// שליחת SMS אימות. ספק נבחר ב-SMS_PROVIDER: twilio | webhook | dev.
// twilio: SMS_TWILIO_SID, SMS_TWILIO_TOKEN, ו-SMS_TWILIO_FROM (מספר) או SMS_TWILIO_SERVICE (Messaging Service SID).
// webhook: SMS_WEBHOOK_URL (+ SMS_WEBHOOK_TOKEN אופציונלי). השרת שולח POST JSON {to, text}. מתאים לכל ספק ישראלי דרך Make/Zapier/שרת קטן.
// sms019 (מומלץ, התיעוד: docs.019sms.co.il/otp): SMS019_USERNAME, SMS019_TOKEN (נוצר באתר: הגדרות > ניהול טוקן API), SMS019_SOURCE (מספר או שם השולח, חייב להיות מאומת אצלם). SMS019_TEST=1 שולח ל-/api/test (בודק תקינות בלי לשלוח בפועל).
// sms4free: SMS4FREE_USER (מספר הנייד שנרשם), SMS4FREE_PASS, SMS4FREE_KEY, SMS4FREE_SENDER (ברירת מחדל: ה-user; שם באנגלית דורש רכישת חבילה), SMS4FREE_URL אופציונלי.
//   שמות השדות (key, user, pass, sender, recipient, msg) מבוססים על התיעוד הציבורי החלקי. לא נבדק מול השרת האמיתי: אם הספק דוחה, התשובה שלו נרשמת ביומן האירועים ב-/admin (sms_error).
// dev: לא שולח, רק כותב ללוג (ורק עם SMS_DEV=1 מחזיר את הקוד לדפדפן). לבדיקות בלבד.
function smsConfig(env) {
  const provider = env.SMS_PROVIDER || (env.SMS_DEV === '1' ? 'dev' : '');
  return { provider, dev: env.SMS_DEV === '1', sid: env.SMS_TWILIO_SID || '', token: env.SMS_TWILIO_TOKEN || '', from: env.SMS_TWILIO_FROM || '', service: env.SMS_TWILIO_SERVICE || '', url: env.SMS_WEBHOOK_URL || '', s019: { url: env.SMS019_URL || (env.SMS019_TEST === '1' ? 'https://019sms.co.il/api/test' : 'https://019sms.co.il/api'), username: env.SMS019_USERNAME || '', token: env.SMS019_TOKEN || '', source: env.SMS019_SOURCE || '' }, s4f: { url: env.SMS4FREE_URL || 'https://api.sms4free.co.il/ApiSMS/v2/SendSMS', user: env.SMS4FREE_USER || '', pass: env.SMS4FREE_PASS || '', key: env.SMS4FREE_KEY || '', sender: env.SMS4FREE_SENDER || env.SMS4FREE_USER || '' }, wtoken: env.SMS_WEBHOOK_TOKEN || '', twilioBase: env.SMS_TWILIO_BASE || 'https://api.twilio.com' };
}
const smsReady = cfg => (cfg.provider === 'twilio' ? Boolean(cfg.sid && cfg.token && (cfg.from || cfg.service)) : cfg.provider === 'sms019' ? Boolean(cfg.s019.username && cfg.s019.token && cfg.s019.source) : cfg.provider === 'sms4free' ? Boolean(cfg.s4f.user && cfg.s4f.pass && cfg.s4f.key) : cfg.provider === 'webhook' ? Boolean(cfg.url) : cfg.provider === 'dev');

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
// שולח קוד אימות. אצל 019 הקוד נוצר אצלם ומוחזר בתשובה; אצל שאר הספקים הקוד נוצר אצלנו (ownCode). מחזיר את הקוד ששלח.
const S019_ERR = { 3: 'שם משתמש או טוקן שגויים', 4: 'אין יתרה בחשבון', 5: 'אין הרשאה לשלוח בשעה הזו', 8: 'המספר חסום', 9: 'מספר טלפון קצר או ארוך מדי', 10: 'הטוקן פג תוקף', 11: 'הטוקן לא תואם לשם המשתמש', 515: 'השולח (source) לא מאומת אצל 019', 992: 'ה-source קצר או ארוך מדי', 503: 'שם המשתמש לא קיים' };
async function sendOtp(cfg, to, textTpl, ownCode, opts = {}) {
  if (cfg.provider === 'sms019') {
    const c = cfg.s019, local = String(to).replace(/^\+972/, '0');
    const r = await fetch(c.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + c.token }, body: JSON.stringify({ send_otp: { user: { username: c.username }, phone: local, app_id: '1', source: c.source, max_tries: String(opts.maxTries || 5), valid_time: String(opts.validMinutes || 10), text: textTpl } }) });
    const raw = (await r.text()).slice(0, 400); let j = {}; try { j = JSON.parse(raw); } catch { /* לא JSON */ }
    if (!r.ok || Number(j.status) !== 0) throw new Error(`019sms ${r.status}: status ${j.status ?? '?'} ${S019_ERR[j.status] || j.message || raw}`.slice(0, 300));
    const code = String(j.code || ''); if (!/^\d{4,8}$/.test(code)) { if (c.url.endsWith('/test')) return ownCode; throw new Error('019sms: לא הוחזר קוד'); }
    return code;
  }
  await sendSms(cfg, to, textTpl.replace('[code]', ownCode)); return ownCode;
}

function normalizePhone(raw) {
  let d = String(raw || '').replace(/[^\d+]/g, '');
  if (d.startsWith('00')) d = '+' + d.slice(2);
  if (d.startsWith('+')) return /^\+\d{8,15}$/.test(d) ? d : '';
  if (d.startsWith('972')) d = '+' + d; else if (d.startsWith('0')) d = '+972' + d.slice(1); else return '';
  return /^\+9725\d{8}$/.test(d) ? d : '';
}
module.exports = { smsConfig, smsReady, sendSms, sendOtp, normalizePhone };
