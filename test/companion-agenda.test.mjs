import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  CompanionAgenda, COMPANION_AGENDA_PROMPT_INSTRUCTION, itemWeight, promptInstruction,
} from '../lib/companion-agenda.mjs';

class TestStore {
  constructor(filename = ':memory:') {
    this.db = new DatabaseSync(filename);
    this.db.exec(`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, role TEXT NOT NULL, speaker TEXT NOT NULL,
      text TEXT NOT NULL, created_at TEXT NOT NULL
    )`);
  }
  transaction(fn) {
    const nested = Boolean(this.depth);
    const point = `agenda_test_${this.depth || 0}`;
    this.db.exec(nested ? `SAVEPOINT ${point}` : 'BEGIN IMMEDIATE');
    this.depth = (this.depth || 0) + 1;
    try {
      const result = fn();
      if (this.failCommit) { this.failCommit = false; throw new Error('forced state failure'); }
      this.db.exec(nested ? `RELEASE ${point}` : 'COMMIT');
      return result;
    } catch (error) {
      this.db.exec(nested ? `ROLLBACK TO ${point}; RELEASE ${point}` : 'ROLLBACK');
      throw error;
    } finally { this.depth -= 1; }
  }
  message(id, role, speaker, text, createdAt = new Date().toISOString()) {
    this.db.prepare('INSERT INTO messages(id,role,speaker,text,created_at) VALUES(?,?,?,?,?)').run(id, role, speaker, text, createdAt);
    return this.getMessage(id);
  }
  getMessage(id) { return this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) || null; }
  close() { this.db.close(); }
}

function fixture(filename = ':memory:', random = () => .5) {
  let time = new Date('2026-09-08T02:00:00.000Z'); // 10:00 Shanghai
  const store = new TestStore(filename);
  const repo = new CompanionAgenda(store, { clock: () => new Date(time), random });
  return {
    store, repo,
    advance(hours) { time = new Date(time.getTime() + hours * 3_600_000); },
    set(value) { time = new Date(value); },
    row(id, speaker, text, role = 'miyue') { return store.message(id, role, speaker, text, time.toISOString()); },
    close() { store.close(); },
  };
}

test('a user recommendation is selected once, survives restart, starts while idle, and needs a delivered receipt', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agenda-recommend-'));
  const filename = path.join(directory, 'life.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let draws = 0;
  const f = fixture(filename, () => { draws += 1; return .5; });
  const recommendation = f.row('u-rec', 'user', '推荐你看看《海边的卡夫卡》');
  let view = f.repo.observe('miyue', [recommendation]);
  assert.equal(draws, 1);
  assert.equal(view.plans[0].owner, 'character');
  assert.equal(view.plans[0].status, 'suggested');
  assert.equal(view.plans[0].provenance, '你前面推荐的《海边的卡夫卡》');
  const dueAt = view.plans[0].dueAt;
  f.close();

  const restarted = fixture(filename, () => { draws += 1; return 0; });
  t.after(() => restarted.close());
  assert.equal(restarted.repo.view('miyue').plans[0].dueAt, dueAt);
  assert.equal(draws, 1, 'restart never redraws a recommendation time');
  restarted.set(new Date(Date.parse(dueAt) + 1));
  restarted.repo.tick('miyue');
  const pending = restarted.repo.pending('miyue');
  assert.match(pending.anchor, /你前面推荐的《海边的卡夫卡》/u);
  assert.equal(restarted.repo.view('miyue').plans[0].status, 'active');
  assert.equal(restarted.repo.markDelivered('miyue', pending.key, 'missing', pending.version), false);
  restarted.row('wrong-speaker', 'user', pending.anchor);
  assert.equal(restarted.repo.markDelivered('miyue', pending.key, 'wrong-speaker', pending.version), false);
  restarted.row('opening', 'assistant', `我开始看${pending.anchor}了。`);
  assert.equal(restarted.repo.markDelivered('miyue', pending.key, 'opening', pending.version), true);
  assert.equal(restarted.repo.markDelivered('miyue', pending.key, 'opening', pending.version), true, 'delivery is idempotent');

  const completed = restarted.row('a-done', 'assistant', '我把《海边的卡夫卡》读完了，最后一段让我停了很久。');
  view = restarted.repo.observe('miyue', [completed], [{
    action: 'complete', id: view.plans[0].id, kind: 'reading', evidence: '读完了', source: 'assistant',
  }]);
  assert.equal(view.plans[0].status, 'completed');
  const outcome = restarted.repo.pending('miyue');
  assert.equal(outcome.type, 'outcome');
  restarted.row('outcome', 'assistant', `关于${outcome.anchor}，我最想跟你说的是结尾的留白。`);
  assert.equal(restarted.repo.markDelivered('miyue', outcome.key, 'outcome', outcome.version), true);
  assert.equal(restarted.repo.pending('miyue'), null);
});

test('joint proposal binds actual opposite-speaker acceptance and supports pause, progress, and cancel', () => {
  const f = fixture();
  const proposal = f.row('a-propose', 'assistant', '今晚要不要一起读《城南旧事》？');
  let view = f.repo.observe('miyue', [proposal], [{ action: 'propose', id: 'shared-book', kind: 'reading', title: '城南旧事', evidence: '一起读《城南旧事》', source: 'assistant', dueAt: '2026-09-08T12:00:00Z' }]);
  assert.equal(view.plans[0].status, 'proposed');
  const acceptance = f.row('u-accept', 'user', '好呀，今晚一起读');
  view = f.repo.observe('miyue', [acceptance], [{ action: 'accept', id: 'shared-book', kind: 'reading', evidence: '今晚一起读', source: 'user' }]);
  assert.equal(view.plans[0].status, 'planned');
  assert.equal(view.plans[0].owner, 'joint');
  f.set('2026-09-09T00:00:00Z');
  view = f.repo.tick('miyue');
  assert.equal(view.plans[0].status, 'awaiting_confirmation');
  assert.notEqual(view.plans[0].status, 'completed', 'passing the due time is not completion');
  view = f.repo.update('miyue', { revision: view.revision, action: 'start', id: 'shared-book' });
  view = f.repo.update('miyue', { revision: view.revision, action: 'pause', id: 'shared-book' });
  assert.equal(view.plans[0].status, 'paused');
  const progress = f.row('u-progress', 'user', '我读到搬家那一章了');
  view = f.repo.observe('miyue', [progress], [{ action: 'progress', id: 'shared-book', kind: 'reading', progress: '搬家那一章', evidence: '搬家那一章', source: 'user' }]);
  assert.equal(view.plans[0].status, 'paused');
  assert.equal(view.plans[0].progress, '搬家那一章');
  view = f.repo.update('miyue', { revision: view.revision, action: 'cancel', id: 'shared-book' });
  assert.equal(view.plans[0].status, 'cancelled');
  f.close();
});

test('acceptance is adjacent, same-turn user requests precede assistant acceptance, and Chinese duration is exact', () => {
  const f = fixture();
  const oldProposal = f.row('old-proposal', 'assistant', '要不要一起看《花样年华》？');
  let view = f.repo.observe('miyue', [oldProposal], [{ action: 'propose', id: 'old-film', kind: 'film', title: '花样年华', evidence: '一起看《花样年华》', source: 'assistant' }]);
  f.row('intervening', 'assistant', '窗外开始下雨了。');
  const lateYes = f.row('late-yes', 'user', '好呀');
  view = f.repo.observe('miyue', [lateYes], [{ action: 'accept', id: 'old-film', kind: 'film', evidence: '好呀', source: 'user' }]);
  assert.equal(view.plans.find(plan => plan.id === 'old-film').status, 'proposed');

  const request = f.row('quiet-request', 'user', '陪我待三十分钟');
  const accepted = f.row('quiet-accept', 'assistant', '好，我陪你待着。');
  view = f.repo.observe('miyue', [request, accepted], [{ action: 'accept', kind: 'quiet', evidence: '好，我陪你待着', source: 'assistant' }]);
  const quiet = view.plans.find(plan => plan.sourceMessageId === 'quiet-request');
  assert.equal(quiet.durationMinutes, 30);
  assert.equal(quiet.status, 'active');
  f.close();
});

test('quiet sessions await confirmation and create only one finish check', () => {
  const f = fixture();
  let view = f.repo.update('miyue', {
    revision: 0, action: 'create', kind: 'quiet', title: '一起安静十分钟', owner: 'joint',
    dueAt: '2026-09-08T03:00:00Z', durationMinutes: 10,
  });
  f.set('2026-09-08T03:00:00Z');
  view = f.repo.tick('miyue');
  assert.equal(view.plans[0].status, 'awaiting_confirmation');
  view = f.repo.update('miyue', { revision: view.revision, action: 'start', id: view.plans[0].id });
  assert.equal(view.plans[0].status, 'active');
  let pending = f.repo.pending('miyue');
  f.row('quiet-open', 'assistant', `现在开始${pending.anchor}。`);
  assert.equal(f.repo.markDelivered('miyue', pending.key, 'quiet-open', pending.version), true);
  f.advance(5 / 60);
  view = f.repo.update('miyue', { revision: f.repo.revision('miyue'), action: 'pause', id: view.plans[0].id });
  f.advance(1);
  view = f.repo.update('miyue', { revision: view.revision, action: 'resume', id: view.plans[0].id });
  f.advance(4 / 60);
  assert.equal(f.repo.tick('miyue').plans[0].status, 'active', 'paused wall time is not counted');
  f.advance(2 / 60);
  view = f.repo.tick('miyue');
  assert.equal(view.plans[0].status, 'awaiting_confirmation');
  pending = f.repo.pending('miyue');
  assert.equal(pending.type, 'finish-check');
  assert.match(pending.detail, /不能声称用户完成/u);
  f.repo.tick('miyue');
  assert.equal(f.repo.pending('miyue').key, pending.key, 'repeated ticks do not add finish checks');
  f.advance(49);
  assert.equal(f.repo.pending('miyue'), null, 'an unanswered check expires without penalty');
  assert.equal(f.repo.view('miyue').plans[0].status, 'awaiting_confirmation');
  f.close();
});

test('an agenda edit during generation rejects a stale opportunity receipt', () => {
  const f = fixture();
  let view = f.repo.update('miyue', {
    revision: 0, action: 'create', kind: 'chat', title: '今晚聊十分钟', owner: 'joint', dueAt: '2026-09-08T03:00:00Z',
  });
  f.set('2026-09-08T03:00:00Z');
  f.repo.tick('miyue');
  const pending = f.repo.pending('miyue');
  f.row('stale-message', 'assistant', `我们来${pending.anchor}。`);
  view = f.repo.view('miyue');
  f.repo.update('miyue', { revision: view.revision, action: 'interest', title: '聊天', value: 1 });
  assert.equal(f.repo.markDelivered('miyue', pending.key, 'stale-message', pending.version), false);
  f.close();
});

test('ritual occurrences collapse missed time and never form a backlog', () => {
  const f = fixture();
  let view = f.repo.update('miyue', {
    revision: 0, action: 'create', kind: 'ritual', title: '晚间十分钟聊天', owner: 'joint',
    dueAt: '2026-09-08T12:00:00Z', recurrence: { frequency: 'daily', time: '20:00' },
  });
  f.set('2026-09-28T12:00:00Z');
  view = f.repo.tick('miyue');
  assert.equal(view.plans[0].status, 'awaiting_confirmation');
  assert.match(view.plans[0].currentOccurrenceId, /2026-09-28$/u);
  assert.equal(f.repo.pending('miyue').type, 'opening');
  view = f.repo.update('miyue', { revision: view.revision, action: 'complete', id: view.plans[0].id, confirmed: true });
  assert.equal(view.plans[0].status, 'completed');
  assert.ok(Date.parse(view.plans[0].dueAt) > Date.parse('2026-09-28T12:00:00Z'));
  assert.equal(view.plans.filter(plan => plan.kind === 'ritual').length, 1);
  f.close();
});

test('source rows control actor and role, duplicate evidence is bounded, and suppression hides derived facts', () => {
  const f = fixture();
  const row = f.row('u-like', 'user', '我特别喜欢包豪斯设计');
  let view = f.repo.observe('miyue', [row], [
    { action: 'interest', kind: 'chat', title: '包豪斯', sentiment: 2, evidence: '包豪斯设计', source: 'assistant' },
    { action: 'interest', kind: 'chat', title: '包豪斯', sentiment: 2, evidence: '不存在的原话', source: 'user' },
    { action: 'interest', kind: 'chat', title: '包豪斯', sentiment: 2, evidence: '包豪斯设计', source: 'user' },
  ]);
  const interest = view.interests.find(item => item.title === '包豪斯');
  assert.equal(interest.audience, 'user');
  assert.equal(interest.value, 1);
  view = f.repo.observe('miyue', [row], [{ action: 'interest', kind: 'chat', title: '包豪斯', sentiment: 2, evidence: '包豪斯设计', source: 'user' }]);
  assert.equal(view.interests.find(item => item.title === '包豪斯').value, 1, 'same saved message cannot inflate weight');
  assert.equal(f.repo.view('miyue', { suppressedSourceIds: ['u-like'] }).interests.some(item => item.title === '包豪斯'), false);
  assert.doesNotMatch(f.repo.context('miyue', { suppressedSourceIds: ['u-like'] }), /包豪斯/u);
  const otherRole = f.row('other', 'user', '推荐你看看《不该出现》', 'other');
  f.repo.observe('miyue', [otherRole]);
  assert.equal(f.repo.view('miyue').plans.length, 0);
  f.repo.observe('miyue', [{ id: 'fabricated', role: 'miyue', speaker: 'user', text: '推荐你看看《假的》' }]);
  assert.equal(f.repo.view('miyue').plans.length, 0, 'unsaved rows are never trusted');
  f.close();
});

test('generic text cannot complete, deleted sources disappear, and stale opportunities are invalidated by reschedule', () => {
  const f = fixture();
  let view = f.repo.update('miyue', { revision: 0, action: 'create', kind: 'cooking', title: '做番茄鸡蛋面', owner: 'character', dueAt: '2026-09-08T03:00:00Z' });
  f.set('2026-09-08T03:00:00Z');
  view = f.repo.tick('miyue');
  const generic = f.row('generic-done', 'assistant', '好');
  view = f.repo.observe('miyue', [generic], [{ action: 'complete', id: view.plans[0].id, kind: 'cooking', evidence: '好', source: 'assistant' }]);
  assert.equal(view.plans[0].status, 'active');
  assert.ok(f.repo.pending('miyue'));
  view = f.repo.update('miyue', { revision: view.revision, action: 'reschedule', id: view.plans[0].id, dueAt: '2026-09-09T03:00:00Z' });
  assert.equal(f.repo.pending('miyue'), null);

  const ownTaste = f.row('own-taste', 'assistant', '我越来越喜欢黑白电影的光影。');
  f.repo.observe('miyue', [ownTaste], [{ action: 'interest', kind: 'film', title: '电影', sentiment: 2, evidence: '喜欢黑白电影', source: 'assistant' }]);
  assert.ok(f.repo.itemWeight({ title: '黑白片', kind: 'film' }) > 1);
  assert.equal(f.repo.itemWeight({ title: '黑白片', kind: 'film' }, { suppressedSourceIds: ['own-taste'] }), 1);
  f.store.db.prepare('DELETE FROM messages WHERE id=?').run('own-taste');
  assert.equal(f.repo.itemWeight({ title: '黑白片', kind: 'film' }), 1);

  const proposal = f.row('delete-proposal', 'assistant', '要不要一起看《春光乍泄》？');
  f.repo.observe('miyue', [proposal], [{ action: 'propose', id: 'delete-film', kind: 'film', title: '春光乍泄', evidence: '一起看《春光乍泄》', source: 'assistant' }]);
  f.store.db.prepare('DELETE FROM messages WHERE id=?').run('delete-proposal');
  f.advance(25);
  assert.equal(f.repo.view('miyue').plans.some(plan => plan.id === 'delete-film'), false);
  assert.notEqual(f.repo.pending('miyue')?.planId,'delete-film');
  f.close();
});

test('UI validation and terminal transitions are strict', () => {
  const f = fixture();
  assert.throws(() => f.repo.update('miyue', { revision: 0, action: 'create', kind: 'quiet', title: '', owner: 'joint' }), /标题/u);
  assert.throws(() => f.repo.update('miyue', { revision: 0, action: 'create', kind: 'quiet', title: '安静', owner: 'joint', durationMinutes: 0 }), /时长/u);
  assert.throws(() => f.repo.update('miyue', { revision: 0, action: 'create', kind: 'ritual', title: '晚聊', owner: 'joint', recurrence: { frequency: 'weekly', time: '25:00', weekday: 7 } }), /时间|weekday/u);
  let view = f.repo.update('miyue', { revision: 0, action: 'create', kind: 'chat', title: '聊聊', owner: 'joint', dueAt: '2026-09-08T03:00:00Z' });
  view = f.repo.update('miyue', { revision: view.revision, action: 'cancel', id: view.plans[0].id });
  assert.throws(() => f.repo.update('miyue', { revision: view.revision, action: 'resume', id: view.plans[0].id }), /不能恢复/u);
  f.close();
});

test('a timed character outing keeps its location, ends without claiming completion, and rejects shared teleporting', () => {
  const f = fixture();
  let view = f.repo.update('miyue', { revision: 0, action: 'create', kind: 'outing', title: '去静安公园散步', owner: 'character', location: '静安公园', dueAt: '2026-09-08T03:00:00Z', durationMinutes: 30 });
  const id = view.plans[0].id;
  f.set('2026-09-08T03:00:00Z'); view = f.repo.tick('miyue');
  assert.equal(view.plans[0].status, 'active');
  assert.equal(view.plans[0].location, '静安公园');
  assert.equal(view.plans[0].endAt, '2026-09-08T03:30:00.000Z');
  const opening = f.repo.pending('miyue');
  f.row('outing-opening', 'assistant', opening.anchor);
  assert.equal(f.repo.markDelivered('miyue', opening.key, 'outing-opening', opening.version), true);
  f.advance(31 / 60); view = f.repo.tick('miyue');
  assert.equal(view.plans[0].status, 'awaiting_confirmation');
  assert.equal(view.plans[0].completedAt, undefined);
  assert.equal(f.repo.pending('miyue').type, 'finish-check');
  assert.throws(() => f.repo.update('miyue', { revision: view.revision, action: 'create', kind: 'outing', title: '一起去公园', owner: 'joint', location: '静安公园', dueAt: '2026-09-09T03:00:00Z' }), /地点/u);
  assert.throws(() => f.repo.update('miyue', { revision: view.revision, action: 'edit', id, durationMinutes: 0 }), /时长/u);
  f.close();
});

test('a rescheduled activity expires its old opening and an overdue character plan is marked missed', () => {
  const f = fixture();
  let view = f.repo.update('miyue', { revision: 0, action: 'create', kind: 'outing', title: '去看展', owner: 'character', dueAt: '2026-09-08T03:00:00Z', durationMinutes: 45 });
  const id = view.plans[0].id;
  f.set('2026-09-08T03:00:00Z'); f.repo.tick('miyue'); assert.equal(f.repo.pending('miyue').type, 'opening');
  view = f.repo.update('miyue', { revision: f.repo.revision('miyue'), action: 'edit', id, dueAt: '2026-09-09T03:00:00Z', durationMinutes: 60, location: '美术馆' });
  assert.equal(view.plans[0].status, 'planned'); assert.equal(f.repo.pending('miyue'), null);
  f.set('2026-09-10T08:00:00Z'); view = f.repo.tick('miyue');
  assert.equal(view.plans[0].status, 'awaiting_confirmation');
  assert.equal(view.plans[0].missed, true);
  assert.equal(f.repo.pending('miyue'), null);
  f.close();
});

test('unambiguous chat commands pause and resume the current shared plan', () => {
  const f = fixture();
  let view = f.repo.update('miyue', { revision: 0, action: 'create', kind: 'chat', title: '睡前聊天', owner: 'joint', dueAt: '2026-09-08T03:00:00Z' });
  f.set('2026-09-08T03:00:00Z');
  view = f.repo.tick('miyue');
  const start = f.row('chat-start', 'user', '现在开始吧');
  view = f.repo.observe('miyue', [start]);
  assert.equal(view.plans[0].status, 'active');
  const pause = f.row('chat-pause', 'user', '先暂停一下');
  view = f.repo.observe('miyue', [pause]);
  assert.equal(view.plans[0].status, 'paused');
  const resume = f.row('chat-resume', 'user', '继续刚才那个');
  view = f.repo.observe('miyue', [resume]);
  assert.equal(view.plans[0].status, 'active');
  f.close();
});

test('optimistic updates rollback atomically and item weights reflect her own positive and negative tastes', () => {
  const f = fixture();
  let view = f.repo.update('miyue', { revision: 0, action: 'interest', title: '电影', value: 2 });
  view = f.repo.update('miyue', { revision: view.revision, action: 'interest', title: '旅行', value: -2 });
  assert.ok(f.repo.itemWeight({ title: '旧电影', kind: 'film' }) > 1);
  assert.ok(f.repo.itemWeight({ title: '远途旅行', kind: 'travel' }) < 1);
  assert.equal(itemWeight({ title: '电影旅行', kind: 'film' }, [
    { title: '电影', value: 20, audience: 'character' }, { title: '旅行', value: 20, audience: 'character' },
  ]), 3);
  assert.throws(() => f.repo.update('miyue', { revision: 0, action: 'interest', title: '书', value: 1 }), error => error.code === 'STALE_COMPANION_AGENDA');
  const before = f.repo.view('miyue');
  f.store.failCommit = true;
  assert.throws(() => f.repo.update('miyue', { revision: before.revision, action: 'interest', title: '烹饪', value: 2 }), /forced state failure/u);
  assert.deepEqual(f.repo.view('miyue'), before);
  assert.equal(promptInstruction(), COMPANION_AGENDA_PROMPT_INSTRUCTION);
  assert.match(promptInstruction(), /0到3个/u);
  assert.ok(f.repo.context('miyue').length <= 1200);
  f.close();
});
test('a negated completion or invented replacement id cannot mutate an existing plan',()=>{const f=fixture();let view=f.repo.update('miyue',{revision:0,action:'create',kind:'reading',title:'城南旧事',owner:'character',dueAt:'2026-09-08T03:00:00Z'});f.advance(2);view=f.repo.tick('miyue');const id=view.plans[0].id;const row=f.row('not-finished','assistant','我还没读完《城南旧事》，今天只是翻了几页。');f.repo.observe('miyue',[row],[{action:'complete',id,kind:'reading',evidence:'读完',source:'assistant'}]);assert.equal(f.repo.view('miyue').plans[0].status,'active');const other=f.row('bad-id','user','推荐你看看《另一部书》');f.repo.observe('miyue',[other],[{action:'recommend',id,kind:'reading',title:'另一部书',source:'user',evidence:other.text}]);assert.equal(f.repo.view('miyue').plans.find(p=>p.id===id).title,'城南旧事');f.close();});
test('forgotten active activities do not block fresh recommendations or affect selection',()=>{const f=fixture();const first=f.row('forgotten','user','推荐你看看《旧书》');f.repo.observe('miyue',[first]);f.advance(40);f.repo.tick('miyue');assert.equal(f.repo.view('miyue').plans[0].status,'active');const next=f.row('new','user','推荐你看看《新书》');f.repo.observe('miyue',[next]);f.repo.getSuppressedSourceIds=()=>['forgotten'];f.advance(40);f.repo.tick('miyue');const view=f.repo.view('miyue');assert.equal(view.plans.length,1);assert.equal(view.plans[0].title,'新书');assert.equal(view.plans[0].status,'active');f.close();});
test('actual model prose updates her reading progress and completion even without optional metadata',()=>{const f=fixture();f.repo.observe('miyue',[f.row('rec','user','推荐你看看《城南旧事》')]);f.advance(40);f.repo.tick('miyue');let view=f.repo.observe('miyue',[f.row('progress','assistant','现在就剩最后一章，打算今晚泡杯茶慢慢读完。')]);assert.notEqual(view.plans[0].status,'completed');view=f.repo.observe('miyue',[f.row('progress-now','assistant','我现在读到最后一章了。')]);assert.match(view.plans[0].progress,/最后一章/);view=f.repo.observe('miyue',[f.row('finished','assistant','记得的，《城南旧事》嘛。那本旧书我读完最后一章了，合上时还舍不得。')]);assert.equal(view.plans[0].status,'completed');assert.equal(view.plans[0].completedBy,'character');f.close();});
test('an unanswered recurring invitation skips missed weeks and resumes without claiming completion',()=>{const f=fixture();f.repo.update('miyue',{revision:0,action:'create',kind:'ritual',title:'周五分享一件小事',owner:'joint',recurrence:{frequency:'weekly',weekday:5,time:'20:00'}});f.set('2026-09-11T12:00:00Z');f.repo.tick('miyue');const first=f.repo.pending('miyue');assert.ok(first);f.set('2026-10-02T12:00:00Z');f.repo.tick('miyue');const current=f.repo.pending('miyue');assert.ok(current);assert.notEqual(current.key,first.key);const plan=f.repo.view('miyue').plans[0];assert.equal(plan.status,'awaiting_confirmation');assert.equal(plan.completedAt,undefined);assert.equal(f.repo.pending('miyue').key,current.key);f.close();});
