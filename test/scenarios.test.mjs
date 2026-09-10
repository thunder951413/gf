import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ScenarioRepository, defaultScenarios } from '../lib/scenarios.mjs';

class TestStore {
  constructor(filename = ':memory:') { this.db = new DatabaseSync(filename); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }
  close() { this.db.close(); }
}

const clock = () => new Date('2026-09-06T14:10:00.000Z');

test('bundled scenarios are original bounded adult stories with rich current-scene canon', () => {
  assert.equal(defaultScenarios.version, 1);
  assert.equal(defaultScenarios.scenarios.length, 3);
  for (const scenario of defaultScenarios.scenarios) {
    assert.equal(scenario.heroine.age, 26);
    assert.match(scenario.participants.join(''), /故事中的用户主角为成年（25岁以上），不推断现实用户年龄/);
    const nodes = Object.values(scenario.nodes);
    assert.ok(nodes.length >= 5 && nodes.length <= (scenario.id === 'rain-lantern' ? 24 : 7));
    for (const node of nodes) {
      assert.ok(node.place && node.time && node.wardrobe && node.emotionalMotive && node.externalObjective);
      assert.ok(node.opening.length >= 2 && node.opening.length <= 4);
      assert.ok(Array.isArray(node.knownFacts));
      assert.ok((node.choices || []).length <= 3);
    }
  }
});

test('distinct opening branches converge while branch consequences remain in recall', () => {
  const store = new TestStore();
  const repo = new ScenarioRepository(store, { clock });
  let view = repo.get();
  assert.equal(view.current.id, 'rain-lantern');
  assert.equal(view.scope, 'rain-lantern');
  assert.equal(view.pendingKey, view.state.pendingKey);
  assert.equal(view.scene.id, 'arcade');
  view = repo.choose('tea-route', view.version);
  assert.equal(view.scene.id, 'tea-shop');
  view = repo.choose('respect-map', view.version);
  assert.equal(view.scene.id, 'rooftop');
  assert.match(repo.context(), /只请老板画路/);
  assert.match(repo.context(), /安全落脚点/);
  assert.ok(repo.context().length <= 5000);
  store.close();
});

test('scenario switching resumes separate saves and does not leak facts across scenarios', () => {
  const store = new TestStore();
  const repo = new ScenarioRepository(store, { clock });
  let rain = repo.choose('tram-route', repo.get().version);
  assert.equal(rain.scene.id, 'tram-stop');
  let paper = repo.select('paper-moon', rain.version);
  assert.equal(paper.scene.id, 'studio');
  paper = repo.choose('cover-first', paper.version);
  assert.equal(paper.scene.id, 'cover-table');
  assert.doesNotMatch(repo.context(), /有轨车|银河影院|轨缝/);
  rain = repo.select('rain-lantern', paper.version);
  assert.equal(rain.scene.id, 'tram-stop');
  assert.equal(rain.state.history[0].choiceId, 'tram-route');
  assert.doesNotMatch(repo.context(), /纸月亮|印刷店/);
  store.close();
});

test('role-scoped progress is isolated in one database', () => {
  const store = new TestStore();
  const zhi = new ScenarioRepository(store, { roleId: 'zhixia', clock });
  const wei = new ScenarioRepository(store, { roleId: 'wenxi', clock });
  const moved = zhi.choose('tea-route', zhi.get().version);
  assert.equal(moved.scene.id, 'tea-shop');
  assert.equal(wei.get().scene.id, 'arcade');
  wei.select('mirror-tide', wei.get().version);
  assert.equal(zhi.get().current.id, 'rain-lantern');
  store.close();
});

test('progress survives repository restart without offline time advancement', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'scenario-restart-'));
  const filename = path.join(directory, 'scenario.sqlite');
  let store = new TestStore(filename);
  let repo = new ScenarioRepository(store, { clock });
  const moved = repo.choose('tea-route', repo.get().version);
  const before = JSON.stringify(moved);
  store.close();
  store = new TestStore(filename);
  repo = new ScenarioRepository(store, { clock: () => new Date('2036-09-06T14:10:00Z') });
  assert.equal(JSON.stringify(repo.get()), before);
  const reset = repo.reset(repo.get().version);
  assert.equal(reset.scene.id, 'arcade');
  assert.equal(reset.state.history.length, 0);
  assert.equal(reset.state.paused, false);
  store.close();
  fs.rmSync(directory, { recursive: true });
});

test('stale or invalid choices reject and ending nodes remain stable', () => {
  const store = new TestStore();
  const repo = new ScenarioRepository(store, { clock });
  const initial = repo.get();
  const next = repo.choose('tea-route', initial.version);
  assert.throws(() => repo.choose('tram-route', initial.version), (error) => error.code === 'STALE_SCENARIO_VERSION');
  assert.throws(() => repo.choose('missing', next.version), (error) => error.code === 'INVALID_SCENARIO_CHOICE');
  let view = repo.choose('trade-poster', next.version);
  view = repo.choose('light-phone', view.version);
  view = repo.choose('public-credit', view.version);
  for(let guard=0;!view.state.ended&&guard<25;guard++)view=repo.choose(view.choices[0].id,view.version);
  assert.equal(view.state.ended, true);
  assert.equal(view.choices.length, 0);
  assert.throws(() => repo.choose('anything', view.version), (error) => error.code === 'INVALID_SCENARIO_CHOICE');
  assert.equal(repo.get().scene.id, 'after-rain');
  store.close();
});

test('clear free-text choices advance only after commit and unrelated chat is a no-op', () => {
  const store = new TestStore();
  const repo = new ScenarioRepository(store, { clock });
  const unrelated = repo.planTurn('这场雨让我想起一首歌，你喜欢雨声吗？');
  assert.equal(unrelated.nextChoiceId, undefined);
  const same = repo.commitTurn(unrelated, 'assistant-chat-1');
  assert.equal(same.scene.id, 'arcade');
  const planned = repo.planTurn('我选择先去茶铺');
  assert.equal(planned.nextChoiceId, 'tea-route');
  assert.equal(repo.get().scene.id, 'arcade', 'planning does not claim the user action before a successful reply');
  assert.match(planned.context, /直接后果/);
  assert.match(planned.context, /茶铺老板确认钥匙牌属于影院二楼失物柜/);
  assert.doesNotMatch(planned.context, /未完成的城市夜行投影草案/);
  const moved = repo.commitTurn(planned, 'assistant-chat-2');
  assert.equal(moved.scene.id, 'tea-shop');
  const duplicate = repo.commitTurn(planned, 'assistant-chat-2');
  assert.deepEqual(duplicate, moved);
  assert.equal(repo.get().state.history.length, 1);
  store.close();
});

test('pause and explicit resume are replay-safe and block choices', () => {
  const store = new TestStore();
  const repo = new ScenarioRepository(store, { clock });
  const pausePlan = repo.planTurn('先暂停一下。');
  assert.equal(pausePlan.pause, true);
  let view = repo.commitTurn(pausePlan, 'pause-reply');
  assert.equal(view.state.paused, true);
  assert.equal(view.choices.length, 0);
  const ignored = repo.planTurn('去问茶铺老板');
  assert.equal(ignored.nextChoiceId, undefined);
  assert.match(ignored.context, /剧情已暂停/);
  const vague = repo.planTurn('以后有空再说');
  assert.equal(vague.pause, undefined);
  const resumePlan = repo.planTurn('继续这个故事');
  assert.equal(resumePlan.pause, false);
  view = repo.commitTurn(resumePlan, 'resume-reply');
  assert.equal(view.state.paused, false);
  assert.equal(view.scene.id, 'arcade');
  assert.equal(repo.planTurn('先不推进剧情。').pause, true);
  store.close();
});

test('context exposes current and recalled facts but never unrevealed future facts', () => {
  const store = new TestStore();
  const repo = new ScenarioRepository(store, { clock });
  const context = repo.context({ initiating: true });
  assert.match(context, /铜钥匙是在停电后/);
  assert.match(context, /城市显然临时给我加了支线任务/);
  assert.doesNotMatch(context, /未完成的城市夜行投影草案/);
  assert.doesNotMatch(context, /蓝色批注正在褪色/);
  assert.doesNotMatch(context, /提交公开展览提案/);
  const pendingKey = repo.get().state.pendingKey;
  repo.markDelivered(pendingKey, repo.get().version);
  const later = repo.context({ initiating: true });
  assert.match(later, /银河影院/);
  assert.doesNotMatch(later, /可主动发起的现场钩子/);
  assert.equal(repo.markDelivered(pendingKey).state.openerDelivered, true);
  store.close();
});

test('commit uses compare-and-swap and a reset requires an explicit call', () => {
  const store = new TestStore();
  const repo = new ScenarioRepository(store, { clock });
  const oldPlan = repo.planTurn('去问茶铺老板');
  repo.pause(true);
  assert.throws(() => repo.commitTurn(oldPlan, 'late-reply'), (error) => error.code === 'STALE_SCENARIO_VERSION');
  assert.equal(repo.get().scene.id, 'arcade');
  repo.pause(false);
  const current = repo.get();
  assert.throws(() => repo.reset(current.version - 1), (error) => error.code === 'STALE_SCENARIO_VERSION');
  assert.equal(repo.get().scene.id, 'arcade');
  store.close();
});

test('ending scenes have no pending proactive opener', () => {
  const store = new TestStore();
  const repo = new ScenarioRepository(store, { clock });
  let view = repo.choose('tram-route', repo.get().version);
  view = repo.choose('follow-mirrors', view.version);
  view = repo.choose('guard-door', view.version);
  view = repo.choose('private-walk', view.version);
  for(let guard=0;!view.state.ended&&guard<25;guard++)view=repo.choose(view.choices[0].id,view.version);
  assert.equal(view.state.ended, true);
  assert.equal(view.pendingKey, null);
  assert.equal(view.state.pendingKey, null);
  assert.equal(view.state.openerDelivered, true);
  assert.doesNotMatch(repo.context({ initiating: true }), /可主动发起的现场钩子/);
  assert.throws(() => repo.markDelivered('rain-lantern:dawn-private:5'), (error) => error.code === 'NO_SCENARIO_OPENER');
  store.close();
});

test('context budget preserves an explicit transition after oversized prior context', () => {
  const store = new TestStore();
  const scenarios = structuredClone(defaultScenarios);
  scenarios.scenarios[0].nodes.arcade.knownFacts.unshift(`超长现场记录${'甲'.repeat(7000)}`);
  const repo = new ScenarioRepository(store, { clock, scenarios });
  const plan = repo.planTurn('我选择先去茶铺');
  assert.ok(plan.context.length <= 5000);
  assert.match(plan.context, /用户已明确选择“陪她去问还亮着灯的茶铺老板”/);
  assert.match(plan.context, /茶铺老板确认钥匙牌属于影院二楼失物柜/);
  store.close();
});
