import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../lib/store.mjs';
import { ReplyDelivery } from '../lib/chat-queue.mjs';
import { WeixinBridge } from '../lib/weixin-bridge.mjs';
import { sessionReminderActions } from '../lib/session-reminders.mjs';

const story = { start: 'start', nodes: { start: { title: '开始', body: '开始', choices: [] } } };
const baseUrl = 'https://ilinkai.weixin.qq.com';

function fixture(options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'youjian-weixin-'));
  const store = new Store({ dataDir, story });
  const calls = { submitted: [], sent: [] };
  const client = {
    async getUpdates() { return { cursor: '', messages: [] }; },
    async startLogin() { return { qrcode: 'qr', qrcodeUrl: 'https://weixin.qq.com/qr' }; },
    async pollLogin() { return { status: 'waiting' }; },
    async sendText(payload) { calls.sent.push(payload); return { messageId: 'sent' }; },
    ...options.client,
  };
  let now = options.now ?? Date.UTC(2026, 0, 1, 8, 0, 0);
  const bridge = new WeixinBridge(store, {
    client,
    submit: (role, text, id) => calls.submitted.push({ role, text, id }),
    clock: () => new Date(now),
    ...options.bridge,
  });
  return {
    store, bridge, client, calls,
    advance(ms) { now += ms; },
    close() { store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); },
  };
}
function bind(bridge) { bridge.bind({ botToken: 'secret-token', botId: 'bot-1', userId: 'owner-1', baseUrl }); }
function inbound({ id = 'msg-1', from = 'owner-1', text = '你好', context = 'ctx-1' } = {}) {
  return { cursor: `cursor-${id}`, messages: [{ message_id: id, message_type: 1, from_user_id: from, context_token: context, item_list: [{ type: 1, text_item: { text } }] }] };
}
function outbox(store) { return store.db.prepare('SELECT * FROM weixin_outbox ORDER BY rowid').all(); }
async function waitFor(predicate, message = 'condition was not met') {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test('Weixin bridge only accepts the bound user and submits every inbound turn to 林晓薇', () => {
  const f = fixture();
  try {
    bind(f.bridge);
    f.bridge.ingest(inbound({ id: 'outsider', from: 'someone-else', text: '别理我' }));
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM weixin_inbox').get().n, 0);
    assert.equal(f.bridge.read().cursor, 'cursor-outsider');

    f.bridge.ingest(inbound({ id: 'owner', text: '只找晓薇' }));
    f.bridge.drainInbox();
    assert.deepEqual(f.calls.submitted, [{ role: 'miyue', text: '只找晓薇', id: f.calls.submitted[0].id }]);
    assert.equal(f.store.db.prepare("SELECT state FROM weixin_inbox WHERE id=?").get(f.calls.submitted[0].id).state, 'submitted');
  } finally { f.close(); }
});

test('Weixin inbound replay is deduplicated, persists its cursor, and rolls both back together on a database failure', () => {
  const f = fixture();
  try {
    bind(f.bridge);
    f.bridge.ingest(inbound({ id: 'once' }));
    f.bridge.ingest(inbound({ id: 'once' }));
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM weixin_inbox').get().n, 1);
    assert.equal(f.bridge.read().cursor, 'cursor-once');

    f.store.db.exec("CREATE TRIGGER reject_weixin_inbox BEFORE INSERT ON weixin_inbox WHEN NEW.text='rollback' BEGIN SELECT RAISE(ABORT, 'rollback'); END");
    assert.throws(() => f.bridge.ingest(inbound({ id: 'rollback', text: 'rollback' })), /rollback/);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM weixin_inbox').get().n, 1);
    assert.equal(f.bridge.read().cursor, 'cursor-once');
  } finally { f.close(); }
});

test('binding starts at the current history cursor, then captures only 林晓薇 non-story replies and merges contiguous parts', () => {
  const f = fixture();
  try {
    f.store.addAssistantMessage('miyue', '旧回复', 'weixin');
    bind(f.bridge);
    f.bridge.capture();
    assert.equal(outbox(f.store).length, 0, 'existing chat history must not be sent when binding');

    f.store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)').run('new-turn', 'miyue', 'user', '继续说吧。', 'chat', new Date().toISOString());
    const first = f.store.addAssistantMessage('miyue', '第一段', 'weixin');
    const second = f.store.addAssistantMessage('miyue', '第二段', 'weixin');
    f.store.addAssistantMessage('wenxi', '闻溪不应发送');
    f.store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)').run('story-choice', 'miyue', 'user', '继续故事。', 'story', new Date().toISOString());
    f.store.db.prepare("INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)").run('story-reply', 'miyue', 'assistant', '故事不应发送', 'story', new Date(Date.now()).toISOString());
    f.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run('2026-01-01T08:00:00.000Z', first.id);
    f.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run('2026-01-01T08:00:20.000Z', second.id);
    f.bridge.capture();
    const rows = outbox(f.store);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'reply');
    assert.equal(rows[0].text, '第一段\n\n第二段');
    assert.deepEqual(JSON.parse(rows[0].message_ids), [first.id, second.id]);
  } finally { f.close(); }
});

test('an outbound reply waits for fresh context, and an inbound message wakes it for delivery', async () => {
  const f = fixture();
  try {
    bind(f.bridge);
    f.store.addAssistantMessage('miyue', '等你先说一句。', 'weixin');
    f.bridge.capture();
    await f.bridge.deliver();
    assert.equal(outbox(f.store)[0].state, 'waiting_context');

    f.bridge.ingest(inbound({ id: 'fresh-context', context: 'ctx-fresh' }));
    assert.equal(outbox(f.store)[0].state, 'pending');
    await f.bridge.deliver();
    assert.equal(outbox(f.store)[0].state, 'sent');
    assert.equal(f.calls.sent.length, 1);
    assert.equal(f.calls.sent[0].contextToken, 'ctx-fresh');
  } finally { f.close(); }
});

test('actual normalized send failures are retained as errors, and a sending row after restart becomes uncertain', async () => {
  const f = fixture({ client: { async sendText() { const error = new Error('微信请求过于频繁，请稍后再试。'); error.code = 'WEIXIN_RATE_LIMITED'; error.uncertain = false; throw error; } } });
  try {
    bind(f.bridge);
    f.bridge.ingest(inbound());
    f.store.addAssistantMessage('miyue', '会发送失败', 'weixin');
    f.bridge.capture();
    await f.bridge.deliver();
    assert.equal(outbox(f.store)[0].state, 'failed');
    assert.match(f.bridge.snapshot().lastError, /请求过于频繁/);
    const failedSnapshot = f.bridge.snapshot();
    assert.equal(failedSnapshot.failedCount, 1);
    assert.equal(failedSnapshot.uncertainCount, 0);

    f.store.db.prepare("UPDATE weixin_outbox SET state='sending',error=NULL WHERE id=?").run(outbox(f.store)[0].id);
    const restarted = new WeixinBridge(f.store, { client: f.client, submit: () => {}, clock: () => new Date() });
    assert.equal(outbox(f.store)[0].state, 'uncertain');
    const uncertainSnapshot = restarted.snapshot();
    assert.equal(uncertainSnapshot.failedCount, 0);
    assert.equal(uncertainSnapshot.uncertainCount, 1);
    await restarted.deliver();
    assert.equal(outbox(f.store)[0].state, 'uncertain', 'uncertain sends must not be replayed automatically');
  } finally { f.close(); }
});

test('disabling proactive cancels only proactive work; pausing or disconnecting keeps chat while disconnect clears credentials and snapshots never expose a token', () => {
  const f = fixture();
  try {
    bind(f.bridge);
    f.store.setChatChannel('miyue', 'weixin');
    f.store.addAssistantMessage('miyue', '主动问候', 'weixin');
    f.store.db.prepare("UPDATE messages SET kind='proactive' WHERE rowid=(SELECT MAX(rowid) FROM messages)").run();
    f.bridge.capture();
    assert.equal(outbox(f.store)[0].kind, 'proactive');
    f.bridge.updateSettings({ proactiveEnabled: false });
    assert.equal(outbox(f.store)[0].state, 'cancelled');

    f.store.addAssistantMessage('miyue', '聊天仍在', 'weixin');
    const before = f.store.getMessages('miyue').map(row => row.text);
    f.bridge.updateSettings({ enabled: false });
    assert.equal(f.bridge.snapshot().state, 'paused');
    assert.equal(f.bridge.read().token, 'secret-token');
    assert.deepEqual(f.store.getMessages('miyue').map(row => row.text), before);

    const snapshot = f.bridge.disconnect();
    assert.equal(f.bridge.read().token, null);
    assert.equal(f.bridge.read().userId, null);
    assert.equal(snapshot.configured, false);
    assert.equal(JSON.stringify(snapshot).includes('secret-token'), false);
    assert.deepEqual(f.store.getMessages('miyue').map(row => row.text), before);
  } finally { f.close(); }
});

test('start long-polls, ingests the bound peer, delivers after a tick, and stop aborts the next poll', async () => {
  let polls = 0, abortSeen = false;
  const f = fixture({ client: { async getUpdates({ signal }) {
    polls += 1;
    if (polls === 1) return inbound({ id: 'polled', text: '轮询来的消息', context: 'polled-context' });
    return new Promise(resolve => signal.addEventListener('abort', () => { abortSeen = true; resolve({ cursor: 'stopped', messages: [] }); }, { once: true }));
  } } });
  try {
    bind(f.bridge); f.bridge.start();
    await waitFor(() => f.calls.submitted.length === 1, 'polling should submit the inbound message');
    assert.deepEqual(f.calls.submitted.map(row => ({ role: row.role, text: row.text })), [{ role: 'miyue', text: '轮询来的消息' }]);
    f.store.addAssistantMessage('miyue', '这是轮询后的回复。', 'weixin');
    await f.bridge.tick();
    assert.equal(f.calls.sent.length, 1);
    assert.equal(f.calls.sent[0].contextToken, 'polled-context');
    await waitFor(() => polls >= 2, 'the long-poll loop should issue a follow-up request');
    await f.bridge.stop();
    assert.equal(abortSeen, true);
    assert.equal(f.bridge.pollTask, null);
  } finally { await f.bridge.stop(); f.close(); }
});

test('a rate-limited send is retried three times at its persisted deadlines, then remains failed', async () => {
  let sends = 0;
  const f = fixture({ client: { async sendText() { sends += 1; const error = new Error('请稍后重试'); error.code = 'WEIXIN_RATE_LIMITED'; error.retryable = true; error.uncertain = false; throw error; } } });
  try {
    bind(f.bridge); f.bridge.ingest(inbound({ context: 'rate-context' }));
    f.store.addAssistantMessage('miyue', '有节制地重试。', 'weixin'); f.bridge.capture();
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await f.bridge.deliver();
      const row = outbox(f.store)[0];
      assert.equal(row.attempts, attempt);
      if (attempt < 3) {
        assert.equal(row.state, 'pending');
        assert.ok(row.next_at > f.bridge.now());
        f.advance(row.next_at - f.bridge.now());
      } else assert.equal(row.state, 'failed');
    }
    assert.equal(sends, 3);
    await f.bridge.deliver();
    assert.equal(sends, 3, 'a terminal rate failure must not continue retrying');
  } finally { f.close(); }
});

test('an auth-expired send suspends later queued sends until reconnect', async () => {
  let sends = 0;
  const f = fixture({ client: { async sendText() { sends += 1; const error = new Error('登录已过期'); error.code = 'WEIXIN_SESSION_EXPIRED'; error.uncertain = false; throw error; } } });
  try {
    bind(f.bridge); f.bridge.ingest(inbound({ context: 'auth-context' }));
    const first = f.store.addAssistantMessage('miyue', '第一条', 'weixin');
    f.store.db.prepare("INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)").run('wx-break', 'miyue', 'user', '分隔', 'chat', new Date(f.bridge.now()).toISOString());
    const second = f.store.addAssistantMessage('miyue', '第二条', 'weixin');
    f.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(new Date(f.bridge.now()).toISOString(), first.id);
    f.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(new Date(f.bridge.now() + 61_000).toISOString(), second.id);
    f.bridge.capture(); assert.equal(outbox(f.store).length, 2);
    await f.bridge.deliver();
    assert.equal(f.bridge.snapshot().state, 'auth_expired');
    assert.equal(sends, 1);
    await f.bridge.deliver();
    assert.equal(sends, 1);
    assert.equal(outbox(f.store)[1].state, 'pending');
  } finally { f.close(); }
});

test('disconnecting or reconnecting during a send cannot let the old session mutate state', async () => {
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const f = fixture({ client: { async sendText() { started(); await blocked; return { messageId: 'late' }; } } });
  try {
    bind(f.bridge); f.bridge.ingest(inbound({ context: 'old-context' }));
    f.store.addAssistantMessage('miyue', '不能串到新会话。', 'weixin'); f.bridge.capture();
    const oldRow = outbox(f.store)[0]; const delivering = f.bridge.deliver();
    await began;
    f.bridge.disconnect();
    bind(f.bridge);
    release(); await delivering;
    assert.equal(f.store.db.prepare('SELECT state FROM weixin_outbox WHERE id=?').get(oldRow.id).state, 'cancelled');
    assert.equal(f.bridge.read().session, 3);
    assert.equal(f.bridge.read().lastOutboundAt, null);
    assert.equal(f.bridge.snapshot().configured, true);
  } finally { f.close(); }
});


test('desktop replies never enter Weixin outbox, including between Weixin reply segments', async () => {
  const f = fixture();
  try {
    bind(f.bridge); f.bridge.ingest(inbound());
    f.store.addAssistantMessage('miyue', '桌面回复');
    f.bridge.capture(); await f.bridge.deliver();
    assert.equal(outbox(f.store).length, 0);
    assert.equal(f.bridge.read().messageCursor, f.bridge.latestRow());
    f.store.addAssistantMessage('miyue', '微信第一轮', 'weixin');
    f.store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)').run('next-turn', 'miyue', 'user', '接着聊。', 'chat', new Date().toISOString());
    f.store.addAssistantMessage('miyue', '桌面第二轮');
    f.store.addAssistantMessage('miyue', '微信第三轮', 'weixin');
    f.bridge.capture(); await f.bridge.deliver(); await f.bridge.deliver();
    assert.deepEqual(f.calls.sent.map(row => row.text), ['微信第一轮', '微信第三轮']);
    assert.equal(f.store.getMessages('miyue').filter(row => row.speaker === 'assistant').length, 4);
  } finally { f.close(); }
});

test('delayed chunks retain their own route after restart and a channel switch', () => {
  const f = fixture();
  try {
    bind(f.bridge);
    const delivery = new ReplyDelivery(f.store);
    delivery.enqueue('miyue', ['微信续段'], null, 'weixin');
    delivery.enqueue('miyue', ['桌面续段']);
    f.store.setChatChannel('miyue', 'desktop');
    const restarted = new ReplyDelivery(f.store);
    for (let i = 0; i < 2; i++) {
      f.store.db.prepare('UPDATE reply_delivery SET due_at=0').run();
      restarted.tick();
    }
    f.bridge.capture();
    assert.deepEqual(outbox(f.store).map(row => row.text), ['微信续段']);
    assert.deepEqual(f.store.getMessages('miyue').map(row => row.text), ['微信续段', '桌面续段']);
  } finally { f.close(); }
});

test('switching to desktop suppresses new and queued proactive Weixin messages', async () => {
  const f = fixture();
  try {
    bind(f.bridge); f.bridge.ingest(inbound());
    f.store.setChatChannel('miyue', 'weixin');
    const first = f.store.addAssistantMessage('miyue', '已排队的问候');
    f.store.db.prepare("UPDATE messages SET kind='proactive' WHERE id=?").run(first.id);
    f.bridge.capture();
    assert.equal(outbox(f.store).length, 1);
    f.store.setChatChannel('miyue', 'desktop');
    const second = f.store.addAssistantMessage('miyue', '桌面期间的问候');
    f.store.db.prepare("UPDATE messages SET kind='reminder' WHERE id=?").run(second.id);
    f.bridge.capture(); await f.bridge.deliver();
    assert.equal(outbox(f.store).length, 1);
    assert.equal(outbox(f.store)[0].state, 'cancelled');
    assert.equal(f.calls.sent.length, 0);
    assert.equal(f.store.getMessages('miyue').length, 2);
  } finally { f.close(); }
});

test('session reminder commitments keep their Weixin origin across channel and proactive setting changes', async () => {
  const f = fixture();
  try {
    bind(f.bridge); f.bridge.ingest(inbound());
    f.store.setChatChannel('miyue', 'desktop');
    f.bridge.updateSettings({ proactiveEnabled: false });
    for (const [channel, text] of [['weixin', '带伞'], ['desktop', '关窗']]) {
      const userText = `一小时后提醒我${text}`;
      const actions = sessionReminderActions({ store: f.store, roleId: 'miyue', userText, replyChannel: channel, clock: () => new Date(Date.UTC(2026, 0, 1, 8)) });
      actions.prepare({ action: 'create', text, dueAt: '2026-01-01T09:00:00.000Z', evidence: userText });
      actions.commit();
    }
    const delivered = f.store.deliverDueReminders(new Date('2026-01-01T10:00:00.000Z'));
    const commitment = delivered.find(row => row.originChannel === 'weixin').message;
    f.bridge.capture();
    assert.equal(outbox(f.store).length, 1);
    assert.equal(outbox(f.store)[0].kind, 'commitment');
    assert.deepEqual(JSON.parse(outbox(f.store)[0].message_ids), [commitment.id]);
    await f.bridge.deliver();
    assert.equal(outbox(f.store)[0].state, 'sent');
    assert.deepEqual(f.calls.sent.map(row => row.text), ['提醒你：\n带伞']);
  } finally { f.close(); }
});

test('a Weixin authentication failure leaves a commitment failed and never reroutes it', async () => {
  const f = fixture({ client: { async sendText() { throw Object.assign(new Error('登录已失效'), { code: 'AUTH_EXPIRED', sessionExpired: true }); } } });
  try {
    bind(f.bridge); f.bridge.ingest(inbound());
    const commitment = f.store.addAssistantMessage('miyue', '提醒你：\n吃药', 'weixin');
    f.store.db.prepare("UPDATE messages SET kind='session_reminder' WHERE id=?").run(commitment.id);
    f.bridge.capture(); await f.bridge.deliver();
    assert.equal(outbox(f.store)[0].kind, 'commitment');
    assert.equal(outbox(f.store)[0].state, 'failed');
    assert.equal(f.bridge.read().lastErrorCode, 'auth_expired');
    assert.equal(f.store.db.prepare('SELECT reply_channel FROM messages WHERE id=?').get(commitment.id).reply_channel, 'weixin');
    await f.bridge.deliver();
    assert.equal(outbox(f.store)[0].attempts, 1);
  } finally { f.close(); }
});

test('a commitment becoming due while Weixin is paused is queued on resume without replaying ordinary history', async () => {
  const f = fixture();
  try {
    bind(f.bridge); f.bridge.ingest(inbound());
    f.bridge.updateSettings({ enabled: false });
    const userText = '一小时后提醒我喝水';
    const actions = sessionReminderActions({ store: f.store, roleId: 'miyue', userText, replyChannel: 'weixin', clock: () => new Date(Date.UTC(2026, 0, 1, 8)) });
    actions.prepare({ action: 'create', text: '喝水', dueAt: '2026-01-01T09:00:00.000Z', evidence: userText });
    actions.commit();
    const delivered = f.store.deliverDueReminders(new Date('2026-01-01T10:00:00.000Z'));
    assert.equal(delivered.length, 1);
    f.store.addAssistantMessage('miyue', '暂停期间的普通旧回复', 'weixin');
    f.bridge.capture();
    assert.equal(outbox(f.store).length, 0);

    f.bridge.updateSettings({ enabled: true });
    const queued = outbox(f.store);
    assert.equal(queued.length, 1);
    assert.equal(queued[0].kind, 'commitment');
    assert.deepEqual(JSON.parse(queued[0].message_ids), [delivered[0].message.id]);
    await f.bridge.deliver();
    assert.equal(queued[0].text, '提醒你：\n喝水');
    assert.deepEqual(f.calls.sent.map(row => row.text), ['提醒你：\n喝水']);
  } finally { f.close(); }
});

test('legacy queued replies without Weixin routing are cancelled before delivery', async () => {
  const f = fixture();
  try {
    bind(f.bridge); f.bridge.ingest(inbound());
    const message = f.store.addAssistantMessage('miyue', '旧版排队的桌面消息', 'weixin');
    f.bridge.capture();
    f.store.db.prepare("UPDATE messages SET reply_channel='desktop' WHERE id=?").run(message.id);
    await f.bridge.deliver();
    assert.equal(outbox(f.store)[0].state, 'cancelled');
    assert.equal(f.calls.sent.length, 0);
  } finally { f.close(); }
});


test('older databases migrate unmarked messages and pending chunks to desktop without losing history', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weixin-route-migration-'));
  const old = new DatabaseSync(path.join(dataDir, 'life.sqlite'));
  old.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY,role TEXT NOT NULL,speaker TEXT NOT NULL,text TEXT NOT NULL,kind TEXT NOT NULL,content_id TEXT,created_at TEXT NOT NULL);
    INSERT INTO messages VALUES('legacy','miyue','assistant','原来的聊天','chat',NULL,'2026-01-01T00:00:00.000Z');
    CREATE TABLE reply_delivery(id TEXT PRIMARY KEY,role_id TEXT NOT NULL,text TEXT NOT NULL,scope TEXT,due_at INTEGER NOT NULL,state TEXT NOT NULL);
    INSERT INTO reply_delivery VALUES('legacy-chunk','miyue','原来的续段',NULL,0,'pending');`);
  old.close();
  const store = new Store({dataDir, story});
  try {
    const delivery = new ReplyDelivery(store);
    delivery.tick();
    assert.deepEqual(store.getMessages('miyue').map(row => row.text), ['原来的聊天', '原来的续段']);
    assert.deepEqual(store.db.prepare('SELECT reply_channel FROM messages').all().map(row => row.reply_channel), ['desktop', 'desktop']);
    assert.equal(store.chatChannel('miyue'), 'desktop');
  } finally { store.close(); fs.rmSync(dataDir, {recursive:true, force:true}); }
});
