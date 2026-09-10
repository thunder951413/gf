import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InnerStateRepository, METRICS, STATE_FIELDS } from '../lib/inner-state.mjs';

class TestStore {
  constructor(filename = ':memory:') { this.db = new DatabaseSync(filename); }
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
  clock.add = (milliseconds) => { value = new Date(value.getTime() + milliseconds); };
  clock.set = (next) => { value = new Date(next); };
  return clock;
}

function raw(store) {
  return JSON.parse(store.db.prepare("SELECT state_json FROM inner_states WHERE role_id='miyue'").get().state_json);
}

test('only miyue is active and baseline is warm without default romance', () => {
  const store = new TestStore();
  const repo = new InnerStateRepository(store, { clock: clockAt('2026-09-06T02:00:00Z'), random: () => 0.5 });
  assert.equal(repo.get('zhixia'), null);
  assert.equal(repo.context('zhixia'), '');
  const state = repo.get();
  assert.ok(state.security >= 65);
  assert.ok(state.desire < 30);
  assert.equal(state.relationshipStage, '熟悉中的朋友');
  assert.equal(state.affectionAllowed, false);
  assert.match(repo.context(), /日常恋爱陪伴以各自生活/);
  const unchanged = JSON.stringify(raw(store));
  assert.equal(repo.initiative(), null);
  assert.equal(JSON.stringify(raw(store)), unchanged, 'an unchanged initiative read does not churn updatedAt');
  store.close();
});

test('daily-state drift starts at thirty minutes while needs accumulate separately, durably and bounded', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-state-'));
  const filename = path.join(directory, 'state.sqlite');
  const clock = clockAt('2026-09-05T22:00:00Z');
  let calls = 0;
  let store = new TestStore(filename);
  let repo = new InnerStateRepository(store, { clock, random: () => { calls += 1; return 0.9; } });
  const initial = repo.get();
  clock.add(29 * 60 * 1000);
  const ordinary=METRICS.filter(key=>!['affectionNeed','desire'].includes(key));
  assert.deepEqual(ordinary.map((key) => repo.get()[key]), ordinary.map((key) => initial[key]));
  assert.equal(calls, 0);
  clock.add(60 * 1000);
  const drifted = repo.get();
  assert.equal(calls, 1);
  assert.ok(METRICS.every((key) => drifted[key] >= 0 && drifted[key] <= 100));
  const durable = JSON.stringify(raw(store));
  store.close();
  store = new TestStore(filename);
  repo = new InnerStateRepository(store, { clock, random: () => { calls += 1; return 0; } });
  repo.get();
  assert.equal(JSON.stringify(raw(store)), durable, 'restart and same-time read do not reroll');
  const beforeAbsence = repo.get();
  clock.add(180 * 24 * 60 * 60 * 1000);
  const afterAbsence = repo.get();
  assert.equal(afterAbsence.desire,100);
  assert.equal(afterAbsence.affectionNeed,100);
  assert.equal(afterAbsence.affection,beforeAbsence.affection);
  assert.equal(calls, 13, 'long absence is capped at twelve half-hour windows');
  store.close();
  fs.rmSync(directory, { recursive: true });
});

test('an event applies one bounded impulse and never replays on reads or restart', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-event-'));
  const filename = path.join(directory, 'state.sqlite');
  const clock = clockAt('2026-09-06T02:00:00Z');
  const event = { id: 'work-1', category: 'work', phase: { activity: '赶稿' } };
  let store = new TestStore(filename);
  let repo = new InnerStateRepository(store, { clock, random: () => 0.5 });
  const once = repo.get('miyue', event);
  const twice = repo.get('miyue', event);
  assert.equal(once.stress, twice.stress);
  assert.equal(once.fatigue, twice.fatigue);
  assert.equal(once.journal.filter((entry) => entry.cause.includes('work')).length, 1);
  const vulnerable = repo.get('miyue', { id: 'emotion-low', category: 'emotional_need', title: '有点低落和脆弱' });
  assert.equal(vulnerable.mode, 'vulnerable');
  const relieved = repo.get('miyue', { id: 'emotion-relief', category: 'emotional_need', title: '得到支持后轻松释然' });
  assert.ok(relieved.stress < vulnerable.stress);
  assert.ok(relieved.security > vulnerable.security);
  store.close();
  store = new TestStore(filename);
  repo = new InnerStateRepository(store, { clock, random: () => 0 });
  assert.equal(repo.get('miyue', event).stress, relieved.stress);
  store.close();
  fs.rmSync(directory, { recursive: true });
});

test('explicit negative boundary wins over positive words, persists, and only explicit permission restores it', () => {
  const store = new TestStore();
  const clock = clockAt('2026-09-06T02:00:00Z');
  const repo = new InnerStateRepository(store, { clock, random: () => 0 });
  let state = repo.afterTurn('miyue', '我不想抱抱，也不要暧昧', { tone: 'playful', closeness: 'invited' });
  assert.equal(state.intimacyBoundary, 'friendly');
  assert.equal(state.suppressed, true);
  state = repo.afterTurn('miyue', '现在也不可以抱抱', { tone: 'playful', closeness: 'invited' });
  assert.equal(state.intimacyBoundary, 'friendly');
  state = repo.afterTurn('miyue', '今天天气不错', { tone: 'neutral', closeness: 'unspecified' });
  assert.equal(state.intimacyBoundary, 'friendly');
  const beforeRestore = state.desire;
  state = repo.afterTurn('miyue', '可以恢复亲密，也可以撒娇了', { tone: 'neutral', closeness: 'unspecified' });
  assert.equal(state.intimacyBoundary, 'open');
  assert.equal(state.suppressed, false);
  assert.equal(state.desire,beforeRestore, 'permission reopens the boundary without fabricating satisfaction or demand');
  store.close();
});

test('signals affect state, neutral chat does not escalate desire, and distress keeps care ahead of flirt', () => {
  const store = new TestStore();
  const repo = new InnerStateRepository(store, { clock: clockAt('2026-09-06T02:00:00Z'), random: () => 0 });
  const initial = repo.get();
  const supported = repo.afterTurn('miyue', '收到', { tone: 'supportive', closeness: 'unspecified' });
  assert.ok(supported.security > initial.security);
  assert.ok(supported.stress < initial.stress);
  const neutral = repo.afterTurn('miyue', '继续聊工作', { tone: 'neutral', closeness: 'unspecified' });
  assert.equal(neutral.desire, supported.desire);
  const distressed = repo.afterTurn('miyue', '今天很崩溃', { tone: 'distressed', closeness: 'unspecified' });
  assert.ok(distressed.stress > neutral.stress);
  assert.match(repo.context(), /需要先被倾听/);
  assert.throws(() => repo.afterTurn('miyue', 'x', { tone: 'romantic', closeness: 'invited' }), /valid tone/);
  store.close();
});

test('non-intimate initiative is idempotent and observes four-hour delivery cooldown', () => {
  const store = new TestStore();
  const clock = clockAt('2026-09-06T15:00:00Z'); // 23:00 Shanghai
  const repo = new InnerStateRepository(store, { clock, random: () => 0.5 });
  repo.get();
  clock.add(6 * 60 * 60 * 1000);
  const first = repo.initiative();
  assert.ok(first);
  assert.equal(first.intimacy, false);
  assert.equal(repo.initiative().key, first.key);
  assert.equal(repo.markInitiated('miyue', first.key, 'message-1'), true);
  assert.equal(repo.markInitiated('miyue', first.key, 'again'), false);
  assert.equal(repo.initiative(), null);
  clock.add(4 * 60 * 60 * 1000);
  const second = repo.initiative('miyue', { id: 'travel-after-rest', category: 'travel' });
  assert.ok(second);
  clock.add(3 * 60 * 60 * 1000);
  assert.equal(repo.markInitiated('miyue', second.key, 'stale-rest'), false, 'a next-day stale rest opener cannot be delivered');
  store.close();
});

test('legacy non-periodic intimacy retains its persisted probability gate and delivery spacing', () => {
  const store = new TestStore();
  const clock = clockAt('2026-09-05T22:00:00Z');
  const repo = new InnerStateRepository(store, { clock, random: () => 0.1 });
  repo.get();
  repo.update('miyue',{revision:0,needCycle:{enabled:false}});
  clock.add(13 * 60 * 60 * 1000);
  repo.afterTurn('miyue', '可以抱抱', { tone: 'playful', closeness: 'invited' });
  repo.afterTurn('miyue', '可以撒娇', { tone: 'playful', closeness: 'invited' });
  repo.afterTurn('miyue', '愿意拥抱', { tone: 'playful', closeness: 'invited' });
  repo.afterTurn('miyue', '允许靠近', { tone: 'playful', closeness: 'invited' });
  repo.afterTurn('miyue', '哈哈', { tone: 'playful', closeness: 'unspecified' });
  repo.afterTurn('miyue', '再开个玩笑', { tone: 'playful', closeness: 'unspecified' });
  const pending = repo.initiative();
  assert.ok(pending);
  assert.equal(pending.intimacy, true);
  assert.equal(repo.initiative().key, pending.key);
  repo.afterTurn('miyue', '不要暧昧', { tone: 'playful', closeness: 'invited' });
  assert.equal(repo.markInitiated('miyue', pending.key, 'stale-affection'), false);
  repo.afterTurn('miyue', '可以恢复亲密，也可以撒娇', { tone: 'playful', closeness: 'invited' });
  repo.afterTurn('miyue', '我愿意亲近', { tone: 'playful', closeness: 'invited' });
  repo.afterTurn('miyue', '可以抱抱', { tone: 'playful', closeness: 'invited' });
  repo.afterTurn('miyue', '可以撒娇', { tone: 'playful', closeness: 'invited' });
  repo.afterTurn('miyue', '哈哈', { tone: 'playful', closeness: 'unspecified' });
  const restored = repo.initiative();
  assert.ok(restored?.intimacy);
  assert.equal(repo.markInitiated('miyue', restored.key, 'affection-1'), true);
  clock.add(4 * 60 * 60 * 1000);
  for (let i = 0; i < 6; i += 1) repo.afterTurn('miyue', '哈哈', { tone: 'playful', closeness: 'unspecified' });
  assert.equal(repo.initiative(), null, 'sixteen-hour and local-day rules still suppress it');
  assert.equal(repo.get().affectionAllowed, false);
  store.close();
});

test('reply affection is tracked without retaining text and ordinary thanks is not counted', () => {
  const store = new TestStore();
  const clock = clockAt('2026-09-06T02:00:00Z');
  const repo = new InnerStateRepository(store, { clock, random: () => 0.5 });
  repo.get();
  assert.equal(repo.noteReply('miyue', '谢谢你关心'), false);
  assert.equal(repo.noteReply('miyue', '想给你一个抱抱', '我想抱抱'), true);
  const saved = JSON.stringify(raw(store));
  assert.doesNotMatch(saved, /想给你一个抱抱|我想抱抱/);
  assert.ok(repo.get().lastAffectionExpressionAt);
  store.close();
});

test('an affectionate reply invalidates an undelivered opener', () => {
  const store = new TestStore();
  const clock = clockAt('2026-09-06T15:00:00Z');
  const repo = new InnerStateRepository(store, { clock, random: () => 0.5 });
  repo.get();
  clock.add(6 * 60 * 60 * 1000);
  const pending = repo.initiative();
  assert.ok(pending);
  assert.equal(repo.noteReply('miyue', '先给你一个抱抱'), true);
  assert.equal(repo.markInitiated('miyue', pending.key, 'stale-after-reply'), false);
  store.close();
});

test('editable view exposes all metrics and manual edits persist with a stable edit revision', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'inner-edit-'));
  const filename = path.join(directory, 'state.sqlite');
  const clock = clockAt('2026-09-06T02:00:00Z');
  let store = new TestStore(filename);
  let repo = new InnerStateRepository(store, { clock, random: () => 0.5 });
  const initial = repo.view();
  assert.equal(initial.revision, 0);
  assert.deepEqual(Object.keys(initial.values), METRICS);
  assert.deepEqual(STATE_FIELDS.map(({ key }) => key), METRICS);
  assert.equal(initial.values.affection, 55);
  assert.equal(initial.values.mood, 65);
  const edited = repo.update('miyue', { revision: 0, values: { affection: 73, mood: 28 } });
  assert.equal(edited.revision, 1);
  assert.equal(edited.values.affection, 73);
  assert.equal(edited.values.mood, 28);
  assert.equal(repo.revision(), 1);
  clock.add(30 * 60 * 1000);
  assert.equal(repo.view().revision, 1, 'elapsed drift does not change the manual edit revision');
  store.close();
  store = new TestStore(filename);
  repo = new InnerStateRepository(store, { clock, random: () => 0.5 });
  assert.equal(repo.view().values.affection, 73);
  assert.equal(repo.revision(), 1);
  assert.match(repo.context(), /疲\d+ 饥\d+ 活\d+ 压\d+ 安\d+ 玩\d+ 喜欢73 愉悦\d+/);
  store.close();
  fs.rmSync(directory, { recursive: true });
});

test('legacy stored states receive new metric defaults without losing existing values', () => {
  const store = new TestStore();
  const at = '2026-09-06T02:00:00.000Z';
  const repo = new InnerStateRepository(store, { clock: clockAt(at), random: () => 0.5 });
  store.db.prepare('INSERT INTO inner_states(role_id,state_json,updated_at) VALUES(?,?,?)').run(
    'miyue',
    JSON.stringify({ fatigue: 41, hunger: 22, vitality: 63, stress: 35, security: 71,
      affectionNeed: 39, desire: 18, playfulness: 57, driftedAt: at, updatedAt: at }),
    at,
  );
  const state = repo.view();
  assert.equal(state.values.fatigue, 41);
  assert.equal(state.values.affection, 55);
  assert.equal(state.values.mood, 65);
  assert.equal(state.revision, 0);
  store.close();
});

test('manual edit validation is strict, stale writes are atomic, and patches preserve other fields', () => {
  const store = new TestStore();
  const clock = clockAt('2026-09-06T02:00:00Z');
  const repo = new InnerStateRepository(store, { clock, random: () => 0.9 });
  repo.view();
  const invalid = [
    () => repo.update('other', { revision: 0, values: { mood: 50 } }),
    () => repo.update('miyue', { values: { mood: 50 } }),
    () => repo.update('miyue', { revision: 0, values: {} }),
    () => repo.update('miyue', { revision: 0, values: { unknown: 2 } }),
    () => repo.update('miyue', { revision: 0, values: { mood: 1.5 } }),
    () => repo.update('miyue', { revision: 0, values: { mood: 101 } }),
  ];
  for (const attempt of invalid) {
    let caught;
    try { attempt(); } catch (error) { caught = error; }
    assert.equal(caught?.status, 400);
  }
  const before = repo.view();
  const edited = repo.update('miyue', { revision: before.revision, values: { mood: 44 } });
  assert.equal(edited.values.fatigue, before.values.fatigue);
  const saved = JSON.stringify(raw(store));
  clock.add(30 * 60 * 1000);
  let conflict;
  try { repo.update('miyue', { revision: 0, values: { fatigue: 99 } }); } catch (error) { conflict = error; }
  assert.equal(conflict?.status, 409);
  assert.equal(JSON.stringify(raw(store)), saved, 'the transaction rolls elapsed drift back with a stale edit');
  store.close();
});

test('mood changes mode while liking gates only autonomous intimacy', () => {
  const clock = clockAt('2026-09-06T15:00:00Z');
  const highStore = new TestStore();
  const high = new InnerStateRepository(highStore, { clock, random: () => 0.1 });
  high.view();
  clock.add(13 * 60 * 60 * 1000);
  let highState = high.update('miyue', { revision: 0, values: {
    fatigue: 20, vitality: 80, stress: 10, security: 80, affectionNeed: 40,
    desire: 90, playfulness: 50, affection: 80, mood: 90,
  } });
  assert.equal(highState.mode, 'playful');
  highState = high.update('miyue', { revision: highState.revision, values: { playfulness: 80 } });
  high.afterTurn('miyue', '哈哈', { tone: 'playful', closeness: 'unspecified' });
  assert.equal(high.initiative()?.intimacy, true);

  const lowStore = new TestStore();
  const low = new InnerStateRepository(lowStore, { clock, random: () => 0.1 });
  low.view();
  const lowState = low.update('miyue', { revision: 0, values: {
    fatigue: 20, vitality: 80, stress: 10, security: 80, affectionNeed: 40,
    desire: 30, playfulness: 80, affection: 49, mood: 30,
  } });
  assert.equal(lowState.mode, 'vulnerable');
  low.afterTurn('miyue', '哈哈', { tone: 'playful', closeness: 'unspecified' });
  assert.notEqual(low.initiative()?.intimacy, true, 'low liking prevents an autonomous intimate opener');
  const invited = low.afterTurn('miyue', '可以抱抱', { tone: 'neutral', closeness: 'invited' });
  assert.ok(invited.desire < lowState.values.desire, 'an accepted user invitation satisfies physical need even with low liking');
  highStore.close();
  lowStore.close();
});

test('liking never drifts or falls and supportive/playful gains are capped at two per local day', () => {
  const store = new TestStore();
  const clock = clockAt('2026-09-06T02:00:00Z');
  const repo = new InnerStateRepository(store, { clock, random: () => 0.9 });
  const initial = repo.view();
  clock.add(180 * 24 * 60 * 60 * 1000);
  assert.equal(repo.view().values.affection, initial.values.affection);
  repo.afterTurn('miyue', '辛苦了', { tone: 'supportive', closeness: 'unspecified' });
  repo.afterTurn('miyue', '哈哈', { tone: 'playful', closeness: 'unspecified' });
  repo.afterTurn('miyue', '再开个玩笑', { tone: 'playful', closeness: 'unspecified' });
  assert.equal(repo.view().values.affection, initial.values.affection + 2);
  repo.afterTurn('miyue', '不聊了', { tone: 'distant', closeness: 'unspecified' });
  assert.equal(repo.view().values.affection, initial.values.affection + 2);
  clock.add(24 * 60 * 60 * 1000);
  repo.afterTurn('miyue', '我在', { tone: 'supportive', closeness: 'unspecified' });
  assert.equal(repo.view().values.affection, initial.values.affection + 3);
  store.close();
});

test('a manual edit invalidates an already composed initiative', () => {
  const store = new TestStore();
  const clock = clockAt('2026-09-06T15:00:00Z');
  const repo = new InnerStateRepository(store, { clock, random: () => 0.5 });
  repo.view();
  clock.add(6 * 60 * 60 * 1000);
  const pending = repo.initiative();
  assert.ok(pending);
  const revision = repo.revision();
  repo.update('miyue', { revision, values: { mood: 50 } });
  assert.equal(repo.markInitiated('miyue', pending.key, 'stale-after-edit'), false);
  store.close();
});

test('explicit need words persist across reload and take precedence over legacy numeric needs',()=>{
 const store=new TestStore(),clock=clockAt('2026-09-06T02:00:00Z');let repo=new InnerStateRepository(store,{clock,random:()=>.5});
 const before=repo.view();const words={emotional:'希望你回应她刚才的分享',physical:'渴望被你拥抱、轻轻抚摸，也想与你接吻'};
 const saved=repo.update('miyue',{revision:before.revision,needs:words});assert.deepEqual(saved.needs,words);assert.deepEqual(saved.values,before.values);
 repo=new InnerStateRepository(store,{clock,random:()=>.5});clock.add(24*3600000);
 const restored=repo.view();assert.deepEqual(restored.needs,words);assert.match(repo.context(),/渴望被你拥抱、轻轻抚摸，也想与你接吻/);assert.doesNotMatch(repo.context(),/亲需\d|亲愿\d/);
 const cleared=repo.update('miyue',{revision:saved.revision,needs:{physical:'  '},values:{desire:99}});assert.equal(cleared.needs.physical,'');assert.equal(cleared.needs.emotional,words.emotional);
 assert.doesNotMatch(repo.context(),/轻轻抚摸/);store.close();
});
test('need edits validate atomically and retain revision conflict protection',()=>{
 const store=new TestStore(),repo=new InnerStateRepository(store,{clock:clockAt('2026-09-06T02:00:00Z')});repo.view();
 for(const needs of [{},{physical:70},{physical:null},{physical:'x'.repeat(161)},{unknown:'想被拥抱'},[]]){
  assert.throws(()=>repo.update('miyue',{revision:0,values:{mood:1},needs}),error=>error.status===400);
  assert.equal(repo.view().values.mood,65);assert.equal(repo.revision(),0);
 }
 repo.update('miyue',{revision:0,needs:{physical:'想被你轻轻抚摸'}});
 assert.throws(()=>repo.update('miyue',{revision:0,needs:{physical:''}}),error=>error.status===409);
 assert.equal(repo.view().needs.physical,'想被你轻轻抚摸');store.close();
});
test('when periodic accumulation is off, manually written wishes retain legacy proactive behavior',()=>{
 const store=new TestStore(),clock=clockAt('2026-09-06T02:00:00Z'),repo=new InnerStateRepository(store,{clock,random:()=>.1});repo.view();clock.add(24*3600000);
 let view=repo.update('miyue',{revision:0,needCycle:{enabled:false},values:{affection:90,mood:80,fatigue:10,vitality:90,stress:10,security:90,playfulness:80,desire:0,affectionNeed:0},needs:{emotional:'',physical:'想与你接吻'}});
 repo.afterTurn('miyue','哈哈',{tone:'playful',closeness:'unspecified'});
 const first=repo.initiative();assert.ok(first?.intimacy);assert.match(first.context,/想与你接吻/);
 view=repo.update('miyue',{revision:view.revision,needs:{physical:'',emotional:'希望你回应她刚才的分享'}});
 assert.equal(repo.markInitiated('miyue',first.key,'stale-message'),false);
 const second=repo.initiative();assert.ok(second);assert.equal(second.intimacy,false);assert.match(second.context,/希望你回应她刚才的分享/);
 repo.update('miyue',{revision:view.revision,needs:{physical:'',emotional:''}});assert.equal(repo.initiative(),null);store.close();
});
