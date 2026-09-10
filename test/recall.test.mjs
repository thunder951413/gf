import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { RecallEngine, RecallRepository } from '../lib/recall.mjs';

const roles = [{ id: 'zhixia' }, { id: 'wenxi' }, { id: 'miyue' }];
const story = { start: 'start', nodes: { start: { id: 'start', title: 'start', body: '', choices: [] } } };

function fixture(t, clock = () => new Date('2026-09-06T12:00:00.000Z')) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-recall-'));
  const store = new Store({ dataDir, story, initialFeeds: [] });
  const repo = new RecallRepository(store, { clock });
  t.after(() => { try { store.close(); } catch {} fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { dataDir, store, repo };
}

function insert(store, role, count, { kind = 'chat', prefix = role, text } = {}) {
  const statement = store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,content_id,created_at) VALUES(?,?,?,?,?,NULL,?)');
  for (let index = 0; index < count; index += 1) {
    statement.run(`${prefix}-${index}`, role, index % 2 ? 'assistant' : 'user', text ? text(index) : `${prefix} message ${index}`, kind, new Date(1_700_000_000_000 + index).toISOString());
  }
}

class FakeModel {
  constructor(result = JSON.stringify({ summary: '累计摘要' })) { this.result = result; this.calls = []; this.configured = true; }
  publicConfig() { return { configured: this.configured }; }
  async complete(messages, options) { this.calls.push({ messages, options }); return typeof this.result === 'function' ? this.result(messages, options) : this.result; }
}

test('repository persists per-role recall and replacement forgets existing transcript rows', (t) => {
  const { dataDir, store, repo } = fixture(t);
  insert(store, 'zhixia', 3);
  insert(store, 'wenxi', 2);
  assert.equal(repo.get('zhixia').pendingCount, 3);
  const replaced = repo.replace('zhixia', '用户喜欢安静的早晨。');
  assert.deepEqual(replaced, {
    roleId: 'zhixia', summary: '用户喜欢安静的早晨。', updatedAt: '2026-09-06T12:00:00.000Z',
    throughId: 'zhixia-2', pendingCount: 0, error: null, revision: 1,
  });
  assert.equal(repo.get('wenxi').summary, '');
  assert.equal(repo.get('wenxi').pendingCount, 2);
  const restarted = new RecallRepository(store, { clock: () => new Date('2026-09-07T00:00:00.000Z') });
  assert.equal(restarted.get('zhixia').summary, '用户喜欢安静的早晨。');
  assert.match(restarted.context('zhixia'), /引用资料/);
  assert.doesNotMatch(restarted.context('zhixia'), /wenxi/);
  assert.equal(fs.existsSync(path.join(dataDir, 'life.sqlite')), true);
});

test('automatic rolling starts at 20, excludes story rows, processes an early batch, and retains ten pending rows', async (t) => {
  const { store, repo } = fixture(t);
  insert(store, 'zhixia', 19);
  insert(store, 'zhixia', 5, { kind: 'story', prefix: 'story' });
  insert(store, 'wenxi', 25, { prefix: 'private' });
  const model = new FakeModel();
  const engine = new RecallEngine({ repo, model, roles });
  assert.equal((await engine.run('zhixia')).reason, 'threshold');
  insert(store, 'zhixia', 1, { prefix: 'last' });
  const result = await engine.run('zhixia');
  assert.equal(result.status, 'updated');
  assert.equal(result.summarizedCount, 10);
  assert.equal(repo.get('zhixia').pendingCount, 10);
  assert.equal(model.calls[0].options.purpose, 'memory');
  assert.equal(model.calls[0].options.roleId, 'zhixia');
  assert.equal(model.calls[0].options.maxTokens, 3000);
  const prompt = model.calls[0].messages.map((message) => message.content).join('\n');
  assert.doesNotMatch(prompt, /story message|private message/);
  assert.match(prompt, /只输出严格 JSON/);
  assert.match(prompt, /当前角色现名阮绵，旧名知夏/);
  assert.doesNotMatch(prompt, /弥月|闻溪/);
  assert.match(prompt, /单方面邀约不能制造双方已经承诺的关系/);
});

test('model failure preserves summary and cursor, stores a sanitized error, and backs off automatic retry', async (t) => {
  let now = new Date('2026-09-06T12:00:00.000Z');
  const clock = () => now;
  const { store, repo } = fixture(t, clock);
  repo.replace('zhixia', '旧摘要');
  insert(store, 'zhixia', 20, { prefix: 'new' });
  const model = new FakeModel(async () => { throw Object.assign(new Error('bad sk-secretABC123 https://private.example/x\ntrace'), { code: 'MODEL_REQUEST_FAILED' }); });
  const engine = new RecallEngine({ repo, model, roles, clock });
  const failed = await engine.run('zhixia');
  assert.equal(failed.status, 'failed');
  assert.equal(repo.get('zhixia').summary, '旧摘要');
  assert.equal(repo.get('zhixia').throughId, null);
  assert.doesNotMatch(repo.get('zhixia').error, /secretABC123|private\.example|\n/);
  assert.equal((await engine.run('zhixia')).reason, 'backoff');
  assert.equal(model.calls.length, 1);
  now = new Date('2026-09-06T12:15:00.000Z');
  await engine.run('zhixia');
  assert.equal(model.calls.length, 2);
});

test('an edit during generation wins optimistic revision comparison', async (t) => {
  const { store, repo } = fixture(t);
  insert(store, 'zhixia', 20);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const model = new FakeModel(async () => { await held; return JSON.stringify({ summary: '过时生成结果' }); });
  const engine = new RecallEngine({ repo, model, roles });
  const pending = engine.run('zhixia');
  while (!model.calls.length) await new Promise((resolve) => setImmediate(resolve));
  const edited = repo.replace('zhixia', '用户刚刚手动编辑的摘要');
  release();
  assert.equal((await pending).status, 'stale');
  assert.equal(repo.get('zhixia').summary, edited.summary);
  assert.equal(repo.get('zhixia').pendingCount, 0);
});

test('long sources stay bounded with an explicit clipping marker and conversation returns only pending role rows', async (t) => {
  let now = new Date('2026-09-06T12:00:00.000Z');
  const clock = () => now;
  const { store, repo } = fixture(t, clock);
  insert(store, 'zhixia', 20, { text: (index) => index === 0 ? `head-${'甲'.repeat(30_000)}-tail` : `short-${index}` });
  insert(store, 'wenxi', 2, { prefix: 'other' });
  const model = new FakeModel();
  const engine = new RecallEngine({ repo, model, roles, clock });
  const first = await engine.run('zhixia');
  assert.equal(first.summarizedCount, 1);
  const quoted = model.calls[0].messages[1].content;
  assert.ok(quoted.length <= 14_000);
  assert.match(quoted, /原消息过长/);
  assert.match(quoted, /head-/);
  assert.match(quoted, /-tail/);
  assert.equal(repo.get('zhixia').pendingCount, 19);
  assert.equal((await engine.run('zhixia')).reason, 'cooldown');
  now = new Date('2026-09-06T12:05:00.000Z');
  const continued = await engine.run('zhixia');
  assert.equal(continued.summarizedCount, 9);
  const tail = repo.conversation('zhixia');
  assert.equal(tail.length, 10);
  assert.ok(tail.reduce((sum, message) => sum + message.text.length, 0) <= 14_000);
  assert.equal(tail.every((message) => !message.id.startsWith('other')), true);
});

test('force compacts below the automatic threshold while keeping a useful ten-message tail', async (t) => {
  const { store, repo } = fixture(t);
  insert(store, 'miyue', 14);
  const model = new FakeModel();
  const engine = new RecallEngine({ repo, model, roles });
  assert.equal((await engine.run('miyue')).reason, 'threshold');
  const forced = await engine.run('miyue', { force: true });
  assert.equal(forced.summarizedCount, 4);
  assert.equal(repo.get('miyue').pendingCount, 10);
});

test('direct and scheduled work coalesces, stop drains it, and stopped engines refuse new runs', async (t) => {
  const { store, repo } = fixture(t);
  insert(store, 'zhixia', 20);
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const model = new FakeModel(async () => { await held; return JSON.stringify({ summary: '完成' }); });
  const engine = new RecallEngine({ repo, model, roles: [roles[0]] });
  const first = engine.run('zhixia', { force: true });
  const duplicate = engine.run('zhixia', { force: true });
  assert.equal(first, duplicate);
  engine.schedule('zhixia');
  while (!model.calls.length) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(engine.status().pendingRoles, ['zhixia']);
  const stopping = engine.stop();
  assert.equal((await engine.run('zhixia', { force: true })).reason, 'stopping');
  release(); await stopping; await first;
  assert.equal(model.calls.length, 1);
  assert.deepEqual(engine.status(), { running: false, pendingRoles: [] });

  insert(store, 'zhixia', 20, { prefix: 'later' });
  assert.equal((await engine.run('zhixia')).reason, 'stopping');
  model.configured = false;
  engine.start();
  assert.equal((await engine.run('zhixia')).reason, 'model-unconfigured');
  await engine.stop();
  assert.equal(model.calls.length, 1);
});

test('empty model summary is a failure that preserves existing recall', async (t) => {
  const { store, repo } = fixture(t);
  repo.replace('zhixia', '不能被空回复擦除的摘要');
  insert(store, 'zhixia', 20, { prefix: 'empty' });
  const model = new FakeModel(JSON.stringify({ summary: '   ' }));
  const engine = new RecallEngine({ repo, model, roles });
  const result = await engine.run('zhixia');
  assert.equal(result.status, 'failed');
  assert.match(result.error, /MEMORY_RESPONSE_EMPTY/);
  assert.equal(repo.get('zhixia').summary, '不能被空回复擦除的摘要');
  assert.equal(repo.get('zhixia').pendingCount, 20);
});

test('successful automatic cooldown survives a repository restart and force bypasses it', async (t) => {
  let now = new Date('2026-09-06T12:00:00.000Z');
  const clock = () => now;
  const { store, repo } = fixture(t, clock);
  insert(store, 'zhixia', 60, { prefix: 'import' });
  const model = new FakeModel();
  const first = new RecallEngine({ repo, model, roles, clock });
  assert.equal((await first.run('zhixia')).summarizedCount, 40);
  const restartedRepo = new RecallRepository(store, { clock });
  const restarted = new RecallEngine({ repo: restartedRepo, model, roles, clock });
  assert.equal((await restarted.run('zhixia')).reason, 'cooldown');
  assert.equal((await restarted.run('zhixia', { force: true })).status, 'updated');
});

test('replacement validates length and never removes raw chats', (t) => {
  const { store, repo } = fixture(t);
  insert(store, 'zhixia', 2);
  assert.throws(() => repo.replace('zhixia', 'x'.repeat(6001)), { code: 'INVALID_RECALL' });
  repo.replace('zhixia', '');
  assert.equal(store.getMessages('zhixia').length, 2);
  assert.deepEqual(repo.conversation('zhixia'), []);
});
