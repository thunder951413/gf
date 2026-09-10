import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LifeTopicRepository, ORDINARY_ANGLES, PUBLIC_DESTINATIONS, TRAVEL_ANGLES } from '../lib/life-topics.mjs';

class TestStore {
  constructor(filename = ':memory:') { this.db = new DatabaseSync(filename); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}

const travel = (overrides = {}) => ({
  id: 'trip-1', type: 'travel', category: 'travel', destination: '泉州',
  title: '一段含私人安排的旅程', sourceHints: ['绝不能泄漏的私人长句'], fictionalCanon: true,
  phase: { id: 'plan' }, ...overrides,
});

test('travel topics advance on delivery rather than event phase and repeated reads are stable', () => {
  const store = new TestStore();
  const repo = new LifeTopicRepository(store, { clock: () => new Date('2026-09-06T00:00:00Z') });
  const first = repo.get(travel());
  const rows = () => store.db.prepare('SELECT COUNT(*) n FROM life_topic_events').get().n;
  assert.equal(rows(), 1);
  assert.deepEqual(repo.get(travel()), first);
  assert.equal(rows(), 1);
  assert.equal(first.angle.id, 'food');
  assert.equal(first.angles.length, TRAVEL_ANGLES.length);
  assert.equal(first.angles[0].shared, false);
  assert.equal(repo.get(travel({ phase: { id: 'away' } })).topicKey, first.topicKey);
  assert.equal(repo.markDelivered('miyue', first.topicKey, 'message-1'), true);
  assert.equal(repo.markDelivered('miyue', first.topicKey, 'message-1'), false);
  const advanced = repo.get(travel({ phase: { id: 'return' } }));
  assert.equal(advanced.angle.id, 'culture');
  assert.equal(advanced.angles[0].shared, true);
  store.close();
});

test('deliveries survive restart, event switches retain independent progress, and invalid claims fail', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'life-topics-'));
  const filename = path.join(directory, 'topics.sqlite');
  let store = new TestStore(filename);
  let repo = new LifeTopicRepository(store);
  const firstKey = repo.get(travel()).topicKey;
  assert.equal(repo.markDelivered('miyue', 'life-topic:trip-1:culture', 'too-early'), false);
  assert.equal(repo.markDelivered('miyue', firstKey, 'm1'), true);
  assert.equal(repo.get(travel({ id: 'trip-2', destination: '成都' })).angle.id, 'food');
  store.close();

  store = new TestStore(filename);
  repo = new LifeTopicRepository(store);
  assert.equal(repo.get(travel()).angle.id, 'culture');
  assert.equal(repo.get(travel({ id: 'trip-2', destination: '成都' })).angle.id, 'food');
  assert.equal(repo.markDelivered('miyue', 'life-topic:missing:food', 'm2'), false);
  assert.equal(repo.markDelivered('miyue', 'life-topic:trip-1:not-real', 'm3'), false);
  const colonEvent = travel({ id: 'trip:with:colon' });
  const colonTopic = repo.get(colonEvent).topicKey;
  assert.equal(repo.markDelivered('miyue', colonTopic, 'm4'), true);
  assert.equal(repo.get(colonEvent).angle.id, 'culture');
  store.close();
  fs.rmSync(directory, { recursive: true });
});

test('public research fields use only curated destinations and generic labels', () => {
  const store = new TestStore();
  const repo = new LifeTopicRepository(store);
  const known = repo.get(travel());
  assert.equal(known.publicQuery, '泉州 美食 饮食文化');
  assert.deepEqual(known.sourceHints, ['泉州', '美食', '饮食文化']);
  assert.ok(known.sourceHints.every((hint) => !hint.includes('私人') && !hint.includes('旅程')));
  const unfamiliar = repo.get(travel({ id: 'secret', destination: '我家门牌号', title: '秘密约会', sourceHints: ['机密'] }));
  assert.equal(unfamiliar.publicQuery, null);
  assert.ok(!JSON.stringify(unfamiliar.sourceHints).match(/我家|秘密|机密/));
  assert.deepEqual([...PUBLIC_DESTINATIONS].sort(), ['苏州', '扬州', '南京', '无锡', '杭州', '丽江', '大理', '成都', '泉州'].sort());
  store.close();
});

test('catalog covers rich travel and ordinary category angles', () => {
  const categories = ['meal', 'cooking', 'clothing', 'commute', 'hobby', 'family', 'work', 'local_walk', 'reading', 'emotional_need'];
  assert.ok(TRAVEL_ANGLES.length >= 6);
  assert.ok(['food', 'culture', 'daily-life', 'history', 'nature', 'tourism-tradeoffs'].every((id) => TRAVEL_ANGLES.some((a) => a.id === id)));
  assert.deepEqual(Object.keys(ORDINARY_ANGLES).sort(), categories.sort());
  assert.ok(Object.values(ORDINARY_ANGLES).every((angles) => angles.length >= 3 && angles.length <= 4));
  const store = new TestStore();
  const repo = new LifeTopicRepository(store);
  for (const category of categories) {
    const result = repo.get({ id: `ordinary-${category}`, type: 'ordinary', category, title: `私人${category}`, sourceHints: ['私密'] });
    assert.ok(result.context.includes(result.angle.title));
    assert.equal(result.publicQuery.startsWith('苏州 '), true);
    assert.ok(!result.publicQuery.includes('私人'));
  }
  store.close();
});

test('exhaustion keeps useful background without resetting or replaying', () => {
  const store = new TestStore();
  const repo = new LifeTopicRepository(store);
  for (let i = 0; i < TRAVEL_ANGLES.length; i += 1) {
    const current = repo.get(travel());
    assert.equal(repo.markDelivered('miyue', current.topicKey, `message-${i}`), true);
  }
  const exhausted = repo.get(travel());
  assert.equal(exhausted.topicKey, null);
  assert.equal(exhausted.angle, null);
  assert.equal(exhausted.publicQuery, null);
  assert.equal(exhausted.angles.length, TRAVEL_ANGLES.length);
  assert.ok(exhausted.angles.every((angle) => angle.shared));
  assert.match(exhausted.context, /泉州.*旅行/);
  assert.doesNotMatch(exhausted.context, /正在泉州旅行/);
  assert.match(exhausted.context, /已经聊过/);
  assert.equal(repo.get(travel()).topicKey, null);
  store.close();
});

test('null events are inert and only miyue is active', () => {
  const store = new TestStore();
  const repo = new LifeTopicRepository(store);
  assert.deepEqual(repo.get(null), { context: '', topicKey: null, sourceHints: [], publicQuery: null, angle: null, angles: [], eventKey: null });
  assert.equal(repo.get(travel(), 'other'), null);
  assert.equal(repo.markDelivered('other', 'life-topic:trip-1:food', 'm1'), false);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM life_topic_events').get().n, 0);
  store.close();
});
