import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { RecallEngine, RecallRepository } from '../lib/recall.mjs';
import { importHistoricalMessages } from './support/history-fixtures.mjs';

const story = { start: 'start', nodes: { start: { id: 'start', title: 'start', body: '', choices: [] } } };
const now = new Date('2026-09-11T12:00:00.000Z');

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-window-'));
  const store = new Store({ dataDir, story, initialFeeds: [] });
  const repo = new RecallRepository(store, { clock: () => now });
  t.after(() => { try { store.close(); } catch {} fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { store, repo };
}

function add(store, { id, role = 'miyue', speaker = 'assistant', text, at, kind = 'chat' }) {
  importHistoricalMessages(store, () => store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,content_id,created_at) VALUES(?,?,?,?,?,NULL,?)')
    .run(id, role, speaker, text, kind, at));
}

class Model {
  constructor() { this.calls = []; }
  publicConfig() { return { configured: true }; }
  async complete(messages, options) { this.calls.push({ messages, options }); return options.roleId==='miyue'?JSON.stringify({items:[],ignored:JSON.parse(messages[1].content).conversation.map(row=>({messageId:row.id,reason:'filler'}))}):JSON.stringify({ summary: '旧消息摘要' }); }
}

test('short term keeps recent raw rows despite a pre-existing summary cursor and preserves whole messages', t => {
  const { store, repo } = fixture(t);
  add(store, { id: 'recent-a', text: '第一条完整原话。', at: '2026-09-10T12:00:00.000Z' });
  add(store, { id: 'recent-b', speaker: 'user', text: '第二条完整原话。', at: '2026-09-11T11:00:00.000Z' });
  repo.replace('miyue', '旧的长期摘要');
  const rows = repo.shortTermConversation('miyue', { now });
  assert.deepEqual(rows.map(row => row.id), ['recent-a', 'recent-b']);
  assert.deepEqual(rows.map(row => row.text), ['第一条完整原话。', '第二条完整原话。']);
  assert.match(repo.longTermContext('miyue', rows), /短期原始对话优先/);
  assert.match(repo.longTermContext('miyue', rows), /旧的长期摘要/);
  assert.equal(repo.get('miyue').summary, '旧的长期摘要');
  repo.store.db.prepare("UPDATE recall_state SET summary_origin='automatic' WHERE role_id='miyue'").run();
  assert.equal(repo.longTermContext('miyue', rows), '');
});

test('ordinary context suppresses an automatic migration summary once grounded memory is available, without deleting it', t => {
  const { store, repo } = fixture(t);
  add(store, { id: 'old-source', speaker: 'user', text: '我喜欢无糖茶。', at: '2026-08-01T00:00:00.000Z' });
  add(store, { id: 'recent-source', text: '最近的完整原话。', at: '2026-09-11T11:00:00.000Z' });
  repo.get('miyue');
  const old = store.db.prepare('SELECT rowid FROM messages WHERE id=?').get('old-source');
  store.db.prepare("UPDATE recall_state SET summary=?, through_rowid=?, through_id=?, summary_origin='automatic' WHERE role_id='miyue'")
    .run('迁移摘要：旧关系判断，不应在普通对话反复注入。', old.rowid, 'old-source');
  // The old rolling cursor is ahead of the ledger during migration, while
  // this grounded item is already usable by the ordinary request projector.
  store.db.prepare('UPDATE consolidated_memory_state SET revision=?, cursor_rowid=?, cursor_id=? WHERE scope=?')
    .run(1, 0, null, 'miyue');
  store.db.prepare(`INSERT INTO consolidated_memories(id,scope,subject,kind,topic,summary,status,evidence_json,first_at,last_at,mentions)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
    'cm-grounded', 'miyue', 'user', 'preference', '饮料口味', '用户喜欢无糖茶。', 'current',
    JSON.stringify([{ messageId: 'old-source', quote: '我喜欢无糖茶。' }]), '2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.000Z', 1,
  );

  const rows = repo.shortTermConversation('miyue', { now });
  const ordinary = repo.longTermContext('miyue', rows);
  assert.match(ordinary, /用户喜欢无糖茶/);
  assert.doesNotMatch(ordinary, /旧关系判断/);
  assert.equal(store.db.prepare('SELECT summary FROM recall_state WHERE role_id=?').get('miyue').summary, '迁移摘要：旧关系判断，不应在普通对话反复注入。');
  assert.match(repo.longTermContext('miyue', rows, { includeLegacy: true }), /旧关系判断/);
});

test('short term has a whole-message size cap and falls back to ten old rows for reconnecting context', t => {
  const { store, repo } = fixture(t);
  add(store, { id: 'large', text: '甲'.repeat(80), at: '2026-09-11T11:00:00.000Z' });
  add(store, { id: 'small', text: '后面的完整消息', at: '2026-09-11T11:01:00.000Z' });
  const capped = repo.shortTermConversation('miyue', { now, chars: 20 });
  assert.deepEqual(capped.map(row => row.id), ['small']);
  assert.equal(capped[0].text, '后面的完整消息');

  const quiet = fixture(t);
  for (let index = 0; index < 12; index += 1) add(quiet.store, { id: `old-${index}`, text: `old-${index}`, at: '2026-08-01T00:00:00.000Z' });
  assert.deepEqual(quiet.repo.shortTermConversation('miyue', { now }).map(row => row.id), Array.from({ length: 10 }, (_, index) => `old-${index + 2}`));
});

test('short term honors role, story scope and persona cutoff while long term remains supplemental', t => {
  const { store, repo } = fixture(t);
  add(store, { id: 'before-cutoff-assistant', text: '不应出现', at: '2026-09-10T12:00:00.000Z' });
  add(store, { id: 'before-cutoff-user', speaker: 'user', text: '用户原话仍可出现', at: '2026-09-10T12:01:00.000Z' });
  add(store, { id: 'other-role', role: 'wenxi', text: '其他角色', at: '2026-09-10T12:02:00.000Z' });
  add(store, { id: 'story-row', text: '故事消息', kind: 'story', at: '2026-09-10T12:03:00.000Z' });
  store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('persona_cutoff:miyue', String(store.db.prepare('SELECT rowid FROM messages WHERE id=?').get('before-cutoff-user').rowid));
  add(store, { id: 'old-qualified', text: '窗口外的旧原话', at: '2026-08-01T00:00:00.000Z' });
  add(store, { id: 'after-cutoff-assistant', text: '新人物原话', at: '2026-09-11T10:00:00.000Z' });
  repo.replace('miyue', '长期摘要仍在');
  const rows = repo.shortTermConversation('miyue', { now });
  assert.deepEqual(rows.map(row => row.id), ['before-cutoff-user', 'after-cutoff-assistant']);
  assert.match(repo.longTermContext('miyue', rows), /短期原始对话优先/);
  assert.doesNotMatch(rows.map(row => row.text).join('\n'), /不应出现|其他角色|故事消息/);
});

test('miyue compaction never summarizes fresh short-term raw rows, even when forced', async t => {
  const { store, repo } = fixture(t);
  for (let index = 0; index < 50; index += 1) add(store, { id: `fresh-${index}`, text: `fresh-${index}`, at: '2026-09-11T10:00:00.000Z' });
  const model = new Model();
  const engine = new RecallEngine({ repo, model, roles: [{ id: 'miyue' }], clock: () => now });
  const result = await engine.run('miyue', { force: true });
  assert.equal(result.reason, 'short-term-window');
  assert.equal(model.calls.length, 0);
  assert.equal(repo.shortTermConversation('miyue', { now }).length, 50);
});

test('the repository clock supplies the default window and an oversized fresh raw row remains protected', async t => {
  const { store, repo } = fixture(t);
  add(store, { id: 'oversized-fresh', text: '甲'.repeat(60_001), at: '2026-09-11T10:00:00.000Z' });
  const model = new Model();
  const engine = new RecallEngine({ repo, model, roles: [{ id: 'miyue' }], clock: () => now });
  assert.deepEqual(repo.shortTermConversation('miyue'), []);
  const result = await engine.run('miyue', { force: true });
  assert.equal(result.reason, 'short-term-window');
  assert.equal(model.calls.length, 0);
});

test('miyue summarizes only older eligible rows and leaves the recent seven-day raw window intact', async t => {
  const { store, repo } = fixture(t);
  for (let index = 0; index < 45; index += 1) add(store, { id: `old-${index}`, text: `old-${index}`, at: '2026-08-01T00:00:00.000Z' });
  for (let index = 0; index < 3; index += 1) add(store, { id: `fresh-${index}`, text: `fresh-${index}`, at: '2026-09-11T10:00:00.000Z' });
  const model = new Model();
  const engine = new RecallEngine({ repo, model, roles: [{ id: 'miyue' }], clock: () => now });
  const result = await engine.run('miyue');
  assert.equal(result.status, 'updated');
  assert.equal(result.summarizedCount, 20);
  const source = model.calls[0].messages[1].content;
  assert.match(source, /old-0/);
  assert.doesNotMatch(source, /fresh-0/);
  assert.deepEqual(repo.shortTermConversation('miyue', { now }).map(row => row.id), ['fresh-0', 'fresh-1', 'fresh-2']);
});

test('other roles retain the existing forced compact behavior', async t => {
  const { store, repo } = fixture(t);
  for (let index = 0; index < 14; index += 1) add(store, { id: `wenxi-${index}`, role: 'wenxi', text: `wenxi-${index}`, at: '2026-09-11T10:00:00.000Z' });
  const model = new Model();
  const engine = new RecallEngine({ repo, model, roles: [{ id: 'wenxi' }], clock: () => now });
  const result = await engine.run('wenxi', { force: true });
  assert.equal(result.status, 'updated');
  assert.equal(result.summarizedCount, 4);
});
