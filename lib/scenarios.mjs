import { scenarioConsequences } from './scenario-consequences.mjs';
import fs from 'node:fs';

const bundled = JSON.parse(fs.readFileSync(new URL('../app-data/scenarios.json', import.meta.url), 'utf8'));
const clone = (value) => structuredClone(value);

function error(message, status, code) {
  const result = new Error(message);
  result.status = status;
  result.code = code;
  return result;
}

function nowIso(clock) {
  const date = new Date(clock());
  if (Number.isNaN(date.getTime())) throw new TypeError('clock must return a valid date');
  return date.toISOString();
}

function normalize(value) {
  return String(value || '').trim().toLocaleLowerCase('zh-CN').replace(/[\s，。！？、,.!?；;：“”"'（）()]/g, '');
}

function appendContext(base, tail) {
  const safeTail = String(tail || '').slice(0, 2400);
  const remaining = Math.max(0, 5000 - safeTail.length - 1);
  return `${String(base || '').slice(0, remaining)}\n${safeTail}`.slice(0, 5000);
}

function validateScenarios(input) {
  const list = Array.isArray(input) ? input : input?.scenarios;
  if (!Array.isArray(list) || !list.length) throw new TypeError('scenarios must contain a non-empty scenarios array');
  const ids = new Set();
  for (const scenario of list) {
    if (!scenario?.id || ids.has(scenario.id) || !scenario.start || !scenario.nodes?.[scenario.start]) {
      throw new TypeError('each scenario needs a unique id, a start, and nodes containing that start');
    }
    ids.add(scenario.id);
    for (const [nodeId, node] of Object.entries(scenario.nodes)) {
      if (node.id !== nodeId || !Array.isArray(node.opening) || node.opening.length < 2 || node.opening.length > 4 || !Array.isArray(node.knownFacts)) {
        throw new TypeError(`invalid scenario node: ${scenario.id}/${nodeId}`);
      }
      for (const choice of node.choices || []) {
        if (!choice.id || !choice.label || !choice.consequence || !scenario.nodes[choice.next]) {
          throw new TypeError(`invalid scenario choice: ${scenario.id}/${nodeId}`);
        }
      }
    }
  }
  return list;
}

function scenarioSummary(scenario) {
  return {
    id: scenario.id,
    title: scenario.title,
    summary: scenario.summary,
    heroine: clone(scenario.heroine),
    participants: clone(scenario.participants),
  };
}

function publicChoice(choice) {
  return { id: choice.id, label: choice.label, consequence: choice.consequence };
}

function publicScene(node) {
  return {
    id: node.id,
    title: node.title,
    place: node.place,
    time: node.time,
    wardrobe: node.wardrobe,
    chapter: node.chapter || null,
    emotionalMotive: node.emotionalMotive,
    externalObjective: node.externalObjective,
    opening: clone(node.opening),
    knownFacts: clone(node.knownFacts),
    ending: Boolean(node.ending),
  };
}

export class ScenarioRepository {
  constructor(store, { roleId = 'zhixia', clock = () => new Date(), scenarios = bundled } = {}) {
    if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('store with db and transaction is required');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    if (typeof roleId !== 'string' || !roleId.trim()) throw new TypeError('roleId must be a non-empty string');
    this.store = store;
    this.roleId = roleId;
    this.clock = clock;
    this.scenarios = validateScenarios(scenarios);
    this.byId = new Map(this.scenarios.map((item) => [item.id, item]));
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS scenario_runtime (
        role_id TEXT PRIMARY KEY,
        scenario_id TEXT NOT NULL,
        version INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS scenario_saves (
        role_id TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        scene_version INTEGER NOT NULL,
        paused INTEGER NOT NULL,
        history_json TEXT NOT NULL,
        delivered_key TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(role_id, scenario_id)
      );
      CREATE TABLE IF NOT EXISTS scenario_commits (
        role_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        PRIMARY KEY(role_id, message_id)
      );
    `);
    this.#ensure();
  }

  #ensure() {
    const first = this.scenarios[0];
    this.store.db.prepare('INSERT OR IGNORE INTO scenario_runtime(role_id,scenario_id,version) VALUES(?,?,1)')
      .run(this.roleId, first.id);
    const runtime = this.store.db.prepare('SELECT scenario_id FROM scenario_runtime WHERE role_id=?').get(this.roleId);
    if (!this.byId.has(runtime.scenario_id)) {
      this.store.db.prepare('UPDATE scenario_runtime SET scenario_id=?,version=version+1 WHERE role_id=?').run(first.id, this.roleId);
    }
    this.#ensureSave(this.store.db.prepare('SELECT scenario_id FROM scenario_runtime WHERE role_id=?').get(this.roleId).scenario_id);
  }

  #ensureSave(scenarioId) {
    const scenario = this.byId.get(scenarioId);
    this.store.db.prepare(`
      INSERT OR IGNORE INTO scenario_saves
        (role_id,scenario_id,node_id,scene_version,paused,history_json,delivered_key,updated_at)
      VALUES(?,?,?,1,0,'[]',NULL,?)
    `).run(this.roleId, scenarioId, scenario.start, nowIso(this.clock));
  }

  #rows() {
    this.#ensure();
    const runtime = this.store.db.prepare('SELECT scenario_id,version FROM scenario_runtime WHERE role_id=?').get(this.roleId);
    const save = this.store.db.prepare('SELECT * FROM scenario_saves WHERE role_id=? AND scenario_id=?').get(this.roleId, runtime.scenario_id);
    return { runtime, save, scenario: this.byId.get(runtime.scenario_id) };
  }

  #assertVersion(actual, expected) {
    if (expected !== undefined && Number(expected) !== actual) {
      throw error('剧情进度已更新，请刷新后再试', 409, 'STALE_SCENARIO_VERSION');
    }
  }

  #pending(scenario, save) {
    return `${scenario.id}:${save.node_id}:${save.scene_version}`;
  }

  get() {
    const { runtime, save, scenario } = this.#rows();
    const node = scenario.nodes[save.node_id];
    const history = JSON.parse(save.history_json);
    const pendingKey = node.ending ? null : this.#pending(scenario, save);
    const current = scenarioSummary(scenario);
    const consequences=scenarioConsequences(scenario,history,node.id);
    const scene = {...publicScene(node),callback:consequences.callback};
    const choices = save.paused ? [] : (node.choices || []).map(publicChoice);
    return {
      scenarios: this.scenarios.map(scenarioSummary),
      consequences,
      scope: scenario.id,
      pendingKey,
      current,
      scenario: current,
      scene,
      state: {
        scenarioId: scenario.id,
        nodeId: node.id,
        paused: Boolean(save.paused),
        ended: Boolean(node.ending),
        history,
        sceneVersion: save.scene_version,
        pendingKey,
        openerDelivered: node.ending || save.delivered_key === pendingKey,
      },
      choices,
      version: runtime.version,
    };
  }

  select(id, expectedVersion) {
    if (!this.byId.has(id)) throw error('这个情境不存在', 404, 'SCENARIO_NOT_FOUND');
    this.store.transaction(() => {
      const runtime = this.store.db.prepare('SELECT scenario_id,version FROM scenario_runtime WHERE role_id=?').get(this.roleId);
      this.#assertVersion(runtime.version, expectedVersion);
      this.#ensureSave(id);
      if (runtime.scenario_id !== id) {
        this.store.db.prepare('UPDATE scenario_runtime SET scenario_id=?,version=version+1 WHERE role_id=?').run(id, this.roleId);
      }
    });
    return this.get();
  }

  choose(choiceId, expectedVersion) {
    this.store.transaction(() => this.#applyChoice(choiceId, expectedVersion));
    return this.get();
  }

  #applyChoice(choiceId, expectedVersion) {
    const runtime = this.store.db.prepare('SELECT scenario_id,version FROM scenario_runtime WHERE role_id=?').get(this.roleId);
    this.#assertVersion(runtime.version, expectedVersion);
    const scenario = this.byId.get(runtime.scenario_id);
    const save = this.store.db.prepare('SELECT * FROM scenario_saves WHERE role_id=? AND scenario_id=?').get(this.roleId, scenario.id);
    if (save.paused) throw error('剧情已暂停，请先明确继续', 409, 'SCENARIO_PAUSED');
    const node = scenario.nodes[save.node_id];
    const choice = (node.choices || []).find((item) => item.id === choiceId);
    if (!choice) throw error('这个选项不属于当前场景', 400, 'INVALID_SCENARIO_CHOICE');
    const history = JSON.parse(save.history_json);
    history.push({
      fromNodeId: node.id,
      choiceId: choice.id,
      label: choice.label,
      consequence: choice.consequence,
      toNodeId: choice.next,
      at: nowIso(this.clock),
    });
    this.store.db.prepare(`
      UPDATE scenario_saves SET node_id=?,scene_version=scene_version+1,history_json=?,delivered_key=NULL,updated_at=?
      WHERE role_id=? AND scenario_id=?
    `).run(choice.next, JSON.stringify(history), nowIso(this.clock), this.roleId, scenario.id);
    this.store.db.prepare('UPDATE scenario_runtime SET version=version+1 WHERE role_id=?').run(this.roleId);
  }

  pause(value) {
    if (typeof value !== 'boolean') throw new TypeError('pause expects a boolean');
    this.store.transaction(() => {
      const { runtime, save } = this.#rows();
      if (Boolean(save.paused) === value) return;
      this.store.db.prepare('UPDATE scenario_saves SET paused=?,updated_at=? WHERE role_id=? AND scenario_id=?')
        .run(value ? 1 : 0, nowIso(this.clock), this.roleId, runtime.scenario_id);
      this.store.db.prepare('UPDATE scenario_runtime SET version=version+1 WHERE role_id=?').run(this.roleId);
    });
    return this.get();
  }

  reset(expectedVersion) {
    this.store.transaction(() => {
      const runtime = this.store.db.prepare('SELECT scenario_id,version FROM scenario_runtime WHERE role_id=?').get(this.roleId);
      this.#assertVersion(runtime.version, expectedVersion);
      const scenario = this.byId.get(runtime.scenario_id);
      this.store.db.prepare(`
        UPDATE scenario_saves SET node_id=?,scene_version=scene_version+1,paused=0,history_json='[]',delivered_key=NULL,updated_at=?
        WHERE role_id=? AND scenario_id=?
      `).run(scenario.start, nowIso(this.clock), this.roleId, scenario.id);
      this.store.db.prepare('UPDATE scenario_runtime SET version=version+1 WHERE role_id=?').run(this.roleId);
    });
    return this.get();
  }

  markDelivered(pendingKey, expectedVersion) {
    this.store.transaction(() => {
      const runtime = this.store.db.prepare('SELECT scenario_id,version FROM scenario_runtime WHERE role_id=?').get(this.roleId);
      this.#assertVersion(runtime.version, expectedVersion);
      const scenario = this.byId.get(runtime.scenario_id);
      const save = this.store.db.prepare('SELECT * FROM scenario_saves WHERE role_id=? AND scenario_id=?').get(this.roleId, scenario.id);
      if (scenario.nodes[save.node_id].ending) throw error('结局场景没有待发送的主动开场', 409, 'NO_SCENARIO_OPENER');
      if (pendingKey !== this.#pending(scenario, save)) throw error('主动开场已过期', 409, 'STALE_SCENARIO_OPENER');
      if (save.delivered_key !== pendingKey) {
        this.store.db.prepare('UPDATE scenario_saves SET delivered_key=?,updated_at=? WHERE role_id=? AND scenario_id=?')
          .run(pendingKey, nowIso(this.clock), this.roleId, scenario.id);
      }
    });
    return this.get();
  }

  context({ initiating = false } = {}) {
    const view = this.get();
    const { current, scene, state, choices } = view;
    const lines = [
      '【互动情境】',
      `情境：${current.title}；章节：${scene.chapter || "独立短篇"}；当前场景：${scene.title}`,
      `参与者：${current.participants.join('；')}`,
      `地点：${scene.place}；时间：${scene.time}`,
      `阮绵的穿着：${scene.wardrobe}`,
      `阮绵此刻的心愿：${scene.emotionalMotive}`,
      `眼前要完成的事：${scene.externalObjective}`,
      `当前已知事实：${scene.knownFacts.join('；') || '暂无'}`,
      `当前现场（保持其中的人名、物件和动作事实）：${scene.opening.join('')}`,
      '阮绵温暖、俏皮、体贴，也有自己的目标和需要；保持非露骨的浪漫张力与幽默。故事中的虚构角色均为至少25岁的成年人，这不表示或推断现实用户的年龄。',
      '气氛、日常小动作可以少量发挥；不得新增钥匙用途、路线、证人口供、秘密规则等影响分支的事实。不知道的线索留待探索，当前可选行动的后果尚未发生。只能使用当前已知事实与下方已发生分支，不得泄露其他节点。不要替故事中的用户主角决定行动、感受、同意或共同过去。用户可以自然聊天，不必每轮强迫选择。',
    ];
    if(view.consequences.effects.length)lines.push(`选择留下的后果：${view.consequences.effects.map(e=>e.text).join("；")}`);
    if(scene.callback)lines.push(`已解锁的具体回响：${scene.callback.text}`);
    if (state.history.length) {
      lines.push(`已发生分支：${state.history.map((item) => `${item.label}（${item.consequence}）`).join('；')}`);
    }
    if (state.paused) lines.push('剧情已暂停。保持普通对话，只有用户明确说继续剧情时才恢复。');
    else if (state.ended) lines.push('这个结局已经抵达。自然停留和聊天，不自动重开或续写用户的新行动。');
    else lines.push(`当前可选行动：${choices.map((item) => `${item.id}=${item.label}（${item.consequence}）`).join('；')}`);
    if (initiating && !state.paused && !state.ended && !state.openerDelivered) {
      lines.push(`可主动发起的现场钩子：${scene.opening.join('')}`);
      lines.push('用自然对话延续现场即可，不要求照抄开场。');
    }
    const result = lines.join('\n');
    return result.length <= 5000 ? result : result.slice(0, 5000);
  }

  planTurn(text) {
    const view = this.get();
    const value = String(text || '').trim();
    const key = normalize(value);
    const plan = {
      expectedVersion: view.version,
      scenarioId: view.current.id,
      nodeId: view.scene.id,
      context: '',
    };
    const pause = /^(?:我想)?(?:先)?(?:暂停(?:一下|剧情|故事)?|停一下|不玩了|不推进剧情|不赶剧情|歇一会儿)(?:吧)?$/.test(key) || /^(?:我想)?(?:先)?(?:暂停故事|暂停剧情|停一下剧情)[，,。！!\s]/.test(value);
    const resume = /^(?:我想)?(?:继续|继续剧情|继续这个故事|恢复剧情|接着玩|继续玩|回到剧情)(?:吧)?$/.test(key);
    if (pause && !view.state.paused) plan.pause = true;
    else if (resume && view.state.paused) plan.pause = false;
    else if (!view.state.paused && !view.state.ended) {
      const matches = [];
      for (const choice of this.byId.get(view.current.id).nodes[view.scene.id].choices || []) {
        const phrases = [choice.label, ...(choice.matchPhrases || [])].map(normalize).filter(Boolean);
        const explicit = phrases.some((phrase) => key === phrase
          || key === `我选${phrase}` || key === `选择${phrase}` || key === `我选择${phrase}`
          || key === `决定${phrase}` || key === `我决定${phrase}`);
        if (explicit) matches.push(choice.id);
      }
      if (matches.length === 1) plan.nextChoiceId = matches[0];
    }
    if (plan.nextChoiceId) {
      const choice = this.byId.get(view.current.id).nodes[view.scene.id].choices.find((item) => item.id === plan.nextChoiceId);
      const target = this.byId.get(view.current.id).nodes[choice.next];
      const transition = `用户已明确选择“${choice.label}”。把“${choice.consequence}”作为该选择的直接后果。转场后地点：${target.place}；时间：${target.time}；阮绵的外部目标：${target.externalObjective}；转场后可呈现的事实：${target.knownFacts.join('；')}；目标现场：${target.opening.join('')}；目标场景接下来的选择：${target.choices.map(c=>c.label).join('；')}。只使用这些目标场景事实，不照抄固定开场，也不替故事中的用户主角补做其他动作。`;
      const projected=[...view.state.history,{fromNodeId:view.scene.id,choiceId:choice.id,toNodeId:choice.next}];
      const consequence=scenarioConsequences(this.byId.get(view.current.id),projected,target.id);
      plan.replyAnchor=[consequence.callback?.text,...target.opening].filter(Boolean).join('\n');
      plan.authoredTransition=true;
      plan.context = appendContext(this.context(), transition+(plan.replyAnchor?'\n程序将呈现这一句已解锁回响，正文不要重复：'+plan.replyAnchor:''));
    } else if (plan.pause === true) {
      plan.context = '【互动情境】当前情境：'+view.current.title+'。用户明确要求暂停；本轮立即退出现场描写，以普通聊天回应，不写剧情中的动作、道具或新经历。人物仍是温暖俏皮、有自己想法的成年阮绵。成功回复后才保存暂停状态，恢复时接原存档。';
    } else if (plan.pause === false) {
      plan.context = appendContext(this.context(), '用户明确要求恢复；本轮可以自然接回当前现场，成功回复后才保存恢复状态。');
    } else {
      plan.context = this.context();
    }
    return plan;
  }

  commitTurn(plan, messageId) {
    if (!plan || typeof plan !== 'object') throw new TypeError('plan is required');
    if (typeof messageId !== 'string' || !messageId.trim()) throw new TypeError('messageId must be a non-empty string');
    return this.store.transaction(() => {
      const committed = this.store.db.prepare('SELECT result_json FROM scenario_commits WHERE role_id=? AND message_id=?').get(this.roleId, messageId);
      if (committed) return JSON.parse(committed.result_json);
      const runtime = this.store.db.prepare('SELECT scenario_id,version FROM scenario_runtime WHERE role_id=?').get(this.roleId);
      this.#assertVersion(runtime.version, plan.expectedVersion);
      const save = this.store.db.prepare('SELECT node_id FROM scenario_saves WHERE role_id=? AND scenario_id=?').get(this.roleId, runtime.scenario_id);
      if (plan.scenarioId !== runtime.scenario_id || plan.nodeId !== save.node_id) {
        throw error('剧情场景已更新，请重新生成回复', 409, 'STALE_SCENARIO_PLAN');
      }
      if (plan.nextChoiceId) this.#applyChoice(plan.nextChoiceId, plan.expectedVersion);
      else if (typeof plan.pause === 'boolean') {
        const fullSave = this.store.db.prepare('SELECT paused FROM scenario_saves WHERE role_id=? AND scenario_id=?').get(this.roleId, runtime.scenario_id);
        if (Boolean(fullSave.paused) !== plan.pause) {
          this.store.db.prepare('UPDATE scenario_saves SET paused=?,updated_at=? WHERE role_id=? AND scenario_id=?')
            .run(plan.pause ? 1 : 0, nowIso(this.clock), this.roleId, runtime.scenario_id);
          this.store.db.prepare('UPDATE scenario_runtime SET version=version+1 WHERE role_id=?').run(this.roleId);
        }
      }
      const result = this.get();
      this.store.db.prepare('INSERT INTO scenario_commits(role_id,message_id,result_json,committed_at) VALUES(?,?,?,?)')
        .run(this.roleId, messageId, JSON.stringify(result), nowIso(this.clock));
      return result;
    });
  }
}

export const defaultScenarios = clone(bundled);
