// שליחת SMS אימות. ספק נבחר ב-SMS_PROVIDER: twilio | webhook | dev.
// twilio: SMS_TWILIO_SID, SMS_TWILIO_TOKEN, ו-SMS_TWILIO_FROM (מספר) או SMS_TWILIO_SERVICE (Messaging Service SID).
// webhook: SMS_WEBHOOK_URL (+ SMS_WEBHOOK_TOKEN אופציונלי). השרת שולח POST JSON {to, text}. מתאים לכל ספק ישראלי דרך Make/Zapier/שרת קטן.
// dev: לא שולח, רק כותב ללוג (ורק עם SMS_DEV=1 מחזיר את הקוד לדפדפן). לבדיקות בלבד.
function smsConfig(env) {
  const provider = env.SMS_PROVIDER || (env.SMS_DEV === '1' ? 'dev' : '');
  return { provider, dev: env.SMS_DEV === '1', sid: env.SMS_TWILIO_SID || '', token: env.SMS_TWILIO_TOKEN || '', from: env.SMS_TWILIO_FROM || '', service: env.SMS_TWILIO_SERVICE || '', url: env.SMS_WEBHOOK_URL || '', wtoken: env.SMS_WEBHOOK_TOKEN || '', twilioBase: env.SMS_TWILIO_BASE || 'https://api.twilio.com' };
}
const smsReady = cfg => (cfg.provider === 'twilio' ? Boolean(cfg.sid && cfg.token && (cfg.from || cfg.service)) : cfg.provider === 'webhook' ? Boolean(cfg.url) : cfg.provider === 'dev');

async function sendSms(cfg, to, text) {
  if (cfg.provider === 'twilio') {
    const f = new URLSearchParams({ To: to, Body: text }); if (cfg.service) f.set('MessagingServiceSid', cfg.service); else f.set('From', cfg.from);
    const r = await fetch(`${cfg.twilioBase}/2010-04-01/Accounts/${encodeURIComponent(cfg.sid)}/Messages.json`, { method: 'POST', headers: { authorization: 'Basic ' + Buffer.from(cfg.sid + ':' + cfg.token).toString('base64'), 'content-type': 'application/x-www-form-urlencoded' }, body: f });
    if (!r.ok) throw new Error('Twilio ' + r.status + ': ' + (await r.text()).slice(0, 160));
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
