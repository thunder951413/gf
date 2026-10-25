import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_UNANSWERED_MESSAGES = 2;
const unansweredLimit = () => Object.assign(new Error('已连续发送两条消息，等你回复后再继续'), { status: 409, code: 'UNANSWERED_MESSAGE_LIMIT' });

const mapMessage = (row) => ({
  id: row.id,
  role: row.role,
  speaker: row.speaker,
  text: row.text,
  kind: row.kind,
  createdAt: row.created_at,
});
const mapMemory = (row) => ({ id: row.id, scope: row.scope, text: row.text, createdAt: row.created_at });
const mapReminder = (row) => ({
  id: row.id,
  role: row.role,
  text: row.text,
  dueAt: row.due_at,
  status: row.status,
  deliveryKind: row.delivery_kind || 'legacy',
  originChannel: row.origin_channel === 'weixin' ? 'weixin' : 'desktop',
});
const mapFeed = (row) => ({ id: row.id, url: row.url, title: row.title });
function parseResearch(value) { try { return value ? JSON.parse(value) : undefined; } catch { return undefined; } }
const mapContent = (row) => ({
  id: row.id,
  feedId: row.feed_id,
  title: row.title,
  url: row.url,
  summary: row.summary,
  publishedAt: row.published_at,
  source: row.source,
  createdAt: row.created_at,
  ...(row.research_json ? { research: parseResearch(row.research_json) } : {}),
});

export class Store {
  constructor({ dataDir, story, initialFeeds = [], clock = () => new Date() }) {
    this.now = () => new Date(clock()).toISOString();
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dataDir, 0o700);
    this.db = new DatabaseSync(path.join(dataDir, 'life.sqlite'));
    this.story = story;
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, role TEXT NOT NULL, speaker TEXT NOT NULL,
        text TEXT NOT NULL, kind TEXT NOT NULL, content_id TEXT, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS messages_role_time ON messages(role, created_at);
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), quiet INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS story_state (id INTEGER PRIMARY KEY CHECK(id=1), node_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS story_history (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT NOT NULL,
        choice_id TEXT NOT NULL, label TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL, due_at TEXT NOT NULL,
        status TEXT NOT NULL, created_at TEXT NOT NULL, delivered_at TEXT
      );
      CREATE TABLE IF NOT EXISTS feeds (id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS content (
        id TEXT PRIMARY KEY, feed_id TEXT NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
        title TEXT NOT NULL, url TEXT NOT NULL, summary TEXT NOT NULL,
        published_at TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(feed_id, url)
      );
    `);
    if (!this.db.prepare('PRAGMA table_info(messages)').all().some(c => c.name === 'reply_channel')) this.db.exec("ALTER TABLE messages ADD COLUMN reply_channel TEXT NOT NULL DEFAULT 'desktop'");
    if (!this.db.prepare('PRAGMA table_info(content)').all().some(c => c.name === 'research_json')) this.db.exec('ALTER TABLE content ADD COLUMN research_json TEXT');
    const reminderColumns = this.db.prepare('PRAGMA table_info(reminders)').all();
    if (!reminderColumns.some(c => c.name === 'delivery_kind')) this.db.exec("ALTER TABLE reminders ADD COLUMN delivery_kind TEXT NOT NULL DEFAULT 'legacy'");
    if (!reminderColumns.some(c => c.name === 'origin_channel')) this.db.exec("ALTER TABLE reminders ADD COLUMN origin_channel TEXT NOT NULL DEFAULT 'desktop'");
    // Delivery cadence outlives history windows, read receipts and transcript
    // deletion. Seed old databases once; every connection shares the same cap.
    this.transaction(() => this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_delivery_state (
        role TEXT PRIMARY KEY, unanswered_count INTEGER NOT NULL CHECK(unanswered_count>=0)
      );
      INSERT OR IGNORE INTO conversation_delivery_state(role,unanswered_count)
      SELECT roles.role, (SELECT COUNT(*) FROM messages m WHERE m.role=roles.role AND m.speaker='assistant'
        AND m.rowid>COALESCE((SELECT MAX(u.rowid) FROM messages u WHERE u.role=roles.role AND u.speaker='user'),0))
      FROM (SELECT DISTINCT role FROM messages) roles;
      CREATE TRIGGER IF NOT EXISTS messages_unanswered_limit BEFORE INSERT ON messages
      WHEN NEW.speaker='assistant' AND COALESCE((SELECT unanswered_count FROM conversation_delivery_state WHERE role=NEW.role),0)>=${MAX_UNANSWERED_MESSAGES}
      BEGIN SELECT RAISE(ABORT,'UNANSWERED_MESSAGE_LIMIT'); END;
      CREATE TRIGGER IF NOT EXISTS messages_delivery_cadence AFTER INSERT ON messages
      WHEN NEW.speaker IN ('user','assistant')
      BEGIN
        INSERT INTO conversation_delivery_state(role,unanswered_count) VALUES(NEW.role,CASE WHEN NEW.speaker='user' THEN 0 ELSE 1 END)
        ON CONFLICT(role) DO UPDATE SET unanswered_count=CASE WHEN NEW.speaker='user' THEN 0 ELSE unanswered_count+1 END;
      END;
    `));
    this.db.prepare('INSERT OR IGNORE INTO settings(id, quiet) VALUES(1, 0)').run();
    this.db.prepare('INSERT OR IGNORE INTO story_state(id, node_id) VALUES(1, ?)').run(story.start);
    if (!this.db.prepare("SELECT value FROM metadata WHERE key='feeds_initialized'").get()) {
      this.transaction(() => {
        const insertFeed = this.db.prepare('INSERT OR IGNORE INTO feeds(id, url, title) VALUES(?, ?, ?)');
        for (const feed of initialFeeds) insertFeed.run(feed.id || randomUUID(), feed.url, feed.title || feed.url);
        this.db.prepare("INSERT INTO metadata(key,value) VALUES('feeds_initialized','1')").run();
      });
    }
  }

  close() { this.db.close(); }
  transaction(fn) {
    const depth = this.transactionDepth || 0;
    const savepoint = `life_nested_${depth}`;
    this.db.exec(depth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.transactionDepth = depth + 1;
    try {
      const result = fn();
      this.db.exec(depth ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      try { this.db.exec(depth ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : 'ROLLBACK'); } catch {}
      throw error?.message === 'UNANSWERED_MESSAGE_LIMIT' ? unansweredLimit() : error;
    } finally { this.transactionDepth = depth; }
  }

  getSettings() { return { quiet: Boolean(this.db.prepare('SELECT quiet FROM settings WHERE id=1').get().quiet) }; }
  setSettings({ quiet }) {
    if (quiet !== undefined) this.db.prepare('UPDATE settings SET quiet=? WHERE id=1').run(quiet ? 1 : 0);
    return this.getSettings();
  }

  sourceMetadata(row) {
    const source=row.speaker==='assistant'&&row.content_id?this.getContent(row.content_id):null;
    return source?{sourceTitle:source.source,sourceUrl:source.url,articleTitle:source.title}:{};
  }

  getMessages(role, limit) {
    const rows = limit
      ? this.db.prepare('SELECT * FROM messages WHERE role=? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(role, limit).reverse()
      : this.db.prepare('SELECT * FROM messages WHERE role=? ORDER BY created_at, rowid').all(role);
    return rows.map(row => this.decorateMessageRow(row));
  }
  decorateMessageRow(row) {
    return { ...mapMessage(row), ...this.sourceMetadata(row), ...(this.proactiveRepo?.decorateMessage(row) || {}), ...(this.materialMetadata?.(row)||{}) };
  }
  // The newest `limit` messages, or the `limit` messages just before `before`
  // (a message id), in chronological order. Used by the chat views so a long
  // history is not sent and re-rendered on every poll.
  getMessagePage(role, { limit = 120, before = null } = {}) {
    const size = Math.max(1, Math.min(1000, Math.trunc(Number(limit)) || 120));
    let rows;
    if (before) {
      const anchor = this.db.prepare('SELECT created_at, rowid AS r FROM messages WHERE id=? AND role=?').get(String(before), role);
      if (!anchor) return { rows: [], hasMore: false };
      rows = this.db.prepare('SELECT * FROM messages WHERE role=? AND (created_at<? OR (created_at=? AND rowid<?)) ORDER BY created_at DESC, rowid DESC LIMIT ?')
        .all(role, anchor.created_at, anchor.created_at, anchor.r, size + 1);
    } else rows = this.db.prepare('SELECT * FROM messages WHERE role=? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(role, size + 1);
    const hasMore = rows.length > size;
    return { rows: rows.slice(0, size).reverse().map(row => this.decorateMessageRow(row)), hasMore };
  }
  getMessage(id) {
    const row = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id);
    return row ? { ...mapMessage(row), ...this.sourceMetadata(row), ...(this.proactiveRepo?.decorateMessage(row) || {}), ...(this.materialMetadata?.(row)||{}) } : null;
  }
  chatChannel(role) { return this.db.prepare('SELECT value FROM metadata WHERE key=?').get(`chat_channel:${role}`)?.value === 'weixin' ? 'weixin' : 'desktop'; }
  setChatChannel(role, channel) { this.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(`chat_channel:${role}`, channel === 'weixin' ? 'weixin' : 'desktop'); }
  unansweredAssistantCount(role) { return Number(this.db.prepare('SELECT unanswered_count FROM conversation_delivery_state WHERE role=?').get(role)?.unanswered_count || 0); }
  assertAssistantMessageAllowed(role) { if (this.unansweredAssistantCount(role) >= MAX_UNANSWERED_MESSAGES) throw unansweredLimit(); }

  saveChatTurn({ role, text, userTexts, userCreatedAts, reply, contentId, afterSave, replyChannel = 'desktop' }) {
    return this.transaction(() => {
      const createdAt = this.now();
      const user = { id: randomUUID(), role, speaker: 'user', text, kind: 'chat', createdAt };
      const assistant = { id: randomUUID(), role, speaker: 'assistant', text: reply, kind: 'chat', createdAt: this.now() };
      const insert = this.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,content_id,created_at) VALUES(?,?,?,?,?,?,?)');
      // An explicit empty list is an internal invitation: only she has spoken.
      const users = (userTexts ?? [text]).map((value,index)=>({
        ...user,id:index===0?user.id:randomUUID(),text:value,
        createdAt:userCreatedAts?.[index] ? new Date(userCreatedAts[index]).toISOString() : createdAt,
      }));
      if (!users.length) this.assertAssistantMessageAllowed(role);
      for(const entry of users)insert.run(entry.id, role, entry.speaker, entry.text, entry.kind, contentId || null, entry.createdAt);
      insert.run(assistant.id, role, assistant.speaker, assistant.text, assistant.kind, contentId || null, assistant.createdAt);
      this.db.prepare('UPDATE messages SET reply_channel=? WHERE id=?').run(replyChannel === 'weixin' ? 'weixin' : 'desktop', assistant.id);
      if(users.length)this.proactiveRepo?.respondToRole(role, users.at(-1).createdAt);
      afterSave?.([...users, assistant]);
      return [...users, assistant];
    });
  }

  addAssistantMessage(role,text,replyChannel='desktop'){
    return this.transaction(()=>{
      this.assertAssistantMessageAllowed(role);
      const message={id:randomUUID(),role,speaker:'assistant',text,kind:'chat',createdAt:this.now()};
      this.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at,reply_channel) VALUES(?,?,?,?,?,?,?)').run(message.id,role,message.speaker,text,message.kind,message.createdAt,replyChannel === 'weixin' ? 'weixin' : 'desktop');
      return message;
    });
  }

  listMemories(role) {
    const rows = role
      ? this.db.prepare("SELECT * FROM memories WHERE scope='shared' OR scope=? ORDER BY created_at, rowid").all(role)
      : this.db.prepare('SELECT * FROM memories ORDER BY created_at, rowid').all();
    return rows.map(mapMemory);
  }
  addMemory(scope, text) {
    const memory = { id: randomUUID(), scope, text, createdAt: this.now() };
    this.db.prepare('INSERT INTO memories(id,scope,text,created_at) VALUES(?,?,?,?)').run(memory.id, scope, text, memory.createdAt);
    return memory;
  }
  updateMemory(id, { text, scope }) {
    const existing = this.db.prepare('SELECT * FROM memories WHERE id=?').get(id);
    if (!existing) return null;
    this.db.prepare('UPDATE memories SET text=?, scope=? WHERE id=?').run(text ?? existing.text, scope ?? existing.scope, id);
    return mapMemory(this.db.prepare('SELECT * FROM memories WHERE id=?').get(id));
  }
  deleteMemory(id) { return this.db.prepare('DELETE FROM memories WHERE id=?').run(id).changes > 0; }

  getStory() {
    const nodeId = this.db.prepare('SELECT node_id FROM story_state WHERE id=1').get().node_id;
    const node = this.story.nodes[nodeId];
    const history = this.db.prepare('SELECT node_id,choice_id,label,created_at FROM story_history ORDER BY seq').all()
      .map((r) => ({ nodeId: r.node_id, choiceId: r.choice_id, label: r.label, createdAt: r.created_at }));
    return { node, history };
  }
  chooseStory(choiceId, expectedNodeId) {
    return this.transaction(() => {
      const currentId = this.db.prepare('SELECT node_id FROM story_state WHERE id=1').get().node_id;
      if (currentId !== expectedNodeId) {
        const error = new Error('故事进度已更新，请刷新后再选择'); error.status = 409; error.code = 'STALE_STORY_NODE'; throw error;
      }
      const current = this.story.nodes[currentId];
      const choice = current?.choices?.find((item) => item.id === choiceId);
      if (!choice || !this.story.nodes[choice.next]) {
        const error = new Error('这个选项不存在'); error.status = 400; error.code = 'INVALID_CHOICE'; throw error;
      }
      const createdAt = this.now();
      this.db.prepare('INSERT INTO story_history(node_id,choice_id,label,created_at) VALUES(?,?,?,?)').run(currentId, choice.id, choice.label, createdAt);
      this.db.prepare('UPDATE story_state SET node_id=? WHERE id=1').run(choice.next);
      const insert = this.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,content_id,created_at) VALUES(?,?,?,?,?,?,?)');
      insert.run(randomUUID(), 'miyue', 'user', choice.label, 'story', null, createdAt);
      insert.run(randomUUID(), 'miyue', 'assistant', this.story.nodes[choice.next].body, 'story', null, this.now());
      return this.getStory();
    });
  }
  resetStory() {
    return this.transaction(() => {
      this.db.prepare('UPDATE story_state SET node_id=? WHERE id=1').run(this.story.start);
      this.db.exec('DELETE FROM story_history');
      this.db.prepare("DELETE FROM messages WHERE role='miyue' AND kind='story'").run();
      return this.getStory();
    });
  }

  listReminders() { return this.db.prepare('SELECT * FROM reminders ORDER BY due_at, created_at').all().map(mapReminder); }
  addReminder(role, text, dueAt) {
    const reminder = { id: randomUUID(), role, text, dueAt, status: 'pending' };
    this.db.prepare('INSERT INTO reminders(id,role,text,due_at,status,created_at) VALUES(?,?,?,?,?,?)')
      .run(reminder.id, role, text, dueAt, reminder.status, this.now());
    return reminder;
  }
  deleteReminder(id) { return this.db.prepare('DELETE FROM reminders WHERE id=?').run(id).changes > 0; }
  deliverDueReminders(at = new Date(), activeRoleIds = null, isBusy = () => false) {
    if (this.getSettings().quiet) return [];
    const end = at.toISOString();
    const start = new Date(at); start.setHours(0, 0, 0, 0);
    return this.transaction(() => {
      const deliveredToday = this.proactiveRepo ? this.proactiveRepo.countContactsSince(start.toISOString()) : Number(this.db.prepare("SELECT COUNT(*) AS n FROM reminders WHERE status='delivered' AND delivery_kind='legacy' AND delivered_at>=? AND delivered_at<=?").get(start.toISOString(), end).n);
      let legacySlots = Math.max(0, (this.proactiveRepo?.getSettings().dailyLimit || 2) - deliveredToday);
      const due = this.db.prepare("SELECT * FROM reminders WHERE status='pending' AND due_at<=? ORDER BY due_at, created_at").all(end)
        .filter(row => (!activeRoleIds || activeRoleIds.has(row.role)) && !isBusy(row.role));
      const update = this.db.prepare("UPDATE reminders SET status='delivered', delivered_at=? WHERE id=? AND status='pending'");
      const insert = this.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,content_id,created_at,reply_channel) VALUES(?,?,?,?,?,?,?,?)');
      const delivered = [];
      for (const row of due) {
        if (this.unansweredAssistantCount(row.role) >= MAX_UNANSWERED_MESSAGES) continue;
        const commitment = row.delivery_kind === 'commitment';
        if (!commitment && legacySlots <= 0) continue;
        const deliveredAt = end;
        if (!update.run(deliveredAt, row.id).changes) continue;
        if (!commitment) legacySlots--;
        const message = {
          id: randomUUID(), role: row.role, speaker: 'assistant',
          text: commitment ? `提醒你：\n${row.text}` : `你之前留了这件事，想现在接着聊吗？\n${row.text}`,
          kind: commitment ? 'session_reminder' : 'reminder', createdAt: deliveredAt,
        };
        const replyChannel = commitment && row.origin_channel === 'weixin' ? 'weixin' : 'desktop';
        insert.run(message.id, message.role, message.speaker, message.text, message.kind, null, message.createdAt, replyChannel);
        delivered.push({ ...mapReminder(row), status: 'delivered', message: { ...message, replyChannel } });
      }
      return delivered;
    });
  }

  listFeeds() { return this.db.prepare('SELECT * FROM feeds ORDER BY rowid').all().map(mapFeed); }
  addFeed(url, title) {
    const feed = { id: randomUUID(), url, title: title || url };
    this.db.prepare('INSERT INTO feeds(id,url,title) VALUES(?,?,?)').run(feed.id, feed.url, feed.title);
    return feed;
  }
  updateFeedTitle(id, title) { this.db.prepare('UPDATE feeds SET title=? WHERE id=?').run(title, id); }
  deleteFeed(id) { return this.db.prepare('DELETE FROM feeds WHERE id=?').run(id).changes > 0; }
  listContent() { return this.db.prepare('SELECT * FROM content ORDER BY COALESCE(published_at,created_at) DESC, rowid DESC').all().map(mapContent); }
  getContent(id) { const row = this.db.prepare('SELECT * FROM content WHERE id=?').get(id); return row ? mapContent(row) : null; }
  getRecentContent(role, messageLimit = 30) {
    const row = this.db.prepare(`
      SELECT c.* FROM (
        SELECT rowid AS message_rowid, content_id
        FROM messages WHERE role=? ORDER BY rowid DESC LIMIT ?
      ) AS recent
      JOIN content AS c ON c.id=recent.content_id
      WHERE recent.content_id IS NOT NULL
      ORDER BY recent.message_rowid DESC LIMIT 1
    `).get(role, messageLimit);
    return row ? mapContent(row) : null;
  }
  addContent(feed, items, sourceTitle) {
    let added = 0;
    const insert = this.db.prepare('INSERT OR IGNORE INTO content(id,feed_id,title,url,summary,published_at,source,created_at) VALUES(?,?,?,?,?,?,?,?)');
    this.transaction(() => {
      for (const item of items) {
        added += Number(insert.run(randomUUID(), feed.id, item.title || item.url, item.url, item.summary || '', item.publishedAt || null, sourceTitle || feed.title, this.now()).changes);
      }
    });
    return added;
  }
}
