// מרכז שליטה: צוות 8 סוכנים על OpenAI בלבד, לכל עסק. שרת ללא תלויות (Node 18+).
// המנוע (public/crew-engine.js) משותף לשרת ולגרסה הסטטית שרצה בדפדפן.
// מצב חי: OPENAI_API_KEY, או מפתח שמוזן בדף. בלי מפתח: מצב הדגמה.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Engine = require('./public/crew-engine.js');
const { loadAgentsData } = require('./lib/agents.js');

const PORT = process.env.PORT || 3000;
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.OPENAI_MODEL || Engine.DEFAULT_MODEL;
const LIVE = Boolean(OPENAI_KEY);
const BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
const BRAND = process.env.BRAND_NAME || 'Agent Crew';

let DEFAULT_CTX = '';
try { DEFAULT_CTX = fs.readFileSync(process.env.CONTEXT_FILE || path.join(__dirname, 'context.md'), 'utf8'); } catch { /* optional */ }
let PROFILES = [];
try { PROFILES = JSON.parse(fs.readFileSync(path.join(__dirname, 'profiles.json'), 'utf8')); } catch { /* optional */ }
const AGENTS = Engine.buildAgents(loadAgentsData(path.join(__dirname, 'agents')));
const ACCOUNTS = process.env.ACCOUNTS === '1'; // מצב מנויים: חשבונות, מסלולים, מכסות וחיבור ל-GROW (ראו lib/saas.js)

// מפתח מהדפדפן (בקשה בודדת, לא נשמר ולא נרשם ביומן) קודם למפתח מהשרת.
function resolveCfg(brief) {
  if (brief.demo === true) return { live: false, key: '', model: MODEL, base: BASE };
  const userKey = typeof brief.apiKey === 'string' ? brief.apiKey.trim() : '';
  const model = String(brief.model || '').trim() || MODEL;
  if (userKey) return { live: true, key: userKey, model, base: BASE };
  return { live: LIVE, key: OPENAI_KEY, model, base: BASE };
}

// io לשרת: קבצים ותמונות נשמרים ב-runs/<runId>/ ומוגשים מ-/runs/
const io = {
  agents: AGENTS, defaultCtx: DEFAULT_CTX, brand: BRAND,
  putFile(rel, data, runId) { try { const f = path.join(__dirname, 'runs', runId, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); } catch { /* אחסון לקריאה בלבד */ } },
  putImage(rel, payload, mime, runId) { this.putFile(rel, payload.b64 ? Buffer.from(payload.b64, 'base64') : payload.svg, runId); return `/runs/${runId}/${rel}`; }
};

// שולח ריצה כזרם NDJSON. hooks.after({finished, failed, emit}) רץ בסוף, לפני סגירת התגובה.
async function streamRun(res, brief, cfg, hooks = {}) {
  res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache' });
  const emit = e => { try { res.write(JSON.stringify({ t: Date.now(), ...e }) + '\n'); } catch { /* הלקוח התנתק */ } };
  let runIdOf = '', finished = false, failed = null;
  const wrap = { ...io, putFile: (rel, d) => io.putFile(rel, d, runIdOf), putImage: (rel, pl, m) => io.putImage(rel, pl, m, runIdOf) };
  try { await Engine.runCrew(brief, e => { if (e.type === 'run') runIdOf = e.runId; if (e.type === 'final') finished = true; emit(e); }, wrap, cfg); }
  catch (err) { failed = String(err.message || err); emit({ type: 'error', message: failed }); }
  if (hooks.after) hooks.after({ finished, failed, emit });
  res.end();
  return { finished, failed };
}
const saas = ACCOUNTS ? require('./lib/saas.js')({ env: process.env, Engine, streamRun, io }) : null;
// ---------- אבטחה: סיסמת כניסה ----------
// בלי APP_PASSWORD השרת מאזין רק ל-localhost. עם סיסמה הוא פתוח לרשת ודורש התחברות.
const PASSWORD = process.env.APP_PASSWORD || '';
const SECRET = process.env.APP_SECRET || crypto.randomBytes(32).toString('hex');
const sha = v => crypto.createHash('sha256').update(String(v)).digest();
const sign = exp => crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
const SESSION_MS = 7 * 24 * 3600 * 1000;
const fails = new Map(); let globalFails = { n: 0, until: 0 };

function authed(req) {
  if (!PASSWORD) return true;
  const m = /(?:^|;\s*)etel_session=(\d+)\.([a-f0-9]+)/.exec(req.headers.cookie || '');
  if (!m || Number(m[1]) < Date.now()) return false;
  const a = Buffer.from(sign(m[1])), b = Buffer.from(m[2]);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const clientIp = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
const isHttps = req => req.headers['x-forwarded-proto'] === 'https';
const LOGIN_HTML = (msg = '') => `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>כניסה · ${BRAND.replace(/[<>&]/g, '')}</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#faf6ef;color:#3a2a1e;font-family:"Segoe UI",Arial,sans-serif}
form{background:#fffdf9;border:1px solid #e6dccd;border-radius:14px;padding:28px;width:min(92vw,340px)}
h1{margin:0 0 4px;font-family:Georgia,serif;font-size:1.4rem}p{margin:0 0 16px;color:#7d6b5b;font-size:.9rem}
input,button{width:100%;padding:11px;border-radius:8px;font:inherit;box-sizing:border-box}input{border:1px solid #e6dccd;margin-bottom:12px}
button{border:0;background:#b8924a;color:#fff;font-weight:600;cursor:pointer}.e{color:#b5532f;font-size:.85rem;margin:0 0 10px}</style></head>
<body><form method="post" action="/login"><h1>${BRAND.replace(/[<>&]/g, '')}</h1><p>הכניסה למערכת הסוכנים</p>${msg ? `<p class="e">${msg}</p>` : ''}
<input type="password" name="password" placeholder="סיסמה" autocomplete="current-password" autofocus required><button>כניסה</button></form></body></html>`;

async function handleAuth(req, res, url) {
  if (url.pathname === '/logout') {
    res.writeHead(302, { location: '/login', 'set-cookie': 'etel_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict' });
    return res.end(), true;
  }
  if (url.pathname === '/login') {
    if (req.method === 'POST') {
      let body = ''; for await (const c of req) { body += c; if (body.length > 2000) break; }
      const pw = new URLSearchParams(body).get('password') || '';
      const ip = clientIp(req), now = Date.now();
      const f = fails.get(ip) || { n: 0, until: 0 };
      if (f.until > now || globalFails.until > now) {
        res.writeHead(429, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(LOGIN_HTML('יותר מדי ניסיונות. נסי שוב בעוד כמה דקות.')), true;
      }
      if (crypto.timingSafeEqual(sha(pw), sha(PASSWORD))) {
        fails.delete(ip);
        const exp = now + SESSION_MS;
        res.writeHead(302, { location: '/', 'set-cookie': `etel_session=${exp}.${sign(exp)}; Path=/; Max-Age=${SESSION_MS / 1000}; HttpOnly; SameSite=Strict${isHttps(req) ? '; Secure' : ''}` });
        return res.end(), true;
      }
      f.n++; if (f.n >= 5) { f.until = now + 15 * 60 * 1000; f.n = 0; } fails.set(ip, f);
      globalFails.n++; if (globalFails.n >= 30) { globalFails = { n: 0, until: now + 15 * 60 * 1000 }; }
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(LOGIN_HTML('סיסמה שגויה.')), true;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(LOGIN_HTML()), true;
  }
  if (!authed(req)) {
    if (url.pathname.startsWith('/api/')) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"login required"}'); }
    else { res.writeHead(302, { location: '/login' }); res.end(); }
    return true;
  }
  return false;
}






// ---------- שרת ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' };

function serveFrom(root, rel, res) {
  const base = path.resolve(root);
  let dec; try { dec = decodeURIComponent(rel); } catch { res.writeHead(400); return res.end(); }
  const full = path.resolve(base, '.' + path.sep + path.normalize(dec).replace(/^([/\\]|\.\.[/\\]?)+/, ''));
  if (!full.startsWith(base + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

async function readJson(req, limit = 6_000_000) {
  let body = '', over = false;
  for await (const c of req) { body += c; if (body.length > limit) { over = true; break; } }
  if (over) return null;
  try { return JSON.parse(body || '{}'); } catch { return {}; }
}
const sendJson = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('cache-control', 'no-store');
  if (PASSWORD && await handleAuth(req, res, url)) return;
  const p = url.pathname;
  if (saas && await saas.handle(req, res, url)) return;
  if (p === '/api/agents') {
    return sendJson(res, 200, { brand: BRAND, auth: Boolean(PASSWORD), live: LIVE, model: LIVE ? `OpenAI · ${MODEL}` : null, defaultContext: DEFAULT_CTX, profiles: PROFILES, formats: Engine.FORMATS, agents: Engine.meta(AGENTS), ...(saas ? saas.publicConfig() : {}) });
  }
  if (p === '/api/run' && req.method === 'POST') {
    const brief = await readJson(req);
    if (!brief) return sendJson(res, 413, { error: 'request too large' });
    await streamRun(res, brief, resolveCfg(brief));
    return;
  }
  if (p === '/api/trends' && req.method === 'POST') {
    const brief = await readJson(req, 200_000) || {};
    try { return sendJson(res, 200, await Engine.trends(brief, io, resolveCfg(brief))); }
    catch (err) { return sendJson(res, 502, { error: String(err.message || err) }); }
  }
  if (p === '/api/check' && req.method === 'POST') {
    const brief = await readJson(req, 200_000) || {};
    return sendJson(res, 200, await Engine.checkConn(resolveCfg(brief)));
  }
  if (p === '/api/tts' && req.method === 'POST') {
    const brief = await readJson(req, 50_000) || {};
    const cfg = resolveCfg(brief);
    if (!cfg.live) return sendJson(res, 400, { error: 'no key' });
    try { const buf = Buffer.from(await Engine.tts(cfg, brief.text || '', { voice: brief.voice, model: brief.ttsModel })); res.writeHead(200, { 'content-type': 'audio/mpeg' }); return res.end(buf); }
    catch (err) { return sendJson(res, 502, { error: String(err.message || err) }); }
  }
  if (p.startsWith('/runs/') && /\.(png|svg)$/.test(p)) return serveFrom(path.join(__dirname, 'runs'), p.slice(6), res);
  return serveFrom(path.join(__dirname, 'public'), p === '/' ? 'index.html' : p, res);
});
(saas ? saas.ready : Promise.resolve()).then(() => server.listen(PORT, (PASSWORD || ACCOUNTS) ? '0.0.0.0' : '127.0.0.1', () => console.log(`Agent crew: http://localhost:${PORT}  [${ACCOUNTS ? 'ACCOUNTS mode' : PASSWORD ? 'password ON' : 'localhost only, no password'}]  (${LIVE ? `LIVE OpenAI ${MODEL}` : 'DEMO mode'})`)));
