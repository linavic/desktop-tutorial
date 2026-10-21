// חיבור ל-GROW (Meshulam). הקוד כאן נכתב לפי תיעוד חלקי: לא אומת מול ה-sandbox של GROW.
// יש לבדוק ב-sandbox לפני חיוב לקוחות אמיתיים (שמות פרמטרים, מבנה ה-webhook, ואישור עסקה).
const GROW_SANDBOX = 'https://sandbox.meshulam.co.il';
const GROW_PROD = 'https://secure.meshulam.co.il';

function growConfig(env) {
  return {
    base: env.GROW_BASE || (env.GROW_SANDBOX === '1' ? GROW_SANDBOX : GROW_PROD),
    userId: env.GROW_USER_ID || '', apiKey: env.GROW_API_KEY || '',
    pages: { own: env.GROW_PAGECODE_OWN || '', managed: env.GROW_PAGECODE_MANAGED || '' },
    links: { own: env.GROW_LINK_OWN || '', managed: env.GROW_LINK_MANAGED || '' },
    approve: env.GROW_APPROVE === '1'
  };
}

// יוצר תהליך תשלום (multipart/form-data, מהשרת בלבד). pageCode נפרד לכל מסלול, מוגדר ב-GROW כהוראת קבע חודשית.
async function createCheckout(g, { customer, plan, sum, publicUrl, secret }) {
  if (g.userId && g.pages[plan]) {
    const f = new FormData();
    const add = (k, v) => { if (v !== undefined && v !== null && v !== '') f.append(k, String(v)); };
    add('pageCode', g.pages[plan]); add('userId', g.userId); add('apiKey', g.apiKey);
    add('sum', sum); add('description', plan === 'own' ? 'מנוי חודשי: מסלול מפתח עצמי' : 'מנוי חודשי: מסלול מפתח המערכת');
    add('successUrl', `${publicUrl}/?paid=1`); add('cancelUrl', `${publicUrl}/?paid=0`);
    add('notifyUrl', `${publicUrl}/api/billing/webhook?s=${encodeURIComponent(secret)}&c=${customer.id}&p=${plan}`);
    add('pageField[fullName]', customer.name); add('pageField[email]', customer.email); add('pageField[phone]', customer.phone);
    add('cField1', customer.id); add('cField2', plan);
    const r = await fetch(g.base + '/api/light/server/1.0/createPaymentProcess', { method: 'POST', body: f });
    const j = await r.json().catch(() => ({}));
    const url = j?.data?.url || j?.url;
    if (!r.ok || !url) throw new Error('GROW createPaymentProcess: ' + JSON.stringify(j).slice(0, 240));
    return { url, processId: j?.data?.processId || j?.processId || null, processToken: j?.data?.processToken || j?.processToken || null };
  }
  if (g.links[plan]) return { url: g.links[plan], processId: null, manual: true };
  const e = new Error('billing_not_configured'); e.code = 'billing_not_configured'; throw e;
}

// אישור עסקה (לפי חלק מהתיעוד חובה, לפי אחר לא). רץ רק אם GROW_APPROVE=1, ולא חוסם אם נכשל.
async function approveTransaction(g, plan, flat, processToken) {
  if (!g.approve) return false;
  try {
    const f = new FormData();
    const add = (k, v) => { if (v) f.append(k, String(v)); };
    add('pageCode', g.pages[plan]); add('userId', g.userId); add('transactionId', flat.transactionid || flat.transactioncode); add('transactionToken', flat.transactiontoken); add('processId', flat.processid); add('processToken', processToken || flat.processtoken);
    const r = await fetch(g.base + '/api/light/server/1.0/approveTransaction', { method: 'POST', body: f });
    return r.ok;
  } catch { return false; }
}

// משטח אובייקט מקונן למפתחות באותיות קטנות (המפתח האחרון בכל נתיב, והנתיב המלא)
function flatten(o, out = {}, prefix = '') {
  if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) {
    const full = (prefix ? prefix + '.' : '') + k.toLowerCase();
    if (v && typeof v === 'object') flatten(v, out, full); else { out[full] = v; out[k.toLowerCase()] = v; }
  }
  return out;
}
const setDeep = (o, key, val) => { const parts = key.replace(/\]/g, '').split('['); let c = o; parts.forEach((p, i) => { if (i === parts.length - 1) c[p] = val; else c = c[p] = (c[p] && typeof c[p] === 'object') ? c[p] : {}; }); };

function parseBody(raw, ct = '') {
  if (/json/i.test(ct)) { try { return JSON.parse(raw); } catch { return {}; } }
  if (/multipart/i.test(ct)) {
    const b = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct); const o = {}; if (!b) return o;
    for (const part of raw.split('--' + (b[1] || b[2]))) { const m = /name="([^"]+)"\r?\n\r?\n([\s\S]*?)\r?\n?$/.exec(part.replace(/^\r?\n/, '')); if (m) setDeep(o, m[1], m[2].replace(/\r?\n$/, '')); }
    return o;
  }
  const o = {}; for (const [k, v] of new URLSearchParams(raw)) setDeep(o, k, v); return o;
}

// מנסה לחלץ מה-webhook: מי הלקוח, כמה שולם, ואם הצליח. מבנה ה-webhook של GROW לא אומת.
function interpretWebhook(body) {
  const flat = flatten(body);
  const vals = Object.values(flat).map(String);
  const customerId = vals.find(v => /^cus_[a-f0-9]{10}$/.test(v)) || null;
  const pick = re => { const k = Object.keys(flat).find(k => re.test(k.split('.').pop())); return k ? flat[k] : undefined; };
  const email = String(pick(/^(payeremail|email)$/) || '').toLowerCase();
  const sum = parseFloat(pick(/^(paymentsum|sum|fullsum|amount)$/)) || 0;
  const transactionId = String(pick(/^(transactionid|transactioncode|asmachta)$/) || '');
  const processId = String(pick(/^processid$/) || '');
  const st = String(pick(/^(status|success)$/) ?? '').toLowerCase();
  const failed = ['0', 'false', 'failed', 'fail', 'error'].includes(st) || Object.keys(flat).some(k => /(^|\.)(failure|failed)$/.test(k) && flat[k] && String(flat[k]) !== '0' && String(flat[k]) !== 'false') || (flat.err && String(flat.err).length > 0 && String(flat.err) !== '0');
  return { flat, customerId, email, sum, transactionId, processId, failed: Boolean(failed) };
}

module.exports = { growConfig, createCheckout, approveTransaction, parseBody, interpretWebhook };
