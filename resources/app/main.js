/* 豆包影视盒 —— Electron 主进程
 * 职责：窗口管理、多采集站聚合搜索（主进程直连，绕开浏览器跨域限制）、
 *       片源配置读写、分类浏览、收藏与历史持久化。
 */
'use strict';

const { app, BrowserWindow, ipcMain, session, Menu, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const { URL } = require('url');
const { createLanServer } = require('./lan-server');
const { createDownloader } = require('./downloader');

// ---------- 便携化：所有数据都落在 D:\DoubaoTV\data ----------
const APP_ROOT = path.dirname(process.execPath);
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const DATA_DIR = path.join(APP_ROOT, 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
app.setPath('userData', DATA_DIR);
app.setPath('sessionData', DATA_DIR);
try {
  fs.mkdirSync(path.join(DATA_DIR, 'crash'), { recursive: true });
  app.setPath('crashDumps', path.join(DATA_DIR, 'crash'));
} catch (_) {}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
// 解析出的流地址需要带上原始播放页的 Referer，部分 CDN 会校验
let currentStreamReferer = '';

// ---------- 内置片源（均为实测可搜索的 Apple CMS 采集接口） ----------
const DEFAULT_SOURCES = [
  { id: 's1', name: '量子资源', url: 'https://cj.lziapi.com/api.php/provide/vod', enabled: true },
  { id: 's2', name: '最大资源', url: 'https://api.zuidapi.com/api.php/provide/vod', enabled: true },
  { id: 's3', name: '光速资源', url: 'https://api.guangsuapi.com/api.php/provide/vod', enabled: true },
  { id: 's4', name: '极速资源', url: 'https://jszyapi.com/api.php/provide/vod', enabled: true },
  { id: 's5', name: '电影天堂', url: 'https://caiji.dyttzyapi.com/api.php/provide/vod', enabled: true },
  { id: 's6', name: '非凡资源', url: 'https://cj.ffzyapi.com/api.php/provide/vod', enabled: true },
  { id: 's7', name: '魔都资源', url: 'https://www.mdzyapi.com/api.php/provide/vod', enabled: true },
  { id: 's8', name: '360资源', url: 'https://360zy.com/api.php/provide/vod', enabled: true },
  { id: 's9', name: '百度资源', url: 'https://api.apibdzy.com/api.php/provide/vod', enabled: true }
];

// ---------- 基础工具 ----------
function logLine(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(path.join(LOG_DIR, 'app.log'), line); } catch (_) {}
}

function readJson(name, fallback) {
  try {
    const p = path.join(DATA_DIR, name);
    if (!fs.existsSync(p)) return fallback;
    const raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch (e) {
    logLine(`读取 ${name} 失败：${e.message}`);
    return fallback;
  }
}

function writeJson(name, data) {
  const p = path.join(DATA_DIR, name);
  const tmp = p + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch (e) {
    logLine(`写入 ${name} 失败：${e.message}`);
    return false;
  }
}

// ---------- HTTP 请求（支持重定向 / gzip / 超时） ----------
function requestRaw(target, { timeout = 12000, headers = {}, redirects = 4 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(target); } catch (_) { return reject(new Error('地址格式不正确')); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('仅支持 http/https 地址'));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      {
        method: 'GET',
        timeout,
        headers: Object.assign({
          'User-Agent': UA,
          Accept: '*/*',
          'Accept-Encoding': 'gzip, deflate',
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: u.origin + '/'
        }, headers)
      },
      (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && redirects > 0) {
          res.resume();
          let next;
          try { next = new URL(res.headers.location, u).toString(); } catch (_) { return reject(new Error('重定向地址无效')); }
          return resolve(requestRaw(next, { timeout, headers, redirects: redirects - 1 }));
        }
        if (code >= 400) {
          res.resume();
          return resolve({ status: code, body: '', error: `HTTP ${code}` });
        }
        const enc = String(res.headers['content-encoding'] || '').toLowerCase();
        let stream = res;
        try {
          if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
          else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
          else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
        } catch (_) { stream = res; }
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('end', () => resolve({ status: code, body: Buffer.concat(chunks).toString('utf8') }));
        stream.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

function parseJsonLoose(text) {
  if (!text) return null;
  const cleaned = text.replace(/^\uFEFF/, '').trim();
  try { return JSON.parse(cleaned); } catch (_) {}
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(cleaned.slice(first, last + 1)); } catch (_) {}
  }
  return null;
}

async function fetchApi(sourceUrl, params, timeout = 12000) {
  const u = new URL(sourceUrl);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    u.searchParams.set(k, v);
  }
  const res = await requestRaw(u.toString(), { timeout });
  if (res.error) throw new Error(res.error);
  const json = parseJsonLoose(res.body);
  if (!json) throw new Error('接口返回无法解析（可能不是采集站接口）');
  return json;
}

// ---------- 采集站数据归一 ----------
function parsePlayGroups(vodPlayFrom, vodPlayUrl) {
  const froms = String(vodPlayFrom || '').split('$$$');
  const urls = String(vodPlayUrl || '').split('$$$');
  const groups = [];
  const max = Math.max(froms.length, urls.length);
  for (let i = 0; i < max; i++) {
    const from = (froms[i] || `线路${i + 1}`).trim();
    const raw = urls[i] || '';
    if (!raw) continue;
    const items = [];
    raw.split('#').forEach((seg) => {
      const s = seg.trim();
      if (!s) return;
      const pos = s.indexOf('$');
      let name = '正片';
      let url = s;
      if (pos > -1) { name = s.slice(0, pos).trim(); url = s.slice(pos + 1).trim(); }
      if (!/^http(s)?:\/\//i.test(url)) return;
      items.push({ name: name || `第${items.length + 1}集`, url });
    });
    if (items.length) groups.push({ from, items });
  }
  return groups;
}

function normalizeVideo(raw, source) {
  const groups = parsePlayGroups(raw.vod_play_from, raw.vod_play_url);
  const episodes = groups.reduce((n, g) => n + g.items.length, 0);
  return {
    sourceId: source.id,
    sourceName: source.name,
    vodId: String(raw.vod_id || ''),
    name: String(raw.vod_name || '').trim(),
    pic: String(raw.vod_pic || '').trim(),
    year: String(raw.vod_year || '').trim(),
    area: String(raw.vod_area || '').trim(),
    type: String(raw.type_name || '').trim(),
    remarks: String(raw.vod_remarks || '').trim(),
    score: String(raw.vod_score || '').trim(),
    content: String(raw.vod_content || '').replace(/<[^>]+>/g, '').trim(),
    actors: String(raw.vod_actor || '').trim(),
    director: String(raw.vod_director || '').trim(),
    playGroups: groups,
    episodes
  };
}

function titleKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[\s\u3000《》「」『』（）()【】\[\]·:：,，.。!！?？'"“”\-_—]+/g, '');
}

function mergeGroups(videos) {
  const map = new Map();
  videos.forEach((v) => {
    if (!v.name) return;
    const key = titleKey(v.name) || v.name;
    let g = map.get(key);
    if (!g) {
      g = { key, title: v.name, poster: '', year: '', type: '', area: '', remarks: '', score: '', content: '', actors: '', director: '', sources: [] };
      map.set(key, g);
    }
    if (!g.poster && v.pic) g.poster = v.pic;
    if (!g.year && v.year && /^\d{4}$/.test(v.year)) g.year = v.year;
    if (!g.type && v.type) g.type = v.type;
    if (!g.area && v.area) g.area = v.area;
    if (!g.remarks && v.remarks) g.remarks = v.remarks;
    if (!g.score && v.score) g.score = v.score;
    if (!g.content && v.content) g.content = v.content;
    if (!g.actors && v.actors) g.actors = v.actors;
    if (!g.director && v.director) g.director = v.director;
    g.sources.push(v);
  });
  const out = Array.from(map.values());
  out.forEach((g) => {
    g.sourceCount = g.sources.length;
    g.episodeMax = g.sources.reduce((m, s) => Math.max(m, s.episodes || 0), 0);
    g.sources.sort((a, b) => (b.episodes || 0) - (a.episodes || 0));
  });
  out.sort((a, b) => b.sourceCount - a.sourceCount || (Number(b.year) || 0) - (Number(a.year) || 0));
  return out;
}

function sourcesConfig() {
  const stored = readJson('sources.json', null);
  if (Array.isArray(stored) && stored.length) {
    return stored
      .filter((s) => s && s.url)
      .map((s, i) => ({
        id: String(s.id || `c${i}`),
        name: String(s.name || `源${i + 1}`),
        url: String(s.url).trim(),
        enabled: s.enabled !== false
      }));
  }
  writeJson('sources.json', DEFAULT_SOURCES);
  return DEFAULT_SOURCES.slice();
}

// ---------- 应用配置：启动自动更新片源 / 启动默认视图 ----------
function appConfig() {
  const stored = readJson('app-config.json', null) || {};
  return Object.assign({
    autoUpdate: true,
    startupEthics: true,
    qualityHigh: true,
    lanEnabled: true,
    lanPort: 8899,
    subUrl: '',
    lastUpdate: '',
    lastSummary: '',
    health: {}
  }, stored);
}

function saveAppConfig(cfg) {
  return writeJson('app-config.json', cfg);
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch (_) { return String(url || ''); }
}

// 订阅内容解析：JSON 数组 / {sites:[{name,url}]} / 每行「名称 地址」
function parseSourceList(text) {
  const out = [];
  const raw = String(text || '').replace(/^\uFEFF/, '').trim();
  if (!raw) return out;
  try {
    const j = JSON.parse(raw);
    const arr = Array.isArray(j) ? j : (j && (j.sites || j.api_site || j.sources)) || [];
    if (Array.isArray(arr)) {
      arr.forEach((it) => {
        if (typeof it === 'string') {
          if (/^http(s)?:\/\//i.test(it)) out.push({ name: hostOf(it), url: it });
        } else if (it && (it.api || it.url)) {
          const u = String(it.api || it.url).trim();
          if (/^http(s)?:\/\//i.test(u)) out.push({ name: String(it.name || it.title || hostOf(u)), url: u });
        }
      });
      return out;
    }
  } catch (_) {}
  raw.split(/\r?\n/).forEach((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('//')) return;
    const m = t.match(/(https?:\/\/[^\s,]+)/);
    if (!m) return;
    out.push({ name: t.replace(m[1], '').trim() || hostOf(m[1]), url: m[1] });
  });
  return out;
}

// 启动时统一做的两件事：刷新片源（订阅合并 + 可用性探活）
async function refreshSourcesOnStartup() {
  const cfg = appConfig();
  if (!cfg.autoUpdate) return { ok: true, skipped: true, msg: '已关闭启动自动更新' };
  let added = 0;
  let subNote = '';
  if (cfg.subUrl) {
    try {
      const res = await requestRaw(cfg.subUrl, { timeout: 12000 });
      if (res.error) throw new Error(res.error);
      const incoming = parseSourceList(res.body);
      if (incoming.length) {
        const list = sourcesConfig();
        const known = new Set(list.map((s) => String(s.url).replace(/\/+$/, '').toLowerCase()));
        const merged = list.slice();
        incoming.forEach((s, i) => {
          const u = String(s.url).trim();
          const key = u.replace(/\/+$/, '').toLowerCase();
          if (!key || known.has(key)) return;
          known.add(key);
          merged.push({ id: `sub${Date.now()}${i}`, name: s.name || hostOf(u), url: u, enabled: true });
          added++;
        });
        if (added) writeJson('sources.json', merged);
      } else {
        subNote = '订阅地址没解析出片源';
      }
    } catch (err) {
      subNote = '订阅更新失败：' + err.message;
    }
  }

  const srcs = sourcesConfig().filter((s) => s.enabled);
  const results = await Promise.all(srcs.map(async (s) => {
    const t0 = Date.now();
    try {
      const json = await fetchApi(s.url, { ac: 'list' }, 8000);
      const classes = Array.isArray(json.class) ? json.class.length : 0;
      return { url: s.url, name: s.name, ok: true, ms: Date.now() - t0, classes };
    } catch (err) {
      return { url: s.url, name: s.name, ok: false, ms: Date.now() - t0, error: err.message };
    }
  }));

  const health = {};
  results.forEach((r) => { health[r.url] = { ok: r.ok, ms: r.ms, at: new Date().toISOString(), error: r.error || '', classes: r.classes || 0 }; });
  cfg.health = health;
  cfg.lastUpdate = new Date().toISOString();
  const alive = results.filter((r) => r.ok).length;
  cfg.lastSummary = `检测 ${results.length} 个源，${alive} 个可用${added ? `，新增 ${added} 个片源` : ''}${subNote ? `；${subNote}` : ''}`;
  saveAppConfig(cfg);
  logLine('[片源] ' + cfg.lastSummary);
  return { ok: true, total: results.length, alive, added, lastUpdate: cfg.lastUpdate, summary: cfg.lastSummary, sources: results };
}

// ---------- IPC ----------
// ---------- 桌面 IPC 与手机端共用的业务逻辑 ----------
async function doSearch(keyword, deep) {
  keyword = String(keyword || '').trim();
  if (!keyword) return { ok: false, msg: '请输入关键词' };
  const srcs = sourcesConfig().filter((s) => s.enabled);
  if (!srcs.length) return { ok: false, msg: '没有启用的片源，请先在「片源」页启用或添加' };

  const per = await Promise.all(
    srcs.map(async (s) => {
      const t0 = Date.now();
      try {
        const pages = [];
        const first = await fetchApi(s.url, { ac: 'detail', wd: keyword, pg: 1 });
        pages.push(first);
        if (deep) {
          const total = Number(first.pagecount || 1);
          const extra = Math.min(total, 3);
          for (let pg = 2; pg <= extra; pg++) {
            try { pages.push(await fetchApi(s.url, { ac: 'detail', wd: keyword, pg })); } catch (_) { break; }
          }
        }
        const videos = pages.flatMap((p) => (Array.isArray(p.list) ? p.list : [])).map((v) => normalizeVideo(v, s));
        const seen = new Set();
        const uniq = videos.filter((v) => {
          const k = v.vodId || v.name + '|' + v.remarks;
          if (seen.has(k)) return false;
          seen.add(k);
          return true;
        });
        return { id: s.id, name: s.name, ok: true, ms: Date.now() - t0, count: uniq.length, videos: uniq };
      } catch (err) {
        return { id: s.id, name: s.name, ok: false, ms: Date.now() - t0, count: 0, videos: [], error: err.message };
      }
    })
  );

  const groups = mergeGroups(per.flatMap((p) => p.videos));
  return {
    ok: true,
    keyword,
    groups,
    perSource: per.map((p) => ({ id: p.id, name: p.name, ok: p.ok, ms: p.ms, count: p.count, error: p.error || '' }))
  };
}

async function doVideos(url, ids) {
  try {
    const json = await fetchApi(url, { ac: 'detail', ids });
    const src = sourcesConfig().find((s) => s.url === url) || { id: 'x', name: '片源' };
    return { ok: true, videos: (Array.isArray(json.list) ? json.list : []).map((v) => normalizeVideo(v, src)) };
  } catch (err) {
    return { ok: false, msg: err.message };
  }
}

async function doResolve(raw) {
  raw = String(raw || '').trim();
  if (!/^http(s)?:\/\//i.test(raw)) return { ok: false, msg: '播放地址无效' };
  // 已经是直链（m3u8 / mp4 等），直接交给播放器
  if (/\.(m3u8|mp4|flv|mkv|ts|mpd)(\?|#|$)/i.test(raw)) {
    currentStreamReferer = '';
    return { ok: true, url: raw, direct: true };
  }
  try {
    const res = await requestRaw(raw, { timeout: 12000 });
    if (res.error) return { ok: false, msg: res.error };
    const body = res.body.replace(/\\\//g, '/');
    let found = null;
    const mainMatch = body.match(/var\s+main\s*=\s*["']([^"']+)["']/i);
    if (mainMatch) found = mainMatch[1];
    if (!found) {
      const pats = [
        /["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i,
        /["'](\/[^"']+\.m3u8[^"']*)["']/i,
        /(https?:\/\/[^"' ]+\.m3u8(?:[^"' ]*)?)/i
      ];
      for (const p of pats) {
        const m = body.match(p);
        if (m) { found = m[1]; break; }
      }
    }
    if (!found) return { ok: false, msg: '这个播放页里没有解析到 m3u8 地址（线路可能已失效）' };
    const abs = new URL(found, raw).toString();
    currentStreamReferer = new URL(raw).origin + '/';
    return { ok: true, url: abs, referer: currentStreamReferer };
  } catch (err) {
    return { ok: false, msg: err.message };
  }
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    dataDir: DATA_DIR,
    exeDir: APP_ROOT
  }));

  ipcMain.handle('sources:get', () => sourcesConfig());

  ipcMain.handle('sources:save', (e, list) => {
    if (!Array.isArray(list)) return { ok: false, msg: '数据格式错误' };
    const clean = list
      .filter((s) => s && String(s.url || '').trim())
      .map((s, i) => ({
        id: String(s.id || `c${Date.now()}${i}`),
        name: String(s.name || `源${i + 1}`).trim(),
        url: String(s.url).trim(),
        enabled: s.enabled !== false
      }));
    const ok = writeJson('sources.json', clean);
    return { ok, msg: ok ? '已保存' : '保存失败，请检查磁盘权限' };
  });

  ipcMain.handle('sources:test', async (e, payload) => {
    const { url } = payload || {};
    const t0 = Date.now();
    try {
      if (!/^http(s)?:\/\//i.test(String(url || ''))) throw new Error('地址需以 http(s):// 开头');
      const json = await fetchApi(url, { ac: 'detail', wd: '流浪地球', pg: 1 });
      const list = Array.isArray(json.list) ? json.list : [];
      const withPlay = list.filter((v) => parsePlayGroups(v.vod_play_from, v.vod_play_url).length > 0).length;
      return {
        ok: list.length > 0,
        ms: Date.now() - t0,
        count: list.length,
        withPlay,
        msg: list.length ? `可用，返回 ${list.length} 条，其中 ${withPlay} 条含播放地址` : '接口可访问但没有搜索结果'
      };
    } catch (err) {
      return { ok: false, ms: Date.now() - t0, count: 0, msg: err.message };
    }
  });

  ipcMain.handle('app:config', () => appConfig());

  ipcMain.handle('app:config:save', (e, patch) => {
    const cfg = appConfig();
    const p = patch && typeof patch === 'object' ? patch : {};
    if (typeof p.autoUpdate === 'boolean') cfg.autoUpdate = p.autoUpdate;
    if (typeof p.startupEthics === 'boolean') cfg.startupEthics = p.startupEthics;
    if (typeof p.qualityHigh === 'boolean') cfg.qualityHigh = p.qualityHigh;
    if (typeof p.lanEnabled === 'boolean') cfg.lanEnabled = p.lanEnabled;
    if (p.lanPort !== undefined && Number(p.lanPort) > 0) cfg.lanPort = Number(p.lanPort);
    if (typeof p.subUrl === 'string') cfg.subUrl = p.subUrl.trim();
    const ok = saveAppConfig(cfg);
    return { ok, cfg };
  });

  ipcMain.handle('sources:refresh', () => refreshSourcesOnStartup());

  ipcMain.handle('search:run', (e, payload) => doSearch(String((payload && payload.keyword) || ''), Boolean(payload && payload.deep)));

  ipcMain.handle('source:videos', (e, payload) => doVideos((payload && payload.url) || '', (payload && payload.ids) || ''));

  ipcMain.handle('browse:classes', async (e, payload) => {
    const { url } = payload || {};
    try {
      const json = await fetchApi(url, { ac: 'list' });
      const cls = (Array.isArray(json.class) ? json.class : []).map((c) => ({
        id: String(c.type_id),
        pid: String(c.type_pid || 0),
        name: String(c.type_name || '')
      }));
      const leaves = cls.filter((c) => !cls.some((o) => o.pid === c.id) && c.name);
      const roots = cls.filter((c) => c.pid === '0' || !cls.some((o) => o.id === c.pid));
      return { ok: true, classes: leaves.length ? leaves : roots };
    } catch (err) {
      return { ok: false, msg: err.message };
    }
  });

  ipcMain.handle('browse:list', async (e, payload) => {
    const { url, typeId, page } = payload || {};
    try {
      const json = await fetchApi(url, { ac: 'detail', t: typeId, pg: page || 1 });
      const src = sourcesConfig().find((s) => s.url === url) || { id: 'b', name: '片源' };
      const videos = (Array.isArray(json.list) ? json.list : []).map((v) => normalizeVideo(v, src));
      return {
        ok: true,
        page: Number(json.page || 1),
        pagecount: Number(json.pagecount || 1),
        total: Number(json.total || videos.length),
        groups: mergeGroups(videos)
      };
    } catch (err) {
      return { ok: false, msg: err.message };
    }
  });

  // 按分类名（如「伦理片」）跨源拉取：各源分类 ID 不同，先取分类表再匹配名字
  const classCache = new Map();
  ipcMain.handle('browse:tagged', async (e, payload) => {
    const tag = String((payload && payload.tag) || '').trim();
    const page = Number((payload && payload.page) || 1);
    if (!tag) return { ok: false, msg: '缺少分类名' };
    const srcs = sourcesConfig().filter((s) => s.enabled);
    if (!srcs.length) return { ok: false, msg: '没有启用的片源' };

    const per = await Promise.all(srcs.map(async (s) => {
      const t0 = Date.now();
      try {
        let cached = classCache.get(s.url);
        if (!cached || Date.now() - cached.at > 30 * 60 * 1000) {
          const j = await fetchApi(s.url, { ac: 'list' }, 10000);
          const cls = (Array.isArray(j.class) ? j.class : []).map((c) => ({
            id: String(c.type_id),
            pid: String(c.type_pid || 0),
            name: String(c.type_name || '')
          }));
          cached = { at: Date.now(), cls };
          classCache.set(s.url, cached);
        }
        const hit = cached.cls.find((c) => c.name.replace(/\s/g, '').includes(tag.replace(/\s/g, '')));
        if (!hit) return { id: s.id, name: s.name, ok: true, ms: Date.now() - t0, count: 0, videos: [], pagecount: 1, note: '该源无此分类' };
        const json = await fetchApi(s.url, { ac: 'detail', t: hit.id, pg: page });
        const videos = (Array.isArray(json.list) ? json.list : []).map((v) => normalizeVideo(v, s));
        return { id: s.id, name: s.name, ok: true, ms: Date.now() - t0, count: videos.length, videos, pagecount: Number(json.pagecount || 1), total: Number(json.total || videos.length) };
      } catch (err) {
        return { id: s.id, name: s.name, ok: false, ms: Date.now() - t0, count: 0, videos: [], pagecount: 1, error: err.message };
      }
    }));

    const groups = mergeGroups(per.flatMap((p) => p.videos || []));
    return {
      ok: true,
      tag,
      page,
      groups,
      pagecount: per.reduce((m, p) => Math.max(m, p.pagecount || 1), 1),
      perSource: per.map((p) => ({ id: p.id, name: p.name, ok: p.ok, ms: p.ms, count: p.count, error: p.error || '', note: p.note || '' }))
    };
  });

  ipcMain.handle('stream:resolve', (e, payload) => doResolve((payload && payload.url) || ''));

  ipcMain.handle('favorites:get', () => readJson('favorites.json', []));
  ipcMain.handle('favorites:save', (e, list) => ({ ok: writeJson('favorites.json', Array.isArray(list) ? list : []) }));
  ipcMain.handle('history:get', () => readJson('history.json', []));
  ipcMain.handle('history:save', (e, list) => ({ ok: writeJson('history.json', Array.isArray(list) ? list.slice(0, 40) : []) }));

  ipcMain.handle('shell:open', (e, url) => {
    if (/^http(s)?:\/\//i.test(String(url || ''))) shell.openExternal(url);
    return true;
  });

  ipcMain.handle('shell:datadir', () => { shell.openPath(DATA_DIR); return true; });

  ipcMain.handle('lan:info', () => (lanServer ? lanServer.info() : { ok: false, port: 0, ip: '', url: '' }));

  // 下载影片：输入播放页地址，主进程自己抓分片并拼成文件
  ipcMain.handle('dl:start', (e, job) => ensureDownloader().start(job || {}));
  ipcMain.handle('dl:cancel', (e, id) => ensureDownloader().cancel(id));
  ipcMain.handle('dl:openDir', async () => {
    const d = downloadDir();
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
    shell.openPath(d);
    return d;
  });

  // 界面缩放：整体放大/缩小（Ctrl + / - / 0），结果落盘，下次启动沿用
  ipcMain.handle('ui:zoom', (e, action) => {
    let cur = 1;
    try { cur = win && !win.isDestroyed() ? win.webContents.getZoomFactor() : 1; } catch (_) {}
    let next = cur;
    if (action === 'in') next = Math.min(1.4, Math.round((cur + 0.1) * 100) / 100);
    else if (action === 'out') next = Math.max(0.8, Math.round((cur - 0.1) * 100) / 100);
    else if (action === 'reset') next = 1;
    else if (typeof action === 'number') next = Math.min(1.4, Math.max(0.8, action));
    try { if (win && !win.isDestroyed()) win.webContents.setZoomFactor(next); } catch (_) {}
    try { const cfg = appConfig(); cfg.zoomFactor = next; saveAppConfig(cfg); } catch (_) {}
    return next;
  });
}

// ---------- 窗口 ----------
let win = null;

// 窗口尺寸：按屏幕工作区算一个不占满屏的默认值，并记住用户自己调过的大小
function defaultWindowBounds() {
  let wa = { width: 1280, height: 800 };
  try { wa = screen.getPrimaryDisplay().workAreaSize; } catch (_) {}
  const width = Math.max(900, Math.min(1120, Math.round(wa.width * 0.64)));
  const height = Math.max(600, Math.min(780, Math.round(wa.height * 0.72)));
  return { width, height, center: true };
}

function savedWindowBounds() {
  const b = appConfig().windowBounds;
  if (!b || !Number.isFinite(b.width) || !Number.isFinite(b.height)) return null;
  try {
    const wa = screen.getPrimaryDisplay().workArea;
    const width = Math.min(Math.max(Math.round(b.width), 880), wa.width);
    const height = Math.min(Math.max(Math.round(b.height), 560), wa.height);
    let x = Number.isFinite(b.x) ? Math.round(b.x) : null;
    let y = Number.isFinite(b.y) ? Math.round(b.y) : null;
    // 位置越界（拔过副屏、改过分辨率）就交给系统居中
    if (x !== null && (x < wa.x - 40 || x > wa.x + wa.width - 160)) x = null;
    if (y !== null && (y < wa.y - 20 || y > wa.y + wa.height - 120)) y = null;
    const opts = { width, height };
    if (x === null || y === null) opts.center = true; else { opts.x = x; opts.y = y; }
    opts.maximized = !!b.maximized;
    return opts;
  } catch (_) { return null; }
}

let boundsTimer = null;
function saveWindowBounds(immediate) {
  if (!win || win.isDestroyed()) return;
  const flush = () => {
    try {
      const b = win.getNormalBounds();
      const cfg = appConfig();
      cfg.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
      saveAppConfig(cfg);
    } catch (_) {}
  };
  clearTimeout(boundsTimer);
  if (immediate) flush(); else boundsTimer = setTimeout(flush, 700);
}

function createWindow() {
  const iconPath = path.join(APP_ROOT, 'app.ico');
  const saved = savedWindowBounds();
  const opts = saved || defaultWindowBounds();
  win = new BrowserWindow({
    width: opts.width,
    height: opts.height,
    x: opts.x,
    y: opts.y,
    center: !!opts.center,
    minWidth: 880,
    minHeight: 560,
    backgroundColor: '#0d1117',
    show: false,
    autoHideMenuBar: true,
    title: '豆包影视盒',
    icon: fs.existsSync(iconPath) ? iconPath : undefined,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  });

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => {
    if (saved && saved.maximized) win.maximize();
    win.show();
    try {
      const b = win.getBounds();
      logLine(`[窗口] ${b.width}x${b.height} @(${b.x},${b.y}) 最大化=${win.isMaximized()}`);
    } catch (_) {}
  });

  // 记住窗口尺寸与位置（拖动/缩放结束 0.7 秒后落盘，关闭时立刻落盘）
  win.on('resize', () => saveWindowBounds(false));
  win.on('move', () => saveWindowBounds(false));
  win.on('close', () => saveWindowBounds(true));

  // 恢复上次的界面缩放（Ctrl + / - / 0 调整）
  win.webContents.on('did-finish-load', () => {
    try {
      const z = Number(appConfig().zoomFactor);
      if (z >= 0.8 && z <= 1.4) win.webContents.setZoomFactor(z);
    } catch (_) {}
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^http(s)?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('render-process-gone', (_e, details) => logLine(`渲染进程退出：${JSON.stringify(details)}`));
  win.on('closed', () => { win = null; });

  // 自检钩子：仅当设置 DBT_TEST 环境变量时生效，用于部署后验证界面与搜索链路
  if (process.env.DBT_TEST) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 1200));
      try {
        if (process.env.DBT_JSFILE) {
          const code = fs.readFileSync(process.env.DBT_JSFILE, 'utf8');
          const out = await win.webContents.executeJavaScript(code, true);
          logLine(`[自检] JS 返回：${JSON.stringify(out)}`);
        }
        const wait = Number(process.env.DBT_WAIT || 0);
        if (wait) await new Promise((r) => setTimeout(r, wait));
        if (process.env.DBT_CAPTURE) {
          try { win.show(); win.focus(); } catch (_) {}
          await new Promise((r) => setTimeout(r, 800));
          const img = await Promise.race([
            win.webContents.capturePage(),
            new Promise((_r, rej) => setTimeout(() => rej(new Error('截图超时')), 8000))
          ]);
          fs.writeFileSync(process.env.DBT_CAPTURE, img.toPNG());
          logLine(`[自检] 已截图 ${process.env.DBT_CAPTURE}`);
        }
      } catch (err) {
        logLine(`[自检] 失败：${err && err.message}`);
      }
      if (process.env.DBT_EXIT) app.quit();
    });
  }
}

function applyNetworkPolicy() {
  const ses = session.defaultSession;

  // 给所有响应补上跨域头：本地页面直接播放第三方 m3u8 需要它
  ses.webRequest.onHeadersReceived((details, callback) => {
    const headers = Object.assign({}, details.responseHeaders || {});
    headers['Access-Control-Allow-Origin'] = ['*'];
    headers['Access-Control-Allow-Headers'] = ['*'];
    headers['Access-Control-Allow-Methods'] = ['GET,HEAD,OPTIONS'];
    callback({ responseHeaders: headers });
  });

  // 部分 CDN 校验来源，按目标站补 Referer；媒体流优先用播放页的来源
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    const headers = details.requestHeaders || {};
    try {
      const u = new URL(details.url);
      const isMedia = details.resourceType === 'media' || /\.(m3u8|ts|m4s|mp4|key)(\?|#|$)/i.test(details.url);
      if (u.protocol.startsWith('http')) {
        if (isMedia && currentStreamReferer) headers.Referer = currentStreamReferer;
        else if (!headers.Referer && !headers.referer) headers.Referer = u.origin + '/';
      }
    } catch (_) {}
    callback({ requestHeaders: headers });
  });
}

// ---------- 后台自动更新片源 ----------
// 原则：更新只在主进程异步跑，绝不重建/关闭窗口、不打断正在播放的视频。
// 结果通过 sources:refreshed 事件推给界面，界面自己决定要不要提示。
let refreshRunning = false;

async function runBackgroundRefresh(tag) {
  if (refreshRunning) { logLine(`[片源] ${tag}跳过：上一次更新还没结束`); return null; }
  refreshRunning = true;
  try {
    const r = await refreshSourcesOnStartup();
    if (!r || r.skipped) { logLine(`[片源] ${tag}未执行：${(r && r.msg) || ''}`); return r; }
    logLine(`[片源] ${tag}：${r.summary}`);
    if (win && !win.isDestroyed() && win.webContents) {
      win.webContents.send('sources:refreshed', r);
    }
    return r;
  } catch (err) {
    logLine(`[片源] ${tag}失败：${err.message}`);
    return null;
  } finally {
    refreshRunning = false;
  }
}

function scheduleBackgroundRefresh() {
  // 窗口加载完再等 3 秒启动，避免和首屏抢网络；之后每 6 小时静默刷新一次
  setTimeout(() => runBackgroundRefresh('启动后台更新'), 3000);
  setInterval(() => runBackgroundRefresh('定时后台更新'), 6 * 60 * 60 * 1000);
}

// ---------- 下载（HLS 分片拼成文件） ----------
let downloader = null;

function downloadDir() {
  const cfg = appConfig();
  return cfg.downloadDir || path.join(APP_ROOT, 'downloads');
}

function ensureDownloader() {
  if (!downloader) {
    downloader = createDownloader({
      ua: UA,
      dir: downloadDir,
      resolve: (u) => doResolve(u),
      log: (m) => logLine(m),
      onEvent: (e) => {
        if (win && !win.isDestroyed() && win.webContents) win.webContents.send('dl:progress', e);
      }
    });
  }
  return downloader;
}

// ---------- 局域网手机端（iPhone 同 WiFi 访问） ----------
let lanServer = null;

function startLanServer() {
  const cfg = appConfig();
  if (cfg.lanEnabled === false) { logLine('[手机] 已关闭局域网访问'); return null; }
  if (lanServer) return lanServer;
  lanServer = createLanServer({
    ua: UA,
    log: (msg) => logLine(msg),
    sourcesConfig,
    fetchApi,
    normalizeVideo,
    mergeGroups,
    doSearch,
    doVideos,
    doResolve,
    onReady: (info) => {
      if (win && !win.isDestroyed() && win.webContents) win.webContents.send('lan:ready', info);
    }
  });
  lanServer.start(cfg.lanPort || 8899);
  return lanServer;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });

  app.whenReady().then(() => {
    applyNetworkPolicy();
    registerIpc();
    createWindow();
    scheduleBackgroundRefresh();
    startLanServer();
    logLine('应用启动');
  });

  app.on('window-all-closed', () => app.quit());
  app.on('activate', () => { if (!win) createWindow(); });
}

process.on('uncaughtException', (err) => logLine(`主进程异常：${err && err.stack ? err.stack : err}`));
process.on('unhandledRejection', (err) => logLine(`未处理拒绝：${err && err.stack ? err.stack : err}`));
