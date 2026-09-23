import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CompanionPursuits } from '../lib/companion-pursuits.mjs';

class Store {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec('CREATE TABLE messages (id TEXT PRIMARY KEY, role TEXT, speaker TEXT, text TEXT)'); }
  transaction(fn) { this.db.exec('BEGIN'); try { const result = fn(); this.db.exec('COMMIT'); return result; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
}

const item = (id, category) => ({
  id, kind: 'reading', title: id, aliases: [], category, sessionMinutes: 60, stageWaitHours: 48, restHours: 48,
  source: { title: 'source', url: `https://example.test/${id}`, scope: 'test' },
  stages: Array.from({ length: 4 }, (_, index) => ({ label: `stage ${index}`, action: `do ${index}`, detail: `detail ${index}` })),
});

test('configured pursuits advance only through eligible persisted sessions', () => {
  let now = new Date('2026-09-07T00:00:00.000Z');
  const store = new Store();
  const repo = new CompanionPursuits(store, { clock: () => now, catalog: { lifePlanning: true, items: [item('one', 'books'), item('two', 'films')] } });
  let view = repo.get('miyue');
  assert.equal(view.pendingKey, undefined);
  assert.equal(view.readable, false);
  assert.equal(repo.prepareSession({ current: { kind: 'work', remainingMinutes: 120 } }).session, null);
  view = repo.prepareSession({ current: { kind: 'home', remainingMinutes: 65 } });
  assert.equal(view.session.status, 'active');
  assert.ok(view.pendingKey);
  const firstStart = view.session.startedAt;
  now = new Date(now.getTime() + 30 * 60000);
  view = repo.prepareSession({ current: { kind: 'travel', remainingMinutes: 120 }, travel: true });
  assert.equal(view.session.status, 'interrupted');
  assert.equal(view.stage.index, 0);
  now = new Date('2026-09-08T00:00:00.000Z');
  view = repo.prepareSession({ current: { kind: 'home', remainingMinutes: 60 } });
  assert.equal(view.session.status, 'active');
  assert.notEqual(view.session.startedAt, firstStart);
  now = new Date(now.getTime() + 60 * 60000);
  view = repo.tick('miyue');
  assert.equal(view.stage.index, 0);
  assert.equal(view.readable, true);
  assert.ok(view.pendingKey, 'the reached stage remains shareable after the session');
  now = new Date('2026-09-09T00:00:00.000Z');
  assert.equal(repo.prepareSession({ current: { kind: 'home', remainingMinutes: 60 } }).stage.index, 0, 'wait is measured from the preceding actual start');
  now = new Date('2026-09-10T00:00:00.000Z');
  view = repo.prepareSession({ current: { kind: 'home', remainingMinutes: 60 } });
  assert.equal(view.stage.index, 1);
  assert.equal(view.session.status, 'active');
  store.db.close();
});

test('the final reached stage remains shareable throughout its rest', () => {
  let now = new Date('2026-09-01T00:00:00.000Z');
  const store = new Store();
  const repo = new CompanionPursuits(store, { clock: () => now, catalog: { items: [item('one', 'books')] } });
  repo.get('miyue');
  for (let stage = 0; stage < 4; stage += 1) {
    repo.prepareSession({ current: { kind: 'home', remainingMinutes: 60 } });
    now = new Date(now.getTime() + 65 * 60000);
    let view = repo.tick('miyue');
    assert.equal(view.stage.index, stage);
    assert.equal(view.readable, true);
    assert.ok(view.pendingKey);
    if (stage < 3) now = new Date(Date.parse(view.session.startedAt) + 48 * 60 * 60000);
  }
  const final = repo.get('miyue');
  assert.equal(final.status, 'resting');
  assert.ok(final.pendingKey);
  store.db.close();
});

test('delivery survives interruption and retry without reoffering the reached stage', () => {
  let now = new Date('2026-09-01T00:00:00.000Z');
  const store = new Store();
  const repo = new CompanionPursuits(store, { clock: () => now, catalog: { items: [item('one', 'books')] } });
  let view = repo.get('miyue');
  view = repo.prepareSession({ current: { kind: 'home', remainingMinutes: 60 } });
  store.db.prepare('INSERT INTO messages VALUES(?,?,?,?)').run('shared', 'miyue', 'assistant', `said ${view.stage.action}`);
  assert.equal(repo.markDelivered(view.pendingKey, 'shared', view.version), true);
  now = new Date(now.getTime() + 10 * 60000);
  view = repo.prepareSession({ current: { kind: 'travel', remainingMinutes: 60 }, travel: true });
  assert.equal(view.session.status, 'interrupted');
  assert.equal(view.pendingKey, undefined);
  now = new Date('2026-09-02T00:00:00.000Z');
  view = repo.prepareSession({ current: { kind: 'home', remainingMinutes: 60 } });
  assert.equal(view.session.status, 'active');
  assert.equal(view.pendingKey, undefined, 'the delivered stage cannot be delivered again after retry');
  assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM companion_pursuit_deliveries').get().count, 1);
  store.db.close();
});

test('migration preserves a reached delivery while refreshing current origin and interests', () => {
  let now = new Date('2026-09-03T00:00:00.000Z');
  const store = new Store();
  const old = item('one', 'books'); delete old.sessionMinutes; delete old.stageWaitHours; delete old.restHours;
  const first = new CompanionPursuits(store, { clock: () => now, catalog: { items: [old] } });
  const original = first.get('miyue');
  store.db.prepare('INSERT INTO messages VALUES(?,?,?,?)').run('old-share', 'miyue', 'assistant', original.stage.action);
  assert.equal(first.markDelivered(original.pendingKey, 'old-share', original.version), true);
  const row = store.db.prepare('SELECT state_json FROM companion_pursuit_state WHERE role_id=?').get('miyue');
  const legacy = JSON.parse(row.state_json);
  legacy.schemaVersion = 2; delete legacy.sessionMode; delete legacy.session; delete legacy.lastSessionDate;
  store.db.prepare('UPDATE companion_pursuit_state SET state_json=? WHERE role_id=?').run(JSON.stringify(legacy), 'miyue');
  const next = item('one', 'books'); next.origin = 'new origin'; next.interests = ['new interest'];
  const migrated = new CompanionPursuits(store, { clock: () => now, catalog: { items: [next] } }).get('miyue');
  assert.equal(migrated.origin, 'new origin');
  assert.deepEqual(migrated.interests, ['new interest']);
  assert.equal(migrated.readable, true);
  assert.equal(migrated.pendingKey, undefined);
  assert.equal(migrated.history.length, 1);
  store.db.close();
});

test('session catalog validation bounds timing metadata', () => {
  const store = new Store();
  assert.throws(() => new CompanionPursuits(store, { catalog: { items: [{ ...item('bad', 'x'), sessionMinutes: 59 }] } }), /sessionMinutes/);
  assert.throws(() => new CompanionPursuits(store, { catalog: { items: [{ ...item('bad2', 'x'), stageWaitHours: 97 }] } }), /stageWaitHours/);
  store.db.close();
});

test('thirty idle days cannot fabricate sessions or skip a catalog', () => {
  let now = new Date('2026-09-01T00:00:00.000Z');
  const store = new Store();
  const repo = new CompanionPursuits(store, { clock: () => now, catalog: { lifePlanning: true, items: [item('one', 'books'), item('two', 'films')] } });
  repo.get('miyue');
  now = new Date('2026-10-01T00:00:00.000Z');
  const held = repo.tick('miyue');
  assert.equal(held.id, 'one');
  assert.equal(held.stage.index, 0);
  assert.equal(held.session, null);
  assert.deepEqual(held.completed, []);
  store.db.close();
});


test('subscription fallback inherits session timings and starts after authored material is exhausted',()=>{
 let now=new Date('2026-09-01T00:00:00Z');const store=new Store();
 const original={...item('authored','science'),kind:'article'};const fresh={...item('subscription','news'),kind:'article'};delete fresh.sessionMinutes;delete fresh.stageWaitHours;delete fresh.restHours;
 const repo=new CompanionPursuits(store,{clock:()=>now,catalog:{lifePlanning:true,items:[original]},pickArticle:()=>fresh});repo.get('miyue');
 for(let stage=0;stage<4;stage++){repo.prepareSession({current:{kind:'home',remainingMinutes:90}});now=new Date(+now+3600000);const view=repo.tick('miyue');now=new Date(view.nextAt);}
 assert.equal(repo.tick('miyue').id,'subscription');
 const started=repo.prepareSession({current:{kind:'reading',remainingMinutes:90}});assert.equal(started.session.status,'active');assert.equal(started.session.minutes,60);
 store.db.close();
});
