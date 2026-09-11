import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { WeixinBridge } from '../lib/weixin-bridge.mjs';

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

test('Weixin bridge only accepts the bound user and submits every inbound turn to 林雨薇', () => {
  const f = fixture();
  try {
    bind(f.bridge);
    f.bridge.ingest(inbound({ id: 'outsider', from: 'someone-else', text: '别理我' }));
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM weixin_inbox').get().n, 0);
    assert.equal(f.bridge.read().cursor, 'cursor-outsider');

    f.bridge.ingest(inbound({ id: 'owner', text: '只找雨薇' }));
    f.bridge.drainInbox();
    assert.deepEqual(f.calls.submitted, [{ role: 'miyue', text: '只找雨薇', id: f.calls.submitted[0].id }]);
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

test('binding starts at the current history cursor, then captures only 林雨薇 non-story replies and merges contiguous parts', () => {
  const f = fixture();
  try {
    f.store.addAssistantMessage('miyue', '旧回复');
    bind(f.bridge);
    f.bridge.capture();
    assert.equal(outbox(f.store).length, 0, 'existing chat history must not be sent when binding');

    const first = f.store.addAssistantMessage('miyue', '第一段');
    const second = f.store.addAssistantMessage('miyue', '第二段');
    f.store.addAssistantMessage('wenxi', '闻溪不应发送');
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
    f.store.addAssistantMessage('miyue', '等你先说一句。');
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
    f.store.addAssistantMessage('miyue', '会发送失败');
    f.bridge.capture();
    await f.bridge.deliver();
    assert.equal(outbox(f.store)[0].state, 'failed');
    assert.match(f.bridge.snapshot().lastError, /请求过于频繁/);

    f.store.db.prepare("UPDATE weixin_outbox SET state='sending',error=NULL WHERE id=?").run(outbox(f.store)[0].id);
    const restarted = new WeixinBridge(f.store, { client: f.client, submit: () => {}, clock: () => new Date() });
    assert.equal(outbox(f.store)[0].state, 'uncertain');
    assert.equal(restarted.snapshot().failedCount, 1);
  } finally { f.close(); }
});

test('disabling proactive cancels only proactive work; pausing or disconnecting keeps chat while disconnect clears credentials and snapshots never expose a token', () => {
  const f = fixture();
  try {
    bind(f.bridge);
    f.store.addAssistantMessage('miyue', '主动问候');
    f.store.db.prepare("UPDATE messages SET kind='proactive' WHERE rowid=(SELECT MAX(rowid) FROM messages)").run();
    f.bridge.capture();
    assert.equal(outbox(f.store)[0].kind, 'proactive');
    f.bridge.updateSettings({ proactiveEnabled: false });
    assert.equal(outbox(f.store)[0].state, 'cancelled');

    f.store.addAssistantMessage('miyue', '聊天仍在');
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
    f.store.addAssistantMessage('miyue', '这是轮询后的回复。');
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
    f.store.addAssistantMessage('miyue', '有节制地重试。'); f.bridge.capture();
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
    const first = f.store.addAssistantMessage('miyue', '第一条');
    f.store.db.prepare("INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)").run('wx-break', 'miyue', 'user', '分隔', 'chat', new Date(f.bridge.now()).toISOString());
    const second = f.store.addAssistantMessage('miyue', '第二条');
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
    f.store.addAssistantMessage('miyue', '不能串到新会话。'); f.bridge.capture();
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
