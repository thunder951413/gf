import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  NEED_CYCLE_DEFAULTS,
  advanceNeedCycle,
  needCycleCandidate,
  needCycleStatus,
  needFulfillment,
} from '../lib/need-cycle.mjs';
import { InnerStateRepository } from '../lib/inner-state.mjs';

const HOUR = 60 * 60 * 1000;

class TestStore {
  constructor() { this.db = new DatabaseSync(':memory:'); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}

function clockAt(initial) {
  let value = new Date(initial);
  const clock = () => new Date(value);
  clock.add = milliseconds => { value = new Date(value.getTime() + milliseconds); };
  return clock;
}

function cycleState(overrides = {}) {
  return {
    ...overrides,
    needCycle: { ...NEED_CYCLE_DEFAULTS, ...overrides.needCycle },
    needClockAt: overrides.needClockAt || '2026-09-10T00:00:00.000Z',
    needRemainders: { ...overrides.needRemainders },
    affectionNeed: overrides.affectionNeed ?? 0,
    desire: overrides.desire ?? 0,
    affection: overrides.affection ?? 80,
    fatigue: overrides.fatigue ?? 20,
    stress: overrides.stress ?? 20,
    relationshipStage: overrides.relationshipStage || '恋爱中',
    intimacyBoundary: overrides.intimacyBoundary || 'open',
    awaitingNeed: overrides.awaitingNeed || null,
    lastNeedContact: overrides.lastNeedContact || null,
    lastTurn: overrides.lastTurn || null,
  };
}

function replaceRaw(store, mutate) {
  const row = store.db.prepare("SELECT state_json FROM inner_states WHERE role_id='miyue'").get();
  const state = JSON.parse(row.state_json);
  mutate(state);
  store.db.prepare("UPDATE inner_states SET state_json=? WHERE role_id='miyue'").run(JSON.stringify(state));
}

test('default cycle fills from zero to 100 and minute ticks retain fractional progress', () => {
  const full = cycleState();
  assert.equal(advanceNeedCycle(full, new Date('2026-09-11T00:00:00.000Z')), true);
  assert.equal(full.affectionNeed, 100);
  assert.equal(full.desire, 50);

  const minute = cycleState({ needCycle: { emotionalHours: 1, physicalHours: 2 } });
  assert.equal(advanceNeedCycle(minute, new Date('2026-09-10T00:00:30.000Z')), false);
  assert.equal(minute.affectionNeed, 0);
  assert.equal(advanceNeedCycle(minute, new Date('2026-09-10T00:01:00.000Z')), true);
  assert.equal(minute.affectionNeed, 1);
  assert.ok(minute.needRemainders.emotional > 0.66);
  advanceNeedCycle(minute, new Date('2026-09-10T00:02:00.000Z'));
  assert.equal(minute.affectionNeed, 3);
  assert.ok(minute.needRemainders.emotional > 0.33);
});

test('status and candidate are deterministic at threshold and respect relationship boundaries and tuning', () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const due = cycleState({ affectionNeed: 85, desire: 85 });
  assert.equal(needCycleStatus(due, now).emotional.due, true);
  assert.equal(needCycleCandidate(due, now).needChannel, 'emotional');
  assert.match(needCycleCandidate(due, now).context, /有点想你/);

  const friends = cycleState({ affectionNeed: 20, desire: 90, relationshipStage: '知心朋友' });
  assert.equal(needCycleCandidate(friends, now).needChannel, 'physical');
  assert.match(needCycleCandidate(friends, now).context, /温柔的拥抱/);
  assert.doesNotMatch(needCycleCandidate(friends, now).context, /接吻/);
  assert.equal(needCycleCandidate({ ...friends, intimacyBoundary: 'friendly' }, now), null);
  assert.equal(needCycleCandidate(friends, now, { flirtation: 0 }), null);
  assert.equal(needCycleCandidate(due, now, { initiative: 0 }), null);
});

test('fatigue softens the expressed wish without making threshold delivery random', () => {
  const state = cycleState({ affectionNeed: 90, desire: 10, fatigue: 70 });
  const candidate = needCycleCandidate(state, new Date('2026-09-10T12:00:00.000Z'));
  assert.equal(candidate.needChannel, 'emotional');
  assert.match(candidate.context, /有点累.*温柔安慰/);
});

test('fulfillment excludes refusals, postponements, and topic/reference discussion', () => {
  const now = new Date('2026-09-10T12:00:00.000Z');
  const state = cycleState({ awaitingNeed: { channel: 'physical', deliveredAt: now.toISOString() } });
  assert.deepEqual(needFulfillment(state, '好', now), ['emotional', 'physical']);
  for (const text of ['不要抱我', '我正忙，晚点再说', '我在开会', '我在忙', '小说里她说“抱抱”是什么意思？']) {
    assert.deepEqual(needFulfillment(state, text, now), [], text);
  }
});

test('repository edits cycle config, freezes disabled needs, and resumes with no disabled-time burst', () => {
  const store = new TestStore(), clock = clockAt('2026-09-10T00:00:00.000Z');
  const repo = new InnerStateRepository(store, { clock, random: () => 0.5 });
  let view = repo.view();
  view = repo.update('miyue', { revision: view.revision, values: { affectionNeed: 10, desire: 20 }, needCycle: { enabled: false, emotionalHours: 1 } });
  clock.add(24 * HOUR);
  const frozen = repo.view();
  assert.deepEqual([frozen.values.affectionNeed, frozen.values.desire], [10, 20]);
  view = repo.update('miyue', { revision: frozen.revision, needCycle: { enabled: true } });
  assert.equal(view.needCycle.emotionalHours, 1);
  assert.deepEqual([view.values.affectionNeed, view.values.desire], [10, 20]);
  clock.add(HOUR);
  assert.deepEqual([repo.view().values.affectionNeed, repo.view().values.desire], [100, 22]);
  store.close();
});

test('repository waits after delivery and applies fixed relief only after a matching user response', () => {
  const store = new TestStore(), clock = clockAt('2026-09-10T12:00:00.000Z');
  const repo = new InnerStateRepository(store, { clock, random: () => 0.5, getRelationship: () => ({ status: { value: 'partners', explicit: true } }) });
  let view = repo.view();
  repo.update('miyue', { revision: view.revision, values: { affectionNeed: 90, desire: 10 }, needCycle: { relief: 35 } });
  const candidate = repo.initiative();
  assert.equal(candidate.needChannel, 'emotional');
  assert.equal(repo.markInitiated('miyue', candidate.key, 'cycle-message'), true);
  const sent = repo.get();
  assert.equal(sent.affectionNeed, 90, 'delivery itself must not fake relief');
  assert.equal(sent.needCycleStatus.awaitingReply, true);
  assert.equal(repo.initiative(), null);
  const replied = repo.afterTurn('miyue', '我在，陪你聊', { tone: 'supportive', closeness: 'unspecified' });
  assert.equal(replied.affectionNeed, 55);
  assert.deepEqual(replied.lastNeedRelief.channels, ['emotional']);
  assert.equal(replied.needCycleStatus.awaitingReply, false);
  store.close();
});

test('refusal and topic change clear awaiting state without recording satisfaction', () => {
  for (const text of ['我正忙，晚点再聊', '我们换个话题聊工作']) {
    const store = new TestStore(), clock = clockAt('2026-09-10T12:00:00.000Z');
    const repo = new InnerStateRepository(store, { clock, random: () => 0.5 });
    repo.view();
    replaceRaw(store, state => {
      state.affectionNeed = 90;
      state.awaitingNeed = { channel: 'emotional', deliveredAt: clock().toISOString() };
      state.lastNeedContact = { ...state.awaitingNeed, messageId: 'message' };
    });
    const result = repo.afterTurn('miyue', text, { tone: 'neutral', closeness: 'unspecified' });
    assert.equal(result.affectionNeed, 90);
    assert.equal(result.awaitingNeed, null);
    assert.equal(result.lastNeedRelief, null);
    store.close();
  }
});

test('restart migration initializes missing clock at now, clamps legacy values, and does not burst', () => {
  const store = new TestStore(), clock = clockAt('2026-09-10T00:00:00.000Z');
  let repo = new InnerStateRepository(store, { clock, random: () => 0.5 });
  repo.view();
  replaceRaw(store, state => {
    state.version = 2;
    delete state.needClockAt;
    state.affectionNeed = 140;
    state.desire = -20;
    state.updatedAt = '2020-01-01T00:00:00.000Z';
  });
  repo = new InnerStateRepository(store, { clock, random: () => 0.5 });
  const migrated = repo.get();
  assert.equal(migrated.needClockAt, clock().toISOString());
  assert.equal(migrated.affectionNeed, 100);
  assert.equal(migrated.desire, 0);
  store.close();
});
