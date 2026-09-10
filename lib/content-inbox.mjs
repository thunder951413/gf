const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_EXPIRY_MS = 7 * DAY_MS;
const EXTENDED_EXPIRY_MS = 30 * DAY_MS;
const MAX_IDS = 200;
const MAX_PAGE_SIZE = 50;
const VALID_ACTIONS = new Set(['read', 'unread', 'archive', 'restore']);
const VALID_STATUSES = new Set(['unread', 'read', 'archived', 'expired', 'all']);
const EXTENDED_CATEGORY = /知识|文化|历史|科普/u;

function problem(message, code) {
  const error = new Error(message);
  error.status = 400;
  error.code = code;
  return error;
}

function asDate(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function searchable(item) {
  return [item?.title, item?.source, item?.summary]
    .map((value) => String(value || '').normalize('NFKC').toLocaleLowerCase())
    .join('\n');
}

export class ContentInbox {
  constructor(store, { clock = () => new Date(), feedCatalog = [] } = {}) {
    if (!store?.db || typeof store.listContent !== 'function' || typeof store.transaction !== 'function') {
      throw new TypeError('ContentInbox requires a Store instance');
    }
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    this.store = store;
    this.db = store.db;
    this.clock = clock;
    const categoryByUrl = new Map((Array.isArray(feedCatalog) ? feedCatalog : [])
      .filter((feed) => feed?.url && feed?.category)
      .map((feed) => [String(feed.url), String(feed.category)]));
    this.feedCategories = new Map((store.listFeeds?.() || [])
      .map((feed) => [String(feed.id), categoryByUrl.get(String(feed.url))])
      .filter(([, category]) => category));
    const existing = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='content_inbox'").get();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS content_inbox (
        content_id TEXT PRIMARY KEY,
        read_at TEXT,
        archived_at TEXT,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    if (!existing && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_reads'").get()) {
      this.store.transaction(() => {
        this.ensureRows(store.listContent(), this.now());
        this.db.prepare(`UPDATE content_inbox SET read_at=? WHERE content_id IN (
          SELECT m.content_id FROM messages m JOIN conversation_reads r ON r.role=m.role
          WHERE m.rowid<=r.last_rowid AND m.content_id IS NOT NULL
        )`).run(this.now().toISOString());
      });
    }
  }

  now() {
    const date = asDate(this.clock());
    if (!date) throw new TypeError('clock must return a valid date');
    return date;
  }

  horizonFor(item) {
    const direct = Array.isArray(item?.category) ? item.category.join(' ') : item?.category;
    const category = direct || this.feedCategories.get(String(item?.feedId));
    return EXTENDED_CATEGORY.test(String(category || '')) ? EXTENDED_EXPIRY_MS : DEFAULT_EXPIRY_MS;
  }

  initialExpiresAt(item, now) {
    const created = asDate(item?.createdAt);
    const published = asDate(item?.publishedAt);
    let base = published || created || now;
    if (base > now) base = created && created <= now ? created : now;
    return new Date(base.getTime() + this.horizonFor(item)).toISOString();
  }

  ensureRows(items, now) {
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO content_inbox(content_id,read_at,archived_at,expires_at,updated_at)
      VALUES(?,NULL,NULL,?,?)
    `);
    this.store.transaction(() => {
      for (const item of items) {
        if (!item?.id) continue;
        const expiresAt = this.initialExpiresAt(item, now);
        insert.run(String(item.id), expiresAt, now.toISOString());
      }
    });
  }

  rowsFor(ids) {
    const rows = [];
    for (let offset = 0; offset < ids.length; offset += 500) {
      const chunk = ids.slice(offset, offset + 500);
      const placeholders = chunk.map(() => '?').join(',');
      rows.push(...this.db.prepare(`SELECT * FROM content_inbox WHERE content_id IN (${placeholders})`).all(...chunk));
    }
    return new Map(rows.map((row) => [String(row.content_id), row]));
  }

  statusFor(row, now) {
    if (row?.archived_at) return 'archived';
    if (row?.read_at) return 'read';
    const expires = asDate(row?.expires_at);
    return expires && expires <= now ? 'expired' : 'unread';
  }

  decorate(items) {
    if (!Array.isArray(items)) throw new TypeError('items must be an array');
    const now = this.now();
    this.ensureRows(items, now);
    const rows = this.rowsFor(items.filter((item) => item?.id).map((item) => String(item.id)));
    return items.map((item) => {
      const row = rows.get(String(item?.id));
      return {
        ...item,
        inbox: {
          status: this.statusFor(row, now),
          readAt: row?.read_at || null,
          archivedAt: row?.archived_at || null,
          expiresAt: row?.expires_at || this.initialExpiresAt(item, now),
        },
      };
    });
  }

  list({ status = 'unread', query = '', page = 1, pageSize = 20 } = {}) {
    status = String(status || 'unread').toLowerCase();
    if (!VALID_STATUSES.has(status)) throw problem('无效的收件箱状态', 'INVALID_INBOX_STATUS');
    page = positiveInteger(page, 1);
    pageSize = positiveInteger(pageSize, 20, MAX_PAGE_SIZE);
    const needle = String(query || '').normalize('NFKC').trim().toLocaleLowerCase();
    const searched = this.decorate(this.store.listContent())
      .filter((item) => !needle || searchable(item).includes(needle));
    const counts = { unread: 0, read: 0, archived: 0, expired: 0, all: searched.length };
    for (const item of searched) counts[item.inbox.status] += 1;
    const filtered = status === 'all' ? searched : searched.filter((item) => item.inbox.status === status);
    const total = filtered.length;
    const pages = total ? Math.ceil(total / pageSize) : 0;
    const offset = (page - 1) * pageSize;
    return { items: filtered.slice(offset, offset + pageSize), total, page, pageSize, pages, counts };
  }

  validateIds(ids) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_IDS || ids.some((id) => typeof id !== 'string' || !id.trim())) {
      throw problem('内容 ID 必须是包含 1 到 200 项的字符串数组', 'INVALID_CONTENT_IDS');
    }
    return [...new Set(ids.map((id) => id.trim()))];
  }

  knownItems(ids) {
    const byId = new Map(this.store.listContent().map((item) => [String(item.id), item]));
    const unknown = ids.filter((id) => !byId.has(id));
    if (unknown.length) throw problem('有内容不存在', 'CONTENT_NOT_FOUND');
    return ids.map((id) => byId.get(id));
  }

  update(ids, action) {
    const normalized = this.validateIds(ids);
    if (!VALID_ACTIONS.has(action)) throw problem('无效的收件箱操作', 'INVALID_INBOX_ACTION');
    const now = this.now();
    return this.store.transaction(() => {
      const items = this.knownItems(normalized);
      this.ensureRows(items, now);
      const timestamp = now.toISOString();
      if (action === 'read') {
        const statement = this.db.prepare('UPDATE content_inbox SET read_at=?, updated_at=? WHERE content_id=? AND read_at IS NULL');
        for (const id of normalized) statement.run(timestamp, timestamp, id);
      } else if (action === 'archive') {
        const statement = this.db.prepare('UPDATE content_inbox SET archived_at=?, updated_at=? WHERE content_id=? AND archived_at IS NULL');
        for (const id of normalized) statement.run(timestamp, timestamp, id);
      } else {
        const statement = this.db.prepare(`
          UPDATE content_inbox SET read_at=NULL, archived_at=NULL, expires_at=?, updated_at=?
          WHERE content_id=? AND (read_at IS NOT NULL OR archived_at IS NOT NULL OR expires_at<=?)
        `);
        for (const item of items) {
          statement.run(new Date(now.getTime() + this.horizonFor(item)).toISOString(), timestamp, String(item.id), timestamp);
        }
      }
      return this.decorate(items);
    });
  }

  markConversationRead(roleId, messageId) {
    if (typeof roleId !== 'string' || !roleId.trim() || typeof messageId !== 'string' || !messageId.trim()) {
      throw problem('角色和消息 ID 必填', 'INVALID_CONVERSATION_TARGET');
    }
    const now = this.now();
    return this.store.transaction(() => {
      const target = this.db.prepare('SELECT rowid,role FROM messages WHERE id=?').get(messageId);
      if (!target) throw problem('消息不存在', 'MESSAGE_NOT_FOUND');
      if (target.role !== roleId) throw problem('消息不属于这个角色', 'MESSAGE_ROLE_MISMATCH');
      const hasReadCursor = Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='conversation_reads'").get());
      const previousRowid = hasReadCursor
        ? Number(this.db.prepare('SELECT last_rowid FROM conversation_reads WHERE role=?').get(roleId)?.last_rowid || 0)
        : 0;
      const items = this.db.prepare(`
        SELECT DISTINCT c.* FROM messages AS m
        JOIN content AS c ON c.id=m.content_id
        WHERE m.role=? AND m.rowid>? AND m.rowid<=? AND m.content_id IS NOT NULL
      `).all(roleId, previousRowid, target.rowid).map((row) => ({
        id: row.id, feedId: row.feed_id, title: row.title, url: row.url,
        summary: row.summary, publishedAt: row.published_at, source: row.source, createdAt: row.created_at,
      }));
      this.ensureRows(items, now);
      const timestamp = now.toISOString();
      const statement = this.db.prepare('UPDATE content_inbox SET read_at=?, updated_at=? WHERE content_id=? AND read_at IS NULL');
      for (const item of items) statement.run(timestamp, timestamp, String(item.id));
      return this.decorate(items);
    });
  }

  unread(items) {
    return this.decorate(items).filter((item) => item.inbox.status === 'unread');
  }
}
