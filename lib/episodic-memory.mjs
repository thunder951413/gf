import { createHash } from 'node:crypto';

const ACTIVE_LIMIT = 100;
const LABEL_LIMIT = 80;
const CORRECTION_LIMIT = 1_000;
const SOURCE_LIMIT = 8;
const DEFAULT_RETRIEVAL_LIMIT = 3;
const DEFAULT_CHAR_BUDGET = 1_500;
const COOLDOWN_TURNS = 3;
const COOLDOWN_MS = 6 * 60 * 60_000;

function invalid(message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID_EPISODIC_MEMORY' });
}

function asDate(clock) {
  const value = clock();
  const date = value instanceof Date ? new Date(value.valueOf()) : new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error('Episodic memory clock returned an invalid date');
  return date;
}

function normalizeScope(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200) throw invalid('记忆范围无效');
  return value.trim();
}

function boundedInteger(value, fallback, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(0, Math.min(maximum, Math.trunc(number)));
}

function ownerOf(scope) {
  const marker = scope.indexOf('::scenario:');
  return marker < 0 ? scope : scope.slice(0, marker);
}

function episodeId(scope, messageIds) {
  const digest = createHash('sha256').update(JSON.stringify([scope, ...messageIds])).digest('hex').slice(0, 24);
  return `episode-${digest}`;
}

function sourceKey(messageIds) {
  return messageIds.join('\u001f');
}

function cleanText(value) {
  return String(value ?? '').trim();
}

const GENERIC = new Set([
  '好', '好的', '好呀', '好啊', '行', '可以', '嗯', '嗯嗯', '哦', '知道了', '收到', '谢谢', '谢谢你',
  '不客气', '没事', '晚安', '早安', '哈哈', '哈哈哈', 'ok', 'okay', 'thanks', 'thank you', 'yes', 'no',
]);

function isBoilerplate(value) {
  const text = cleanText(value).toLowerCase().replace(/[\s，。！？、,.!?~～]+/g, '');
  if (!text) return true;
  if (GENERIC.has(text)) return true;
  return text.length <= 3 && /^(好|行|嗯|哦|哈|谢|ok|yes|no)+$/iu.test(text);
}

const CUES = [
  ['preference', /喜欢|偏爱|讨厌|不喜欢|更想|宁愿|习惯|最爱|favorite|favourite|prefer|dislike/iu],
  ['comparison', /比起|相比|比较像|更像|不如|还是.+更|versus|compare|rather than/iu],
  ['disagreement', /不同意|不赞同|不认同|反对|我觉得不是|你说.+但|争论|分歧|disagree|don't agree|do not agree/iu],
  ['advice', /建议|要不要|不妨|应该|可以试试|最好|劝|提醒|recommend|advice|suggest|you should/iu],
  ['shared-joke', /玩笑|笑话|梗|暗号|外号|哈哈哈|笑死|逗你|joke|inside joke|nickname/iu],
];

function meaningfulPair(user, assistant) {
  const userText = cleanText(user.text);
  const assistantText = cleanText(assistant.text);
  if (isBoilerplate(userText) || isBoilerplate(assistantText)) return null;
  if (userText.length < 4 || assistantText.length < 6) return null;
  const combined = `${userText}\n${assistantText}`;
  for (const [category, pattern] of CUES) if (pattern.test(combined)) return category;
  return null;
}

const TOKEN_STOP = new Set([
  'the', 'and', 'that', 'this', 'with', 'you', 'your', 'was', 'are', 'have', 'for', 'but', 'not',
  '我们', '你们', '他们', '这个', '那个', '可以', '好的', '谢谢', '觉得', '一个', '什么', '怎么', '之前',
]);

function tokens(value) {
  const text = cleanText(value).toLowerCase();
  const result = new Set();
  for (const word of text.match(/[a-z0-9][a-z0-9_-]{1,}/g) || []) if (!TOKEN_STOP.has(word)) result.add(word);
  for (const run of text.match(/[\p{Script=Han}]+/gu) || []) {
    if (run.length === 1) result.add(run);
    for (let index = 0; index < run.length - 1; index += 1) {
      const token = run.slice(index, index + 2);
      if (!TOKEN_STOP.has(token) && !GENERIC.has(token)) result.add(token);
    }
  }
  return result;
}

function overlapScore(queryTokens, value) {
  const candidate = tokens(value);
  let overlap = 0;
  for (const token of queryTokens) if (candidate.has(token)) overlap += token.length > 2 ? 1.25 : 1;
  return overlap;
}

function quoteContext(entry) {
  const lines = [`【共同经历证据；条目 ID：${entry.id}${entry.corrected ? '；原话已被用户更正' : ''}】`];
  for (const quote of entry.quotes) {
    const attribution = entry.corrected
      ? quote.speaker === 'user'
        ? '用户当时说（原话已过时，仅作证据；以用户更正为准）'
        : '角色当时说（角色表达或虚构叙事，不是客观事实；原话已过时，以用户更正为准）'
      : quote.speaker === 'user'
        ? '用户当时说（原话）'
        : '角色当时说（角色表达或虚构叙事，不是客观事实）';
    lines.push(`消息 ID：${quote.id}；时间：${quote.createdAt}；${attribution}`);
    lines.push('【原话开始】', quote.text, '【原话结束】');
  }
  if (entry.corrected) lines.push('【用户更正开始；当前应以此为准】', entry.correction, '【用户更正结束】');
  return lines.join('\n');
}

export class EpisodicMemoryRepository {
  constructor(store, { clock = () => new Date() } = {}) {
    if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('EpisodicMemoryRepository requires a Store');
    this.store = store;
    this.db = store.db;
    this.clock = clock;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS scenario_message_scope (
        message_id TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
        scope TEXT NOT NULL
      );
      CREATE VIEW IF NOT EXISTS recall_messages AS
        SELECT m.rowid AS rowid,m.id,COALESCE(s.scope,m.role) AS role,m.speaker,m.text,m.kind,m.content_id,m.created_at
        FROM messages m LEFT JOIN scenario_message_scope s ON s.message_id=m.id;
      CREATE TABLE IF NOT EXISTS episodic_memory_state (
        scope TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 0,
        observed_turn INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS episodic_memory_entries (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        owner_scope TEXT NOT NULL,
        source_key TEXT NOT NULL,
        origin TEXT NOT NULL CHECK(origin IN ('automatic','manual')),
        category TEXT,
        label TEXT,
        pinned INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','tombstone')),
        correction TEXT,
        corrected_at TEXT,
        last_used_at TEXT,
        cooldown_until_turn INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(scope, source_key)
      );
      CREATE INDEX IF NOT EXISTS episodic_memory_scope_status
        ON episodic_memory_entries(scope,status,created_at);
      CREATE INDEX IF NOT EXISTS episodic_memory_owner_status
        ON episodic_memory_entries(owner_scope,status,created_at);
      CREATE TABLE IF NOT EXISTS episodic_memory_quotes (
        entry_id TEXT NOT NULL REFERENCES episodic_memory_entries(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        speaker TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(entry_id,ordinal),
        UNIQUE(entry_id,message_id)
      );
      CREATE TABLE IF NOT EXISTS episodic_memory_observed (
        scope TEXT NOT NULL,
        message_id TEXT NOT NULL,
        PRIMARY KEY(scope,message_id)
      );
    `);
    if(!this.db.prepare('PRAGMA table_info(episodic_memory_entries)').all().some(c=>c.name==='retired_reason'))this.db.exec('ALTER TABLE episodic_memory_entries ADD COLUMN retired_reason TEXT');
  }

  _ensure(scope) {
    const normalized = normalizeScope(scope);
    this.db.prepare('INSERT OR IGNORE INTO episodic_memory_state(scope) VALUES(?)').run(normalized);
    return normalized;
  }

  _now() {
    return asDate(this.clock);
  }

  _canonical(scope, references, { objects = false, maximum = SOURCE_LIMIT } = {}) {
    if (!Array.isArray(references) || !references.length || references.length > maximum) {
      throw invalid(`消息引用必须包含 1 到 ${maximum} 条记录`);
    }
    const seen = new Set();
    const canonical = [];
    const statement = this.db.prepare(`
      SELECT rowid,id,role,speaker,text,kind,created_at
      FROM recall_messages
      WHERE id=? AND role=? AND kind<>'story'
        AND (speaker='user' OR rowid>COALESCE((SELECT CAST(value AS INTEGER) FROM metadata WHERE key='persona_cutoff:'||recall_messages.role),0))
    `);
    for (const reference of references) {
      const id = objects ? reference?.id : reference;
      if (typeof id !== 'string' || !id || seen.has(id)) throw invalid('消息引用无效或重复');
      seen.add(id);
      const row = statement.get(id, scope);
      if (!row) throw invalid(`消息 ${id} 不属于当前记忆范围或不可用于记忆`);
      if (objects) {
        if (typeof reference.text !== 'string' || reference.text !== row.text) throw invalid(`消息 ${id} 的文本与已提交记录不一致`);
        if (reference.speaker !== undefined && reference.speaker !== row.speaker) throw invalid(`消息 ${id} 的说话者与已提交记录不一致`);
        if (reference.role !== undefined && reference.role !== ownerOf(scope)) throw invalid(`消息 ${id} 的角色与已提交记录不一致`);
        if (reference.kind !== undefined && reference.kind !== row.kind) throw invalid(`消息 ${id} 的类型与已提交记录不一致`);
        if (reference.createdAt !== undefined && String(reference.createdAt) !== row.created_at) throw invalid(`消息 ${id} 的时间与已提交记录不一致`);
      }
      canonical.push(row);
    }
    canonical.sort((left, right) => left.rowid - right.rowid);
    return canonical;
  }

  _entry(id) {
    const row = this.db.prepare('SELECT * FROM episodic_memory_entries WHERE id=?').get(id);
    if (!row) return null;
    const quotes = this.db.prepare('SELECT message_id,speaker,text,created_at FROM episodic_memory_quotes WHERE entry_id=? ORDER BY ordinal').all(id)
      .map((quote) => ({ id: quote.message_id, speaker: quote.speaker, text: quote.text, createdAt: quote.created_at }));
    const entry = {
      id: row.id,
      scope: row.scope,
      origin: row.origin,
      category: row.category || null,
      label: row.label || null,
      pinned: Boolean(row.pinned),
      status: row.status,
      corrected: Boolean(row.correction),
      correction: row.correction || null,
      correctedAt: row.corrected_at || null,
      lastUsedAt: row.last_used_at || null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      quotes,
    };
    const suppressedBy = this._blockedBy(entry);
    return { ...entry, suppressed: row.status !== 'active' || suppressedBy.length > 0, suppressedBy };
  }

  _overrideIndex(scope) {
    const rows = this.db.prepare(`
      SELECT e.rowid AS entry_rowid,e.id,e.status,e.correction,e.corrected_at,q.message_id
      FROM episodic_memory_entries e
      JOIN episodic_memory_quotes q ON q.entry_id=e.id
      WHERE e.scope=? AND ((e.status='tombstone' AND COALESCE(e.retired_reason,'user')<>'capacity') OR e.correction IS NOT NULL)
      ORDER BY e.rowid
    `).all(scope);
    const index = new Map();
    for (const row of rows) {
      let override = index.get(row.message_id);
      if (!override) { override = { tombstones: new Set(), correction: null }; index.set(row.message_id, override); }
      if (row.status === 'tombstone') {
        override.tombstones.add(row.id);
        continue;
      }
      if (!override.correction
        || String(row.corrected_at).localeCompare(String(override.correction.correctedAt)) > 0
        || (row.corrected_at === override.correction.correctedAt && Number(row.entry_rowid) > override.correction.rowid)) {
        override.correction = { id: row.id, correctedAt: row.corrected_at, rowid: Number(row.entry_rowid) };
      }
    }
    return index;
  }

  _blockedBy(entry, overrideIndex = this._overrideIndex(entry.scope)) {
    const blockers = new Set();
    for (const quote of entry.quotes) {
      const override = overrideIndex.get(quote.id);
      if (!override) continue;
      for (const id of override.tombstones) if (id !== entry.id) blockers.add(id);
      if (override.correction && override.correction.id !== entry.id) blockers.add(override.correction.id);
    }
    return [...blockers].sort();
  }

  _increment(scope, amount = 1) {
    if (amount > 0) this.db.prepare('UPDATE episodic_memory_state SET revision=revision+? WHERE scope=?').run(amount, scope);
  }

  _insert(scope, rows, { origin, category = null, label = null, pinned = false }) {
    const ids = rows.map((row) => row.id);
    const id = episodeId(scope, ids);
    const existing = this.db.prepare('SELECT * FROM episodic_memory_entries WHERE id=?').get(id);
    if (existing) return { entry: this._entry(id), created: false };

    if (origin === 'automatic') {
      const pinnedCount = Number(this.db.prepare("SELECT COUNT(*) AS n FROM episodic_memory_entries WHERE owner_scope=? AND status='active' AND pinned=1").get(ownerOf(scope)).n);
      if (pinnedCount >= ACTIVE_LIMIT) return { entry: null, created: false };
    }
    const now = this._now().toISOString();
    this.db.prepare(`
      INSERT INTO episodic_memory_entries(
        id,scope,owner_scope,source_key,origin,category,label,pinned,status,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,?,?, 'active',?,?)
    `).run(id, scope, ownerOf(scope), sourceKey(ids), origin, category, label, pinned ? 1 : 0, now, now);
    const insertQuote = this.db.prepare('INSERT INTO episodic_memory_quotes(entry_id,ordinal,message_id,speaker,text,created_at) VALUES(?,?,?,?,?,?)');
    rows.forEach((row, ordinal) => insertQuote.run(id, ordinal, row.id, row.speaker, row.text, row.created_at));
    this._increment(scope);
    this._enforceCap(ownerOf(scope), id);
    return { entry: this._entry(id), created: true };
  }

  _enforceCap(owner, protectedId) {
    const active = this.db.prepare("SELECT id,scope,pinned FROM episodic_memory_entries WHERE owner_scope=? AND status='active' ORDER BY created_at,rowid").all(owner);
    let excess = active.length - ACTIVE_LIMIT;
    if (excess <= 0) return;
    const now = this._now().toISOString();
    for (const row of active) {
      if (excess <= 0) break;
      if (row.pinned || row.id === protectedId) continue;
      const changed = this.db.prepare("UPDATE episodic_memory_entries SET status='tombstone',retired_reason='capacity',updated_at=? WHERE id=? AND status='active' AND pinned=0").run(now, row.id).changes;
      if (changed) {
        this._increment(row.scope);
        excess -= 1;
      }
    }
    if (excess > 0) throw invalid('已固定的共同经历已达到 100 条上限');
  }

  observe(scope, rows) {
    const normalized = this._ensure(scope);
    const canonical = this._canonical(normalized, rows, { objects: true, maximum: 100 });
    return this.store.transaction(() => {
      let newTurns = 0;
      const mark = this.db.prepare('INSERT OR IGNORE INTO episodic_memory_observed(scope,message_id) VALUES(?,?)');
      for (const row of canonical) if (row.speaker === 'user' && mark.run(normalized, row.id).changes) newTurns += 1;
      if (newTurns) this.db.prepare('UPDATE episodic_memory_state SET observed_turn=observed_turn+? WHERE scope=?').run(newTurns, normalized);

      const retained = [];
      for (let index = 1; index < canonical.length; index += 1) {
        const user = canonical[index - 1];
        const assistant = canonical[index];
        if (user.speaker !== 'user' || assistant.speaker !== 'assistant') continue;
        const category = meaningfulPair(user, assistant);
        if (!category) continue;
        const candidate = { id: episodeId(normalized, [user.id, assistant.id]), scope: normalized, quotes: [{ id: user.id }, { id: assistant.id }] };
        if (this._blockedBy(candidate).length) continue;
        const result = this._insert(normalized, [user, assistant], { origin: 'automatic', category });
        if (result.entry?.status === 'active') retained.push(result.entry);
      }
      return retained;
    });
  }

  remember(scope, messageIds, label) {
    const normalized = this._ensure(scope);
    if (label !== undefined && (typeof label !== 'string' || label.trim().length > LABEL_LIMIT)) throw invalid('标签最多 80 个字符');
    const normalizedLabel = typeof label === 'string' && label.trim() ? label.trim() : null;
    const rows = this._canonical(normalized, messageIds);
    return this.store.transaction(() => {
      const id = episodeId(normalized, rows.map((row) => row.id));
      const existing = this.db.prepare('SELECT * FROM episodic_memory_entries WHERE id=?').get(id);
      if (!existing) {
        const candidate = { id, scope: normalized, quotes: rows.map((row) => ({ id: row.id })) };
        if (this._blockedBy(candidate).length) throw invalid('这些原消息已被删除或更正；只能用完全相同的消息组合恢复原条目');
        return this._insert(normalized, rows, { origin: 'manual', label: normalizedLabel, pinned: true }).entry;
      }
      const now = this._now().toISOString();
      const changed = existing.pinned !== 1 || existing.status !== 'active' || existing.label !== normalizedLabel || existing.origin !== 'manual';
      if (changed) {
        this.db.prepare("UPDATE episodic_memory_entries SET origin='manual',label=?,pinned=1,status='active',updated_at=? WHERE id=?")
          .run(normalizedLabel, now, id);
        this._increment(normalized);
        this._enforceCap(ownerOf(normalized), id);
      }
      return this._entry(id);
    });
  }

  list(scope, { status = 'all' } = {}) {
    const normalized = this._ensure(scope);
    if (!['all', 'active', 'tombstone'].includes(status)) throw invalid('记忆状态无效');
    const rows = status === 'all'
      ? this.db.prepare('SELECT id FROM episodic_memory_entries WHERE scope=? ORDER BY created_at DESC,rowid DESC').all(normalized)
      : this.db.prepare('SELECT id FROM episodic_memory_entries WHERE scope=? AND status=? ORDER BY created_at DESC,rowid DESC').all(normalized, status);
    return rows.map(({ id }) => this._entry(id));
  }

  retrieve(scope, text, { limit = DEFAULT_RETRIEVAL_LIMIT, charBudget = DEFAULT_CHAR_BUDGET } = {}) {
    const normalized = this._ensure(scope);
    if (typeof text !== 'string' || isBoilerplate(text)) return [];
    const queryTokens = tokens(text);
    if (!queryTokens.size) return [];
    const count = boundedInteger(limit, DEFAULT_RETRIEVAL_LIMIT, 20);
    const budget = boundedInteger(charBudget, DEFAULT_CHAR_BUDGET, 20_000);
    if (!count || !budget) return [];
    const state = this.db.prepare('SELECT observed_turn FROM episodic_memory_state WHERE scope=?').get(normalized);
    const now = this._now().valueOf();
    const ranked = [];
    for (const entry of this.list(normalized, { status: 'active' })) {
      if (entry.suppressed) continue;
      const row = this.db.prepare('SELECT cooldown_until_turn,last_used_at FROM episodic_memory_entries WHERE id=?').get(entry.id);
      const withinTurns = Number(row.cooldown_until_turn) > Number(state.observed_turn);
      const recentlyUsed = row.last_used_at && now - new Date(row.last_used_at).valueOf() < COOLDOWN_MS;
      if (withinTurns && recentlyUsed) continue;
      let score = 0;
      for (const quote of entry.quotes) score += overlapScore(queryTokens, quote.text);
      if (entry.correction) score += overlapScore(queryTokens, entry.correction) * 1.1;
      if (entry.label) score += Math.min(1, overlapScore(queryTokens, entry.label) * 0.25);
      if (score <= 0) continue;
      score += entry.pinned ? 0.2 : 0;
      ranked.push({ entry, score });
    }
    ranked.sort((left, right) => right.score - left.score
      || Number(right.entry.pinned) - Number(left.entry.pinned)
      || right.entry.createdAt.localeCompare(left.entry.createdAt)
      || left.entry.id.localeCompare(right.entry.id));

    const selected = [];
    let used = '【可核验的共同经历引用资料】\n'.length + '\n引用只证明当时说过这些话；角色表达或虚构叙事不能当作客观事实。'.length;
    for (const { entry } of ranked) {
      if (selected.length >= count) break;
      const size = quoteContext(entry).length + (selected.length ? 2 : 0);
      if (used + size > budget) continue;
      selected.push(entry);
      used += size;
    }
    return selected;
  }

  context(entries, scope) {
    if (!Array.isArray(entries) || !entries.length) return '';
    const requestedScope = scope === undefined ? null : normalizeScope(typeof scope === 'object' ? scope?.scope : scope);
    const verified = [];
    for (const candidate of entries) {
      if (!candidate?.id) continue;
      const entry = this._entry(candidate.id);
      if (entry?.status === 'active' && !entry.suppressed && (!requestedScope || entry.scope === requestedScope)) verified.push(entry);
    }
    if (!verified.length) return '';
    return `【可核验的共同经历引用资料】\n${verified.map(quoteContext).join('\n\n')}\n引用只证明当时说过这些话；角色表达或虚构叙事不能当作客观事实。`;
  }

  remove(scope, id) {
    const normalized = this._ensure(scope);
    if (typeof id !== 'string' || !id) return false;
    return this.store.transaction(() => {
      const now = this._now().toISOString();
      const changed = this.db.prepare("UPDATE episodic_memory_entries SET status='tombstone',retired_reason='user',updated_at=? WHERE id=? AND scope=? AND status='active'")
        .run(now, id, normalized).changes;
      if (changed) this._increment(normalized);
      return Boolean(changed);
    });
  }

  correct(scope, id, note) {
    const normalized = this._ensure(scope);
    if (typeof id !== 'string' || !id) throw invalid('共同经历 ID 无效');
    if (typeof note !== 'string' || !note.trim() || note.trim().length > CORRECTION_LIMIT) throw invalid('更正内容必须为 1 到 1000 个字符');
    const normalizedNote = note.trim();
    return this.store.transaction(() => {
      const existing = this.db.prepare("SELECT correction FROM episodic_memory_entries WHERE id=? AND scope=? AND status='active'").get(id, normalized);
      if (!existing) throw invalid('找不到可更正的共同经历');
      if (existing.correction === normalizedNote) return this._entry(id);
      const now = this._now().toISOString();
      this.db.prepare('UPDATE episodic_memory_entries SET correction=?,corrected_at=?,updated_at=? WHERE id=?')
        .run(normalizedNote, now, now, id);
      this._increment(normalized);
      return this._entry(id);
    });
  }

  revision(scope) {
    const normalized = this._ensure(scope);
    return Number(this.db.prepare('SELECT revision FROM episodic_memory_state WHERE scope=?').get(normalized).revision);
  }

  suppressedSourceIds(scope) {
    const normalized = this._ensure(scope);
    return this.db.prepare(`
      SELECT DISTINCT q.message_id
      FROM episodic_memory_entries e
      JOIN episodic_memory_quotes q ON q.entry_id=e.id
      WHERE e.scope=? AND ((e.status='tombstone' AND COALESCE(e.retired_reason,'user')<>'capacity') OR e.correction IS NOT NULL)
      ORDER BY q.message_id
    `).all(normalized).map(({ message_id: id }) => id);
  }

  hasOverrides(scope) {
    const normalized = this._ensure(scope);
    return Boolean(this.db.prepare(`
      SELECT 1 FROM episodic_memory_entries
      WHERE scope=? AND ((status='tombstone' AND COALESCE(retired_reason,'user')<>'capacity') OR correction IS NOT NULL)
      LIMIT 1
    `).get(normalized));
  }

  markUsed(ids) {
    if (!Array.isArray(ids) || !ids.length) return 0;
    const unique = [...new Set(ids.filter((id) => typeof id === 'string' && id))];
    if (!unique.length) return 0;
    return this.store.transaction(() => {
      const now = this._now().toISOString();
      let changed = 0;
      for (const id of unique) {
        const row = this.db.prepare(`
          SELECT e.scope,e.last_used_at,e.cooldown_until_turn,s.observed_turn
          FROM episodic_memory_entries e JOIN episodic_memory_state s ON s.scope=e.scope
          WHERE e.id=? AND e.status='active'
        `).get(id);
        if (!row) continue;
        const until = Number(row.observed_turn) + COOLDOWN_TURNS;
        if (row.last_used_at === now && Number(row.cooldown_until_turn) === until) continue;
        this.db.prepare('UPDATE episodic_memory_entries SET last_used_at=?,cooldown_until_turn=? WHERE id=?').run(now, until, id);
        this._increment(row.scope);
        changed += 1;
      }
      return changed;
    });
  }
}
