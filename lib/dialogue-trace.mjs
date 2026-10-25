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
function guidanceItems(value){return Array.isArray(value)?value.slice(0,4).map(i=>({instruction:clip(i?.instruction,500),quote:clip(i?.quote,500),...(['evidence','draft'].includes(i?.quoteSource)?{quoteSource:i.quoteSource}:{})})):[];}
function receipt(value){try{const text=JSON.stringify(value);return text.length<=6000?JSON.parse(text):{truncated:true,excerpt:text.slice(0,6000)};}catch{return null;}}
function normalize(trace, clock) {
  const now = new Date(clock()); const createdAt = Number.isFinite(+now) ? now.toISOString() : new Date().toISOString();
  const sourceIds = boundedStrings(trace?.reaction?.sourceIds, 12, 120).map(safeId).filter(Boolean);
  return {
    id: safeId(trace?.id) || randomUUID(), roleId: safeId(trace?.roleId) || 'miyue', createdAt,
    trigger: { type: clip(typeof trace?.trigger === 'string' ? trace.trigger : trace?.trigger?.type || trace?.triggerType, 60) || null },
    mode: trace?.mode === 'session' ? 'session' : 'legacy',
    ...(plain(trace?.morningMemory)?{morningMemory:{status:clip(trace.morningMemory.status,40),reason:clip(trace.morningMemory.reason,80)||null,day:/^\d{4}-\d{2}-\d{2}$/u.test(trace.morningMemory.day||'')?trace.morningMemory.day:null}}:{}),
    revisions: countMetadata(trace?.revisions),
    history: Array.isArray(trace?.history)?trace.history.slice(-80).map(row=>({id:safeId(row.id),speaker:row.speaker,authorId:safeId(row.authorId),authorName:clip(row.authorName,80),kind:clip(row.kind,40),at:clip(row.at,80)})):[],
    calls:Array.isArray(trace?.calls)?trace.calls.slice(0,12).map(call=>({purpose:clip(call.purpose,60),status:clip(call.status,40),durationMs:integer(call.durationMs),model:clip(call.model,120),usage:receipt(call.usage)||null,errorCode:clip(call.errorCode,80)||null})):[],
    toolResults:Array.isArray(trace?.toolResults)?trace.toolResults.slice(0,6).map(item=>({request:receipt(item.request),status:clip(item.status,40),result:receipt(item.result)})):[],
    toolCalls: Array.isArray(trace?.toolCalls) ? trace.toolCalls.slice(0, 6).map(item=>({name:clip(item.name,40),status:clip(item.status,40)})) : [],
    ...(['used','discarded','action','failed'].includes(trace?.speculativeDraft)?{speculativeDraft:trace.speculativeDraft}:{}),
    ...(plain(trace?.length)?{length:{...(plain(trace.length.budget)?{budget:{target:integer(trace.length.budget.target,0),hard:integer(trace.length.budget.hard,0),detail:trace.length.budget.detail===true}}:{}),tightened:trace.length.tightened===true,...(trace.length.reason?{reason:clip(trace.length.reason,60)}:{}),...(trace.length.code?{code:clip(trace.length.code,60)}:{}),...(Number.isFinite(trace.length.from)?{from:integer(trace.length.from,0),to:integer(trace.length.to,0)}:{})}}:{}),
    ...(plain(trace?.informationSelection)&&['food','series','film','travel','news','products','games','books','music'].includes(trace.informationSelection.category)?{informationSelection:{category:trace.informationSelection.category,offered:Math.min(48,integer(trace.informationSelection.offered,0))}}:{}),
    ...(plain(trace?.guidance) ? { guidance: {
      status: ['ready','disabled','unavailable'].includes(trace.guidance.status) ? trace.guidance.status : 'unavailable',
      count: Math.min(4, integer(trace.guidance.count, 0)), items:guidanceItems(trace.guidance.items),
      ...(plain(trace.guidance.turn)?{turn:{
        focus:plain(trace.guidance.turn.focus)?{text:clip(trace.guidance.turn.focus.text,300),sourceId:clip(trace.guidance.turn.focus.sourceId,120),quote:clip(trace.guidance.turn.focus.quote,500)}:null,
        claims:Array.isArray(trace.guidance.turn.claims)?trace.guidance.turn.claims.slice(0,3).map(c=>({actor:clip(c.actor,20),phase:clip(c.phase,20),text:clip(c.text,300),sourceId:clip(c.sourceId,120),quote:clip(c.quote,500)})):[],
      },rejected:Math.min(4,integer(trace.guidance.rejected,0))}:{}),
      ...(trace.guidance.code ? { code: clip(trace.guidance.code, 80) } : {}),
      ...(['fast','reasoning'].includes(trace.guidance.reviewEffort)?{reviewEffort:trace.guidance.reviewEffort}:{}),
      ...(['food','series','film','travel','news','products','games','books','music'].includes(trace.guidance.informationCategory)?{informationCategory:trace.guidance.informationCategory}:{}),
    } } : {}),
    ...(plain(trace?.review) ? { review: {
      status: ['ready','unavailable'].includes(trace.review.status) ? trace.review.status : 'unavailable',
      count: Math.min(4, integer(trace.review.count, 0)), items:guidanceItems(trace.review.items), rewritten: trace.review.rewritten === true,
      ...(trace.review.code ? { code: clip(trace.review.code, 80) } : {}),
      ...(trace.review.fallbackFrom ? { fallbackFrom: clip(trace.review.fallbackFrom,80) } : {}),
      ...(trace.review.escalatedFrom ? { escalatedFrom: clip(trace.review.escalatedFrom,80) } : {}),
      ...(plain(trace.review.verification)?{verification:{status:['ready','unavailable'].includes(trace.review.verification.status)?trace.review.verification.status:'unavailable',count:Math.min(2,integer(trace.review.verification.count,0)),...(trace.review.verification.mode==='inline'?{mode:'inline'}:{}),...(trace.review.verification.items?.length?{items:guidanceItems(trace.review.verification.items)}:{}),...(trace.review.verification.code?{code:clip(trace.review.verification.code,80)}:{}),...(trace.review.verification.fallbackFrom?{fallbackFrom:clip(trace.review.verification.fallbackFrom,80)}:{})}}:{}),
    } } : {}),
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
