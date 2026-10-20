// מנוע צוות הסוכנים: קובץ אחד שרץ גם בשרת Node וגם ישירות בדפדפן (אירוח סטטי).
// כל הקריאות הן ל-OpenAI בלבד. אין תלות בקבצים: הסביבה מעבירה io (שמירה והגשה של תמונות וקבצים).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CrewEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULT_MODEL = 'gpt-4.1';
  const IMAGE_MODEL = 'gpt-image-2'; // לפי הגדרת הסקיל gpt-image-gen בפרויקט. לא לשנות.
  const TTS_MODEL = 'gpt-4o-mini-tts';
  const MAX_IMAGES = 2;
  const NO_CTX = 'לא הוגדר הקשר עסקי. כתבו תוכן כללי וברור, ובסעיף "פערים פתוחים" ציינו מה צריך לדעת על העסק (תחום, קהל, טון, כללים).';

  // פורמטים לרשתות חברתיות. gen = הגודל שמבקשים מהמודל, והדפדפן חותך בדיוק ליחס.
  const FORMATS = {
    '1:1': { label: 'פוסט ריבועי · פייסבוק, אינסטגרם, לינקדאין', w: 1, h: 1, gen: '1024x1024' },
    '4:5': { label: 'אינסטגרם פיד (4:5)', w: 4, h: 5, gen: '1024x1536' },
    '9:16': { label: 'סטורי, רילס, טיקטוק, שורטס (9:16)', w: 9, h: 16, gen: '1024x1536' },
    '16:9': { label: 'יוטיוב, כרזה, פייסבוק רוחבי (16:9)', w: 16, h: 9, gen: '1536x1024' },
    '1.91:1': { label: 'קישור בפייסבוק או לינקדאין (1.91:1)', w: 191, h: 100, gen: '1536x1024' },
    '2:3': { label: 'פינטרסט (2:3)', w: 2, h: 3, gen: '1024x1536' }
  };

  // inputs = מזהי הסוכנים שהקבצים שלהם עוברים לסוכן. out = נתיב קובץ הפלט. search = חיפוש חי ברשת.
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

  // data = { id: { description, tools, body, steps } } מקבצי agents/*.md
  const buildAgents = data => PIPE.map(p => ({ ...p, ...(data[p.id] || { description: '', tools: [], body: '', steps: [] }) }));
  const meta = agents => agents.map(a => ({ id: a.id, title: a.title, color: a.color, label: a.label, search: Boolean(a.search), out: a.out('<slug>'), inputs: a.inputs, description: a.description, tools: a.tools, steps: a.steps }));

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const hdr = cfg => ({ 'content-type': 'application/json', authorization: `Bearer ${cfg.key}` });
  const fail = async (what, res) => { throw new Error(`${what} ${res.status}: ${(await res.text()).slice(0, 220)}`); };
  const jsonFrom = (text, open, close) => { const a = text.indexOf(open), b = text.lastIndexOf(close); if (a < 0 || b < a) return null; try { return JSON.parse(text.slice(a, b + 1)); } catch { return null; } };
  const placeholders = text => [...text.matchAll(/\{\{IMAGE_NEEDED:\s*"([\s\S]*?)"\s*\}\}/g)].map(m => ({ raw: m[0], desc: m[1] }));

  // קורא זרם SSE (עובד בשרת ובדפדפן) ומחזיר אובייקטי data
  async function* sse(res) {
    const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
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

  async function streamLLM(cfg, system, user, onDelta, maxTokens = 2200) {
    const res = await fetch(cfg.base + '/v1/chat/completions', {
      method: 'POST', headers: hdr(cfg),
      body: JSON.stringify({ model: cfg.model, stream: true, max_completion_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })
    });
    if (!res.ok) await fail('OpenAI API', res);
    let full = '';
    for await (const j of sse(res)) { const t = j.choices?.[0]?.delta?.content; if (t) { full += t; onDelta(t); } }
    return full.trim();
  }

  // Responses API עם חיפוש חי ברשת (web_search, ואם נדחה אז web_search_preview)
  async function streamSearch(cfg, system, user, h, maxTokens = 2600) {
    const open = tool => fetch(cfg.base + '/v1/responses', {
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

  // ראייה: ניתוח סגנון מתמונות reference
  async function describeStyle(cfg, refs) {
    const res = await fetch(cfg.base + '/v1/chat/completions', {
      method: 'POST', headers: hdr(cfg),
      body: JSON.stringify({ model: cfg.model, max_completion_tokens: 300, messages: [{ role: 'user', content: [
        { type: 'text', text: 'Describe the shared visual style of these reference images in 3 short English lines: medium/look, color palette, lighting, composition. No preamble.' },
        ...refs.map(u => ({ type: 'image_url', image_url: { url: u } }))
      ] }] })
    });
    if (!res.ok) await fail('OpenAI Vision', res);
    return ((await res.json()).choices?.[0]?.message?.content || '').trim();
  }

  // יצירת תמונה (הסקיל gpt-image-gen): gpt-image-2, medium, png. אם הגודל לא נתמך, חוזרים לריבוע.
  async function genImage(cfg, prompt, size) {
    const call = s => fetch(cfg.base + '/v1/images/generations', { method: 'POST', headers: hdr(cfg), body: JSON.stringify({ model: IMAGE_MODEL, prompt, size: s, quality: 'medium', output_format: 'png' }) });
    let used = size, res = await call(size);
    if (!res.ok && res.status === 400 && size !== '1024x1024') { used = '1024x1024'; res = await call(used); }
    if (!res.ok) await fail('OpenAI Images', res);
    const b64 = (await res.json()).data?.[0]?.b64_json;
    if (!b64) throw new Error('OpenAI Images: no image in response');
    return { b64, size: used, fellBack: used !== size };
  }

  // הקראה בקול (OpenAI TTS). מחזיר ArrayBuffer של mp3.
  async function tts(cfg, text, opts = {}) {
    const model = opts.model || TTS_MODEL;
    const body = { model, voice: opts.voice || 'coral', input: String(text).slice(0, 600), response_format: 'mp3' };
    if (model === 'gpt-4o-mini-tts') body.instructions = 'Speak Hebrew clearly and naturally, in a warm, upbeat tone at a steady medium pace.';
    const res = await fetch(cfg.base + '/v1/audio/speech', { method: 'POST', headers: hdr(cfg), body: JSON.stringify(body) });
    if (!res.ok) await fail('OpenAI Speech', res);
    return res.arrayBuffer();
  }

  // ---------- הדגמה ----------
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

  function buildPrompts(agent, task, ctx, slug, byAgent, style, fmt) {
    const extra = NOTES[agent.id] || '';
    const tools = agent.search ? '' : 'אין לך גישה לקבצים, לאינטרנט או לכלים. ';
    const env = `\n\n---\nהקשר הפרויקט (תחליף ל-CLAUDE.md):\n${ctx}\n\nמגבלות הסביבה: ${tools}הקבצים מהשלבים הקודמים מוצגים בהודעה. אל תמציא מקורות או עובדות; מה שחסר מסמנים "[צריך מקור]" או "צריך אימות". כתוב בעברית אלא אם התבקש אחרת. ה-slug הוא ${slug}. ${extra || 'החזר רק את תוכן קובץ הפלט שלך ב-Markdown, בלי הקדמה ובלי תיאור של פעולות על קבצים.'}${agent.id === 'yuval' && fmt ? `\n\nפורמט היעד של התמונות: ${fmt.id} (${fmt.label}). חשבו על קומפוזיציה מתאימה לפורמט, עם הנושא המרכזי במרכז.` : ''}${agent.id === 'yuval' && style ? `\n\nסגנון מה-reference (חובה להתאים אליו):\n${style}` : ''}`;
    const need = agent.inputs.map(id => byAgent[id]).filter(Boolean).map(k => `### ${k.path}\n${k.content}`).join('\n\n');
    const user = agent.id === 'orchestrator' ? `בקשת תוכן: ${task}` : `בקשת התוכן המקורית: ${task}\n\nהקבצים מהשלבים הקודמים:\n\n${need}`;
    return { system: agent.body + env, user };
  }

  // ---------- ריצת הצוות ----------
  // cfg = { live, key, model, base }. io = { agents, defaultCtx, brand, putFile(rel, text), putImage(rel, {b64|svg}, mime) -> url }
  async function runCrew(brief, emit, io, cfg) {
    const task = String(brief.task || '').trim().slice(0, 1500) || 'פוסט היכרות שמציג את העסק ואת השירות הראשי שלו';
    const ctx = String(brief.context || '').trim().slice(0, 6000) || io.defaultCtx || NO_CTX;
    const biz = String(brief.businessName || '').trim().slice(0, 60) || io.brand || 'Agent Crew';
    const fid = FORMATS[brief.format] ? brief.format : '1:1';
    const fmt = { id: fid, ...FORMATS[fid] };
    const refs = (Array.isArray(brief.refs) ? brief.refs : []).filter(u => typeof u === 'string' && /^data:image\/(png|jpe?g|webp);base64,/.test(u) && u.length < 900000).slice(0, 3);
    const runId = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + Math.random().toString(16).slice(2, 6);
    const slug = 'task-' + runId.slice(-9);
    emit({ type: 'run', runId, slug, mode: cfg.live ? 'live' : 'demo', model: cfg.live ? `OpenAI · ${cfg.model}` : null, refs: refs.length, format: fid });
    const byAgent = {}, files = [];
    const AG = io.agents;

    for (const agent of AG) {
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
          const { system, user } = buildPrompts(agent, task, ctx, slug, byAgent, style, fmt);
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
            let url;
            if (!cfg.live) {
              const [gw, gh] = fmt.gen.split('x').map(n => Math.round(n / 2.4)), hue = [36, 200][i % 2];
              url = await io.putImage(rel, { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${gw}" height="${gh}" viewBox="0 0 ${gw} ${gh}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,86%)"/><stop offset="1" stop-color="hsl(${hue + 20},35%,70%)"/></linearGradient></defs><rect width="${gw}" height="${gh}" fill="url(#g)"/><text x="${gw / 2}" y="${gh / 2 - 6}" text-anchor="middle" font-family="Georgia,serif" font-size="${gw / 20}" letter-spacing="6" fill="#fff">${biz.toUpperCase().replace(/[<&>"]/g, '')}</text><text x="${gw / 2}" y="${gh / 2 + 28}" text-anchor="middle" font-family="sans-serif" font-size="${gw / 42}" fill="#ffffffcc">demo ${fid} · image ${i + 1}</text></svg>` }, 'image/svg+xml', runId);
            } else {
              emit({ type: 'step', agent: agent.id, text: `מייצר תמונה ${i + 1}/${prompts.length} בפורמט ${fid} (${IMAGE_MODEL})` });
              const full = `${prompts[i]}${style ? `\n\nStyle reference: ${style}` : ''}\n\nCompose for a ${fid} frame; keep the key subject centered with safe margins because the image will be cropped to exactly ${fid}.\n\nStrict: no text, no letters, no logos, no brand names, no signage, no watermarks anywhere in the image.`;
              const g = await genImage(cfg, full, fmt.gen);
              if (g.fellBack) note += `הגודל ${fmt.gen} לא נתמך, נוצרה תמונה ריבועית והיא תיחתך ל-${fid}.\n`;
              url = await io.putImage(rel, { b64: g.b64 }, 'image/png', runId);
            }
            made.push({ rel, n: i + 1, prompt: prompts[i] });
            emit({ type: 'image', agent: agent.id, url, prompt: prompts[i], n: i + 1, ratio: fid });
          } catch (e) { note += `תמונה ${i + 1} נכשלה: ${e.message}\n`; }
        }
        text = `# תמונות: ${slug}\n\n**פורמט:** ${fid} (${fmt.label})\n\n` + (style ? `**סגנון מה-reference:** ${style}\n\n` : '') + prompts.map((p, i) => `## תמונה ${i + 1}\n**Prompt:** ${p}\n**קובץ:** ${made.find(x => x.n === i + 1)?.rel || 'לא נוצר'}`).join('\n\n') + (note ? `\n\n## הערות\n${note}` : '');
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

      if (!/[぀-ヿ㐀-鿿가-힯]/.test(ctx)) text = text.replace(/[぀-ヿ㐀-鿿가-힯]/g, '');
      const file = { agent: agent.id, label: agent.label, path: outPath, content: text };
      byAgent[agent.id] = file; files.push(file);
      if (io.putFile) await io.putFile(outPath, text, runId);
      emit({ type: 'done', agent: agent.id, ms: Date.now() - t0, chars: text.length, file, note: note.trim(), sources: srcs.length });
    }
    emit({ type: 'final', files: files.map(f => ({ agent: f.agent, label: f.label, path: f.path, content: f.content })) });

    try { // פרואקטיבי: הצעות להמשך
      let ideas;
      if (cfg.live) {
        const raw = await streamLLM(cfg, 'את מנהלת תוכן פרואקטיבית. החזירי JSON בלבד: מערך של 3 מחרוזות, כל אחת משימת המשך קצרה וקונקרטית בעברית לצוות התוכן.', `הקשר:\n${ctx}\n\nהמשימה שהושלמה: ${task}\n\nהתוצר הסופי:\n${byAgent.editor.content.slice(0, 2500)}`, () => {}, 300);
        ideas = jsonFrom(raw, '[', ']');
      } else ideas = ['גרסה רוסית של אותו תוכן לקבוצת נשים', 'סדרת סטוריז של 4 פריימים מאותו נושא', 'פוסט שאלות ותשובות על אותו נושא'];
      if (Array.isArray(ideas)) emit({ type: 'next', ideas: ideas.filter(x => typeof x === 'string').slice(0, 3) });
    } catch { /* הצעות הן בונוס */ }
  }

  // בדיקת חיבור חינמית: בלי יצירת תוכן
  async function checkConn(cfg) {
    if (!cfg.live) return [{ name: 'מפתח OpenAI', ok: false, detail: 'לא הוזן מפתח. הדביקי אותו בשדה למעלה.' }];
    const out = [];
    const step = async (name, fn) => { try { out.push({ name, ok: true, detail: await fn() }); } catch (e) { out.push({ name, ok: false, detail: String(e.message || e) }); } };
    const model = async id => { const r = await fetch(cfg.base + '/v1/models/' + encodeURIComponent(id), { headers: hdr(cfg) }); if (!r.ok) await fail('models', r); };
    await step('מפתח ומודל הטקסט', async () => { await model(cfg.model); return `המפתח תקין והמודל ${cfg.model} זמין`; });
    await step('מודל התמונות', async () => { await model(IMAGE_MODEL); return `${IMAGE_MODEL} זמין`; });
    await step('הקראה בקול (OpenAI)', async () => { await model(TTS_MODEL); return `${TTS_MODEL} זמין`; });
    out.push({ name: 'חיפוש ברשת', ok: null, detail: 'אי אפשר לבדוק בלי להריץ חיפוש (עולה כסף). יתברר בהרצה: חן והחוקר יציגו שאילתות ומקורות, ואם לא, תופיע הערה ביומן.' });
    return out;
  }

  // רדאר טרנדים (פרואקטיבי)
  async function trends(brief, io, cfg) {
    const ctx = String(brief.context || '').trim().slice(0, 6000) || io.defaultCtx || NO_CTX;
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

  return { DEFAULT_MODEL, IMAGE_MODEL, TTS_MODEL, FORMATS, PIPE, buildAgents, meta, runCrew, checkConn, trends, tts };
});
