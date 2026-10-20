// אחסון לקוחות בקובץ JSON (כתיבה אטומית). מתאים למאות לקוחות. דורש דיסק קבוע בשרת (DATA_DIR).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class Store {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, 'db.json');
    this.db = { customers: {}, events: [] };
    try { this.db = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { /* חדש */ }
    this.db.customers = this.db.customers || {}; this.db.events = this.db.events || [];
    this._t = null;
    const flush = () => { try { this.flush(); } catch { /* */ } };
    process.on('exit', flush); process.on('SIGTERM', () => { flush(); process.exit(0); }); process.on('SIGINT', () => { flush(); process.exit(0); });
  }
  save() { clearTimeout(this._t); this._t = setTimeout(() => this.flush(), 150); }
  flush() { clearTimeout(this._t); const tmp = this.file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(this.db)); fs.renameSync(tmp, this.file); }
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
