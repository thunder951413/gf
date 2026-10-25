// Where the chat starts (2026-10-25): messages before this point are archived
// — still stored, still exportable and deletable, but not shown by default
// and not read back to her as raw words. Distilled records are unaffected.
const KEY = 'chat_display_since';

export function chatDisplaySince(db) {
  try { const value = JSON.parse(db.prepare('SELECT value FROM metadata WHERE key=?').get(KEY)?.value || 'null'); return typeof value?.since === 'string' ? value.since : null; }
  catch { return null; }
}

export function setChatDisplaySince(db, since, { now = new Date() } = {}) {
  const value = since === 'now' ? new Date(now).toISOString() : since === null ? null : new Date(since);
  if (value instanceof Date && Number.isNaN(value.valueOf())) throw Object.assign(new Error('时间格式无效'), { status: 400, code: 'INVALID_DISPLAY_SINCE' });
  const iso = value instanceof Date ? value.toISOString() : value;
  db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, JSON.stringify({ since: iso, changedAt: new Date(now).toISOString() }));
  return iso;
}

export const afterDisplayCut = (db, rows = []) => {
  const since = chatDisplaySince(db);
  return since ? rows.filter(row => String(row.createdAt ?? row.created_at ?? '') >= since) : rows;
};
