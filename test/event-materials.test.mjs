import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { EventMaterials } from '../lib/event-materials.mjs';

class Store {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec('CREATE TABLE messages(id TEXT PRIMARY KEY,role TEXT,speaker TEXT,text TEXT,kind TEXT)'); }
  getMessage(id) { return this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) || null; }
  transaction(fn) { this.db.exec('BEGIN'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
}
const event = (id, phase = 'doing', startedAt = '2026-09-12T00:00:00.000Z', patch = {}) => ({ id, instanceStartedAt: startedAt, phase, title: `event ${id}`, detail: '最初的具体内容', state: { untouched: true, updatedAt: '2026-09-12T10:00:00.000Z', count: 1 }, ...patch });
const fixture = t => { let now = new Date('2026-09-12T10:00:00.000Z'); const store = new Store(); for (const [id, role = 'miyue', speaker = 'assistant', kind = 'chat'] of [['a'], ['b'], ['user', 'miyue', 'user'], ['other', 'wenxi']]) store.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(id, role, speaker, 'saved', kind); const repo = new EventMaterials(store, { clock: () => now }); t.after(() => store.db.close()); return { store, repo, set: value => { now = new Date(value); } }; };

test('select is read-only, deterministic, and clamps its bounded candidate count', t => {
  const { store, repo } = fixture(t), events = [event('first'), event('second'), event('third'), event('fourth')], before = structuredClone(events);
  assert.deepEqual(repo.select(events, { limit: 99 }).map(item => item.id), ['first', 'second', 'third']);
  assert.deepEqual(repo.select(events, { limit: 0 }).map(item => item.id), ['first']);
  assert.deepEqual(events, before);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM companion_event_materials').get().count, 0);
});

test('an exposure remains suppressed across days, while explicit follow-up may request it again', t => {
  const { repo, set } = fixture(t), first = event('first'), second = event('second');
  repo.record([first], 'a');
  assert.deepEqual(repo.select([first, second]).map(item => item.id), ['second']);
  repo.record([second], 'a');
  set('2026-09-20T10:00:00.000Z'); assert.deepEqual(repo.select([first, second]), []);
  assert.deepEqual(repo.select([first, second], { explicit: true, limit: 2 }).map(item => item.id), ['first', 'second']);
});

test('generic paused and recent lifecycle churn does not renew an already exposed instance', t => {
  const { repo } = fixture(t), current = event('trip', 'away');
  repo.record([current], 'a');
  const pollingOnly = event('trip', 'away', '2026-09-12T00:00:00.000Z', { updatedAt: '2026-09-18T00:00:00.000Z', state: { untouched: true, updatedAt: '2026-09-18T00:00:00.000Z', count: 999 } });
  const paused = event('trip', 'paused', '2026-09-12T00:00:00.000Z', { detail: '暂时搁着。' });
  const recent = event('trip', 'recent', '2026-09-12T00:00:00.000Z', { detail: '事情告一段落，留下一点余味。' });
  assert.equal(repo.key(current), repo.key(pollingOnly));
  assert.deepEqual(repo.select([pollingOnly]), []);
  assert.deepEqual(repo.select([paused]), []);
  assert.deepEqual(repo.select([recent]), []);
  assert.deepEqual(repo.select([recent], { explicit: true }).map(item => item.phase), ['recent']);
});

test('completion and changed active content remain material opportunities', t => {
  const { repo } = fixture(t), current = event('trip', 'doing');
  repo.record([current], 'a');
  const revised = event('trip', 'doing', '2026-09-12T00:00:00.000Z', { detail: '行程已改到山塘街散步' });
  const changedChoice = event('trip', 'doing', '2026-09-12T00:00:00.000Z', { choice: { selected: '靠窗的位置', adopted: true } });
  const arrived = event('trip', 'arrived');
  const home = event('trip', 'home');
  assert.deepEqual(repo.select([revised]).map(item => item.detail), ['行程已改到山塘街散步']);
  assert.deepEqual(repo.select([changedChoice]).map(item => item.choice.selected), ['靠窗的位置']);
  assert.deepEqual(repo.select([arrived]).map(item => item.phase), ['arrived']);
  assert.deepEqual(repo.select([home]).map(item => item.phase), ['home']);
});

test('meaningful facts inside a phase object remain part of active material', t => {
  const { repo } = fixture(t);
  const first = event('trip', { id: 'doing', label: '正在做', detail: '正在比较两条路线。', activity: '看地图' });
  const revised = event('trip', { id: 'doing', label: '仍在进行', detail: '决定沿河散步。', activity: '出门', result: '选了河边' });
  repo.record([first], 'a');
  assert.notEqual(repo.key(first), repo.key(revised));
  assert.deepEqual(repo.select([revised]), [revised]);
});

test('scheduler flags and candidate ranking never turn an unchanged event into new material', t => {
  const { repo } = fixture(t), current = event('trip', 'away');
  repo.record([current], 'a');
  const polled = event('trip', 'away', '2026-09-12T00:00:00.000Z', {
    foreground: false, doing: true, due: true, priority: 99, score: 0.1, weight: 500,
    scheduling: { nextRunAt: '2026-09-20T00:00:00.000Z', priority: 3 }
  });
  assert.equal(repo.key(current), repo.key(polled));
  assert.deepEqual(repo.select([polled]), []);
});

test('old cooldown rows suppress an upgrade-time replay and new records are precise retry-idempotent', t => {
  const { store, repo, set } = fixture(t), item = event('one');
  store.db.prepare('INSERT INTO companion_event_materials VALUES(?,?,?)').run(repo.legacyKey(item), '2026-09-01T00:00:00.000Z', 'a');
  assert.deepEqual(repo.select([item]), []);
  assert.deepEqual(repo.select([item], { explicit: true }).map(value => value.id), ['one']);
  repo.record([item], 'a'); const key = repo.key(item), first = store.db.prepare('SELECT * FROM companion_event_materials WHERE event_key=?').get(key);
  set('2026-09-12T12:00:00.000Z'); repo.record([item], 'a'); repo.record([item], 'b');
  assert.deepEqual(store.db.prepare('SELECT * FROM companion_event_materials WHERE event_key=?').get(key), first);
});

test('source-linked snapshots distinguish supplied material from the saved reply and honor projections', t => {
  const { repo } = fixture(t), first = event('one', 'doing'), revised = event('one', 'doing', '2026-09-12T00:00:00.000Z', { detail: '后来换成了靠窗的位置。' });
  repo.record([first], 'a');
  assert.match(repo.describe(revised), /曾供回复参考/);
  assert.match(repo.context(revised), /保存的实际回复：“saved”/);
  assert.doesNotMatch(repo.describe(revised), /提过/);
  assert.match(repo.describe(revised), /不表示回复一定使用/);
  assert.match(repo.describe(revised), /只补充新的变化/);
  assert.match(repo.describe(revised, { projectSource: row => ({ ...row, text: '保留的回复片段' }) }), /保留的回复片段/);
  assert.equal(repo.describe(revised, { projectSource: () => null }), '');
  assert.deepEqual(repo.select([revised]), [revised]);
});

test('record skips events without a durable source identity', t => {
  const { store, repo } = fixture(t), sourceLess = { id: 'missing-start', phase: 'doing', title: '没有实例' };
  assert.deepEqual(repo.record([sourceLess], 'a'), { count: 0 });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM companion_event_materials').get().count, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM companion_event_material_exposures').get().count, 0);
  assert.equal(repo.describe(sourceLess), '');
});

test('records require a saved Miyue assistant reply and never change event state', t => {
  const { repo } = fixture(t), item = event('one'), before = structuredClone(item);
  for (const id of ['missing', 'user', 'other']) assert.throws(() => repo.record([item], id), { code: 'INVALID_EVENT_MATERIAL' });
  repo.record([item], 'a');
  assert.deepEqual(item, before);
});
