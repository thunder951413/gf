import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LifeThreadRepository, defaultLifeThreads } from '../lib/life-threads.mjs';

class TestStore {
  constructor(filename = ':memory:') {
    this.db = new DatabaseSync(filename);
    this.db.exec('CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,role TEXT NOT NULL,speaker TEXT NOT NULL,text TEXT NOT NULL)');
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); }
}

function addMessage(store, id, text, { role = 'miyue', speaker = 'assistant' } = {}) {
  store.db.prepare('INSERT INTO messages(id,role,speaker,text) VALUES(?,?,?,?)').run(id, role, speaker, text);
  return id;
}

function addAssistantFor(repo, id, text = null) {
  const current = repo.get('miyue');
  return addMessage(repo.store, id, text ?? current.beat.text);
}

function clockAt(initial) {
  let value = new Date(initial);
  const clock = () => new Date(value);
  clock.addHours = (hours) => { value = new Date(value.getTime() + hours * 3600_000); };
  clock.set = (next) => { value = new Date(next); };
  return clock;
}

function deliverAndAdvance(repo, clock, messageId) {
  const current = repo.get('miyue');
  addAssistantFor(repo, messageId, current.beat.text);
  assert.equal(repo.markDelivered(current.pendingKey, messageId), true);
  clock.set(repo.get('miyue').dueAt);
  return repo.tick('miyue');
}

test('catalog has grounded authored arcs with 4-5 paced beats', () => {
  assert.ok(defaultLifeThreads.templates.length >= 3);
  assert.ok(defaultLifeThreads.templates.some((item) => item.id === 'design-packaging'));
  assert.ok(defaultLifeThreads.templates.some((item) => item.id === 'hobby-collage'));
  assert.ok(defaultLifeThreads.templates.some((item) => item.id === 'travel-notebook'));
  for (const template of defaultLifeThreads.templates) {
    assert.ok(template.beats.length >= 4 && template.beats.length <= 5);
    assert.ok(template.beats.every((beat) => beat.delayHours >= 12 && beat.delayHours <= 24));
  }
});

test('only explicit miyue get seeds and repeated reads never advance or revise', () => {
  const store = new TestStore();
  const clock = clockAt('2026-09-07T02:00:00Z');
  const repo = new LifeThreadRepository(store, { clock, random: () => 0 });
  assert.equal(repo.tick('miyue'), null);
  assert.equal(repo.pending('miyue'), null);
  assert.equal(repo.context('miyue'), '');
  assert.equal(repo.get('xingye'), null);
  assert.equal(repo.pending('xingye'), null);
  assert.equal(repo.context('xingye'), '');
  const first = repo.get('miyue');
  assert.equal(first.template, first.templateId);
  assert.equal(first.templateId, 'design-packaging');
  assert.equal(first.status, 'active');
  assert.equal(repo.get('miyue').version, first.version);
  clock.addHours(240);
  assert.equal(repo.get('miyue').beat.id, first.beat.id);
  assert.equal(repo.get('miyue').version, first.version);
  store.close();
});

test('state and authored delivery history survive repository restart', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'life-threads-'));
  const filename = path.join(directory, 'state.sqlite');
  const clock = clockAt('2026-09-07T02:00:00Z');
  let store = new TestStore(filename);
  let repo = new LifeThreadRepository(store, { clock, random: () => 0 });
  const first = repo.get('miyue');
  addAssistantFor(repo, 'delivery-1', first.beat.text);
  assert.equal(repo.markDelivered(first.pendingKey, 'delivery-1'), true);
  const saved = repo.get('miyue');
  store.close();
  store = new TestStore(filename);
  repo = new LifeThreadRepository(store, { clock, random: () => 0.99 });
  const restarted = repo.get('miyue');
  assert.equal(restarted.id, saved.id);
  assert.equal(restarted.version, saved.version);
  assert.deepEqual(restarted.history, saved.history);
  assert.equal(restarted.pendingKey, null);
  store.close();
  fs.rmSync(directory, { recursive: true });
});

test('tick advances at most one delivered beat after its due time and never catches up offline', () => {
  const store = new TestStore();
  const clock = clockAt('2026-09-07T02:00:00Z');
  const repo = new LifeThreadRepository(store, { clock, random: () => 0 });
  const first = repo.get('miyue');
  clock.addHours(100);
  assert.equal(repo.tick('miyue').beat.id, first.beat.id, 'an undelivered beat cannot advance');
  addAssistantFor(repo, 'beat-1', first.beat.text);
  assert.equal(repo.markDelivered(first.pendingKey, 'beat-1'), true);
  const dueAt = repo.get('miyue').dueAt;
  clock.set(new Date(Date.parse(dueAt) - 1));
  assert.equal(repo.tick('miyue').beat.id, first.beat.id);
  clock.addHours(500);
  const second = repo.tick('miyue');
  assert.equal(second.beat.id, 'palette');
  assert.equal(repo.tick('miyue').beat.id, 'palette');
  assert.ok(second.pendingKey);
  store.close();
});

test('choice planning is exact, CAS-protected, replay-safe, and changes future authored text', () => {
  function branch(choiceId, messageId) {
    const store = new TestStore();
    const clock = clockAt('2026-09-07T02:00:00Z');
    const repo = new LifeThreadRepository(store, { clock, random: () => 0 });
    const start = repo.get('miyue');
    const plan = repo.planChoice('miyue', choiceId, start.version);
    addAssistantFor(repo, messageId, '已按这个偏好继续。');
    const selected = repo.commit(plan, messageId);
    assert.equal(repo.commit(plan, messageId).version, selected.version, 'message replay is idempotent');
    assert.throws(() => repo.planChoice('miyue', choiceId, start.version), (error) => error.code === 'STALE_LIFE_THREAD_VERSION');
    addAssistantFor(repo, `${messageId}-delivery`, selected.beat.text);
    assert.equal(repo.markDelivered(selected.pendingKey, `${messageId}-delivery`), true);
    clock.set(repo.get('miyue').dueAt);
    const next = repo.tick('miyue');
    store.close();
    return next;
  }
  const cool = branch('design-cool', 'cool-choice');
  const warm = branch('design-warm', 'warm-choice');
  assert.notEqual(cool.beat.text, warm.beat.text);
  assert.match(cool.beat.text, /雾蓝和银灰/);
  assert.match(warm.beat.text, /杏色和砖红/);
  assert.ok(cool.knownFacts.some((fact) => fact.includes('冷色')));
});

test('an issued choice plan remains authentic across repository restart', () => {
  const store = new TestStore();
  const clock = clockAt('2026-09-07T02:00:00Z');
  let repo = new LifeThreadRepository(store, { clock, random: () => 0 });
  const start = repo.get('miyue');
  const plan = repo.planChoice('miyue', 'design-warm', start.version);
  addAssistantFor(repo, 'restart-choice', '已按这个偏好继续。');
  repo = new LifeThreadRepository(store, { clock, random: () => 0 });
  assert.equal(repo.commit(plan, 'restart-choice').version, start.version + 1);
  assert.equal(repo.commit(plan, 'restart-choice').version, start.version + 1);
  assert.throws(
    () => repo.commit({ ...plan, choiceId: 'design-cool' }, 'forged-choice'),
    (error) => error.code === 'INVALID_LIFE_THREAD_PLAN',
  );
  store.close();
});

test('commit requires a real miyue assistant response and invalid messages never apply a choice', () => {
  const store = new TestStore();
  const repo = new LifeThreadRepository(store, { clock: clockAt('2026-09-07T02:00:00Z'), random: () => 0 });
  const start = repo.get('miyue');
  for (const [id, options] of [['wrong-role-commit', { role: 'wenxi' }], ['wrong-speaker-commit', { speaker: 'user' }]]) {
    const plan = repo.planChoice('miyue', 'design-cool', start.version);
    addMessage(store, id, '生成成功的回复', options);
    assert.throws(() => repo.commit(plan, id), (error) => error.code === 'INVALID_LIFE_THREAD_MESSAGE');
    assert.equal(repo.get('miyue').version, start.version);
  }
  const missingPlan = repo.planChoice('miyue', 'design-cool', start.version);
  assert.throws(() => repo.commit(missingPlan, 'missing-message'), (error) => error.code === 'INVALID_LIFE_THREAD_MESSAGE');
  assert.equal(repo.get('miyue').version, start.version);
  const validPlan = repo.planChoice('miyue', 'design-cool', start.version);
  addAssistantFor(repo, 'valid-choice-response', '生成成功的回复');
  assert.equal(repo.commit(validPlan, 'valid-choice-response').version, start.version + 1);
  store.close();
});

test('questions, negation, ambiguity, and casual input never infer a choice', () => {
  for (const text of ['你觉得雾蓝和银灰好吗？', '不选雾蓝和银灰', '今天有点累', '雾蓝和银灰还是杏色和砖红']) {
    const store = new TestStore();
    const repo = new LifeThreadRepository(store, { clock: clockAt('2026-09-07T02:00:00Z'), random: () => 0 });
    const before = repo.get('miyue');
    const plan = repo.planReply('miyue', text);
    assert.equal(plan.choiceId, undefined);
    addAssistantFor(repo, `message-${text}`, '普通聊天回复。');
    const after = repo.commit(plan, `message-${text}`);
    assert.equal(after.version, before.version);
    assert.deepEqual(after.choices, before.choices);
    store.close();
  }
  const store = new TestStore();
  const repo = new LifeThreadRepository(store, { clock: clockAt('2026-09-07T02:00:00Z'), random: () => 0 });
  repo.get('miyue');
  assert.equal(repo.planReply('miyue', '我选雾蓝和银灰').choiceId, 'design-cool');
  store.close();
});

test('delivery validates the scoped current key and records only exact delivered canon', () => {
  const store = new TestStore();
  const repo = new LifeThreadRepository(store, { clock: clockAt('2026-09-07T02:00:00Z'), random: () => 0 });
  const start = repo.get('miyue');
  addAssistantFor(repo, 'wrong-key-message', start.beat.text);
  addMessage(store, 'wrong-role', start.beat.text, { role: 'wenxi' });
  addMessage(store, 'wrong-speaker', start.beat.text, { speaker: 'user' });
  addAssistantFor(repo, 'incomplete', start.beat.text.slice(0, -1));
  assert.equal(repo.markDelivered('wrong-key', 'wrong-key-message'), false);
  assert.equal(repo.markDelivered(start.pendingKey, 'fake-id'), false);
  assert.equal(repo.markDelivered(start.pendingKey, 'wrong-role'), false);
  assert.equal(repo.markDelivered(start.pendingKey, 'wrong-speaker'), false);
  assert.equal(repo.markDelivered(start.pendingKey, 'incomplete'), false);
  addAssistantFor(repo, 'message-1', `开场\n${start.beat.text}\n接着聊。`);
  assert.equal(repo.markDelivered(start.pendingKey, 'message-1'), true);
  addAssistantFor(repo, 'message-2', start.beat.text);
  assert.equal(repo.markDelivered(start.pendingKey, 'message-2'), false);
  const after = repo.get('miyue');
  assert.equal(after.history.length, 1);
  assert.equal(after.history[0].text, start.beat.text);
  assert.ok(after.knownFacts.some((fact) => fact.includes('十分钟')));
  store.close();
});

test('context contains only current and actually delivered beats, with explicit fiction guard', () => {
  const store = new TestStore();
  const clock = clockAt('2026-09-07T02:00:00Z');
  const repo = new LifeThreadRepository(store, { clock, random: () => 0 });
  const first = repo.get('miyue');
  let context = repo.context('miyue');
  assert.match(context, /虚构个人生活连续性/);
  assert.match(context, new RegExp(first.beat.title));
  assert.doesNotMatch(context, /第一只纸盒小样折出来了/);
  assert.doesNotMatch(context, /把练习收成一张项目卡/);
  deliverAndAdvance(repo, clock, 'first-delivery');
  context = repo.context('miyue');
  assert.match(context, new RegExp(first.beat.text.slice(0, 16)));
  assert.doesNotMatch(context, /第一只纸盒小样折出来了/);
  store.close();
});

test('travel notebook is not selected during the plan phase but phase-less direct events remain compatible', () => {
  const planningStore = new TestStore();
  const planning = new LifeThreadRepository(planningStore, { clock: clockAt('2026-09-07T02:00:00Z'), random: () => 0 });
  const planEvent = { active: { id: 'trip-plan', type: 'travel', destination: '杭州', phase: { id: 'plan' } } };
  assert.equal(planning.get('miyue', planEvent).templateId, 'design-packaging');
  planningStore.close();

  const incompleteStore = new TestStore();
  const incomplete = new LifeThreadRepository(incompleteStore, { clock: clockAt('2026-09-07T02:00:00Z'), random: () => 0 });
  assert.equal(incomplete.get('miyue', { active: { type: 'travel', destination: '杭州' } }).templateId, 'design-packaging');
  incompleteStore.close();

  const awayStore = new TestStore();
  const away = new LifeThreadRepository(awayStore, { clock: clockAt('2026-09-07T02:00:00Z'), random: () => 0 });
  assert.equal(away.get('miyue', { active: { type: 'travel', destination: '杭州', phase: { id: 'away' } } }).templateId, 'travel-notebook');
  awayStore.close();

  const directStore = new TestStore();
  const direct = new LifeThreadRepository(directStore, { clock: clockAt('2026-09-07T02:00:00Z'), random: () => 0 });
  assert.equal(direct.get('miyue', { type: 'travel', destination: '杭州' }).templateId, 'travel-notebook');
  directStore.close();
});

test('travel notebook binds to the public event destination and pauses on destination change', () => {
  const store = new TestStore();
  const clock = clockAt('2026-09-07T02:00:00Z');
  const repo = new LifeThreadRepository(store, { clock, random: () => 0 });
  const hangzhou = { active: { id: 'trip-1', type: 'travel', destination: '杭州', phase: { id: 'away' } } };
  const first = repo.get('miyue', hangzhou);
  assert.equal(first.templateId, 'travel-notebook');
  assert.equal(first.kind, 'travel');
  assert.equal(first.travelBound, true);
  assert.equal(first.userDirected, false);
  assert.match(first.title, /杭州/);
  assert.doesNotMatch(JSON.stringify(first), /天气|营业/);
  addAssistantFor(repo, 'travel-delivery', first.beat.text);
  assert.equal(repo.markDelivered(first.pendingKey, 'travel-delivery'), true);
  clock.set(repo.get('miyue', hangzhou).dueAt);
  const second = repo.tick('miyue', hangzhou);
  assert.notEqual(second.beat.id, first.beat.id);
  const nanjing = { active: { id: 'trip-2', type: 'travel', destination: '南京', phase: { id: 'away' } } };
  const derivedPaused = repo.get('miyue', nanjing);
  assert.equal(derivedPaused.status, 'paused');
  assert.equal(derivedPaused.pendingKey, null);
  const pausedContext = repo.context('miyue', nanjing);
  assert.match(pausedContext, /暂时暂停/);
  assert.match(pausedContext, new RegExp(first.beat.text.slice(0, 18)));
  assert.doesNotMatch(pausedContext, new RegExp(second.beat.text.slice(0, 18)));
  assert.equal(repo.pending('miyue', nanjing), null);
  const paused = repo.tick('miyue', nanjing);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.beat.id, second.beat.id);
  assert.match(paused.title, /杭州/);
  assert.equal(repo.pending('miyue', nanjing), null);
  const resumed = repo.tick('miyue', null);
  assert.equal(resumed.status, 'active');
  assert.equal(resumed.beat.id, second.beat.id);
  assert.ok(resumed.pendingKey);
  store.close();
});

test('completed arc waits 48 hours and the next tick avoids immediate template repeat', () => {
  const store = new TestStore();
  const clock = clockAt('2026-09-07T02:00:00Z');
  const repo = new LifeThreadRepository(store, { clock, random: () => 0 });
  let view = repo.get('miyue');
  const firstTemplate = view.templateId;
  for (let index = 0; index < 5; index += 1) {
    addAssistantFor(repo, `complete-${index}`, view.beat.text);
    assert.equal(repo.markDelivered(view.pendingKey, `complete-${index}`), true);
    view = repo.get('miyue');
    if (view.status === 'completed') break;
    clock.set(view.dueAt);
    view = repo.tick('miyue');
  }
  assert.equal(view.status, 'completed');
  const cooldownAt = view.dueAt;
  clock.set(new Date(Date.parse(cooldownAt) - 1));
  assert.equal(repo.tick('miyue').id, view.id);
  clock.set(cooldownAt);
  const next = repo.tick('miyue');
  assert.notEqual(next.id, view.id);
  assert.notEqual(next.templateId, firstTemplate);
  store.close();
});

test('material exposure accepts a saved reply without the selected beat only at its selected version', () => {
  const store = new TestStore(); const repo = new LifeThreadRepository(store, { clock: clockAt('2026-09-07T00:00:00Z'), random: () => 0 });
  const view = repo.get('miyue');
  addMessage(store, 'material-reply', '我刚收好桌上的纸边，想先坐一会儿。');
  assert.equal(repo.markDelivered(view.pendingKey, 'material-reply', { mode: 'material_exposure', key: 'wrong-key', expectedVersion: view.version }), false);
  assert.equal(repo.markDelivered(view.pendingKey, 'material-reply', { mode: 'material_exposure', key: view.pendingKey, expectedVersion: view.version + 1 }), false);
  assert.equal(repo.markDelivered(view.pendingKey, 'material-reply', { mode: 'material_exposure', key: view.pendingKey, expectedVersion: view.version }), true);
  const receipt = repo.get('miyue').history[0];
  assert.equal(receipt.actualReply, '我刚收好桌上的纸边，想先坐一会儿。');
  assert.equal(receipt.selectedText, view.beat.text);
  store.close();
});
