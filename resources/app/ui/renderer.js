'use strict';

/* ---------------- 基础工具 ---------------- */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function fixImages(root) {
  $$('img[data-fallback]', root).forEach((img) => {
    img.addEventListener('error', () => {
      const ph = document.createElement('div');
      ph.className = 'poster-ph';
      ph.textContent = '封面失效';
      img.replaceWith(ph);
    }, { once: true });
  });
}

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const s = Math.floor(sec % 60);
  const m = Math.floor((sec / 60) % 60);
  const h = Math.floor(sec / 3600);
  const p = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

/* ---------------- 全局状态 ---------------- */
const state = {
  sources: [],
  groups: [],            // 当前搜索结果
  favorites: [],
  history: [],
  detail: null,          // { group, sourceIdx, lineIdx }
  browse: { sourceUrl: '', classId: '', page: 1, pagecount: 1, total: 0 },
  ethics: { page: 1, pagecount: 1 },
  cfg: {},
  qualityHigh: true,
  overlay: null
};

/* ---------------- 视图切换 ---------------- */
function switchView(name) {
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'favorites') renderFavorites();
  if (name === 'sources') renderSources();
  if (name === 'browse') initBrowse();
  if (name === 'ethics') loadEthicsPage(state.ethics.page || 1);
}

$$('.nav-item').forEach((b) => b.addEventListener('click', () => switchView(b.dataset.view)));

/* ---------------- 启动初始化 ---------------- */
async function boot() {
  try {
    const info = await window.api.info();
    $('#verLabel').textContent = `v${info.version} · 本地运行`;
    $('#aboutDataDir').textContent = info.dataDir;
  } catch (_) {}

  state.sources = await window.api.getSources();
  state.favorites = await window.api.getFavorites() || [];
  state.history = await window.api.getHistory() || [];
  renderHistoryChips();
  renderSources();
  updateSourceStatus(state.sources.map((s) => ({ name: s.name, ok: true, ms: 0, count: 0, idle: true })));

  // 片源更新全部在后台（主进程）跑：这里只挂监听，不等待、不切页、不碰播放窗口
  await loadConfigUi();
  if (window.api.onSourcesRefreshed) window.api.onSourcesRefreshed(handleBackgroundRefresh);
  loadLanInfo();
  if (window.api.onLanReady) window.api.onLanReady((info) => renderLanInfo(info));
  if (window.api.onDownloadProgress) window.api.onDownloadProgress(onDownloadEvent);
  if (state.cfg.startupEthics !== false) {
    state.ethics.page = 1;
    switchView('ethics');
  }
}

// 手机访问地址：主进程起好局域网服务后回填
async function loadLanInfo() {
  try {
    const info = await window.api.lanInfo();
    if (info && info.ok) renderLanInfo(info);
  } catch (_) {}
}

function renderLanInfo(info) {
  const urlEl = $('#lanUrl');
  const hintEl = $('#lanHint');
  if (!urlEl || !info) return;
  if (!info.ok) {
    urlEl.textContent = '未启用（局域网服务没有起来）';
    if (hintEl) hintEl.textContent = '检查「片源管理」或 data\\app-config.json 里的 lanEnabled；端口被占用时会自动换端口。';
    return;
  }
  urlEl.textContent = info.url;
  urlEl.dataset.url = info.url;
  state.lanUrl = info.url;
  if (hintEl) {
    hintEl.textContent = `手机连同一个 WiFi，用 Safari 打开 ${info.url} 即可搜索、选线路、在线播放（由本机代理转发，画质与电脑端同源）。若手机打不开，多半是 Windows 防火墙拦了：在防火墙弹窗里点「允许访问」，或放行 ${info.port} 端口。`;
  }
}

$('#btnCopyLan') && $('#btnCopyLan').addEventListener('click', async () => {
  const url = (state.lanUrl || $('#lanUrl').dataset.url || '').trim();
  if (!url) return toast('地址还没准备好');
  try { await navigator.clipboard.writeText(url); toast('已复制：' + url); } catch (_) { toast('复制失败，手动记一下：' + url); }
});

// 后台更新完成回调：只更新状态与文字，播放中不打扰
function handleBackgroundRefresh(r) {
  if (!r || !r.ok || r.skipped) return;
  state.cfg.lastUpdate = r.lastUpdate;
  state.cfg.lastSummary = r.summary;
  renderLastUpdate();
  window.api.getSources().then((list) => { state.sources = list; renderSources(); }).catch(() => {});
  const playing = player && player.classList.contains('show');
  $('#searchHint').textContent = '片源已在后台更新：' + r.summary;
  if (playing) return;
  toast('片源已在后台更新：' + r.summary);
}

/* ---------------- 启动自动更新 / 订阅设置 ---------------- */
async function loadConfigUi() {
  try { state.cfg = (await window.api.getConfig()) || {}; } catch (_) { state.cfg = {}; }
  $('#autoUpdate').checked = state.cfg.autoUpdate !== false;
  $('#startupEthics').checked = state.cfg.startupEthics !== false;
  $('#subUrl').value = state.cfg.subUrl || '';
  state.qualityHigh = state.cfg.qualityHigh !== false;
  updateQualityBtn(null);
  renderLastUpdate();
}

function renderLastUpdate() {
  const el = $('#lastUpdate');
  if (!el) return;
  if (!state.cfg.lastUpdate) { el.textContent = '尚未更新过'; return; }
  const d = new Date(state.cfg.lastUpdate);
  el.textContent = `上次更新：${d.toLocaleString('zh-CN', { hour12: false })}${state.cfg.lastSummary ? ' · ' + state.cfg.lastSummary : ''}`;
}

async function doRefreshSources(silent) {
  const btn = $('#btnRefreshSources');
  if (!silent && btn) { btn.disabled = true; btn.textContent = '更新中…'; }
  let r = null;
  try { r = await window.api.refreshSources(); } catch (err) { r = { ok: false, msg: err.message }; }
  if (!silent && btn) { btn.disabled = false; btn.textContent = '立即更新片源'; }
  if (r && r.ok && !r.skipped) {
    state.cfg.lastUpdate = r.lastUpdate;
    state.cfg.lastSummary = r.summary;
    state.sources = await window.api.getSources();
    renderSources();
    renderLastUpdate();
    if (!silent) toast(r.summary);
  } else if (r && r.skipped) {
    if (!silent) toast(r.msg);
  } else {
    toast('片源更新失败：' + ((r && r.msg) || '未知错误'));
  }
  return r;
}

$('#autoUpdate').addEventListener('change', async (e) => {
  await window.api.saveConfig({ autoUpdate: e.target.checked });
  state.cfg.autoUpdate = e.target.checked;
  toast(e.target.checked ? '已开启：每次启动自动更新片源' : '已关闭启动自动更新');
});

$('#startupEthics').addEventListener('change', async (e) => {
  await window.api.saveConfig({ startupEthics: e.target.checked });
  state.cfg.startupEthics = e.target.checked;
  toast(e.target.checked ? '已开启：每次启动自动打开「伦理片」' : '已关闭启动自动打开「伦理片」');
});

$('#subUrl').addEventListener('change', async (e) => {
  const r = await window.api.saveConfig({ subUrl: e.target.value.trim() });
  state.cfg.subUrl = e.target.value.trim();
  toast(state.cfg.subUrl ? '订阅地址已保存，下次启动会按它更新片源' : '已清空订阅地址，只做启动体检');
});

$('#btnRefreshSources').addEventListener('click', () => doRefreshSources(false));
$('#btnEthicsReload').addEventListener('click', () => loadEthicsPage(1));

/* ---------------- 伦理片（跨源按分类名抓取） ---------------- */
async function loadEthicsPage(page) {
  const p = Math.max(1, Number(page) || 1);
  state.ethics.page = p;
  $('#ethicsGrid').innerHTML = '';
  $('#ethicsStatus').innerHTML = '';
  $('#ethicsHint').textContent = '正在跨片源抓取「伦理片」分类……';
  let r = null;
  try { r = await window.api.browseTagged('伦理片', p); } catch (err) { r = { ok: false, msg: err.message }; }
  if (!r || !r.ok) {
    $('#ethicsHint').textContent = '加载失败：' + ((r && r.msg) || '未知错误');
    return;
  }
  state.ethics.pagecount = r.pagecount || 1;
  const per = r.perSource || [];
  $('#ethicsStatus').innerHTML = per.map((s) => {
    if (!s.ok) return `<span class="src-pill bad" title="${esc(s.error || '')}"><i class="dot"></i>${esc(s.name)} · 失败</span>`;
    if (s.note) return `<span class="src-pill" title="${esc(s.note)}"><i class="dot"></i>${esc(s.name)} · 无此分类</span>`;
    return `<span class="src-pill"><i class="dot"></i>${esc(s.name)} · ${s.count} 条 · ${s.ms}ms</span>`;
  }).join('');
  const okSrc = per.filter((s) => s.ok && s.count > 0).length;
  $('#ethicsHint').textContent = r.groups.length
    ? `共合并 ${r.groups.length} 部影片，来自 ${okSrc} 个片源 · 第 ${r.page}/${r.pagecount} 页。点卡片可看线路与播放。`
    : '这次没有抓到内容：可点右上角「刷新」，或到「片源管理」检查源是否还可用。';
  renderCards($('#ethicsGrid'), r.groups);
  renderEthicsPager(r.page, r.pagecount);
}

function renderEthicsPager(page, pagecount) {
  const box = $('#ethicsPager');
  if (!box) return;
  if (!pagecount || pagecount <= 1) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <button class="ghost-btn" data-p="prev" ${page <= 1 ? 'disabled' : ''}>上一页</button>
    <span class="hint" style="margin:0">${page} / ${pagecount}</span>
    <button class="ghost-btn" data-p="next" ${page >= pagecount ? 'disabled' : ''}>下一页</button>`;
  $$('#ethicsPager button').forEach((b) => b.addEventListener('click', () => {
    loadEthicsPage(b.dataset.p === 'prev' ? page - 1 : page + 1);
    $('#view-ethics').scrollTop = 0;
  }));
}

$('#btnDataDir').addEventListener('click', () => window.api.openDataDir());

/* ---------------- 搜索 ---------------- */
const kwInput = $('#kw');
kwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
$('#btnSearch').addEventListener('click', () => doSearch());

function renderHistoryChips() {
  const box = $('#historyChips');
  const items = state.history.slice(0, 8);
  box.innerHTML = items.map((k) => `<button class="chip" data-kw="${esc(k)}">${esc(k)}</button>`).join('');
  $$('.chip', box).forEach((b) => b.addEventListener('click', () => {
    kwInput.value = b.dataset.kw;
    doSearch();
  }));
}

function addHistory(keyword) {
  state.history = [keyword, ...state.history.filter((k) => k !== keyword)].slice(0, 40);
  window.api.saveHistory(state.history);
  renderHistoryChips();
}

function updateSourceStatus(perSource) {
  const box = $('#sourceStatus');
  if (!perSource || !perSource.length) { box.innerHTML = ''; return; }
  box.innerHTML = perSource.map((s) => {
    if (s.idle) return `<span class="src-pill"><i class="dot"></i>${esc(s.name)}</span>`;
    const cls = s.ok ? '' : 'bad';
    const detail = s.ok ? `${s.count} 条 · ${s.ms}ms` : (esc(s.error || '失败'));
    return `<span class="src-pill ${cls}" title="${esc(s.error || '')}"><i class="dot"></i>${esc(s.name)} · ${detail}</span>`;
  }).join('');
}

async function doSearch() {
  const keyword = kwInput.value.trim();
  if (!keyword) { kwInput.focus(); return; }
  const deep = $('#deepSearch').checked;
  const btn = $('#btnSearch');
  btn.disabled = true;
  btn.textContent = '搜索中…';
  $('#searchHint').textContent = '正在并发搜索所有启用的片源，请稍候……';
  $('#searchResults').innerHTML = '';
  updateSourceStatus(state.sources.filter((s) => s.enabled).map((s) => ({ name: s.name, idle: true })));

  try {
    const res = await window.api.search(keyword, deep);
    if (!res.ok) { toast(res.msg || '搜索失败'); $('#searchHint').textContent = res.msg || '搜索失败'; return; }
    updateSourceStatus(res.perSource);
    state.groups = res.groups || [];
    renderCards($('#searchResults'), state.groups);
    const hits = state.groups.length;
    const okSources = (res.perSource || []).filter((s) => s.ok && s.count > 0).length;
    $('#searchHint').textContent = hits
      ? `「${keyword}」共匹配 ${hits} 部影片，来自 ${okSources} 个有结果的片源。点卡片查看线路与选集。`
      : `「${keyword}」没有搜到结果，可换个关键词、勾选深度搜索，或在「片源管理」里检查源是否可用。`;
    addHistory(keyword);
  } catch (err) {
    $('#searchHint').textContent = '搜索出错：' + (err && err.message ? err.message : err);
  } finally {
    btn.disabled = false;
    btn.textContent = '搜索';
  }
}

/* ---------------- 卡片渲染 ---------------- */
function isFav(key) { return state.favorites.some((f) => f.key === key); }

function cardHtml(g) {
  const poster = g.poster
    ? `<img src="${esc(g.poster)}" alt="" data-fallback>`
    : `<div class="poster-ph">无封面</div>`;
  const meta = [g.year, g.type].filter(Boolean).join(' · ');
  const epText = g.episodeMax > 1 ? `${g.episodeMax} 集` : '';
  return `
    <div class="card" data-key="${esc(g.key)}">
      <div class="card-poster">
        ${poster}
        <span class="badge">${g.sourceCount} 源${epText ? ' · ' + esc(epText) : ''}</span>
        ${g.remarks ? `<span class="remark">${esc(g.remarks)}</span>` : ''}
        ${isFav(g.key) ? '<span class="fav-flag">★</span>' : ''}
      </div>
      <div class="card-title">${esc(g.title)}</div>
      <div class="card-sub">${esc(meta || (g.area || '') || '—')}</div>
    </div>`;
}

function renderCards(container, groups, onClickExtra) {
  if (!groups.length) {
    container.innerHTML = '<div class="empty-tip">暂无结果</div>';
    return;
  }
  container.innerHTML = groups.map(cardHtml).join('');
  fixImages(container);
  $$('.card', container).forEach((el) => {
    el.addEventListener('click', () => {
      const g = groups.find((x) => x.key === el.dataset.key);
      if (onClickExtra) onClickExtra(g); else openDetail(g);
    });
  });
}

/* ---------------- 详情 ---------------- */
function openDetail(group) {
  state.detail = { group, sourceIdx: 0, lineIdx: 0 };
  renderDetail();
  $('#detailMask').classList.add('show');
}
function closeDetail() {
  $('#detailMask').classList.remove('show');
  state.detail = null;
}
$('#detailClose').addEventListener('click', closeDetail);
$('#detailMask').addEventListener('click', (e) => { if (e.target.id === 'detailMask') closeDetail(); });

function renderDetail() {
  const d = state.detail;
  if (!d) return;
  const g = d.group;
  const src = g.sources[d.sourceIdx] || {};
  const line = (src.playGroups || [])[d.lineIdx] || null;

  $('#dTitle').textContent = g.title;
  $('#dPoster').style.display = g.poster ? 'block' : 'none';
  if (g.poster) { $('#dPoster').src = g.poster; }
  $('#dPosterPh').style.display = g.poster ? 'none' : 'flex';
  $('#dSub').textContent = [g.year, g.area, g.type, g.score ? `${g.score} 分` : '', g.remarks].filter(Boolean).join(' · ');
  $('#dActors').textContent = [g.director ? '导演：' + g.director : '', g.actors ? '主演：' + g.actors : ''].filter(Boolean).join('　');
  $('#dIntro').textContent = g.content || '暂无简介';

  const favBtn = $('#btnFav');
  favBtn.textContent = isFav(g.key) ? '★ 已收藏' : '★ 收藏';

  // 片源 tabs
  $('#dSourceTabs').innerHTML = g.sources.map((s, i) => {
    const n = s.episodes || 0;
    return `<button class="tab ${i === d.sourceIdx ? 'active' : ''}" data-i="${i}">${esc(s.sourceName)} · ${n ? n + (n > 1 ? ' 集' : ' 集') : '无地址'}</button>`;
  }).join('');
  $$('#dSourceTabs .tab').forEach((b) => b.addEventListener('click', () => {
    state.detail.sourceIdx = Number(b.dataset.i);
    state.detail.lineIdx = 0;
    renderDetail();
  }));

  // 播放线路 tabs（同一片源可能有多条线路）
  const groups = src.playGroups || [];
  if (groups.length > 1) {
    $('#dLineTabs').innerHTML = groups.map((gr, i) =>
      `<button class="tab ${i === d.lineIdx ? 'active' : ''}" data-i="${i}">${esc(gr.from)}（${gr.items.length}）</button>`
    ).join('');
    $$('#dLineTabs .tab').forEach((b) => b.addEventListener('click', () => {
      state.detail.lineIdx = Number(b.dataset.i);
      renderDetail();
    }));
  } else {
    $('#dLineTabs').innerHTML = '';
  }

  // 剧集（每集右下角带一个下载按钮）
  if (line && line.items.length) {
    $('#dEpisodes').innerHTML = line.items.map((it, i) =>
      `<div class="ep-cell"><button class="ep" data-i="${i}" title="${esc(it.url)}">${esc(it.name)}</button><button class="ep-dl" data-dl="${i}" title="下载这一集到本地">⤓</button></div>`
    ).join('');
    $$('#dEpisodes .ep').forEach((b) => b.addEventListener('click', () => {
      openPlayer(d.sourceIdx, d.lineIdx, Number(b.dataset.i));
    }));
    $$('#dEpisodes .ep-dl').forEach((b) => b.addEventListener('click', () => {
      const it = line.items[Number(b.dataset.dl)];
      if (!it) return;
      enqueueDownload({ playUrl: it.url, title: g.title, epName: it.name });
      toast('已加入下载队列：' + it.name);
    }));
  } else {
    $('#dEpisodes').innerHTML = '<div class="empty-tip">这个片源没有提供可播放地址，试试切换上面的其他片源。</div>';
  }
}

/* ---------------- 下载 ---------------- */
const DL = { queue: [], pending: new Map(), active: 0, max: 1 };

function dlFmtBytes(n) {
  if (!n) return '0 MB';
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}

function enqueueDownload(item) {
  DL.queue.push(item);
  pumpDownload();
}

function pumpDownload() {
  while (DL.active < DL.max && DL.queue.length) {
    const item = DL.queue.shift();
    DL.active++;
    window.api.downloadStart(item)
      .then((id) => { if (id) DL.pending.set(id, item); })
      .catch((err) => {
        DL.active = Math.max(0, DL.active - 1);
        toast('下载启动失败：' + err.message);
        pumpDownload();
      });
  }
}

function renderDlItem(e) {
  const panel = $('#dlPanel');
  if (!panel) return;
  panel.classList.add('show');
  const key = 'dl-' + e.id;
  let el = document.getElementById(key);
  if (!el) {
    el = document.createElement('div');
    el.className = 'dl-item';
    el.id = key;
    el.innerHTML = `
      <div class="dl-name"></div>
      <div class="dl-bar"><i></i></div>
      <div class="dl-meta"><span class="dl-state"></span><button class="dl-ctl" data-ctl="cancel">取消</button></div>`;
    const list = $('#dlList');
    list.insertBefore(el, list.firstChild);
    const ctl = el.querySelector('.dl-ctl');
    ctl.addEventListener('click', () => {
      const phase = ctl.dataset.phase || '';
      if (phase === 'done') { window.api.openDownloadDir(); return; }
      if (phase === 'error' || phase === 'canceled') { el.remove(); return; }
      window.api.downloadCancel(e.id);
      ctl.textContent = '取消中…';
    });
  }
  const name = [e.title, e.epName].filter(Boolean).join(' · ');
  el.querySelector('.dl-name').textContent = name || '影片';
  const bar = el.querySelector('.dl-bar');
  const fill = bar.querySelector('i');
  const ctl = el.querySelector('.dl-ctl');
  const pct = e.total ? Math.min(100, Math.round((e.done / e.total) * 100)) : 0;
  fill.style.width = (e.phase === 'done' ? 100 : pct) + '%';
  bar.classList.toggle('err', e.phase === 'error');
  bar.classList.toggle('ok', e.phase === 'done');

  let text = '';
  ctl.dataset.phase = e.phase;
  if (e.phase === 'prepare') text = '正在解析线路…';
  else if (e.phase === 'download') {
    text = `${pct}%（${e.done}/${e.total} 片） ${dlFmtBytes(e.bytes)}` + (e.speed ? ` · ${dlFmtBytes(e.speed)}/s` : '');
    ctl.textContent = '取消';
    ctl.style.display = '';
  } else if (e.phase === 'done') {
    text = `已完成 · ${dlFmtBytes(e.bytes)} · ${e.total} 片`;
    ctl.textContent = '打开文件夹';
    ctl.style.display = '';
  } else if (e.phase === 'canceled') {
    text = '已取消';
    ctl.textContent = '清除';
  } else {
    text = '失败：' + (e.error || '未知原因');
    ctl.textContent = '清除';
  }
  el.querySelector('.dl-state').textContent = text;
}

/* 下载进度事件（主进程推送） */
function onDownloadEvent(e) {
  if (!e || !e.id) return;
  renderDlItem(e);
  if (['done', 'error', 'canceled'].includes(e.phase) && DL.pending.has(e.id)) {
    DL.pending.delete(e.id);
    DL.active = Math.max(0, DL.active - 1);
    setTimeout(pumpDownload, 400);
  }
  if (e.phase === 'done') toast('下载完成：' + [e.title, e.epName].filter(Boolean).join(' · '));
  else if (e.phase === 'error') toast('下载失败：' + (e.error || '未知原因'));
}

$('#dlHide') && $('#dlHide').addEventListener('click', () => $('#dlPanel').classList.remove('show'));
$('#btnOpenDlDir') && $('#btnOpenDlDir').addEventListener('click', () => window.api.openDownloadDir());

$('#btnDlLine') && $('#btnDlLine').addEventListener('click', () => {
  const d = state.detail;
  if (!d) return;
  const src = d.group.sources[d.sourceIdx] || {};
  const line = (src.playGroups || [])[d.lineIdx];
  if (!line || !line.items.length) { toast('这条线路没有可下载的地址'); return; }
  line.items.forEach((it) => DL.queue.push({ playUrl: it.url, title: d.group.title, epName: it.name }));
  pumpDownload();
  toast(`已加入下载队列：${line.items.length} 集（下载到 D:\\DoubaoTV\\downloads）`);
});

$('#dPoster').addEventListener('error', () => {
  $('#dPoster').style.display = 'none';
  $('#dPosterPh').style.display = 'flex';
});

$('#btnFav').addEventListener('click', () => {
  const g = state.detail && state.detail.group;
  if (!g) return;
  const idx = state.favorites.findIndex((f) => f.key === g.key);
  if (idx >= 0) {
    state.favorites.splice(idx, 1);
    toast('已取消收藏');
  } else {
    state.favorites.unshift({ key: g.key, title: g.title, poster: g.poster, year: g.year, type: g.type, addTime: Date.now() });
    toast('已加入收藏');
  }
  window.api.saveFavorites(state.favorites);
  $('#btnFav').textContent = isFav(g.key) ? '★ 已收藏' : '★ 收藏';
});

/* ---------------- 收藏 ---------------- */
function renderFavorites() {
  const box = $('#favGrid');
  if (!state.favorites.length) {
    box.innerHTML = '<div class="empty-tip">还没有收藏。在影片详情里点「★ 收藏」即可。</div>';
    return;
  }
  const asGroups = state.favorites.map((f) => ({
    key: f.key, title: f.title, poster: f.poster, year: f.year, type: f.type,
    sourceCount: 0, episodeMax: 0, remarks: '', sources: []
  }));
  renderCards(box, asGroups, (g) => {
    kwInput.value = g.title;
    switchView('search');
    doSearch();
  });
}

$('#btnClearFav').addEventListener('click', () => {
  if (!state.favorites.length) return;
  if (!confirm('确定清空全部收藏吗？')) return;
  state.favorites = [];
  window.api.saveFavorites(state.favorites);
  renderFavorites();
});

/* ---------------- 片源管理 ---------------- */
let sourceTestResults = {};

function renderSources() {
  const box = $('#sourceList');
  if (!state.sources.length) {
    box.innerHTML = '<div class="empty-tip">还没有片源，请在下方添加。</div>';
    return;
  }
  box.innerHTML = state.sources.map((s, i) => {
    const r = sourceTestResults[s.id];
    const msg = r ? `<span class="src-msg ${r.ok ? 'ok' : 'bad'}">${esc(r.ok ? `${r.count} 条 / ${r.ms}ms` : r.msg)}</span>` : '<span class="src-msg"></span>';
    return `
      <div class="source-row ${s.enabled ? '' : 'disabled'}" data-i="${i}">
        <input type="checkbox" ${s.enabled ? 'checked' : ''} data-act="toggle" title="启用/停用" />
        <div>
          <div class="src-name">${esc(s.name)}</div>
          <div class="src-url">${esc(s.url)}</div>
        </div>
        ${msg}
        <button class="mini-btn" data-act="test">测速</button>
        <button class="mini-btn danger" data-act="del">删除</button>
      </div>`;
  }).join('');

  $$('#sourceList .source-row').forEach((row) => {
    const i = Number(row.dataset.i);
    row.querySelector('[data-act=toggle]').addEventListener('change', (e) => {
      state.sources[i].enabled = e.target.checked;
      persistSources();
      renderSources();
    });
    row.querySelector('[data-act=test]').addEventListener('click', async (e) => {
      const btn = e.target;
      btn.disabled = true; btn.textContent = '测速中';
      const r = await window.api.testSource(state.sources[i].url);
      sourceTestResults[state.sources[i].id] = r;
      btn.disabled = false; btn.textContent = '测速';
      renderSources();
      toast(`${state.sources[i].name}：${r.msg}`);
    });
    row.querySelector('[data-act=del]').addEventListener('click', () => {
      if (!confirm(`删除片源「${state.sources[i].name}」？`)) return;
      state.sources.splice(i, 1);
      persistSources();
      renderSources();
    });
  });
}

async function persistSources() {
  const r = await window.api.saveSources(state.sources);
  if (!r.ok) toast(r.msg || '保存失败');
}

$('#btnAddSource').addEventListener('click', async () => {
  const name = $('#newName').value.trim();
  const url = $('#newUrl').value.trim();
  if (!url) { toast('请填写接口地址'); return; }
  if (!/^http(s)?:\/\//i.test(url)) { toast('接口地址需以 http(s):// 开头'); return; }
  const id = 'u' + Date.now();
  state.sources.push({ id, name: name || url.replace(/^http(s)?:\/\//, '').split('/')[0], url, enabled: true });
  $('#newName').value = ''; $('#newUrl').value = '';
  await persistSources();
  renderSources();
  toast('已添加，正在测速……');
  const r = await window.api.testSource(url);
  sourceTestResults[id] = r;
  renderSources();
  toast(r.msg);
});

$('#btnTestAll').addEventListener('click', async () => {
  const btn = $('#btnTestAll');
  btn.disabled = true; btn.textContent = '测速中…';
  const enabled = state.sources.filter((s) => s.enabled);
  await Promise.all(enabled.map(async (s) => {
    sourceTestResults[s.id] = await window.api.testSource(s.url);
    renderSources();
  }));
  btn.disabled = false; btn.textContent = '一键测速';
  const ok = enabled.filter((s) => sourceTestResults[s.id] && sourceTestResults[s.id].ok).length;
  toast(`测速完成：${ok}/${enabled.length} 个源可用`);
});

$('#btnExport').addEventListener('click', async () => {
  const text = JSON.stringify(state.sources, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    $('#importBox').value = text;
    toast('配置已复制到剪贴板，并填入下方文本框');
  } catch (_) {
    $('#importBox').value = text;
    toast('配置已填入下方文本框，可自行复制');
  }
});

$('#btnImport').addEventListener('click', () => {
  $('#importBox').focus();
  toast('把配置粘贴到下方文本框，再点「导入上面的内容」');
});

$('#btnImportApply').addEventListener('click', async () => {
  const raw = $('#importBox').value.trim();
  if (!raw) { toast('文本框是空的'); return; }
  let added = 0;
  let arr = null;
  try { arr = JSON.parse(raw); } catch (_) {}
  if (Array.isArray(arr)) {
    arr.forEach((s) => {
      if (s && s.url) {
        state.sources.push({ id: 'i' + Date.now() + added, name: String(s.name || '导入源'), url: String(s.url), enabled: s.enabled !== false });
        added++;
      }
    });
  } else {
    raw.split(/\r?\n/).forEach((line) => {
      const t = line.trim();
      if (!t || !/http(s)?:\/\//i.test(t)) return;
      const m = t.match(/(https?:\/\/\S+)/);
      const url = m ? m[1] : '';
      const name = t.replace(url, '').trim() || url.replace(/^http(s)?:\/\//, '').split('/')[0];
      if (url) {
        state.sources.push({ id: 'i' + Date.now() + added, name, url, enabled: true });
        added++;
      }
    });
  }
  if (!added) { toast('没有识别到有效地址'); return; }
  await persistSources();
  renderSources();
  $('#importBox').value = '';
  toast(`已导入 ${added} 个片源`);
});

/* ---------------- 分类浏览 ---------------- */
let browseClassesLoaded = '';

async function initBrowse() {
  const sel = $('#browseSource');
  const enabled = state.sources.filter((s) => s.enabled);
  if (!enabled.length) {
    $('#classList').innerHTML = '<div class="empty-tip">没有启用的片源</div>';
    $('#browseGrid').innerHTML = '';
    return;
  }
  const current = sel.value || enabled[0].url;
  sel.innerHTML = enabled.map((s) => `<option value="${esc(s.url)}">${esc(s.name)}</option>`).join('');
  if (!enabled.some((s) => s.url === current)) sel.value = enabled[0].url;
  if (browseClassesLoaded !== sel.value) await loadClasses();
}

$('#browseSource').addEventListener('change', async () => {
  state.browse.classId = '';
  state.browse.page = 1;
  await loadClasses();
});

async function loadClasses() {
  const url = $('#browseSource').value;
  browseClassesLoaded = url;
  $('#classList').innerHTML = '<div class="empty-tip">加载分类中…</div>';
  $('#browseGrid').innerHTML = '';
  const r = await window.api.browseClasses(url);
  if (!r.ok) {
    $('#classList').innerHTML = `<div class="empty-tip">分类加载失败：${esc(r.msg)}</div>`;
    return;
  }
  $('#classList').innerHTML = r.classes.map((c) =>
    `<div class="class-item" data-id="${esc(c.id)}">${esc(c.name)}</div>`
  ).join('');
  $$('#classList .class-item').forEach((el) => el.addEventListener('click', () => {
    $$('#classList .class-item').forEach((x) => x.classList.remove('active'));
    el.classList.add('active');
    state.browse.classId = el.dataset.id;
    state.browse.page = 1;
    loadBrowsePage();
  }));
  if (r.classes.length) {
    state.browse.classId = r.classes[0].id;
    $('.class-item', $('#classList')).classList.add('active');
    loadBrowsePage();
  }
}

async function loadBrowsePage() {
  if (!state.browse.classId) return;
  const url = $('#browseSource').value;
  $('#browseInfo').textContent = '加载中…';
  $('#browseGrid').innerHTML = '';
  const r = await window.api.browseList(url, state.browse.classId, state.browse.page);
  if (!r.ok) {
    $('#browseInfo').textContent = '加载失败：' + r.msg;
    return;
  }
  state.browse.pagecount = r.pagecount;
  state.browse.total = r.total;
  $('#browseInfo').textContent = `共 ${r.total} 条 · 第 ${r.page}/${r.pagecount} 页`;
  renderCards($('#browseGrid'), r.groups);
  renderPager(r.page, r.pagecount);
}

function renderPager(page, pagecount) {
  const box = $('#browsePager');
  if (pagecount <= 1) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <button class="ghost-btn" data-p="prev" ${page <= 1 ? 'disabled' : ''}>上一页</button>
    <span class="hint" style="margin:0">${page} / ${pagecount}</span>
    <button class="ghost-btn" data-p="next" ${page >= pagecount ? 'disabled' : ''}>下一页</button>`;
  $$('#browsePager button').forEach((b) => b.addEventListener('click', () => {
    state.browse.page = b.dataset.p === 'prev' ? page - 1 : page + 1;
    loadBrowsePage();
    $('#view-browse').scrollTop = 0;
  }));
}

/* ---------------- 播放器 ---------------- */
const P = { hls: null, group: null, sourceIdx: 0, lineIdx: 0, epIdx: 0, playUrl: '', triedHls: false, failCount: 0, hideTimer: null, tried: new Set() };
const video = $('#video');
const player = $('#player');

/* 画面尺寸：默认「原始」＝最多按片源真实分辨率显示，不放大（低分辨率片源放大就会糊）；
   「铺满」则填满窗口（object-fit contain 仍然不裁切、不变形）。 */
let fitActual = true;

function applyFitMode() {
  const btn = $('#btnFit');
  if (fitActual) {
    video.classList.remove('fill');
    // 关键：CSS 像素 × devicePixelRatio 才是真实显示像素。
    // 这里按「1 个视频像素 = 1 个屏幕物理像素」封顶，4K 屏 175% 缩放下也不会把 1080p 放大到发虚。
    const dpr = window.devicePixelRatio || 1;
    const w = video.videoWidth || 0;
    const h = video.videoHeight || 0;
    video.style.maxWidth = w ? Math.round(w / dpr) + 'px' : '';
    video.style.maxHeight = h ? Math.round(h / dpr) + 'px' : '';
  } else {
    video.classList.add('fill');
    video.style.maxWidth = '';
    video.style.maxHeight = '';
  }
  if (btn) {
    btn.textContent = fitActual ? '原始' : '铺满';
    btn.classList.toggle('on', fitActual);
  }
}

video.addEventListener('loadedmetadata', applyFitMode);
video.addEventListener('resize', applyFitMode);

function episodeList() {
  const g = P.group;
  if (!g) return null;
  const src = g.sources[P.sourceIdx] || {};
  const line = (src.playGroups || [])[P.lineIdx];
  return line ? line.items : null;
}

function openPlayer(sourceIdx, lineIdx, epIdx) {
  const g = state.detail && state.detail.group;
  if (!g) return;
  P.group = g;
  P.sourceIdx = sourceIdx;
  P.lineIdx = lineIdx;
  P.epIdx = epIdx;
  P.tried = new Set();
  player.classList.add('show', 'pinned');
  clearTimeout(P.hideTimer);
  P.hideTimer = setTimeout(() => player.classList.remove('pinned'), 2600);
  startEpisode();
}

async function startEpisode(auto) {
  const list = episodeList();
  if (!list || !list[P.epIdx]) { showPlayerError('没有找到可播放的地址'); return; }
  const ep = list[P.epIdx];
  const src = P.group.sources[P.sourceIdx];
  $('#pTitle').textContent = P.group.title;
  $('#pEpisode').textContent = `${src.sourceName} · ${ep.name}（${P.epIdx + 1}/${list.length}）`;
  $('#playerError').classList.remove('show');
  $('#playerLoading').classList.add('show');
  $('#playerLoadingText').textContent = auto ? '这条线路打不开，正在自动换下一条……' : '正在解析片源地址……';
  P.tried.add(`${P.sourceIdx}|${P.lineIdx}`);
  const r = await window.api.resolveStream(ep.url);
  if (!r.ok) { tryNextLine(r.msg || '解析失败'); return; }
  playMedia(r.url);
}

// 当前线路失效时，按顺序尝试该片的其它线路／其它片源；全部试完才报错
function tryNextLine(reason) {
  const g = P.group;
  if (g) {
    for (let si = 0; si < g.sources.length; si++) {
      const groups = (g.sources[si].playGroups || []);
      for (let li = 0; li < groups.length; li++) {
        if (P.tried.has(`${si}|${li}`)) continue;
        const items = (groups[li] && groups[li].items) || [];
        if (!items[P.epIdx]) continue;
        P.sourceIdx = si; P.lineIdx = li;
        startEpisode(true);
        return;
      }
    }
  }
  showPlayerError(`片源线路失效（${reason}）。这部片的所有线路都打不开了，返回详情换一部片子，或在「片源管理」里换片源再试。`);
}

function cleanupPlayer() {
  if (P.hls) { try { P.hls.destroy(); } catch (_) {} P.hls = null; }
  try { video.pause(); } catch (_) {}
  video.removeAttribute('src');
  try { video.load(); } catch (_) {}
  updateQualityBtn(null);
}

function looksHls(url) {
  return /\.m3u8(\?|#|$)/i.test(url) || /m3u8/i.test(url) || /\/hls\//i.test(url);
}

function playMedia(url) {
  cleanupPlayer();
  P.playUrl = url;
  P.failCount = 0;
  $('#playerLoading').classList.add('show');
  $('#playerLoadingText').textContent = '正在加载片源……';
  $('#playerError').classList.remove('show');

  if (looksHls(url) || (window.Hls && Hls.isSupported() && !/\.(mp4|mp3|mkv)(\?|#|$)/i.test(url))) {
    startHls(url);
  } else {
    startNative(url);
  }
}

function startHls(url) {
  if (!window.Hls || !Hls.isSupported()) { startNative(url); return; }
  P.triedHls = true;
  const hls = new Hls({
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
    enableWorker: true,
    lowLatencyMode: false,
    manifestLoadingTimeOut: 15000,
    manifestLoadingMaxRetry: 3,
    fragLoadingTimeOut: 20000,
    fragLoadingMaxRetry: 4,
    // 画质相关：不按窗口大小裁档，允许更长的缓冲，优先清晰度
    capLevelToPlayerSize: false,
    startLevel: -1,
    abrEwmaDefaultEstimate: 1500000,
    maxBufferSize: 60 * 1000 * 1000
  });
  P.hls = hls;
  hls.attachMedia(video);
  hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(url));
  hls.on(Hls.Events.MANIFEST_PARSED, () => {
    applyQualityPreference(hls);
    $('#playerLoading').classList.remove('show');
    video.play().catch(() => {
      $('#playerLoading').classList.remove('show');
      video.muted = true;
      video.play().catch(() => {});
    });
  });
  hls.on(Hls.Events.LEVEL_SWITCHED, () => updateQualityBtn(hls));
  hls.on(Hls.Events.ERROR, (_e, data) => {
    if (!data || !data.fatal) return;
    P.failCount++;
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR && P.failCount <= 2) {
      $('#playerLoadingText').textContent = '网络异常，正在重试……';
      setTimeout(() => { try { hls.startLoad(); } catch (_) {} }, 1200);
      return;
    }
    if (P.failCount <= 2 && data.type === Hls.ErrorTypes.MEDIA_ERROR) {
      setTimeout(() => { try { hls.recoverMediaError(); } catch (_) {} }, 800);
      return;
    }
    tryNextLine(data.details || data.type);
  });
}

// 画质偏好：固定最高档（清晰优先）或交给 ABR 自动调节（流畅优先）
function applyQualityPreference(hls) {
  if (!hls || !hls.levels || !hls.levels.length) return;
  if (state.qualityHigh) hls.currentLevel = hls.levels.length - 1;
  else hls.currentLevel = -1;
  updateQualityBtn(hls);
}

function updateQualityBtn(hls) {
  const btn = $('#btnQuality');
  if (!btn) return;
  const levels = (hls && hls.levels) || [];
  const idx = hls ? (hls.currentLevel >= 0 ? hls.currentLevel : (hls.level >= 0 ? hls.level : 0)) : 0;
  const lv = levels[idx];
  let label = state.qualityHigh ? '最高' : '自动';
  if (video.videoWidth > 0) label = `${video.videoWidth}×${video.videoHeight}`;
  else if (lv && lv.width && lv.height) label = `${lv.width}×${lv.height}`;
  else if (lv && lv.height) label = `${lv.height}p`;
  else if (levels.length === 1) label = '单一档';
  btn.textContent = label;
  btn.classList.toggle('on', !!state.qualityHigh);
  const bitrate = lv && lv.bitrate ? `${Math.round(lv.bitrate / 1000)}k` : '';
  btn.title = levels.length > 1
    ? `当前 ${label}${bitrate ? ' · ' + bitrate : ''}（共 ${levels.length} 档，${state.qualityHigh ? '已锁定最高档' : '自动升降档'}）· 点击切换`
    : `当前 ${label}${bitrate ? ' · ' + bitrate : ''}（源只提供这一档，画质上限由片源决定）· 点击切换自动/最高`;
}

function startNative(url) {
  const qbtn = $('#btnQuality');
  if (qbtn) { qbtn.textContent = '原始'; qbtn.title = '直链视频（mp4 等），画质由文件本身决定'; }
  video.src = url;
  video.play().catch(() => {});
  video.addEventListener('loadedmetadata', () => $('#playerLoading').classList.remove('show'), { once: true });
  video.addEventListener('error', () => {
    $('#playerLoading').classList.remove('show');
    if (!P.triedHls) { startHls(url); return; }
    tryNextLine('直链无法播放');
  }, { once: true });
  setTimeout(() => {
    if (video.readyState >= 2) $('#playerLoading').classList.remove('show');
  }, 1200);
}

function showPlayerError(msg) {
  $('#playerLoading').classList.remove('show');
  $('#playerErrorText').textContent = msg;
  $('#playerError').classList.add('show');
}

function closePlayer() {
  cleanupPlayer();
  player.classList.remove('show', 'pinned');
}

$('#btnClosePlayer').addEventListener('click', closePlayer);
$('#btnBack').addEventListener('click', closePlayer);
$('#btnRetry').addEventListener('click', () => { $('#playerError').classList.remove('show'); playMedia(P.playUrl); });
$('#btnBrowser').addEventListener('click', () => { if (P.playUrl) window.api.openExternal(P.playUrl); });

$('#btnPrevEp').addEventListener('click', () => {
  const list = episodeList();
  if (!list) return;
  if (P.epIdx > 0) { P.epIdx--; startEpisode(); } else toast('已经是第一集');
});
$('#btnNextEp').addEventListener('click', () => {
  const list = episodeList();
  if (!list) return;
  if (P.epIdx < list.length - 1) { P.epIdx++; startEpisode(); } else toast('已经是最后一集');
});

$('#btnPlay').addEventListener('click', () => {
  if (video.paused) video.play().catch(() => {}); else video.pause();
});
video.addEventListener('play', () => { $('#btnPlay').textContent = '❚❚'; });
video.addEventListener('pause', () => { $('#btnPlay').textContent = '▶'; });
video.addEventListener('timeupdate', updateTimeUi);
video.addEventListener('progress', updateTimeUi);
video.addEventListener('loadedmetadata', updateTimeUi);
video.addEventListener('waiting', () => $('#playerLoading').classList.add('show'));
video.addEventListener('playing', () => $('#playerLoading').classList.remove('show'));

function updateTimeUi() {
  const cur = video.currentTime || 0;
  const dur = isFinite(video.duration) ? video.duration : 0;
  $('#timeLabel').textContent = `${fmtTime(cur)} / ${dur ? fmtTime(dur) : '直播 / 未知'}`;
  const pct = dur ? (cur / dur) * 100 : 0;
  $('#seekPlayed').style.width = pct + '%';
  try {
    if (dur && video.buffered.length) {
      const end = video.buffered.end(video.buffered.length - 1);
      $('#seekBuffered').style.width = Math.min(100, (end / dur) * 100) + '%';
    }
  } catch (_) {}
}

$('#seekBar').addEventListener('click', (e) => {
  if (!isFinite(video.duration)) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  video.currentTime = ratio * video.duration;
});

$('#volBar').addEventListener('input', (e) => {
  video.volume = Number(e.target.value);
  $('#btnVol').textContent = video.volume === 0 ? '🔇' : '🔊';
});
$('#btnVol').addEventListener('click', () => {
  video.muted = !video.muted;
  $('#btnVol').textContent = video.muted || video.volume === 0 ? '🔇' : '🔊';
});

const RATES = [1, 1.25, 1.5, 2, 0.75];
let rateIdx = 0;
// 拿真实解码分辨率刷新画质徽标（源站 m3u8 里的 RESOLUTION 常写得不准）
video.addEventListener('loadedmetadata', () => updateQualityBtn(P.hls));
video.addEventListener('resize', () => updateQualityBtn(P.hls));
$('#btnRate').addEventListener('click', () => {
  rateIdx = (rateIdx + 1) % RATES.length;
  video.playbackRate = RATES[rateIdx];
  $('#btnRate').textContent = `${RATES[rateIdx]}x`;
});

$('#btnQuality').addEventListener('click', async () => {
  state.qualityHigh = !state.qualityHigh;
  state.cfg.qualityHigh = state.qualityHigh;
  try { await window.api.saveConfig({ qualityHigh: state.qualityHigh }); } catch (_) {}
  if (P.hls) applyQualityPreference(P.hls); else updateQualityBtn(null);
  toast(state.qualityHigh ? '已切到固定最高画质（网络吃紧时可切回自动）' : '已切到自动画质：按带宽自动升降档');
});

$('#btnFit').addEventListener('click', () => {
  fitActual = !fitActual;
  applyFitMode();
  toast(fitActual ? '已切到「原始尺寸」：按片源分辨率显示，不放大，最清晰' : '已切到「铺满窗口」：小片源会被放大，可能发虚');
});

$('#btnFull').addEventListener('click', () => {
  if (!document.fullscreenElement) player.requestFullscreen().catch(() => {});
  else document.exitFullscreen().catch(() => {});
});

player.addEventListener('mousemove', () => {
  player.classList.add('pinned');
  clearTimeout(P.hideTimer);
  P.hideTimer = setTimeout(() => player.classList.remove('pinned'), 2600);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (player.classList.contains('show')) { closePlayer(); return; }
    if ($('#detailMask').classList.contains('show')) { closeDetail(); return; }
  }
  if (!player.classList.contains('show')) return;
  if (e.target && /INPUT|TEXTAREA|SELECT/.test(e.target.tagName)) return;
  if (e.code === 'Space') { e.preventDefault(); if (video.paused) video.play(); else video.pause(); }
  else if (e.code === 'ArrowLeft') { video.currentTime = Math.max(0, video.currentTime - 10); }
  else if (e.code === 'ArrowRight') { video.currentTime = Math.min(video.duration || 1e9, video.currentTime + 10); }
  else if (e.code === 'ArrowUp') { e.preventDefault(); video.volume = Math.min(1, video.volume + 0.05); $('#volBar').value = video.volume; }
  else if (e.code === 'ArrowDown') { e.preventDefault(); video.volume = Math.max(0, video.volume - 0.05); $('#volBar').value = video.volume; }
  else if (e.key === 'f' || e.key === 'F') { $('#btnFull').click(); }
});

video.volume = 0.8;

/* 界面整体缩放：Ctrl + / - / 0（列表、卡片、播放器一起缩放，设置会被记住） */
async function applyZoom(action) {
  try {
    const v = await window.api.uiZoom(action);
    const pct = Math.round(Number(v) * 100);
    toast(action === 'reset' ? '界面缩放已复位到 100%' : `界面缩放 ${pct}%`);
  } catch (_) {}
}

document.addEventListener('keydown', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  if (e.key === '=' || e.key === '+') { e.preventDefault(); applyZoom('in'); }
  else if (e.key === '-' || e.key === '_') { e.preventDefault(); applyZoom('out'); }
  else if (e.key === '0') { e.preventDefault(); applyZoom('reset'); }
});

boot().catch((e) => toast('初始化出错：' + e.message));
