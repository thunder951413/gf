import { randomUUID } from 'node:crypto';

const STATES = new Set(['engaged', 'wants_more', 'less', 'blocked', 'deferred', 'neutral', 'changed_topic', 'unknown']);
const SCOPES = new Set(['topic', 'category']);
const CLOSING = new Set(['less', 'blocked', 'deferred', 'changed_topic']);
const DAY = 86_400_000;
const CATEGORY_ALIASES = Object.freeze({
  philosophy: ['philosophy', '哲学'], psychology: ['psychology', '心理学'], history: ['history', '历史'],
  geography: ['geography', '地理'], science: ['science', '科学'], arts: ['arts', '艺术'], society: ['society', '社会'],
});

const invalid = message => Object.assign(new Error(message), { code: 'INVALID_DISCUSSION_TOPIC' });
const iso = clock => {
  const date = new Date(clock());
  if (Number.isNaN(date.valueOf())) throw invalid('clock returned an invalid date');
  return date.toISOString();
};
const json = value => { try { return JSON.parse(value); } catch { return null; } };
const clean = (value, max = 200) => typeof value === 'string' && value.trim() && value.trim().length <= max ? value.trim() : null;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function locateWhitespaceEquivalent(text, quote) {
  if (typeof text !== 'string' || typeof quote !== 'string') return null;
  const source = [...text.matchAll(/\S/gu)], needle = [...quote.matchAll(/\S/gu)].map(match => match[0]).join('');
  if (!needle) return null;
  const compact = source.map(match => match[0]).join(''), utf16Offset = compact.indexOf(needle);
  if (utf16Offset < 0) return null;
  const offset = [...compact.slice(0, utf16Offset)].length;
  const first = source[offset], last = source[offset + [...needle].length - 1];
  return first && last ? text.slice(first.index, last.index + last[0].length) : null;
}

function normalizeCatalog(catalog) {
  if (!Array.isArray(catalog)) throw invalid('catalog must be an array');
  const ids = new Set();
  return catalog.flatMap(raw => {
    if (!raw || typeof raw !== 'object') return [];
    const id = clean(raw.id, 100), category = clean(raw.category, 60), title = clean(raw.title, 160), premise = clean(raw.premise, 1200);
    if (!id || ids.has(id) || !category || !title || !premise) return [];
    ids.add(id);
    return [{
      id, category, title, premise,
      aliases: Array.isArray(raw.aliases) ? raw.aliases.map(item => clean(item, 80)).filter(Boolean).slice(0, 12) : [],
      angles: Array.isArray(raw.angles) ? raw.angles.flatMap(item => clean(item?.id, 80) && clean(item?.detail, 600) ? [{ id: clean(item.id, 80), detail: clean(item.detail, 600) }] : []).slice(0, 12) : [],
      sources: Array.isArray(raw.sources) ? raw.sources.flatMap(item => clean(item?.title, 200) && clean(item?.url, 1000) ? [{ title: clean(item.title, 200), url: clean(item.url, 1000), ...(clean(item?.note, 600) ? { note: clean(item.note, 600) } : {}) }] : []).slice(0, 12) : [],
      ...(raw.limits === undefined ? {} : { limits: structuredClone(raw.limits) }),
    }];
  });
}

export class DiscussionTopics {
  constructor(store, { clock = () => new Date(), random = Math.random, catalog = [], isVisible = () => true } = {}) {
    if (!store?.db || typeof store.transaction !== 'function') throw invalid('DiscussionTopics requires a Store');
    this.store = store;
    this.clock = clock;
    this.random = random;
    this.catalog = normalizeCatalog(catalog);
    this.byId = new Map(this.catalog.map(topic => [topic.id, topic]));
    this.isVisible = isVisible;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS discussion_topic_exposures (
        id TEXT PRIMARY KEY, role_id TEXT NOT NULL, topic_id TEXT NOT NULL,
        opened_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS discussion_topic_exposures_role_time
        ON discussion_topic_exposures(role_id, opened_at DESC);
      CREATE TABLE IF NOT EXISTS discussion_topic_deliveries (
        message_id TEXT PRIMARY KEY, exposure_id TEXT NOT NULL REFERENCES discussion_topic_exposures(id) ON DELETE CASCADE,
        trigger TEXT NOT NULL, quote TEXT NOT NULL, delivered_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS discussion_topic_deliveries_exposure_time
        ON discussion_topic_deliveries(exposure_id, delivered_at DESC);
      CREATE TABLE IF NOT EXISTS discussion_topic_responses (
        message_id TEXT PRIMARY KEY, exposure_id TEXT NOT NULL REFERENCES discussion_topic_exposures(id) ON DELETE CASCADE,
        state TEXT NOT NULL, scope TEXT NOT NULL, evidence TEXT, observed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS discussion_topic_responses_exposure_time
        ON discussion_topic_responses(exposure_id, observed_at DESC);
    `);
  }

  #message(id) {
    const source = this.store.db.prepare('SELECT rowid AS source_rowid,* FROM messages WHERE id=?').get(id);
    if (!source) return null;
    const row = this.store.getMessage?.(id) || { id:source.id,role:source.role,speaker:source.speaker,text:source.text,kind:source.kind,createdAt:source.created_at };
    if (!row || !this.isVisible(row)) return null;
    return { ...row, _sourceRowid: source.source_rowid };
  }

  #validDelivery(row) {
    const message = row && this.#message(row.message_id);
    return message && message.role === row.role_id && message.speaker === 'assistant' && message.kind !== 'story'
      && typeof message.text === 'string' && message.text.includes(row.quote) ? { row, message } : null;
  }

  #validResponse(row) {
    const message = row && this.#message(row.message_id);
    if (!message || message.role !== row.role_id || message.speaker !== 'user' || message.kind === 'story') return null;
    if (row.state !== 'unknown' && (!row.evidence || !message.text.includes(row.evidence))) return null;
    return { row, message };
  }

  #exposures(roleId) {
    return this.store.db.prepare('SELECT * FROM discussion_topic_exposures WHERE role_id=?').all(roleId).flatMap(exposure => {
      const deliveries = this.store.db.prepare('SELECT * FROM discussion_topic_deliveries WHERE exposure_id=? ORDER BY rowid').all(exposure.id);
      if (!deliveries.length) return [];
      const anchor = this.#validDelivery({ ...deliveries[0], role_id: roleId });
      if (!anchor) return [];
      const visible = deliveries.flatMap(row => {
        const valid = this.#validDelivery({ ...row, role_id: roleId });
        return valid ? [{ ...row, message: valid.message }] : [];
      });
      const latest = visible.at(-1);
      return latest && this.byId.has(exposure.topic_id) ? [{ ...exposure, ...latest, _anchorRowid: anchor.message._sourceRowid }] : [];
    }).sort((a,b) => b.message._sourceRowid - a.message._sourceRowid);
  }

  #responses(roleId) {
    const validExposures = new Map(this.#exposures(roleId).map(item => [item.id, item]));
    return this.store.db.prepare(`SELECT r.*,r.rowid AS response_rowid,e.role_id,e.topic_id FROM discussion_topic_responses r
      JOIN discussion_topic_exposures e ON e.id=r.exposure_id WHERE e.role_id=? ORDER BY r.observed_at,r.rowid`).all(roleId)
      .flatMap(row => {
        const response = this.#validResponse(row), exposure = validExposures.get(row.exposure_id);
        return response && exposure && response.message._sourceRowid > exposure._anchorRowid ? [row] : [];
      });
  }

  #state(roleId) {
    const now = new Date(this.clock()).valueOf(), responses = this.#responses(roleId);
    const categories = new Map([...new Set(this.catalog.map(topic => topic.category))].map(category => [category, { category, score: 1, blocked: false, observations: 0 }]));
    const topics = new Map(this.catalog.map(topic => [topic.id, { blocked: false, score: 1 }]));
    const directional = new Map();
    for (const response of responses) {
      if (!['engaged', 'wants_more', 'less', 'blocked'].includes(response.state)) continue;
      directional.set(`${response.exposure_id}:${response.scope}`, response);
    }
    for (const response of [...directional.values()].sort((a,b) => Date.parse(a.observed_at)-Date.parse(b.observed_at) || a.response_rowid-b.response_rowid)) {
      const topic = this.byId.get(response.topic_id), category = categories.get(topic?.category), topicState = topics.get(response.topic_id);
      if (!topic || !category || !topicState) continue;
      const age = Math.max(0, now - Date.parse(response.observed_at));
      const decay = Math.pow(0.5, age / (45 * DAY));
      category.observations += 1;
      if (response.state === 'blocked') {
        if (response.scope === 'category') category.blocked = true; else topicState.blocked = true;
      } else if (response.state === 'wants_more') {
        if (response.scope === 'category') { category.blocked = false; category.score += .8 * decay; }
        else { topicState.blocked = false; topicState.score += .8 * decay; category.score += .25 * decay; }
      } else if (response.state === 'less') {
        if (response.scope === 'category') category.score -= .65 * decay;
        else topicState.score -= .7 * decay;
      } else if (response.state === 'engaged') {
        topicState.score += .2 * decay;
        category.score += .14 * decay;
      }
    }
    for (const value of categories.values()) value.score = value.blocked ? 0 : clamp(value.score, .2, 3);
    for (const value of topics.values()) value.score = value.blocked ? 0 : clamp(value.score, .25, 2.5);
    return { categories, topics, responses };
  }

  choose({ roleId = 'miyue', category = null, force = false, excludeTopicIds = [] } = {}) {
    const role = clean(roleId, 80);
    if (!role) throw invalid('roleId is invalid');
    const requestedCategory = category == null ? null : clean(category, 60);
    if (category != null && !requestedCategory) throw invalid('category is invalid');
    const excluded = new Set(Array.isArray(excludeTopicIds) ? excludeTopicIds.filter(value => typeof value === 'string') : []);
    const state = this.#state(role), exposures = this.#exposures(role), cutoff = new Date(this.clock()).valueOf() - 7 * DAY;
    const recentTopics = new Set(exposures.filter(item => Date.parse(item.delivered_at) >= cutoff).map(item => item.topic_id));
    const latestCategory = this.byId.get(exposures[0]?.topic_id)?.category || null;
    let candidates = this.catalog.filter(topic => (!requestedCategory || topic.category === requestedCategory) && !excluded.has(topic.id)
      && (force || (!state.categories.get(topic.category)?.blocked && !state.topics.get(topic.id)?.blocked))
      && (force || !recentTopics.has(topic.id)));
    if (!requestedCategory && latestCategory) {
      const alternatives = candidates.filter(topic => topic.category !== latestCategory);
      if (alternatives.length) candidates = alternatives;
    }
    if (!candidates.length) return null;
    const exposureCounts = new Map();
    for (const item of exposures) exposureCounts.set(item.topic_id, (exposureCounts.get(item.topic_id) || 0) + 1);
    const randomValue = clamp(Number(this.random()) || 0, 0, .999999999);
    if (!force && randomValue < .25 && candidates.some(topic => !exposureCounts.has(topic.id))) {
      const unexplored = candidates.filter(topic => !exposureCounts.has(topic.id));
      return structuredClone(unexplored[Math.floor(clamp(Number(this.random()) || 0, 0, .999999999) * unexplored.length)]);
    }
    const weighted = candidates.map(topic => {
      const categoryWeight = state.categories.get(topic.category).score || (force ? 1 : 0);
      const topicWeight = state.topics.get(topic.id).score || (force ? 1 : 0);
      return { topic, weight: categoryWeight * topicWeight / (1 + .35 * (exposureCounts.get(topic.id) || 0)) };
    });
    const total = weighted.reduce((sum, item) => sum + item.weight, 0);
    let cursor = clamp(Number(this.random()) || 0, 0, .999999999) * total;
    for (const item of weighted) { cursor -= item.weight; if (cursor < 0) return structuredClone(item.topic); }
    return structuredClone(weighted.at(-1).topic);
  }

  recordDelivery({ roleId = 'miyue', topicId, messageId, trigger, quote, exposureId = null }) {
    const role = clean(roleId, 80), topic = this.byId.get(topicId), sourceQuote = clean(quote, 600), sourceTrigger = clean(trigger, 80);
    if (!role || !topic || !clean(messageId, 100) || !sourceTrigger || !sourceQuote || sourceQuote.length < 8) return null;
    const message = this.#message(messageId);
    const savedQuote = message && locateWhitespaceEquivalent(message.text, sourceQuote);
    if (!message || message.role !== role || message.speaker !== 'assistant' || message.kind === 'story' || !savedQuote) return null;
    return this.store.transaction(() => {
      const existingDelivery = this.store.db.prepare('SELECT exposure_id FROM discussion_topic_deliveries WHERE message_id=?').get(messageId);
      if (existingDelivery) return this.#publicExposure(existingDelivery.exposure_id);
      let id = exposureId;
      if (id) {
        const existing = this.store.db.prepare('SELECT * FROM discussion_topic_exposures WHERE id=?').get(id);
        if (!existing || existing.role_id !== role || existing.topic_id !== topic.id) return null;
      } else {
        id = randomUUID();
        this.store.db.prepare('INSERT INTO discussion_topic_exposures(id,role_id,topic_id,opened_at) VALUES(?,?,?,?)').run(id, role, topic.id, iso(this.clock));
      }
      this.store.db.prepare('INSERT INTO discussion_topic_deliveries(message_id,exposure_id,trigger,quote,delivered_at) VALUES(?,?,?,?,?)')
        .run(messageId, id, sourceTrigger, savedQuote, iso(this.clock));
      return this.#publicExposure(id);
    });
  }

  #publicExposure(id) {
    const exposure = this.store.db.prepare('SELECT * FROM discussion_topic_exposures WHERE id=?').get(id);
    if (!exposure) return null;
    const delivery = this.store.db.prepare('SELECT * FROM discussion_topic_deliveries WHERE exposure_id=? ORDER BY delivered_at DESC,rowid DESC LIMIT 1').get(id);
    const valid = delivery && this.#validDelivery({ ...delivery, role_id: exposure.role_id });
    if (!valid) return null;
    return { id: exposure.id, roleId: exposure.role_id, topicId: exposure.topic_id, topic: structuredClone(this.byId.get(exposure.topic_id)), messageId: delivery.message_id, lastMessageId: delivery.message_id, trigger: delivery.trigger, quote: delivery.quote, deliveredAt: delivery.delivered_at, text: valid.message.text, message: valid.message.text };
  }

  observeResponse({ roleId = 'miyue', messageId, exposureId, signal }) {
    const role = clean(roleId, 80), exposure = this.store.db.prepare('SELECT * FROM discussion_topic_exposures WHERE id=?').get(exposureId);
    if (!role || !exposure || exposure.role_id !== role || !signal || !STATES.has(signal.state) || !SCOPES.has(signal.scope)) return null;
    const message = this.#message(messageId);
    if (!message || message.role !== role || message.speaker !== 'user' || message.kind === 'story') return null;
    const prior = this.store.db.prepare('SELECT * FROM discussion_topic_responses WHERE message_id=?').get(messageId);
    if (prior) return prior.exposure_id === exposureId ? this.#publicResponse(prior) : null;
    const tracked = this.#exposures(role).find(item => item.id === exposureId);
    if (!tracked || message._sourceRowid <= tracked.message._sourceRowid) return null;
    const evidence = signal.state === 'unknown' && !signal.evidence ? null : clean(signal.evidence, 400);
    if (signal.state !== 'unknown' && (!evidence || !message.text.includes(evidence))) return null;
    const topic = this.byId.get(exposure.topic_id);
    if (!topic) return null;
    if (signal.scope === 'category' && ['less', 'blocked', 'wants_more'].includes(signal.state)) {
      const aliases = CATEGORY_ALIASES[topic.category] || [topic.category];
      if (!evidence || !aliases.some(alias => evidence.toLocaleLowerCase().includes(alias.toLocaleLowerCase()))) return null;
    }
    return this.store.transaction(() => {
      this.store.db.prepare('INSERT INTO discussion_topic_responses(message_id,exposure_id,state,scope,evidence,observed_at) VALUES(?,?,?,?,?,?)')
        .run(messageId, exposureId, signal.state, signal.scope, evidence, iso(this.clock));
      return this.#publicResponse(this.store.db.prepare('SELECT * FROM discussion_topic_responses WHERE message_id=?').get(messageId));
    });
  }

  #publicResponse(row) {
    return row && { messageId: row.message_id, exposureId: row.exposure_id, state: row.state, scope: row.scope, evidence: row.evidence || null, observedAt: row.observed_at };
  }

  active({ roleId = 'miyue', conversation = [] } = {}) {
    const role = clean(roleId, 80), latest = role && this.#exposures(role)[0];
    if (!latest || new Date(this.clock()).valueOf() - Date.parse(latest.delivered_at) > 72 * 3600_000) return null;
    const responses = this.#responses(role).filter(row => row.exposure_id === latest.id);
    if (responses.some(row => CLOSING.has(row.state))) return null;
    const supplied = Array.isArray(conversation) ? conversation : [];
    const after = supplied.flatMap(row => {
      if (!row?.id) return [];
      const saved = this.#message(row.id);
      return saved && saved.role === role && saved.kind !== 'story' && saved._sourceRowid > latest.message._sourceRowid ? [saved] : [];
    });
    // A later assistant opening that is not a recorded continuation terminates
    // this local thread. The sole exception is the ordinary reply paired with
    // a confirmed non-closing user response: an ordinary reply may continue
    // the exchange even when its optional delivery annotation is absent or
    // invalid. The reply is not recorded as topical material and earns no
    // additional interest credit.
    const bridgeIds = new Set(this.#responses(role).filter(row => row.exposure_id === latest.id && ['neutral','engaged','wants_more'].includes(row.state)).map(row => row.message_id));
    const unrelatedAssistant = after.some(row => {
      if (row.speaker !== 'assistant' || this.store.db.prepare('SELECT 1 FROM discussion_topic_deliveries WHERE message_id=? AND exposure_id=?').get(row.id, latest.id)) return false;
      if (row.kind !== 'chat') return true;
      const before = this.store.db.prepare('SELECT id,speaker FROM messages WHERE role=? AND rowid<? ORDER BY rowid DESC LIMIT 1').get(role, row._sourceRowid);
      return !before || before.speaker !== 'user' || !bridgeIds.has(before.id);
    });
    if (unrelatedAssistant) return null;
    return this.#publicExposure(latest.id);
  }

  profile(roleId = 'miyue') {
    const role = clean(roleId, 80);
    if (!role) throw invalid('roleId is invalid');
    const state = this.#state(role), exposures = this.#exposures(role).slice(0, 20), responses = this.#responses(role).slice(-30).reverse();
    return {
      roleId: role,
      categories: [...state.categories.values()].map(item => ({ category: item.category, score: Number(item.score.toFixed(3)), blocked: item.blocked, observations: item.observations })),
      exposures: exposures.map(item => ({ id: item.id, topicId: item.topic_id, messageId: item.message_id, deliveredAt: item.delivered_at, trigger: item.trigger })),
      responses: responses.map(item => ({ messageId: item.message_id, exposureId: item.exposure_id, topicId: item.topic_id, state: item.state, scope: item.scope, evidence: item.evidence || null, observedAt: item.observed_at })),
    };
  }
}
