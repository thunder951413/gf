import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeTravelPlan, travelState } from '../lib/travel-state.mjs';
import { LifeEventRepository } from '../lib/life-events.mjs';
import { CompanionRuntime } from '../lib/companion-runtime.mjs';

class Store {
  constructor(filename = ':memory:') {
    this.db = new DatabaseSync(filename);
    this.db.exec('CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,role TEXT,speaker TEXT,text TEXT)');
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}

const request = () => ({
  homeCity: '苏州',
  departAt: '2026-10-01T00:00:00Z',
  returnAt: '2026-10-04T12:00:00Z',
  stops: [
    { city: '扬州', arriveAt: '2026-10-01T02:00:00Z', leaveAt: '2026-10-02T04:00:00Z', lodging: '扬州的住处' },
    { city: '南京', arriveAt: '2026-10-02T06:00:00Z', leaveAt: '2026-10-04T08:00:00Z' },
  ],
});

test('normalized multi-stop travel has exact half-open boundary states without mutating input', () => {
  const input = request();
  const before = structuredClone(input);
  const plan = normalizeTravelPlan(input);
  assert.deepEqual(input, before);
  const event = { type: 'travel', travelPlan: plan };
  const samples = [
    ['2026-09-30T23:59:59Z', 'planned', '苏州'],
    [plan.departAt, 'outbound', null],
    [plan.stops[0].arriveAt, 'staying', '扬州'],
    [plan.stops[0].leaveAt, 'between_stops', null],
    [plan.stops[1].arriveAt, 'staying', '南京'],
    [plan.stops[1].leaveAt, 'returning', null],
    [plan.returnAt, 'returned', '苏州'],
  ];
  for (const [at, status, currentCity] of samples) {
    const state = travelState(event, at);
    assert.equal(state.status, status, at);
    assert.equal(state.currentCity, currentCity, at);
    assert.equal(state.returnAt, plan.returnAt);
    assert.equal(state.stops.length, 2);
  }
});

test('travel validation is strict and rejects overlaps, empty cities, and inverted ranges', () => {
  const cases = [
    { ...request(), stops: [] },
    { ...request(), stops: [{ city: '', arriveAt: '2026-10-01T02:00:00Z', leaveAt: '2026-10-02T04:00:00Z' }] },
    { ...request(), stops: [{ city: '扬州', arriveAt: '2026-10-02T02:00:00Z', leaveAt: '2026-10-01T04:00:00Z' }] },
    { ...request(), stops: [request().stops[0], { city: '南京', arriveAt: '2026-10-02T03:00:00Z', leaveAt: '2026-10-03T00:00:00Z' }] },
  ];
  for (const value of cases) assert.throws(() => normalizeTravelPlan(value), error => error.code === 'INVALID_TRAVEL_PLAN');
});

test('planTravel persists a future itinerary across restart and conflict rejection is atomic', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'travel-state-'));
  const filename = path.join(directory, 'life.sqlite');
  let now = new Date('2026-09-30T12:00:00Z');
  const clock = () => new Date(now);
  let store = new Store(filename);
  try {
    let repo = new LifeEventRepository(store, { clock, random: () => .99 });
    const planned = repo.planTravel({ ...request(), title: '江南两城小住' });
    assert.equal(planned.active.travelPlan.stops.length, 2);
    assert.equal(travelState(planned, now).status, 'planned');
    const beforeRuntime = store.db.prepare("SELECT state_json FROM life_event_runtime WHERE role_id='miyue'").get().state_json;
    const beforeJournal = store.db.prepare('SELECT COUNT(*) AS count FROM life_event_journal').get().count;
    assert.throws(() => repo.planTravel({ ...request(), departAt: '2026-10-05T00:00:00Z', returnAt: '2026-10-06T12:00:00Z', stops: [{ city: '无锡', arriveAt: '2026-10-05T02:00:00Z', leaveAt: '2026-10-06T08:00:00Z' }] }), error => error.code === 'ACTIVE_LIFE_EVENT');
    assert.equal(store.db.prepare("SELECT state_json FROM life_event_runtime WHERE role_id='miyue'").get().state_json, beforeRuntime);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM life_event_journal').get().count, beforeJournal);

    store.close();
    store = new Store(filename);
    repo = new LifeEventRepository(store, { clock, random: () => .99 });
    now = new Date('2026-10-02T06:00:00Z');
    const restarted = repo.get();
    assert.equal(travelState(restarted, now).status, 'staying');
    assert.equal(travelState(restarted, now).currentCity, '南京');
    now = new Date(request().returnAt);
    assert.equal(repo.get().active, null);
  } finally {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('runtime keeps varied destination routines, clamps stop boundaries, handles transit, and restores home', () => {
  let now = new Date('2026-09-08T02:00:00Z');
  const plan = normalizeTravelPlan({
    homeCity: '苏州', departAt: '2026-09-08T00:00:00Z', returnAt: '2026-09-08T06:00:00Z',
    stops: [{ city: '扬州', arriveAt: '2026-09-08T01:00:00Z', leaveAt: '2026-09-08T03:00:00Z', lodging: '扬州客舍' },
      { city: '南京', arriveAt: '2026-09-08T04:00:00Z', leaveAt: '2026-09-08T05:00:00Z' }],
  });
  const life = { active: { id: 'trip', type: 'travel', title: '两城小住', startedAt: '2026-09-07T12:00:00Z', endsAt: plan.returnAt, travelPlan: plan } };
  const store = new Store();
  try {
    const runtime = new CompanionRuntime(store, { clock: () => new Date(now), random: () => .5, getInputs: () => ({ life }) });
    let view = runtime.snapshot();
    assert.equal(view.current.kind, 'reading');
    assert.equal(view.current.location, '扬州客舍');
    assert.doesNotMatch(JSON.stringify(view.current), /苏州|工作/);
    assert.equal(view.current.endsAt, '2026-09-08T03:00:00.000Z');
    assert.equal(view.world.nextTransitionAt, view.current.endsAt);

    now = new Date('2026-09-08T03:00:00Z');
    view = runtime.advance();
    assert.equal(view.current.kind, 'travel');
    assert.equal(view.current.location, '从扬州前往南京的途中');
    now = new Date(plan.returnAt);
    view = runtime.advance();
    assert.match(view.current.location, /苏州/);
    assert.notEqual(view.current.kind, 'travel');
  } finally { store.close(); }
});

test('legacy phase-only travel remains readable', () => {
  const event = {
    type: 'travel', destination: '南京', startedAt: '2026-09-08T00:00:00Z', endsAt: '2026-09-10T00:00:00Z',
    phase: { id: 'away', location: '南京' },
  };
  const state = travelState(event, '2026-09-08T12:00:00Z');
  assert.equal(state.status, 'staying');
  assert.equal(state.currentCity, '南京');
});
