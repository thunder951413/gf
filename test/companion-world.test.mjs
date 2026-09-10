import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCompanionWorld } from '../lib/companion-world.mjs';

const travel = {
  active: {
    id: 'trip-1', type: 'travel', title: '去南京短住',
    startedAt: '2026-09-08T00:00:00.000Z', endsAt: '2026-09-10T12:00:00.000Z',
    phase: { id: 'plan', title: '收拾与计划', location: '苏州的家中', activity: '旧缓存阶段' },
    phases: [
      { id: 'plan', title: '收拾与计划', offsetHours: 0, location: '苏州的家中', activity: '整理行李' },
      { id: 'outbound', title: '出发途中', offsetHours: 4, location: '从苏州前往南京的途中', activity: '乘车前往南京' },
      { id: 'away', title: '异地停留', offsetHours: 7, location: '南京', activity: '在南京散步' },
      { id: 'return', title: '返程途中', offsetHours: 48, location: '从南京返回苏州的途中', activity: '乘车返回苏州' },
    ],
    facts: ['已抵达未来的南京景点'],
  },
};

test('event phase schedule controls place and activity ahead of stale character state', () => {
  const world = buildCompanionWorld({
    now: '2026-09-08T05:00:00.000Z', life: travel,
    character: { activity: '已经回到苏州', location: '苏州', feeling: '平静', wish: '休息' },
  });
  assert.equal(world.location, '从苏州前往南京的途中');
  assert.equal(world.activity, '乘车前往南京');
  assert.deepEqual(world.event.phase, { id: 'outbound', title: '出发途中' });
  assert.equal(world.event.nextTransitionAt, '2026-09-08T07:00:00.000Z');
  assert.equal(world.nextTransitionAt, '2026-09-08T07:00:00.000Z');
});

test('event expiry is exclusive and immediately falls back to the home routine', () => {
  const world = buildCompanionWorld({ now: travel.active.endsAt, life: travel, character: { activity: '仍在南京旅行' } });
  assert.equal(world.event, null);
  assert.equal(world.location, '苏州的家中');
  assert.equal(world.activity, '自由活动');
  assert.equal(world.nextTransitionAt, '2026-09-10T15:00:00.000Z');
});

test('routine follows Shanghai time and uses the next local boundary', () => {
  const breakfast = buildCompanionWorld({ now: '2026-09-08T23:30:00.000Z' });
  assert.equal(breakfast.activity, '早餐与上午准备');
  assert.equal(breakfast.nextTransitionAt, '2026-09-09T01:00:00.000Z');
  const night = buildCompanionWorld({ now: '2026-09-08T15:30:00.000Z' });
  assert.equal(night.activity, '夜间休息');
  assert.equal(night.nextTransitionAt, '2026-09-08T23:00:00.000Z');
});

test('stored phase is a floor when the clock moves backward', () => {
  const life = structuredClone(travel);
  life.active.phaseIndex = 2;
  life.active.phase = life.active.phases[2];
  const world = buildCompanionWorld({ now: '2026-09-08T05:00:00.000Z', life });
  assert.equal(world.location, '南京');
  assert.equal(world.activity, '在南京散步');
  assert.deepEqual(world.event.phase, { id: 'away', title: '异地停留' });
  assert.equal(world.event.nextTransitionAt, '2026-09-10T00:00:00.000Z');
});

test('life next check can bring the world transition forward', () => {
  const life = { ...travel, nextCheckAt: '2026-09-08T05:30:00.000Z' };
  const world = buildCompanionWorld({ now: '2026-09-08T05:00:00.000Z', life });
  assert.equal(world.event.nextTransitionAt, '2026-09-08T07:00:00.000Z');
  assert.equal(world.nextTransitionAt, life.nextCheckAt);
});

test('snapshot reveals no future phase details or event facts', () => {
  const serialized = JSON.stringify(buildCompanionWorld({ now: '2026-09-08T01:00:00.000Z', life: travel }));
  assert.doesNotMatch(serialized, /乘车前往南京|在南京散步|已抵达未来|phases|facts/);
  assert.match(serialized, /整理行李/);
});

test('numeric fields are finite, bounded and whitelisted', () => {
  const world = buildCompanionWorld({
    now: '2026-09-08T00:00:00.000Z',
    inner: { fatigue: -8, hunger: 33.5, vitality: Infinity, stress: 101, security: '72', affectionNeed: NaN, desire: 50, playfulness: 120, interactions: 4.9 },
    tuning: { values: { warmth: 140, playfulness: '45', initiative: NaN, unknown: 99 } },
  });
  assert.deepEqual(world.body, { fatigue: 0, hunger: 33.5, vitality: 0, stress: 100, security: 0, affectionNeed: 0, desire: 50, playfulness: 100, affection: 55, mood: 65 });
  assert.deepEqual(world.traits, { warmth: 100 });
  assert.equal(world.relationship.interactions, 4);
});

test('builder is deterministic and does not mutate inputs', () => {
  const input = {
    now: new Date('2026-09-08T05:00:00.000Z'), life: structuredClone(travel),
    inner: { fatigue: 20, relationshipStage: '熟悉中的朋友', intimacyBoundary: 'open', feeling: '安心', wish: '聊聊' },
    tuning: { warmth: 80 },
  };
  const before = structuredClone(input);
  const first = buildCompanionWorld(input);
  const second = buildCompanionWorld(input);
  assert.deepEqual(first, second);
  assert.deepEqual(input, before);
});
