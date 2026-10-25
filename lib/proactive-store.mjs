import { randomUUID, createHash } from 'node:crypto';
import { MAX_UNANSWERED_MESSAGES } from './store.mjs';

export const PROACTIVE_DEFAULTS = Object.freeze({
  enabled: true, fetchIntervalMinutes: 120, minGapMinutes: 60, maxGapMinutes: 120,
  dailyLimit: 24, activeStart: '09:00', activeEnd: '23:00',
  topics: '时事,科技,知识,文化,关系', notifications: false, desktopNotifications: true,
});
const EMPTY_RUNTIME = { nextFetchAt: null, nextContactAt: null, lastFetchAt: null, lastContactAt: null, lastDecisionAt: null, lastReason: '正在准备下一次联系', lastError: null };
const ROLES = ['zhixia', 'wenxi', 'miyue'];
const clockTime = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
export function localDayStart(at) { const d = new Date(at); d.setHours(0, 0, 0, 0); return d.toISOString(); }
export function inActiveWindow(at, settings) {
  const minute = at.getHours() * 60 + at.getMinutes();
  const minutes = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = minutes(settings.activeStart), end = minutes(settings.activeEnd);
  return start < end ? minute >= start && minute < end : minute >= start || minute < end;
}
function invalid(message) { return Object.assign(new Error(message), { status: 400, code: 'INVALID_PROACTIVE_SETTINGS' }); }
export function validateProactiveSettings(previous, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('主动陪伴设置格式无效');
  if (Object.keys(patch).some(key => !(key in PROACTIVE_DEFAULTS))) throw invalid('包含不支持的主动陪伴设置');
  const result = { ...previous, ...patch };
  for (const key of ['enabled', 'notifications', 'desktopNotifications']) if (typeof result[key] !== 'boolean') throw invalid('开关设置必须为开启或关闭');
  for (const [key, min, max] of [['fetchIntervalMinutes', 15, 1440], ['minGapMinutes', 60, 1440], ['maxGapMinutes', 60, 2880], ['dailyLimit', 1, 24]]) {
    if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) throw invalid(`${key} 超出允许范围`);
  }
  if (result.maxGapMinutes < result.minGapMinutes) throw invalid('最长间隔不能小于最短间隔');
  if (!clockTime(result.activeStart) || !clockTime(result.activeEnd) || result.activeStart === result.activeEnd) throw invalid('联系时段需要两个不同的有效时间');
  if (typeof result.topics !== 'string' || result.topics.length > 500) throw invalid('兴趣主题最多填写 500 个字符');
  result.topics = result.topics.trim(); return result;
}
function normalizedTitle(title) { return String(title || '').normalize('NFKC').toLowerCase().replace(/[\p{P}\p{Z}\p{S}\s]/gu, '').slice(0, 180); }
function canonicalUrl(value) {
  try { const url = new URL(value); url.hash = ''; for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$)/i.test(key)) url.searchParams.delete(key); url.searchParams.sort(); return url.href.replace(/\/$/, ''); }
  catch { return String(value || ''); }
}
const eventMetadata = row => row ? { sourceTitle: row.source_title || undefined, sourceUrl: row.source_url || undefined, proactiveReason: row.reason, proactiveKind: row.kind } : {};

export class ProactiveRepository {
  constructor(store, { feedCatalog = [], clock = () => new Date() } = {}) {
    this.store = store; this.db = store.db; this.clock = clock; this.feedCatalog = feedCatalog;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS proactive_events (
        id TEXT PRIMARY KEY, role TEXT NOT NULL, kind TEXT NOT NULL, content_id TEXT,
        message_id TEXT NOT NULL UNIQUE, topic_key TEXT NOT NULL UNIQUE, reason TEXT NOT NULL,
        source_title TEXT, source_url TEXT, article_title TEXT, source_id TEXT,
        created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'delivered', feedback TEXT
      );
      CREATE INDEX IF NOT EXISTS proactive_created ON proactive_events(created_at);
      CREATE TABLE IF NOT EXISTS proactive_attempts (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proactive_leases (name TEXT PRIMARY KEY, token TEXT NOT NULL, until_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_reads (role TEXT PRIMARY KEY, last_rowid INTEGER NOT NULL DEFAULT 0);
    `);
    if (!this.db.prepare('PRAGMA table_info(proactive_events)').all().some(c => c.name === 'source_research')) this.db.exec('ALTER TABLE proactive_events ADD COLUMN source_research TEXT');
    this.putIfAbsent('proactive_settings', PROACTIVE_DEFAULTS); this.putIfAbsent('proactive_runtime', EMPTY_RUNTIME);
    // 2026-10-25 cadence: no daily quota beyond a safety limit, at least an hour between contacts.
    if (!this.read('proactive_cadence_v1', false)) {
      const old = this.getSettings(), minGapMinutes = Math.max(60, old.minGapMinutes);
      this.write('proactive_settings', { ...old, minGapMinutes, maxGapMinutes: old.maxGapMinutes >= minGapMinutes ? old.maxGapMinutes : 120, dailyLimit: 24 });
      this.write('proactive_cadence_v1', true);
    }
    store.proactiveRepo = this;
  }
  read(key, fallback) { try { return JSON.parse(this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)?.value || 'null') || fallback; } catch { return fallback; } }
  write(key, value) { this.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); return value; }
  putIfAbsent(key, value) { this.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)').run(key, JSON.stringify(value)); }
  getSettings() { return { ...PROACTIVE_DEFAULTS, ...this.read('proactive_settings', {}) }; }
  saveSettings(patch) {
    const settings = validateProactiveSettings(this.getSettings(), patch);
    this.write('proactive_settings', settings);
    const at = this.clock();
    if ('fetchIntervalMinutes' in patch) this.updateRuntime({ nextFetchAt: new Date(at.valueOf() + settings.fetchIntervalMinutes * 60_000).toISOString() });
    if ('minGapMinutes' in patch || 'maxGapMinutes' in patch) this.updateRuntime({ nextContactAt: new Date(at.valueOf() + settings.minGapMinutes * 60_000).toISOString() });
    return settings;
  }
  getRuntime() {
    const runtime = { ...EMPTY_RUNTIME, ...this.read('proactive_runtime', {}) };
    const latest = this.db.prepare("SELECT MAX(created_at) AS at FROM messages WHERE kind IN ('proactive','reminder','session_reminder') AND speaker='assistant'").get().at;
    if (latest && (!runtime.lastContactAt || latest > runtime.lastContactAt)) runtime.lastContactAt = latest;
    return runtime;
  }
  updateRuntime(patch) { return this.write('proactive_runtime', { ...this.getRuntime(), ...patch }); }
  getQuiet() { return this.store.getSettings().quiet; }
  getLastUserAt() { return this.db.prepare("SELECT MAX(created_at) AS at FROM messages WHERE speaker='user' AND kind='chat'").get().at || null; }
  getLastMessageId(role) { return this.db.prepare('SELECT id FROM messages WHERE role=? ORDER BY rowid DESC LIMIT 1').get(role)?.id || null; }
  getLastUnansweredAssistantAt(role) {
    const latest = this.db.prepare('SELECT speaker,created_at FROM messages WHERE role=? ORDER BY rowid DESC LIMIT 1').get(role);
    return latest?.speaker === 'assistant' ? latest.created_at : null;
  }
  countContactsSince(iso) { return Number(this.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind IN ('proactive','reminder') AND speaker='assistant' AND created_at>=?").get(iso).n); }
  countAttemptsSince(iso) { return Number(this.db.prepare('SELECT COUNT(*) AS n FROM proactive_attempts WHERE created_at>=?').get(iso).n); }
  recordAttempt(at) { this.db.prepare('INSERT INTO proactive_attempts(id,created_at) VALUES(?,?)').run(randomUUID(), at); }
  unansweredCount(role) { return this.store.unansweredAssistantCount(role); }
  getCandidates() {
    const since = new Date(this.clock().valueOf() - 30 * 86400_000).toISOString();
    const events = this.db.prepare('SELECT * FROM proactive_events WHERE created_at>=? ORDER BY created_at DESC,rowid DESC').all(since);
    const usedUrls = new Set(events.filter(e => e.source_url).map(e => canonicalUrl(e.source_url)));
    const usedTitles = new Set(events.filter(e => e.article_title).map(e => normalizedTitle(e.article_title)));
    const feedFeedback = new Map();
    for (const e of events) if (e.source_id && e.feedback && !feedFeedback.has(e.source_id)) feedFeedback.set(e.source_id, e.feedback);
    const feeds = new Map(this.store.listFeeds().map(f => [f.id, f]));
    return this.store.listContent().slice(0, 500).map(item => {
      const catalog = this.feedCatalog.find(f => f.url === feeds.get(item.feedId)?.url);
      return {
      ...item, category: catalog?.category || '综合',
      // Optional per-feed share from app-data/feeds.json ("weight", default 1).
      feedWeight: Number.isFinite(Number(catalog?.weight)) && Number(catalog.weight) > 0 ? Number(catalog.weight) : 1,
      dislikedSource: feedFeedback.get(item.feedId) === 'less',
      used: usedUrls.has(canonicalUrl(item.url)) || (normalizedTitle(item.title) && usedTitles.has(normalizedTitle(item.title))),
    };});
  }
  getRecentContacts(limit = 10) { return this.db.prepare('SELECT role,kind,content_id,created_at FROM proactive_events ORDER BY rowid DESC LIMIT ?').all(limit).map(e => ({ role: e.role, kind: e.kind, contentId: e.content_id, createdAt: e.created_at })); }
  getMemories(role) { return this.store.listMemories(role); }
  getConversation(role, limit = 20) { return this.store.getMessages(role, limit); }
  getStory() { return this.store.getStory(); }
  acquireLease(name, nowIso, untilIso) {
    return this.store.transaction(() => {
      const row = this.db.prepare('SELECT * FROM proactive_leases WHERE name=?').get(name);
      if (row && row.until_at > nowIso) return null;
      const token = randomUUID(); this.db.prepare('INSERT INTO proactive_leases(name,token,until_at) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET token=excluded.token,until_at=excluded.until_at').run(name, token, untilIso); return token;
    });
  }
  releaseLease(name, token) { this.db.prepare('DELETE FROM proactive_leases WHERE name=? AND token=?').run(name, token); }
  commitDelivery({ role, text, kind, contentId, reason, topicKey, createdAt, nextContactAt, expectedLastMessageId, unansweredCooldownMinutes = 0, afterSave }) {
    return this.store.transaction(() => {
      const settings = this.getSettings(), at = new Date(createdAt);
      if (!settings.enabled || this.getQuiet() || !inActiveWindow(at, settings) || this.countContactsSince(localDayStart(at)) >= settings.dailyLimit) return null;
      if (this.unansweredCount(role) >= MAX_UNANSWERED_MESSAGES) return null;
      if (unansweredCooldownMinutes > 0) {
        const unansweredAt = this.getLastUnansweredAssistantAt(role);
        if (unansweredAt && at < new Date(new Date(unansweredAt).valueOf() + unansweredCooldownMinutes * 60_000)) return null;
      }
      if (this.getLastMessageId(role) !== (expectedLastMessageId || null)) return null;
      if (!ROLES.includes(role) || !['content', 'continuation', 'story', 'life', 'followup'].includes(kind) || !text?.trim()) return null;
      const content = contentId ? this.store.getContent(contentId) : null;
      if (kind === 'content' && !content) return null;
      if (content) {
        const key = normalizedTitle(content.title), url = canonicalUrl(content.url);
        const past = this.db.prepare('SELECT source_url,article_title FROM proactive_events WHERE created_at>=?').all(new Date(at.valueOf() - 30 * 86400_000).toISOString());
        if (past.some(e => (e.source_url && canonicalUrl(e.source_url) === url) || (key && normalizedTitle(e.article_title) === key))) return null;
      }
      // A source ID can differ across feeds; deduplication above uses both URL and title.
      const stableKey = content && kind !== 'life' ? `article:${createHash('sha256').update(canonicalUrl(content.url)).digest('hex')}` : topicKey;
      if (!stableKey || this.db.prepare('SELECT id FROM proactive_events WHERE topic_key=?').get(stableKey)) return null;
      const messageId = randomUUID();
      this.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,content_id,created_at) VALUES(?,?,?,?,?,?,?)').run(messageId, role, 'assistant', text.trim(), 'proactive', contentId || null, createdAt);
      this.db.prepare('INSERT INTO proactive_events(id,role,kind,content_id,message_id,topic_key,reason,source_title,source_url,article_title,source_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), role, kind, contentId || null, messageId, stableKey, String(reason || '').slice(0, 300), content?.source || null, content?.url || null, content?.title || null, content?.feedId || null, createdAt);
      if (content?.research) this.db.prepare('UPDATE proactive_events SET source_research=? WHERE message_id=?').run(JSON.stringify(content.research), messageId);
      this.updateRuntime({ nextContactAt, lastContactAt: createdAt, lastDecisionAt: createdAt, lastReason: reason, lastError: null });
      const message=this.store.getMessage(messageId);afterSave?.(message);return this.store.getMessage(messageId);
    });
  }
  decorateMessage(row) {
    const event = this.db.prepare('SELECT * FROM proactive_events WHERE message_id=?').get(row.id);
    let research; try { research = event?.source_research ? JSON.parse(event.source_research) : null; } catch {}
    return { ...eventMetadata(event), ...(research ? { sourceResearch: research } : {}) };
  }
  respondToRole(role, at) { this.db.prepare("UPDATE proactive_events SET status='responded' WHERE role=? AND status='delivered' AND created_at<=?").run(role, at); }
  feedback(messageId, value) {
    if (!['good', 'less', 'later'].includes(value)) throw invalid('不支持这种反馈');
    return this.db.prepare("UPDATE proactive_events SET feedback=?,status='acknowledged' WHERE message_id=?").run(value, messageId).changes > 0;
  }
  recent(limit = 15) { return this.db.prepare('SELECT * FROM proactive_events ORDER BY rowid DESC LIMIT ?').all(limit).map(e => ({ id: e.id, role: e.role, kind: e.kind, reason: e.reason, createdAt: e.created_at, sourceTitle: e.source_title, sourceUrl: e.source_url, feedback: e.feedback, messageId: e.message_id })); }
  unreadByRole() {
    const result = Object.fromEntries(ROLES.map(role => [role, 0]));
    for (const row of this.db.prepare("SELECT m.role,COUNT(*) AS n FROM messages m LEFT JOIN conversation_reads r ON r.role=m.role WHERE m.rowid>COALESCE(r.last_rowid,0) AND m.speaker='assistant' AND m.kind IN ('proactive','reminder','session_reminder') GROUP BY m.role").all()) result[row.role] = Number(row.n);
    return result;
  }
  inbox() {
    const rows = this.db.prepare("SELECT m.* FROM messages m LEFT JOIN conversation_reads r ON r.role=m.role WHERE m.rowid>COALESCE(r.last_rowid,0) AND m.speaker='assistant' AND m.kind IN ('proactive','reminder','session_reminder') ORDER BY m.rowid DESC LIMIT 30").all();
    return { items: rows.map(row => ({ messageId: row.id, role: row.role, text: row.text, kind: row.kind, createdAt: row.created_at, ...this.decorateMessage(row) })), unreadByRole: this.unreadByRole() };
  }
  markRead(role, messageId) {
    const row = this.db.prepare('SELECT rowid FROM messages WHERE role=? AND id=?').get(role, messageId); if (!row) return false;
    this.db.prepare('INSERT INTO conversation_reads(role,last_rowid) VALUES(?,?) ON CONFLICT(role) DO UPDATE SET last_rowid=MAX(last_rowid,excluded.last_rowid)').run(role, row.rowid); return true;
  }
  addDefaultSourcesOnce(catalog, version = 'proactive_sources_v2') {
    if (this.read(version, false)) return;
    this.store.transaction(() => {
      for (const feed of catalog) this.db.prepare('INSERT OR IGNORE INTO feeds(id,url,title) VALUES(?,?,?)').run(feed.id, feed.url, feed.title);
      this.write(version, true);
    });
  }
}
