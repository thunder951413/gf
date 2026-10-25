import { randomBytes } from 'node:crypto';

// Things he is in the middle of, plans and open questions he mentioned
// (“用 AI 写重生炼丹小说”“改良自己的咖啡”), proposed once a day by the
// morning happenings call from his own day records. Each is worth one
// question a few days later; asking it, or him bringing it up first, closes it.
const DAY = 86400000;
const dayOf = at => new Date(+new Date(at) + 8 * 3600000).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const clip = (value, max) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);
// Unasked threads lapse a few days after they became due; old news is not a question.
const EXPIRE_DAYS = 4;
const MAX_OPEN = 12;

export function keywordHits(text, keywords = []) {
  const value = String(text || '');
  return keywords.filter(word => word && value.includes(word)).length;
}
// One distinctive word is enough when there is only one; otherwise two.
export function keywordMatch(text, keywords = [], { exclude = '' } = {}) {
  const usable = keywords.filter(word => word && !String(exclude || '').includes(word));
  if (!usable.length) return false;
  return keywordHits(text, usable) >= Math.min(2, usable.length);
}

export class UserThreads {
  constructor(store, { clock = () => new Date(), isSourceValid = () => true } = {}) {
    this.store = store; this.db = store.db; this.clock = clock; this.isSourceValid = isSourceValid;
    this.db.exec(`CREATE TABLE IF NOT EXISTS user_threads(id TEXT PRIMARY KEY,role_id TEXT NOT NULL,source_ref TEXT NOT NULL,source_day TEXT NOT NULL,source_text TEXT NOT NULL,
      text TEXT NOT NULL,keywords TEXT NOT NULL,ask_after TEXT NOT NULL,created_day TEXT NOT NULL,status TEXT NOT NULL,asked_at TEXT,asked_message_id TEXT,mode TEXT,UNIQUE(role_id,source_ref))`);
  }
  #map(row) {
    return row && { id: row.id, roleId: row.role_id, sourceRef: row.source_ref, sourceDay: row.source_day, sourceText: row.source_text, text: row.text,
      keywords: JSON.parse(row.keywords), askAfter: row.ask_after, createdDay: row.created_day, status: row.status, askedAt: row.asked_at, askedMessageId: row.asked_message_id, mode: row.mode };
  }
  list(roleId = 'miyue', { limit = 30 } = {}) {
    return this.db.prepare('SELECT * FROM user_threads WHERE role_id=? ORDER BY created_day DESC,rowid DESC LIMIT ?').all(roleId, limit).map(row => this.#map(row));
  }
  open(roleId = 'miyue') {
    return this.db.prepare("SELECT * FROM user_threads WHERE role_id=? AND status='open' ORDER BY ask_after,rowid").all(roleId).map(row => this.#map(row));
  }
  known(roleId = 'miyue') { return new Set(this.db.prepare('SELECT source_ref FROM user_threads WHERE role_id=?').all(roleId).map(row => row.source_ref)); }
  // Entries were validated by the caller against his own day records. The
  // caller's transaction covers these inserts together with the day record.
  add(roleId, entries = [], { now = this.clock() } = {}) {
    const today = dayOf(now), added = [];
    {
      for (const entry of entries) {
        if (this.db.prepare("SELECT COUNT(*) n FROM user_threads WHERE role_id=? AND status='open'").get(roleId).n >= MAX_OPEN) break;
        const days = Math.max(1, Math.min(3, Math.round(Number(entry.askAfterDays) || 1)));
        const askAfter = [addDays(entry.sourceDay, days), today].sort().at(-1);
        const id = `q${randomBytes(3).toString('hex')}`;
        const result = this.db.prepare('INSERT OR IGNORE INTO user_threads(id,role_id,source_ref,source_day,source_text,text,keywords,ask_after,created_day,status) VALUES(?,?,?,?,?,?,?,?,?,?)')
          .run(id, roleId, entry.sourceRef, entry.sourceDay, clip(entry.sourceText, 300), clip(entry.text, 60), JSON.stringify(entry.keywords || []), askAfter, today, 'open');
        if (result.changes) added.push(id);
      }
    }
    return added;
  }
  #expire(roleId, today) {
    this.db.prepare("UPDATE user_threads SET status='expired' WHERE role_id=? AND status='open' AND ask_after<?").run(roleId, addDays(today, -EXPIRE_DAYS));
  }
  // At most one a day: none once something was asked today.
  offer(roleId = 'miyue', { now = this.clock() } = {}) {
    const today = dayOf(now);
    this.#expire(roleId, today);
    const askedToday = this.db.prepare("SELECT asked_at FROM user_threads WHERE role_id=? AND status='asked' AND asked_at IS NOT NULL").all(roleId).some(row => dayOf(row.asked_at) === today);
    if (askedToday) return null;
    for (const thread of this.open(roleId)) {
      if (thread.askAfter > today) continue;
      // An edited or deleted source removes the record built from it.
      if (!this.isSourceValid(roleId, thread.sourceRef)) { this.db.prepare('DELETE FROM user_threads WHERE id=?').run(thread.id); continue; }
      return thread;
    }
    return null;
  }
  mark(id, { status = 'asked', messageId = null, mode = 'reply', now = this.clock() } = {}) {
    return this.db.prepare("UPDATE user_threads SET status=?,asked_at=?,asked_message_id=?,mode=? WHERE id=? AND status='open'")
      .run(status, new Date(now).toISOString(), messageId, mode, id).changes > 0;
  }
  // He brought it up himself: nothing left to ask about.
  observeUser(roleId, text, messageId, { now = this.clock() } = {}) {
    const closed = [];
    for (const thread of this.open(roleId)) if (keywordMatch(text, thread.keywords) && this.mark(thread.id, { status: 'mentioned', messageId, mode: 'user', now })) closed.push(thread.id);
    return closed;
  }
}
