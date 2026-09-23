const SUBJECTS = new Set(['user', 'character', 'shared']);
const KINDS = new Set(['fact', 'preference', 'boundary', 'event', 'topic', 'agreement']);
const STATUSES = new Set(['current', 'ongoing', 'completed', 'cancelled', 'past']);
const IGNORE_REASONS = new Set(['greeting', 'repeat', 'filler', 'unsupported', 'superseded', 'transient']);
const MAX_ITEMS = 100, MAX_SUMMARY_CHARS = 16000, MAX_AUDIT = 100;
const PROJECTED_CHARACTER_ITEMS = 3, PROJECTED_CHARACTER_CHARS = 1000;
const QUERY_STOP_WORDS = new Set(['自己', '你', '我', '现在', '最近', '今天', '这个', '那个', '这里', '那里', '然后', '一下', '什么', '怎么', '可以', '还是', '就是', '已经', '没有', '不是', '一个', '一些', '事情', '问题', '感觉', '觉得', '想要', '知道', '说说', '聊聊', '到了', '还行']);

function invalid(message) { const error = new Error(message); error.code = 'INVALID_CONSOLIDATED_MEMORY'; throw error; }
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function text(value, name, max, { optional = false } = {}) {
  if (value == null && optional) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max) invalid(`${name} is invalid`);
  return value.trim();
}
function normalized(value) { return value.trim().replace(/[\p{P}\p{S}\s]/gu, '').toLocaleLowerCase(); }
function json(value) { return JSON.stringify(value); }
function parse(value, fallback = []) { try { return JSON.parse(value); } catch { return fallback; } }
function iso(value) { const date = new Date(value); if (Number.isNaN(date.valueOf())) invalid('now is invalid'); return date.toISOString(); }
function queryTokens(value) {
  if (typeof value !== 'string') return new Set();
  const tokens = new Set();
  const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
  let singleHanRun = '';
  const addHanRun = () => {
    // Segmenter deliberately splits some proper names and coined work labels
    // into single Han characters. Keep short contiguous compounds so a named
    // recall such as “绿金改稿” can still find “绿金包装稿”.
    for (let size = 2; size <= Math.min(4, singleHanRun.length); size += 1) {
      for (let index = 0; index <= singleHanRun.length - size; index += 1) {
        const compound = singleHanRun.slice(index, index + size);
        if (!QUERY_STOP_WORDS.has(compound)) tokens.add(compound);
      }
    }
    singleHanRun = '';
  };
  for (const part of segmenter.segment(value)) {
    if (!part.isWordLike) { addHanRun(); continue; }
    const token = normalized(part.segment);
    if (QUERY_STOP_WORDS.has(token)) { addHanRun(); continue; }
    if (/^[\p{Script=Han}]$/u.test(token)) { singleHanRun += token; continue; }
    addHanRun();
    if (token.length > 1) tokens.add(token);
  }
  addHanRun();
  return tokens;
}
function queryMatches(item, tokens) {
  if (!tokens.size) return false;
  const haystack = queryTokens(`${item.topic} ${item.summary}`);
  for (const token of tokens) if (haystack.has(token)) return true;
  return false;
}

export class ConsolidatedMemoryRepository {
  constructor(store, { getSuppressedSourceIds = () => [], projectSource = row => row } = {}) {
    if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('ConsolidatedMemoryRepository requires a Store');
    if (typeof getSuppressedSourceIds !== 'function') throw new TypeError('getSuppressedSourceIds must be a function');
    if (typeof projectSource !== 'function') throw new TypeError('projectSource must be a function');
    this.store = store; this.db = store.db; this.getSuppressedSourceIds = getSuppressedSourceIds; this.projectSource = projectSource;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS consolidated_memory_state (
        scope TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0,
        cursor_rowid INTEGER NOT NULL DEFAULT 0, cursor_id TEXT
      );
      CREATE TABLE IF NOT EXISTS consolidated_memories (
        id TEXT PRIMARY KEY, scope TEXT NOT NULL, subject TEXT NOT NULL, kind TEXT NOT NULL,
        topic TEXT NOT NULL, summary TEXT NOT NULL, status TEXT NOT NULL,
        evidence_json TEXT NOT NULL, first_at TEXT NOT NULL, last_at TEXT NOT NULL,
        mentions INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, archived_at TEXT
      );
      CREATE INDEX IF NOT EXISTS consolidated_memories_scope_active ON consolidated_memories(scope,active,id);
      CREATE TABLE IF NOT EXISTS consolidated_memory_audit (
        run_id INTEGER PRIMARY KEY AUTOINCREMENT, scope TEXT NOT NULL, revision INTEGER NOT NULL,
        cursor_rowid INTEGER NOT NULL, cursor_id TEXT, created_at TEXT NOT NULL, model TEXT,
        counts_json TEXT NOT NULL, coverage_json TEXT NOT NULL, changes_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS consolidated_memory_audit_scope_run ON consolidated_memory_audit(scope,run_id DESC);
    `);
  }

  _scope(scope) { return text(scope, 'scope', 160); }
  _ensure(scope) { this.db.prepare('INSERT OR IGNORE INTO consolidated_memory_state(scope) VALUES(?)').run(scope); }
  _state(scope) { this._ensure(scope); return this.db.prepare('SELECT * FROM consolidated_memory_state WHERE scope=?').get(scope); }
  _map(row) { return { id: row.id, subject: row.subject, kind: row.kind, topic: row.topic, summary: row.summary, status: row.status, evidence: parse(row.evidence_json), firstAt: row.first_at, lastAt: row.last_at, mentions: row.mentions }; }
  _active(scope) { return this.db.prepare('SELECT * FROM consolidated_memories WHERE scope=? AND active=1 ORDER BY id').all(scope); }
  _canonical(scope, id) {
    // This is deliberately the same privacy predicate used by recall.  A
    // ledger never turns a story/persona message into durable context.
    const row = this.db.prepare(`SELECT rowid,id,role,speaker,text,kind,created_at FROM recall_messages
      WHERE role=? AND id=? AND kind<>'story'
      AND (speaker='user' OR rowid>COALESCE((SELECT CAST(value AS INTEGER) FROM metadata WHERE key='persona_cutoff:'||recall_messages.role),0))`).get(scope, id) || null;
    if (!row || row.speaker === 'user') return row;
    const projected = this.projectSource(row, scope);
    return projected && typeof projected.text === 'string' && projected.text.trim() ? { ...row, ...projected, rowid: row.rowid, id: row.id, role: row.role, speaker: row.speaker, kind: row.kind, created_at: row.created_at } : null;
  }
  _suppressed(scope) {
    const ids = this.getSuppressedSourceIds(scope);
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new TypeError('getSuppressedSourceIds must return string[]');
    return new Set(ids);
  }
  _evidenceVisible(scope, source, suppressed = this._suppressed(scope)) {
    if (suppressed.has(source.messageId)) return false;
    const row = this._canonical(scope, source.messageId);
    return Boolean(row && typeof source.quote === 'string' && row.text.includes(source.quote));
  }
  _validateRows(scope, rows) {
    if (!Array.isArray(rows) || rows.length > 500) invalid('rows is invalid');
    const result = new Map();
    for (const row of rows) {
      if (!plain(row) || typeof row.id !== 'string' || !row.id || !Number.isInteger(row.rowid) || row.rowid < 1 || typeof row.text !== 'string' || typeof row.speaker !== 'string') invalid('row is invalid');
      if (result.has(row.id)) invalid('duplicate row id');
      const raw = this.db.prepare(`SELECT rowid,id,role,speaker,text,kind,created_at FROM recall_messages
        WHERE role=? AND id=? AND kind<>'story' AND (speaker='user' OR rowid>COALESCE(
        (SELECT CAST(value AS INTEGER) FROM metadata WHERE key='persona_cutoff:'||recall_messages.role),0))`).get(scope, row.id);
      const canonical = this._canonical(scope, row.id);
      if (!raw || raw.rowid !== row.rowid || raw.speaker !== row.speaker) invalid('row is not canonical');
      if (canonical && canonical.text !== row.text) invalid('row is not canonical');
      if (!canonical && (raw.text !== row.text || raw.speaker !== 'assistant')) invalid('row is not canonical');
      result.set(row.id, canonical || { ...raw, hidden: true });
    }
    return result;
  }
  _validateCandidate(candidate, rows, scope) {
    if (!plain(candidate)) invalid('candidate is invalid');
    const allowed = new Set(['targetId', 'subject', 'kind', 'topic', 'summary', 'status', 'evidence']);
    if (Object.keys(candidate).some(key => !allowed.has(key))) invalid('candidate has unknown fields');
    if (candidate.targetId != null && (typeof candidate.targetId !== 'string' || !candidate.targetId)) invalid('targetId is invalid');
    const subject = text(candidate.subject, 'subject', 16); if (!SUBJECTS.has(subject)) invalid('subject is invalid');
    const kind = text(candidate.kind, 'kind', 16); if (!KINDS.has(kind)) invalid('kind is invalid');
    const topic = text(candidate.topic, 'topic', 80); const summary = text(candidate.summary, 'summary', 200);
    const status = text(candidate.status, 'status', 16); if (!STATUSES.has(status)) invalid('status is invalid');
    if (!Array.isArray(candidate.evidence) || candidate.evidence.length < 1 || candidate.evidence.length > 4) invalid('evidence is invalid');
    const evidence = []; const ids = new Set(); let user = false, assistant = false;
    for (const source of candidate.evidence) {
      if (!plain(source) || Object.keys(source).some(key => key !== 'messageId' && key !== 'quote')) invalid('evidence is invalid');
      const messageId = text(source.messageId, 'messageId', 160), quote = text(source.quote, 'quote', 500);
      const evidenceKey=JSON.stringify([messageId,quote]); if (ids.has(evidenceKey)) invalid('duplicate evidence'); ids.add(evidenceKey);
      const row = rows.get(messageId);
      const canonical = row && this._canonical(scope, messageId);
      if (!row || !canonical || !row.text.includes(quote) || !canonical.text.includes(quote)) invalid('evidence quote is not grounded');
      if (row.speaker === 'user') user = true; if (row.speaker === 'assistant') assistant = true;
      evidence.push({ messageId, quote });
    }
    if ((subject === 'user' && (!user || assistant)) || (subject === 'character' && (!assistant || user)) || (subject === 'shared' && (!user || !assistant))) invalid('evidence speaker does not match subject');
    return { targetId: candidate.targetId || null, subject, kind, topic, summary, status, evidence };
  }
  snapshot(scope) { scope = this._scope(scope); const state = this._state(scope); const suppressed = this._suppressed(scope); return { revision: state.revision, cursor: { rowid: state.cursor_rowid, id: state.cursor_id }, items: this._active(scope).map(row => this._map(row)).filter(item => item.evidence.every(source => this._evidenceVisible(scope, source, suppressed))) }; }

  apply(scope, input) {
    scope = this._scope(scope);
    if (!plain(input) || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 0 || input.fromCursor == null || !plain(input.through) || !Number.isInteger(input.through.rowid) || input.through.rowid < 1 || typeof input.through.id !== 'string' || !input.through.id || !Array.isArray(input.candidates) || input.candidates.length > 40 || !Array.isArray(input.ignored)) invalid('apply input is invalid');
    const now = iso(input.now); const rows = this._validateRows(scope, input.rows);
    const through = rows.get(input.through.id);
    if (!through || through.rowid !== input.through.rowid) invalid('through is not a supplied canonical row');
    return this.store.transaction(() => {
      const state = this.db.prepare('SELECT * FROM consolidated_memory_state WHERE scope=?').get(scope) || { revision: 0, cursor_rowid: 0, cursor_id: null };
      if (state.revision !== input.expectedRevision) return { status: 'stale', revision: state.revision, cursor: { rowid: state.cursor_rowid, id: state.cursor_id } };
      const from = typeof input.fromCursor === 'number' ? { rowid: input.fromCursor, id: state.cursor_id } : input.fromCursor;
      if (!plain(from) || !Number.isInteger(from.rowid) || from.rowid < 0 || (from.id != null && typeof from.id !== 'string') || from.rowid !== state.cursor_rowid || (typeof input.fromCursor !== 'number' && from.id !== state.cursor_id)) invalid('fromCursor does not match state');
      if (through.rowid <= state.cursor_rowid) invalid('cursor must advance');
      if (Math.max(...[...rows.values()].map(row => row.rowid)) !== through.rowid || [...rows.values()].some(row => row.rowid <= state.cursor_rowid || row.rowid > through.rowid)) invalid('rows are outside cursor range');
      const qualified = this.db.prepare(`SELECT rowid,id FROM recall_messages WHERE role=? AND kind<>'story'
        AND (speaker='user' OR rowid>COALESCE((SELECT CAST(value AS INTEGER) FROM metadata WHERE key='persona_cutoff:'||recall_messages.role),0))
        AND rowid>? AND rowid<=? ORDER BY rowid`).all(scope, state.cursor_rowid, through.rowid);
      if (qualified.length !== rows.size || qualified.some(row => !rows.has(row.id))) invalid('rows must cover every qualified source');
      const candidateErrors=[];
      const candidates = input.candidates.map((item,index) => {try{return this._validateCandidate(item, rows, scope);}catch(error){candidateErrors.push(`items[${index}]: ${error.message}`);return null;}});
      if(candidateErrors.length)invalid(candidateErrors.join('; '));
      const suppressed = this._suppressed(scope);
      if (candidates.some(candidate => candidate.evidence.some(source => suppressed.has(source.messageId)))) invalid('evidence source is suppressed');
      const ignored = new Map();
      for (const item of input.ignored) {
        if (!plain(item) || Object.keys(item).some(key => key !== 'messageId' && key !== 'reason') || typeof item.messageId !== 'string' || !IGNORE_REASONS.has(item.reason) || !rows.has(item.messageId) || ignored.has(item.messageId)) invalid('ignored is invalid');
        ignored.set(item.messageId, item.reason);
      }
      const covered = new Set(candidates.flatMap(item => item.evidence.map(source => source.messageId)));
      const missing=[...rows.keys()].filter(id=>!covered.has(id)&&!ignored.has(id));if(missing.length)invalid('all rows need coverage; missing messageIds: '+missing.join(', '));
      for (const id of rows.keys()) { if (covered.has(id) && ignored.has(id)) invalid('row cannot be evidence and ignored: '+id); }
      this.db.prepare('INSERT OR IGNORE INTO consolidated_memory_state(scope) VALUES(?)').run(scope);
      const summaryCharsBefore=this._active(scope).reduce((sum,row)=>sum+row.summary.length,0);
      const active = this._active(scope), byId = new Map(active.map(row => [row.id, row]));
      const changes = []; let created = 0, updated = 0, repeated = 0;
      for (const candidate of candidates) {
        let row = candidate.targetId ? byId.get(candidate.targetId) : null;
        if (candidate.targetId && (!row || row.subject !== candidate.subject || row.kind !== candidate.kind)) invalid('targetId is not an active matching memory');
        if (!row) row = active.find(item => item.subject === candidate.subject && item.kind === candidate.kind && normalized(item.topic) === normalized(candidate.topic))
          || (!['event','agreement'].includes(candidate.kind)&&active.find(item => item.subject === candidate.subject && item.kind === candidate.kind && normalized(item.summary) === normalized(candidate.summary) && item.status === candidate.status));
        const latestEvidenceRowid = Math.max(...candidate.evidence.map(source => rows.get(source.messageId).rowid));
        if (row) {
          const before = this._map(row), same = normalized(row.summary) === normalized(candidate.summary) && row.status === candidate.status;
          const existingEvidenceRowid = Math.max(0, ...parse(row.evidence_json).map(source => this._canonical(scope, source.messageId)?.rowid || 0));
          if (!same && latestEvidenceRowid <= existingEvidenceRowid) invalid('replacement needs newer evidence');
          const merged = [...parse(row.evidence_json), ...candidate.evidence].filter((source, index, all) => index === all.findIndex(other => other.messageId === source.messageId && other.quote === source.quote)).slice(-6);
          const dates = candidate.evidence.map(source => rows.get(source.messageId).created_at).filter(Boolean).sort();
          const firstAt = [row.first_at, dates[0]].filter(Boolean).sort()[0] || now;
          const lastAt = [row.last_at, dates.at(-1)].filter(Boolean).sort().at(-1) || now;
          this.db.prepare('UPDATE consolidated_memories SET topic=?,summary=?,status=?,evidence_json=?,first_at=?,last_at=?,mentions=mentions+1 WHERE id=?').run(same?row.topic:candidate.topic, same?row.summary:candidate.summary, candidate.status, json(merged), firstAt, lastAt, row.id);
          const after = this._map(this.db.prepare('SELECT * FROM consolidated_memories WHERE id=?').get(row.id));
          const current = this.db.prepare('SELECT * FROM consolidated_memories WHERE id=?').get(row.id); active.splice(active.indexOf(row), 1, current); byId.set(row.id, current);
          changes.push({ type: same ? 'repeat' : 'replace', id: row.id, before: same ? undefined : before, after }); if (same) repeated++; else updated++;
        } else {
          const sequence = Number(this.db.prepare("SELECT COALESCE(MAX(CAST(SUBSTR(id,4) AS INTEGER)),0)+1 AS n FROM consolidated_memories").get().n);
          const id = `cm-${sequence}`;
          const dates = candidate.evidence.map(source => rows.get(source.messageId).created_at).filter(Boolean).sort(); const firstAt = dates[0] || now, lastAt = dates.at(-1) || now;
          this.db.prepare('INSERT INTO consolidated_memories(id,scope,subject,kind,topic,summary,status,evidence_json,first_at,last_at,mentions) VALUES(?,?,?,?,?,?,?,?,?,?,1)').run(id, scope, candidate.subject, candidate.kind, candidate.topic, candidate.summary, candidate.status, json(candidate.evidence), firstAt, lastAt);
          const after = this._map(this.db.prepare('SELECT * FROM consolidated_memories WHERE id=?').get(id)); changes.push({ type: 'create', id, after }); created++;
          const inserted = this.db.prepare('SELECT * FROM consolidated_memories WHERE id=?').get(id); active.push(inserted); byId.set(id, inserted);
        }
      }
      this._enforceCapacity(scope, now, changes);
      const revision = state.revision + 1;
      this.db.prepare('UPDATE consolidated_memory_state SET revision=?,cursor_rowid=?,cursor_id=? WHERE scope=?').run(revision, through.rowid, through.id, scope);
      const counts = { sourceChars:[...rows.values()].reduce((sum,row)=>sum+row.text.length,0),summaryCharsBefore,summaryCharsAfter:this._active(scope).reduce((sum,row)=>sum+row.summary.length,0), rows: rows.size, candidates: candidates.length, ignored: ignored.size, created, updated, repeated, archived: changes.filter(change => change.type === 'archive').length };
      this.db.prepare('INSERT INTO consolidated_memory_audit(scope,revision,cursor_rowid,cursor_id,created_at,model,counts_json,coverage_json,changes_json) VALUES(?,?,?,?,?,?,?,?,?)').run(scope, revision, through.rowid, through.id, now, input.model == null ? null : text(input.model, 'model', 160), json(counts), json([...rows.keys()].map(messageId => ({ messageId, reason:ignored.get(messageId)||'retained' }))), json(changes));
      this.db.prepare('DELETE FROM consolidated_memory_audit WHERE scope=? AND run_id NOT IN (SELECT run_id FROM consolidated_memory_audit WHERE scope=? ORDER BY run_id DESC LIMIT ?)').run(scope, scope, MAX_AUDIT);
      return { status: 'updated', revision, cursor: { rowid: through.rowid, id: through.id }, stats: counts };
    });
  }
  reset(scope, { cursor, now } = {}) {
    scope = this._scope(scope); const at = iso(now);
    if (cursor != null && (!plain(cursor) || !Number.isInteger(cursor.rowid) || cursor.rowid < 0 || (cursor.id != null && typeof cursor.id !== 'string'))) invalid('cursor is invalid');
    return this.store.transaction(() => {
      const state = this._state(scope); let next = cursor;
      if (!next) next = this.db.prepare(`SELECT rowid,id FROM recall_messages WHERE role=? AND kind<>'story'
        AND (speaker='user' OR rowid>COALESCE((SELECT CAST(value AS INTEGER) FROM metadata WHERE key='persona_cutoff:'||recall_messages.role),0)) ORDER BY rowid DESC LIMIT 1`).get(scope) || { rowid: 0, id: null };
      if (next.rowid && (!next.id || !this._canonical(scope, next.id)?.rowid || this._canonical(scope, next.id).rowid !== next.rowid)) invalid('cursor is not canonical');
      const removed = this.db.prepare('SELECT id FROM consolidated_memories WHERE scope=? AND active=1 ORDER BY id').all(scope).map(row => row.id);
      this.db.prepare('DELETE FROM consolidated_memories WHERE scope=?').run(scope);
      const revision = state.revision + 1;
      this.db.prepare('UPDATE consolidated_memory_state SET revision=?,cursor_rowid=?,cursor_id=? WHERE scope=?').run(revision, next.rowid, next.id || null, scope);
      this.db.prepare('INSERT INTO consolidated_memory_audit(scope,revision,cursor_rowid,cursor_id,created_at,model,counts_json,coverage_json,changes_json) VALUES(?,?,?,?,?,?,?,?,?)').run(scope, revision, next.rowid, next.id || null, at, 'explicit-reset', json({ reset: true, removed: removed.length }), '[]', json(removed.map(id => ({ type: 'reset', id }))));
      this.db.prepare('DELETE FROM consolidated_memory_audit WHERE scope=? AND run_id NOT IN (SELECT run_id FROM consolidated_memory_audit WHERE scope=? ORDER BY run_id DESC LIMIT ?)').run(scope, scope, MAX_AUDIT);
      return { revision, cursor: { rowid: next.rowid, id: next.id || null }, removed: removed.length };
    });
  }
  _enforceCapacity(scope, now, changes) {
    let rows = this._active(scope), chars = rows.reduce((sum, row) => sum + row.summary.length, 0);
    const archive = row => { this.db.prepare('UPDATE consolidated_memories SET active=0,archived_at=? WHERE id=?').run(now, row.id); changes.push({ type: 'archive', id: row.id }); rows = rows.filter(item => item.id !== row.id); chars -= row.summary.length; };
    const ordered = () => [...rows].sort((a, b) => {
      const ap = a.kind === 'boundary' || (a.kind === 'agreement' && a.status === 'ongoing'); const bp = b.kind === 'boundary' || (b.kind === 'agreement' && b.status === 'ongoing');
      return Number(ap) - Number(bp) || a.last_at.localeCompare(b.last_at) || a.id.localeCompare(b.id);
    });
    while (rows.length > MAX_ITEMS || chars > MAX_SUMMARY_CHARS) archive(ordered()[0]);
    this.db.prepare(`DELETE FROM consolidated_memories WHERE id IN (
      SELECT id FROM consolidated_memories WHERE scope=? AND active=0 ORDER BY archived_at DESC,id DESC LIMIT -1 OFFSET 100
    )`).run(scope);
  }
  context(scope, { suppressedSourceIds = [], characterQuery, includeCharacter = true } = {}) {
    scope = this._scope(scope); if (!Array.isArray(suppressedSourceIds) || suppressedSourceIds.some(id => typeof id !== 'string')) invalid('suppressedSourceIds is invalid'); const suppressed = new Set([...suppressedSourceIds, ...this._suppressed(scope)]);
    if (characterQuery !== undefined && typeof characterQuery !== 'string') invalid('characterQuery is invalid');
    if (typeof includeCharacter !== 'boolean') invalid('includeCharacter is invalid');
    const projected = characterQuery !== undefined;
    const tokens = projected ? queryTokens(characterQuery) : null;
    const lines = [];
    let projectedCharacterItems = 0, projectedCharacterChars = 0;
    const ordered = this._active(scope).sort((a, b) => {
      const ap = a.kind === 'boundary' || (a.kind === 'agreement' && a.status === 'ongoing'); const bp = b.kind === 'boundary' || (b.kind === 'agreement' && b.status === 'ongoing');
      return Number(bp) - Number(ap) || a.id.localeCompare(b.id);
    });
    for (const item of ordered) {
      if (!includeCharacter && item.subject === 'character' && item.kind !== 'boundary') continue;
      const evidence = parse(item.evidence_json); if (evidence.some(source => !this._evidenceVisible(scope, source, suppressed))) continue;
      const line = `[${item.id} ${item.subject}/${item.kind} ${item.status} ${item.last_at.slice(0,10)}] ${item.summary} (source:${evidence.at(-1)?.messageId})`;
      // An ordinary turn should retain user facts and durable shared agreements,
      // but not keep injecting the character's old life log.  A supplied query
      // restores matching character material and topics from either person.
      // A previously discussed scene or opinion is not a permanent instruction.
      const queryScoped = (item.subject === 'character' && item.kind !== 'boundary') || item.kind === 'topic';
      if (projected && queryScoped) {
        if (!queryMatches(item, tokens)) continue;
        if (projectedCharacterItems >= PROJECTED_CHARACTER_ITEMS || projectedCharacterChars + line.length > PROJECTED_CHARACTER_CHARS) continue;
        projectedCharacterItems += 1; projectedCharacterChars += line.length;
      }
      if ((lines.join('\n').length + (lines.length ? 1 : 0) + line.length) > 28000) break; lines.push(line);
    }
    return lines.join('\n');
  }
  recordFailure(scope,{now,sourceIds=[],code='MEMORY_RESPONSE_INVALID'}={}) {
    scope=this._scope(scope);const state=this._state(scope);
    const coverage=sourceIds.filter(id=>this._canonical(scope,id)).map(messageId=>({messageId,reason:'pending_retry'}));
    this.store.transaction(()=>{
      this.db.prepare('INSERT INTO consolidated_memory_audit(scope,revision,cursor_rowid,cursor_id,created_at,model,counts_json,coverage_json,changes_json) VALUES(?,?,?,?,?,?,?,?,?)')
        .run(scope,state.revision,state.cursor_rowid,state.cursor_id,iso(now),null,json({failed:true,rows:coverage.length,reason:['INVALID_CONSOLIDATED_MEMORY','MEMORY_RESPONSE_INVALID'].includes(code)?code:'MODEL_FAILED'}),json(coverage),'[]');
      this.db.prepare('DELETE FROM consolidated_memory_audit WHERE scope=? AND run_id NOT IN (SELECT run_id FROM consolidated_memory_audit WHERE scope=? ORDER BY run_id DESC LIMIT ?)').run(scope,scope,MAX_AUDIT);
    });
  }
  review(scope, { limit = 10 } = {}) {
    scope = this._scope(scope); if (!Number.isInteger(limit) || limit < 1 || limit > 100) invalid('limit is invalid'); const state = this._state(scope);
    const suppressed = this._suppressed(scope);
    const visible = item => !item || item.evidence?.every(source => this._evidenceVisible(scope, source, suppressed));
    const items = this._active(scope).map(row => this._map(row)).filter(visible);
    const counts = this.db.prepare('SELECT COUNT(*) AS total, SUM(active) AS active FROM consolidated_memories WHERE scope=?').get(scope);
    const runs = this.db.prepare('SELECT * FROM consolidated_memory_audit WHERE scope=? ORDER BY run_id DESC LIMIT ?').all(scope, limit).map(run => {
      const changes = parse(run.changes_json).map(change => (visible(change.after) && visible(change.before)) ? change : { type: change.type, id: change.id, redacted: true });
      const coverage = parse(run.coverage_json).filter(source => !suppressed.has(source.messageId) && this._canonical(scope, source.messageId));
      return { id:run.run_id, revision: run.revision, cursor: { rowid: run.cursor_rowid, id: run.cursor_id }, createdAt: run.created_at, model: run.model, counts: parse(run.counts_json, {}), coverage, changes };
    });
    return { revision: state.revision, cursor: { rowid: state.cursor_rowid, id: state.cursor_id }, items, counts: { total: Number(counts.total), active: Number(counts.active || 0) }, runs };
  }
}
