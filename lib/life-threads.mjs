import fs from 'node:fs';
import { randomUUID } from 'node:crypto';

const bundled = JSON.parse(fs.readFileSync(new URL('../app-data/life-threads.json', import.meta.url), 'utf8'));
const HOUR = 60 * 60 * 1000;
const COOLDOWN_HOURS = 48;
const ROLE_ID = 'miyue';

const clone = (value) => structuredClone(value);

function repositoryError(message, status, code) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function asDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('clock must return a valid date');
  return date;
}

function cleanDestination(value) {
  if (typeof value !== 'string') return null;
  const result = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  return result && result.length <= 80 ? result : null;
}

function travelFrom(event) {
  const wrapped = Boolean(event?.active && typeof event.active === 'object');
  const active = wrapped ? event.active : event;
  if (!active || active.type !== 'travel') return null;
  const destination = cleanDestination(active.destination);
  const phaseId = typeof active.phase === 'string' ? active.phase : typeof active.phase?.id === 'string' ? active.phase.id : null;
  return destination ? { id: typeof active.id === 'string' ? active.id : null, destination, phaseId, direct: !wrapped } : null;
}

function normalizeReply(value) {
  return String(value || '').normalize('NFKC').trim().toLocaleLowerCase('zh-CN')
    .replace(/[\s，。！、,.!；;：“”"'（）()]/gu, '');
}

function fill(value, destination) {
  if (typeof value === 'string') return value.replaceAll('{destination}', destination || '旅途中');
  if (Array.isArray(value)) return value.map((item) => fill(item, destination));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, fill(item, destination)]));
  }
  return value;
}

function validateCatalog(input) {
  if (!input || typeof input.version !== 'string' || !Array.isArray(input.templates) || input.templates.length < 3) {
    throw new TypeError('life thread catalog must contain a version and at least three templates');
  }
  const ids = new Set();
  for (const template of input.templates) {
    if (!template?.id || ids.has(template.id) || !template.title || !['travel', 'independent'].includes(template.kind)) {
      throw new TypeError('each life thread template needs a unique id, title, and supported kind');
    }
    ids.add(template.id);
    if (!Array.isArray(template.initialFacts) || !Array.isArray(template.beats) || template.beats.length < 4 || template.beats.length > 5) {
      throw new TypeError(`invalid life thread template: ${template.id}`);
    }
    const beatIds = new Set();
    const choiceIds = new Set();
    for (const beat of template.beats) {
      if (!beat?.id || beatIds.has(beat.id) || !beat.title || !beat.text || !beat.emotion || !beat.need
          || !Array.isArray(beat.facts) || !Number.isFinite(beat.delayHours)
          || beat.delayHours < 12 || beat.delayHours > 24) {
        throw new TypeError(`invalid life thread beat: ${template.id}/${beat?.id || '?'}`);
      }
      beatIds.add(beat.id);
      for (const choice of beat.choices || []) {
        if (!choice?.id || choiceIds.has(choice.id) || !choice.label || !choice.fact || !Array.isArray(choice.matchPhrases)) {
          throw new TypeError(`invalid life thread choice: ${template.id}/${beat.id}`);
        }
        choiceIds.add(choice.id);
      }
      for (const [choiceId, variant] of Object.entries(beat.variants || {})) {
        if (!choiceIds.has(choiceId) || !variant.text || !variant.emotion || !variant.need || !Array.isArray(variant.facts)) {
          throw new TypeError(`invalid life thread variant: ${template.id}/${beat.id}/${choiceId}`);
        }
      }
    }
  }
  return clone(input);
}

function parse(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function publicChoice(choice) { return { id: choice.id, label: choice.label }; }

export class LifeThreadRepository {
  constructor(store, { clock = () => new Date(), random = Math.random, catalog = bundled } = {}) {
    if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('store with db and transaction is required');
    if (typeof clock !== 'function' || typeof random !== 'function') throw new TypeError('clock and random must be functions');
    this.store = store;
    this.clock = clock;
    this.random = random;
    this.catalog = validateCatalog(catalog);
    this.templates = new Map(this.catalog.templates.map((template) => [template.id, template]));
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS life_thread_runtime (
        role_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS life_thread_deliveries (
        role_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        beat_id TEXT NOT NULL,
        pending_key TEXT NOT NULL,
        message_id TEXT NOT NULL,
        delivered_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY(role_id, thread_id, beat_id),
        UNIQUE(role_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS life_thread_commits (
        role_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        committed_at TEXT NOT NULL,
        PRIMARY KEY(role_id, message_id)
      );
      CREATE TABLE IF NOT EXISTS life_thread_plans (
        token TEXT PRIMARY KEY,
        role_id TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        beat_id TEXT NOT NULL,
        expected_version INTEGER NOT NULL,
        choice_id TEXT,
        created_at TEXT NOT NULL,
        committed_message_id TEXT
      );
    `);
  }

  #load() {
    const row = this.store.db.prepare('SELECT state_json FROM life_thread_runtime WHERE role_id=?').get(ROLE_ID);
    return row ? parse(row.state_json) : null;
  }

  #save(state, now) {
    this.store.db.prepare(`
      INSERT INTO life_thread_runtime(role_id,state_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(role_id) DO UPDATE SET state_json=excluded.state_json,updated_at=excluded.updated_at
    `).run(ROLE_ID, JSON.stringify(state), now.toISOString());
  }

  #selectTemplate(event, excludedId = null) {
    const travel = travelFrom(event);
    const travelReady = Boolean(travel && (travel.direct || (travel.phaseId && travel.phaseId !== 'plan')));
    let candidates = this.catalog.templates.filter((template) => template.kind === 'independent' || (template.kind === 'travel' && travelReady));
    const withoutRepeat = candidates.filter((template) => template.id !== excludedId);
    if (withoutRepeat.length) candidates = withoutRepeat;
    if (!candidates.length) return null;
    const draw = Number(this.random());
    const safe = Number.isFinite(draw) ? Math.min(Math.max(draw, 0), 0.9999999999999999) : 0;
    return { template: candidates[Math.floor(safe * candidates.length)], travel };
  }

  #newState(now, event, previous = null) {
    const selected = this.#selectTemplate(event, previous?.current?.templateId || previous?.lastTemplateId || null);
    if (!selected) return previous;
    const destination = selected.template.kind === 'travel' ? selected.travel.destination : null;
    const template = fill(selected.template, destination);
    return {
      catalogVersion: this.catalog.version,
      revision: Number(previous?.revision || 0) + 1,
      lastTemplateId: previous?.current?.templateId || previous?.lastTemplateId || null,
      current: {
        id: `life-thread-${ROLE_ID}-${now.getTime()}-${randomUUID()}`,
        templateId: template.id,
        title: template.title,
        beatIndex: 0,
        status: 'active',
        startedAt: now.toISOString(),
        dueAt: now.toISOString(),
        delivered: false,
        decisions: {},
        knownFacts: clone(template.initialFacts),
        history: [],
        destination,
        sourceEventId: selected.template.kind === 'travel' ? selected.travel.id : null,
        pauseReason: null,
      },
    };
  }

  #template(state) { return state?.current ? this.templates.get(state.current.templateId) : null; }

  #resolvedBeat(state) {
    const source = this.#template(state)?.beats[state.current.beatIndex];
    if (!source) return null;
    let result = fill(source, state.current.destination);
    for (const choiceId of Object.values(state.current.decisions || {})) {
      if (result.variants?.[choiceId]) result = { ...result, ...clone(result.variants[choiceId]) };
    }
    delete result.variants;
    return result;
  }

  #choiceSource(state) {
    return fill(this.#template(state)?.beats[state.current.beatIndex] || {}, state.current.destination);
  }

  #availableChoices(state) {
    if (state.current.status !== 'active') return [];
    const beat = this.#choiceSource(state);
    if (state.current.decisions[beat.id]) return [];
    return beat.choices || [];
  }

  #pendingKey(state) {
    const beat = this.#resolvedBeat(state);
    if (!beat || state.current.status !== 'active' || state.current.delivered) return null;
    return `life-thread:${state.current.id}:${beat.id}:${state.current.beatIndex}`;
  }

  #view(state, { paused = false } = {}) {
    if (!state?.current) return null;
    const beat = this.#resolvedBeat(state);
    if (!beat) return null;
    const forcedPaused = paused && state.current.status === 'active';
    const status = forcedPaused ? 'paused' : state.current.status;
    return {
      id: state.current.id,
      template: state.current.templateId,
      templateId: state.current.templateId,
      kind: this.#template(state)?.kind || null,
      userDirected: Object.keys(state.current.decisions || {}).length > 0,
      travelBound: this.#template(state)?.kind === 'travel' && Boolean(state.current.sourceEventId),
      title: state.current.title,
      beat: { id: beat.id, title: beat.title, text: beat.text, emotion: beat.emotion, need: beat.need },
      status,
      version: state.revision,
      knownFacts: clone(state.current.knownFacts),
      choices: status === 'active' ? this.#availableChoices(state).map(publicChoice) : [],
      history: clone(state.current.history),
      pendingKey: status === 'active' ? this.#pendingKey(state) : null,
      dueAt: state.current.dueAt,
    };
  }

  #destinationChanged(state, event) {
    if (this.#template(state)?.kind !== 'travel') return false;
    const travel = travelFrom(event);
    return Boolean(travel && travel.destination !== state.current.destination);
  }

  #assertVersion(state, expectedVersion) {
    if (Number(expectedVersion) !== state.revision) {
      throw repositoryError('生活片段已更新，请刷新后再试', 409, 'STALE_LIFE_THREAD_VERSION');
    }
  }

  #assistantMessage(messageId) {
    const id = typeof messageId === 'string' ? messageId.trim() : '';
    if (!id) return null;
    try {
      const message = typeof this.store.getMessage === 'function'
        ? this.store.getMessage(id)
        : this.store.db.prepare('SELECT id,role,speaker,text FROM messages WHERE id=?').get(id);
      return message?.role === ROLE_ID && message.speaker === 'assistant' && typeof message.text === 'string' ? message : null;
    } catch {
      return null;
    }
  }

  get(roleId, event = null) {
    if (roleId !== ROLE_ID) return null;
    const now = asDate(this.clock());
    return this.store.transaction(() => {
      let state = this.#load();
      if (!state) {
        state = this.#newState(now, event);
        if (state) this.#save(state, now);
      }
      return this.#view(state, { paused: this.#destinationChanged(state, event) });
    });
  }

  tick(roleId, event = null) {
    if (roleId !== ROLE_ID) return null;
    const now = asDate(this.clock());
    return this.store.transaction(() => {
      let state = this.#load();
      if (!state) return null;
      const changedDestination = this.#destinationChanged(state, event);
      if (changedDestination) {
        if (state.current.status !== 'paused' || state.current.pauseReason !== 'destination_changed') {
          state.current.status = 'paused';
          state.current.pauseReason = 'destination_changed';
          state.revision += 1;
          this.#save(state, now);
        }
        return this.#view(state);
      }
      if (state.current.status === 'paused' && state.current.pauseReason === 'destination_changed') {
        const travel = travelFrom(event);
        if (travel && travel.destination !== state.current.destination) return this.#view(state);
        state.current.status = 'active';
        state.current.pauseReason = null;
        state.revision += 1;
        this.#save(state, now);
        return this.#view(state);
      }
      if (state.current.status === 'completed') {
        if (now.getTime() < Date.parse(state.current.dueAt)) return this.#view(state);
        state = this.#newState(now, event, state);
        this.#save(state, now);
        return this.#view(state);
      }
      if (state.current.status !== 'active' || !state.current.delivered || now.getTime() < Date.parse(state.current.dueAt)) {
        return this.#view(state);
      }
      const template = this.#template(state);
      if (state.current.beatIndex >= template.beats.length - 1) return this.#view(state);
      state.current.beatIndex += 1;
      state.current.delivered = false;
      state.current.dueAt = now.toISOString();
      state.revision += 1;
      this.#save(state, now);
      return this.#view(state);
    });
  }

  pending(roleId, event = null) {
    if (roleId !== ROLE_ID) return null;
    const state = this.#load();
    if (!state || this.#destinationChanged(state, event)) return null;
    const view = this.#view(state);
    if (!view?.pendingKey || asDate(this.clock()).getTime() < Date.parse(view.dueAt)) return null;
    return view;
  }

  markDelivered(key, messageId, delivery = null) {
    if (typeof key !== 'string' || !key || typeof messageId !== 'string' || !messageId.trim()) return false;
    const now = asDate(this.clock());
    return this.store.transaction(() => {
      const state = this.#load();
      if (!state || state.current.status !== 'active' || state.current.delivered || key !== this.#pendingKey(state)) return false;
      const beat = this.#resolvedBeat(state);
      const message = this.#assistantMessage(messageId);
      const exposure = delivery?.mode === 'material_exposure';
      if (!message || !message.text.trim()) return false;
      if (exposure && Number(delivery.expectedVersion) !== state.revision) return false;
      if (exposure && delivery.key !== key) return false;
      if (!exposure && !message.text.includes(beat.text)) return false;
      const receipt = exposure ? {
        id: beat.id,
        title: beat.title,
        selectedText: beat.text,
        emotion: beat.emotion,
        need: beat.need,
        facts: clone(beat.facts),
        messageId: messageId.trim(),
        actualReply: message.text,
        delivery: 'material_exposure',
        deliveredAt: now.toISOString(),
      } : {
        id: beat.id,
        title: beat.title,
        text: beat.text,
        emotion: beat.emotion,
        need: beat.need,
        facts: clone(beat.facts),
        messageId: messageId.trim(),
        deliveredAt: now.toISOString(),
      };
      try {
        this.store.db.prepare(`
          INSERT INTO life_thread_deliveries
            (role_id,thread_id,beat_id,pending_key,message_id,delivered_at,payload_json)
          VALUES(?,?,?,?,?,?,?)
        `).run(ROLE_ID, state.current.id, beat.id, key, receipt.messageId, receipt.deliveredAt, JSON.stringify(receipt));
      } catch (error) {
        if (/UNIQUE|constraint/iu.test(String(error?.message))) return false;
        throw error;
      }
      state.current.delivered = true;
      state.current.history.push(receipt);
      for (const fact of beat.facts) if (!state.current.knownFacts.includes(fact)) state.current.knownFacts.push(fact);
      const template = this.#template(state);
      if (state.current.beatIndex === template.beats.length - 1) {
        state.current.status = 'completed';
        state.current.completedAt = now.toISOString();
        state.current.dueAt = new Date(now.getTime() + COOLDOWN_HOURS * HOUR).toISOString();
      } else {
        state.current.dueAt = new Date(now.getTime() + beat.delayHours * HOUR).toISOString();
      }
      state.revision += 1;
      this.#save(state, now);
      return true;
    });
  }

  #makePlan(state, choiceId = null) {
    const beat = this.#resolvedBeat(state);
    const token = randomUUID();
    const plan = {
      token,
      roleId: ROLE_ID,
      threadId: state.current.id,
      beatId: beat.id,
      expectedVersion: state.revision,
      ...(choiceId ? { choiceId } : {}),
    };
    this.store.db.prepare(`
      INSERT INTO life_thread_plans
        (token,role_id,thread_id,beat_id,expected_version,choice_id,created_at)
      VALUES(?,?,?,?,?,?,?)
    `).run(token, ROLE_ID, plan.threadId, plan.beatId, plan.expectedVersion, choiceId, asDate(this.clock()).toISOString());
    return plan;
  }

  planChoice(roleId, choiceId, expectedVersion) {
    if (roleId !== ROLE_ID) return null;
    const state = this.#load();
    if (!state) return null;
    this.#assertVersion(state, expectedVersion);
    const choice = this.#availableChoices(state).find((item) => item.id === choiceId);
    if (!choice) throw repositoryError('这个选项不属于当前生活片段', 400, 'INVALID_LIFE_THREAD_CHOICE');
    return this.#makePlan(state, choice.id);
  }

  planReply(roleId, text) {
    if (roleId !== ROLE_ID) return null;
    const state = this.#load();
    if (!state) return null;
    const raw = String(text || '').trim();
    const normalized = normalizeReply(raw);
    if (!normalized || /[?？]/u.test(raw) || /^(?:不|别|不要|没|并不|不是|不想|不选)/u.test(normalized)) return this.#makePlan(state);
    const matches = [];
    for (const choice of this.#availableChoices(state)) {
      const phrases = [choice.label, ...choice.matchPhrases].map(normalizeReply).filter(Boolean);
      const exact = phrases.some((phrase) => [
        phrase, `我选${phrase}`, `选择${phrase}`, `我选择${phrase}`, `就${phrase}`, `就选${phrase}`, `${phrase}吧`,
      ].includes(normalized));
      if (exact) matches.push(choice.id);
    }
    return this.#makePlan(state, matches.length === 1 ? matches[0] : null);
  }

  commit(plan, messageId) {
    if (!plan || typeof plan !== 'object' || typeof plan.token !== 'string') {
      throw repositoryError('生活片段选择计划无效', 400, 'INVALID_LIFE_THREAD_PLAN');
    }
    if (typeof messageId !== 'string' || !messageId.trim()) throw new TypeError('messageId must be a non-empty string');
    const now = asDate(this.clock());
    return this.store.transaction(() => {
      const replay = this.store.db.prepare('SELECT result_json FROM life_thread_commits WHERE role_id=? AND message_id=?')
        .get(ROLE_ID, messageId.trim());
      if (replay) return parse(replay.result_json);
      const issued = this.store.db.prepare('SELECT * FROM life_thread_plans WHERE token=? AND role_id=?').get(plan.token, ROLE_ID);
      const samePlan = issued
        && issued.thread_id === plan.threadId
        && issued.beat_id === plan.beatId
        && issued.expected_version === Number(plan.expectedVersion)
        && (issued.choice_id || null) === (plan.choiceId || null);
      if (!samePlan || (issued.committed_message_id && issued.committed_message_id !== messageId.trim())) {
        throw repositoryError('生活片段选择计划无效', 400, 'INVALID_LIFE_THREAD_PLAN');
      }
      if (!this.#assistantMessage(messageId)) {
        throw repositoryError('找不到属于林晓薇的有效回复消息', 400, 'INVALID_LIFE_THREAD_MESSAGE');
      }
      const state = this.#load();
      if (!state || plan.roleId !== ROLE_ID || plan.threadId !== state.current.id || plan.beatId !== this.#resolvedBeat(state)?.id) {
        throw repositoryError('生活片段已更新，请重新处理回复', 409, 'STALE_LIFE_THREAD_PLAN');
      }
      this.#assertVersion(state, plan.expectedVersion);
      if (plan.choiceId) {
        const beat = this.#choiceSource(state);
        const choice = this.#availableChoices(state).find((item) => item.id === plan.choiceId);
        if (!choice) throw repositoryError('这个选项不属于当前生活片段', 400, 'INVALID_LIFE_THREAD_CHOICE');
        state.current.decisions[beat.id] = choice.id;
        if (!state.current.knownFacts.includes(choice.fact)) state.current.knownFacts.push(choice.fact);
        state.revision += 1;
        this.#save(state, now);
      }
      const result = this.#view(state);
      this.store.db.prepare('INSERT INTO life_thread_commits(role_id,message_id,result_json,committed_at) VALUES(?,?,?,?)')
        .run(ROLE_ID, messageId.trim(), JSON.stringify(result), now.toISOString());
      this.store.db.prepare('UPDATE life_thread_plans SET committed_message_id=? WHERE token=?')
        .run(messageId.trim(), plan.token);
      return result;
    });
  }

  context(roleId, event = null) {
    if (roleId !== ROLE_ID) return '';
    const state = this.#load();
    if (!state) return '';
    const destinationChanged = this.#destinationChanged(state, event);
    const view = this.#view(state, { paused: destinationChanged });
    if (view.status === 'paused') {
      const history = view.history.length
        ? view.history.map((item) => `${item.title}：${item.actualReply ?? item.text}`).join('；')
        : '暂无已经分享的片段。';
      return [
        '【虚构个人生活连续性｜林晓薇】',
        `旅行手册项目“${view.title}”暂时暂停。`,
        '暂停原因：检测到另一处底层旅行目的地。为避免混写地点，这条旧旅行手册在恢复前不会推进或主动发送。',
        `实际已经讲过的存档：${history}`,
        '以上只记录已经发生并发送过的虚构个人生活内容；不得补写当前活动、未发送片段或未来进展。用户当前话题优先。',
      ].join('\n').slice(0, 3600);
    }
    const lines = [
      '【虚构个人生活连续性｜林晓薇】',
      `当前个人项目：${view.title}（状态：${view.status}）`,
      `当前片段：${view.beat.title}。${view.beat.text}`,
      `当前感受：${view.beat.emotion}`,
      `当前小需要：${view.beat.need}`,
      `已经成立的事实：${view.knownFacts.join('；') || '暂无'}`,
    ];
    if (view.history.length) {
      lines.push(`实际已经讲过的片段：${view.history.map((item) => `${item.title}：${item.actualReply ?? item.text}`).join('；')}`);
    } else {
      lines.push('实际已经讲过的片段：暂无。');
    }
    if (view.choices.length) lines.push(`用户当前可明确选择：${view.choices.map((item) => `${item.id}=${item.label}`).join('；')}`);
    lines.push('以上是程序保存的虚构个人生活事实。只使用当前片段和实际历史，不预告、推测或创作后续片段；不得替用户选择。普通聊天不改变选择。');
    return lines.join('\n').slice(0, 3600);
  }
}

export const LIFE_THREAD_VERSION = bundled.version;
export const LIFE_THREAD_COOLDOWN_HOURS = COOLDOWN_HOURS;
export const defaultLifeThreads = clone(bundled);
