import { mentionedSources } from './source-mentions.mjs';
import { companionSourceInternals } from './companion-sources.mjs';

const { canonicalUrl, normalizedTitle } = companionSourceInternals;
const MONTH = 30 * 86400_000;

// Shared by chat, scheduled life openings and desktop invitations. Receipts
// follow committed messages, not the scheduler's changing opportunity keys.
export class CompanionSourceHistory {
  constructor(store, { clock = () => new Date() } = {}) {
    this.store = store; this.db = store.db; this.clock = clock;
    this.db.exec(`CREATE TABLE IF NOT EXISTS companion_source_deliveries (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      content_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
      PRIMARY KEY(message_id, content_id)
    )`);
  }
  recent(roleId = 'miyue') {
    return this.db.prepare(`SELECT d.content_id AS id, d.title, d.url
      FROM companion_source_deliveries d JOIN messages m ON m.id=d.message_id
      WHERE m.role=? AND m.created_at>=? ORDER BY m.rowid DESC LIMIT 300`)
      .all(roleId, new Date(+this.clock() - MONTH).toISOString());
  }
  excludedIds(items, roleId = 'miyue') {
    const recent = this.recent(roleId);
    const ids = new Set(recent.map(x => x.id)), urls = new Set(recent.map(x => canonicalUrl(x.url))), titles = new Set(recent.map(x => normalizedTitle(x.title)));
    return items.filter(x => ids.has(x.id) || urls.has(canonicalUrl(x.url)) || titles.has(normalizedTitle(x.title))).map(x => x.id);
  }
  repeated(text, roleId = 'miyue') { return mentionedSources(text, this.recent(roleId)); }
  record(message, items) {
    if (message.speaker !== 'assistant' || message.role !== 'miyue') return [];
    const matched = mentionedSources(message.text, items);
    const contentId=message.contentId || message.content_id || this.db.prepare('SELECT content_id FROM messages WHERE id=?').get(message.id)?.content_id;
    const explicit = items.find(x => x.id === contentId);
    if (explicit && !matched.some(x => x.id === explicit.id)) matched.unshift(explicit);
    const insert = this.db.prepare('INSERT OR IGNORE INTO companion_source_deliveries(message_id,content_id,title,url) VALUES(?,?,?,?)');
    for (const item of matched) insert.run(message.id, item.id, item.title, item.url);
    const first = matched[0];
    if (first) {
      this.db.prepare('UPDATE messages SET content_id=? WHERE id=? AND content_id IS NULL').run(first.id, message.id);
      this.db.prepare(`UPDATE proactive_events SET content_id=?,source_title=?,source_url=?,article_title=?,source_id=?
        WHERE message_id=? AND content_id IS NULL`).run(first.id, first.source || null, first.url, first.title, first.feedId || null, message.id);
    }
    return matched;
  }
  backfill() {
    const items = this.store.listContent();
    // Bounded recovery for legacy replies which omitted contentId; no chat text
    // is rewritten and duplicate historic messages remain visible as evidence.
    const rows = this.db.prepare("SELECT * FROM messages WHERE role='miyue' AND speaker='assistant' AND created_at>=? ORDER BY rowid DESC LIMIT 300")
      .all(new Date(+this.clock() - MONTH).toISOString());
    this.store.transaction(() => { for (const row of rows) this.record(row, items); });
  }
}
