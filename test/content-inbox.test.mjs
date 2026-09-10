import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { ContentInbox } from '../lib/content-inbox.mjs';

function fixture(t, initial = '2026-09-07T00:00:00.000Z') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-content-inbox-'));
  let current = new Date(initial);
  const store = new Store({ dataDir, story: { start: 'start', nodes: { start: { body: '', choices: [] } } } });
  const inbox = new ContentInbox(store, { clock: () => new Date(current) });
  t.after(() => { store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const feed = store.addFeed('https://example.test/feed', '每日来源');
  const add = (title, options = {}) => {
    store.addContent(feed, [{ title, url: `https://example.test/${encodeURIComponent(title)}`, summary: options.summary || '', publishedAt: options.publishedAt }], options.source || feed.title);
    const inserted = store.listContent().find((entry) => entry.title === title);
    store.db.prepare('UPDATE content SET created_at=? WHERE id=?').run(current.toISOString(), inserted.id);
    const item = store.getContent(inserted.id);
    if (options.category) item.category = options.category;
    return item;
  };
  return { dataDir, store, inbox, feed, add, advance(ms) { current = new Date(current.getTime() + ms); }, now: () => new Date(current) };
}

test('metadata persists while original content remains untouched', (t) => {
  const f = fixture(t);
  const item = f.add('持久文章', { publishedAt: '2026-09-06T00:00:00.000Z' });
  f.inbox.update([item.id], 'read');
  const original = f.store.getContent(item.id);
  const reopened = new ContentInbox(f.store, { clock: f.now });
  assert.equal(reopened.decorate([original])[0].inbox.status, 'read');
  assert.deepEqual(f.store.getContent(item.id), original);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM content').get().n, 1);
});

test('unread content expires automatically and read content never becomes expired', (t) => {
  const f = fixture(t);
  const stale = f.add('旧闻', { publishedAt: '2026-08-30T00:00:00.000Z' });
  const fresh = f.add('未来误差', { publishedAt: '2099-01-01T00:00:00.000Z' });
  assert.equal(f.inbox.decorate([stale])[0].inbox.status, 'expired');
  assert.equal(f.inbox.decorate([fresh])[0].inbox.expiresAt, '2026-09-14T00:00:00.000Z');
  f.inbox.update([fresh.id], 'read');
  f.advance(60 * 24 * 60 * 60 * 1000);
  assert.equal(f.inbox.decorate([fresh])[0].inbox.status, 'read');
});

test('feed catalog gives knowledge and culture sources a thirty-day expiry', (t) => {
  const f = fixture(t);
  const item = f.add('长期知识', { publishedAt: '2026-09-01T00:00:00.000Z' });
  const inbox = new ContentInbox(f.store, {
    clock: f.now,
    feedCatalog: [{ url: f.feed.url, category: '历史文化' }],
  });
  assert.equal(inbox.decorate([item])[0].inbox.expiresAt, '2026-10-01T00:00:00.000Z');
});

test('unread and restore reset state and expiry from the manual action time', (t) => {
  const f = fixture(t);
  const item = f.add('可恢复文章', { publishedAt: '2020-01-01T00:00:00.000Z' });
  f.inbox.update([item.id], 'archive');
  f.advance(1000);
  let decorated = f.inbox.update([item.id], 'restore')[0];
  assert.equal(decorated.inbox.status, 'unread');
  assert.equal(decorated.inbox.readAt, null);
  assert.equal(decorated.inbox.archivedAt, null);
  assert.equal(decorated.inbox.expiresAt, '2026-09-14T00:00:01.000Z');
  f.inbox.update([item.id], 'read');
  decorated = f.inbox.update([item.id], 'unread')[0];
  assert.equal(decorated.inbox.status, 'unread');
  assert.equal(decorated.inbox.readAt, null);
});

test('list searches, paginates, clamps size, and reports status counts', (t) => {
  const f = fixture(t);
  const one = f.add('月球新闻', { summary: '关于新的观测项目' });
  const two = f.add('文化专栏', { source: '月球周刊' });
  f.add('无关内容');
  f.inbox.update([one.id], 'read');
  f.inbox.update([two.id], 'archive');
  const result = f.inbox.list({ status: 'all', query: '月球', page: 1, pageSize: 100 });
  assert.equal(result.pageSize, 50);
  assert.equal(result.total, 2);
  assert.deepEqual(result.counts, { unread: 0, read: 1, archived: 1, expired: 0, all: 2 });
  assert.equal(f.inbox.list({ status: 'all', page: 2, pageSize: 2 }).items.length, 1);
});

test('invalid batch is atomic and never removes source rows', (t) => {
  const f = fixture(t);
  const item = f.add('原始资料');
  assert.throws(() => f.inbox.update([item.id, 'missing'], 'read'), (error) => error.status === 400 && error.code === 'CONTENT_NOT_FOUND');
  assert.equal(f.inbox.decorate([item])[0].inbox.status, 'unread');
  assert.equal(f.store.getContent(item.id).title, '原始资料');
  assert.throws(() => f.inbox.update([], 'read'), (error) => error.code === 'INVALID_CONTENT_IDS');
});

test('conversation reads are role-gated, ordered by rowid, and preserve archives', (t) => {
  const f = fixture(t);
  const first = f.add('第一篇');
  const second = f.add('第二篇');
  const a = f.store.saveChatTurn({ role: 'wenxi', text: '第一篇', reply: '好', contentId: first.id });
  const foreign = f.store.saveChatTurn({ role: 'miyue', text: '第二篇', reply: '好', contentId: second.id });
  f.inbox.update([first.id], 'archive');
  assert.throws(() => f.inbox.markConversationRead('wenxi', foreign[0].id), (error) => error.code === 'MESSAGE_ROLE_MISMATCH');
  assert.equal(f.inbox.decorate([second])[0].inbox.status, 'unread');
  const changed = f.inbox.markConversationRead('wenxi', a.at(-1).id);
  assert.equal(changed.length, 1);
  assert.equal(f.inbox.decorate([first])[0].inbox.status, 'archived');
  assert.ok(f.inbox.decorate([first])[0].inbox.readAt);
});

test('conversation read cursor prevents restored old content from being marked read again', (t) => {
  const f = fixture(t);
  f.store.db.exec('CREATE TABLE conversation_reads (role TEXT PRIMARY KEY, last_rowid INTEGER NOT NULL DEFAULT 0)');
  const old = f.add('旧对话文章');
  const fresh = f.add('新对话文章');
  const oldTurn = f.store.saveChatTurn({ role: 'wenxi', text: '旧', reply: '好', contentId: old.id });
  const oldRowid = f.store.db.prepare('SELECT rowid FROM messages WHERE id=?').get(oldTurn.at(-1).id).rowid;
  f.store.db.prepare('INSERT INTO conversation_reads(role,last_rowid) VALUES(?,?)').run('wenxi', oldRowid);
  f.inbox.update([old.id], 'restore');
  const freshTurn = f.store.saveChatTurn({ role: 'wenxi', text: '新', reply: '好', contentId: fresh.id });
  const changed = f.inbox.markConversationRead('wenxi', freshTurn.at(-1).id);
  assert.deepEqual(changed.map((item) => item.id), [fresh.id]);
  assert.equal(f.inbox.decorate([old])[0].inbox.status, 'unread');
  assert.equal(f.inbox.decorate([fresh])[0].inbox.status, 'read');
});

test('unread helper selects only currently unread decorated items', (t) => {
  const f = fixture(t);
  const first = f.add('未读');
  const second = f.add('已读');
  f.inbox.update([second.id], 'read');
  assert.deepEqual(f.inbox.unread([first, second]).map((item) => item.id), [first.id]);
});
