import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../lib/store.mjs';
import { ProactiveRepository } from '../lib/proactive-store.mjs';
import { CompanionSourceHistory } from '../lib/companion-source-history.mjs';

const NOW = new Date('2026-09-10T12:00:00.000Z');
const story = { start: 'start', nodes: { start: {} } };

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-source-history-'));
  const store = new Store({ dataDir, story, initialFeeds: [] });
  new ProactiveRepository(store, { clock: () => NOW });
  const history = new CompanionSourceHistory(store, { clock: () => NOW });
  const feed = store.addFeed('https://feed.example/rss', 'Example feed');
  t.after(() => { store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { store, history, feed };
}

function addContent(store, feed, rows) {
  store.addContent(feed, rows.map(({ title, url }) => ({ title, url, summary: 'A substantive summary.' })), 'Example feed');
  return store.listContent();
}

function insertMessage(store, { id = randomUUID(), role = 'miyue', text, contentId = null, createdAt = NOW.toISOString() }) {
  store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,content_id,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(id, role, 'assistant', text, 'chat', contentId, createdAt);
  return { id, role, speaker: 'assistant', text, kind: 'chat', contentId, createdAt };
}

test('records every explicit source once per message and remains idempotent', t => {
  const { store, history, feed } = fixture(t);
  const [first, second] = addContent(store, feed, [
    { title: '自由泳换气如何保持身体平衡', url: 'https://example.com/swim' },
    { title: '苏州这座城市是不是过誉了', url: 'https://example.com/suzhou' },
  ]);
  const message = insertMessage(store, { text: `资料一：${first.url}\n资料二：${second.url}` });
  assert.deepEqual(history.record(message, [first, second]), [first, second]);
  assert.deepEqual(history.record(message, [first, second]), [first, second]);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM companion_source_deliveries WHERE message_id=?').get(message.id).n, 2);
  assert.equal(store.db.prepare('SELECT content_id FROM messages WHERE id=?').get(message.id).content_id, first.id);
});

test('source receipts roll back with their enclosing Store transaction', t => {
  const { store, history, feed } = fixture(t);
  const [source] = addContent(store, feed, [{ title: '自由泳换气如何保持身体平衡', url: 'https://example.com/swim' }]);
  const id = randomUUID();
  assert.throws(() => store.transaction(() => {
    const message = insertMessage(store, { id, text: `来源：${source.url}` });
    history.record(message, [source]);
    throw new Error('abort');
  }), /abort/);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE id=?').get(id).n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM companion_source_deliveries WHERE message_id=?').get(id).n, 0);
});

test('backfills legacy Miyue messages without content_id from a stripped publisher title', t => {
  const { store, history, feed } = fixture(t);
  const [source] = addContent(store, feed, [{
    title: '苏州这座城市是不是过誉了? - 知乎｜知乎观点', url: 'https://www.zhihu.com/question/12345',
  }]);
  const message = insertMessage(store, { text: '我想继续谈谈“苏州这座城市是不是过誉了？”这篇。' });
  history.backfill();
  assert.equal(store.db.prepare('SELECT content_id FROM messages WHERE id=?').get(message.id).content_id, source.id);
  assert.deepEqual(history.recent().map(({ id, title, url }) => ({ id, title, url })), [{ id: source.id, title: source.title, url: source.url }]);
});

test('excludes canonical URL duplicates even when content ids and titles differ', t => {
  const { store, history, feed } = fixture(t);
  const [original] = addContent(store, feed, [{ title: '原始报道的完整标题', url: 'https://example.com/story?a=1&utm_source=rss' }]);
  const message = insertMessage(store, { text: `来源：${original.url}` });
  history.record(message, [original]);
  const duplicate = { id: 'different-id', title: '转载后的完全不同标题', url: 'https://example.com/story?utm_medium=email&a=1' };
  const distinct = { id: 'distinct', title: '完全不同的另一篇文章', url: 'https://example.com/elsewhere' };
  assert.deepEqual(history.excludedIds([duplicate, distinct]), ['different-id']);
});

test('keeps roles isolated, cascades deleted messages, and expires receipts after 30 days', t => {
  const { store, history, feed } = fixture(t);
  const [source] = addContent(store, feed, [{ title: '自由泳换气如何保持身体平衡', url: 'https://example.com/swim' }]);
  const miyue = insertMessage(store, { text: `来源：${source.url}` });
  const wenxi = insertMessage(store, { role: 'wenxi', text: `来源：${source.url}` });
  history.record(miyue, [source]);
  assert.deepEqual(history.record(wenxi, [source]), []);
  assert.deepEqual(history.recent('wenxi'), []);
  store.db.prepare('DELETE FROM messages WHERE id=?').run(miyue.id);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM companion_source_deliveries').get().n, 0);

  const expired = insertMessage(store, { text: `来源：${source.url}`, createdAt: new Date(+NOW - 30 * 86400_000 - 1).toISOString() });
  history.record(expired, [source]);
  assert.deepEqual(history.recent(), []);
  assert.deepEqual(history.excludedIds([source]), []);
});
