// שכבת מנויים: חשבונות, מסלולים, מכסות, מדידת עלות, חיבור ל-GROW וניהול.
// המפתח של המערכת (OPENAI_API_KEY) נשאר בשרת בלבד. הלקוח אף פעם לא רואה אותו, וכל הריצה על המפתח הזה קורית כאן.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Store } = require('./store.js');
const { growConfig, createCheckout, approveTransaction, parseBody, interpretWebhook } = require('./grow.js');

module.exports = function createSaas({ env, Engine, streamRun, io }) {
  const store = new Store(env.DATA_DIR || path.join(__dirname, '..', 'data'), { url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_KEY });
  const g = growConfig(env);
  const num = (v, d) => (v !== undefined && v !== '' && !Number.isNaN(+v) ? +v : d);
  const C = {
    prices: { own: num(env.PRICE_OWN, 99), managed: num(env.PRICE_MANAGED, 149) },
    limitManaged: num(env.LIMIT_MANAGED, 30), editLimit: num(env.EDIT_LIMIT, 150), trialEdits: num(env.TRIAL_EDITS, 6), radarLimit: num(env.RADAR_LIMIT, 10), trialRuns: num(env.TRIAL_RUNS, 1),
    periodDays: 31, graceDays: num(env.GRACE_DAYS, 3),
    serverKey: env.OPENAI_API_KEY || '', model: env.OPENAI_MODEL || Engine.DEFAULT_MODEL, base: env.OPENAI_BASE_URL || 'https://api.openai.com',
    adminToken: env.ADMIN_TOKEN || '', webhookSecret: env.GROW_WEBHOOK_SECRET || '', allowedOrigin: env.ALLOWED_ORIGIN || '', publicUrl: (env.PUBLIC_URL || '').replace(/\/$/, ''),
    // מחירי OpenAI בדולרים (מקורות משניים, לוודא מול דף המחירים הרשמי). אפשר לדרוס עם PRICES_JSON
    usd: { in: 2 / 1e6, out: 8 / 1e6, search: 0.025, image: 0.045, ...(env.PRICES_JSON ? JSON.parse(env.PRICES_JSON) : {}) },
    usdIls: num(env.USD_ILS, 3.7)
  };
  const active = new Set(), hits = new Map();
  const month = () => new Date().toISOString().slice(0, 7);
  const usageOf = c => (c.usage[month()] ||= { runs: 0, radar: 0, edits: 0, costUsd: 0, searches: 0, images: 0, tin: 0, tout: 0 });
  const costOf = u => (u.in || 0) * C.usd.in + (u.out || 0) * C.usd.out + (u.searches || 0) * C.usd.search + (u.images || 0) * C.usd.image;
  const rate = (ip, max, ms) => { const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < ms); if (a.length >= max) { hits.set(ip, a); return false; } a.push(now); hits.set(ip, a); return true; };
  const ipOf = req => String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const eq = (a, b) => { const x = crypto.createHash('sha256').update(String(a)).digest(), y = crypto.createHash('sha256').update(String(b)).digest(); return crypto.timingSafeEqual(x, y); };

  const limOf = c => (Number.isFinite(c.customLimit) && c.customLimit > 0 ? c.customLimit : C.limitManaged);
  const state = c => {
    const now = Date.now();
    if (c.plan && c.paidUntil && now <= c.paidUntil + C.graceDays * 864e5) return 'active';
    if (c.trialRuns > 0) return 'trial';
    return c.plan ? 'expired' : 'none';
  };
  const pub = c => {
    const u = usageOf(c), managed = c.plan === 'managed';
    return { id: c.id, name: c.name, email: c.email, plan: c.plan, state: state(c), paidUntil: c.paidUntil, trialRuns: c.trialRuns, cancelRequested: c.cancelRequested, blocked: Boolean(c.blocked),
      usage: { runs: u.runs, radar: u.radar, runLimit: managed ? limOf(c) : null, radarLimit: managed ? C.radarLimit : null } };
  };
  const publicConfig = () => ({
    accounts: true, termsUrl: env.TERMS_URL || '',
    plans: {
      own: { name: 'מפתח OpenAI משלך', price: C.prices.own, unlimited: true },
      managed: { name: 'המפתח של המערכת', price: C.prices.managed, limit: C.limitManaged },
      trial: { runs: C.trialRuns }
    }
  });

  function entitle(c, kind) {
    if (c.blocked) return { ok: false, reason: 'blocked' };
    const s = state(c);
    if (kind === 'edit') {
      const u = usageOf(c);
      if (s === 'active') return c.plan === 'own' ? { ok: true, mode: 'own' } : u.edits >= C.editLimit ? { ok: false, reason: 'edit_limit' } : { ok: true, mode: 'managed' };
      if (s === 'trial') return u.edits >= C.trialEdits ? { ok: false, reason: 'edit_limit' } : { ok: true, mode: 'trial' };
      return { ok: false, reason: s === 'expired' ? 'subscription_expired' : 'subscription_required' };
    }
    if (s === 'active') {
      if (c.plan === 'own') return { ok: true, mode: 'own' };
      const u = usageOf(c), used = kind === 'run' ? u.runs : u.radar, lim = kind === 'run' ? limOf(c) : C.radarLimit;
      return used >= lim ? { ok: false, reason: kind === 'run' ? 'limit_reached' : 'radar_limit' } : { ok: true, mode: 'managed' };
    }
    if (s === 'trial') return kind === 'run' ? { ok: true, mode: 'trial' } : { ok: false, reason: 'radar_needs_subscription' };
    return { ok: false, reason: s === 'expired' ? 'subscription_expired' : 'subscription_required' };
  }
  const bump = (c, mode, kind, d) => { if (mode === 'trial') c.trialRuns += -d; else { const u = usageOf(c); const k = kind === 'run' ? 'runs' : 'radar'; u[k] = Math.max(0, u[k] + d); } store.save(); };
  function finish(c, mode, usage, task, ok) {
    const u = usageOf(c), cost = mode === 'own' ? 0 : costOf(usage);
    u.costUsd += cost; u.searches += usage.searches || 0; u.images += usage.images || 0; u.tin += usage.in || 0; u.tout += usage.out || 0;
    c.history.unshift({ t: Date.now(), task: String(task || '').slice(0, 120), mode, costUsd: +cost.toFixed(4), ok }); c.history.length = Math.min(c.history.length, 30); store.save();
  }

  const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
  async function readRaw(req, limit = 6_000_000) { let b = ''; for await (const x of req) { b += x; if (b.length > limit) return null; } return b; }
  async function readJson(req, limit) { const raw = await readRaw(req, limit); if (raw === null) return null; try { return JSON.parse(raw || '{}'); } catch { return {}; } }
  const auth = req => { const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || ''); const c = m ? store.byToken(m[1].trim()) : null; if (c && Date.now() - (c.lastSeen || 0) > 60e3) { c.lastSeen = Date.now(); store.save(); } return c; };
  const isAdmin = req => C.adminToken && eq(req.headers['x-admin-token'] || '', C.adminToken);
  const baseUrl = req => C.publicUrl || `https://${req.headers.host}`;

  async function handle(req, res, url) {
    const p = url.pathname;
    if (!p.startsWith('/api/') && p !== '/admin') return false;
    if (p.startsWith('/api/') && C.allowedOrigin) {
      res.setHeader('access-control-allow-origin', C.allowedOrigin); res.setHeader('vary', 'origin');
      res.setHeader('access-control-allow-headers', 'authorization,content-type,x-admin-token'); res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }
    }
    if (p === '/admin') { fs.readFile(path.join(__dirname, '..', 'public', 'admin.html'), (e, d) => { res.writeHead(e ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' }); res.end(e ? 'Not found' : d); }); return true; }

    // ----- חשבון -----
    if (p === '/api/account/register' && req.method === 'POST') {
      if (!rate('reg:' + ipOf(req), 6, 3600e3)) return json(res, 429, { error: 'too_many_requests' }), true;
      const b = await readJson(req, 20000) || {};
      const name = String(b.name || '').trim().slice(0, 80), email = String(b.email || '').trim().slice(0, 120), phone = String(b.phone || '').replace(/[^\d+]/g, '').slice(0, 16);
      if (name.length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'invalid_details' }), true;
      if (store.byEmail(email)) return json(res, 409, { error: 'email_exists' }), true;
      const { customer, token } = store.create({ name, email, phone, trialRuns: C.trialRuns });
      store.event('register', { id: customer.id, email });
      return json(res, 200, { token, account: pub(customer) }), true;
    }
    if (p === '/api/account/login' && req.method === 'POST') {
      if (!rate('login:' + ipOf(req), 20, 600e3)) return json(res, 429, { error: 'too_many_requests' }), true;
      const b = await readJson(req, 5000) || {}, c = store.byToken(String(b.token || '').trim());
      return c ? json(res, 200, { token: String(b.token).trim(), account: pub(c) }) : json(res, 401, { error: 'invalid_token' }), true;
    }
    if (p === '/api/account/me') { const c = auth(req); return c ? json(res, 200, { account: pub(c) }) : json(res, 401, { error: 'login_required' }), true; }

    // ----- תשלום -----
    if (p === '/api/billing/checkout' && req.method === 'POST') {
      const c = auth(req); if (!c) return json(res, 401, { error: 'login_required' }), true;
      const b = await readJson(req, 5000) || {}; const plan = b.plan === 'managed' ? 'managed' : b.plan === 'own' ? 'own' : null;
      if (!plan) return json(res, 400, { error: 'invalid_plan' }), true;
      if (!C.webhookSecret) return json(res, 501, { error: 'billing_not_configured' }), true;
      try {
        const r = await createCheckout(g, { customer: c, plan, sum: C.prices[plan], publicUrl: baseUrl(req), secret: C.webhookSecret });
        c.billing.pending = { plan, processId: r.processId, processToken: r.processToken, t: Date.now() }; store.event('checkout', { id: c.id, plan, manual: Boolean(r.manual) });
        return json(res, 200, { url: r.url, manual: Boolean(r.manual) }), true;
      } catch (e) { store.event('checkout_error', { id: c.id, message: String(e.message).slice(0, 300) }); return json(res, e.code === 'billing_not_configured' ? 501 : 502, { error: e.code || 'billing_error' }), true; }
    }
    if (p === '/api/billing/cancel-request' && req.method === 'POST') {
      const c = auth(req); if (!c) return json(res, 401, { error: 'login_required' }), true;
      c.cancelRequested = true; store.event('cancel_request', { id: c.id, email: c.email }); store.save(); return json(res, 200, { account: pub(c) }), true;
    }
    if (p === '/api/billing/webhook' && req.method === 'POST') {
      if (!C.webhookSecret || !eq(url.searchParams.get('s') || '', C.webhookSecret)) return json(res, 403, { error: 'forbidden' }), true;
      const raw = await readRaw(req, 500_000); const body = parseBody(raw || '', req.headers['content-type'] || '');
      const w = interpretWebhook(body);
      let c = store.get(url.searchParams.get('c') || '') || (w.customerId && store.get(w.customerId)) || (w.email && store.byEmail(w.email)) || null;
      store.event('webhook', { matched: c ? c.id : null, customerId: w.customerId, email: w.email, sum: w.sum, transactionId: w.transactionId, failed: w.failed, keys: Object.keys(w.flat).slice(0, 40) });
      if (c) {
        let plan = url.searchParams.get('p') || String(w.flat.cfield2 || '');
        if (!['own', 'managed'].includes(plan)) plan = w.sum >= C.prices.managed - 1 ? 'managed' : w.sum >= C.prices.own - 1 ? 'own' : (c.billing.pending && c.billing.pending.plan) || c.plan || 'own';
        if (w.failed) { c.billing.lastFailure = Date.now(); }
        else if (w.transactionId && c.billing.txIds.includes(w.transactionId)) { /* כפילות */ }
        else {
          c.plan = plan; c.paidUntil = Math.max(Date.now(), c.paidUntil || 0) + C.periodDays * 864e5;
          if (w.transactionId) c.billing.txIds = [...c.billing.txIds.slice(-24), w.transactionId];
          approveTransaction(g, plan, w.flat, c.billing.pending && c.billing.pending.processToken);
        }
        store.save();
      }
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('OK'); return true;
    }

    // ----- ניהול -----
    if (p.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return json(res, 401, { error: 'admin_required' }), true;
      if (p === '/api/admin/summary') {
        const all = store.all(), act = all.filter(c => state(c) === 'active'), m = month();
        const costUsd = all.reduce((s, c) => s + ((c.usage[m] || {}).costUsd || 0), 0);
        const mrr = act.reduce((s, c) => s + (C.prices[c.plan] || 0), 0);
        return json(res, 200, { customers: all.length, active: act.length, own: act.filter(c => c.plan === 'own').length, managed: act.filter(c => c.plan === 'managed').length, trial: all.filter(c => state(c) === 'trial').length, mrrIls: mrr, costUsd: +costUsd.toFixed(2), costIls: +(costUsd * C.usdIls).toFixed(2), month: m, note: 'ההכנסה כוללת מע"מ ועמלות סליקה. העלות היא הערכה לפי מחירון שמוגדר ב-PRICES_JSON.' }), true;
      }
      const row = c => { const tot = Object.values(c.usage).reduce((t, u) => ({ runs: t.runs + (u.runs || 0), cost: t.cost + (u.costUsd || 0) }), { runs: 0, cost: 0 }); return { ...pub(c), phone: c.phone, createdAt: c.createdAt, lastSeen: c.lastSeen || 0, tags: c.tags || [], note: (c.note || '').slice(0, 80), customLimit: c.customLimit || null, totalRuns: tot.runs, costUsdMonth: +(((c.usage[month()] || {}).costUsd) || 0).toFixed(3), costUsdTotal: +tot.cost.toFixed(3) }; };
      if (p === '/api/admin/customers') return json(res, 200, { customers: store.all().sort((a, b) => b.createdAt - a.createdAt).map(row), prices: C.prices }), true;
      if (p === '/api/admin/customer' && req.method === 'GET') {
        const c = store.get(url.searchParams.get('id')); if (!c) return json(res, 404, { error: 'not_found' }), true;
        const { tokenHash, ...rest } = c; return json(res, 200, { customer: { ...rest, ...row(c), usageMonths: c.usage }, events: store.db.events.filter(e => e.data && e.data.id === c.id).slice(-60).reverse() }), true;
      }
      if (p === '/api/admin/create' && req.method === 'POST') {
        const b = await readJson(req, 5000) || {}, name = String(b.name || '').trim().slice(0, 80), email = String(b.email || '').trim().slice(0, 120);
        if (name.length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'invalid_details' }), true;
        if (store.byEmail(email)) return json(res, 409, { error: 'email_exists' }), true;
        const { customer, token } = store.create({ name, email, phone: String(b.phone || '').replace(/[^\d+]/g, '').slice(0, 16), trialRuns: C.trialRuns });
        store.event('admin', { id: customer.id, action: 'create' }); return json(res, 200, { customer: row(customer), token }), true;
      }
      if (p === '/api/admin/export') {
        const q = v => '"' + String(v ?? '').replace(/"/g, '""') + '"', d = t => (t ? new Date(t).toISOString().slice(0, 10) : '');
        const lines = [['name', 'email', 'phone', 'plan', 'state', 'paid_until', 'created', 'last_seen', 'runs_total', 'cost_usd_total', 'tags', 'note'].join(',')];
        store.all().forEach(c => { const r = row(c); lines.push([r.name, r.email, r.phone, r.plan || '', r.state, d(r.paidUntil), d(r.createdAt), d(r.lastSeen), r.totalRuns, r.costUsdTotal, (r.tags || []).join(' '), c.note || ''].map(q).join(',')); });
        res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="customers.csv"' }); res.end('\ufeff' + lines.join('\n')); return true;
      }
      if (p === '/api/admin/setup') {
        const pu = baseUrl(req), has = k => Boolean(env[k]);
        const checks = [
          { ok: Boolean(C.serverKey), label: 'מפתח OpenAI של המערכת', env: 'OPENAI_API_KEY', help: 'נדרש למסלול 149 ולניסיון החינמי. אין API חינמי של OpenAI: פותחים חשבון ב-platform.openai.com, מטעינים יתרה קטנה ויוצרים מפתח. בלי זה עובדת רק ההדגמה.' },
          { ok: has('SUPABASE_URL') && has('SUPABASE_SERVICE_KEY'), label: 'אחסון קבוע ללקוחות (Supabase)', env: 'SUPABASE_URL, SUPABASE_SERVICE_KEY', help: 'בלי זה הלקוחות נמחקים בכל הפעלה מחדש של השרת, אלא אם יש דיסק קבוע.' },
          { ok: Boolean(C.publicUrl), label: 'כתובת ציבורית של השרת', env: 'PUBLIC_URL', help: 'נכנסת לקישורי החזרה מהתשלום ול-webhook.' },
          { ok: Boolean(g.userId && g.apiKey), label: 'חשבון GROW (userId ו-apiKey)', env: 'GROW_USER_ID, GROW_API_KEY', help: 'מתקבלים מ-GROW אחרי שפותחים חשבון סולק.' },
          { ok: Boolean(g.pages.own), label: 'דף תשלום חוזר ב-GROW: 99 ₪ (מפתח עצמי)', env: 'GROW_PAGECODE_OWN', help: 'יוצרים ב-GROW דף תשלום עם הוראת קבע חודשית ומעתיקים את ה-pageCode.' },
          { ok: Boolean(g.pages.managed), label: 'דף תשלום חוזר ב-GROW: 149 ₪ (מפתח המערכת)', env: 'GROW_PAGECODE_MANAGED', help: 'כמו הקודם, בסכום 149.' },
          { ok: Boolean(C.webhookSecret), label: 'סוד ל-webhook', env: 'GROW_WEBHOOK_SECRET', help: 'מחרוזת אקראית ארוכה שאת בוחרת. היא מגינה על כתובת ה-webhook.' },
          { ok: has('TERMS_URL'), label: 'קישור לתקנון ותנאי שימוש', env: 'TERMS_URL', help: 'מוצג ללקוח לפני תשלום. מומלץ מאוד לפני מכירה.' }
        ];
        return json(res, 200, { checks, webhookUrl: `${pu}/api/billing/webhook?s=${C.webhookSecret || '<GROW_WEBHOOK_SECRET>'}`, successUrl: `${pu}/?paid=1`, cancelUrl: `${pu}/?paid=0`, sandbox: env.GROW_SANDBOX === '1' }), true;
      }
      if (p === '/api/admin/check-openai' && !C.serverKey) return json(res, 200, { results: [{ name: 'מפתח OpenAI של המערכת', ok: false, detail: 'לא הוגדר OPENAI_API_KEY בשרת (ב-Render: Environment).' }] }), true;
      if (p === '/api/admin/check-openai') return json(res, 200, { results: await Engine.checkConn({ live: Boolean(C.serverKey), key: C.serverKey, model: C.model, base: C.base }) }), true;
      if (p === '/api/admin/events') return json(res, 200, { events: store.db.events.slice(-100).reverse() }), true;
      if (p === '/api/admin/customer' && req.method === 'POST') {
        const b = await readJson(req, 8000) || {}, c = store.get(b.id); if (!c) return json(res, 404, { error: 'not_found' }), true;
        let extra = {};
        if (b.action === 'activate') { c.plan = b.plan === 'managed' ? 'managed' : 'own'; c.paidUntil = Math.max(Date.now(), c.paidUntil || 0) + (num(b.days, C.periodDays)) * 864e5; c.cancelRequested = false; }
        else if (b.action === 'extend') { c.paidUntil = Math.max(Date.now(), c.paidUntil || 0) + num(b.days, 7) * 864e5; }
        else if (b.action === 'cancel') { c.paidUntil = Date.now() - C.graceDays * 864e5 - 1; }
        else if (b.action === 'trial') { c.trialRuns = num(b.value, 1); }
        else if (b.action === 'block') { c.blocked = Boolean(b.value); }
        else if (b.action === 'limit') { const v = num(b.value, 0); c.customLimit = v > 0 ? Math.min(v, 100000) : null; }
        else if (b.action === 'resetUsage') { delete c.usage[month()]; }
        else if (b.action === 'note') { c.note = String(b.value || '').slice(0, 2000); }
        else if (b.action === 'tags') { c.tags = (Array.isArray(b.value) ? b.value : String(b.value || '').split(/[,\s]+/)).map(t => String(t).trim().slice(0, 24)).filter(Boolean).slice(0, 12); }
        else if (b.action === 'edit') {
          const name = String(b.name || '').trim().slice(0, 80), email = String(b.email || '').trim().slice(0, 120);
          if (name.length < 2 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: 'invalid_details' }), true;
          const other = store.byEmail(email); if (other && other.id !== c.id) return json(res, 409, { error: 'email_exists' }), true;
          c.name = name; c.email = email.toLowerCase(); c.phone = String(b.phone || '').replace(/[^\d+]/g, '').slice(0, 16);
        }
        else if (b.action === 'newcode') { const t = 'crew_' + crypto.randomBytes(24).toString('hex'); c.tokenHash = store.hash(t); extra = { token: t }; }
        else if (b.action === 'delete') { delete store.db.customers[c.id]; store.event('admin', { id: c.id, action: 'delete', email: c.email }); store.save(); return json(res, 200, { deleted: true }), true; }
        else return json(res, 400, { error: 'invalid_action' }), true;
        store.event('admin', { id: c.id, action: b.action, plan: b.plan }); store.save(); return json(res, 200, { customer: row(c), ...extra }), true;
      }
      return json(res, 404, { error: 'not_found' }), true;
    }

    // ----- ריצות (בשרת, לפי הרשאות) -----
    if (p === '/api/run' && req.method === 'POST') {
      const brief = await readJson(req); if (!brief) return json(res, 413, { error: 'request too large' }), true;
      if (brief.demo === true) { await streamRun(res, { ...brief, apiKey: '' }, { live: false, key: '', model: C.model, base: C.base }); return true; }
      const c = auth(req); if (!c) return json(res, 401, { error: 'login_required' }), true;
      const ent = entitle(c, 'run'); if (!ent.ok) return json(res, 402, { error: ent.reason, account: pub(c) }), true;
      if (active.has(c.id)) return json(res, 429, { error: 'run_in_progress' }), true;
      let cfg;
      if (ent.mode === 'own') {
        const key = String(brief.apiKey || '').trim(); if (!key) return json(res, 400, { error: 'key_required' }), true;
        cfg = { live: true, key, model: String(brief.model || '').trim() || C.model, base: C.base };
      } else {
        if (!C.serverKey) return json(res, 503, { error: 'server_key_missing' }), true;
        cfg = { live: true, key: C.serverKey, model: C.model, base: C.base };
      }
      cfg.usage = { in: 0, out: 0, searches: 0, images: 0 }; cfg.maxToolCalls = ent.mode === 'own' ? 3 : 2;
      bump(c, ent.mode, 'run', +1); active.add(c.id);
      await streamRun(res, { ...brief, apiKey: '', model: '' }, cfg, { after: ({ finished, emit }) => {
        active.delete(c.id);
        if (finished) finish(c, ent.mode, cfg.usage, brief.task, true); else bump(c, ent.mode, 'run', -1);
        emit({ type: 'account', account: pub(c) });
      } });
      return true;
    }
    if (p === '/api/trends' && req.method === 'POST') {
      const brief = await readJson(req, 200000) || {};
      if (brief.demo === true) return json(res, 200, await Engine.trends(brief, io, { live: false })), true;
      const c = auth(req); if (!c) return json(res, 401, { error: 'login_required' }), true;
      const ent = entitle(c, 'radar'); if (!ent.ok) return json(res, 402, { error: ent.reason }), true;
      const key = ent.mode === 'own' ? String(brief.apiKey || '').trim() : C.serverKey; if (!key) return json(res, 400, { error: 'key_required' }), true;
      const cfg = { live: true, key, model: C.model, base: C.base, usage: { in: 0, out: 0, searches: 0, images: 0 }, maxToolCalls: 2 };
      bump(c, ent.mode, 'radar', +1);
      try { const out = await Engine.trends(brief, io, cfg); if (ent.mode !== 'own') { const u = usageOf(c); u.costUsd += costOf(cfg.usage); store.save(); } return json(res, 200, out), true; }
      catch (e) { bump(c, ent.mode, 'radar', -1); return json(res, 502, { error: String(e.message || e) }), true; }
    }
    if ((p === '/api/revise' || p === '/api/reimage') && req.method === 'POST') {
      const brief = await readJson(req, 200000) || {}, fn = p === '/api/revise' ? 'revise' : 'reimage';
      if (brief.demo === true) return json(res, 200, await Engine[fn](brief, io, { live: false })), true;
      const c = auth(req); if (!c) return json(res, 401, { error: 'login_required' }), true;
      const ent = entitle(c, 'edit'); if (!ent.ok) return json(res, 402, { error: ent.reason }), true;
      const key = ent.mode === 'own' ? String(brief.apiKey || '').trim() : C.serverKey; if (!key) return json(res, 400, { error: 'key_required' }), true;
      const cfg = { live: true, key, model: C.model, base: C.base, usage: { in: 0, out: 0, searches: 0, images: 0 } };
      const u = usageOf(c); u.edits += 1; store.save();
      try { const out = await Engine[fn](brief, io, cfg); if (ent.mode !== 'own') { u.costUsd += costOf(cfg.usage); u.images += cfg.usage.images || 0; u.tin += cfg.usage.in || 0; u.tout += cfg.usage.out || 0; store.save(); } return json(res, 200, out), true; }
      catch (e) { u.edits = Math.max(0, u.edits - 1); store.save(); return json(res, 502, { error: String(e.message || e) }), true; }
    }
    if (p === '/api/tts' && req.method === 'POST') {
      const brief = await readJson(req, 50000) || {}, c = auth(req);
      if (!c || state(c) !== 'active' || c.plan !== 'own') return json(res, 403, { error: 'tts_own_key_only' }), true;
      const key = String(brief.apiKey || '').trim(); if (!key) return json(res, 400, { error: 'key_required' }), true;
      try { const buf = Buffer.from(await Engine.tts({ live: true, key, base: C.base }, brief.text || '', { voice: brief.voice, model: brief.ttsModel })); res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.end(buf); }
      catch (e) { json(res, 502, { error: String(e.message || e) }); }
      return true;
    }
    return false;
  }

  return { ready: store.ready, handle, publicConfig, store, C, state, usageOf };
};
