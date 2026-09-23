import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CompanionDynamics } from '../lib/companion-dynamics.mjs';

class TestStore { constructor(file = ':memory:') { this.db = new DatabaseSync(file); this.db.exec('CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,role TEXT,speaker TEXT,text TEXT,hidden INTEGER DEFAULT 0)'); } transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const out = fn(); this.db.exec('COMMIT'); return out; } catch (err) { this.db.exec('ROLLBACK'); throw err; } } getMessage(id) { return this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) || null; } add(id, speaker, text, role = 'miyue') { this.db.prepare('INSERT INTO messages(id,role,speaker,text) VALUES(?,?,?,?)').run(id, role, speaker, text); return this.getMessage(id); } close() { this.db.close(); } }
const change = evidence => ({ assistant_message_id: 'a1', dynamics: { feelings: [{ id: 'f1', label: '想念', intensity: 62, description: '想和你多待一会儿', cause: '刚才的告别', evidence }] } });

test('durable state survives restart and context carries version and natural expression settings', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dynamics-')), file = path.join(dir, 'state.sqlite'); let store = new TestStore(file);
  const rows = [store.add('u1', 'user', '今天先告别，晚点再聊。'), store.add('a1', 'assistant', '刚才告别后，我有点想和你多待一会儿。')];
  let repo = new CompanionDynamics(store, { clock: () => new Date('2026-09-20T00:00:00Z') });
  assert.equal(repo.commit('miyue', change('想和你多待一会儿'), { rows, expectedRevision: 0 }).revision, 1); store.close(); store = new TestStore(file);
  repo = new CompanionDynamics(store, { clock: () => new Date('2026-09-20T01:00:00Z') });
  assert.equal(repo.get().feelings[0].label, '想念'); assert.match(repo.context(), /"stateRevision":1/); assert.match(repo.context(), /热恋时可以自然/); store.close(); fs.rmSync(dir, { recursive: true });
});

test('invalid evidence is stripped, stale revisions reject, and an actual assistant message receipt is idempotent', () => {
  const store = new TestStore(), repo = new CompanionDynamics(store); let rows = [store.add('a1', 'assistant', '我有点想和你多待一会儿。')];
  const bad = repo.commit('miyue', change('不存在'), { rows, expectedRevision: 0 }); assert.equal(bad.revision, 0); assert.equal(bad.rejected[0].reason, 'invalid_evidence');
  rows = [store.add('a2', 'assistant', '我有点想和你多待一会儿。')]; const first = repo.commit('miyue', change('想和你多待一会儿'), { rows, expectedRevision: 0 }); const repeat = repo.commit('miyue', change('想和你多待一会儿'), { rows, expectedRevision: 0 }); assert.deepEqual(repeat, first);
  assert.throws(() => repo.commit('miyue', { dynamics: {} }, { rows: [store.add('a3', 'assistant', '新的回复')], expectedRevision: 0 }), err => err.status === 409); store.close();
});

test('empty or malformed optional dynamics leave state unchanged', () => {
  const store = new TestStore(), repo = new CompanionDynamics(store); assert.deepEqual(repo.commit('miyue', {}, { expectedRevision: 0 }), { accepted: [], rejected: [], revision: 0 });
  assert.equal(repo.commit('miyue', { dynamics: 'bad' }, { expectedRevision: 0 }).revision, 0); assert.equal(repo.get().updatedAt, null); store.close();
});

test('a source projection hides corrected evidence without reviving it', () => {
  const store = new TestStore(), repo = new CompanionDynamics(store, { projectSource: row => row.hidden ? false : row }); const rows = [store.add('a1', 'assistant', '我有点想和你多待一会儿。')];
  repo.commit('miyue', change('想和你多待一会儿'), { rows, expectedRevision: 0 }); assert.equal(repo.get().feelings.length, 1); store.db.prepare('UPDATE messages SET hidden=1 WHERE id=?').run('a1'); assert.equal(repo.get().feelings.length, 0); store.close();
});

test('settings validate strictly and use optimistic revisions', () => {
  const store = new TestStore(), repo = new CompanionDynamics(store); const initial = repo.settings(); assert.equal(initial.city, '苏州');
  const saved = repo.saveSettings({ expressionPreferences: '可以坦率表达喜欢，也可以简短说出不高兴。', dailyDiscoveryCalls: 3 }, 0); assert.equal(saved.revision, 1); assert.equal(saved.dailyDiscoveryCalls, 3);
  assert.throws(() => repo.saveSettings({ city: '' }, 1), err => err.status === 400); assert.throws(() => repo.saveSettings({ city: '杭州' }, 0), err => err.status === 409); store.close();
});

test('resolved threads retain their stable id, progress, cause metadata, and context record', () => {
  const store = new TestStore(), repo = new CompanionDynamics(store, { clock: () => new Date('2026-09-20T00:00:00Z') });
  const rows = [store.add('a-thread', 'assistant', '那本书已经聊完第三章，我想把这个问题先放下。')];
  const proposal = { dynamics: { threads: [{ id: 'book-thread', subject: '那本书', progress: '已经聊完第三章', openQuestion: '', status: 'resolved', evidence: '聊完第三章' }], feelings: [{ id: 'settled', label: '释然', intensity: 40, description: '这件事暂时放下了', cause: '聊完第三章', evidence: '先放下' }] } };
  assert.equal(repo.commit('miyue', proposal, { rows, expectedRevision: 0 }).revision, 1); const saved = repo.get();
  assert.equal(saved.threads[0].id, 'book-thread'); assert.equal(saved.threads[0].status, 'resolved'); assert.equal(saved.threads[0].progress, '已经聊完第三章'); assert.equal(saved.feelings[0].cause, '聊完第三章'); assert.match(repo.context(), /book-thread/); assert.match(repo.context(), /resolved/); store.close();
});
