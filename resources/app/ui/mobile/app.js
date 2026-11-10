(function () {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const TAGS = ['伦理片', '电影', '电视剧', '动漫', '综艺', '动作片', '喜剧片', '爱情片', '科幻片', '恐怖片'];

  const state = { info: null, keyword: '', groups: [], cur: null, curSrcIdx: 0 };

  let toastTimer = null;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  async function api(path, params) {
    const qs = new URLSearchParams(params || {}).toString();
    const r = await fetch(path + (qs ? '?' + qs : ''), { headers: { Accept: 'application/json' } });
    return r.json();
  }

  // ---------- 首页 ----------
  async function loadInfo() {
    try {
      const info = await api('/api/info');
      state.info = info;
      $('#sub').textContent = info.ok ? `手机版 · ${info.sources} 个片源` : '手机版';
    } catch (_) {}
  }

  function renderChips() {
    $('#chips').innerHTML = TAGS.map((t) => `<button class="chip" data-tag="${t}">${t}</button>`).join('');
    $$('#chips .chip').forEach((b) => {
      b.addEventListener('click', () => {
        $('#wd').value = b.dataset.tag;
        doSearch(b.dataset.tag);
      });
    });
  }

  function setEmpty(text) {
    const el = $('#empty');
    el.style.display = text ? 'block' : 'none';
    el.textContent = text || '';
  }

  async function doSearch(wd) {
    const keyword = String(wd || '').trim();
    if (!keyword) return toast('先输入片名');
    state.keyword = keyword;
    setEmpty('正在跨片源搜索……');
    $('#grid').innerHTML = '';
    try {
      const r = await api('/api/search', { wd: keyword, deep: '1' });
      if (!r.ok) { setEmpty(r.msg || '搜索失败'); return; }
      state.groups = r.groups || [];
      render();
      if (!state.groups.length) setEmpty('没搜到，换个片名试试');
      else setEmpty('');
    } catch (err) {
      setEmpty('搜索出错：' + err.message);
    }
  }

  function render() {
    const grid = $('#grid');
    grid.innerHTML = state.groups.map((g, i) => `
      <div class="card" data-i="${i}">
        <img class="pic" loading="lazy" referrerpolicy="no-referrer" src="${escapeAttr(g.poster)}" alt="" onerror="this.style.visibility='hidden'" />
        <div class="info">
          <div class="t">${escapeHtml(g.title)}</div>
          <div class="m"><span>${escapeHtml(g.remarks || g.year || '')}</span><span>${g.sourceCount} 源</span></div>
        </div>
      </div>`).join('');
    $$('#grid .card').forEach((c) => {
      c.addEventListener('click', () => {
        const g = state.groups[Number(c.dataset.i)];
        if (g) openDetail(g, 0);
      });
    });
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  }
  function escapeAttr(s) {
    const v = String(s == null ? '' : s);
    return /^https?:\/\//i.test(v) ? escapeHtml(v) : '';
  }

  // ---------- 详情 ----------
  async function openDetail(group, srcIdx) {
    state.cur = group;
    state.curSrcIdx = srcIdx || 0;
    const v = group.sources[state.curSrcIdx];
    $('#dTitle').textContent = group.title;
    $('#dMeta').textContent = [group.year, group.type, group.remarks].filter(Boolean).join(' · ');
    $('#sheet').classList.add('show');
    $('#dLines').innerHTML = '<div class="line-title">正在取线路……</div>';
    renderSrcLine(group);

    if (!v) { $('#dLines').innerHTML = '<div class="line-title">这个条目没有可用线路</div>'; return; }
    try {
      const r = await api('/api/detail', { src: v.src, id: v.vodId });
      if (!r.ok) { $('#dLines').innerHTML = '<div class="line-title">取详情失败：' + escapeHtml(r.msg || '') + '</div>'; return; }
      const lines = r.lines || [];
      if (!lines.length) { $('#dLines').innerHTML = '<div class="line-title">这个源没有可用播放线路</div>'; return; }
      $('#dLines').innerHTML = lines.map((ln, li) => `
        <div class="line">
          <div class="src">${escapeHtml(v.name)} · ${escapeHtml(ln.from)}（${ln.items.length} 集）</div>
          <div class="eps">${ln.items.map((it, ei) => `<button class="ep" data-l="${li}" data-e="${ei}">${escapeHtml(it.name)}</button>`).join('')}</div>
        </div>`).join('');
      $$('#dLines .ep').forEach((b) => {
        b.addEventListener('click', () => {
          const ln = lines[Number(b.dataset.l)];
          const ep = ln.items[Number(b.dataset.e)];
          playEpisode(ep, `${group.title} · ${ln.from} · ${ep.name}`);
        });
      });
    } catch (err) {
      $('#dLines').innerHTML = '<div class="line-title">取详情出错：' + escapeHtml(err.message) + '</div>';
    }
  }

  function renderSrcLine(group) {
    const box = $('#dSrc');
    if (!group.sources || group.sources.length <= 1) { box.innerHTML = ''; return; }
    box.innerHTML = '<div class="src-title">换个片源试试（不同源清晰度不同）</div>' +
      `<div class="srcline">${group.sources.map((s, i) => `<button class="chip ${i === state.curSrcIdx ? 'on' : ''}" data-i="${i}">${escapeHtml(s.name)}</button>`).join('')}</div>`;
    $$('#dSrc .chip').forEach((b) => {
      b.addEventListener('click', () => openDetail(group, Number(b.dataset.i)));
    });
  }

  function closeSheet() { $('#sheet').classList.remove('show'); }

  // ---------- 播放 ----------
  async function playEpisode(ep, title) {
    closeSheet();
    const video = $('#v');
    $('#pTitle').textContent = title;
    $('#player').classList.add('show');
    video.removeAttribute('src');
    toast('正在解析播放地址……');
    try {
      const r = await api('/api/play', { u: ep.url });
      if (!r.ok) { toast('这条线路打不开：' + (r.msg || '')); return; }
      video.src = r.src;
      video.play().catch(() => {});
    } catch (err) {
      toast('解析失败：' + err.message);
    }
  }

  function closePlayer() {
    const video = $('#v');
    try { video.pause(); } catch (_) {}
    video.removeAttribute('src');
    try { video.load(); } catch (_) {}
    $('#player').classList.remove('show');
  }

  // ---------- 绑定 ----------
  $('#btnSearch').addEventListener('click', () => doSearch($('#wd').value));
  $('#wd').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#wd').blur(); doSearch($('#wd').value); } });
  $('#btnClose').addEventListener('click', closeSheet);
  $('#btnBack').addEventListener('click', closePlayer);
  $('#v').addEventListener('error', () => {
    const code = $('#v').error ? $('#v').error.code : 0;
    if (code) toast('播放失败（错误码 ' + code + '），换条线路或换个片源再试');
  });

  loadInfo();
  renderChips();
})();
