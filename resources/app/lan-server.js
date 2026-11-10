// 局域网手机端：iPhone / 手机浏览器通过 http://<电脑IP>:<端口> 访问同一个片源库
// 关键点：手机不能直接拉这些 CDN 的 m3u8（要带 Referer、且跨域分片拿不到），
// 所以由电脑侧做代理转发：playlist 里的每个地址都改写回本机 /p?u=...，分片与密钥也走代理。
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function lanIp() {
  const ifs = os.networkInterfaces();
  const cands = [];
  Object.keys(ifs).forEach((name) => {
    (ifs[name] || []).forEach((a) => {
      if (a.family === 'IPv4' && !a.internal) cands.push({ name, address: a.address });
    });
  });
  const score = (ip) => (ip.startsWith('192.168.') ? 3 : ip.startsWith('10.') ? 2 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 1 : 0);
  cands.sort((a, b) => score(b.address) - score(a.address));
  return cands[0] || null;
}

function proxyLink(url, referer) {
  let p = '/p?u=' + encodeURIComponent(url);
  if (referer) p += '&r=' + encodeURIComponent(referer);
  return p;
}

// 把 m3u8 里的所有地址（子清单 / 分片 / 密钥 / MAP）改写成本机代理地址
function rewritePlaylist(text, baseUrl, referer) {
  const abs = (u) => {
    try { return new URL(u, baseUrl).toString(); } catch (_) { return u; }
  };
  // 子清单保留 .m3u8 后缀，Safari 的原生 HLS 对这点比较敏感
  const link = (u) => {
    const p = proxyLink(u, referer);
    return /\.m3u8(\?|#|$)/i.test(u) ? p.replace('/p?', '/p/playlist.m3u8?') : p;
  };
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      // EXT-X-KEY / EXT-X-MAP / EXT-X-MEDIA 里的 URI="..."
      return line.replace(/URI="([^"]+)"/g, (_m, u) => 'URI="' + proxyLink(abs(u), referer) + '"');
    }
    return link(abs(t));
  }).join('\n');
}

function createLanServer(core) {
  const uiDir = path.join(__dirname, 'ui', 'mobile');
  const state = { server: null, port: 0, ip: '', url: '' };

  function sendJson(res, obj, code) {
    const body = JSON.stringify(obj);
    res.writeHead(code || 200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(body);
  }

  function sendFile(res, filePath) {
    fs.readFile(filePath, (err, buf) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('找不到页面'); }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache'
      });
      res.end(buf);
    });
  }

  function handleProxy(req, res, q) {
    const target = q.get('u') || '';
    const referer = q.get('r') || '';
    if (!/^https?:\/\//i.test(target)) { res.writeHead(400); return res.end('bad url'); }
    let u;
    try { u = new URL(target); } catch (_) { res.writeHead(400); return res.end('bad url'); }
    const mod = u.protocol === 'https:' ? https : http;
    const headers = {
      'User-Agent': core.ua,
      Accept: '*/*',
      'Accept-Encoding': 'identity',
      Referer: referer || u.origin + '/'
    };
    if (req.headers.range) headers.Range = req.headers.range;

    const upstream = mod.request(u, { method: 'GET', headers, timeout: 20000 }, (up) => {
      const code = up.statusCode || 502;
      const ct = String(up.headers['content-type'] || '');
      const looksM3u8 = /mpegurl|m3u8/i.test(ct) || /\.m3u8(\?|#|$)/i.test(target);

      if (looksM3u8 && code < 400) {
        const chunks = [];
        up.on('data', (c) => chunks.push(c));
        up.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (!/^\s*#EXTM3U/.test(text)) {
            res.writeHead(code, { 'Content-Type': ct || 'text/plain; charset=utf-8' });
            return res.end(text.slice(0, 4000));
          }
          res.writeHead(200, {
            'Content-Type': 'application/vnd.apple.mpegurl',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(rewritePlaylist(text, target, referer));
        });
        up.on('error', () => { try { res.destroy(); } catch (_) {} });
        return;
      }

      const h = { 'Access-Control-Allow-Origin': '*' };
      if (ct) h['Content-Type'] = ct;
      if (up.headers['content-length']) h['Content-Length'] = up.headers['content-length'];
      if (up.headers['accept-ranges']) h['Accept-Ranges'] = up.headers['accept-ranges'];
      if (up.headers['content-range']) h['Content-Range'] = up.headers['content-range'];
      res.writeHead(code, h);
      up.pipe(res);
      up.on('error', () => { try { res.destroy(); } catch (_) {} });
    });

    upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
    upstream.on('error', () => {
      try { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('上游请求失败'); } catch (_) {}
    });
    upstream.end();
  }

  async function route(req, res) {
    const parsed = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(parsed.pathname);
    const q = parsed.searchParams;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' });
      return res.end();
    }

    // 静态页面
    if (p === '/' || p === '/index.html') return sendFile(res, path.join(uiDir, 'index.html'));
    if (/^\/(app\.(css|js))$/.test(p)) return sendFile(res, path.join(uiDir, p.slice(1)));

    // 代理（分片 / 密钥 / 直播清单）。清单用 /p/playlist.m3u8 让 Safari 一眼认出这是 HLS
    if (/^\/p(\/.*)?$/.test(p)) return handleProxy(req, res, q);

    if (p === '/api/info') {
      const srcs = core.sourcesConfig().filter((s) => s.enabled);
      return sendJson(res, { ok: true, name: '豆包影视盒', port: state.port, ip: state.ip, url: state.url, sources: srcs.length });
    }

    if (p === '/api/search') {
      const wd = String(q.get('wd') || '').trim();
      if (!wd) return sendJson(res, { ok: false, msg: '请输入关键词' });
      const r = await core.doSearch(wd, q.get('deep') === '1');
      if (!r.ok) return sendJson(res, r);
      const srcMap = {};
      core.sourcesConfig().forEach((s) => { srcMap[s.id] = s.url; });
      const groups = r.groups.slice(0, 60).map((g) => ({
        key: g.key, title: g.title, poster: g.poster, year: g.year, type: g.type,
        remarks: g.remarks, score: g.score, content: (g.content || '').slice(0, 120),
        sourceCount: g.sourceCount,
        sources: (g.sources || []).map((v) => ({
          id: v.sourceId, name: v.sourceName, src: srcMap[v.sourceId] || '', vodId: v.vodId,
          remarks: v.remarks, episodes: v.episodes
        }))
      }));
      return sendJson(res, { ok: true, keyword: r.keyword, groups });
    }

    if (p === '/api/detail') {
      const src = String(q.get('src') || '');
      const id = String(q.get('id') || '');
      if (!/^https?:\/\//i.test(src) || !id) return sendJson(res, { ok: false, msg: '参数不全' });
      const r = await core.doVideos(src, id);
      if (!r.ok || !r.videos || !r.videos.length) return sendJson(res, { ok: false, msg: r.msg || '没取到详情' });
      const v = r.videos[0];
      return sendJson(res, {
        ok: true, title: v.name, poster: v.pic, year: v.year, remarks: v.remarks,
        content: v.content, actors: v.actors,
        lines: (v.playGroups || []).map((g) => ({
          from: g.from,
          items: g.items.map((it) => ({ name: it.name, url: it.url }))
        }))
      });
    }

    if (p === '/api/play') {
      const raw = String(q.get('u') || '');
      if (!/^https?:\/\//i.test(raw)) return sendJson(res, { ok: false, msg: '播放地址无效' });
      const r = await core.doResolve(raw);
      if (!r.ok) return sendJson(res, r);
      const link = proxyLink(r.url, r.referer || '');
      return sendJson(res, { ok: true, direct: !!r.direct, src: link.replace('/p?', '/p/playlist.m3u8?'), real: r.url });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('没有这个地址');
  }

  function listen(port, attempt) {
    const srv = http.createServer((req, res) => {
      route(req, res).catch((err) => {
        try { sendJson(res, { ok: false, msg: err.message }, 500); } catch (_) {}
      });
    });
    srv.on('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempt < 6) { try { srv.close(); } catch (_) {} return listen(port + 1, attempt + 1); }
      core.log(`[手机] 局域网服务启动失败：${err.message}`);
    });
    srv.listen(port, '0.0.0.0', () => {
      state.server = srv;
      state.port = port;
      const ipInfo = lanIp();
      state.ip = ipInfo ? ipInfo.address : '';
      state.url = state.ip ? `http://${state.ip}:${port}` : `http://127.0.0.1:${port}`;
      core.log(`[手机] 手机访问地址 ${state.url}（网卡 ${ipInfo ? ipInfo.name : '未识别'}）`);
      if (core.onReady) core.onReady(info());
    });
  }

  function info() {
    return { ok: !!state.server, port: state.port, ip: state.ip, url: state.url };
  }

  function start(preferredPort) {
    listen(Number(preferredPort) || 8899, 0);
    return { info };
  }

  function stop() {
    if (state.server) { try { state.server.close(); } catch (_) {} state.server = null; }
  }

  return { start, info, stop };
}

module.exports = { createLanServer, lanIp };
