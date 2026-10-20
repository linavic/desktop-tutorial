// מרכז שליטה לצוות 8 הסוכנים. שרת ללא תלויות (Node 18+).
// כל סוכן נטען מקובץ ההגדרה שלו ב-agents/*.md. ההעברה בין סוכנים נעשית דרך קבצים (runs/<runId>/...).
// מצב חי: OPENAI_API_KEY / ANTHROPIC_API_KEY, או מפתח שמוזן בדף. בלי מפתח: מצב הדגמה.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const PROVIDER = process.env.PROVIDER || (OPENAI_KEY ? 'openai' : ANTHROPIC_KEY ? 'anthropic' : '');
const MODEL = PROVIDER === 'openai'
  ? (process.env.OPENAI_MODEL || 'gpt-4.1')
  : (process.env.CLAUDE_MODEL || 'claude-sonnet-5-5');
const LIVE = (PROVIDER === 'openai' && Boolean(OPENAI_KEY)) || (PROVIDER === 'anthropic' && Boolean(ANTHROPIC_KEY));
const IMAGE_MODEL = 'gpt-image-2'; // לפי הגדרת הסקיל gpt-image-gen בפרויקט. לא לשנות.
const MAX_IMAGES = 2;

let CLINIC = '';
try { CLINIC = fs.readFileSync(path.join(__dirname, '..', 'CLINIC.md'), 'utf8'); } catch { /* optional */ }

// ---------- הסוכנים ----------
// inputs = מזהי הסוכנים שהקבצים שלהם עוברים לסוכן הזה. out = נתיב קובץ הפלט.
const PIPE = [
  { id: 'orchestrator', title: 'מנהל', color: '#e0b567', label: 'בריף', inputs: [], out: s => `content/briefs/${s}.md` },
  { id: 'chen', title: 'חן', color: '#8fd16a', label: 'מקורות', inputs: ['orchestrator'], out: s => `content/sources/${s}.md` },
  { id: 'researcher', title: 'חוקר', color: '#44b3a6', label: 'מחקר', inputs: ['orchestrator', 'chen'], out: s => `content/research/${s}.md` },
  { id: 'writer', title: 'כותב', color: '#c58bf2', label: 'טיוטה', inputs: ['orchestrator', 'researcher', 'chen'], out: s => `content/drafts/${s}.md` },
  { id: 'yael', title: 'יעל', color: '#f28bb6', label: 'שכתוב בסגנון הצוות', inputs: ['writer'], out: s => `Output/${s}.md` },
  { id: 'yuval', title: 'יובל', color: '#ffb347', label: 'תמונות', inputs: ['yael'], out: s => `yuval/outputs/${s}.md` },
  { id: 'editor', title: 'עורך', color: '#7fb3ff', label: 'גרסה סופית', inputs: ['yael', 'orchestrator', 'researcher'], out: s => `content/final/${s}.md` },
  { id: 'publisher', title: 'מפיץ', color: '#ff7a7a', label: 'התאמות הפצה', inputs: ['editor'], out: s => `content/final/${s}.distribution.md` }
];

function parseAgent(p) {
  const raw = fs.readFileSync(path.join(__dirname, 'agents', p.id + '.md'), 'utf8').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(raw);
  const fm = {};
  (m ? m[1] : '').split('\n').forEach(l => { const i = l.indexOf(':'); if (i > 0) fm[l.slice(0, i).trim()] = l.slice(i + 1).trim(); });
  const body = (m ? m[2] : raw).trim();
  const sec = /\n## (?:מה לעשות|Flow|Workflow)[^\n]*\n([\s\S]*?)(?:\n## |$)/.exec('\n' + body);
  const clean = s => s.replace(/\*\*|`/g, '').trim();
  const steps = sec ? sec[1].split('\n').map(l => /^\d+\.\s+(.*)$/.exec(l.trim())).filter(Boolean).map(x => clean(x[1])) : [];
  return { ...p, description: fm.description || '', tools: (fm.tools || '').split(',').map(s => s.trim()).filter(Boolean), body, steps };
}
const AGENTS = PIPE.map(parseAgent);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- מודל (סטרימינג) ----------
async function streamLLM(cfg, system, user, onDelta, maxTokens = 2200) {
  const isOpenAI = cfg.provider === 'openai';
  const res = await fetch(isOpenAI ? (process.env.OPENAI_BASE_URL || 'https://api.openai.com') + '/v1/chat/completions' : (process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', {
    method: 'POST',
    headers: isOpenAI
      ? { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` }
      : { 'content-type': 'application/json', 'x-api-key': cfg.key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(isOpenAI
      ? { model: cfg.model, stream: true, max_completion_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }
      : { model: cfg.model, stream: true, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] })
  });
  if (!res.ok) throw new Error(`${isOpenAI ? 'OpenAI' : 'Claude'} API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const dec = new TextDecoder(); let buf = '', full = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (d === '[DONE]') continue;
      try {
        const j = JSON.parse(d);
        const t = isOpenAI ? j.choices?.[0]?.delta?.content : (j.type === 'content_block_delta' ? j.delta?.text : '');
        if (t) { full += t; onDelta(t); }
      } catch { /* partial line */ }
    }
  }
  return full.trim();
}

// יצירת תמונה לפי הסקיל gpt-image-gen: gpt-image-2, 1024x1024, medium, png. דורש מפתח OpenAI.
async function genImage(cfg, prompt) {
  const res = await fetch((process.env.OPENAI_BASE_URL || 'https://api.openai.com') + '/v1/images/generations', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` },
    body: JSON.stringify({ model: IMAGE_MODEL, prompt, size: '1024x1024', quality: 'medium', output_format: 'png' })
  });
  if (!res.ok) throw new Error(`OpenAI Images ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const b64 = (await res.json()).data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI Images: no image in response');
  return Buffer.from(b64, 'base64');
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

// ---------- מצב הדגמה ----------
const DEMO = {
  orchestrator: t => `# בריף: ${t}\n\n**מטרה:** להפוך את הבקשה לתוכן אחד ברור.\n**קהל יעד:** לפי הקשר הפרויקט.\n**מסר מרכזי:** ערך קודם, בלי לחץ.\n**פורמט:** מאמר קצר עם תמונה.\n**טון:** חם, ישיר, מדובר.\n\n## נקודות מפתח\n1. הוק פותח שעוצר גלילה\n2. שלוש נקודות ערך\n3. קריאה לפעולה אחת`,
  chen: t => `# מקורות: ${t}\n\n**מקורות לא אומתו: אין חיפוש ברשת במצב הדגמה.**\n\n## מילות חיפוש מומלצות\n- ${t}\n- מדריך למתחילות\n\n## סוגי מקורות איכותיים\n- אתרים רשמיים ופרסומים מקצועיים`,
  researcher: t => `# מחקר: ${t}\n\n## ממצאים\n- נקודה 1: [מצב הדגמה, אין חיפוש אמיתי]\n- נקודה 2: [צריך אימות]\n\n## מקורות\nאין מקורות במצב הדגמה.`,
  writer: t => `# ${t}\n\nפתיח שמושך: שאלה שהקהל שואל את עצמו.\n\nגוף: שלוש נקודות קצרות לפי הבריף והמחקר.\n\nסיום: קריאה לפעולה אחת, ברורה.\n\n[צריך מקור] — נקודה 2`,
  yael: t => `# ${t}\n\n{{IMAGE_NEEDED: "תמונת פתיחה: בד פשתן קרם מתנופף בשמיים בהירים, אווירה שקטה ויוקרתית, גווני בז' וקרם"}}\n\nפתיח בקול שלנו: שאלה אחת שהקהל באמת שואל.\n\nגוף: שלוש נקודות קצרות וברורות, בלי ז'רגון.\n\n{{IMAGE_NEEDED: "המחשה לנקודה המרכזית: כף יד מחזיקה צנצנת קרם על רקע בז' נקי, תאורה רכה"}}\n\nסיום: קריאה אחת לפעולה.`,
  yuval: () => '',
  editor: t => `# ${t}\n\nפתיח מחודד: שאלה אחת שהקהל באמת שואל.\n\nגוף: שלוש נקודות קצרות וברורות.\n\nסיום: קריאה אחת לפעולה.\n\n---\n## הערות עורך\n- קוצר הפתיח, והתמונות שובצו.\n- ללא בעיות פתוחות. (מצב הדגמה)`,
  publisher: t => `# התאמות הפצה: ${t}\n\n## פייסבוק\nפוסט קצר עם שאלה בסוף.\n\n## אינסטגרם\nקרוסלה של 5 שקפים.\n\n## Checklist פרסום\n- [ ] מדיה מוכנה\n- [ ] קישורים נבדקו\n- [ ] אישור לפני פרסום\n\nהפרסום בפועל ידני אחרי אישור.`
};

const NO_TOOLS = {
  chen: 'את לא יכולה לחפש ברשת בסביבה הזו. אל תמציאי כתובות, כותרים או ציטוטים. פתחי בשורה "מקורות לא אומתו: אין חיפוש ברשת בסביבה זו". אחר כך תני: מילות חיפוש מומלצות, סוגי מקורות איכותיים, ותקציר ידע כללי שאת בטוחה בו, מסומן "לא אומת". לא לעבוד עם זיכרון חיפושים ולא לשמור קבצי Content.',
  yael: 'כתבי את המאמר המשוכתב ב-Markdown בלבד (ללא HTML ובלי שמירת קבצים). השאירי עד 2 placeholders בפורמט {{IMAGE_NEEDED: "תיאור מפורט"}} במקומות המתאימים. אל תוסיפי קישורים או CTA של מחבר מקורי.',
  yuval: `החזירי רק שורות בפורמט "PROMPT <מספר>: <prompt באנגלית>", שורה לכל placeholder, עד ${MAX_IMAGES} שורות. בלי שום טקסט נוסף. אין reference בסביבה זו, אז השתמשי בסגנון נקי ועקבי: גווני בז' וקרם, תאורה רכה, מינימליסטי.`
};

function placeholders(text) {
  return [...text.matchAll(/\{\{IMAGE_NEEDED:\s*"([\s\S]*?)"\s*\}\}/g)].map(m => ({ raw: m[0], desc: m[1] }));
}

function buildPrompts(agent, task, ctx, slug, byAgent) {
  const extra = NO_TOOLS[agent.id] || '';
  const env = `\n\n---\nהקשר הפרויקט (תחליף ל-CLAUDE.md):\n${ctx}\n\nמגבלות הסביבה: אין לך גישה לקבצים, לאינטרנט או לכלים. הקבצים מהשלבים הקודמים מוצגים בהודעה. אל תמציא מקורות או עובדות; מה שחסר מסמנים "[צריך מקור]" או "צריך אימות". כתוב בעברית אלא אם התבקש אחרת. ה-slug הוא ${slug}. ${extra || 'החזר רק את תוכן קובץ הפלט שלך ב-Markdown, בלי הקדמה ובלי תיאור של פעולות על קבצים.'}`;
  const need = agent.inputs.map(id => byAgent[id]).filter(Boolean).map(k => `### ${k.path}\n${k.content}`).join('\n\n');
  const user = agent.id === 'orchestrator' ? `בקשת תוכן: ${task}` : `בקשת התוכן המקורית: ${task}\n\nהקבצים מהשלבים הקודמים:\n\n${need}`;
  return { system: agent.body + env, user };
}

// ---------- ריצת הצוות ----------
async function runCrew(brief, emit) {
  const cfg = resolveCfg(brief);
  const task = String(brief.task || '').trim().slice(0, 1500) || 'מאמר על בדיקת עור לפני טיפול ראשון';
  const ctx = String(brief.context || '').trim().slice(0, 6000) || CLINIC || 'אין הקשר. כתבו תוכן כללי וברור.';
  const runId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + crypto.randomBytes(2).toString('hex');
  const slug = 'task-' + runId.slice(-9);
  const runDir = path.join(__dirname, 'runs', runId);
  emit({ type: 'run', runId, slug, mode: cfg.live ? 'live' : 'demo', model: cfg.live ? `${cfg.provider === 'openai' ? 'OpenAI' : 'Claude'} · ${cfg.model}` : null });
  const byAgent = {}, files = [];
  const save = (rel, data) => { try { const f = path.join(runDir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); } catch { /* אחסון לקריאה בלבד */ } };

  for (const agent of AGENTS) {
    const outPath = agent.out(slug);
    const inputs = agent.inputs.map(id => byAgent[id]).filter(Boolean).map(x => x.path);
    emit({ type: 'start', agent: agent.id, inputs, output: outPath });
    const t0 = Date.now();
    let text = '', note = '';

    if (agent.id === 'yuval') {
      // 1. prompts (מודל) 2. תמונות (gpt-image-2, רק עם מפתח OpenAI) 3. שילוב בטקסט של יעל
      const ph = placeholders(byAgent.yael.content).slice(0, MAX_IMAGES);
      let prompts;
      if (cfg.live) {
        const { system, user } = buildPrompts(agent, task, ctx, slug, byAgent);
        const raw = await streamLLM(cfg, system, user, d => emit({ type: 'delta', agent: agent.id, text: d }), 700);
        prompts = [...raw.matchAll(/PROMPT\s*\d+\s*:\s*(.+)/g)].map(m => m[1].trim()).slice(0, MAX_IMAGES);
        if (!prompts.length) prompts = ph.map(p => p.desc);
      } else {
        prompts = ph.map((p, i) => `Soft minimal beige and cream scene ${i + 1}, gentle natural light, calm luxury skincare mood`);
        const demoText = prompts.map((p, i) => `PROMPT ${i + 1}: ${p}`).join('\n');
        for (let i = 0; i < demoText.length; i += 4) { emit({ type: 'delta', agent: agent.id, text: demoText.slice(i, i + 4) }); await sleep(20); }
      }
      const made = [];
      for (let i = 0; i < prompts.length; i++) {
        const rel = `yuval/outputs/${slug}-${i + 1}.${cfg.live && cfg.provider === 'openai' ? 'png' : cfg.live ? '' : 'svg'}`;
        try {
          if (!cfg.live) {
            const hue = [36, 200][i % 2];
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,86%)"/><stop offset="1" stop-color="hsl(${hue + 20},35%,70%)"/></linearGradient></defs><rect width="640" height="400" fill="url(#g)"/><text x="320" y="190" text-anchor="middle" font-family="Georgia,serif" font-size="30" letter-spacing="6" fill="#fff">ETEL CLINIC</text><text x="320" y="230" text-anchor="middle" font-family="sans-serif" font-size="15" fill="#ffffffcc">demo image ${i + 1}</text></svg>`;
            save(rel, svg); made.push({ rel, n: i + 1, prompt: prompts[i] });
          } else if (cfg.provider === 'openai') {
            emit({ type: 'step', agent: agent.id, text: `מייצר תמונה ${i + 1}/${prompts.length} (${IMAGE_MODEL})` });
            save(rel, await genImage(cfg, prompts[i])); made.push({ rel, n: i + 1, prompt: prompts[i] });
          }
        } catch (e) { note += `תמונה ${i + 1} נכשלה: ${e.message}\n`; }
        const m = made.find(x => x.n === i + 1);
        if (m) emit({ type: 'image', agent: agent.id, url: `/runs/${runId}/${m.rel}`, prompt: m.prompt, n: m.n });
      }
      if (cfg.live && cfg.provider !== 'openai') note += 'יצירת תמונות דורשת מפתח OpenAI (gpt-image-2). נוצרו prompts בלבד.\n';
      text = `# תמונות: ${slug}\n\n` + prompts.map((p, i) => `## תמונה ${i + 1}\n**Prompt:** ${p}\n**קובץ:** ${made.find(x => x.n === i + 1)?.rel || 'לא נוצר'}`).join('\n\n') + (note ? `\n\n## הערות\n${note}` : '');
      // שילוב: מחליפים placeholders בטקסט של יעל בהפניות לתמונות, והעורך מקבל את הגרסה המשולבת
      let merged = byAgent.yael.content;
      placeholders(merged).forEach((p, i) => {
        const m = made.find(x => x.n === i + 1);
        merged = merged.replace(p.raw, m ? `![תמונה ${i + 1}](${m.rel})` : `[תמונה חסרה: ${p.desc}]`);
      });
      byAgent.yael = { ...byAgent.yael, content: merged };
      files.find(f => f.agent === 'yael').content = merged;
    } else if (cfg.live) {
      const { system, user } = buildPrompts(agent, task, ctx, slug, byAgent);
      text = await streamLLM(cfg, system, user, d => emit({ type: 'delta', agent: agent.id, text: d }));
    } else {
      text = DEMO[agent.id](task);
      for (let i = 0; i < text.length; i += 4) { emit({ type: 'delta', agent: agent.id, text: text.slice(i, i + 4) }); await sleep(30); }
      await sleep(600);
    }

    const file = { agent: agent.id, label: agent.label, path: outPath, content: text };
    byAgent[agent.id] = file; files.push(file);
    save(outPath, text);
    emit({ type: 'done', agent: agent.id, ms: Date.now() - t0, chars: text.length, file, note: note.trim() });
  }
  emit({ type: 'final', files: files.map(f => ({ agent: f.agent, label: f.label, path: f.path, content: f.content })) });
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
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

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

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('cache-control', 'no-store');
  if (PASSWORD && await handleAuth(req, res, url)) return;
  if (url.pathname === '/api/agents') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      auth: Boolean(PASSWORD), live: LIVE, model: LIVE ? `${PROVIDER === 'openai' ? 'OpenAI' : 'Claude'} · ${MODEL}` : null,
      defaultContext: CLINIC,
      agents: AGENTS.map(a => ({ id: a.id, title: a.title, color: a.color, label: a.label, out: a.out('<slug>'), inputs: a.inputs, description: a.description, tools: a.tools, steps: a.steps }))
    }));
  }
  if (url.pathname === '/api/run' && req.method === 'POST') {
    let body = '';
    for await (const c of req) { body += c; if (body.length > 20000) break; }
    let brief = {};
    try { brief = JSON.parse(body || '{}'); } catch { /* empty */ }
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache' });
    const emit = e => res.write(JSON.stringify({ t: Date.now(), ...e }) + '\n');
    try { await runCrew(brief, emit); }
    catch (err) { emit({ type: 'error', message: String(err.message || err) }); }
    return res.end();
  }
  if (url.pathname.startsWith('/runs/') && /\.(png|svg)$/.test(url.pathname)) return serveFrom(path.join(__dirname, 'runs'), url.pathname.slice(6), res);
  return serveFrom(path.join(__dirname, 'public'), url.pathname === '/' ? 'index.html' : url.pathname, res);
}).listen(PORT, PASSWORD ? '0.0.0.0' : '127.0.0.1', () => console.log(`Agent crew: http://localhost:${PORT}  [${PASSWORD ? 'password ON' : 'localhost only, no password'}]  (${LIVE ? `LIVE ${PROVIDER} ${MODEL}` : 'DEMO mode'})`));
