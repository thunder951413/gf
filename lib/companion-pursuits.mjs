import fs from 'node:fs';

const ROLE_ID = 'miyue';
const HOUR = 60 * 60 * 1000;
const STAGE_WAIT_HOURS = 36;
const REST_HOURS = 48;
const RECHECK_HOURS = 24;
const MAX_DETAIL_BYTES = 2048;
const MAX_COMPLETED = 12;
const STATE_SCHEMA_VERSION = 3;

const clone = (value) => structuredClone(value);

function asDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('clock must return a valid date');
  return date;
}

function parse(value) {
  try { return JSON.parse(value); } catch { return null; }
}

function textField(value, name, maximum, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  const result = value.normalize('NFC').trim();
  if (!result || result.length > maximum) throw new TypeError(`${name} must contain 1-${maximum} characters`);
  return result;
}

function validateItem(input, name = 'pursuit') {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError(`${name} must be an object`);
  const id = textField(input.id, `${name}.id`, 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)) throw new TypeError(`${name}.id contains unsupported characters`);
  if (!['reading', 'film', 'article'].includes(input.kind)) throw new TypeError(`${name}.kind is unsupported`);
  const title = textField(input.title, `${name}.title`, 200);
  if (!Array.isArray(input.aliases) || input.aliases.length > 12) throw new TypeError(`${name}.aliases must be an array of at most 12 strings`);
  const aliases = input.aliases.map((alias, index) => textField(alias, `${name}.aliases[${index}]`, 100));
  if (new Set(aliases).size !== aliases.length) throw new TypeError(`${name}.aliases must be unique`);
  if (!input.source || typeof input.source !== 'object' || Array.isArray(input.source)) throw new TypeError(`${name}.source is required`);
  const source = {
    title: textField(input.source.title, `${name}.source.title`, 240),
    url: textField(input.source.url, `${name}.source.url`, 2048),
    scope: textField(input.source.scope, `${name}.source.scope`, 500),
  };
  let url;
  try { url = new URL(source.url); } catch { throw new TypeError(`${name}.source.url must be a valid URL`); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError(`${name}.source.url must use HTTP or HTTPS`);
  if (!Array.isArray(input.stages) || input.stages.length !== 4) throw new TypeError(`${name}.stages must contain exactly four stages`);
  const stages = input.stages.map((stage, index) => {
    if (!stage || typeof stage !== 'object' || Array.isArray(stage)) throw new TypeError(`${name}.stages[${index}] must be an object`);
    const detail = textField(stage.detail, `${name}.stages[${index}].detail`, MAX_DETAIL_BYTES);
    if (Buffer.byteLength(detail, 'utf8') > MAX_DETAIL_BYTES) throw new TypeError(`${name}.stages[${index}].detail exceeds 2KB`);
    return {
      label: textField(stage.label, `${name}.stages[${index}].label`, 120),
      action: textField(stage.action, `${name}.stages[${index}].action`, 1000),
      detail,
    };
  });
  const origin = textField(input.origin, `${name}.origin`, 300, { optional: true });
  const residue = textField(input.residue, `${name}.residue`, 300, { optional: true });
  let weight;
  if (input.weight !== undefined) {
    if (!Number.isInteger(input.weight) || input.weight < 1 || input.weight > 10) {
      throw new TypeError(`${name}.weight must be an integer from 1 to 10`);
    }
    weight = input.weight;
  }
  let interests;
  if (input.interests !== undefined) {
    if (!Array.isArray(input.interests) || input.interests.length > 10) {
      throw new TypeError(`${name}.interests must be an array of at most 10 strings`);
    }
    interests = input.interests.map((interest, index) => textField(interest, `${name}.interests[${index}]`, 40));
  }
  let follows;
  if (input.follows !== undefined) {
    if (!Array.isArray(input.follows) || input.follows.length > 6) {
      throw new TypeError(`${name}.follows must be an array of at most 6 links`);
    }
    follows = input.follows.map((follow, index) => {
      if (!follow || typeof follow !== 'object' || Array.isArray(follow)) {
        throw new TypeError(`${name}.follows[${index}] must be an object`);
      }
      const followId = textField(follow.id, `${name}.follows[${index}].id`, 100);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(followId)) {
        throw new TypeError(`${name}.follows[${index}].id contains unsupported characters`);
      }
      return { id: followId, reason: textField(follow.reason, `${name}.follows[${index}].reason`, 300) };
    });
  }
  const category = textField(input.category, `${name}.category`, 80, { optional: true });
  const sessionNumbers = [
    ['stageWaitHours', 48, 96], ['restHours', 48, 96], ['sessionMinutes', 60, 90],
  ];
  const optionalNumbers = {};
  for (const [field, minimum, maximum] of sessionNumbers) {
    if (input[field] === undefined) continue;
    if (!Number.isInteger(input[field]) || input[field] < minimum || input[field] > maximum) {
      throw new TypeError(`${name}.${field} must be an integer from ${minimum} to ${maximum}`);
    }
    optionalNumbers[field] = input[field];
  }
  return {
    id, kind: input.kind, title, aliases, source, stages,
    ...(origin === undefined ? {} : { origin }),
    ...(residue === undefined ? {} : { residue }),
    ...(weight === undefined ? {} : { weight }),
    ...(interests === undefined ? {} : { interests }),
    ...(follows === undefined ? {} : { follows }),
    ...(category === undefined ? {} : { category }),
    ...optionalNumbers,
  };
}

function validateCatalog(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.items) || !input.items.length) {
    throw new TypeError('companion pursuit catalog must contain items');
  }
  if (input.lifePlanning !== undefined && typeof input.lifePlanning !== 'boolean') {
    throw new TypeError('companion pursuit catalog lifePlanning must be a boolean');
  }
  const items = input.items.map((item, index) => validateItem(item, `items[${index}]`));
  const ids = new Set();
  for (const item of items) {
    if (ids.has(item.id)) throw new TypeError(`duplicate companion pursuit id: ${item.id}`);
    ids.add(item.id);
  }
  for (const item of items) {
    for (const follow of item.follows ?? []) {
      if (!ids.has(follow.id)) throw new TypeError(`${item.id}.follows references unknown pursuit id: ${follow.id}`);
    }
  }
  return { items, ...(input.lifePlanning === undefined ? {} : { lifePlanning: input.lifePlanning }) };
}

function loadBundledCatalog() {
  return JSON.parse(fs.readFileSync(new URL('../app-data/companion-pursuits.json', import.meta.url), 'utf8'));
}

function normalizeMatchText(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase('zh-CN').replace(/\s+/gu, ' ').trim();
}

function clip(value, maximum) {
  const text = String(value || '').trim();
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

function weightedChoice(random, items, getWeight = () => 1) {
  const weights=items.map(entry=>{
    const adjustment=Number(getWeight(entry.item));
    return (entry.item.weight??1)*(Number.isFinite(adjustment)?Math.max(.25,Math.min(3,adjustment)):1);
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const draw = Math.max(0, Math.min(0.999999999999, Number(random()) || 0));
  let cursor = draw * total;
  for (let index=0;index<items.length;index++) {
    cursor -= weights[index];
    if (cursor < 0) return items[index];
  }
  return items.at(-1);
}

export class CompanionPursuits {
  constructor(store, { clock = () => new Date(), random = Math.random, catalog, pickArticle, getWeight = () => 1 } = {}) {
    if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('store with db and transaction is required');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    if (typeof random !== 'function') throw new TypeError('random must be a function');
    if (pickArticle !== undefined && typeof pickArticle !== 'function') throw new TypeError('pickArticle must be a function');
    this.store = store;
    this.clock = clock;
    this.random = random;
    this.catalog = validateCatalog(catalog ?? loadBundledCatalog());
    this.pickArticle = pickArticle;
    if(typeof getWeight!=='function')throw new TypeError('getWeight must be a function');
    this.getWeight=getWeight;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS companion_pursuit_state (
        role_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS companion_pursuit_deliveries (
        role_id TEXT NOT NULL,
        pursuit_id TEXT NOT NULL,
        stage_index INTEGER NOT NULL,
        pending_key TEXT NOT NULL,
        message_id TEXT NOT NULL,
        expected_version INTEGER NOT NULL,
        delivered_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY(role_id, pursuit_id, stage_index),
        UNIQUE(role_id, pending_key),
        UNIQUE(role_id, message_id)
      );
    `);
    const now = this.#now();
    store.transaction(() => {
      const row = this.store.db.prepare('SELECT state_json,revision,updated_at FROM companion_pursuit_state WHERE role_id=?').get(ROLE_ID);
      const state = row ? parse(row.state_json) : null;
      if (state && state.revision === row.revision && this.#upgradeState(state, row.updated_at)) this.#save(state, now);
    });
  }

  #now() { return asDate(this.clock()); }

  #load() {
    const row = this.store.db.prepare('SELECT state_json,revision FROM companion_pursuit_state WHERE role_id=?').get(ROLE_ID);
    const state = row ? parse(row.state_json) : null;
    if (!state || state.revision !== row.revision) return null;
    return state;
  }

  #save(state, now) {
    this.store.db.prepare(`
      INSERT INTO companion_pursuit_state(role_id,state_json,revision,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(role_id) DO UPDATE SET
        state_json=excluded.state_json,revision=excluded.revision,updated_at=excluded.updated_at
    `).run(ROLE_ID, JSON.stringify(state), state.revision, now.toISOString());
  }

  #selectItem(catalogIndex, previousItem = null) {
    const template = this.catalog.items[catalogIndex];
    // Catalog entries are authored commitments. A picker is only a fallback
    // source after a completed trajectory has run out of authored choices.
    if (template.sessionMinutes !== undefined || template.kind !== 'article' || !this.pickArticle) return clone(template);
    // Preserve the old optional picker contract for catalogs that have not
    // opted into scheduled sessions.
    const picked = this.pickArticle({ template: clone(template), previous: previousItem ? clone(previousItem) : null });
    if (picked && typeof picked.then === 'function') throw new TypeError('pickArticle must return synchronously');
    if (picked == null) return clone(template);
    const item = validateItem(picked, 'pickArticle result');
    if (item.kind !== 'article') throw new TypeError('pickArticle result must be an article');
    return item;
  }

  #freshArticle(previousItem, completedIds) {
    if (!this.pickArticle) return null;
    const catalogIndex = this.catalog.items.findIndex((item) => item.kind === 'article');
    if (catalogIndex < 0) return null;
    const picked = this.pickArticle({
      template: clone(this.catalog.items[catalogIndex]),
      previous: clone(previousItem),
    });
    if (picked && typeof picked.then === 'function') throw new TypeError('pickArticle must return synchronously');
    if (picked == null) return null;
    let item;
    try { item = validateItem(picked, 'pickArticle result'); } catch { return null; }
    if (item.kind !== 'article' || completedIds.has(item.id)) return null;
    if (previousItem?.sessionMinutes !== undefined) item = { ...item, category:item.category ?? '订阅阅读', sessionMinutes:item.sessionMinutes ?? 60, stageWaitHours:item.stageWaitHours ?? 72, restHours:item.restHours ?? 48 };
    return { item, catalogIndex };
  }

  #newState(now, catalogIndex = 0, revision = 1, previousItem = null, completed = [], selectedItem = null, completedItemIds = null) {
    const safeIndex = ((catalogIndex % this.catalog.items.length) + this.catalog.items.length) % this.catalog.items.length;
    return {
      schemaVersion: STATE_SCHEMA_VERSION,
      revision,
      catalogIndex: safeIndex,
      item: selectedItem ? clone(selectedItem) : this.#selectItem(safeIndex, previousItem),
      stageIndex: 0,
      stageDelivered: false,
      status: 'active',
      startedAt: now.toISOString(),
      stageStartedAt: now.toISOString(),
      nextAt: selectedItem?.sessionMinutes !== undefined || this.catalog.items[safeIndex].sessionMinutes !== undefined ? null : new Date(now.getTime() + STAGE_WAIT_HOURS * HOUR).toISOString(),
      sessionMode: (selectedItem?.sessionMinutes ?? this.catalog.items[safeIndex].sessionMinutes) !== undefined,
      session: null,
      lastSessionDate: null,
      history: [],
      completed: clone(completed).slice(-MAX_COMPLETED),
      completedItemIds: clone(completedItemIds ?? [...new Set(completed.map((item) => item.id))]),
    };
  }

  #completionSnapshot(state, occurredAt) {
    const stage = state.item.stages.at(-1);
    return {
      id: state.item.id,
      kind: state.item.kind,
      title: state.item.title,
      aliases: clone(state.item.aliases),
      origin: state.item.origin ?? '',
      residue: state.item.residue ?? '',
      source: clone(state.item.source),
      startedAt: state.startedAt,
      completedAt: occurredAt,
      lastAction: stage.action,
      completion: {
        occurredAt,
        label: stage.label,
        action: stage.action,
        detail: stage.detail,
      },
    };
  }

  #recordCompletion(state, occurredAt) {
    const existing = (state.completed ?? []).find((item) => item.id === state.item.id && item.completedAt === occurredAt);
    state.completedItemIds = [...new Set([...(state.completedItemIds ?? []), state.item.id])];
    if (existing) return;
    state.completed = [...(state.completed ?? []), this.#completionSnapshot(state, occurredAt)].slice(-MAX_COMPLETED);
  }

  #upgradeState(state, updatedAt) {
    let changed = this.#upgradeCurrentMetadata(state);
    if (state.schemaVersion === STATE_SCHEMA_VERSION) {
      if (!Array.isArray(state.completedItemIds)) {
        state.completedItemIds = [...this.#completedIds(state)];
        if (!changed) state.revision += 1;
        changed = true;
      }
      // Existing trajectories retain their original clock semantics.  Adding
      // session metadata to a catalog must not fast-forward a persisted item.
      if (state.sessionMode === undefined) {
        const configured = state.item?.sessionMinutes !== undefined;
        state.sessionMode = configured;
        const reached = state.stageDelivered || (state.history ?? []).some((entry) => entry.index === state.stageIndex);
        state.session ??= configured && reached ? {
          status: 'ended', startedAt: state.stageStartedAt ?? updatedAt, endedAt: updatedAt,
        } : null;
        state.lastSessionDate ??= null;
        if (configured && state.status === 'active') {
          // Do not reinterpret elapsed wall-clock time as dozens of unseen
          // reading sessions when a catalog is upgraded in place.
          state.stageStartedAt = null;
          state.nextAt = null;
        }
        state.revision += 1;
        changed = true;
      }
      return changed;
    }
    const persistedAt = Number.isFinite(Date.parse(updatedAt)) ? new Date(updatedAt) : this.#now();
    const nextAt = Number.isFinite(Date.parse(state.nextAt)) ? new Date(state.nextAt) : null;
    const legacyFinal = state.stageIndex === state.item.stages.length - 1;
    const wasResting = state.status === 'resting';
    if (!Number.isFinite(Date.parse(state.stageStartedAt))) {
      const waitHours = state.status === 'resting' ? REST_HOURS : STAGE_WAIT_HOURS;
      state.stageStartedAt = new Date(nextAt ? nextAt.getTime() - waitHours * HOUR : persistedAt.getTime()).toISOString();
    }
    if (legacyFinal && state.status === 'active') state.status = 'resting';
    if (!nextAt) {
      const waitHours = state.status === 'resting' ? REST_HOURS : STAGE_WAIT_HOURS;
      state.nextAt = new Date(Date.parse(state.stageStartedAt) + waitHours * HOUR).toISOString();
    }
    if (state.status === 'resting') {
      const matchingCompletion = wasResting ? [...(state.completed ?? [])].reverse().find((item) => item.id === state.item.id
        && (!item.startedAt || item.startedAt === state.startedAt)) : null;
      const occurredAt = matchingCompletion?.completedAt ?? state.stageStartedAt;
      this.#recordCompletion(state, occurredAt);
      const completed = [...(state.completed ?? [])].reverse().find((item) => item.id === state.item.id && item.completedAt === occurredAt);
      if (completed) {
        completed.startedAt ??= state.startedAt;
        completed.completion ??= this.#completionSnapshot(state, occurredAt).completion;
      }
    }
    state.completedItemIds = [...this.#completedIds(state)];
    state.schemaVersion = STATE_SCHEMA_VERSION;
    state.sessionMode = state.item?.sessionMinutes !== undefined;
    const reached = state.stageDelivered || (state.history ?? []).some((entry) => entry.index === state.stageIndex);
    state.session ??= state.sessionMode && reached ? {
      status: 'ended', startedAt: state.stageStartedAt ?? persistedAt.toISOString(), endedAt: persistedAt.toISOString(),
    } : null;
    state.lastSessionDate ??= null;
    if (state.sessionMode && state.status === 'active') {
      state.stageStartedAt = null;
      state.nextAt = null;
    }
    if (!changed) state.revision += 1;
    changed = true;
    return changed;
  }

  #upgradeCurrentMetadata(state) {
    const template = this.catalog.items.find((item) => item.id === state.item?.id);
    if (!template) return false;
    let changed = false;
    for (const field of ['origin', 'interests']) {
      const isFollowOrigin = field === 'origin' && this.catalog.items.some((item) => item.follows?.some((follow) => (
        follow.id === state.item.id && follow.reason === state.item.origin
      )));
      if (template[field] !== undefined && JSON.stringify(state.item[field]) !== JSON.stringify(template[field])) {
        if (isFollowOrigin) continue;
        state.item[field] = clone(template[field]);
        changed = true;
      }
    }
    for (const field of ['residue', 'follows', 'category', 'stageWaitHours', 'restHours', 'sessionMinutes']) {
      if (state.item[field] === undefined && template[field] !== undefined) {
        state.item[field] = clone(template[field]);
        changed = true;
      }
    }
    if (changed) state.revision += 1;
    return changed;
  }

  #completedIds(state) {
    const ids = new Set([...(state.completedItemIds ?? []), ...(state.completed ?? []).map((item) => item.id)]);
    const rows = this.store.db.prepare(`
      SELECT pursuit_id FROM companion_pursuit_deliveries
      WHERE role_id=? AND stage_index=3
    `).all(ROLE_ID);
    for (const row of rows) {
      const separator = row.pursuit_id.indexOf(':');
      if (separator > 0) ids.add(row.pursuit_id.slice(0, separator));
    }
    return ids;
  }

  #pendingKey(state) {
    const shareable = state.status === 'active'
      || (state.status === 'resting' && state.stageIndex === state.item.stages.length - 1);
    return shareable && !state.stageDelivered && !state.shareExpired
      && (!state.sessionMode || ['active', 'ended', 'interrupted'].includes(state.session?.status))
      ? `companion-pursuit:${ROLE_ID}:${state.item.id}:${state.startedAt}:${state.stageIndex}`
      : null;
  }

  #view(state) {
    if (!state?.item) return null;
    const stage = state.item.stages[state.stageIndex];
    return {
      id: state.item.id,
      title: state.item.title,
      kind: state.item.kind,
      aliases: clone(state.item.aliases),
      source: clone(state.item.source),
      ...(state.item.origin === undefined ? {} : { origin: state.item.origin }),
      ...(state.item.interests === undefined ? {} : { interests: clone(state.item.interests) }),
      ...(state.item.category === undefined ? {} : { category: state.item.category }),
      ...(state.status === 'resting' && state.item.residue !== undefined ? { residue: state.item.residue } : {}),
      stage: { index: state.stageIndex, label: stage.label, action: stage.action, detail: stage.detail },
      ...(!state.lastMentionedAt || this.#now().getTime()-Date.parse(state.lastMentionedAt)>=24*HOUR ? (this.#pendingKey(state) ? {pendingKey:this.#pendingKey(state)} : {}) : {}),
      ...(state.retiredAt ? {retired:true} : {}),
      version: state.revision,
      status: state.status,
      stageStartedAt: state.stageStartedAt,
      nextAt: state.nextAt,
      history: clone(state.history),
      completed: clone(state.completed ?? []),
      startedAt: state.startedAt,
      ...(state.sessionMode ? { session: clone(state.session) } : {}),
      hasStarted: state.sessionMode ? Boolean(state.session?.startedAt) : true,
      readable: !state.retiredAt && (state.sessionMode ? Boolean(state.session?.startedAt) : true),
    };
  }

  #assistantMessage(messageId) {
    const id = typeof messageId === 'string' ? messageId.trim() : '';
    if (!id) return null;
    try {
      const message = typeof this.store.getMessage === 'function'
        ? this.store.getMessage(id)
        : this.store.db.prepare('SELECT id,role,speaker,text FROM messages WHERE id=?').get(id);
      return message?.role === ROLE_ID && message.speaker === 'assistant' && typeof message.text === 'string' ? message : null;
    } catch { return null; }
  }

  get(roleId) {
    if (roleId !== ROLE_ID) return null;
    const now = this.#now();
    return this.store.transaction(() => {
      let state = this.#load();
      if (!state) {
        state = this.#newState(now);
        this.#save(state, now);
      }
      return this.#view(state);
    });
  }

  #startNext(state, now) {
    if (this.catalog.lifePlanning === true) {
      const completedIds = this.#completedIds(state);
      let candidates = this.catalog.items
        .map((item, catalogIndex) => ({ item, catalogIndex }))
        .filter((entry) => !completedIds.has(entry.item.id));
      const priorCategory = state.item.category;
      const alternatives = candidates.filter((entry) => entry.item.category && entry.item.category !== priorCategory);
      if (priorCategory && alternatives.length) candidates = alternatives;
      if (candidates.length) {
        const selected = weightedChoice(this.random, candidates, this.getWeight);
        return this.#newState(now, selected.catalogIndex, state.revision, state.item, state.completed ?? [], selected.item, state.completedItemIds);
      }
      const fresh = this.#freshArticle(state.item, completedIds);
      if (fresh) return this.#newState(now, fresh.catalogIndex, state.revision, state.item, state.completed ?? [], fresh.item, state.completedItemIds);
    } else if (state.item.follows !== undefined) {
      const completedIds = this.#completedIds(state);
      const linked = state.item.follows.find((follow) => !completedIds.has(follow.id));
      if (linked) {
        const catalogIndex = this.catalog.items.findIndex((item) => item.id === linked.id);
        const selected = { ...clone(this.catalog.items[catalogIndex]), origin: linked.reason };
        return this.#newState(now, catalogIndex, state.revision, state.item, state.completed ?? [], selected, state.completedItemIds);
      }
      const fresh = this.#freshArticle(state.item, completedIds);
      if (fresh) return this.#newState(now, fresh.catalogIndex, state.revision, state.item, state.completed ?? [], fresh.item, state.completedItemIds);
    } else {
      return this.#newState(now, state.catalogIndex + 1, state.revision, state.item, state.completed ?? [], null, state.completedItemIds);
    }
    state.nextAt = new Date(now.getTime() + RECHECK_HOURS * HOUR).toISOString();
    return state;
  }

  #advanceTo(state, now) {
    if (state.sessionMode) {
      let changed = false;
      const session = state.session;
      if (session?.status === 'active' && now.getTime() >= Date.parse(session.endsAt)) {
        const endedAt = session.endsAt;
        session.status = 'ended'; session.endedAt = endedAt;
        state.lastSessionDate = session.date;
        // Ending a session does not revoke a delivery from that same stage.
        if (state.stageIndex === state.item.stages.length - 1) {
          state.status = 'resting';
          state.stageStartedAt = session.startedAt;
          state.nextAt = new Date(Date.parse(endedAt) + (state.item.restHours ?? REST_HOURS) * HOUR).toISOString();
          this.#recordCompletion(state, endedAt);
        } else {
          state.nextAt = new Date(Date.parse(session.startedAt) + (state.item.stageWaitHours ?? STAGE_WAIT_HOURS) * HOUR).toISOString();
        }
        changed = true;
      }
      if (state.status === 'resting' && state.nextAt && now.getTime() >= Date.parse(state.nextAt)) {
        state.shareExpired = true;
        state = this.#startNext(state, now);
        changed = true;
      }
      if (changed) state.revision += 1;
      return { state, changed };
    }
    let changed = false;
    while (state.status === 'active' && state.nextAt && now.getTime() >= Date.parse(state.nextAt)) {
      const occurredAt = state.nextAt;
      state.stageIndex += 1;
      state.stageDelivered = false;
      state.stageStartedAt = occurredAt;
      changed = true;
      if (state.stageIndex === state.item.stages.length - 1) {
        state.status = 'resting';
        state.nextAt = new Date(Date.parse(occurredAt) + REST_HOURS * HOUR).toISOString();
        this.#recordCompletion(state, occurredAt);
        break;
      }
      state.nextAt = new Date(Date.parse(occurredAt) + STAGE_WAIT_HOURS * HOUR).toISOString();
    }
    if (state.status === 'resting' && state.nextAt && now.getTime() >= Date.parse(state.nextAt)) {
      // A lack of new material can postpone the next activity, but must not
      // keep an old final-stage notification alive through every recheck.
      state.shareExpired = true;
      state = this.#startNext(state, now);
      changed = true;
    }
    if (changed) state.revision += 1;
    return { state, changed };
  }

  tick(roleId) {
    if (roleId !== ROLE_ID) return null;
    const now = this.#now();
    return this.store.transaction(() => {
      let state = this.#load();
      if (!state) return null;
      const advanced = this.#advanceTo(state, now);
      state = advanced.state;
      if (advanced.changed) this.#save(state, now);
      return this.#view(state);
    });
  }

  #shanghaiDate(now) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const part = (type) => parts.find((entry) => entry.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  }

  #remainingMinutes(current, now) {
    if (Number.isFinite(current?.remainingMinutes)) return current.remainingMinutes;
    if (Number.isFinite(current?.remainingMs)) return current.remainingMs / 60000;
    if (current?.endsAt && Number.isFinite(Date.parse(current.endsAt))) return (Date.parse(current.endsAt) - now.getTime()) / 60000;
    return 0;
  }

  prepareSession({ current, travel = false, scheduled = false, enabled = true } = {}) {
    const now = this.#now();
    return this.store.transaction(() => {
      let state = this.#load();
      if (!state) return null;
      let advanced = this.#advanceTo(state, now); state = advanced.state;
      let changed = advanced.changed;
      if (!state.sessionMode) {
        if (changed) this.#save(state, now);
        return this.#view(state);
      }
      const allowed = ['reading', 'home', 'cafe', 'rest', 'music'].includes(current?.kind);
      const blocked = !enabled || travel || scheduled || !allowed;
      if (state.session?.status === 'active' && blocked) {
        state.session.status = 'interrupted';
        state.session.interruptedAt = now.toISOString();
        state.lastSessionDate = state.session.date;
        changed = true;
      }
      const date = this.#shanghaiDate(now);
      const ready = !state.nextAt || now.getTime() >= Date.parse(state.nextAt);
      const noSessionToday = state.lastSessionDate !== date && state.session?.date !== date;
      const duration = state.item.sessionMinutes;
      if (state.status === 'active' && !blocked && ready && noSessionToday && this.#remainingMinutes(current, now) >= duration) {
        if (state.session?.status === 'ended') {
          // Keep the reached stage readable between sessions.  The next
          // stage becomes current only when its own real session starts.
          state.stageIndex += 1;
          state.stageDelivered = false;
        }
        state.session = { status: 'active', date, startedAt: now.toISOString(), endsAt: new Date(now.getTime() + duration * 60000).toISOString(), minutes: duration };
        state.stageStartedAt = now.toISOString();
        state.nextAt = state.session.endsAt;
        changed = true;
      }
      if (changed) { state.revision += 1; this.#save(state, now); }
      return this.#view(state);
    });
  }

  pending(roleId) {
    if (roleId !== ROLE_ID) return null;
    const state = this.#load();
    if (!state) return null;
    const view = this.#view(state);
    return view.pendingKey ? view : null;
  }

  markDelivered(key, messageId, expectedVersion, delivery = null) {
    if (typeof key !== 'string' || !key || typeof messageId !== 'string' || !messageId.trim()
        || !Number.isSafeInteger(expectedVersion)) return false;
    const id = messageId.trim();
    const now = this.#now();
    return this.store.transaction(() => {
      const replay = this.store.db.prepare(`
        SELECT 1 FROM companion_pursuit_deliveries
        WHERE role_id=? AND pending_key=? AND message_id=? AND expected_version=?
      `).get(ROLE_ID, key, id, expectedVersion);
      if (replay) return true;
      let state = this.#load();
      if (state) {
        const advanced = this.#advanceTo(state, now);
        state = advanced.state;
        if (advanced.changed) this.#save(state, now);
      }
      if (!state || state.revision !== expectedVersion || key !== this.#pendingKey(state)) return false;
      const stage = state.item.stages[state.stageIndex];
      const message = this.#assistantMessage(id);
      const exposure = delivery?.mode === 'material_exposure';
      if (!message || !message.text.trim()) return false;
      if (exposure && Number(delivery.expectedVersion) !== expectedVersion) return false;
      if (exposure && delivery.key !== key) return false;
      if (!exposure && !message.text.includes(stage.action)) return false;
      const receipt = {
        index: state.stageIndex,
        label: stage.label,
        ...(exposure ? { selectedAction: stage.action, actualReply: message.text, delivery: 'material_exposure' } : { action: stage.action }),
        detail: stage.detail,
        source: clone(state.item.source),
        messageId: id,
        deliveredAt: now.toISOString(),
        ...(state.stageIndex === state.item.stages.length - 1 ? {
          title: state.item.title,
          aliases: clone(state.item.aliases),
          ...(state.item.origin === undefined ? {} : { origin: state.item.origin }),
          ...(state.item.residue === undefined ? {} : { residue: state.item.residue }),
        } : {}),
      };
      try {
        this.store.db.prepare(`
          INSERT INTO companion_pursuit_deliveries
            (role_id,pursuit_id,stage_index,pending_key,message_id,expected_version,delivered_at,payload_json)
          VALUES(?,?,?,?,?,?,?,?)
        `).run(ROLE_ID, `${state.item.id}:${state.startedAt}`, state.stageIndex, key, id, expectedVersion, receipt.deliveredAt, JSON.stringify(receipt));
      } catch (error) {
        if (/UNIQUE|constraint/iu.test(String(error?.message))) return false;
        throw error;
      }
      state.stageDelivered = true;
      state.history.push(receipt);
      state.revision += 1;
      this.#save(state, now);
      return true;
    });
  }

  // A topic mentioned in an ordinary answer also counts as conversational
  // exposure. It suppresses invitations, without claiming a reading stage is done.
  noteConversation(roleId, messageId, fullText = null) {
    if (roleId !== ROLE_ID) return false;
    const message = this.#assistantMessage(messageId);
    if (!message) return false;
    const state = this.#load();
    if (!state || state.retiredAt || state.lastMentionMessageId === messageId) return false;
    const text = normalizeMatchText(fullText ?? message.text);
    const names = [state.item.title, ...state.item.aliases].map(normalizeMatchText).filter(name=>name.length>=3);
    if (!names.some(name=>text.includes(name))) return false;
    state.lastMentionedAt = this.#now().toISOString();
    state.lastMentionMessageId = messageId;
    state.revision += 1;
    this.#save(state,this.#now());
    return true;
  }

  // Put away an activity without pretending its remaining stages were read.
  // Retired items remain available to explicit historical questions, not selection.
  retire(roleId, {expectedId, reason='暂时收起这个话题'} = {}) {
    if (roleId !== ROLE_ID || typeof expectedId !== 'string') return false;
    return this.store.transaction(()=>{
      let state=this.#load();
      if (!state || state.item.id!==expectedId || state.retiredAt) return false;
      const now=this.#now(), stage=state.item.stages[state.stageIndex];
      const retired={id:state.item.id,kind:state.item.kind,title:state.item.title,aliases:clone(state.item.aliases),source:clone(state.item.source),startedAt:state.startedAt,retiredAt:now.toISOString(),retired:true,reason,lastAction:state.sessionMode&&!state.session?.startedAt?'尚未开始':stage.action,detail:state.sessionMode&&!state.session?.startedAt?'':stage.detail};
      state.completed=[...(state.completed??[]),retired].slice(-MAX_COMPLETED);
      state.completedItemIds=[...new Set([...(state.completedItemIds??[]),state.item.id])];
      state.retiredAt=now.toISOString();state.shareExpired=true;state.status='resting';
      if(state.session?.status==='active')state.session={...state.session,status:'interrupted',interruptedAt:now.toISOString()};
      state.nextAt=now.toISOString();state.revision+=1;
      state=this.#startNext(state,now);
      this.#save(state,now);
      return this.#view(state);
    });
  }

  invitationContext(roleId) {
    if(roleId!==ROLE_ID)return '';
    const retired=(this.#load()?.completed??[]).filter(item=>item.retired).slice(-4);
    return retired.length?'【已收起的主动话题】'+JSON.stringify(retired.map(item=>({title:item.title,reason:item.reason})))+'。这些话题已经聊过很多，不再作为新鲜事、类比或阅读近况主动带起。此次从其他生活或内容发起；用户明确追问这些旧话题时仍可回答。':'';
  }

  #matchedCompleted(state, text) {
    const input = normalizeMatchText(text);
    if (!input) return null;
    return [...(state.completed ?? [])].reverse().find((item) => [item.title, ...(item.aliases ?? [])]
      .map(normalizeMatchText).filter((name) => name.length >= 2).some((name) => input.includes(name))) ?? null;
  }

  #completedReceipt(completed) {
    const rows = this.store.db.prepare(`
      SELECT pursuit_id,payload_json FROM companion_pursuit_deliveries
      WHERE role_id=? AND stage_index=3 ORDER BY delivered_at DESC
    `).all(ROLE_ID);
    for (const row of rows) {
      if (completed.startedAt ? row.pursuit_id !== `${completed.id}:${completed.startedAt}` : !row.pursuit_id.startsWith(`${completed.id}:`)) continue;
      const receipt = parse(row.payload_json);
      if (receipt) return receipt;
    }
    return null;
  }

  context(roleId, { detailed = false, text = '' } = {}) {
    if (roleId !== ROLE_ID) return '';
    const state = this.#load();
    if (!state) return '';
    const view = this.#view(state);
    const matched = this.#matchedCompleted(state, text);
    if (matched?.retired) return ['【已收起的阅读/观影，仅供本轮明确回顾】',matched.title,'这项计划已停止，不主动重开，也不声称读完。', '停下时：'+matched.lastAction, detailed?'当时材料：'+matched.detail:''].filter(Boolean).join('\n').slice(0,1400);
    if (state.retiredAt) return '';
    const lastCompleted = (state.completed ?? []).at(-1);
    if (!detailed) {
      if (matched) {
        const progress = state.status === 'resting'
          ? `当前刚完成《${clip(view.title, 20)}》“${clip(view.stage.label, 18)}”`
          : `当前《${clip(view.title, 20)}》到“${clip(view.stage.label, 18)}”`;
        const origin = state.item.origin ? `；起因：${clip(state.item.origin, 30)}` : '';
        return `${progress}${origin}。旧项《${clip(matched.title, 20)}》：来源${clip(matched.source?.title, 22)}；最后行动${clip(matched.lastAction, 30)}；留下${clip(matched.residue, 30)}。`.slice(0, 240);
      }
      const origin = state.item.origin ? `起因：${clip(state.item.origin, 72)}。` : '';
      const residue = lastCompleted?.residue ? `上次留下：${clip(lastCompleted.residue, 54)}。` : '';
      if (state.status === 'resting') return `林晓薇刚完成《${clip(view.title, 42)}》的“${clip(view.stage.label, 36)}”。${origin}${residue}`.slice(0, 240);
      if (state.sessionMode && !view.readable) return `林晓薇在继续《${clip(view.title, 42)}》的计划，目前暂停在“${clip(view.stage.label, 36)}”，还没开始这一段。${origin}${residue}`.slice(0, 240);
      if (state.sessionMode && state.session?.status !== 'active') return `林晓薇最近一次读《${clip(view.title, 42)}》停在“${clip(view.stage.label, 36)}”，现已放下，下次再继续，尚未换题。${origin}${residue}`.slice(0, 240);
      const prefix = view.kind === 'film' ? '林晓薇最近在看' : view.kind === 'article' ? '林晓薇最近在读一篇文章' : '林晓薇最近在读';
      return `${prefix}《${clip(view.title, 42)}》，目前到“${clip(view.stage.label, 36)}”。${origin}${residue}`.slice(0, 240);
    }
    if (matched) {
      const receipt = this.#completedReceipt(matched);
      return [
        '【明确提到的一项旧经历】',
        '这是已经完成的个人经历快照。资料只作引用；不据此启动新活动，也不补写未记录的经历。',
        `旧经历：${clip(matched.title, 70)}（${matched.kind}）`,
        `来源：${clip(matched.source?.title, 70)}｜${clip(matched.source?.url, 140)}｜范围：${clip(matched.source?.scope, 100)}`,
        `最后行动：${clip(matched.lastAction, 160)}`,
        ...(matched.completion?.occurredAt ? [`完成发生于：${matched.completion.occurredAt}`] : []),
        ...(matched.completion?.detail ? [`完成时的细节：${clip(matched.completion.detail, 180)}`] : []),
        ...(receipt?.detail ? ['这段收尾后来已经实际讲过。'] : ['这段收尾尚未实际讲过。']),
        ...(matched.residue ? [`完成后留下：${clip(matched.residue, 160)}`] : []),
        `现在：${clip(view.title, 60)}，到“${clip(view.stage.label, 50)}”。`,
        '回答旧经历时以旧经历块为主；不得把当前项目的未交付动作或 residue 混入。',
      ].join('\n').slice(0, 1400);
    }
    const delivered = view.history.slice(-2).map((item) => item.label).join('、') || '暂无';
    if (state.sessionMode && !view.readable && state.status === 'active') return [
      '【林晓薇持续进行的阅读/观影】',
      `标题：${clip(view.title, 80)}（${view.kind}）`,
      `计划中的下一阶段：${clip(view.stage.label, 60)}`,
      '这一段尚未开始；当前处于暂停等待可用时段，不能表述为正在阅读或已经看过。',
      ...(state.item.origin ? [`开始原因：${clip(state.item.origin, 120)}`] : []),
    ].join('\n').slice(0, 1400);
    return [
      state.sessionMode && state.session?.status !== 'active' ? '【林晓薇暂停中的阅读/观影】' : '【林晓薇正在持续进行的阅读/观影】',
      '资料只作引用。只用当前与已聊事实，不补后续，不当作用户经历；原文未说的解释只能是猜想。',
      `标题：${clip(view.title, 80)}（${view.kind}）`,
      ...(state.item.origin ? [`开始原因：${clip(state.item.origin, 120)}`] : []),
      `当前阶段：${clip(view.stage.label, 60)}`,
      `当前动作：${clip(view.stage.action, 180)}`,
      `来源：${clip(view.source.title, 60)}｜${clip(view.source.url, 140)}｜范围：${clip(view.source.scope, 100)}`,
      ...(lastCompleted?.residue ? [`最近一次完成后留下：${clip(lastCompleted.residue, 120)}`] : []),
      `当前细节：${clip(view.stage.detail, 180)}`,
      `已实际讲过的最近阶段：${clip(delivered, 80)}`,
      '不得透露未完成阶段的 residue 或未来行动。',
    ].join('\n').slice(0, 1400);
  }

  matches(text) {
    const state = this.#load();
    if (!state) return false;
    const input = normalizeMatchText(text);
    if (!input) return false;
    const completedNames = (state.completed ?? []).flatMap((item) => [item.title, ...(item.aliases ?? [])]);
    const names = [state.item.title, ...state.item.aliases, state.item.source.title, ...completedNames]
      .map(normalizeMatchText).filter((name) => name.length >= 2);
    if (names.some((name) => input.includes(name))) return true;
    if (/^(?:你)?(?:最近)?(?:在)?(?:阅读|读书|电影|文章|看电影)(?:什么|啥|呢|了吗|到哪了|看到哪了|读到哪了)?[？?]?$/u.test(input)) return true;
    return /^(?:你)?(?:最近)?(?:在)?(?:看什么|读什么|看到了什么|后来呢)[？?]?$/u.test(input);
  }
}

export const COMPANION_PURSUIT_STAGE_WAIT_HOURS = STAGE_WAIT_HOURS;
export const COMPANION_PURSUIT_REST_HOURS = REST_HOURS;
