import { randomUUID } from 'node:crypto';

const clip = (value, length) => String(value || '').replace(/\s+/gu, ' ').trim().slice(0, length);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const safeId = value => clip(value, 160).replace(/[^\w:.-]/gu, '_');
const integer = (value, fallback = null) => Number.isInteger(value) && value >= 0 ? value : fallback;
const boundedStrings = (value, max = 12, length = 100) => Array.isArray(value) ? [...new Set(value.map(item => clip(item, length)).filter(Boolean))].slice(0, max) : [];
function timing(value) {
  if (!plain(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 20).flatMap(([key, ms]) => {
    const amount = Number(ms); return /^[\w.-]{1,60}$/u.test(key) && Number.isFinite(amount) && amount >= 0 && amount <= 600000 ? [[key, Math.round(amount)]] : [];
  }));
}
function scores(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap(item => {
    if (!plain(item)) return [];
    const id = safeId(item.id || item.sourceId); const score = Number(item.score);
    return id && Number.isFinite(score) ? [{ id, score: Math.max(-1e6, Math.min(1e6, score)) }] : [];
  });
}
function channels(value) {
  if (!plain(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 12).flatMap(([key, score]) => {
    const amount = Number(score); return /^[\w.-]{1,60}$/u.test(key) && Number.isFinite(amount) ? [[key, Math.max(-1e6, Math.min(1e6, amount))]] : [];
  }));
}
function retrievalItems(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 16).flatMap(item => {
    if (!plain(item)) return [];
    const id = safeId(item.id); if (!id) return [];
    const score = item.score == null || item.score === '' ? NaN : Number(item.score);
    return [{ id, sourceIds: boundedStrings(item.sourceIds, 12, 120).map(safeId).filter(Boolean),
      score: Number.isFinite(score) ? Math.max(-1e6, Math.min(1e6, score)) : null,
      channels: channels(item.channels), reason: clip(item.reason || item.selectionReason, 100) || null,
      chars: integer(item.chars, typeof item.text === 'string' ? item.text.length : null) }];
  });
}
function rejections(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap(item => {
    if (!plain(item)) return [];
    const id = safeId(item.id); const reason = clip(item.reason, 120);
    return id && reason ? [{ id, reason }] : [];
  });
}
function countMetadata(value) {
  if (!plain(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 20).flatMap(([key, count]) => {
    const amount = integer(count); return /^[\w.-]{1,60}$/u.test(key) && amount != null && amount <= 1e6 ? [[key, amount]] : [];
  }));
}
function counts(value) {
  if (Array.isArray(value)) return value.slice(0, 32).flatMap(item => {
    if (!plain(item)) return [];
    const chars = integer(item.chars); if (chars == null || chars > 200000) return [];
    return [{ index: integer(item.index, null), kind: clip(item.kind, 60) || null, role: clip(item.role, 60) || null, chars }];
  });
  if (!plain(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 20).flatMap(([key, chars]) => {
    const amount = integer(chars); return /^[\w.-]{1,60}$/u.test(key) && amount != null && amount <= 200000 ? [[key, amount]] : [];
  }));
}
function semantic(value) {
  if (!plain(value)) return { status: null, intent: null, continuity: null, focusMessageId: null };
  return { status: clip(value.status, 60) || null, intent: clip(value.intent || value.decision?.intent, 60) || null,
    reason:clip(value.reason,60)||null,
    continuity: clip(value.continuity || value.decision?.continuity, 60) || null,
    focusMessageId: safeId(value.focusMessageId || value.decision?.focusMessageId) || null,
    correction:value.decision?.correction===true,meaningChars:typeof value.decision?.turnMeaning==='string'?Math.min(240,value.decision.turnMeaning.length):0 };
}
function stages(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 32).flatMap(item => {
    if (!plain(item)) return [];
    const name = clip(item.name || item.stage, 60); const ms = Number(item.ms ?? item.durationMs);
    return name && Number.isFinite(ms) && ms >= 0 && ms <= 600000 ? [{ name, ms: Math.round(ms), status: clip(item.status, 40) || null }] : [];
  });
}
function normalize(trace, clock) {
  const now = new Date(clock()); const createdAt = Number.isFinite(+now) ? now.toISOString() : new Date().toISOString();
  const sourceIds = boundedStrings(trace?.reaction?.sourceIds, 12, 120).map(safeId).filter(Boolean);
  return {
    id: safeId(trace?.id) || randomUUID(), roleId: safeId(trace?.roleId) || 'miyue', createdAt,
    trigger: { type: clip(typeof trace?.trigger === 'string' ? trace.trigger : trace?.trigger?.type || trace?.triggerType, 60) || null },
    mode: trace?.mode === 'session' ? 'session' : 'legacy',
    toolCalls: Array.isArray(trace?.toolCalls) ? trace.toolCalls.slice(0, 6).map(item=>({name:clip(item.name,40),status:clip(item.status,40)})) : [],
    semantic: semantic(trace?.semantic),
    stageTimings: timing(trace?.stageTimings || trace?.timings), stages: stages(trace?.stages),
    retrieval: { selected: retrievalItems(trace?.retrieval?.selected), represented: retrievalItems(trace?.retrieval?.represented),
      rejected: rejections(trace?.retrieval?.rejected), stats: countMetadata(trace?.retrieval?.stats), status: clip(trace?.retrieval?.status, 60) || null,
      errorCode: clip(trace?.retrieval?.errorCode, 80) || null, scores: scores(trace?.retrieval?.scores),
      rejections: boundedStrings(trace?.retrieval?.rejections, 16, 100) },
    promptBlocks: counts(trace?.promptBlocks || trace?.promptBlockChars),
    outcome: { status: clip(trace?.outcome?.status || trace?.outcome, 60) || 'unknown', code: clip(trace?.outcome?.code, 80) || null },
    revision: integer(trace?.revision, 0), repairCount: integer(trace?.repairCount, 0), messageIds: boundedStrings(trace?.messageIds, 24, 120).map(safeId).filter(Boolean), repairIssues: boundedStrings(trace?.repairIssues, 16, 100),
    reaction: { kind: clip(trace?.reaction?.kind, 80) || 'none', sourceIds },
    dynamicsStatus:['omitted','invalid','unchanged','proposed'].includes(trace?.dynamicsStatus)?trace.dynamicsStatus:null,
    historicalCheck:trace?.historicalCheck===true,
  };
}

export class DialogueTraceRepository {
  constructor(store, { clock = () => new Date(), maxRecords = 300 } = {}) {
    if (!store?.db) throw new TypeError('store with db is required');
    this.store = store; this.clock = clock; this.maxRecords = Math.max(1, Math.min(1000, integer(maxRecords, 300)));
    store.db.exec('CREATE TABLE IF NOT EXISTS dialogue_traces (id TEXT PRIMARY KEY, role_id TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL)');
  }
  record(trace = {}) {
    const value = normalize(trace, this.clock);
    this.store.db.prepare('INSERT INTO dialogue_traces(id,role_id,created_at,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET role_id=excluded.role_id,created_at=excluded.created_at,payload=excluded.payload').run(value.id, value.roleId, value.createdAt, JSON.stringify(value));
    this.store.db.prepare('DELETE FROM dialogue_traces WHERE id IN (SELECT id FROM dialogue_traces WHERE role_id=? ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ?)').run(value.roleId, this.maxRecords);
    return structuredClone(value);
  }
  list({ roleId = 'miyue', limit = 20 } = {}) {
    const safeRole = safeId(roleId) || 'miyue'; const safeLimit = Math.max(1, Math.min(200, integer(limit, 20)));
    return this.store.db.prepare('SELECT payload FROM dialogue_traces WHERE role_id=? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(safeRole, safeLimit)
      .flatMap(row => { try { const value = JSON.parse(row.payload); return plain(value) ? [structuredClone(value)] : []; } catch { return []; } });
  }
}
