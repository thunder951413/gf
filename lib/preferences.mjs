const DEFAULT_REPLY_PACE = 'natural';

export class PreferencesRepository {
  constructor(store) {
    this.store = store;
    this.db = store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS preferences (
        id INTEGER PRIMARY KEY CHECK(id=1),
        reply_pace TEXT NOT NULL CHECK(reply_pace IN ('natural', 'instant'))
      );
      CREATE TABLE IF NOT EXISTS role_avatars (
        role_id TEXT PRIMARY KEY,
        data_url TEXT NOT NULL
      );
    `);
    this.db.prepare('INSERT OR IGNORE INTO preferences(id, reply_pace) VALUES(1, ?)').run(DEFAULT_REPLY_PACE);
  }

  get() {
    const replyPace = this.getReplyPace();
    const avatars = Object.fromEntries(this.db.prepare('SELECT role_id, data_url FROM role_avatars ORDER BY role_id').all().map(row => [row.role_id, row.data_url]));
    return { replyPace, avatars };
  }

  getReplyPace() { return this.db.prepare('SELECT reply_pace FROM preferences WHERE id=1').get().reply_pace; }

  setReplyPace(replyPace) {
    this.db.prepare('UPDATE preferences SET reply_pace=? WHERE id=1').run(replyPace);
    return this.get();
  }

  setAvatar(roleId, avatar) {
    if (avatar === null) this.db.prepare('DELETE FROM role_avatars WHERE role_id=?').run(roleId);
    else this.db.prepare('INSERT INTO role_avatars(role_id,data_url) VALUES(?,?) ON CONFLICT(role_id) DO UPDATE SET data_url=excluded.data_url').run(roleId, avatar);
    return this.get();
  }
}
