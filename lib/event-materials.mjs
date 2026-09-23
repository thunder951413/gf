import { createHash } from 'node:crypto';

const MAX_LIMIT = 3;
const invalid = message => Object.assign(new Error(message), { code: 'INVALID_EVENT_MATERIAL' });
const VOLATILE_FIELD = /(?:^|_)(?:updated|created|observed|presented|started|ended|expires?|next|last|clock)(?:_?at|_?time)?$|(?:^|_)(?:count|counter|revision|version|index|sequence|seq)$/i;
const volatile = key => VOLATILE_FIELD.test(key) || /(?:At|Time|Count|Counter|Revision|Version|Index|Sequence|Seq)$/.test(key);

function stable(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return `[${value.map(item => stable(item, seen)).join(',')}]`;
  if (typeof value !== 'object') return 'null';
  if (seen.has(value)) return '"[circular]"';
  seen.add(value);
  const encoded = Object.keys(value).sort().filter(key => !volatile(key) && value[key] !== undefined && typeof value[key] !== 'function')
    .map(key => `${JSON.stringify(key)}:${stable(value[key], seen)}`).join(',');
  seen.delete(value);
  return `{${encoded}}`;
}

function phaseOf(event) {
  const phase = typeof event?.phase === 'string' ? event.phase : event?.phase?.id;
  return typeof phase === 'string' && phase ? phase : null;
}

function identityOf(event) {
  const id = typeof event?.id === 'string' ? event.id.trim() : '';
  const startedAt = event?.instanceStartedAt || event?.startedAt;
  return id && typeof startedAt === 'string' && startedAt ? { id, startedAt } : null;
}

function sourceKeyOf(event) {
  const identity = identityOf(event);
  return identity ? `${identity.id}:${identity.startedAt}` : null;
}

const COMPLETION_PHASES = new Set(['arrived', 'home']);
const PASSIVE_PHASES = new Set(['paused', 'recent']);

function contentProjection(event) {
  const choice = event?.choice && typeof event.choice === 'object' ? event.choice : null;
  const phase = event?.phase && typeof event.phase === 'object' ? event.phase : null;
  // This is deliberately an allow-list. Scheduler state (foreground, due,
  // priority, weights, and polling status) is not a new conversational fact.
  return {
    kind: event?.kind, type: event?.type, category: event?.category,
    title: event?.title, detail: event?.detail, summary: event?.summary,
    description: event?.description, location: event?.location, activity: event?.activity,
    participants: event?.participants, people: event?.people,
    source: event?.source, facts: event?.facts,
    result: event?.result, outcome: event?.outcome, evidence: event?.evidence,
    choice: choice && { value: choice.value, selected: choice.selected, adopted: choice.adopted, result: choice.result, evidence: choice.evidence },
    // Keep phase facts, but exclude its id and display label: those are
    // lifecycle bookkeeping and must not by themselves make a new material.
    phase: phase && {
      title: phase.title, detail: phase.detail, location: phase.location,
      activity: phase.activity, feeling: phase.feeling, wish: phase.wish,
      result: phase.result, outcome: phase.outcome, evidence: phase.evidence,
      choice: phase.choice
    }
  };
}

function materialProjection(event) {
  const projection = contentProjection(event);
  // A lifecycle label is not itself a fresh thing to tell the user. Arrival
  // and homecoming are exceptions: they are factual completions even when the
  // rendered detail happens to stay the same.
  const phase = phaseOf(event);
  return COMPLETION_PHASES.has(phase) ? { ...projection, completion: phase } : projection;
}

// “Presented” means only that optional context was supplied to a saved reply.
// It is neither proof that the reply used the material nor a claim about an event fact.
export class EventMaterials {
  constructor(store, { clock = () => new Date() } = {}) {
    this.store = store;
    this.clock = clock;
    // The original table is retained. New v2 keys coexist with old rows, and
    // lookup of old rows conservatively prevents upgrade-time replay. Old rows
    // lack a content fingerprint, so they cannot distinguish a later revision;
    // an explicit follow-up can seed its v2 exposure without a blind migration.
    store.db.exec(`CREATE TABLE IF NOT EXISTS companion_event_materials (
      event_key TEXT PRIMARY KEY, last_presented_at TEXT NOT NULL, message_id TEXT NOT NULL
    )`);
    store.db.exec(`CREATE TABLE IF NOT EXISTS companion_event_material_exposures (
      source_key TEXT NOT NULL,
      material_key TEXT NOT NULL,
      phase TEXT,
      last_presented_at TEXT NOT NULL,
      message_id TEXT NOT NULL,
      PRIMARY KEY(source_key, material_key)
    )`);
  }

  legacyKey(event) {
    const identity = identityOf(event), phase = phaseOf(event);
    return identity && phase ? `${identity.id}:${identity.startedAt}:${phase}` : null;
  }

  key(event) {
    const legacy = this.legacyKey(event);
    if (!legacy) return null;
    return `v2:${legacy}:${createHash('sha256').update(stable(materialProjection(event))).digest('hex')}`;
  }

  sourceKey(event) { return sourceKeyOf(event); }

  materialKey(event) {
    return this.sourceKey(event) ? createHash('sha256').update(stable(materialProjection(event))).digest('hex') : null;
  }

  #legacyExposure(sourceKey) {
    if (!sourceKey) return false;
    const legacyPrefix = `${sourceKey}:`, v2Prefix = `v2:${sourceKey}:`;
    // Primary-key ranges avoid walking every retained legacy row for each
    // candidate while still treating unknown historical keys conservatively.
    return Boolean(this.store.db.prepare(`SELECT 1 FROM companion_event_materials
      WHERE event_key=? OR (event_key>=? AND event_key<?) OR (event_key>=? AND event_key<?) LIMIT 1`)
      .get(sourceKey, legacyPrefix, `${legacyPrefix}\uffff`, v2Prefix, `${v2Prefix}\uffff`));
  }

  #exposures(sourceKey) {
    return sourceKey ? this.store.db.prepare('SELECT source_key,material_key,phase,last_presented_at,message_id FROM companion_event_material_exposures WHERE source_key=? ORDER BY last_presented_at DESC, rowid DESC').all(sourceKey) : [];
  }

  #isOpportunity(event, sourceKey, materialKey) {
    const exposures = this.#exposures(sourceKey);
    if (!exposures.length) return !this.#legacyExposure(sourceKey);
    if (exposures.some(exposure => exposure.material_key === materialKey)) return false;
    const phase = phaseOf(event);
    if (PASSIVE_PHASES.has(phase)) return false;
    if (COMPLETION_PHASES.has(phase)) return true;
    // A changed active item (including a settled choice) remains useful. A
    // transition alone is never enough because phase is absent from its key.
    return true;
  }

  select(events, { limit = 1, explicit = false } = {}) {
    if (!Array.isArray(events)) throw invalid('Events must be an array');
    const count = Math.max(1, Math.min(MAX_LIMIT, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 1));
    return events.map((event, index) => ({ event, index, key: this.key(event), sourceKey: this.sourceKey(event), materialKey: this.materialKey(event) }))
      .filter(item => item.key && item.sourceKey && item.materialKey)
      .map(item => ({ ...item, available: this.#isOpportunity(item.event, item.sourceKey, item.materialKey) }))
      .filter(item => explicit || item.available)
      .sort((left, right) => Number(right.available) - Number(left.available) || left.index - right.index)
      .slice(0, count).map(item => item.event);
  }

  describe(event, { projectSource, reviewing = false } = {}) {
    const sourceKey = this.sourceKey(event);
    const exposure = this.#exposures(sourceKey)[0];
    if (!exposure) return '';
    const message = this.store.getMessage?.(exposure.message_id) || this.store.db.prepare('SELECT id,text FROM messages WHERE id=?').get(exposure.message_id);
    const visible = typeof projectSource === 'function' ? projectSource(message) : message;
    if (!visible) return '';
    const reply = typeof visible.text === 'string' ? visible.text.replace(/\s+/g, ' ').trim().slice(0, 360) : '';
    const phase = exposure.phase ? `此前阶段：“${exposure.phase}”` : '此前已提供过材料';
    return `【同一生活片段曾供回复参考】${phase}；该材料曾在生成一条保存回复时提供。${reply ? `保存的实际回复：“${reply}”。` : ''}这不表示回复一定使用了材料；${reviewing?'按用户追问回顾或补充具体细节，不把旧事说成刚发生。':'这次只补充新的变化，不要从头介绍。'}`;
  }

  context(event, options) { return this.describe(event, options); }

  record(events, messageId) {
    if (!Array.isArray(events) || typeof messageId !== 'string' || !messageId) throw invalid('Invalid presentation record');
    const message = this.store.getMessage?.(messageId) || this.store.db.prepare('SELECT id,role,speaker,kind FROM messages WHERE id=?').get(messageId);
    if (!message || message.role !== 'miyue' || message.speaker !== 'assistant' || message.kind === 'story') throw invalid('Presentation requires a saved Miyue assistant message');
    const items = [...new Map(events.map(event => {
      const sourceKey = this.sourceKey(event), materialKey = this.materialKey(event), key = this.key(event);
      return sourceKey && materialKey && key ? [`${sourceKey}:${materialKey}`, { event, sourceKey, materialKey, key }] : null;
    }).filter(Boolean)).values()];
    return this.store.transaction(() => {
      const save = this.store.db.prepare(`INSERT INTO companion_event_materials(event_key,last_presented_at,message_id) VALUES(?,?,?) ON CONFLICT(event_key) DO NOTHING`);
      const saveExposure = this.store.db.prepare(`INSERT INTO companion_event_material_exposures(source_key,material_key,phase,last_presented_at,message_id) VALUES(?,?,?,?,?) ON CONFLICT(source_key,material_key) DO NOTHING`);
      const presentedAt = new Date(this.clock()).toISOString();
      for (const item of items) {
        save.run(item.key, presentedAt, messageId);
        saveExposure.run(item.sourceKey, item.materialKey, phaseOf(item.event), presentedAt, messageId);
      }
      return { count: items.length };
    });
  }
}
