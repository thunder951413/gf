import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CompanionRuntime, sceneFor } from '../lib/companion-runtime.mjs';

class TestStore {
  constructor(filename = ':memory:') {
    this.db = new DatabaseSync(filename);
    this.db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE messages(id TEXT PRIMARY KEY,role TEXT,speaker TEXT,text TEXT)');
  }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  close() { this.db.close(); }
}

function fixture({ time = '2026-09-08T02:00:00Z', draws = [.1, .1, .1, .1, .1], inputs = {} } = {}) {
  let now = new Date(time); let index = 0; const store = new TestStore();
  const runtime = new CompanionRuntime(store, { clock: () => new Date(now), random: () => draws[index++ % draws.length], getInputs: () => inputs, intervalMs: 10 });
  return { store, runtime, set: value => { now = new Date(value); }, get now() { return now; }, get drawCount() { return index; } };
}

test('daily plan is stable across polling, covers night and cross-midnight, and revision ignores clock seconds', () => {
  const f = fixture(); const first = f.runtime.snapshot(); const draws = f.drawCount;
  const second = f.runtime.snapshot();
  assert.deepEqual(second.dayPlan, first.dayPlan); assert.equal(f.drawCount, draws); assert.equal(second.revision, first.revision);
  f.set('2026-09-08T15:30:00Z'); const night = f.runtime.advance();
  assert.equal(night.current.kind, 'sleep'); assert.equal(night.current.endsAt, '2026-09-08T23:20:00.000Z');
});

test('stored plan survives restart without random reroll', () => {
  const f = fixture(); const first = f.runtime.snapshot();
  const restarted = new CompanionRuntime(f.store, { clock: () => new Date(f.now), random: () => { throw new Error('rerolled'); } });
  assert.deepEqual(restarted.snapshot().dayPlan, first.dayPlan);
});
test('National Day uses a rest-day plan and weekday plans retain meals and a leisure break',()=>{
 const holiday=fixture({time:'2026-10-06T02:00:00Z'}),view=holiday.runtime.snapshot();
 assert.equal(view.dayPlan.some(i=>i.kind==='work'),false);assert.ok(view.dayPlan.some(i=>i.kind==='meal'));holiday.store.close();
 const regular=fixture({time:'2026-10-08T02:00:00Z'}),plan=regular.runtime.snapshot().dayPlan;
 assert.ok(plan.some(i=>i.kind==='work'));assert.ok(plan.some(i=>i.id.endsWith('afternoon-reading')&&i.kind==='rest'));regular.store.close();
});

test('travel keeps trip location while sleep and meals retain routine action', () => {
  const inputs = { life: { active: { id: 'trip', type: 'travel', startedAt: '2026-09-08T00:00:00Z', endsAt: '2026-09-10T00:00:00Z', phase: { location: '南京', activity: '逛博物馆' } } } };
  const f = fixture({ time: '2026-09-08T16:00:00Z', inputs }); const view = f.runtime.snapshot();
  assert.equal(view.current.kind, 'sleep'); assert.equal(view.current.title, '睡觉'); assert.equal(view.current.location, '南京');
});

test('agenda character activity wins while unconfirmed joint activity does not fabricate participation', () => {
  const inputs = { agenda: { plans: [{ id: 'joint', owner: 'joint', status: 'awaiting_confirmation', kind: 'reading', title: '一起读书', dueAt: '2026-09-08T01:00:00Z' }, { id: 'own', owner: 'character', status: 'active', kind: 'reading', title: '读《雪国》', startedAt: '2026-09-08T01:30:00Z', location: '窗边' }] } };
  const f = fixture({ inputs }); const view = f.runtime.snapshot();
  assert.equal(view.current.id, 'agenda:own'); assert.equal(view.current.location, '窗边'); assert.doesNotMatch(view.current.title, /一起/);
  inputs.agenda.plans[1].status = 'cancelled'; assert.notEqual(f.runtime.advance().current.id, 'agenda:joint');
});

test('long absence creates no backlog and opportunity delivery is confirmed, exact-once, and stale-safe', () => {
  const f = fixture({ time: '2026-09-08T10:30:00Z', draws: [.1, .1, .1, .1, 0] });
  assert.equal(f.runtime.snapshot().pending, null, 'first boot is quiet');
  f.set('2026-09-08T11:05:00Z'); const pending = f.runtime.pending(); assert.ok(pending);
  assert.equal(f.runtime.markDelivered(pending.key, 'missing'), false);
  f.store.db.prepare('INSERT INTO messages VALUES(?,?,?,?)').run('user', 'miyue', 'user', 'hi');
  assert.equal(f.runtime.markDelivered(pending.key, 'user'), false);
  f.store.db.prepare('INSERT INTO messages VALUES(?,?,?,?)').run('assistant', 'miyue', 'assistant', 'scene');
  assert.equal(f.runtime.markDelivered(pending.key, 'assistant'), true); assert.equal(f.runtime.markDelivered(pending.key, 'assistant'), true);
  f.set('2026-09-11T12:00:00Z'); const later = f.runtime.advance();
  assert.ok(later.transitions.length <= 12); assert.equal(later.pending, null);
});

test('timer advances without anyone reading a view and isolates errors', async () => {
  let calls = 0; let displays = 0; const store = new TestStore();
  const runtime = new CompanionRuntime(store, { intervalMs: 10, getInputs: () => { calls += 1; if (calls === 1) throw new Error('temporary'); return {}; }, onAdvance: () => { displays += 1; } });
  runtime.start(); await new Promise(resolve => setTimeout(resolve, 45)); runtime.stop();
  assert.ok(calls >= 2); assert.ok(displays >= 1); assert.equal(runtime.status().running, false); assert.ok(runtime.status().lastTickAt); store.close();
});

test('automatic scenes do not gate conversation opportunities, while disabling runtime clears them', () => {
  const f = fixture(); let view = f.runtime.snapshot();
  view = f.runtime.updateSettings({ revision: view.revision, settings: { automaticScenes: false } });
  assert.equal(view.settings.enabled, true); assert.equal(view.settings.automaticScenes, false);
  assert.throws(() => f.runtime.updateSettings({ revision: 0, settings: { enabled: false } }), error => error.code === 'STALE_COMPANION_RUNTIME');
  const active = fixture({ time: '2026-09-08T10:30:00Z', draws: Array(20).fill(0) });
  view = active.runtime.snapshot();
  view = active.runtime.updateSettings({ revision: view.revision, settings: { automaticScenes: false } });
  active.set('2026-09-08T11:01:00Z'); view = active.runtime.advance(); assert.ok(view.pending);
  view = active.runtime.updateSettings({ revision: view.revision, settings: { enabled: false } }); assert.equal(view.pending, null);
});

test('configuration is a pure settings read and frequent ticks avoid false long-absence suppression', () => {
  let callbacks = 0; const f = fixture({ time: '2026-09-08T10:30:00Z', draws: Array(20).fill(0) });
  f.runtime.onAdvance = () => { callbacks += 1; };
  const first = f.runtime.snapshot(); const before = callbacks;
  assert.deepEqual(f.runtime.configuration(), { revision: first.revision, settings: first.settings }); assert.equal(callbacks, before);
  f.set('2026-09-08T10:59:00Z'); f.runtime.advance();
  f.set('2026-09-08T11:01:00Z'); const view = f.runtime.advance(); assert.ok(view.pending); assert.match(view.pending.key, /^runtime:/);
  assert.equal(view.transitions.at(-1).toTitle, view.current.title); assert.equal(view.transitions.at(-1).location, view.current.location);
});

test('plans cover every minute, expose only valid scene ids, and weekends replace office work', () => {
  const allowed = new Set(['study', 'summer-coast', 'autumn-cafe', 'winter-home', 'private-bedroom', 'spring-study', null]);
  for (const time of ['2026-09-08T02:00:00Z', '2026-09-12T02:00:00Z']) {
    const f = fixture({ time }); const view = f.runtime.snapshot();
    const sorted = [...view.dayPlan].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    for (let index = 0; index < sorted.length - 1; index += 1) assert.equal(sorted[index].endsAt, sorted[index + 1].startedAt);
    assert.ok(sorted.every(item => allowed.has(item.sceneId)));
    if (time.includes('-12')) { assert.ok(sorted.some(item => item.id.endsWith('weekend-outing'))); assert.ok(!sorted.some(item => item.kind === 'work')); }
  }
});

test('waking, meals, and rest can be selected as persisted opportunities', () => {
  const f = fixture({ time: '2026-09-07T23:00:00Z', draws: Array(20).fill(0) });
  let view = f.runtime.snapshot();
  const shareKinds = view.dayPlan.filter(item => ['waking', 'meal', 'rest'].includes(item.kind));
  assert.ok(shareKinds.length >= 4);
  f.set('2026-09-07T23:21:00Z');
  view = f.runtime.advance(); assert.equal(view.current.kind, 'waking'); assert.equal(view.pending.kind, 'waking');
});

test('travel overrides idle blocks with a usable scene for both general and coast locations', () => {
  const life = { active: { id: 'trip', type: 'travel', startedAt: '2026-09-12T00:00:00Z', endsAt: '2026-09-13T00:00:00Z', phase: { location: '南京' } } };
  const f = fixture({ time: '2026-09-12T03:30:00Z', inputs: { life } });
  let view = f.runtime.snapshot(); assert.equal(view.current.kind, 'travel'); assert.match(view.current.title, /南京/); assert.equal(view.current.sceneId, 'spring-study');
  life.active.phase.location = '青岛海边'; view = f.runtime.advance(); assert.equal(view.current.sceneId, 'summer-coast');
});

test('scene routing covers walk, bar, and general travel with existing scene ids',()=>{
  assert.equal(sceneFor('walk','苏州街巷'),'spring-study');
  assert.equal(sceneFor('bar','苏州的小酒馆'),'autumn-cafe');
  assert.equal(sceneFor('travel','南京'),'spring-study');
  assert.equal(sceneFor('travel','青岛海边'),'summer-coast');
});

test('ordinary life events remain conversational background and never replace authoritative schedule state', () => {
  const inputs = { life: { active: { id: 'cooking', type: 'ordinary', category: 'cooking', title: '准备晚饭', startedAt: '2026-09-08T00:00:00Z', endsAt: '2026-09-08T08:00:00Z', phase: { location: '苏州的厨房', activity: '切西红柿' } } } };
  const f = fixture({ time: '2026-09-08T02:00:00Z', inputs });
  const view = f.runtime.snapshot();
  assert.equal(view.current.kind, 'work'); assert.equal(view.current.title, '处理上午的工作'); assert.equal(view.current.location, '苏州的工作室');
  assert.equal(view.world.event, null); assert.equal(view.world.activity, view.current.title); assert.equal(view.world.location, view.current.location);
  assert.equal(inputs.life.active.phase.activity, '切西红柿', 'life repository input stays available to context consumers');
});
