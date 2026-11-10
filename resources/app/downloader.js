/* 豆包影视盒 —— 影片下载器
 * 采集站的线路都是 HLS（m3u8 + 成百上千个分片），不能靠"另存为"保存，
 * 所以这里自己做：读清单 →（多档时选最高码率）→ 顺序抓分片 → AES-128 解密 → 边抓边拼成一个文件。
 * 输出：普通 ts 分片拼成 .ts；带 EXT-X-MAP 的 fMP4 拼成 .mp4。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// 取二进制内容（分片就是二进制，不能走会按 utf8 解码的 requestRaw）
function fetchBuf(target, { ua = DEFAULT_UA, referer = '', timeout = 30000, redirects = 4 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(target); } catch (_) { return reject(new Error('地址无效：' + target)); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new Error('仅支持 http/https'));
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      {
        method: 'GET',
        timeout,
        headers: {
          'User-Agent': ua,
          Accept: '*/*',
          'Accept-Encoding': 'identity', // 分片若被 gzip 会拼坏
          'Accept-Language': 'zh-CN,zh;q=0.9',
          Referer: referer || u.origin + '/'
        }
      },
      (res) => {
        const code = res.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(code) && res.headers.location && redirects > 0) {
          res.resume();
          let next;
          try { next = new URL(res.headers.location, u).toString(); } catch (_) { return reject(new Error('重定向地址无效')); }
          return resolve(fetchBuf(next, { ua, referer, timeout, redirects: redirects - 1 }));
        }
        if (code >= 400) {
          res.resume();
          return reject(new Error('HTTP ' + code + '（' + target.slice(0, 80) + '）'));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

function parseMaster(text) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l.toUpperCase().startsWith('#EXT-X-STREAM-INF')) continue;
    const bw = Number((l.match(/BANDWIDTH=(\d+)/i) || [])[1] || 0);
    for (let j = i + 1; j < lines.length; j++) {
      const n = lines[j].trim();
      if (!n) continue;
      if (n.startsWith('#')) continue;
      variants.push({ bw, url: n });
      break;
    }
  }
  return variants;
}

function parseMedia(text) {
  const lines = text.split(/\r?\n/);
  const segs = [];
  let key = null;
  let map = null;
  let mediaSeq = 0;
  let endList = false;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (l.toUpperCase().startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSeq = Number(l.split(':')[1] || 0) || 0;
    } else if (l.toUpperCase().startsWith('#EXT-X-KEY:')) {
      const method = (l.match(/METHOD=([^,]+)/i) || [])[1] || '';
      const uri = (l.match(/URI="([^"]+)"/) || [])[1];
      const iv = (l.match(/IV=0x([0-9a-fA-F]+)/) || [])[1];
      if (/AES-128/i.test(method) && uri) key = { uri, iv };
      else if (/NONE/i.test(method)) key = null;
    } else if (l.toUpperCase().startsWith('#EXT-X-MAP:')) {
      const uri = (l.match(/URI="([^"]+)"/) || [])[1];
      if (uri) map = uri;
    } else if (l.toUpperCase().startsWith('#EXT-X-ENDLIST')) {
      endList = true;
    } else if (!l.startsWith('#')) {
      segs.push(l);
    }
  }
  return { segs, key, map, mediaSeq, endList };
}

function decryptAes(buf, key, ivHex, seq) {
  const iv = ivHex
    ? Buffer.from(ivHex.padEnd(32, '0').slice(0, 32), 'hex')
    : Buffer.from(seq.toString(16).padStart(32, '0'), 'hex'); // 无显式 IV 时按规范用序号
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([d.update(buf), d.final()]);
}

function safeName(s, max) {
  return String(s || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 90);
}

/* 创建下载管理器
 * opts: { ua, dir, resolve, log, onEvent }
 * resolve(playUrl) 复用主进程那套解析规则，返回 { ok, url, referer }
 */
function createDownloader(opts) {
  const ua = opts.ua || DEFAULT_UA;
  const log = opts.log || (() => {});
  const onEvent = opts.onEvent || (() => {});
  const resolveUrl = opts.resolve;
  const baseDir = () => opts.dir() || path.join(process.cwd(), 'downloads');
  const jobs = new Map();
  let seqNo = 0;

  function emit(job) {
    try {
      onEvent({
        id: job.id,
        title: job.title,
        epName: job.epName,
        phase: job.phase,
        done: job.done,
        total: job.total,
        bytes: job.bytes,
        speed: job.speed,
        file: job.file,
        error: job.error,
        current: job.current
      });
    } catch (_) {}
  }

  async function start(input) {
    const job = {
      id: 'dl' + Date.now().toString(36) + (++seqNo),
      title: String(input.title || '影片'),
      epName: String(input.epName || ''),
      playUrl: String(input.playUrl || ''),
      canceled: false,
      phase: 'prepare',
      done: 0,
      total: 0,
      bytes: 0,
      speed: 0,
      file: '',
      error: '',
      current: ''
    };
    jobs.set(job.id, job);
    emit(job);
    job.promise = run(job).catch((err) => {
      job.error = err && err.message ? err.message : String(err);
      job.phase = job.canceled ? 'canceled' : 'error';
      if (job.file && fs.existsSync(job.file)) {
        try { fs.unlinkSync(job.file); } catch (_) {} // 半截文件不留，避免误以为下载成功
      }
      log('[下载] 失败：' + job.title + (job.epName ? ' ' + job.epName : '') + ' —— ' + job.error);
      emit(job);
    }).then(() => {
      setTimeout(() => jobs.delete(job.id), 30000);
    });
    return job.id;
  }

  function cancel(id) {
    const job = jobs.get(id);
    if (!job) return false;
    job.canceled = true;
    try { job.ws && job.ws.destroy(); } catch (_) {}
    return true;
  }

  async function run(job) {
    // 1) 播放页 → 真正的 m3u8
    let m3u8 = job.playUrl;
    let referer = '';
    if (!/\.m3u8(\?|#|$)/i.test(m3u8)) {
      const r = await resolveUrl(m3u8);
      if (!r || !r.ok) throw new Error((r && r.msg) || '解析播放地址失败');
      m3u8 = r.url;
      referer = r.referer || new URL(m3u8).origin + '/';
    } else {
      referer = new URL(m3u8).origin + '/';
    }

    // 2) 读清单；多档（master）时选带宽最高的一档
    let text = (await fetchBuf(m3u8, { ua, referer })).toString('utf8');
    if (!text.includes('#EXTINF') && text.includes('#EXT-X-STREAM-INF')) {
      const variants = parseMaster(text).sort((a, b) => b.bw - a.bw);
      if (!variants.length) throw new Error('清单里没有可用画质档');
      m3u8 = new URL(variants[0].url, m3u8).toString();
      text = (await fetchBuf(m3u8, { ua, referer })).toString('utf8');
    }

    const media = parseMedia(text);
    if (!media.segs.length) throw new Error('清单里没有视频分片（可能是直播或线路已失效）');
    // 自检专用：DBT_TEST 下可用 DBT_DL_LIMIT 只下前 N 片，验证链路而不搬整部片
    const limit = process.env.DBT_TEST && Number(process.env.DBT_DL_LIMIT) ? Number(process.env.DBT_DL_LIMIT) : 0;
    const segList = limit && media.segs.length > limit ? media.segs.slice(0, limit) : media.segs;
    job.total = segList.length;
    job.phase = 'download';
    emit(job);

    // 3) 目标文件
    fs.mkdirSync(baseDir(), { recursive: true });
    const ext = media.map ? '.mp4' : '.ts';
    const name = [safeName(job.title), safeName(job.epName)].filter(Boolean).join(' - ') || '影片';
    let file = path.join(baseDir(), name + ext);
    if (fs.existsSync(file)) {
      file = path.join(baseDir(), name + ' - ' + new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19) + ext);
    }
    job.file = file;

    // 4) 加密线路先取密钥
    let aes = null;
    if (media.key) {
      const keyBuf = await fetchBuf(new URL(media.key.uri, m3u8).toString(), { ua, referer });
      if (keyBuf.length !== 16) throw new Error('AES 密钥长度异常（' + keyBuf.length + ' 字节）');
      aes = { key: keyBuf, ivHex: media.key.iv || null };
    }

    const ws = fs.createWriteStream(file);
    job.ws = ws;
    const writeChunk = (buf) => new Promise((resolve, reject) => {
      ws.write(buf, (err) => (err ? reject(err) : resolve()));
    });

    // fMP4 的初始化段必须先写
    if (media.map) {
      const init = await fetchBuf(new URL(media.map, m3u8).toString(), { ua, referer });
      await writeChunk(init);
      job.bytes += init.length;
    }

    // 5) 并发抓取 + 严格按顺序写盘
    const segs = segList.map((s, i) => ({ url: new URL(s, m3u8).toString(), i }));
    const pending = new Map();
    let nextWrite = 0;
    let writing = false;

    async function flushOrder() {
      if (writing) return;
      writing = true;
      try {
        while (pending.has(nextWrite)) {
          const buf = pending.get(nextWrite);
          pending.delete(nextWrite);
          job.current = '#' + (nextWrite + 1);
          await writeChunk(buf);
          job.bytes += buf.length;
          nextWrite++;
          job.done = nextWrite;
        }
      } finally {
        writing = false;
      }
    }

    async function fetchSeg(i) {
      const buf = await fetchBuf(segs[i].url, { ua, referer });
      if (!buf.length) throw new Error('分片为空 #' + (i + 1));
      if (aes) return decryptAes(buf, aes.key, aes.ivHex, media.mediaSeq + i);
      return buf;
    }

    let cursor = 0;
    const t0 = Date.now();
    let lastEmit = 0;
    let lastBytes = 0;
    let lastT = t0;

    async function worker() {
      while (true) {
        if (job.canceled) throw new Error('已取消');
        const i = cursor++;
        if (i >= segs.length) return;
        const buf = await fetchSeg(i);
        if (job.canceled) throw new Error('已取消');
        pending.set(i, buf);
        await flushOrder();
        const now = Date.now();
        if (now - lastEmit > 600) {
          job.speed = Math.round(((job.bytes - lastBytes) * 1000) / Math.max(1, now - lastT));
          lastBytes = job.bytes;
          lastT = now;
          lastEmit = now;
          emit(job);
        }
      }
    }

    const workers = [];
    for (let k = 0; k < 4; k++) workers.push(worker());
    await Promise.all(workers);
    await flushOrder();

    await new Promise((resolve, reject) => {
      ws.end((err) => (err ? reject(err) : resolve()));
    });
    job.ws = null;
    job.phase = 'done';
    job.done = job.total;
    job.speed = 0;
    job.ms = Date.now() - t0;
    log('[下载] 完成：' + path.basename(file) + '（' + (job.bytes / 1048576).toFixed(1) + ' MB，' + job.total + ' 个分片，' + Math.round(job.ms / 1000) + ' 秒）');
    emit(job);
  }

  return {
    start,
    cancel,
    dir: baseDir
  };
}

module.exports = { createDownloader, fetchBuf, parseMaster, parseMedia };
