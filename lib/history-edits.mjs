import { createHash } from 'node:crypto';

export const historySourceHash = (text) => createHash('sha256').update(String(text)).digest('hex');

const invalid = (message) => Object.assign(new Error(message), { code: 'INVALID_HISTORY_EDIT' });
const stamp = (clock) => new Date(clock()).toISOString();

function normalizeEdit(edit) {
  if (!edit || typeof edit !== 'object' || typeof edit.id !== 'string' || !edit.id ||
      typeof edit.sourceHash !== 'string' || !/^[a-f0-9]{64}$/i.test(edit.sourceHash) ||
      (typeof edit.replacement !== 'string' && !Array.isArray(edit.keptSpans)) || typeof edit.reason !== 'string' || !edit.reason.trim() || edit.reason.length > 2000) throw invalid('Invalid history edit');
  if (edit.replacement !== undefined && (typeof edit.replacement !== 'string' || edit.replacement.length > 16000 || edit.keptSpans !== undefined)) throw invalid('Use either replacement or kept spans');
  let previous = 0;
  const keptSpans = (edit.keptSpans || []).map((span, index) => {
    if (!span || !Number.isInteger(span.start) || !Number.isInteger(span.end) ||
        span.start < 0 || span.end <= span.start || (index && span.start < previous)) throw invalid('Invalid kept spans');
    previous = span.end;
    return { start: span.start, end: span.end };
  });
  return { id: edit.id, sourceHash: edit.sourceHash.toLowerCase(), keptSpans, replacement:edit.replacement ?? null, reason: edit.reason };
}

function textFor(row, spans) { return spans.map(({ start, end }) => row.text.slice(start, end)).join('\n'); }

export class HistoryEdits {
  constructor(store, { clock = () => new Date() } = {}) {
    this.store = store;
    this.clock = clock;
    store.db.exec(`CREATE TABLE IF NOT EXISTS companion_history_edits (
      message_id TEXT PRIMARY KEY, role TEXT NOT NULL, source_hash TEXT NOT NULL,
      kept_spans_json TEXT NOT NULL, reason TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    if (!store.db.prepare('PRAGMA table_info(companion_history_edits)').all().some(column=>column.name==='replacement_text')) store.db.exec('ALTER TABLE companion_history_edits ADD COLUMN replacement_text TEXT');
    store.db.exec(`CREATE TABLE IF NOT EXISTS companion_history_edit_audit (
      id INTEGER PRIMARY KEY, message_id TEXT NOT NULL,role TEXT NOT NULL, action TEXT NOT NULL,
      before_json TEXT,after_json TEXT,created_at TEXT NOT NULL
    )`);
  }

  set(role, edits) {
    if (typeof role !== 'string' || !role || !Array.isArray(edits)) throw invalid('Invalid history edit batch');
    const normalized = edits.map(normalizeEdit);
    if (new Set(normalized.map(edit => edit.id)).size !== normalized.length) throw invalid('Duplicate message id');
    return this.store.transaction(() => {
      const message = this.store.db.prepare('SELECT id,role,speaker,text,kind FROM messages WHERE id=? AND role=?');
      for (const edit of normalized) {
        const row = message.get(edit.id, role);
        if (!row || row.speaker !== 'assistant' || row.kind === 'story') throw invalid('Only assistant chat messages may be edited');
        if (historySourceHash(row.text) !== edit.sourceHash) throw invalid('Source text changed');
        if (edit.keptSpans.some(span => span.end > row.text.length)) throw invalid('Kept span exceeds source text');
      }
      const save = this.store.db.prepare(`INSERT INTO companion_history_edits(message_id,role,source_hash,kept_spans_json,reason,updated_at,replacement_text)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET role=excluded.role,source_hash=excluded.source_hash,
        kept_spans_json=excluded.kept_spans_json,reason=excluded.reason,updated_at=excluded.updated_at,replacement_text=excluded.replacement_text`);
      const updatedAt = stamp(this.clock);
      for (const edit of normalized) {
        const previous=this.store.db.prepare('SELECT * FROM companion_history_edits WHERE message_id=?').get(edit.id);
        this.store.db.prepare('INSERT INTO companion_history_edit_audit(message_id,role,action,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)').run(edit.id,role,'set',previous?JSON.stringify(previous):null,JSON.stringify(edit),updatedAt);
        save.run(edit.id, role, edit.sourceHash, JSON.stringify(edit.keptSpans), edit.reason, updatedAt,edit.replacement);
      }
      return { count: normalized.length };
    });
  }

  project(role, rows) {
    if (!Array.isArray(rows)) throw invalid('Rows must be an array');
    const lookup = this.store.db.prepare('SELECT source_hash,kept_spans_json,replacement_text FROM companion_history_edits WHERE message_id=? AND role=?');
    return rows.flatMap(row => {
      if (!row || row.role !== role || row.speaker !== 'assistant' || row.kind === 'story') return [row];
      const saved = lookup.get(row.id, role);
      if (!saved || historySourceHash(row.text) !== saved.source_hash) return [row];
      if (saved.replacement_text !== null) return saved.replacement_text.trim() ? [{...row,text:saved.replacement_text}] : [];
      let spans;
      try { spans = JSON.parse(saved.kept_spans_json); } catch { return [row]; }
      if (!Array.isArray(spans) || spans.some(span => !span || !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > row.text.length)) return [row];
      if (!spans.length) return [];
      return [{ ...row, text: textFor(row, spans) }];
    });
  }

  stats(role) {
    const rows = this.store.db.prepare(`SELECT m.text,e.source_hash,e.kept_spans_json,e.replacement_text
      FROM companion_history_edits e JOIN messages m ON m.id=e.message_id
      WHERE e.role=? AND m.role=? AND m.speaker='assistant' AND m.kind<>'story'`).all(role, role);
    let active = 0, stale = 0, originalChars = 0, keptChars = 0;
    for (const row of rows) {
      if (historySourceHash(row.text) !== row.source_hash) { stale++; continue; }
      if (row.replacement_text !== null) { active++; originalChars+=row.text.length; keptChars+=row.replacement_text.length; continue; }
      try {
        const spans = JSON.parse(row.kept_spans_json);
        if (!Array.isArray(spans) || spans.some(span => !Number.isInteger(span.start) || !Number.isInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > row.text.length)) { stale++; continue; }
        active++; originalChars += row.text.length; keptChars += spans.reduce((sum, span) => sum + span.end - span.start, 0);
      } catch { stale++; }
    }
    return { active, stale, originalChars, keptChars };
  }

  revision(role) {
    if (typeof role !== 'string' || !role) throw invalid('Invalid history edit role');
    return Number(this.store.db.prepare('SELECT COALESCE(MAX(id), 0) AS revision FROM companion_history_edit_audit WHERE role=?').get(role).revision);
  }

  remove(role, ids) {
    if (typeof role !== 'string' || !role || !Array.isArray(ids) || ids.some(id => typeof id !== 'string' || !id)) throw invalid('Invalid removal');
    if (new Set(ids).size !== ids.length) throw invalid('Duplicate message id');
    return this.store.transaction(() => {
      const remove = this.store.db.prepare('DELETE FROM companion_history_edits WHERE role=? AND message_id=?');
      let count = 0;
      for (const id of ids) {
        const previous=this.store.db.prepare('SELECT * FROM companion_history_edits WHERE message_id=? AND role=?').get(id,role);
        if(previous)this.store.db.prepare('INSERT INTO companion_history_edit_audit(message_id,role,action,before_json,after_json,created_at) VALUES(?,?,?,?,?,?)').run(id,role,'remove',JSON.stringify(previous),null,stamp(this.clock));
        count += remove.run(role, id).changes;
      }
      return { count };
    });
  }

  list(role,{limit=100,offset=0}={}) {
    return this.store.db.prepare(`SELECT m.id,m.role,m.speaker,m.kind,m.text,m.created_at AS createdAt,e.reason,e.updated_at AS updatedAt,e.source_hash AS sourceHash
      FROM companion_history_edits e JOIN messages m ON m.id=e.message_id WHERE e.role=? ORDER BY m.created_at DESC,m.rowid DESC LIMIT ? OFFSET ?`).all(role,Math.min(500,Math.max(1,Number(limit)||100)),Math.max(0,Number(offset)||0)).map(row=>({...row,original:row.text,corrected:this.project(role,[row])[0]?.text||'',stale:historySourceHash(row.text)!==row.sourceHash}));
  }
}
