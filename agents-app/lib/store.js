// אחסון לקוחות בקובץ JSON (כתיבה אטומית). מתאים למאות לקוחות. דורש דיסק קבוע בשרת (DATA_DIR).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  // dir: אחסון בקובץ. אם מוגדרים SUPABASE_URL ו-SUPABASE_SERVICE_KEY, המסד נשמר בטבלה kv ב-Supabase (חינם, בלי דיסק).
  constructor(dir, remote) {
    this.remote = remote && remote.url && remote.key ? { url: String(remote.url).replace(/\/$/, ''), key: remote.key } : null;
    this.file = path.join(dir, 'db.json');
    this.db = { customers: {}, events: [] };
    if (!this.remote) { fs.mkdirSync(dir, { recursive: true }); try { this.db = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* חדש */ } }
    this._q = Promise.resolve();
    this.db.customers = this.db.customers || {}; this.db.events = this.db.events || [];
    this._t = null;
    const flush = () => { try { this.flush(); } catch { /* */ } };
    this.ready = this.init();
    process.on('exit', flush); const stop = () => Promise.resolve().then(() => this.flush()).catch(() => {}).finally(() => process.exit(0));
    process.on('SIGTERM', stop); process.on('SIGINT', stop);
  }
  _h() { return { apikey: this.remote.key, authorization: 'Bearer ' + this.remote.key, 'content-type': 'application/json' }; }
  async init() {
    if (!this.remote) return;
    const r = await fetch(`${this.remote.url}/rest/v1/kv?k=eq.db&select=v`, { headers: this._h() });
    if (!r.ok) throw new Error('Supabase: טעינה נכשלה (' + r.status + '). בדקו שהטבלה kv קיימת ושהמפתח נכון.');
    const rows = await r.json(); if (rows[0] && rows[0].v) this.db = rows[0].v;
    this.db.customers = this.db.customers || {}; this.db.events = this.db.events || [];
  }
  save() { clearTimeout(this._t); this._t = setTimeout(() => this.flush(), 150); }
  flush() {
    clearTimeout(this._t);
    if (this.remote) { const body = JSON.stringify({ k: 'db', v: this.db, updated_at: new Date().toISOString() }); this._q = this._q.then(() => fetch(`${this.remote.url}/rest/v1/kv?on_conflict=k`, { method: 'POST', headers: { ...this._h(), prefer: 'resolution=merge-duplicates' }, body }).then(r => { if (!r.ok) console.error('Supabase save failed', r.status); })).catch(e => console.error('Supabase save error', e.message)); return this._q; }
    const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.db)); fs.renameSync(tmp, this.file); }
  hash(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }
  create({ name, email, phone, trialRuns }) {
    const id = 'cus_' + crypto.randomBytes(5).toString('hex'), token = 'crew_' + crypto.randomBytes(24).toString('hex');
    const c = { id, name, email: email.toLowerCase(), phone: phone || '', tokenHash: this.hash(token), plan: null, paidUntil: 0, trialRuns, cancelRequested: false, createdAt: Date.now(), usage: {}, history: [], billing: { txIds: [] } };
    this.db.customers[id] = c; this.save(); return { customer: c, token };
  }
  all() { return Object.values(this.db.customers); }
  get(id) { return this.db.customers[id] || null; }
  byEmail(e) { e = String(e || '').toLowerCase(); return this.all().find(c => c.email === e) || null; }
  byToken(t) { if (!t) return null; const h = this.hash(t); return this.all().find(c => c.tokenHash === h) || null; }
  event(type, data) { this.db.events.push({ t: Date.now(), type, data }); if (this.db.events.length > 500) this.db.events.shift(); this.save(); }
}
module.exports = { Store };
