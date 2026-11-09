'use strict';
// خادم FOR YOU — بدون أي اعتماديات (Node المدمج فقط).
// يقدّم الواجهة ويحفظ صفحات الإهداء الإلكتروني حتى تفتح من أي جهاز.
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const PUBLISH_KEY = process.env.PUBLISH_KEY || '';
const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
const PUB = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8' };
const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob: https:; media-src 'self' data: blob: https:; frame-src https://www.youtube-nocookie.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

/* ---------- تخزين الإهداءات (ملف JSON) ---------- */
let store = {}, FILE = path.join(DATA_DIR, 'greetings.json'), persistent = true;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); store = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') { try { fs.accessSync(DATA_DIR, fs.constants.W_OK); } catch (x) { persistent = false; console.warn('DATA_DIR غير قابل للكتابة: الإهداءات بالذاكرة فقط'); } } }
let wt = null;
function save() { clearTimeout(wt); wt = setTimeout(() => { if (!persistent) return; const tmp = FILE + '.tmp'; try { fs.writeFileSync(tmp, JSON.stringify(store)); fs.renameSync(tmp, FILE); } catch (e) { console.error('save failed', e.message); } }, 200); }

/* ---------- أدوات ---------- */
const hits = new Map();
function limited(ip, key, max) { const k = key + ip, n = Date.now(), a = (hits.get(k) || []).filter(t => n - t < 60000); a.push(n); hits.set(k, a); if (hits.size > 5000) hits.clear(); return a.length > max; }
const sha = s => crypto.createHash('sha256').update(String(s)).digest();
const authed = req => PUBLISH_KEY && crypto.timingSafeEqual(sha(req.headers['x-publish-key'] || ''), sha(PUBLISH_KEY));
function send(res, code, body, headers) { const h = Object.assign({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' }, headers || {}); if (typeof body === 'object' && !Buffer.isBuffer(body)) { body = JSON.stringify(body); h['Content-Type'] = 'application/json; charset=utf-8'; h['Cache-Control'] = 'no-store'; } res.writeHead(code, h); res.end(body); }
function readBody(req, max) { return new Promise((ok, no) => { let n = 0, bad = false; const c = []; req.on('data', d => { n += d.length; if (bad) return; if (n > max) { bad = true; no(Object.assign(new Error('big'), { code: 413 })); } else c.push(d); }); req.on('end', () => { if (!bad) ok(Buffer.concat(c).toString('utf8')); }); req.on('error', no); }); }
const THEMES = ['rose', 'gold', 'night', 'lilac', 'peach'];
const str = (v, n) => typeof v === 'string' ? v.slice(0, n) : '';
function clean(d) {
  if (!d || typeof d !== 'object') return null;
  const imgs = Array.isArray(d.imgs) ? d.imgs.slice(0, 8).filter(s => typeof s === 'string' && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(s) && s.length < 900000) : [];
  const url = u => /^https?:\/\/[^\s]+$/i.test(u) ? u.slice(0, 500) : '';
  return { to: str(d.to, 80), from: str(d.from, 80), occ: str(d.occ, 40), msg: str(d.msg, 3000), music: url(str(d.music, 500)), date: /^\d{4}-\d{2}-\d{2}$/.test(d.date) ? d.date : '', dlabel: str(d.dlabel, 80), theme: THEMES.includes(d.theme) ? d.theme : 'rose', color: /^#[0-9a-fA-F]{6}$/.test(d.color) ? d.color : '', imgs, disabled: !!d.disabled };
}
const tokOK = t => /^[0-9a-f]{32}$/.test(t);

/* ---------- ملفات ثابتة ---------- */
const cache = new Map();
function serveFile(req, res, file) {
  fs.stat(file, (e, st) => {
    if (e || !st.isFile()) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    const ext = path.extname(file).toLowerCase(), html = ext === '.html';
    const h = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': html ? 'no-cache' : 'public, max-age=86400' };
    if (html) h['Content-Security-Policy'] = CSP;
    const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && /^(\.html|\.js|\.css|\.json|\.svg)$/.test(ext);
    if (!gz) { h['Content-Length'] = st.size; res.writeHead(200, Object.assign({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY' }, h)); return fs.createReadStream(file).pipe(res); }
    const k = file + st.mtimeMs, c = cache.get(k);
    const out = buf => { h['Content-Encoding'] = 'gzip'; h['Vary'] = 'Accept-Encoding'; send(res, 200, buf, h); };
    if (c) return out(c);
    fs.readFile(file, (e2, b) => { if (e2) return send(res, 500, 'err'); const z = zlib.gzipSync(b); cache.set(k, z); out(z); });
  });
}

http.createServer(async (req, res) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  let u; try { u = new URL(req.url, 'http://x'); } catch (e) { return send(res, 400, { error: 'bad url' }); }
  const p = decodeURIComponent(u.pathname);
  try {
    if (p === '/api/health') return send(res, 200, { ok: true, time: new Date().toISOString() });
    if (p === '/api/status') return send(res, 200, { ok: true, publishEnabled: !!PUBLISH_KEY, persistent });
    if (p === '/api/check-key' && req.method === 'POST') {
      if (!PUBLISH_KEY) return send(res, 503, { error: 'publish disabled' });
      if (limited(ip, 'k', 15)) return send(res, 429, { error: 'slow down' });
      return authed(req) ? send(res, 200, { ok: true }) : send(res, 401, { error: 'bad key' });
    }
    const m = p.match(/^\/api\/greetings\/([^/]+)$/);
    if (m) {
      const tok = m[1];
      if (!tokOK(tok)) return send(res, 404, { error: 'not found' });
      if (req.method === 'GET') {
        if (limited(ip, 'g', 120)) return send(res, 429, { error: 'slow down' });
        const g = store[tok];
        return g ? send(res, 200, { data: g }, { 'X-Robots-Tag': 'noindex' }) : send(res, 404, { error: 'not found' });
      }
      if (req.method === 'PUT' || req.method === 'DELETE') {
        if (!PUBLISH_KEY) return send(res, 503, { error: 'publish disabled' });
        if (limited(ip, 'w', 60)) return send(res, 429, { error: 'slow down' });
        if (!authed(req)) return send(res, 401, { error: 'bad key' });
        if (req.method === 'DELETE') { delete store[tok]; save(); return send(res, 200, { ok: true }); }
        let body; try { body = JSON.parse(await readBody(req, 6 * 1024 * 1024)); } catch (e) { return send(res, e.code === 413 ? 413 : 400, { error: e.code === 413 ? 'too large' : 'bad json' }); }
        const d = clean(body && body.data);
        if (!d || !d.to) return send(res, 400, { error: 'invalid data' });
        if (!store[tok] && Object.keys(store).length >= 5000) return send(res, 507, { error: 'storage full' });
        store[tok] = d; save();
        return send(res, 200, { ok: true });
      }
      return send(res, 405, { error: 'method' });
    }
    if (p.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    let f = path.normalize(path.join(PUB, p));
    if (!f.startsWith(PUB)) return send(res, 403, 'Forbidden');
    if (p.endsWith('/') || !path.extname(p)) f = path.join(PUB, 'index.html');
    serveFile(req, res, f);
  } catch (e) { console.error(e); if (!res.headersSent) send(res, 500, { error: 'server error' }); }
}).listen(PORT, '0.0.0.0', () => console.log('FOR YOU listening on ' + PORT + (PUBLISH_KEY ? ' (publish enabled)' : ' (PUBLISH_KEY not set)') + ' data=' + DATA_DIR));
