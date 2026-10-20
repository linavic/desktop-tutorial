// Etel Clinic – מערכת 5 סוכנים. שרת ללא תלויות (Node 18+).
// מצב חי: מוגדר ANTHROPIC_API_KEY. בלי מפתח: מצב הדגמה עם טקסטים לדוגמה.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const KEY = process.env.ANTHROPIC_API_KEY || '';
const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const LIVE = Boolean(KEY);

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

async function claude(system, user, maxTokens = 1200) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] })
  });
  if (!res.ok) throw new Error(`Claude API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.content || []).map(b => b.text || '').join('').trim();
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

// ---------- שרת ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/agents') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ live: LIVE, model: LIVE ? MODEL : null, agents: AGENTS }));
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
}).listen(PORT, () => console.log(`Etel agents app: http://localhost:${PORT}  (${LIVE ? 'LIVE ' + MODEL : 'DEMO mode'})`));
