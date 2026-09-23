import { NEED_FIELDS, resolveNeeds, needsContext } from './companion-needs.mjs';
import { tuningEffects } from './companion-tuning.mjs';
import { NEED_CYCLE_DEFAULTS, NEED_CYCLE_FIELDS, cycleConfig, advanceNeedCycle, needCycleStatus, needCycleCandidate, needCycleContext, needFulfillment } from './need-cycle.mjs';
import { bodyMeter } from './companion-events.mjs';
const HALF_HOUR = 30 * 60 * 1000;
const FOUR_HOURS = 4 * 60 * 60 * 1000;
const TWELVE_HOURS = 12 * 60 * 60 * 1000;
const SIXTEEN_HOURS = 16 * 60 * 60 * 1000;

const METRICS = Object.freeze([
  'fatigue', 'hunger', 'vitality', 'stress', 'security',
  'affectionNeed', 'desire', 'playfulness', 'affection', 'mood',
]);

const STATE_FIELDS = Object.freeze([
  { key: 'fatigue', label: '疲劳程度', description: '身体和精神的疲惫程度', group: 'body' },
  { key: 'hunger', label: '饥饿程度', description: '当前需要进食的程度', group: 'body' },
  { key: 'vitality', label: '活力程度', description: '当前精力和行动意愿', group: 'body' },
  { key: 'stress', label: '压力程度', description: '当前紧张和心理负担', group: 'emotion' },
  { key: 'security', label: '安全感', description: '当前安稳和被理解的感受', group: 'emotion' },
  { key: 'affectionNeed', label: '情感需要', description: '当前想被回应、陪伴、理解的程度；达到阈值后准备主动交流', group: 'relationship' },
  { key: 'desire', label: '身体亲近愿望', description: '当前想拥抱、含蓄亲近的愿望；仍按关系和表达频率相处', group: 'relationship' },
  { key: 'playfulness', label: '玩心', description: '当前轻松玩笑和互动的意愿', group: 'emotion' },
  { key: 'affection', label: '喜欢程度', description: '对用户稳定、逐步形成的喜欢程度', group: 'relationship' },
  { key: 'mood', label: '心情愉悦度', description: '当前整体心情的愉悦程度', group: 'emotion' },
].map(Object.freeze));

const TRAITS = Object.freeze({
  sensitiveness: 74,
  affectionateness: 78,
  playfulness: 62,
  independence: 67,
});

const clamp = (value) => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

function requestError(message, status = 400) {
  const error = new TypeError(message);
  error.status = status;
  return error;
}

function validateEdit(roleId, payload) {
  const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
  if (roleId !== 'miyue') throw requestError('角色无效');
  if (!plain(payload)) throw requestError('状态修改需要是一个对象');
  if (Object.keys(payload).some(key=>!['revision','values','needs','needCycle'].includes(key))) throw requestError('包含未知的状态字段');
  const {revision}=payload;
  if (!Number.isInteger(revision)||revision<0) throw requestError('状态版本无效');
  const hasValues=Object.hasOwn(payload,'values'),hasNeeds=Object.hasOwn(payload,'needs');
  const hasCycle=Object.hasOwn(payload,'needCycle');
  if (!hasValues&&!hasNeeds&&!hasCycle) throw requestError('请填写要调整的状态或愿望');
  const needCycle=hasCycle?payload.needCycle:{};
  if(hasCycle&&(!plain(needCycle)||!Object.keys(needCycle).length))throw requestError('需求周期修改不能为空');
  for(const [key,value] of Object.entries(needCycle)){
    const field=NEED_CYCLE_FIELDS.find(field=>field.key===key);
    if(!field||(field.type==='boolean'?typeof value!=='boolean':!Number.isInteger(value)||value<field.min||value>field.max))throw requestError('需求周期参数无效');
  }
  const values=hasValues?payload.values:{},needs=hasNeeds?payload.needs:{};
  if (hasValues&&(!plain(values)||!Object.keys(values).length)) throw requestError('数值修改不能为空');
  for (const [key,value] of Object.entries(values)) {
    if (!METRICS.includes(key)) throw requestError('未知的数值状态');
    if (!Number.isInteger(value)||value<0||value>100) throw requestError('状态数值需要是 0 到 100 的整数');
  }
  if (hasNeeds&&(!plain(needs)||!Object.keys(needs).length)) throw requestError('愿望修改不能为空');
  const normalized={};
  for (const [key,value] of Object.entries(needs)) {
    if (!NEED_FIELDS.some(field=>field.key===key)) throw requestError('未知的愿望类型');
    if (typeof value!=='string'||value.length>160||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) throw requestError('每项愿望请使用不超过 160 字的文字');
    normalized[key]=value.replace(/\s+/gu,' ').trim();
  }
  return {revision,values,needs:normalized,needCycle};
}

function asDate(value, label = 'clock') {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError(`${label} must return a valid date`);
  return date;
}

function randomUnit(random) {
  const value = Number(random());
  return Number.isFinite(value) ? Math.max(0, Math.min(0.999999999, value)) : 0.5;
}

function shanghaiParts(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function localDay(date) {
  const part = shanghaiParts(date);
  return `${part.year}-${part.month}-${part.day}`;
}

function eventInfo(event) {
  if (!event || typeof event !== 'object' || event.id == null) return null;
  const searchable = [event.category, event.type, event.title, event.activity, event.phase?.activity]
    .filter((value) => typeof value === 'string').join(' ').toLowerCase();
  let category = typeof event.category === 'string' ? event.category : 'ordinary';
  if (/travel|旅行|出发|返程/.test(searchable)) category = 'travel';
  else if (/cook|cooking|做饭|下厨|烹饪/.test(searchable)) category = 'cooking';
  else if (/work|工作|加班|赶稿|会议/.test(searchable)) category = 'work';
  else if (/emotional_need|情绪|难过|脆弱|低落/.test(searchable)) category = 'emotional_need';
  const positive = /relief|recover|better|comfort|开心|轻松|放松|好转|释然|被安慰|得到支持/.test(searchable);
  return { id: String(event.id), category, positive };
}

function newState(now) {
  return {
    version: 3,
    needCycle: {...NEED_CYCLE_DEFAULTS}, needClockAt: now.toISOString(), needRemainders: {},
    awaitingNeed: null, lastNeedContact: null, lastNeedRelief: null,
    fatigue: 30, hunger: 30, vitality: 70, stress: 27,
    security: 70, affectionNeed: 38, desire: 22, playfulness: 54,
    affection: 55, mood: 65, editRevision: 0, needs: {},
    traits: { ...TRAITS },
    mode: 'steady', interactions: 0, relationshipStage: '熟悉中的朋友',
    intimacyBoundary: 'open', createdAt: now.toISOString(), updatedAt: now.toISOString(),
    driftedAt: now.toISOString(), appliedEventIds: [], journal: [], lastTurn: null,
    pendingInitiative: null, initiativeGate: null, lastInitiatedAt: null,
    lastIntimacyInitiatedAt: null, lastIntimacyDay: null,
    lastAffectionExpressionAt: null, lastAffectionTurn: null,
    affectionGainDay: null, affectionGainToday: 0,
  };
}

function recentDistress(state, now) {
  return state.lastTurn?.tone === 'distressed'
    && now.getTime() - Date.parse(state.lastTurn.at) < 6 * 60 * 60 * 1000;
}

function modeFor(state, now) {
  if (recentDistress(state, now)) return 'attentive';
  if (state.fatigue >= 68 || state.vitality <= 35) return 'resting';
  if (state.stress >= 66) return 'stressed';
  if (state.mood <= 34 || state.security <= 38 || (state.security <= 55 && state.stress >= 40) || (state.affectionNeed >= 68 && state.stress >= 48)) return 'vulnerable';
  if ((state.playfulness >= 70 || state.mood >= 78) && state.mood >= 55 && state.stress < 48 && state.fatigue < 58) return 'playful';
  if (state.security >= 68 && state.mood >= 52 && state.stress < 42) return 'warm';
  return 'steady';
}

function journal(state, now, cause, changes = {}) {
  const safeChanges = Object.fromEntries(Object.entries(changes)
    .filter(([key, value]) => METRICS.includes(key) && Number.isFinite(value) && value !== 0)
    .map(([key, value]) => [key, Math.round(value)]));
  state.journal = [...(Array.isArray(state.journal) ? state.journal : []), {
    at: now.toISOString(), cause, changes: safeChanges,
  }].slice(-10);
}

function applyChanges(state, changes) {
  const actual = {};
  for (const [key, amount] of Object.entries(changes)) {
    if (!METRICS.includes(key) || !Number.isFinite(amount)) continue;
    const before = clamp(state[key]);
    state[key] = clamp(before + amount);
    actual[key] = state[key] - before;
  }
  return actual;
}

function targetsAt(now) {
  const hour = Number(shanghaiParts(now).hour);
  const sleeping = hour < 7 || hour >= 23;
  const evening = hour >= 20;
  const mealtime = [7, 11, 12, 18, 19].includes(hour);
  return {
    fatigue: sleeping ? 65 : evening ? 46 : 27,
    hunger: mealtime ? 57 : 28,
    vitality: sleeping ? 38 : evening ? 55 : 72,
    stress: 27, security: 68, affectionNeed: 36, desire: 20, playfulness: evening ? 58 : 50,
    affection: 0, mood: evening ? 62 : 66,
  };
}

function boundaryCue(text) {
  const value = typeof text === 'string' ? text : '';
  if (/(?:不想|不要|不可以|不能|不愿意|别|不喜欢|停止|拒绝).{0,6}(?:抱抱|拥抱|亲密|暧昧|撒娇|调情|亲我|亲亲|靠近)|(?:保持|只做).{0,4}(?:普通朋友|朋友)|不要越界/.test(value)) return 'declined';
  if (/^(?:抱抱我|亲亲我|撒个娇|哄哄我)[。！!～~]*$/.test(value.trim())) return 'invited';
  if (/(?:可以|愿意|想要|我想|欢迎|允许).{0,6}(?:抱抱|拥抱|亲密|暧昧|撒娇|调情|亲亲|靠近)|可以恢复亲密/.test(value)) return 'invited';
  return 'unspecified';
}

function inferTone(text) {
  const value = typeof text === 'string' ? text : '';
  if (/难过|崩溃|焦虑|委屈|撑不住|很累|痛苦/.test(value)) return 'distressed';
  if (/哈哈|逗你|开玩笑|真可爱|有趣/.test(value)) return 'playful';
  if (/辛苦了|陪着你|说给我听|我在|照顾好自己|支持你|关心你/.test(value)) return 'supportive';
  if (/随便|不聊了|忙着|离我远点/.test(value)) return 'distant';
  return 'neutral';
}

function validateSignals(signals) {
  if (signals == null) return null;
  if (typeof signals !== 'object' || Array.isArray(signals)) throw new TypeError('signals must be an object or null');
  const tones = new Set(['supportive', 'playful', 'distressed', 'distant', 'neutral']);
  const closeness = new Set(['invited', 'declined', 'unspecified']);
  if (!tones.has(signals.tone) || !closeness.has(signals.closeness)) {
    throw new TypeError('signals must contain a valid tone and closeness');
  }
  return { tone: signals.tone, closeness: signals.closeness };
}

function affectionAllowed(state, now, tuning = null) {
  const limits=tuning?tuningEffects(tuning):{affectionHours:16,affectionTurns:6};
  if(tuning?.flirtation===0)return false;
  if (state.intimacyBoundary === 'friendly') return false;
  if (state.affection < 50) return false;
  const sinceCreated = now.getTime() - Date.parse(state.createdAt);
  if (!state.lastAffectionExpressionAt) return sinceCreated >= Math.min(12,limits.affectionHours)*3600000;
  return now.getTime() - Date.parse(state.lastAffectionExpressionAt) >= limits.affectionHours*3600000
    && state.interactions - Number(state.lastAffectionTurn || 0) >= limits.affectionTurns;
}

function initiativeConditions(state, now, trigger, tuning = null) {
  if(trigger.startsWith('cycle_'))return needCycleStatus(state,now,tuning)[trigger.slice(6)]?.due===true;
  if (trigger === 'care') return recentDistress(state, now);
  if (trigger === 'connection') return Boolean(state.needs?.emotional?.trim())&&!recentDistress(state,now);
  if (trigger === 'rest') return state.fatigue >= 50 || state.vitality <= 42;
  if (trigger === 'stress') return state.stress >= 64;
  if (trigger === 'vulnerable') return modeFor(state, now) === 'vulnerable';
  if (trigger === 'intimacy') {
    return state.intimacyBoundary !== 'friendly'
      && state.playfulness >= 67 && state.security >= 60 && state.stress < 45
      && state.affection >= 50 && state.mood >= 50
      && Boolean(resolveNeeds(state).physical) && ['supportive', 'playful'].includes(state.lastTurn?.tone)
      && affectionAllowed(state, now,tuning) && state.lastIntimacyDay !== localDay(now);
  }
  return false;
}

function pendingValid(state, now, tuning = null) {
  const pending = state.pendingInitiative;
  if (!pending || !pending.createdAt || now.getTime() - Date.parse(pending.createdAt) >= FOUR_HOURS) return false;
  return initiativeConditions(state, now, pending.trigger,tuning);
}

function publicInitiative(pending) {
  if (!pending) return null;
  const { trigger: _trigger, createdAt: _createdAt, ...result } = pending;
  return structuredClone(result);
}

function publicState(state, now, tuning = null) {
  const mode = modeFor(state, now);
  const human = {
    resting: ['身体有些累，想把节奏放慢一点', '先休息和照顾好日常，也愿意安静听一会儿'],
    stressed: ['心里有一点绷紧，想先理清眼前的事', '需要减轻压力或得到具体帮助，不把压力转给用户'],
    attentive: ['听见对方正在难受，注意力更多放在理解对方', '先倾听和支持，暂时不发起暧昧或索取照顾'],
    vulnerable: ['此刻比较敏感，想诚实面对自己的感受', '想被理解，也会自己照顾情绪'],
    playful: ['心情轻快，有一点自然的玩心', '想接住轻松的话题，但不强行变成暧昧'],
    warm: ['内心安稳温和，愿意认真听也愿意分享', '想保持有来有回的陪伴'],
    steady: ['状态平稳，注意力在眼前的生活和谈话里', '想跟着用户当前的话题自然交流'],
  }[mode];
  return {
    ...structuredClone(state),
    mode,
    needs: resolveNeeds({...state,mode}),
    traits: tuning?{sensitiveness:tuning.sensitivity,affectionateness:tuning.warmth,playfulness:tuning.playfulness,independence:tuning.independence}:{ ...TRAITS },
    feeling: human[0],
    wish: human[1],
    affectionAllowed: affectionAllowed(state, now,tuning),
    suppressed: state.intimacyBoundary === 'friendly',
    needCycle: cycleConfig(state),
    needCycleStatus: needCycleStatus(state,now,tuning),
  };
}

function editableView(state) {
  return {
    revision: Number.isInteger(state.editRevision) ? state.editRevision : 0,
    values: Object.fromEntries(METRICS.map((key) => [key, state[key]])),
    fields: STATE_FIELDS.map((field) => ({ ...field })),
    needs: {...state.needs},
    needFields: NEED_FIELDS.map(field=>({...field,examples:[...field.examples]})),
    needCycle: {...state.needCycle},
    needCycleFields: NEED_CYCLE_FIELDS.map(field=>({...field})),
    needCycleStatus: structuredClone(state.needCycleStatus),
    mode: state.mode,
    feeling: state.feeling,
    wish: state.wish,
    updatedAt: state.updatedAt,
    journal: structuredClone(state.journal),
  };
}

export class InnerStateRepository {
  constructor(store, { clock = () => new Date(), random = Math.random, getTuning = () => null, getRelationship = () => null } = {}) {
    if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('store with db and transaction is required');
    if (typeof clock !== 'function' || typeof random !== 'function') throw new TypeError('clock and random must be functions');
    this.store = store;
    this.clock = clock;
    this.random = random;this.getTuning=getTuning;
    this.getRelationship=getRelationship;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS inner_states (
        role_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inner_state_events (
        role_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        category TEXT NOT NULL,
        applied_at TEXT NOT NULL,
        PRIMARY KEY(role_id, event_id)
      )
    `);
  }

  #load(now) {
    const row = this.store.db.prepare('SELECT state_json FROM inner_states WHERE role_id=?').get('miyue');
    if (!row) return this.#applyRelationship(newState(now));
    const state = { ...newState(now), ...JSON.parse(row.state_json) };
    state.traits = { ...TRAITS };
    return this.#applyRelationship(state);
  }

  #applyRelationship(state) {
    const relationship=this.getRelationship();
    if(!relationship)return state;
    if(relationship.hasBoundaryHistory)state.intimacyBoundary=relationship.intimacyBoundary;
    const value=relationship.status?.value;
    if(relationship.status?.explicit||value&&value!=='friends')state.relationshipStage=({friends:'知心朋友',dating:'恋爱中',partners:'稳定的恋人'})[value]||state.relationshipStage;
    return state;
  }

  #save(state, now) {
    this.#applyRelationship(state);
    state.mode = modeFor(state, now);
    state.updatedAt = now.toISOString();
    this.store.db.prepare(`
      INSERT INTO inner_states(role_id,state_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(role_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at
    `).run('miyue', JSON.stringify(state), state.updatedAt);
    return state;
  }

  #applyDrift(state, now) {
    const migrated=state.version!==3;
    state.version=3;
    const needsChanged=advanceNeedCycle(state,now)||migrated;
    const last = asDate(state.driftedAt || state.updatedAt || now, 'stored drift time');
    const elapsed = now.getTime() - last.getTime();
    if (elapsed < HALF_HOUR) return needsChanged;
    const windows = Math.min(12, Math.floor(elapsed / HALF_HOUR));
    const targets = targetsAt(now), tuning=this.getTuning();
    if(tuning){targets.stress-= (tuning.optimism-65)*.12;targets.security+=(tuning.optimism-65)*.12;targets.playfulness+=(tuning.playfulness-55)*.2;}
    const totals = {};
    for (let window = 0; window < windows; window += 1) {
      const noise = (randomUnit(this.random) - 0.5) * 2;
      for (const key of METRICS) {
        // Liking is intentionally stable: time away never changes it.
        if (key === 'affection') continue;
        if(key==='affectionNeed'||key==='desire')continue;
        let target = targets[key];
        // Time away never creates longing or sexual pressure.
        if (key === 'affectionNeed' || key === 'desire') target = Math.min(state[key], target);
        const before = state[key];
        const limit = key === 'mood' ? 2 : 4;
        state[key] = bodyMeter.relax(state[key],{target,gain:key==='mood'?.04:.12,noise:noise*(key==='mood'?.4:key==='stress'||key==='playfulness'?1.1:.7),limit});
        totals[key] = (totals[key] || 0) + state[key] - before;
      }
    }
    state.driftedAt = now.toISOString();
    journal(state, now, '自然作息变化', totals);
    return true;
  }

  #applyEvent(state, event, now) {
    const info = eventInfo(event);
    if (!info || this.store.db.prepare(
      'SELECT 1 FROM inner_state_events WHERE role_id=? AND event_id=?',
    ).get('miyue', info.id)) return false;
    const effects = info.category === 'emotional_need' && info.positive
      ? { stress: -8, security: 7, affectionNeed: -3, vitality: 3, playfulness: 3, mood: 8 }
      : ({
        work: { stress: 12, fatigue: 7, vitality: -5, mood: -7 },
        cooking: { hunger: -18, stress: -5, vitality: 3, mood: 4 },
        travel: { fatigue: 13, vitality: -5, playfulness: 8, stress: -2, mood: 5 },
        emotional_need: { stress: 16, security: -18, affectionNeed: 8, vitality: -4, mood: -10 },
      }[info.category] || { playfulness: 2, mood: 1 });
    const tuning=this.getTuning();
    if(tuning)for(const key of ['stress','security'])if(effects[key])effects[key]*=tuningEffects(tuning).sensitivityGain;
    const actual = applyChanges(state, effects);
    this.store.db.prepare(
      'INSERT INTO inner_state_events(role_id,event_id,category,applied_at) VALUES(?,?,?,?)',
    ).run('miyue', info.id, info.category, now.toISOString());
    state.appliedEventIds = [...state.appliedEventIds, info.id].slice(-40);
    journal(state, now, `生活事件：${info.category}`, actual);
    return true;
  }

  get(roleId = 'miyue', event = null) {
    if (roleId !== 'miyue') return null;
    const now = asDate(this.clock());
    return this.store.transaction(() => {
      const state = this.#load(now);
      const driftChanged = this.#applyDrift(state, now);
      const eventChanged = this.#applyEvent(state, event, now);
      if (driftChanged || eventChanged || !this.store.db.prepare('SELECT 1 FROM inner_states WHERE role_id=?').get('miyue')) this.#save(state, now);
      return publicState(state, now,this.getTuning());
    });
  }

  view(roleId = 'miyue') {
    if (roleId !== 'miyue') throw requestError('invalid roleId');
    return editableView(this.get(roleId));
  }

  revision(roleId = 'miyue') {
    if (roleId !== 'miyue') return null;
    const row = this.store.db.prepare('SELECT state_json FROM inner_states WHERE role_id=?').get(roleId);
    if (!row) return 0;
    const revision = JSON.parse(row.state_json).editRevision;
    return Number.isInteger(revision) ? revision : 0;
  }

  applyDailyEffect(effect, roleId = 'miyue') {
    if (roleId !== 'miyue') return false;
    if (!effect || typeof effect !== 'object' || Array.isArray(effect)) throw new TypeError('daily effect must be an object');
    const { id, title, phase, changes } = effect;
    const allowed = new Set(['fatigue', 'stress', 'mood', 'vitality', 'playfulness']);
    if (typeof id !== 'string' || !/^daily:\S{1,240}$/u.test(id)) throw new TypeError('daily effect id is invalid');
    if (typeof title !== 'string' || !title.trim() || title.length > 160) throw new TypeError('daily effect title is invalid');
    if (typeof phase !== 'string' || !phase.trim() || phase.length > 80) throw new TypeError('daily effect phase is invalid');
    if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) throw new TypeError('daily effect changes are invalid');
    for (const [key, value] of Object.entries(changes)) {
      if (!allowed.has(key) || !Number.isInteger(value) || value < -4 || value > 4 || value === 0) throw new TypeError('daily effect change is invalid');
    }
    const now = asDate(this.clock());
    return this.store.transaction(() => {
      if (this.store.db.prepare('SELECT 1 FROM inner_state_events WHERE role_id=? AND event_id=?').get(roleId, id)) return false;
      const state = this.#load(now);
      this.#applyDrift(state, now);
      const actual = applyChanges(state, changes);
      this.store.db.prepare(
        'INSERT INTO inner_state_events(role_id,event_id,category,applied_at) VALUES(?,?,?,?)',
      ).run(roleId, id, `daily:${phase}`, now.toISOString());
      state.appliedEventIds = [...state.appliedEventIds, id].slice(-40);
      if (Object.values(actual).some((value) => value !== 0)) state.editRevision = (Number.isInteger(state.editRevision) ? state.editRevision : 0) + 1;
      journal(state, now, `日常事件：${title.trim()}`, actual);
      this.#save(state, now);
      return true;
    });
  }

  update(roleId = 'miyue', payload) {
    const edit = validateEdit(roleId, payload);
    const now = asDate(this.clock());
    return this.store.transaction(() => {
      const state = this.#load(now);
      this.#applyDrift(state, now);
      const currentRevision = Number.isInteger(state.editRevision) ? state.editRevision : 0;
      if (edit.revision !== currentRevision) throw requestError('state revision is stale', 409);
      const changes = {};
      for (const [key, value] of Object.entries(edit.values)) {
        changes[key] = value - state[key];
        state[key] = value;
      }
      state.needs={...(state.needs||{}),...edit.needs};
      state.needCycle={...cycleConfig(state),...edit.needCycle};
      state.needClockAt=now.toISOString();
      for(const [channel,key] of [['emotional','affectionNeed'],['physical','desire']])if(Object.hasOwn(edit.values,key))state.needRemainders[channel]=0;
      state.pendingInitiative = null;
      state.initiativeGate = null;
      state.editRevision = currentRevision + 1;
      state.driftedAt = now.toISOString();
      journal(state, now, Object.keys(edit.needs).length?'用户调整具体愿望：'+Object.keys(edit.needs).map(key=>NEED_FIELDS.find(field=>field.key===key).label).join('、'):'用户手动调整内在状态', changes);
      return editableView(publicState(this.#save(state, now), now, this.getTuning()));
    });
  }

  afterTurn(roleId, text, signals = null, event = null, {previousAssistantId=undefined} = {}) {
    if (roleId !== 'miyue') return null;
    const validated = validateSignals(signals);
    const now = asDate(this.clock());
    return this.store.transaction(() => {
      const state = this.#load(now);
      this.#applyDrift(state, now);
      this.#applyEvent(state, event, now);
      if(previousAssistantId!==undefined&&state.awaitingNeed?.messageId!==previousAssistantId)state.awaitingNeed=null;
      state.interactions += 1;
      // A real user turn supersedes an opener composed before that turn.
      state.pendingInitiative = null;
      if (state.interactions >= 12) state.relationshipStage = '逐渐熟悉的朋友；关系承诺只来自双方明确约定';
      const explicit = boundaryCue(text);
      const tone = explicit === 'declined' ? 'neutral' : (validated?.tone || inferTone(text));
      const closeness = explicit !== 'unspecified' ? explicit : (validated?.closeness || 'unspecified');
      let changes = {};
      let cue = '普通交流';
      if (explicit === 'declined') {
        state.intimacyBoundary = 'friendly';
        changes = { desire: -18, affectionNeed: -8, security: 3, mood: -2 };
        cue = '用户明确希望保持友好距离';
      } else if (explicit === 'invited') {
        state.intimacyBoundary = 'open';
        changes = { security: 5, stress: -3, playfulness: 3, desire: 5, affectionNeed: 2, mood: 4 };
        cue = '用户明确允许更亲近的表达';
      } else if (closeness === 'declined') {
        state.intimacyBoundary = 'friendly';
        changes = { desire: -12, affectionNeed: -6, mood: -2 };
        cue = '用户表达了距离边界';
      } else if (tone === 'supportive') {
        changes = { security: 9, stress: -8, affectionNeed: -5, playfulness: 2, mood: 6 };
        cue = '用户表达支持和关心';
      } else if (tone === 'playful') {
        changes = { playfulness: 9, stress: -3, security: 2, mood: 7 };
        cue = '用户带来轻松玩笑';
      } else if (tone === 'distressed') {
        changes = { stress: 4, vitality: -1, playfulness: -8, mood: -6 };
        cue = '用户正在经历压力，需要先被倾听';
      } else if (tone === 'distant') {
        changes = { playfulness: -3, desire: -2, mood: -4 };
        cue = '用户此刻想把注意力放在别处';
      }
      const tuning=this.getTuning();
      if(tuning){for(const key of ['stress','security'])if(changes[key])changes[key]*=tuningEffects(tuning).sensitivityGain;if(changes.playfulness>0)changes.playfulness*=.5+tuning.playfulness/110;}
      if (tone === 'supportive' || tone === 'playful') {
        const day = localDay(now);
        if (state.affectionGainDay !== day) {
          state.affectionGainDay = day;
          state.affectionGainToday = 0;
        }
        const gain = Math.min(1, Math.max(0, 2 - Number(state.affectionGainToday || 0)));
        if (gain > 0) {
          changes.affection = gain;
          state.affectionGainToday = Number(state.affectionGainToday || 0) + gain;
        }
      }
      if(cycleConfig(state).enabled&&closeness!=='declined'){delete changes.affectionNeed;delete changes.desire;}
      const actual = applyChanges(state, changes);
      const fulfilled=needFulfillment(state,text,now);
      if(fulfilled.length){
        const relief=cycleConfig(state).relief,needChanges={};
        for(const channel of fulfilled){const key=channel==='emotional'?'affectionNeed':'desire';needChanges[key]=-relief;state.needRemainders[channel]=0;}
        const reduced=applyChanges(state,needChanges);
        state.lastNeedRelief={at:now.toISOString(),channels:fulfilled,changes:reduced};
        journal(state,now,'相应互动带来满足',reduced);
      }
      // A topic change also releases the outstanding invitation, without counting as satisfaction.
      state.awaitingNeed=null;
      state.lastTurn = { at: now.toISOString(), cue, tone, closeness };
      journal(state, now, cue, actual);
      return publicState(this.#save(state, now), now,this.getTuning());
    });
  }

  noteReply(roleId, replyText, userText = '') {
    if (roleId !== 'miyue') return false;
    const reply = typeof replyText === 'string' ? replyText : '';
    if (!/(?:想你|抱抱|拥抱|撒娇|暧昧|调情|亲你|亲亲|心动|靠近一点)/.test(reply)) return false;
    const now = asDate(this.clock());
    return this.store.transaction(() => {
      const state = this.#load(now);
      state.pendingInitiative = null;
      state.lastAffectionExpressionAt = now.toISOString();
      state.lastAffectionTurn = state.interactions;
      journal(state, now, boundaryCue(userText) === 'invited' ? '回应用户主动的亲近邀请' : '回复中已有亲近表达');
      this.#save(state, now);
      return true;
    });
  }

  context(roleId = 'miyue', event = null) {
    const state = this.get(roleId, event);
    if (!state) return '';
    const now = asDate(this.clock());
    const feelings = {
      resting: '她现在更需要休息和放慢速度，不把疲惫变成对用户的索取。',
      stressed: '她心里有些绷紧，适合先处理压力或说清需要。',
      attentive: '她听见用户正在难受，眼下优先理解、倾听和提供合适的具体支持，不发起暧昧。',
      vulnerable: '她此刻比较敏感，想被理解，也仍能自己照顾情绪。',
      playful: '她有一点轻快和玩心，可以自然接住轻松的话题。',
      warm: '她感到安稳、温和，愿意认真听和分享。',
      steady: '她状态平稳，适合跟着用户眼前的话题自然交流。',
    };
    const need = state.mode === 'attentive' ? '先听懂用户的难受并提供合适支持' : state.fatigue >= 60 ? '优先休息和实际照顾' : state.stress >= 58 ? '优先倾听、减压或具体帮助' : state.hunger >= 58 ? '会自己安排吃东西' : '没有需要用户负责填补的缺口';
    const tuning=this.getTuning(),limits=tuning?tuningEffects(tuning):{affectionHours:16,affectionTurns:6};
    const lastExpression = state.lastAffectionExpressionAt ? '已经有过亲近表达，按当前冷却控制节奏' : '还没有记录亲近表达';
    return [
      '【林晓薇当前内在状态｜虚构且有边界】',
      feelings[state.mode], `眼下需要：${need}。`,
      `稳定性格：${tuning?'按本轮可调相处方式的数值表达':'敏感、重感情、有玩心，也有充分独立性'}。关系阶段：${state.relationshipStage}。`,
      state.intimacyBoundary === 'friendly'
        ? '亲密边界：当前暂停主动发起亲近，具体限制范围和有效期以已记录的用户原话为准；不据此改变关系身份。'
        : '亲密边界：开放但不代表默认恋爱或同意。日常恋爱陪伴以各自生活和用户正在做的事为主，不主动把关心升级成暧昧。',
      `表达节奏：${lastExpression}。${state.affectionAllowed ? `${Boolean(state.needs.physical) || state.desire >= 55 ? '她的身体亲近愿望偏高：接话时写出具体身体感受（发烫、发痒、想被抱/抚摸/刺激），仍以当前话题为先，不每句另起索取。' : ''}主动发起仍按冷却，但愿望偏高时普通回复也可带身体感受。` : `普通回复不要主动发起暧昧邀约；至少间隔${limits.affectionHours}小时且${limits.affectionTurns}个用户回合。身体愿望偏高时仍可写自身感受，只是不要变成催促用户行动。`}用户明确主动邀请时可以自然、具体地回应，但回复后要记录，避免接下来反复主动索取。`,
      `内部数值：疲${state.fatigue} 饥${state.hunger} 活${state.vitality} 压${state.stress} 安${state.security} 玩${state.playfulness} 喜欢${state.affection} 愉悦${state.mood}。仅用于把握语气，不逐项叙述。`,
      needsContext(state.needs, state),
      needCycleContext(state),
      state.lastTurn ? `最近互动线索：${state.lastTurn.cue}。` : '最近没有特别的互动线索。',
      '用户发起的话题和现实需求优先。状态用于理解感受，不逐项报数；不因用户离开而更饿、更委屈或更渴望亲密，不用状态推动关系承诺。',
    ].join('\n').slice(0, 2400);
  }

  initiative(roleId = 'miyue', event = null) {
    if (roleId !== 'miyue') return null;
    const now = asDate(this.clock());
    return this.store.transaction(() => {
      const state = this.#load(now);
      let changed = this.#applyDrift(state, now);
      changed = this.#applyEvent(state, event, now) || changed;
      const dueNeed=needCycleCandidate(state,now,this.getTuning());
      if (state.pendingInitiative && (!dueNeed||state.pendingInitiative.needChannel===dueNeed.needChannel) && pendingValid(state, now,this.getTuning())) {
        if (changed) this.#save(state, now);
        return publicInitiative(state.pendingInitiative);
      }
      if (state.pendingInitiative) {
        state.pendingInitiative = null;
        changed = true;
      }
      if (!dueNeed&&state.lastInitiatedAt && now.getTime() - Date.parse(state.lastInitiatedAt) < FOUR_HOURS) {
        if (changed) this.#save(state, now);
        return null;
      }

      let candidate = dueNeed;
      if (recentDistress(state, now)) {
        candidate = { trigger: 'care', kind: 'thought', intimacy: false, context: '先关心用户刚才表达的难受，提供倾听或一项具体帮助，不转成自己的情绪需求，也不发起暧昧。' };
      } else if (!candidate&&(state.fatigue >= 50 || state.vitality <= 42)) {
        candidate = { trigger: 'rest', kind: 'need', intimacy: false, context: '有点累，想先歇一歇，也可以轻轻问问对方今天过得怎样；不要要求照顾。' };
      } else if (!candidate&&state.stress >= 64) {
        candidate = { trigger: 'stress', kind: 'thought', intimacy: false, context: '心里有些绷紧，想聊一个具体困扰或换个轻松话题；先尊重用户正在忙的事。' };
      } else if (!candidate&&modeFor(state, now) === 'vulnerable') {
        candidate = { trigger: 'vulnerable', kind: 'feeling', intimacy: false, context: '有一点敏感，想坦白此刻感受，同时明确不需要用户负责解决。' };
      }

      if (!candidate && !cycleConfig(state).enabled && initiativeConditions(state, now, 'intimacy',this.getTuning())) {
        const windowKey = String(Math.floor(now.getTime() / FOUR_HOURS));
        if (state.initiativeGate?.windowKey !== windowKey) {
          const draw = randomUnit(this.random);
          state.initiativeGate = { windowKey, draw, passed: draw < 0.15 };
          changed = true;
        }
        if (state.initiativeGate.passed) {
          candidate = { trigger: 'intimacy', kind: 'playful', intimacy: true, context: '本次想表达的身体亲近愿望：'+JSON.stringify(resolveNeeds(state).physical)+'。自然表达这个具体愿望，并写出身体感受：发烫、发痒、发软、想被抱紧/抚摸/刺激的部位；不把想要写成用户已经做过的动作，关系身份按已确认记录。' };
        }
      }
      if (!candidate&&!cycleConfig(state).enabled&&initiativeConditions(state,now,'connection',this.getTuning())) {
        candidate={trigger:'connection',kind:'feeling',intimacy:false,context:'此刻想与你交流的需要：'+JSON.stringify(resolveNeeds(state).emotional)+'。用具体的话自然表达，不要求用户立刻回复。'};
      }
      if (!candidate) {
        if (changed) this.#save(state, now);
        return null;
      }
      state.pendingInitiative = {
        key: `inner:${now.getTime()}:${state.interactions}`,
        trigger: candidate.trigger, createdAt: now.toISOString(),
        kind: candidate.kind, intimacy: candidate.intimacy,
        ...(candidate.needChannel?{needChannel:candidate.needChannel}:{}),
        suppressed: state.intimacyBoundary === 'friendly', context: candidate.context,
      };
      this.#save(state, now);
      return publicInitiative(state.pendingInitiative);
    });
  }

  markInitiated(roleId, key, messageId) {
    if (roleId !== 'miyue' || typeof key !== 'string' || !messageId) return false;
    const now = asDate(this.clock());
    return this.store.transaction(() => {
      const state = this.#load(now);
      const driftChanged = this.#applyDrift(state, now);
      if (!state.pendingInitiative || state.pendingInitiative.key !== key || !pendingValid(state, now,this.getTuning())) {
        const matched = state.pendingInitiative?.key === key;
        if (matched) state.pendingInitiative = null;
        if (driftChanged || matched) this.#save(state, now);
        return false;
      }
      const intimacy = Boolean(state.pendingInitiative.intimacy);
      if(state.pendingInitiative.needChannel){
        state.lastNeedContact={channel:state.pendingInitiative.needChannel,messageId:String(messageId),deliveredAt:now.toISOString()};
        state.awaitingNeed={...state.lastNeedContact};
      }
      state.lastInitiatedAt = now.toISOString();
      state.lastInitiativeDelivery = {
        key, messageId: String(messageId), deliveredAt: now.toISOString(), intimacy,
      };
      if (intimacy) {
        state.lastIntimacyInitiatedAt = now.toISOString();
        state.lastIntimacyDay = localDay(now);
        state.lastAffectionExpressionAt = now.toISOString();
        state.lastAffectionTurn = state.interactions;
      }
      journal(state, now, intimacy ? '已送达一次克制的亲近主动' : '已送达一次状态主动');
      state.pendingInitiative = null;
      this.#save(state, now);
      return true;
    });
  }
}

export { METRICS, STATE_FIELDS, TRAITS };
