// מרכז שליטה: צוות 8 סוכנים על OpenAI בלבד, לכל עסק. שרת ללא תלויות (Node 18+).
// הקשר העסק מוגדר בדף (או בקובץ context.md / CONTEXT_FILE כברירת מחדל), ותבניות לתחומים ב-profiles.json.
// כל סוכן נטען מקובץ ההגדרה שלו ב-agents/*.md. ההעברה בין סוכנים נעשית דרך קבצים (runs/<runId>/...).
// מצב חי: OPENAI_API_KEY, או מפתח שמוזן בדף. בלי מפתח: מצב הדגמה.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const MODEL = process.env.OPENAI_MODEL || 'gpt-4.1';
const LIVE = Boolean(OPENAI_KEY);
const BASE = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
const IMAGE_MODEL = 'gpt-image-2'; // לפי הגדרת הסקיל gpt-image-gen בפרויקט. לא לשנות.
const MAX_IMAGES = 2;
const BRAND = process.env.BRAND_NAME || 'Agent Crew';

let DEFAULT_CTX = '';
try { DEFAULT_CTX = fs.readFileSync(process.env.CONTEXT_FILE || path.join(__dirname, 'context.md'), 'utf8'); } catch { /* optional */ }
let PROFILES = [];
try { PROFILES = JSON.parse(fs.readFileSync(path.join(__dirname, 'profiles.json'), 'utf8')); } catch { /* optional */ }
const NO_CTX = 'לא הוגדר הקשר עסקי. כתבו תוכן כללי וברור, ובסעיף "פערים פתוחים" ציינו מה צריך לדעת על העסק (תחום, קהל, טון, כללים).';

// ---------- הסוכנים ----------
// inputs = מזהי הסוכנים שהקבצים שלהם עוברים לסוכן הזה. out = נתיב קובץ הפלט. search = מקבל חיפוש חי ברשת.
const PIPE = [
  { id: 'orchestrator', title: 'מנהל', color: '#e0b567', label: 'בריף', inputs: [], out: s => `content/briefs/${s}.md` },
  { id: 'chen', title: 'חן', color: '#8fd16a', label: 'מקורות', search: true, inputs: ['orchestrator'], out: s => `content/sources/${s}.md` },
  { id: 'researcher', title: 'חוקר', color: '#44b3a6', label: 'מחקר', search: true, inputs: ['orchestrator', 'chen'], out: s => `content/research/${s}.md` },
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
const hdr = cfg => ({ 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` });
const fail = async (what, res) => { throw new Error(`${what} ${res.status}: ${(await res.text()).slice(0, 220)}`); };

// קורא זרם SSE ומחזיר אובייקטי data
async function* sse(res) {
  const dec = new TextDecoder(); let buf = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (d === '[DONE]') continue;
      try { yield JSON.parse(d); } catch { /* partial */ }
    }
  }
}

// ---------- מודל: Chat Completions (סטרימינג) ----------
async function streamLLM(cfg, system, user, onDelta, maxTokens = 2200) {
  const res = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: hdr(cfg),
    body: JSON.stringify({ model: cfg.model, stream: true, max_completion_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
  });
  if (!res.ok) await fail('OpenAI API', res);
  let full = '';
  for await (const j of sse(res)) { const t = j.choices?.[0]?.delta?.content; if (t) { full += t; onDelta(t); } }
  return full.trim();
}

// ---------- מודל: Responses API עם חיפוש חי ברשת (web_search) ----------
async function streamSearch(cfg, system, user, h, maxTokens = 2600) {
  const open = tool => fetch(BASE + '/v1/responses', {
    method: 'POST', headers: hdr(cfg),
    body: JSON.stringify({ model: cfg.model, stream: true, instructions: system, input: user, tools: [{ type: tool }], max_output_tokens: maxTokens })
  });
  let res = await open('web_search');
  if (!res.ok && (res.status === 400 || res.status === 404)) res = await open('web_search_preview');
  if (!res.ok) await fail('OpenAI Responses', res);
  let full = ''; const sources = new Map();
  const cleanUrl = u => { try { const x = new URL(u); if (x.searchParams.get('utm_source') === 'openai') x.searchParams.delete('utm_source'); return x.toString(); } catch { return u; } };
  const addSource = a => { const url = a?.url && cleanUrl(a.url); if (url && !sources.has(url)) { const s = { url, title: a.title || url }; sources.set(url, s); h.onSource(s); } };
  for await (const j of sse(res)) {
    const t = j.type;
    if (t === 'response.output_text.delta' && j.delta) { full += j.delta; h.onDelta(j.delta); }
    else if (t === 'response.web_search_call.searching' || t === 'response.web_search_call.in_progress') h.onSearch('');
    else if (t === 'response.output_item.done' && j.item?.type === 'web_search_call') { const q = j.item.action?.query; if (q) h.onSearch(q); }
    else if (t === 'response.output_text.annotation.added' && j.annotation?.type === 'url_citation') addSource(j.annotation);
    else if (t === 'response.completed') { for (const o of j.response?.output || []) for (const c of o.content || []) for (const a of c.annotations || []) if (a.type === 'url_citation') addSource(a); }
    else if (t === 'error' || t === 'response.failed') throw new Error('OpenAI Responses: ' + (j.message || j.response?.error?.message || 'failed'));
  }
  return { text: full.trim(), sources: [...sources.values()] };
}

// ---------- ראייה: ניתוח סגנון מתמונות reference ----------
async function describeStyle(cfg, refs) {
  const res = await fetch(BASE + '/v1/chat/completions', {
    method: 'POST', headers: hdr(cfg),
    body: JSON.stringify({
      model: cfg.model, max_completion_tokens: 300,
      messages: [{ role: 'user', content: [
        { type: 'text', text: 'Describe the shared visual style of these reference images in 3 short English lines: medium/look, color palette, lighting, composition. No preamble.' },
        ...refs.map(u => ({ type: 'image_url', image_url: { url: u } }))
      ] }]
    })
  });
  if (!res.ok) await fail('OpenAI Vision', res);
  return ((await res.json()).choices?.[0]?.message?.content || '').trim();
}

// יצירת תמונה לפי הסקיל gpt-image-gen: gpt-image-2, 1024x1024, medium, png.
async function genImage(cfg, prompt) {
  const res = await fetch(BASE + '/v1/images/generations', {
    method: 'POST', headers: hdr(cfg),
    body: JSON.stringify({ model: IMAGE_MODEL, prompt, size: '1024x1024', quality: 'medium', output_format: 'png' })
  });
  if (!res.ok) await fail('OpenAI Images', res);
  const b64 = (await res.json()).data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI Images: no image in response');
  return Buffer.from(b64, 'base64');
}

// מפתח מהדפדפן (בקשה בודדת, לא נשמר ולא נרשם ביומן) קודם למפתח מהשרת.
function resolveCfg(brief) {
  const userKey = typeof brief.apiKey === 'string' ? brief.apiKey.trim() : '';
  const model = String(brief.model || '').trim() || MODEL;
  if (userKey) return { live: true, key: userKey, model };
  return { live: LIVE, key: OPENAI_KEY, model };
}
const jsonFrom = (text, open, close) => { const a = text.indexOf(open), b = text.lastIndexOf(close); if (a < 0 || b < a) return null; try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; } };

// ---------- מצב הדגמה ----------
const DEMO = {
  orchestrator: t => `# בריף: ${t}\n\n**מטרה:** להפוך את הבקשה לתוכן אחד ברור.\n**קהל יעד:** לפי הקשר הפרויקט.\n**מסר מרכזי:** ערך קודם, בלי לחץ.\n**פורמט:** מאמר קצר עם תמונה.\n**טון:** חם, ישיר, מדובר.\n\n## נקודות מפתח\n1. הוק פותח שעוצר גלילה\n2. שלוש נקודות ערך\n3. קריאה לפעולה אחת`,
  chen: t => `# מקורות: ${t}\n\n**מצב הדגמה: אין חיפוש אמיתי.** במצב חי חן מחפשת ברשת ומחזירה קישורים אמיתיים.\n\n## מילות חיפוש\n- ${t}\n- מדריך למתחילות`,
  researcher: t => `# מחקר: ${t}\n\n## ממצאים\n- נקודה 1: [מצב הדגמה]\n- נקודה 2: [צריך אימות]\n\n## מקורות\nאין מקורות במצב הדגמה.`,
  writer: t => `# ${t}\n\nפתיח שמושך: שאלה שהקהל שואל את עצמו.\n\nגוף: שלוש נקודות קצרות לפי הבריף והמחקר.\n\nסיום: קריאה לפעולה אחת, ברורה.\n\n[צריך מקור] — נקודה 2`,
  yael: t => `# ${t}\n\n{{IMAGE_NEEDED: "תמונת פתיחה: סצנה נקייה ומודרנית שמבטאת את המותג, תאורה רכה, פלטת צבעים עדינה"}}\n\nפתיח בקול שלנו: שאלה אחת שהקהל באמת שואל.\n\n## שלוש נקודות\n- נקודה ראשונה, קצרה וברורה\n- נקודה שנייה, בלי ז'רגון\n- נקודה שלישית, עם **דגש** אחד\n\n{{IMAGE_NEEDED: "המחשה לנקודה המרכזית: קומפוזיציה פשוטה עם אלמנט אחד בולט על רקע נקי"}}\n\nסיום: קריאה אחת לפעולה.`,
  yuval: () => '',
  editor: t => `# ${t}\n\n![תמונה 1](yuval/outputs/demo-1.svg)\n\nפתיח מחודד: שאלה אחת שהקהל באמת שואל.\n\n## שלוש נקודות\n- נקודה ראשונה, קצרה וברורה\n- נקודה שנייה, בלי ז'רגון\n- נקודה שלישית, עם **דגש** אחד\n\n![תמונה 2](yuval/outputs/demo-2.svg)\n\nסיום: קריאה אחת לפעולה.\n\n---\n## הערות עורך\n- קוצר הפתיח, והתמונות שובצו.\n- ללא בעיות פתוחות. (מצב הדגמה)`,
  publisher: t => `# התאמות הפצה: ${t}\n\n## פייסבוק\nפוסט קצר עם שאלה בסוף.\n\n## אינסטגרם\nקרוסלה של 5 שקפים.\n\n## Checklist פרסום\n- [ ] מדיה מוכנה\n- [ ] קישורים נבדקו\n- [ ] אישור לפני פרסום\n\nהפרסום בפועל ידני אחרי אישור.`
};
const DEMO_QUERIES = { chen: ['טרנדים עכשיו בתחום', 'מדריכים אמינים לנושא'], researcher: ['נתונים ועובדות עדכניות', 'שאלות נפוצות של הקהל'] };
const DEMO_SOURCES = [
  { url: 'https://example.com/demo-1', title: 'מקור לדוגמה 1 (הדגמה)' },
  { url: 'https://example.org/demo-2', title: 'מקור לדוגמה 2 (הדגמה)' },
  { url: 'https://example.net/demo-3', title: 'מקור לדוגמה 3 (הדגמה)' }
];

const NOTES = {
  chen: 'יש לך חיפוש חי ברשת. השתמשי בו: מצאי מקורות עדכניים ואמינים, וציטטי רק קישורים אמיתיים שהחיפוש החזיר. אל תמציאי כתובות, כותרים או ציטוטים. הגישה היא רק לחיפוש, בלי שמירת קבצים וזיכרון חיפושים. החזירי סיכום מאורגן של הממצאים עם הקישורים.',
  researcher: 'יש לך חיפוש חי ברשת. השתמשי בו כדי לאמת עובדות ולמצוא נתונים עדכניים. לכל טענה ציינו מקור אמיתי מהחיפוש, והפרידי בין עובדה מאומתת להערכה. אל תמציאי מקורות.',
  yael: 'כתבי את המאמר המשוכתב ב-Markdown בלבד (ללא HTML ובלי שמירת קבצים). השאירי עד 2 placeholders בפורמט {{IMAGE_NEEDED: "תיאור מפורט"}} במקומות המתאימים. תיאור התמונה חייב להתאים למציאות של העסק לפי ההקשר: אווירה, צבעים ונושא. בלי טקסט, לוגו, שלטים או שמות מותג בתמונה (הלוגו האמיתי מתווסף בנפרד), ובלי להמציא אנשים, מוצרים או מקומות ספציפיים. אל תוסיפי קישורים או CTA של מחבר מקורי.',
  yuval: `החזירי רק שורות בפורמט "PROMPT <מספר>: <prompt באנגלית>", שורה לכל placeholder, עד ${MAX_IMAGES} שורות. בלי שום טקסט נוסף. כל prompt חייב להתאים לעסק ולמציאות שלו לפי ההקשר (נושא, אווירה, צבעים). בלי טקסט, אותיות, לוגו, שלטים או שמות מותג בתמונה, כי הלוגו האמיתי של העסק מתווסף בנפרד. בלי להמציא אנשים, מוצרים או מקומות ספציפיים.`
};

function placeholders(text) {
  return [...text.matchAll(/\{\{IMAGE_NEEDED:\s*"([\s\S]*?)"\s*\}\}/g)].map(m => ({ raw: m[0], desc: m[1] }));
}

function buildPrompts(agent, task, ctx, slug, byAgent, style) {
  const extra = NOTES[agent.id] || '';
  const tools = agent.search ? '' : 'אין לך גישה לקבצים, לאינטרנט או לכלים. ';
  const env = `\n\n---\nהקשר הפרויקט (תחליף ל-CLAUDE.md):\n${ctx}\n\nמגבלות הסביבה: ${tools}הקבצים מהשלבים הקודמים מוצגים בהודעה. אל תמציא מקורות או עובדות; מה שחסר מסמנים "[צריך מקור]" או "צריך אימות". כתוב בעברית אלא אם התבקש אחרת. ה-slug הוא ${slug}. ${extra || 'החזר רק את תוכן קובץ הפלט שלך ב-Markdown, בלי הקדמה ובלי תיאור של פעולות על קבצים.'}${agent.id === 'yuval' && style ? `\n\nסגנון מה-reference (חובה להתאים אליו):\n${style}` : ''}`;
  const need = agent.inputs.map(id => byAgent[id]).filter(Boolean).map(k => `### ${k.path}\n${k.content}`).join('\n\n');
  const user = agent.id === 'orchestrator' ? `בקשת תוכן: ${task}` : `בקשת התוכן המקורית: ${task}\n\nהקבצים מהשלבים הקודמים:\n\n${need}`;
  return { system: agent.body + env, user };
}

// ---------- ריצת הצוות ----------
async function runCrew(brief, emit) {
  const cfg = resolveCfg(brief);
  const task = String(brief.task || '').trim().slice(0, 1500) || 'פוסט היכרות שמציג את העסק ואת השירות הראשי שלו';
  const ctx = String(brief.context || '').trim().slice(0, 6000) || DEFAULT_CTX || NO_CTX;
  const biz = String(brief.businessName || '').trim().slice(0, 60) || BRAND;
  const refs = (Array.isArray(brief.refs) ? brief.refs : []).filter(u => typeof u === 'string' && /^data:image\/(png|jpe?g|webp);base64,/.test(u) && u.length < 900000).slice(0, 3);
  const runId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + crypto.randomBytes(2).toString('hex');
  const slug = 'task-' + runId.slice(-9);
  const runDir = path.join(__dirname, 'runs', runId);
  emit({ type: 'run', runId, slug, mode: cfg.live ? 'live' : 'demo', model: cfg.live ? `OpenAI · ${cfg.model}` : null, refs: refs.length });
  const byAgent = {}, files = [];
  const save = (rel, data) => { try { const f = path.join(runDir, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data); } catch { /* אחסון לקריאה בלבד */ } };

  for (const agent of AGENTS) {
    const outPath = agent.out(slug);
    const inputs = agent.inputs.map(id => byAgent[id]).filter(Boolean).map(x => x.path);
    emit({ type: 'start', agent: agent.id, inputs, output: outPath });
    const t0 = Date.now();
    let text = '', note = '', srcs = [];
    const onDelta = d => emit({ type: 'delta', agent: agent.id, text: d });

    if (agent.id === 'yuval') {
      let style = '';
      if (cfg.live && refs.length) {
        emit({ type: 'step', agent: agent.id, text: `מנתח ${refs.length} תמונות reference (ראייה)` });
        try { style = await describeStyle(cfg, refs); emit({ type: 'style', agent: agent.id, style }); } catch (e) { note += `ניתוח reference נכשל: ${e.message}\n`; }
      }
      const ph = placeholders(byAgent.yael.content).slice(0, MAX_IMAGES);
      let prompts;
      if (cfg.live) {
        const { system, user } = buildPrompts(agent, task, ctx, slug, byAgent, style);
        const raw = await streamLLM(cfg, system, user, onDelta, 700);
        prompts = [...raw.matchAll(/PROMPT\s*\d+\s*:\s*(.+)/g)].map(m => m[1].trim()).slice(0, MAX_IMAGES);
        if (!prompts.length) prompts = ph.map(p => p.desc);
      } else {
        prompts = ph.map((p, i) => `Clean modern brand scene ${i + 1}, soft natural light, minimal composition, calm premium mood`);
        const demoText = prompts.map((p, i) => `PROMPT ${i + 1}: ${p}`).join('\n');
        for (let i = 0; i < demoText.length; i += 4) { onDelta(demoText.slice(i, i + 4)); await sleep(20); }
      }
      const made = [];
      for (let i = 0; i < prompts.length; i++) {
        const rel = `yuval/outputs/${slug}-${i + 1}.${cfg.live ? 'png' : 'svg'}`;
        try {
          if (!cfg.live) {
            const hue = [36, 200][i % 2];
            save(rel, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,86%)"/><stop offset="1" stop-color="hsl(${hue + 20},35%,70%)"/></linearGradient></defs><rect width="640" height="400" fill="url(#g)"/><text x="320" y="190" text-anchor="middle" font-family="Georgia,serif" font-size="30" letter-spacing="6" fill="#fff">${biz.toUpperCase().replace(/[<&>"]/g, '')}</text><text x="320" y="230" text-anchor="middle" font-family="sans-serif" font-size="15" fill="#ffffffcc">demo image ${i + 1}</text></svg>`);
          } else {
            emit({ type: 'step', agent: agent.id, text: `מייצר תמונה ${i + 1}/${prompts.length} (${IMAGE_MODEL})` });
            save(rel, await genImage(cfg, `${prompts[i]}${style ? `\n\nStyle reference: ${style}` : ''}\n\nStrict: no text, no letters, no logos, no brand names, no signage, no watermarks anywhere in the image.`));
          }
          made.push({ rel, n: i + 1, prompt: prompts[i] });
          emit({ type: 'image', agent: agent.id, url: `/runs/${runId}/${rel}`, prompt: prompts[i], n: i + 1 });
        } catch (e) { note += `תמונה ${i + 1} נכשלה: ${e.message}\n`; }
      }
      text = `# תמונות: ${slug}\n\n` + (style ? `**סגנון מה-reference:** ${style}\n\n` : '') + prompts.map((p, i) => `## תמונה ${i + 1}\n**Prompt:** ${p}\n**קובץ:** ${made.find(x => x.n === i + 1)?.rel || 'לא נוצר'}`).join('\n\n') + (note ? `\n\n## הערות\n${note}` : '');
      // שילוב: מחליפים placeholders בטקסט של יעל בהפניות לתמונות, והעורך מקבל את הגרסה המשולבת
      let merged = byAgent.yael.content;
      placeholders(merged).forEach((p, i) => {
        const m = made.find(x => x.n === i + 1);
        merged = merged.replace(p.raw, m ? `![תמונה ${i + 1}](${m.rel})` : `[תמונה חסרה: ${p.desc}]`);
      });
      byAgent.yael = { ...byAgent.yael, content: merged };
      files.find(f => f.agent === 'yael').content = merged;
    } else if (cfg.live && agent.search) {
      const { system, user } = buildPrompts(agent, task, ctx, slug, byAgent);
      try {
        const r = await streamSearch(cfg, system, user, { onDelta, onSearch: q => emit({ type: 'search', agent: agent.id, query: q }), onSource: s => emit({ type: 'source', agent: agent.id, ...s }) });
        text = r.text; srcs = r.sources;
      } catch (e) {
        note += `חיפוש חי לא זמין (${e.message}). עובד בלי חיפוש.\n`;
        text = await streamLLM(cfg, system + '\n\nאין חיפוש ברשת כרגע. אל תמציאי קישורים; סמני "צריך אימות".', user, onDelta);
      }
      if (srcs.length) text += `\n\n## מקורות (חיפוש חי)\n` + srcs.map(s => `- [${s.title}](${s.url})`).join('\n');
    } else if (cfg.live) {
      const { system, user } = buildPrompts(agent, task, ctx, slug, byAgent);
      text = await streamLLM(cfg, system, user, onDelta);
    } else {
      if (agent.search) {
        for (const q of DEMO_QUERIES[agent.id]) { emit({ type: 'search', agent: agent.id, query: q }); await sleep(450); }
        for (const s of DEMO_SOURCES) { emit({ type: 'source', agent: agent.id, ...s }); await sleep(250); }
      }
      text = DEMO[agent.id](task);
      for (let i = 0; i < text.length; i += 4) { onDelta(text.slice(i, i + 4)); await sleep(30); }
      await sleep(500);
    }

    if (!/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(ctx)) text = text.replace(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g, '');
    const file = { agent: agent.id, label: agent.label, path: outPath, content: text };
    byAgent[agent.id] = file; files.push(file);
    save(outPath, text);
    emit({ type: 'done', agent: agent.id, ms: Date.now() - t0, chars: text.length, file, note: note.trim(), sources: srcs.length });
  }
  emit({ type: 'final', files: files.map(f => ({ agent: f.agent, label: f.label, path: f.path, content: f.content })) });

  // פרואקטיבי: הצעות להמשך
  try {
    let ideas;
    if (cfg.live) {
      const raw = await streamLLM(cfg, 'את מנהלת תוכן פרואקטיבית. החזירי JSON בלבד: מערך של 3 מחרוזות, כל אחת משימת המשך קצרה וקונקרטית בעברית לצוות התוכן.', `הקשר:\n${ctx}\n\nהמשימה שהושלמה: ${task}\n\nהתוצר הסופי:\n${byAgent.editor.content.slice(0, 2500)}`, () => {}, 300);
      ideas = jsonFrom(raw, '[', ']');
    } else ideas = ['גרסה רוסית של אותו תוכן לקבוצת נשים', 'סדרת סטוריז של 4 פריימים מאותו נושא', 'פוסט שאלות ותשובות על אותו נושא'];
    if (Array.isArray(ideas)) emit({ type: 'next', ideas: ideas.filter(x => typeof x === 'string').slice(0, 3) });
  } catch { /* הצעות הן בונוס */ }
}

// ---------- בדיקת חיבור (חינמית: בלי יצירת תוכן) ----------
async function checkConn(brief) {
  const cfg = resolveCfg(brief);
  if (!cfg.live) return [{ name: 'מפתח OpenAI', ok: false, detail: 'לא הוזן מפתח. הדביקי אותו בשדה למעלה, או הגדירי OPENAI_API_KEY בשרת.' }];
  const out = [];
  const step = async (name, fn) => { try { out.push({ name, ok: true, detail: await fn() }); } catch (e) { out.push({ name, ok: false, detail: String(e.message || e) }); } };
  const model = async id => { const r = await fetch(BASE + '/v1/models/' + encodeURIComponent(id), { headers: hdr(cfg) }); if (!r.ok) await fail('models', r); };
  await step('מפתח ומודל הטקסט', async () => { await model(cfg.model); return `המפתח תקין והמודל ${cfg.model} זמין`; });
  await step('מודל התמונות', async () => { await model(IMAGE_MODEL); return `${IMAGE_MODEL} זמין`; });
  out.push({ name: 'חיפוש ברשת', ok: null, detail: 'אי אפשר לבדוק בלי להריץ חיפוש (עולה כסף). יתברר בהרצה: חן והחוקר יציגו שאילתות ומקורות, ואם לא, תופיע הערה ביומן.' });
  return out;
}
// ---------- רדאר טרנדים (פרואקטיבי) ----------
async function trends(brief) {
  const cfg = resolveCfg(brief);
  const ctx = String(brief.context || '').trim().slice(0, 6000) || DEFAULT_CTX || NO_CTX;
  if (!cfg.live) {
    return { demo: true, ideas: [
      { title: 'רעיון הדגמה 1', why: 'במצב חי הרעיונות מגיעים מחיפוש בזמן אמת ברשת.', task: 'פוסט על הנושא החם של השבוע' },
      { title: 'רעיון הדגמה 2', why: 'מבוסס על מה שאנשים מחפשים עכשיו.', task: 'קרוסלה: 3 דברים שכדאי לדעת' },
      { title: 'רעיון הדגמה 3', why: 'עונתיות ואירועים קרובים.', task: 'רילס קצר לקראת העונה' }
    ], sources: [] };
  }
  const system = 'את מנהלת תוכן פרואקטיבית. חפשי ברשת מה חם ועדכני עכשיו בתחום העסק (חדשות, מגמות, שאלות שאנשים שואלים, עונתיות) והצעי 5 רעיונות לתוכן שכדאי לפרסם השבוע. החזירי JSON בלבד, בלי טקסט נוסף: [{"title":"כותרת קצרה","why":"למה זה חם עכשיו, משפט אחד","task":"משימה מוכנה לצוות התוכן בעברית"}]. אל תמציאי עובדות.';
  const r = await streamSearch(cfg, system, `הקשר העסק:\n${ctx}\n\nהתאריך היום: ${new Date().toISOString().slice(0, 10)}`, { onDelta: () => {}, onSearch: () => {}, onSource: () => {} }, 1800);
  const ideas = jsonFrom(r.text, '[', ']');
  if (!Array.isArray(ideas)) throw new Error('לא התקבלו רעיונות תקינים');
  return { demo: false, ideas: ideas.slice(0, 5), sources: r.sources.slice(0, 8) };
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

async function readJson(req, limit = 6_000_000) {
  let body = '', over = false;
  for await (const c of req) { body += c; if (body.length > limit) { over = true; break; } }
  if (over) return null;
  try { return JSON.parse(body || '{}'); } catch { return {}; }
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  res.setHeader('x-content-type-options', 'nosniff'); res.setHeader('referrer-policy', 'no-referrer'); res.setHeader('cache-control', 'no-store');
  if (PASSWORD && await handleAuth(req, res, url)) return;
  if (url.pathname === '/api/agents') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({
      brand: BRAND, auth: Boolean(PASSWORD), live: LIVE, model: LIVE ? `OpenAI · ${MODEL}` : null,
      defaultContext: DEFAULT_CTX, profiles: PROFILES,
      agents: AGENTS.map(a => ({ id: a.id, title: a.title, color: a.color, label: a.label, search: Boolean(a.search), out: a.out('<slug>'), inputs: a.inputs, description: a.description, tools: a.tools, steps: a.steps }))
    }));
  }
  if (url.pathname === '/api/run' && req.method === 'POST') {
    const brief = await readJson(req);
    if (!brief) { res.writeHead(413, { 'content-type': 'application/json' }); return res.end('{"error":"request too large"}'); }
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache' });
    const emit = e => res.write(JSON.stringify({ t: Date.now(), ...e }) + '\n');
    try { await runCrew(brief, emit); }
    catch (err) { emit({ type: 'error', message: String(err.message || err) }); }
    return res.end();
  }
  if (url.pathname === '/api/check' && req.method === 'POST') {
    const brief = await readJson(req, 200_000) || {};
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify(await checkConn(brief)));
  }
  if (url.pathname === '/api/trends' && req.method === 'POST') {
    const brief = await readJson(req, 200_000) || {};
    try { const out = await trends(brief); res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify(out)); }
    catch (err) { res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' }); return res.end(JSON.stringify({ error: String(err.message || err) })); }
  }
  if (url.pathname.startsWith('/runs/') && /\.(png|svg)$/.test(url.pathname)) return serveFrom(path.join(__dirname, 'runs'), url.pathname.slice(6), res);
  return serveFrom(path.join(__dirname, 'public'), url.pathname === '/' ? 'index.html' : url.pathname, res);
}).listen(PORT, PASSWORD ? '0.0.0.0' : '127.0.0.1', () => console.log(`Agent crew: http://localhost:${PORT}  [${PASSWORD ? 'password ON' : 'localhost only, no password'}]  (${LIVE ? `LIVE OpenAI ${MODEL}` : 'DEMO mode'})`));
