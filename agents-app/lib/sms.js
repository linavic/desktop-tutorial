// שליחת SMS אימות. ספק נבחר ב-SMS_PROVIDER: twilio | webhook | dev.
// twilio: SMS_TWILIO_SID, SMS_TWILIO_TOKEN, ו-SMS_TWILIO_FROM (מספר) או SMS_TWILIO_SERVICE (Messaging Service SID).
// webhook: SMS_WEBHOOK_URL (+ SMS_WEBHOOK_TOKEN אופציונלי). השרת שולח POST JSON {to, text}. מתאים לכל ספק ישראלי דרך Make/Zapier/שרת קטן.
// sms4free: SMS4FREE_USER (מספר הנייד שנרשם), SMS4FREE_PASS, SMS4FREE_KEY, SMS4FREE_SENDER (ברירת מחדל: ה-user; שם באנגלית דורש רכישת חבילה), SMS4FREE_URL אופציונלי.
//   שמות השדות (key, user, pass, sender, recipient, msg) מבוססים על התיעוד הציבורי החלקי. לא נבדק מול השרת האמיתי: אם הספק דוחה, התשובה שלו נרשמת ביומן האירועים ב-/admin (sms_error).
// dev: לא שולח, רק כותב ללוג (ורק עם SMS_DEV=1 מחזיר את הקוד לדפדפן). לבדיקות בלבד.
function smsConfig(env) {
  const provider = env.SMS_PROVIDER || (env.SMS_DEV === '1' ? 'dev' : '');
  return { provider, dev: env.SMS_DEV === '1', sid: env.SMS_TWILIO_SID || '', token: env.SMS_TWILIO_TOKEN || '', from: env.SMS_TWILIO_FROM || '', service: env.SMS_TWILIO_SERVICE || '', url: env.SMS_WEBHOOK_URL || '', s4f: { url: env.SMS4FREE_URL || 'https://api.sms4free.co.il/ApiSMS/v2/SendSMS', user: env.SMS4FREE_USER || '', pass: env.SMS4FREE_PASS || '', key: env.SMS4FREE_KEY || '', sender: env.SMS4FREE_SENDER || env.SMS4FREE_USER || '' }, wtoken: env.SMS_WEBHOOK_TOKEN || '', twilioBase: env.SMS_TWILIO_BASE || 'https://api.twilio.com' };
}
const smsReady = cfg => (cfg.provider === 'twilio' ? Boolean(cfg.sid && cfg.token && (cfg.from || cfg.service)) : cfg.provider === 'sms4free' ? Boolean(cfg.s4f.user && cfg.s4f.pass && cfg.s4f.key) : cfg.provider === 'webhook' ? Boolean(cfg.url) : cfg.provider === 'dev');

async function sendSms(cfg, to, text) {
  if (cfg.provider === 'twilio') {
    const f = new URLSearchParams({ To: to, Body: text }); if (cfg.service) f.set('MessagingServiceSid', cfg.service); else f.set('From', cfg.from);
    const r = await fetch(`${cfg.twilioBase}/2010-04-01/Accounts/${encodeURIComponent(cfg.sid)}/Messages.json`, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(cfg.sid + ':' + cfg.token).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: f });
    if (!r.ok) throw new Error('Twilio ' + r.status + ': ' + (await r.text()).slice(0, 160));
    return;
  }
  if (cfg.provider === 'sms4free') {
    const c = cfg.s4f, local = String(to).replace(/^\+972/, '0');
    const r = await fetch(c.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: c.key, user: c.user, pass: c.pass, sender: c.sender, recipient: local, msg: text }) });
    const raw = (await r.text()).slice(0, 300); let j; try { j = JSON.parse(raw); } catch { j = raw.trim(); }
    const n = typeof j === 'number' ? j : Number(typeof j === 'object' && j ? (j.status ?? j.Status ?? j.result ?? j.Result ?? j.success) : j);
    const ok = r.ok && (n > 0 || (typeof j === 'object' && j && (j.success === true || j.Success === true)));
    if (!ok) throw new Error('SMS4Free ' + r.status + ': ' + raw);
    return;
  }
  if (cfg.provider === 'webhook') {
    const r = await fetch(cfg.url, { method: 'POST', headers: { 'content-type': 'application/json', ...(cfg.wtoken ? { authorization: 'Bearer ' + cfg.wtoken } : {}) }, body: JSON.stringify({ to, text }) });
    if (!r.ok) throw new Error('SMS webhook ' + r.status);
    return;
  }
  if (cfg.provider === 'dev') { console.log(`[SMS dev] ${to}: ${text}`); return; }
  throw new Error('sms_not_configured');
}

// מספר נייד ישראלי (05x...) או בינלאומי עם + לפורמט E.164
function normalizePhone(raw) {
  let d = String(raw || '').replace(/[^\d+]/g, '');
  if (d.startsWith('00')) d = '+' + d.slice(2);
  if (d.startsWith('+')) return /^\+\d{8,15}$/.test(d) ? d : '';
  if (d.startsWith('972')) d = '+' + d; else if (d.startsWith('0')) d = '+972' + d.slice(1); else return '';
  return /^\+9725\d{8}$/.test(d) ? d : '';
}
module.exports = { smsConfig, smsReady, sendSms, normalizePhone };
