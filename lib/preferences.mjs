import {
  HISTORY_MAX_TOKENS_RANGE,
  HISTORY_WINDOW_DAYS_RANGE,
  HISTORY_WINDOW_DEFAULTS,
} from './dialogue-budget.mjs';

const DEFAULT_REPLY_PACE = 'natural';
const { days: DEFAULT_HISTORY_WINDOW_DAYS, maxTokens: DEFAULT_HISTORY_MAX_TOKENS } = HISTORY_WINDOW_DEFAULTS;

export { HISTORY_MAX_TOKENS_RANGE, HISTORY_WINDOW_DAYS_RANGE };

function invalidHistoryPreference(field, range) {
  const label = field === 'days' ? '对话窗口天数' : '对话 token 上限';
  const code = field === 'days' ? 'INVALID_HISTORY_WINDOW_DAYS' : 'INVALID_HISTORY_MAX_TOKENS';
  return Object.assign(new Error(`${label}须在 ${range.min}–${range.max} 之间`), { status: 400, code });
}

function validateHistoryPreference(value, field, range) {
  if (!Number.isSafeInteger(value) || value < range.min || value > range.max) throw invalidHistoryPreference(field, range);
}

export class PreferencesRepository {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS preferences (
        id INTEGER PRIMARY KEY CHECK(id=1),
        reply_pace TEXT NOT NULL CHECK(reply_pace IN ('natural', 'instant')),
        history_window_days INTEGER NOT NULL DEFAULT ${DEFAULT_HISTORY_WINDOW_DAYS},
        history_max_tokens INTEGER NOT NULL DEFAULT ${DEFAULT_HISTORY_MAX_TOKENS}
      );
      CREATE TABLE IF NOT EXISTS role_avatars (
        role_id TEXT PRIMARY KEY,
        data_url TEXT NOT NULL
      );
    `);
    // Existing databases created before the history window columns need an
    // idempotent migration; CREATE TABLE IF NOT EXISTS leaves them untouched.
    const columns = this.db.prepare('PRAGMA table_info(preferences)').all().map(row => row.name);
    if (!columns.includes('history_window_days')) this.db.exec(`ALTER TABLE preferences ADD COLUMN history_window_days INTEGER NOT NULL DEFAULT ${DEFAULT_HISTORY_WINDOW_DAYS}`);
    if (!columns.includes('history_max_tokens')) this.db.exec(`ALTER TABLE preferences ADD COLUMN history_max_tokens INTEGER NOT NULL DEFAULT ${DEFAULT_HISTORY_MAX_TOKENS}`);
    this.db.prepare('INSERT OR IGNORE INTO preferences(id, reply_pace) VALUES(1, ?)').run(DEFAULT_REPLY_PACE);
  }

  get() {
    const replyPace = this.getReplyPace();
    const { historyWindowDays, historyMaxTokens } = this.getHistoryWindow();
    const avatars = Object.fromEntries(this.db.prepare('SELECT role_id, data_url FROM role_avatars ORDER BY role_id').all().map(row => [row.role_id, row.data_url]));
    return { replyPace, avatars, historyWindowDays, historyMaxTokens };
  }

  getReplyPace() { return this.db.prepare('SELECT reply_pace FROM preferences WHERE id=1').get().reply_pace; }

  setReplyPace(replyPace) {
    this.db.prepare('UPDATE preferences SET reply_pace=? WHERE id=1').run(replyPace);
    return this.get();
  }

  getHistoryWindow() {
    const row = this.db.prepare('SELECT history_window_days, history_max_tokens FROM preferences WHERE id=1').get();
    return { historyWindowDays: row.history_window_days, historyMaxTokens: row.history_max_tokens };
  }

  setHistoryWindow({ days, maxTokens }) {
    // Validate the entire patch before writing. A request containing one valid
    // and one invalid field must never leave a partially updated preference.
    if (days !== undefined) validateHistoryPreference(days, 'days', HISTORY_WINDOW_DAYS_RANGE);
    if (maxTokens !== undefined) validateHistoryPreference(maxTokens, 'maxTokens', HISTORY_MAX_TOKENS_RANGE);

    const assignments = [];
    const values = [];
    if (days !== undefined) { assignments.push('history_window_days=?'); values.push(days); }
    if (maxTokens !== undefined) { assignments.push('history_max_tokens=?'); values.push(maxTokens); }
    if (assignments.length) this.db.prepare(`UPDATE preferences SET ${assignments.join(', ')} WHERE id=1`).run(...values);
    return this.get();
  }

  setAvatar(roleId, avatar) {
    if (avatar === null) this.db.prepare('DELETE FROM role_avatars WHERE role_id=?').run(roleId);
    else this.db.prepare('INSERT INTO role_avatars(role_id,data_url) VALUES(?,?) ON CONFLICT(role_id) DO UPDATE SET data_url=excluded.data_url').run(roleId, avatar);
    return this.get();
  }
}
