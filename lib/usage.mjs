import { randomUUID } from 'node:crypto';

const token = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export function normalizeUsage(usage) {
  const inputTokens = token(usage?.prompt_tokens ?? usage?.input_tokens);
  const outputTokens = token(usage?.completion_tokens ?? usage?.output_tokens);
  return {
    inputTokens, outputTokens,
    totalTokens: token(usage?.total_tokens) ?? (inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null),
    cachedTokens: token(usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? usage?.input_tokens_details?.cached_tokens),
    reasoningTokens: token(usage?.completion_tokens_details?.reasoning_tokens ?? usage?.output_tokens_details?.reasoning_tokens),
  };
}
const cacheStats = rows => {
  let cacheObservedRequests = 0, cacheObservedInputTokens = 0, cacheHitTokens = 0;
  for (const row of rows) {
    const inputTokens = token(row?.inputTokens), cachedTokens = token(row?.cachedTokens);
    if (inputTokens === null || inputTokens === 0 || cachedTokens === null || cachedTokens > inputTokens) continue;
    cacheObservedRequests += 1;
    cacheObservedInputTokens += inputTokens;
    cacheHitTokens += cachedTokens;
  }
  return {
    cacheHitRate: cacheObservedInputTokens ? cacheHitTokens / cacheObservedInputTokens : null,
    cacheObservedRequests,
    cacheObservedInputTokens,
    cacheHitTokens,
    cacheMissTokens: cacheObservedInputTokens - cacheHitTokens,
  };
};
const sum = rows => {
  const result = { requests: rows.length, unknownRequests: rows.filter(row => token(row.totalTokens) === null).length, cancelledRequests: rows.filter(row=>row.status==='cancelled').length, failedRequests: rows.filter(row => !['success','cancelled'].includes(row.status)).length };
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedTokens', 'reasoningTokens']) {
    const known = rows.map(row => token(row[key])).filter(value => value !== null);
    result[key] = known.length ? known.reduce((a, b) => a + b, 0) : rows.length ? null : 0;
  }
  return { ...result, ...cacheStats(rows) };
};
const dayKey = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
export class UsageRepository {
  constructor(store, { clock = () => new Date() } = {}) {
    this.store = store; this.clock = clock;
    store.db.exec('CREATE TABLE IF NOT EXISTS model_usage (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, payload TEXT NOT NULL)');
    store.db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES (?,?)').run('usage_started_at', clock().toISOString());
  }
  record({ usage, provider, model, purpose = 'chat', roleId = null, status = 'success', durationMs, errorCode, upstreamStatus }) {
    const entry = { id: randomUUID(), createdAt: this.clock().toISOString(), provider: String(provider || '').slice(0, 200), model: String(model || '').slice(0, 200), purpose: String(purpose).slice(0, 60), roleId, status, durationMs: Math.max(0, Number(durationMs) || 0), ...normalizeUsage(usage) };
    if(typeof errorCode==='string'&&/^MODEL_[A-Z_]{1,60}$/.test(errorCode))entry.errorCode=errorCode;
    if(Number.isInteger(upstreamStatus)&&upstreamStatus>=400&&upstreamStatus<=599)entry.upstreamStatus=upstreamStatus;
    this.store.db.prepare('INSERT INTO model_usage VALUES (?,?,?)').run(entry.id, entry.createdAt, JSON.stringify(entry));
    return entry;
  }
  snapshot() {
    const rows = this.store.db.prepare('SELECT payload FROM model_usage ORDER BY rowid').all().map(row => JSON.parse(row.payload));
    const grouped = key => [...new Set(rows.map(row => row[key]))].map(value => ({ [key]: value, ...sum(rows.filter(row => row[key] === value)) }));
    return { since: this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get('usage_started_at').value,
      today: sum(rows.filter(row => dayKey(new Date(row.createdAt)) === dayKey(this.clock()))), allTime: sum(rows), byRole: grouped('roleId'), byPurpose: grouped('purpose'), recent: rows.slice(-50).reverse().map(row => ({ ...row, ...cacheStats([row]) })) };
  }
}
