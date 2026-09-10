import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CATEGORY_WEIGHTS,
  DAILY_ORDINARY_EVENT_CHANCE,
  LifeEventRepository,
  ORDINARY_EVENT_CATALOG,
  TRAVEL_EVENT_CATALOG,
  shanghaiDayKey,
  shanghaiWeekInfo,
} from '../lib/life-events.mjs';

class TestStore {
  constructor(filename = ':memory:') { this.db = new DatabaseSync(filename); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  close() { this.db.close(); }
}

function clockAt(initial) {
  let value = new Date(initial);
  const clock = () => new Date(value);
  clock.set = (next) => { value = new Date(next); };
  clock.addHours = (hours) => { value = new Date(value.getTime() + hours * 60 * 60 * 1000); };
  return clock;
}

function randomSequence(values, fallback = 0.99) {
  const queue = [...values];
  const fn = () => { fn.calls += 1; return queue.length ? queue.shift() : fallback; };
  fn.calls = 0;
  return fn;
}

function runtime(store) {
  return JSON.parse(store.db.prepare("SELECT state_json FROM life_event_runtime WHERE role_id='miyue'").get().state_json);
}

test('catalog is rich, weighted, fictional, and covers all requested ordinary categories', () => {
  const required = ['meal', 'cooking', 'clothing', 'commute', 'hobby', 'family', 'work', 'local_walk', 'reading', 'emotional_need'];
  assert.ok(ORDINARY_EVENT_CATALOG.length >= 30);
  assert.deepEqual([...new Set(ORDINARY_EVENT_CATALOG.map((item) => item.category))].sort(), required.sort());
  assert.deepEqual(Object.keys(CATEGORY_WEIGHTS).sort(), required.sort());
  assert.ok(Object.values(CATEGORY_WEIGHTS).every((weight) => weight > 0));
  assert.equal(DAILY_ORDINARY_EVENT_CHANCE, 0.9);
  assert.ok(ORDINARY_EVENT_CATALOG.every((item) => item.variants.length >= 2 && item.sourceHints.length >= 2));
  assert.deepEqual(TRAVEL_EVENT_CATALOG.map((item) => item.destination).sort(), ['南京', '扬州', '无锡', '杭州', '丽江', '大理', '成都', '泉州'].sort());
  assert.ok(!JSON.stringify(ORDINARY_EVENT_CATALOG).match(/新闻|天气预报|正在营业|确诊|住院/));
});

test('weekly travel uses an exact lower-than 5% boundary', () => {
  const beforeBoundary = new TestStore();
  const clock = clockAt('2026-09-07T02:00:00.000Z'); // Monday 10:00 in Shanghai.
  const selected = new LifeEventRepository(beforeBoundary, { clock, random: () => 0.049 }).get();
  assert.equal(selected.active.type, 'travel');
  beforeBoundary.close();

  const atBoundary = new TestStore();
  const missed = new LifeEventRepository(atBoundary, { clock, random: () => 0.05 }).get();
  assert.notEqual(missed.active?.type, 'travel');
  assert.equal(runtime(atBoundary).weeklyDecision.result, 'not_selected');
  atBoundary.close();
});

test('one weekly draw survives repeated reads and repository restart', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'life-events-'));
  const filename = path.join(directory, 'events.sqlite');
  const clock = clockAt('2026-09-07T02:00:00.000Z');
  const firstRandom = randomSequence([0.5, 0.99]);
  let store = new TestStore(filename);
  let repo = new LifeEventRepository(store, { clock, random: firstRandom });
  const first = repo.get();
  const version = first.version;
  repo.get();
  assert.equal(firstRandom.calls, 2, 'one weekly draw plus one daily no-event draw');
  assert.equal(repo.get().version, version, 'identical reads keep a stable context version');
  store.close();

  const restartedRandom = randomSequence([]);
  store = new TestStore(filename);
  repo = new LifeEventRepository(store, { clock, random: restartedRandom });
  assert.equal(repo.get().version, version);
  assert.equal(restartedRandom.calls, 0);
  store.close();
  fs.rmSync(directory, { recursive: true });
});

test('Shanghai week boundary is Monday and clocks moving backwards never reroll', () => {
  const sunday = new Date('2026-09-06T15:59:00.000Z');
  const monday = new Date('2026-09-06T16:00:00.000Z');
  assert.equal(shanghaiDayKey(sunday), '2026-09-06');
  assert.equal(shanghaiWeekInfo(sunday).key, '2026-08-31');
  assert.equal(shanghaiWeekInfo(monday).key, '2026-09-07');
  assert.equal(shanghaiWeekInfo(sunday).nextAt, '2026-09-06T16:00:00.000Z');

  const store = new TestStore();
  const clock = clockAt('2026-09-07T02:00:00.000Z');
  const random = randomSequence([0.5, 0.99]);
  const repo = new LifeEventRepository(store, { clock, random });
  const current = repo.get();
  clock.set('2026-08-31T02:00:00.000Z');
  const backwards = repo.get();
  assert.equal(random.calls, 2);
  assert.equal(backwards.checkedWeek, current.checkedWeek);
  assert.equal(backwards.nextWeeklyCheckAt, current.nextWeeklyCheckAt);
  assert.equal(runtime(store).dailyCheckedDate, '2026-09-07');
  store.close();
});

test('long absence checks only the current week and current day', () => {
  const store = new TestStore();
  const clock = clockAt('2026-01-05T02:00:00.000Z');
  const random = randomSequence([], 0.99);
  const repo = new LifeEventRepository(store, { clock, random });
  repo.get();
  clock.set('2026-09-07T02:00:00.000Z');
  repo.get();
  assert.equal(random.calls, 4, 'two gets each make one current-week and one current-day draw');
  assert.equal(runtime(store).checkedWeek, '2026-09-07');
  assert.equal(runtime(store).dailyCheckedDate, '2026-09-07');
  store.close();
});

test('travel has fixed itinerary, moving locations, monotonic phases, and idempotent delivery', () => {
  const store = new TestStore();
  const clock = clockAt('2026-09-07T02:00:00.000Z');
  const random = randomSequence([0.049, 0]);
  let repo = new LifeEventRepository(store, { clock, random });
  const plan = repo.get();
  const eventId = plan.active.id;
  const destination = plan.active.destination;
  const initialVersion = plan.version;
  assert.equal(plan.active.phase.id, 'plan');
  assert.equal(plan.active.location, '苏州的家中');
  assert.deepEqual(plan.active.phases.map((phase) => phase.offsetHours), [0, 24, 27, 72, 75]);
  const planTopic = repo.pendingTopic();
  assert.equal(repo.markDelivered('miyue', planTopic, 'message-plan'), true);
  assert.equal(repo.markDelivered('miyue', planTopic, 'message-plan-again'), false);

  clock.addHours(28);
  const away = repo.get();
  assert.equal(away.active.id, eventId);
  assert.equal(away.active.destination, destination);
  assert.equal(away.active.phase.id, 'away');
  assert.equal(away.active.location, destination);
  assert.notEqual(away.version, initialVersion);
  assert.equal(repo.markDelivered('miyue', planTopic, 'late-plan'), false, 'missed phase cannot be claimed retroactively');
  const awayTopic = repo.pendingTopic();
  assert.match(awayTopic, new RegExp(`^life:${eventId}:away$`));
  assert.equal(repo.markDelivered('miyue', awayTopic, 'message-away'), true);

  repo = new LifeEventRepository(store, { clock, random: randomSequence([]) });
  assert.equal(repo.get().active.phase.id, 'away');
  clock.addHours(-20);
  assert.equal(repo.get().active.phase.id, 'away', 'clock rollback cannot reverse a persisted phase');
  clock.addHours(68);
  assert.equal(repo.get().active.phase.id, 'home');
  assert.equal(repo.get().active.location, '苏州的家中');
  clock.addHours(21);
  assert.equal(repo.get().active, null);
  assert.match(repo.context(), /最近完成：.*短住/);
  store.close();
});

test('traveling across Monday records a skip without a draw or overlapping event', () => {
  const store = new TestStore();
  const clock = clockAt('2026-09-06T04:00:00.000Z'); // Sunday noon in Shanghai.
  const random = randomSequence([0.01, 0.5]);
  const repo = new LifeEventRepository(store, { clock, random });
  const trip = repo.get().active;
  assert.equal(trip.type, 'travel');
  assert.equal(random.calls, 2, 'travel decision and destination');
  clock.set('2026-09-07T02:00:00.000Z');
  const monday = repo.get();
  assert.equal(monday.active.id, trip.id);
  assert.equal(random.calls, 2, 'no weekly or daily random draw while traveling');
  assert.equal(runtime(store).weeklyDecision.result, 'skipped_traveling');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM life_event_journal').get().n, 1);
  store.close();
});

test('midnight and late-night travel draws schedule both journeys in daylight with continuous durations', () => {
  for (const initial of ['2026-09-06T16:00:00Z', '2026-09-07T15:45:00Z']) {
    const store = new TestStore();
    const repo = new LifeEventRepository(store, { clock: clockAt(initial), random: () => 0 });
    const event = repo.get().active;
    const times = event.phases.map(phase => new Date(Date.parse(event.startedAt) + phase.offsetHours * 3600000));
    for (const index of [1, 3]) {
      const hour = new Date(+times[index] + 8 * 3600000).getUTCHours();
      assert.ok(hour >= 9 && hour <= 16);
    }
    assert.ok(times.every((time, index) => index === 0 || time > times[index - 1]));
    assert.equal((times[2] - times[1]) / 3600000, 3);
    assert.equal((times[4] - times[3]) / 3600000, 3);
    assert.equal((Date.parse(event.endsAt) - times[4]) / 3600000, 21);
    store.close();
  }
});

test('ordinary event waits until 07:00, respects category duration, and occurs once per local day across restart', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'life-events-daily-'));
  const filename = path.join(directory, 'events.sqlite');
  const clock = clockAt('2026-09-07T16:30:00.000Z'); // Tuesday 00:30 in Shanghai.
  const random = randomSequence([0.5, 0]);
  let store = new TestStore(filename);
  let repo = new LifeEventRepository(store, { clock, random });
  assert.equal(repo.get().active, null);
  assert.equal(runtime(store).dailyCheckedDate, null);

  clock.set('2026-09-07T23:00:00.000Z'); // Tuesday 07:00.
  random.push?.();
  const selectionRandom = randomSequence([0.1, 0, 0, 0, 0]);
  repo.random = selectionRandom;
  const first = repo.get();
  assert.equal(first.active.type, 'ordinary');
  assert.equal(first.active.category, 'meal');
  assert.ok(first.active.durationHours >= 1 && first.active.durationHours <= 3);
  const id = first.active.id;
  store.close();

  store = new TestStore(filename);
  repo = new LifeEventRepository(store, { clock, random: randomSequence([]) });
  assert.equal(repo.get().active.id, id);
  clock.addHours(4);
  assert.equal(repo.get().active, null);
  assert.equal(repo.get().recent.length, 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM life_event_journal').get().n, 1);
  store.close();
  fs.rmSync(directory, { recursive: true });
});

test('ordinary event crossing Monday defers, then receives exactly one weekly travel draw', () => {
  const store = new TestStore();
  const clock = clockAt('2026-09-06T15:00:00.000Z'); // Sunday 23:00 Shanghai.
  const random = randomSequence([0.5, 0.1, 0, 0, 0, 0, 0.01, 0]);
  const repo = new LifeEventRepository(store, { clock, random });
  const ordinary = repo.get().active;
  assert.equal(ordinary.type, 'ordinary');
  clock.set('2026-09-06T16:30:00.000Z');
  assert.equal(repo.get().active.id, ordinary.id);
  assert.equal(runtime(store).checkedWeek, '2026-08-31');
  assert.equal(runtime(store).nextWeeklyCheckAt, ordinary.endsAt);
  const callsWhileDeferred = random.calls;
  clock.set(ordinary.endsAt);
  const after = repo.get();
  assert.equal(after.active.type, 'travel');
  assert.equal(random.calls, callsWhileDeferred + 2, 'one travel draw plus fixed destination draw');
  assert.equal(runtime(store).checkedWeek, '2026-09-07');
  store.close();
});

test('settings validation is durable and never rerolls an already checked week', () => {
  const store = new TestStore();
  const clock = clockAt('2026-09-07T02:00:00.000Z');
  const random = randomSequence([0.5, 0.99]);
  const repo = new LifeEventRepository(store, { clock, random });
  repo.get();
  assert.equal(repo.saveSettings({ weeklyTravelChance: 0.2 }).weeklyTravelChance, 0.2);
  assert.equal(repo.get().weeklyTravelChance, 0.2);
  assert.equal(random.calls, 2);
  for (const value of [-0.1, 1.1, Infinity, NaN, '0.5']) {
    assert.throws(
      () => repo.saveSettings({ weeklyTravelChance: value }),
      (error) => error.status === 400 && error.code === 'INVALID_LIFE_SETTINGS',
    );
  }
  const restarted = new LifeEventRepository(store, { clock, random: randomSequence([]) });
  assert.equal(restarted.get().weeklyTravelChance, 0.2);
  store.close();
});

test('other roles are inert and context contains bounded fictional-canon safeguards', () => {
  const store = new TestStore();
  const random = randomSequence([0.5, 0.99]);
  const repo = new LifeEventRepository(store, { clock: clockAt('2026-09-07T02:00:00.000Z'), random });
  assert.equal(repo.get('xingye'), null);
  assert.equal(repo.tick('xingye'), null);
  assert.equal(repo.pendingTopic('xingye'), null);
  assert.equal(repo.context('xingye'), '');
  assert.equal(random.calls, 0);
  repo.get();
  const context = repo.context();
  assert.ok(context.length <= 1800);
  assert.match(context, /虚构个人生活连续性/);
  assert.match(context, /错过的阶段不得集中补发/);
  store.close();
});

test('recent response is capped at 12 while journal history remains intact', () => {
  const store = new TestStore();
  const clock = clockAt('2026-08-03T02:00:00.000Z');
  const repo = new LifeEventRepository(store, { clock, random: () => 0.5 });
  repo.saveSettings({ weeklyTravelChance: 0 });
  for (let day = 0; day < 15; day += 1) {
    clock.set(new Date(Date.parse('2026-08-03T02:00:00.000Z') + day * 24 * 60 * 60 * 1000));
    repo.get();
  }
  const snapshot = repo.get();
  assert.equal(snapshot.recent.length, 12);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM life_event_journal').get().n, 15);
  store.close();
});

test('overnight daily scheduling persists a varied daytime slot without rerolling on restart', () => {
  const store = new TestStore();
  const clock = clockAt('2026-09-06T16:00:00Z');
  const random = randomSequence([0.5, 0.6]);
  let repo = new LifeEventRepository(store, { clock, random });
  assert.equal(repo.get().active, null);
  assert.equal(runtime(store).dailySchedule.notBefore, '2026-09-07T16:00:00+08:00');
  const laterRandom = randomSequence([0.1, 0.5, 0, 0, 0]);
  repo = new LifeEventRepository(store, { clock, random: laterRandom });
  clock.set('2026-09-06T23:00:00Z');
  assert.equal(repo.get().active, null);
  assert.equal(laterRandom.calls, 0);
  clock.set('2026-09-07T08:00:00Z');
  assert.equal(repo.get().active.type, 'ordinary');
  assert.equal(runtime(store).dailyCheckedDate, '2026-09-07');
  store.close();
});

test('restart catches up a persisted event deadline once and preserves its completion record', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'life-expiry-restart-'));
  const filename = path.join(directory, 'events.sqlite');
  const clock = clockAt('2026-09-07T02:00:00Z');
  let store = new TestStore(filename);
  let repo = new LifeEventRepository(store, { clock, random: () => 0 });
  const trip = repo.get().active;
  repo.saveSettings({ weeklyTravelChance: 0 });
  store.close();
  clock.set(trip.endsAt);
  store = new TestStore(filename);
  try {
    repo = new LifeEventRepository(store, { clock, random: () => .99 });
    const first = repo.get();
    assert.equal(first.active, null);
    const completed = first.recent.find(item => item.id === trip.id);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.completedAt, trip.endsAt);
    const version = first.version;
    for (let i = 0; i < 10; i++) {
      assert.equal(repo.get().version, version);
      assert.equal(repo.get().recent.filter(item => item.id === trip.id).length, 1);
    }
  } finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('background timer completes an event without any chat or snapshot read', t => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const store = new TestStore();
  const clock = clockAt('2026-09-07T02:00:00Z');
  const repo = new LifeEventRepository(store, { clock, random: () => 0 });
  const trip = repo.get().active;
  repo.saveSettings({ weeklyTravelChance: 0 });
  repo.random = () => .99;
  repo.start();
  try {
    clock.set(trip.endsAt);
    t.mock.timers.tick(60_000);
    // Read persisted rows directly so get() cannot accidentally do the work.
    assert.equal(runtime(store).activeEventId, null);
    const event = JSON.parse(store.db.prepare('SELECT event_json FROM life_event_journal WHERE event_id=?').get(trip.id).event_json);
    assert.equal(event.status, 'completed');
    assert.equal(event.completedAt, trip.endsAt);
  } finally { repo.stop(); store.close(); }
});
