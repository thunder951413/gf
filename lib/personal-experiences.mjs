const ROLE_ID = 'miyue';
const KINDS = new Set(['reading', 'film', 'daily']);
const PAST_ACTION = /读过|看过|读了|看了|翻过|读完|看完|去过|做过|试过|去了|做了|逛了|吃过|学过|住过/u;
const FIRST_PERSON = /我(?:也|曾|以前|之前|那时|当时)?/u;
const NEGATED_OR_FUTURE = /没读过|没有读过|还没(?:读|看)|没看过|没有看过|想看|准备|打算/u;
const FIRST_PERSON_IMPRESSION = /我(?:觉得|喜欢|不喜欢|记得|最爱|印象里|会觉得|总觉得)|(?:让我|令我|对我)/u;

function clean(value, maximum) {
  if (typeof value !== 'string') return null;
  const text = value.normalize('NFC').trim();
  return text && text.length <= maximum ? text : null;
}

function normalizedTitle(value) {
  const text = clean(value, 100);
  return text?.normalize('NFKC').replace(/[《》“”"'‘’]/gu, '').replace(/\s+/gu, ' ').toLocaleLowerCase('zh-CN') || null;
}

function clip(value, maximum) {
  const text = String(value || '').trim();
  return text.length <= maximum ? text : `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

function isOwnPastExperience(text, { allowSubjectless = false } = {}) {
  if (!text || NEGATED_OR_FUTURE.test(text)) return false;
  const first = text.search(FIRST_PERSON);
  const action = text.search(PAST_ACTION);
  return action >= 0 && (allowSubjectless || (first >= 0 && action >= first));
}

function isOwnStatement(text, options) {
  return !NEGATED_OR_FUTURE.test(text) && (isOwnPastExperience(text, options) || FIRST_PERSON_IMPRESSION.test(text));
}

function titleFrom(text) {
  const match = String(text || '').match(/《\s*([^《》]{1,100}?)\s*》/u);
  return match?.[1]?.trim() || null;
}

function unquotedUserTitle(text) {
  const match = String(text || '').match(/(?:读过|看过|读了|看了|读完|看完)\s*([\p{Script=Han}A-Za-z0-9·._-]{2,100}?)(?:吗|么|呢|呀|啊|[？?!！，。]|$)/u);
  const title = match?.[1]?.trim();
  if (!title || /^(?:这|那|一本|这本|那本)?(?:书|电影|片子|影片|剧|小说)$/u.test(title)) return null;
  return title;
}

function clauses(text) {
  return String(text || '').split(/[。！？!?；;\n]/u).map((part) => part.trim()).filter(Boolean);
}

function kindFrom(text) {
  return /电影|影片|片子|剧|看过|看了|看完/u.test(text) && !/读过|读了|读完|翻过/u.test(text) ? 'film' : 'reading';
}

function mapRow(row) {
  return {
    kind: row.kind,
    title: row.title,
    summary: row.summary,
    evidence: row.evidence,
    messageId: row.message_id,
    source: row.source,
    createdAt: row.created_at,
  };
}

export class PersonalExperiences {
  constructor(store, { clock = () => new Date() } = {}) {
    if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('PersonalExperiences requires a Store');
    this.store = store;
    this.clock = clock;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS personal_experiences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('reading','film','daily')),
        title TEXT NOT NULL,
        title_normalized TEXT NOT NULL,
        summary TEXT NOT NULL,
        evidence TEXT NOT NULL,
        message_id TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source='fictional_conversation'),
        created_at TEXT NOT NULL,
        UNIQUE(role_id, message_id, title_normalized)
      );
      CREATE INDEX IF NOT EXISTS personal_experiences_role_title_time
        ON personal_experiences(role_id, title_normalized, id DESC);
    `);
  }

  #now() {
    const date = this.clock();
    const value = date instanceof Date ? date : new Date(date);
    return Number.isNaN(value.valueOf()) ? new Date().toISOString() : value.toISOString();
  }

  #candidate(candidate, assistant, userText) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
    const kind = candidate.kind;
    const title = clean(candidate.title, 100);
    const summary = clean(candidate.summary, 240);
    const evidence = clean(candidate.evidence, 240);
    if (!KINDS.has(kind) || !title || !summary || !evidence || !assistant.text.includes(evidence)) return null;
    const normalized = normalizedTitle(title);
    if (!normalized || !(assistant.text.includes(title) || userText.includes(title))) return null;
    const userNamesTitle = userText.includes(title);
    if (!isOwnStatement(evidence, { allowSubjectless: userNamesTitle }) || (/^\s*你/u.test(evidence) && !isOwnPastExperience(evidence))) return null;
    return { kind, title, summary, evidence, messageId: assistant.id };
  }

  #fallback(assistant, userText) {
    const found = [];
    for (const clause of clauses(assistant.text)) {
      const title = titleFrom(clause) || titleFrom(userText) || unquotedUserTitle(userText);
      if (!title) continue;
      const userNamesTitle = userText.includes(title);
      if (!isOwnPastExperience(clause, { allowSubjectless: userNamesTitle }) || (/^\s*你/u.test(clause) && !isOwnPastExperience(clause))) continue;
      found.push({ kind: kindFrom(clause), title, summary: clip(clause, 240), evidence: clip(clause, 240), messageId: assistant.id });
    }
    return found;
  }

  observe(roleId, messagesArray, candidate = null) {
    if (roleId !== ROLE_ID || !Array.isArray(messagesArray)) return [];
    const messages = messagesArray.filter((message) => message && message.role === roleId && typeof message.id === 'string' && typeof message.text === 'string');
    const assistant = [...messages].reverse().find((message) => message.speaker === 'assistant');
    if (!assistant) return [];
    const userText = messages.filter((message) => message.speaker === 'user').map((message) => message.text).join('\n');
    const proposed = this.#candidate(candidate, assistant, userText);
    const entries = proposed ? [proposed] : this.#fallback(assistant, userText);
    const unique = [];
    const seen = new Set();
    for (const entry of entries) {
      const key = normalizedTitle(entry.title);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      unique.push(entry);
      if (unique.length === 2) break;
    }
    if (!unique.length) return [];
    return this.store.transaction(() => {
      const insert = this.store.db.prepare(`INSERT OR IGNORE INTO personal_experiences
        (role_id,kind,title,title_normalized,summary,evidence,message_id,source,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`);
      const get = this.store.db.prepare(`SELECT kind,title,summary,evidence,message_id,source,created_at
        FROM personal_experiences WHERE role_id=? AND message_id=? AND title_normalized=?`);
      const rows = [];
      for (const entry of unique) {
        const normalized = normalizedTitle(entry.title);
        insert.run(roleId, entry.kind, entry.title, normalized, entry.summary, entry.evidence, entry.messageId, 'fictional_conversation', this.#now());
        const row = get.get(roleId, entry.messageId, normalized);
        if (row) rows.push(mapRow(row));
      }
      return rows;
    });
  }

  list(roleId, limit = 30) {
    if (roleId !== ROLE_ID) return [];
    const count = Math.max(0, Math.min(30, Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 30));
    if (!count) return [];
    return this.store.db.prepare(`SELECT kind,title,summary,evidence,message_id,source,created_at FROM (
      SELECT *, ROW_NUMBER() OVER (PARTITION BY title_normalized ORDER BY id DESC) AS version
      FROM personal_experiences WHERE role_id=?
    ) WHERE version=1 ORDER BY id DESC LIMIT ?`).all(roleId, count).map(mapRow);
  }

  context(roleId, text = '', maxChars = 600) {
    if (roleId !== ROLE_ID) return '';
    const maximum = Math.max(0, Math.min(600, Number.isFinite(Number(maxChars)) ? Math.trunc(Number(maxChars)) : 600));
    if (!maximum) return '';
    const all = this.list(roleId, 30);
    const query = String(text || '').normalize('NFKC').toLocaleLowerCase('zh-CN');
    const relevant = query ? all.filter((entry) => {
      const title = normalizedTitle(entry.title);
      return title && (query.includes(title) || title.includes(query));
    }) : [];
    const selected = relevant.length ? relevant.slice(0, 2) : all.slice(0, 1);
    if (!selected.length) return '';
    const output = ['【角色虚构经历（不是用户经历／不是已核实网络资料）】', ...selected.map((entry) => `${entry.kind}｜${entry.title}：${entry.summary}（证据：${entry.evidence}）`)].join('\n');
    return clip(output, maximum);
  }
}
