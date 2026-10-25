import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../lib/store.mjs';
import { ProactiveRepository } from '../lib/proactive-store.mjs';
import { ReplyDelivery, splitReply } from '../lib/chat-queue.mjs';

const story = { start: 'start' };
const limitError = error => error.status === 409 && error.code === 'UNANSWERED_MESSAGE_LIMIT';
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-delivery-cap-'));
  let at = new Date('2026-10-01T08:00:00Z');
  const stores = new Set();
  const open = () => { const store = new Store({ dataDir, story, clock: () => at }); stores.add(store); return store; };
  const close = store => { store.close(); stores.delete(store); };
  t.after(() => { for (const store of stores) store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const repo = store => {
    const repository = new ProactiveRepository(store, { clock: () => at });
    repository.saveSettings({ activeStart: '00:00', activeEnd: '23:59', dailyLimit: 12 });
    return repository;
  };
  return { dataDir, open, close, repo, advance: days => { at = new Date(+at + days * 86400_000); } };
}
function send(repo, topic, role = 'miyue') {
  return repo.commitDelivery({ role, kind: 'continuation', text: '今天有件小事想和你说。', reason: '分享', topicKey: topic,
    createdAt: repo.clock().toISOString(), nextContactAt: repo.clock().toISOString(), expectedLastMessageId: repo.getLastMessageId(role) });
}

test('ordinary replies and invitations share two consecutive messages, and a real user reply starts a new sequence', t => {
  const f = fixture(t), store = f.open(), repo = f.repo(store);
  store.saveChatTurn({ role: 'miyue', text: '今天去了河边。', reply: '河边今天怎么样？' });
  assert.equal(repo.unansweredCount('miyue'), 1);
  assert.ok(send(repo, 'first-followup'));
  assert.equal(send(repo, 'third-message'), null);
  assert.throws(() => store.saveChatTurn({ role: 'miyue', userTexts: [], reply: '再问一句。' }), limitError);
  const next = store.saveChatTurn({ role: 'miyue', userTexts: ['河边很安静。', '散了半小时步。'], reply: '听起来挺舒服的。' });
  assert.deepEqual(next.map(row => row.speaker), ['user', 'user', 'assistant']);
  assert.equal(repo.unansweredCount('miyue'), 1);
  assert.ok(send(repo, 'next-followup'));
  assert.equal(repo.unansweredCount('miyue'), 2);
});

test('days, feedback, read receipts, deleted history and a restart never restore unanswered allowance', t => {
  const f = fixture(t); let store = f.open(), repo = f.repo(store);
  const first = send(repo, 'first'), second = send(repo, 'second');
  assert.ok(first && second);
  assert.equal(repo.feedback(first.id, 'good'), true);
  assert.equal(repo.markRead('miyue', second.id), true);
  assert.equal(repo.unreadByRole().miyue, 0);
  assert.equal(repo.unansweredCount('miyue'), 2);
  store.db.exec('DELETE FROM proactive_events; DELETE FROM messages');
  f.close(store); f.advance(3); store = f.open(); repo = f.repo(store);
  assert.equal(repo.unansweredCount('miyue'), 2);
  assert.equal(send(repo, 'after-restart'), null);
  assert.throws(() => store.addAssistantMessage('miyue', '还没有新回复。'), limitError);
  store.saveChatTurn({ role: 'miyue', text: '回来了。', reply: '回来啦。' });
  assert.equal(repo.unansweredCount('miyue'), 1);
  assert.ok(send(repo, 'after-real-reply'));
});

test('legacy databases seed cadence from all messages after each role\'s last user message without deleting old history', t => {
  const f = fixture(t), db = new DatabaseSync(path.join(f.dataDir, 'life.sqlite'));
  db.exec('CREATE TABLE messages(id TEXT PRIMARY KEY,role TEXT NOT NULL,speaker TEXT NOT NULL,text TEXT NOT NULL,kind TEXT NOT NULL,content_id TEXT,created_at TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?)');
  for (const [id, role, speaker, kind] of [
    ['old', 'miyue', 'assistant', 'proactive'], ['reply', 'miyue', 'user', 'chat'],
    ['normal', 'miyue', 'assistant', 'chat'], ['invitation', 'miyue', 'assistant', 'chat'],
    ['one', 'wenxi', 'assistant', 'proactive'], ['two', 'wenxi', 'assistant', 'reminder'], ['three', 'wenxi', 'assistant', 'chat'],
  ]) insert.run(id, role, speaker, id, kind, null, '2026-09-01T00:00:00Z');
  db.close();
  let store = f.open();
  assert.equal(store.unansweredAssistantCount('miyue'), 2);
  assert.equal(store.unansweredAssistantCount('wenxi'), 3);
  assert.equal(store.getMessages('wenxi').length, 3);
  assert.throws(() => store.addAssistantMessage('wenxi', '不应继续。'), limitError);
  store.saveChatTurn({ role: 'miyue', text: '新回复。', reply: '收到。' });
  f.close(store); store = f.open();
  assert.equal(store.unansweredAssistantCount('miyue'), 1, 'restart must not reseed existing counters');
});

test('a rolled-back reply cannot reset the allowance or consume a delivery slot', t => {
  const f = fixture(t), store = f.open();
  store.addAssistantMessage('miyue', '第一条。');
  assert.throws(() => store.saveChatTurn({ role: 'miyue', userTexts: [], reply: '失败的第二条。', afterSave: () => { throw Error('stale'); } }), /stale/);
  assert.equal(store.unansweredAssistantCount('miyue'), 1);
  store.addAssistantMessage('miyue', '第二条。');
  assert.throws(() => store.saveChatTurn({ role: 'miyue', text: '未提交的用户回复。', reply: '旧状态。', afterSave: () => { throw Error('stale'); } }), /stale/);
  assert.equal(store.unansweredAssistantCount('miyue'), 2);
  assert.deepEqual(store.getMessages('miyue').map(row => row.text), ['第一条。', '第二条。']);
});

test('two SQLite connections and direct inserts cannot both take the last delivery slot', t => {
  const f = fixture(t), first = f.open();
  first.addAssistantMessage('miyue', '第一条。');
  const second = f.open();
  second.addAssistantMessage('miyue', '第二条。');
  assert.throws(() => first.addAssistantMessage('miyue', '并发第三条。'), limitError);
  assert.throws(() => first.transaction(() => first.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)')
    .run('direct', 'miyue', 'assistant', '直接插入第三条。', 'chat', first.now())), limitError);
  assert.equal(second.unansweredAssistantCount('miyue'), 2);
  assert.equal(first.getMessages('miyue').length, 2);
});

test('reminders wait at the cap without losing their pending state or using another role\'s allowance', t => {
  const f = fixture(t), store = f.open(); f.repo(store).saveSettings({ dailyLimit: 1 });
  store.addAssistantMessage('miyue', '第一条。'); store.addAssistantMessage('miyue', '第二条。');
  const held = store.addReminder('miyue', '保留待提醒事项', store.now());
  const other = store.addReminder('zhixia', '另一角色提醒', store.now());
  assert.deepEqual(store.deliverDueReminders(new Date(store.now())).map(row => row.id), [other.id]);
  assert.equal(store.listReminders().find(row => row.id === held.id).status, 'pending');
  store.db.prepare("UPDATE reminders SET delivery_kind='commitment' WHERE id=?").run(held.id);
  assert.deepEqual(store.deliverDueReminders(new Date(store.now())), []);
  store.saveChatTurn({ role: 'miyue', text: '我回来了。', reply: '回来啦。' });
  assert.deepEqual(store.deliverDueReminders(new Date(store.now())).map(row => row.id), [held.id]);
  assert.equal(store.unansweredAssistantCount('miyue'), 2);
  assert.deepEqual(store.deliverDueReminders(new Date(store.now())), []);
});

test('segmentation preserves the complete answer in no more than two messages', () => {
  const text = Array.from({ length: 40 }, (_, i) => `第${i + 1}句描述今天发生的一件小事，保留这一句的完整内容。`).join('');
  for (const mode of ['companion', 'information', 'scenario']) {
    const parts = splitReply(text, mode);
    assert.equal(parts.length, 2);
    assert.equal(parts.join(''), text);
  }
  assert.equal(splitReply('```js\nconst a = 1;\n```').length, 1);
});

test('reminders cannot interrupt a pending user reply or its remaining chunks', t => {
  const f = fixture(t), store = f.open();
  const busy = store.addReminder('miyue', '仍在等待的提醒', store.now());
  const free = store.addReminder('zhixia', '可发送的提醒', store.now());
  assert.deepEqual(store.deliverDueReminders(new Date(store.now()), null, role => role === 'miyue').map(row => row.id), [free.id]);
  assert.equal(store.listReminders().find(row => row.id === busy.id).status, 'pending');
  assert.equal(store.unansweredAssistantCount('miyue'), 0);
});

test('legacy persisted chunks merge into the last slot after restart and keep their channel', t => {
  const f = fixture(t); let store = f.open();
  store.saveChatTurn({ role: 'miyue', text: '继续说吧。', reply: '先讲第一部分。', replyChannel: 'weixin' });
  new ReplyDelivery(store).enqueue('miyue', ['第二部分。', '第三部分。', '最后一部分。'], null, 'weixin');
  f.close(store); store = f.open();
  const delivered = [], delivery = new ReplyDelivery(store, { onDelivery: row => delivered.push(row) });
  store.db.exec('UPDATE reply_delivery SET due_at=0');
  delivery.tick(); delivery.tick();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].text, '第二部分。\n第三部分。\n最后一部分。');
  assert.equal(store.db.prepare('SELECT reply_channel FROM messages WHERE id=?').get(delivered[0].id).reply_channel, 'weixin');
  assert.equal(delivery.pending('miyue'), 0);
  assert.equal(store.unansweredAssistantCount('miyue'), 2);
  delivery.enqueue('miyue', ['已经没有发送空间。']);
  store.db.exec('UPDATE reply_delivery SET due_at=0');
  delivery.tick();
  assert.equal(delivery.pending('miyue'), 0, 'blocked legacy chunks must not leave the role busy forever');
  assert.equal(delivered.length, 1);
});
