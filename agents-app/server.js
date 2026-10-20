// Etel Clinic – מערכת 5 סוכנים. שרת ללא תלויות (Node 18+).
// מצב חי: מוגדר ANTHROPIC_API_KEY. בלי מפתח: מצב הדגמה עם טקסטים לדוגמה.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
// ספק: OPENAI_API_KEY או ANTHROPIC_API_KEY. אם שניהם מוגדרים, OpenAI קודם (אפשר לכפות עם PROVIDER=anthropic).
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const PROVIDER = process.env.PROVIDER || (OPENAI_KEY ? 'openai' : ANTHROPIC_KEY ? 'anthropic' : '');
const MODEL = PROVIDER === 'openai'
  ? (process.env.OPENAI_MODEL || 'gpt-4.1')
  : (process.env.CLAUDE_MODEL || 'claude-sonnet-5-5');
const LIVE = (PROVIDER === 'openai' && Boolean(OPENAI_KEY)) || (PROVIDER === 'anthropic' && Boolean(ANTHROPIC_KEY));

let CLINIC = '';
try { CLINIC = fs.readFileSync(path.join(__dirname, '..', 'CLINIC.md'), 'utf8'); } catch { /* optional */ }

const STYLE_RULES = `כללי כתיבה מחייבים:
- עברית מדוברת, חמה ודוגרית, פנייה בלשון נקבה.
- כל שורה בעברית נפתחת באות עברית (לא באימוג'י, ספרה, מילה באנגלית או האשטג).
- 3 עד 5 האשטגים בעברית, בשורה נפרדת בסוף, בלי קו תחתון.
- בלי קישורים (כותבים "הלינק בביו"), בלי מחירים, בלי לפני/אחרי, בלי הבטחת תוצאה.
- אל תמציאי עובדות, שמות או הסמכות על הקליניקה. מה שחסר מסמנים ב-[סוגריים].`;

const AGENTS = [
  {
    id: 'strategist', n: 1, name: 'אסטרטגית', color: '#8a6d3b',
    role: 'מחליטה על הזווית של הפוסט לפי הבריף ופרופיל הקליניקה.',
    does: ['קוראת את פרופיל הקליניקה (CLINIC.md)', 'בוחרת זווית, קהל ומטרה', 'מגדירה קריאה לפעולה'],
    steps: ['קוראת פרופיל קליניקה', 'בוחרת זווית וקהל', 'מגדירה קריאה לפעולה']
  },
  {
    id: 'writer', n: 2, name: 'כותבת', color: '#2f6f62',
    role: 'כותבת את הפוסט בעברית מדוברת לפי האסטרטגיה.',
    does: ['כותבת הוק פותח', 'כותבת גוף וסיום', 'מוסיפה האשטגים בסוף'],
    steps: ['כותבת הוק', 'כותבת גוף וקריאה לפעולה', 'מוסיפה האשטגים']
  },
  {
    id: 'translator', n: 3, name: 'מתאימה לרוסית', color: '#3d5a8a',
    role: 'כותבת גרסה רוסית טבעית (לא תרגום מילולי) לקהל הרוסי של הקליניקה.',
    does: ['מתאימה את המסר לקהל דובר רוסית', 'שומרת על הטון והגבלות הפרסום', 'מחזירה גרסה מוכנה לפרסום'],
    steps: ['קוראת את הפוסט בעברית', 'מנסחת ברוסית טבעית', 'בודקת שהטון נשמר']
  },
  {
    id: 'compliance', n: 4, name: 'בודקת ציות', color: '#a04a3a',
    role: 'בודקת את הפוסט מול כללי הקליניקה והפרסום ומתקנת אם צריך.',
    does: ['6 בדיקות אוטומטיות על הטקסט', 'מתקנת הפרות', 'מחליטה: מאושר / תוקן'],
    steps: ['מריצה 6 בדיקות', 'מתקנת הפרות אם יש', 'מחליטה על סטטוס']
  },
  {
    id: 'scheduler', n: 5, name: 'מתזמנת', color: '#6b4c8a',
    role: 'מרכיבה חבילה סופית ובוחרת מועד פרסום. לא מפרסמת בעצמה.',
    does: ['בוחרת יום ושעה (ראשון עד חמישי, לא שבת)', 'מרכיבה חבילה סופית עם הערות', 'מעבירה לאישור שלך'],
    steps: ['בוחרת מועד', 'מרכיבה חבילה סופית', 'מעבירה לאישור']
  }
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callLLM(cfg, system, user, maxTokens = 1200) {
  if (cfg.provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
      body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
    });
    if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    return (data.choices?.[0]?.message?.content || '').trim();
  }
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: cfg.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] })
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.content || []).map(b => b.text || '').join('').trim();
}

// מפתח מהדפדפן (בקשה בודדת, לא נשמר ולא נרשם ביומן) קודם למפתח מהשרת.
function resolveCfg(brief) {
  const userKey = typeof brief.apiKey === 'string' ? brief.apiKey.trim() : '';
  if (userKey) {
    const provider = brief.provider === 'anthropic' ? 'anthropic' : 'openai';
    const model = String(brief.model || '').trim() || (provider === 'openai' ? (process.env.OPENAI_MODEL || 'gpt-4.1') : (process.env.CLAUDE_MODEL || 'claude-sonnet-5-5'));
    return { live: true, provider, key: userKey, model };
  }
  return { live: LIVE, provider: PROVIDER, key: PROVIDER === 'openai' ? OPENAI_KEY : ANTHROPIC_KEY, model: MODEL };
}

// ---------- בדיקות ציות דטרמיניסטיות ----------
function runChecks(he, ru) {
  const lines = he.split('\n').filter(l => l.trim());
  const isHashtagLine = l => /^\s*(#\S+\s*)+$/.test(l);
  const badStart = lines.filter(l => !isHashtagLine(l) && /[֐-׿]/.test(l) && !/^[֐-׿]/.test(l.trim()));
  const tags = (he.match(/#[^\s#]+/g) || []);
  return [
    { name: 'כל שורה בעברית נפתחת באות עברית', ok: badStart.length === 0, detail: badStart[0] },
    { name: 'אין קישורים בכיתוב', ok: !/https?:\/\/|www\./i.test(he + ru) },
    { name: 'אין מחירים', ok: !/₪|שקל|\bNIS\b|шекел/i.test(he + ru) },
    { name: 'אין הבטחת תוצאה או "לפני ואחרי"', ok: !/מבטיח|מובטח|100%|לפני ואחרי|תוצאות מובטחות|гаранти|до и после/i.test(he + ru) },
    { name: '3 עד 5 האשטגים, בלי קו תחתון', ok: tags.length >= 3 && tags.length <= 5 && !tags.some(t => t.includes('_')), detail: `${tags.length} האשטגים` },
    { name: 'אין שאריות תבנית שלא הושלמו, חוץ מ-[סוגריים] מכוונים', ok: !/TODO|undefined|null/.test(he + ru) }
  ];
}

function autoFix(he) {
  return he.replace(/https?:\/\/\S+/g, 'הלינק בביו').split('\n').map(l => {
    if (/^\s*(#\S+\s*)+$/.test(l)) return l.replace(/_/g, '');
    return /[֐-׿]/.test(l) && !/^[֐-׿]/.test(l.trim()) ? l.replace(/^[^֐-׿]+/, '') : l;
  }).join('\n');
}

// ---------- מועד פרסום ----------
function nextSlot(platform, from = new Date()) {
  const times = { instagram: '12:30', facebook: '20:00', tiktok: '20:00', linkedin: '08:30' };
  const t = times[platform] || '12:30';
  const [h, m] = t.split(':').map(Number);
  const d = new Date(from);
  for (let i = 0; i < 8; i++) {
    const c = new Date(d); c.setDate(d.getDate() + i); c.setHours(h, m, 0, 0);
    if (c > from && c.getDay() <= 4) { // ראשון(0) עד חמישי(4)
      const days = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי'];
      return `יום ${days[c.getDay()]}, ${c.toLocaleDateString('he-IL')} בשעה ${t}`;
    }
  }
  return 'ראשון הקרוב, 12:30';
}

// ---------- ריצת הצינור ----------
async function pipeline(brief, emit) {
  const cfg = resolveCfg(brief);
  const LIVE = cfg.live;
  const claude = (system, user, max) => callLLM(cfg, system, user, max);
  const topic = (brief.topic || 'בדיקת עור לפני טיפול ראשון').trim();
  const platform = brief.platform || 'instagram';
  const format = brief.format || 'פוסט';
  const ctx = {};
  const step = async (agent, i, text, ms = 700) => { emit({ type: 'step', agent, index: i, text }); if (!LIVE) await sleep(ms); };

  // 1. אסטרטגית
  emit({ type: 'start', agent: 'strategist' });
  await step('strategist', 0, `קראה את פרופיל הקליניקה (${CLINIC ? CLINIC.length + ' תווים' : 'לא נמצא CLINIC.md'})`);
  ctx.strategy = LIVE
    ? await claude(`את אסטרטגית תוכן של Etel Clinic. ענִי בקצרה (עד 6 שורות) בפורמט: זווית / קהל / מטרה / קריאה לפעולה.\n\n${CLINIC}`, `נושא: ${topic}\nפלטפורמה: ${platform}\nפורמט: ${format}`, 500)
    : `זווית: ${topic} – מתחילים בהבנה ולא בהזרקה.\nקהל: נשים 28–60 בנתניה והסביבה.\nמטרה: אמון, ולהוביל לבדיקת העור.\nקריאה לפעולה: "הלינק בביו" לבדיקת עור של 60 שניות.`;
  await step('strategist', 1, 'בחרה זווית וקהל');
  await step('strategist', 2, 'הגדירה קריאה לפעולה');
  emit({ type: 'done', agent: 'strategist', output: ctx.strategy });

  // 2. כותבת
  emit({ type: 'start', agent: 'writer' });
  await step('writer', 0, 'כותבת הוק פותח');
  ctx.he = LIVE
    ? await claude(`את כותבת תוכן בעברית ל-Etel Clinic. החזירי רק את הפוסט המוכן, בלי הקדמות.\n\n${STYLE_RULES}\n\n${CLINIC}`, `פורמט: ${format} ל-${platform}\nנושא: ${topic}\n\nאסטרטגיה:\n${ctx.strategy}`)
    : `${topic}? בואי נעשה סדר 🤍\n\nלפני שמחליטים על טיפול, כדאי להבין מה העור שלך באמת צריך.\n\nבקליניקה שלנו בנתניה מתחילים בשיחה ובבדיקה, לא בהזרקה.\n\nעני על 5 שאלות ב-60 שניות וקבלי המלצה אישית מהצוות שלנו. בלי לחץ ובלי התחייבות.\n\nהלינק בביו.\n\n#אסתטיקהרפואית #נתניה #טיפוחעור #בדיקתעור`;
  await step('writer', 1, 'כתבה גוף וקריאה לפעולה');
  await step('writer', 2, 'הוסיפה האשטגים');
  emit({ type: 'done', agent: 'writer', output: ctx.he });

  // 3. רוסית
  emit({ type: 'start', agent: 'translator' });
  await step('translator', 0, 'קראה את הפוסט בעברית');
  ctx.ru = LIVE
    ? await claude('את כותבת תוכן ברוסית ל-Etel Clinic בנתניה. כתבי גרסה טבעית לקהל דובר רוסית, לא תרגום מילולי. אותם כללים: בלי קישורים, מחירים, הבטחות או "до и после". החזירי רק את הטקסט.', ctx.he)
    : `Не уверены, что на самом деле нужно вашей коже? 🤍\n\nОтветьте на 5 коротких вопросов и получите персональную рекомендацию от команды ETEL CLINIC в Нетании.\n\nБез давления и обязательств. Ссылка в профиле.`;
  await step('translator', 1, 'ניסחה ברוסית טבעית');
  await step('translator', 2, 'בדקה שהטון נשמר');
  emit({ type: 'done', agent: 'translator', output: ctx.ru });

  // 4. ציות
  emit({ type: 'start', agent: 'compliance' });
  let checks = runChecks(ctx.he, ctx.ru);
  for (let i = 0; i < checks.length; i++) emit({ type: 'check', agent: 'compliance', check: checks[i] });
  await step('compliance', 0, `הריצה ${checks.length} בדיקות: ${checks.filter(c => c.ok).length} עברו`);
  let status = 'מאושר';
  if (checks.some(c => !c.ok)) {
    await step('compliance', 1, 'מתקנת הפרות');
    ctx.he = LIVE && checks.some(c => !c.ok)
      ? await claude(`תקני את הפוסט כך שיעמוד בכללים. החזירי רק את הפוסט המתוקן.\n\n${STYLE_RULES}\n\nהבדיקות שנכשלו: ${checks.filter(c => !c.ok).map(c => c.name).join('; ')}`, ctx.he)
      : autoFix(ctx.he);
    checks = runChecks(ctx.he, ctx.ru);
    status = checks.every(c => c.ok) ? 'תוקן ואושר' : 'נדרשת בדיקה ידנית';
  } else {
    await step('compliance', 1, 'לא נמצאו הפרות');
  }
  await step('compliance', 2, `סטטוס: ${status}`);
  emit({ type: 'done', agent: 'compliance', output: `סטטוס: ${status}`, checks });

  // 5. מתזמנת
  emit({ type: 'start', agent: 'scheduler' });
  const slot = nextSlot(platform);
  await step('scheduler', 0, `בחרה מועד: ${slot}`);
  const pkg = `# חבילה לפרסום\n\nפלטפורמה: ${platform} · פורמט: ${format}\nמועד מוצע: ${slot}\nסטטוס ציות: ${status}\n\n## עברית\n${ctx.he}\n\n## רוסית\n${ctx.ru}\n\n## לפני פרסום\n- אשרי את הטקסט מול הצוות הרפואי.\n- ודאי שיש הסכמה כתובה לכל תמונה של מטופלת או של צוות.\n- הפוסט לא פורסם. הפרסום ידני אחרי אישורך.`;
  await step('scheduler', 1, 'הרכיבה חבילה סופית');
  await step('scheduler', 2, 'מעבירה לאישורך. לא מפרסמת אוטומטית');
  emit({ type: 'done', agent: 'scheduler', output: slot });
  emit({ type: 'final', package: pkg, status });
}


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
const LOGIN_HTML = (msg = '') => `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>כניסה · Etel Clinic</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#faf6ef;color:#3a2a1e;font-family:"Segoe UI",Arial,sans-serif}
form{background:#fffdf9;border:1px solid #e6dccd;border-radius:14px;padding:28px;width:min(92vw,340px)}
h1{margin:0 0 4px;font-family:Georgia,serif;font-size:1.4rem}p{margin:0 0 16px;color:#7d6b5b;font-size:.9rem}
input,button{width:100%;padding:11px;border-radius:8px;font:inherit;box-sizing:border-box}input{border:1px solid #e6dccd;margin-bottom:12px}
button{border:0;background:#b8924a;color:#fff;font-weight:600;cursor:pointer}.e{color:#b5532f;font-size:.85rem;margin:0 0 10px}</style></head>
<body><form method="post" action="/login"><h1>Etel Clinic</h1><p>הכניסה למערכת הסוכנים</p>${msg ? `<p class="e">${msg}</p>` : ''}
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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('cache-control', 'no-store');
  if (PASSWORD && await handleAuth(req, res, url)) return;
  if (url.pathname === '/api/agents') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ auth: Boolean(PASSWORD), live: LIVE, model: LIVE ? `${PROVIDER === 'openai' ? 'OpenAI' : 'Claude'} · ${MODEL}` : null, agents: AGENTS }));
  }
  if (url.pathname === '/api/run' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    let brief = {};
    try { brief = JSON.parse(body || '{}'); } catch { /* empty */ }
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache' });
    const emit = e => res.write(JSON.stringify({ t: Date.now(), ...e }) + '\n');
    try { await pipeline(brief, emit); }
    catch (err) { emit({ type: 'error', message: String(err.message || err) }); }
    return res.end();
  }
  const file = url.pathname === '/' ? '/index.html' : url.pathname;
  const full = path.join(__dirname, 'public', path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
  if (!full.startsWith(path.join(__dirname, 'public'))) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, PASSWORD ? '0.0.0.0' : '127.0.0.1', () => console.log(`Etel agents app: http://localhost:${PORT}  [${PASSWORD ? 'password ON' : 'localhost only, no password'}]  (${LIVE ? `LIVE ${PROVIDER} ${MODEL}` : 'DEMO mode'})`));
