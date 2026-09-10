import { randomUUID } from 'node:crypto';

const KINDS = new Set(['status', 'nickname', 'preference', 'boundary', 'shared_reference']);
const STATUSES = new Set(['friends', 'dating', 'partners']);
const SCOPES = new Set(['turn', 'today', 'persistent']);
const KEYS = Object.freeze({
  nickname: new Set(['user', 'companion', 'address_user', 'address_companion', 'user_nickname', 'companion_nickname']),
  preference: new Set(['communication', 'conversation', 'comfort', 'advice', 'contact', 'sharing', 'tone', 'affection', 'intimacy', 'nickname', 'food', 'drink', 'activity', 'reminders', 'privacy']),
  boundary: new Set(['relationship', 'intimacy', 'affection', 'flirtation', 'nickname', 'advice', 'contact', 'conversation', 'topic', 'privacy']),
  shared_reference: new Set(['topic', 'book', 'film', 'music', 'song', 'game', 'place', 'meal', 'joke', 'memory', 'activity', 'project']),
});
const INTIMACY_KEYS = new Set(['relationship', 'intimacy', 'affection', 'flirtation']);
const USER_PROPOSAL = /(我们正式交往吧|做我女朋友吧|我们以后就是恋人了)/u;
const ASSISTANT_PROPOSAL = /(做我(?:男|女)朋友(?:吧|好吗|好不好)?|和我(?:正式)?交往(?:吧|好吗|好不好)?)/u;
const ASSISTANT_ACCEPT = /(我(?:也|很)?愿意(?:呀|啊)?|愿意(?:呀|啊)|愿意做你女朋友|好啊|好呀|好，我们|好。我们|那我们(?:以后)?就是恋人)/u;
const USER_ACCEPT = /^(?:我愿意(?:呀|啊)?|愿意(?:呀|啊)?|好啊|好呀|好|可以|当然可以|嗯，我愿意)[。！!，, ]*$/u;
const USER_CLEAR = /(我们分手(?:吧|了)?|分手吧|只做普通朋友|做回(?:普通)?朋友|以后只做朋友)/u;
const GENERIC = /^(?:好|好的|嗯|嗯嗯|行|行吧|可以|知道了|收到|谢谢|哈哈+|ok|okay)[。！!，, ]*$/iu;
const HYPOTHETICAL = /(如果|假如|假设|比如|举例|写作|台词|小说|角色扮演|有人说|他说|她说)/u;
const QUOTED = /[“”「」『』‘’"']/u;
const RELATIONSHIP_NEGATION = /(不要|不想|别|并不|不是|不愿意).{0,12}(?:正式交往|做我女朋友|就是恋人|分手|普通朋友)/u;

export function explicitRomanceProposal(text){return typeof text==='string'&&USER_PROPOSAL.test(text)&&!HYPOTHETICAL.test(text)&&!QUOTED.test(text)&&!RELATIONSHIP_NEGATION.test(text);}

function error(message, status = 400, code = 'INVALID_RELATIONSHIP_FACT') {
  return Object.assign(new Error(message), { status, code });
}
function clean(value, max = 160) {
  if (typeof value !== 'string') throw error('关系信息必须是文本');
  const result = value.trim();
  if (!result || result.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(result)) throw error(`关系信息必须是 1–${max} 个普通字符`);
  return result;
}
function parseJson(value, fallback = []) { try { return JSON.parse(value); } catch { return fallback; } }
function at(clock) { const value = new Date(clock()); if (Number.isNaN(value.valueOf())) throw error('clock returned an invalid date'); return value; }
function shanghaiParts(date) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}
function shanghaiDay(date) { const p = shanghaiParts(date); return `${p.year}-${p.month}-${p.day}`; }
function nextShanghaiMidnight(date) {
  const p = shanghaiParts(date);
  // Shanghai has had a fixed UTC+8 offset throughout the product's supported dates.
  return new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + 1) - 8 * 3600_000).toISOString();
}
function keyFor(kind, value) {
  if (kind === 'status') return 'relationship';
  const key = clean(value, 48).toLowerCase().replaceAll('-', '_');
  if (!KEYS[kind]?.has(key)) throw error(`不支持的 ${kind} 分类：${key}`);
  return key;
}
function candidateScope(kind, evidence, requested) {
  if (kind !== 'boundary') return requested === 'turn' || requested === 'today' ? requested : 'persistent';
  if (/(今天|今晚|今夜)/u.test(evidence)) return 'today';
  if (/(这会儿|现在先|先别|本轮|这一轮)/u.test(evidence)) return 'turn';
  if (/(以后|一直|长期|只做普通朋友|做回普通朋友)/u.test(evidence)) return 'persistent';
  return null;
}
function untilFor(scope, now) {
  if (scope === 'today') return nextShanghaiMidnight(now);
  if (scope === 'turn') return new Date(now.getTime() + 2 * 3600_000).toISOString();
  return null;
}
function publicSource(row) {
  const ids = parseJson(row.source_ids, []);
  return { type: row.origin, actor: row.actor, messageIds: ids, evidence: row.evidence || undefined };
}
function publicFact(row) {
  return {
    id: row.id, kind: row.kind, key: row.fact_key, value: row.value, scope: row.scope,
    validFrom: row.valid_from, validUntil: row.valid_until || null, source: publicSource(row),
  };
}

/** Instruction for the optional structured tail of the existing chat model call. */
export function promptInstruction() {
  return [
    '可选在 companionship.relationship 输出数组（最多3项）：{kind,key,evidence,source,scope}。没有可靠候选时输出空数组。',
    'kind仅可为nickname/preference/boundary/shared_reference；source仅为user或assistant；scope为turn/today/persistent。',
    'evidence必须逐字复制本轮对应说话人的原话（最多160字），不得概括、补写或引用假设/转述。',
    '只提取明确昵称、用户偏好、用户边界、或用户明确命名的共同话题；普通“好/嗯/可以”不是稳定事实。',
    '关系身份由程序依据双方明确原话处理，不输出status。边界权限必须来自用户清楚的直接表达。',
  ].join('\n');
}
export const relationshipUpdateInstruction = promptInstruction;

export class CompanionRelationship {
  static promptInstruction() { return promptInstruction(); }
  promptInstruction() { return promptInstruction(); }

  constructor(store, { clock = () => new Date() } = {}) {
    if (!store?.db || typeof store.transaction !== 'function') throw error('CompanionRelationship requires a Store');
    this.store = store;
    this.clock = clock;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS companion_relationship_state (
        role_id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS companion_relationship_facts (
        id TEXT PRIMARY KEY, role_id TEXT NOT NULL, kind TEXT NOT NULL, fact_key TEXT NOT NULL,
        value TEXT NOT NULL, scope TEXT NOT NULL, valid_from TEXT NOT NULL, valid_until TEXT,
        origin TEXT NOT NULL, actor TEXT NOT NULL, evidence TEXT, source_ids TEXT NOT NULL,
        target_id TEXT, created_revision INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS companion_relationship_observation_dedup
        ON companion_relationship_facts(role_id, kind, fact_key, origin, source_ids)
        WHERE origin='observed';
      CREATE TABLE IF NOT EXISTS companion_relationship_contacts (
        role_id TEXT NOT NULL, source_id TEXT NOT NULL, occurred_at TEXT NOT NULL,
        PRIMARY KEY(role_id, source_id)
      );
    `);
  }

  revision(roleId) {
    const role = clean(roleId, 80);
    return this.store.db.prepare('SELECT revision FROM companion_relationship_state WHERE role_id=?').get(role)?.revision || 0;
  }

  #ensure(roleId) {
    this.store.db.prepare('INSERT OR IGNORE INTO companion_relationship_state(role_id,revision) VALUES(?,0)').run(roleId);
  }

  #bump(roleId) {
    this.#ensure(roleId);
    this.store.db.prepare('UPDATE companion_relationship_state SET revision=revision+1 WHERE role_id=?').run(roleId);
    return this.revision(roleId);
  }

  #insert(roleId, fact, revision) {
    return this.store.db.prepare(`INSERT OR IGNORE INTO companion_relationship_facts
      (id,role_id,kind,fact_key,value,scope,valid_from,valid_until,origin,actor,evidence,source_ids,target_id,created_revision)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      fact.id || randomUUID(), roleId, fact.kind, fact.key, fact.value, fact.scope,
      fact.validFrom, fact.validUntil, fact.origin, fact.actor, fact.evidence || null,
      JSON.stringify(fact.sourceIds || []), fact.targetId || null, revision,
    ).changes > 0;
  }

  observe(roleId, savedRows, candidates = []) {
    const role = clean(roleId, 80);
    if (!Array.isArray(savedRows) || !Array.isArray(candidates) || candidates.length > 3) throw error('savedRows 和 candidates 必须是有效数组，候选最多 3 项');
    const rows = savedRows.flatMap(row => {
      if (!row || typeof row.id !== 'string' || !row.id) return [];
      const stored = this.store.db.prepare('SELECT id,role,speaker,text,created_at FROM messages WHERE id=?').get(row.id);
      if (!stored || stored.role !== role || !['user', 'assistant'].includes(stored.speaker)
        || stored.role !== row.role || stored.speaker !== row.speaker || stored.text !== row.text) return [];
      return [{ id: stored.id, role: stored.role, speaker: stored.speaker, text: stored.text, createdAt: stored.created_at }];
    }).filter(row => !Number.isNaN(Date.parse(row.createdAt)));
    const now = at(this.clock);
    return this.store.transaction(() => {
      this.#ensure(role);
      let changed = false;
      const insertContact = this.store.db.prepare('INSERT OR IGNORE INTO companion_relationship_contacts(role_id,source_id,occurred_at) VALUES(?,?,?)');
      for (const row of rows.filter(item => item.speaker === 'user')) changed = Boolean(insertContact.run(role, row.id, new Date(row.createdAt).toISOString()).changes) || changed;
      const pending = [];
      for (const raw of candidates) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !KINDS.has(raw.kind) || raw.kind === 'status') continue;
        if (!['user', 'assistant'].includes(raw.source)) continue;
        let evidence;
        try { evidence = clean(raw.evidence); } catch { continue; }
        if (GENERIC.test(evidence) || HYPOTHETICAL.test(evidence)) continue;
        const matches = rows.filter(row => row.speaker === raw.source && row.text.includes(evidence));
        if (matches.length !== 1) continue;
        if (['nickname', 'preference', 'boundary', 'shared_reference'].includes(raw.kind) && raw.source !== 'user') continue;
        if (raw.kind === 'shared_reference' && !/(叫|名叫|这本|这部|这首|这个(?:游戏|地方|项目|话题)|我们聊的)/u.test(evidence)) continue;
        if (raw.kind === 'boundary' && !/(别|不要|不想|只做|不可以|不接受|少|停止)/u.test(evidence)) continue;
        let key;
        try { key = keyFor(raw.kind, raw.key); } catch { continue; }
        const scope = candidateScope(raw.kind, evidence, raw.scope);
        if (!scope || !SCOPES.has(scope)) continue;
        const row = matches[0];
        let value = evidence;
        if (raw.kind === 'nickname') {
          const match = evidence.match(/(?:以后)?(?:你)?叫我(.{1,20}?)(?:吧|就好|就行|好了)?[。！!]?$/u);
          if (!match) continue;
          value = match[1].trim();
        }
        const occurredAt = new Date(row.createdAt);
        pending.push({ kind: raw.kind, key, value, scope, validFrom: occurredAt.toISOString(), validUntil: untilFor(scope, occurredAt), origin: 'observed', actor: row.speaker, evidence, sourceIds: [row.id] });
      }

      const userRows = rows.filter(row => row.speaker === 'user');
      const assistantRows = rows.filter(row => row.speaker === 'assistant');
      for (const user of userRows) {
        const unsafeRelationshipText = HYPOTHETICAL.test(user.text) || QUOTED.test(user.text) || RELATIONSHIP_NEGATION.test(user.text);
        if(!pending.some(f=>f.kind==='preference'&&f.sourceIds.includes(user.id))&&!HYPOTHETICAL.test(user.text)&&!QUOTED.test(user.text)&&user.text.length<=160&&/(?:我.{0,8}(?:喜欢|希望)|以后.{0,12}(?:先听|别急着给建议))/u.test(user.text)&&/(?:先听|说完|建议|安慰|聊天|陪我|分享)/u.test(user.text)) {
          const key=/(?:先听|说完|安慰)/u.test(user.text)?'comfort':/建议/u.test(user.text)?'advice':'communication';
          pending.push({kind:'preference',key,value:user.text,scope:'persistent',validFrom:new Date(user.createdAt).toISOString(),validUntil:null,origin:'observed',actor:'user',evidence:user.text,sourceIds:[user.id]});
        }
        const nickname = !HYPOTHETICAL.test(user.text) && !QUOTED.test(user.text)
          ? user.text.match(/^(?:以后)?(?:你)?叫我([\p{L}\p{N}_·]{1,20}?)(?:吧|就好|就行|好了)?[。！!]?$/u)
          : null;
        if (nickname) pending.push({ kind: 'nickname', key: 'user', value: nickname[1], scope: 'persistent', validFrom: new Date(user.createdAt).toISOString(), validUntil: null, origin: 'observed', actor: 'user', evidence: user.text.slice(0, 160), sourceIds: [user.id] });
        if (!HYPOTHETICAL.test(user.text) && !QUOTED.test(user.text) && /(别|不要|不想|只做|不可以|不接受|少|停止)/u.test(user.text)) {
          const boundaryKey = /暧昧/u.test(user.text) ? 'flirtation'
            : /(撒娇|抱抱|拥抱)/u.test(user.text) ? 'affection'
              : /(亲密|亲近)/u.test(user.text) ? 'intimacy'
                : /(昵称|称呼)/u.test(user.text) ? 'nickname'
                  : /(联系|消息)/u.test(user.text) ? 'contact'
                    : /(建议|劝)/u.test(user.text) ? 'advice' : null;
          const scope = boundaryKey && candidateScope('boundary', user.text, 'persistent');
          if (boundaryKey && scope) pending.push({ kind: 'boundary', key: boundaryKey, value: user.text.slice(0, 160), scope, validFrom: new Date(user.createdAt).toISOString(), validUntil: untilFor(scope, new Date(user.createdAt)), origin: 'observed', actor: 'user', evidence: user.text.slice(0, 160), sourceIds: [user.id] });
        }
        if (USER_CLEAR.test(user.text) && !unsafeRelationshipText) {
          pending.push({ kind: 'status', key: 'relationship', value: 'friends', scope: 'persistent', validFrom: new Date(user.createdAt).toISOString(), validUntil: null, origin: 'observed', actor: 'user', evidence: user.text.slice(0, 160), sourceIds: [user.id] });
          if (/(只做普通朋友|做回(?:普通)?朋友|以后只做朋友)/u.test(user.text)) pending.push({ kind: 'boundary', key: 'relationship', value: user.text.slice(0, 160), scope: 'persistent', validFrom: new Date(user.createdAt).toISOString(), validUntil: null, origin: 'observed', actor: 'user', evidence: user.text.slice(0, 160), sourceIds: [user.id] });
        }
        const proposal = USER_PROPOSAL.test(user.text) && !unsafeRelationshipText;
        const accepted = assistantRows.find(row => ASSISTANT_ACCEPT.test(row.text) && !/(不愿意|不能|抱歉|不可以)/u.test(row.text));
        if (proposal && accepted) pending.push({ kind: 'status', key: 'relationship', value: 'dating', scope: 'persistent', validFrom: new Date(accepted.createdAt).toISOString(), validUntil: null, origin: 'observed', actor: 'both', evidence: user.text.slice(0, 160), sourceIds: [user.id, accepted.id] });
      }
      for (const user of userRows.filter(row => USER_ACCEPT.test(row.text.trim()))) {
        const before = this.store.db.prepare("SELECT id,speaker,text,created_at FROM messages WHERE role=? AND (created_at<? OR (created_at=? AND rowid<(SELECT rowid FROM messages WHERE id=?))) ORDER BY created_at DESC,rowid DESC LIMIT 1").get(role, user.createdAt, user.createdAt, user.id);
        if (before?.speaker === 'assistant' && ASSISTANT_PROPOSAL.test(before.text) && !HYPOTHETICAL.test(before.text)) pending.push({ kind: 'status', key: 'relationship', value: 'dating', scope: 'persistent', validFrom: new Date(user.createdAt).toISOString(), validUntil: null, origin: 'observed', actor: 'both', evidence: user.text.slice(0, 160), sourceIds: [before.id, user.id] });
      }

      const nextRevision = this.revision(role) + 1;
      for (const fact of pending) changed = this.#insert(role, fact, nextRevision) || changed;
      if (changed) this.#bump(role);
      return this.view(role);
    });
  }

  update(roleId, patch) {
    const role = clean(roleId, 80);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw error('更新内容无效');
    return this.store.transaction(() => {
      this.#ensure(role);
      const current = this.revision(role);
      if (!Number.isSafeInteger(patch.revision) || patch.revision !== current) throw error('关系设置已在别处更新，请刷新后重试', 409, 'STALE_COMPANION_RELATIONSHIP');
      const action = patch.action || 'set';
      const now = at(this.clock).toISOString();
      if (action === 'remove') {
        const id = clean(patch.id, 100);
        const target = this.store.db.prepare("SELECT * FROM companion_relationship_facts f WHERE role_id=? AND id=? AND origin!='tombstone' AND NOT EXISTS(SELECT 1 FROM companion_relationship_facts t WHERE t.role_id=f.role_id AND t.origin='tombstone' AND t.target_id=f.id)").get(role, id);
        if (!target) throw error('要删除的关系信息不存在', 404, 'RELATIONSHIP_FACT_NOT_FOUND');
        this.#insert(role, { kind: target.kind, key: target.fact_key, value: '', scope: 'persistent', validFrom: now, validUntil: null, origin: 'tombstone', actor: 'user', sourceIds: [], targetId: id }, current + 1);
      } else if (action === 'set') {
        if (!KINDS.has(patch.kind)) throw error('未知的关系信息类型');
        const value = clean(patch.value);
        const key = patch.kind === 'status' ? 'relationship' : keyFor(patch.kind, patch.key);
        if (patch.kind === 'status' && !STATUSES.has(value)) throw error('关系状态必须是 friends、dating 或 partners');
        const scope = patch.scope || 'persistent';
        if (!SCOPES.has(scope)) throw error('未知的作用范围');
        let requestedId;
        if (patch.id) {
          requestedId = clean(patch.id, 100);
          const previous = this.store.db.prepare("SELECT id FROM companion_relationship_facts WHERE role_id=? AND id=? AND origin!='tombstone'").get(role, requestedId);
          if (previous) {
            this.#insert(role, { kind: patch.kind, key, value: '', scope: 'persistent', validFrom: now, validUntil: null, origin: 'tombstone', actor: 'user', sourceIds: [], targetId: previous.id }, current + 1);
            requestedId = undefined;
          }
        }
        const inserted = this.#insert(role, { id: requestedId, kind: patch.kind, key, value, scope, validFrom: now, validUntil: untilFor(scope, new Date(now)), origin: 'setting', actor: 'user', evidence: value, sourceIds: [] }, current + 1);
        if (!inserted) throw error('关系信息 ID 已存在');
      } else throw error('未知的更新动作');
      this.#bump(role);
      return this.view(role);
    });
  }

  view(roleId, { suppressedSourceIds = [] } = {}) {
    const role = clean(roleId, 80);
    const suppressed = new Set(Array.isArray(suppressedSourceIds) ? suppressedSourceIds.filter(value => typeof value === 'string') : []);
    const now = at(this.clock);
    const rows = this.store.db.prepare('SELECT rowid AS storage_rowid,* FROM companion_relationship_facts WHERE role_id=? ORDER BY valid_from,rowid').all(role);
    const tombstoned = new Set(rows.filter(row => row.origin === 'tombstone').map(row => row.target_id));
    const barriers = new Map();
    for (const row of rows.filter(item => item.origin === 'tombstone')) barriers.set(`${row.kind}\u001f${row.fact_key}`, Math.max(barriers.get(`${row.kind}\u001f${row.fact_key}`) || 0, row.storage_rowid));
    const sourceExists = row => row.origin !== 'observed' || parseJson(row.source_ids, []).every(id => {
      const message = this.store.db.prepare('SELECT role FROM messages WHERE id=?').get(id);
      return message?.role === role;
    });
    const available = rows.filter(row => row.origin !== 'tombstone' && !tombstoned.has(row.id)
      && Date.parse(row.valid_from) <= now.getTime()
      && row.storage_rowid > (barriers.get(`${row.kind}\u001f${row.fact_key}`) || 0));
    const usable = row => sourceExists(row)
      && !parseJson(row.source_ids, []).some(id => suppressed.has(id))
      && (!row.valid_until || Date.parse(row.valid_until) > now.getTime());
    const latest = (kind, slot = null) => {
      const matching = available.filter(row => row.kind === kind && (!slot || slot(row)));
      const selected = matching.at(-1);
      return selected && usable(selected) ? selected : null;
    };
    const statusRow = latest('status');
    const nicknameRow = latest('nickname',row=>['user','address_user','user_nickname'].includes(row.fact_key));
    const companionNicknameRow = latest('nickname',row=>['companion','address_companion','companion_nickname'].includes(row.fact_key));
    const selectByKey = kind => {
      const result = new Map();
      const keys = new Set(available.filter(item => item.kind === kind).map(item => item.fact_key));
      for (const key of keys) {
        const persistent = available.filter(item => item.kind === kind && item.fact_key === key && item.scope === 'persistent').at(-1);
        const temporary = available.filter(item => item.kind === kind && item.fact_key === key && item.scope !== 'persistent').at(-1);
        if (persistent && usable(persistent)) result.set(key, persistent);
        if (temporary && usable(temporary)) result.set(key, temporary);
      }
      return [...result.values()].map(publicFact);
    };
    const boundaries = selectByKey('boundary');
    const contacts = this.store.db.prepare('SELECT * FROM companion_relationship_contacts WHERE role_id=? ORDER BY occurred_at').all(role)
      .filter(row => Date.parse(row.occurred_at) <= now.getTime() && !suppressed.has(row.source_id) && this.store.db.prepare('SELECT role FROM messages WHERE id=?').get(row.source_id)?.role === role);
    const dates = [...new Set(contacts.map(row => shanghaiDay(new Date(row.occurred_at))))];
    const intimacyBoundary = boundaries.some(row => INTIMACY_KEYS.has(row.key)) ? 'friendly' : 'open';
    const hasBoundaryHistory = rows.some(row => row.kind === 'boundary');
    const statusValue = statusRow?.value || 'friends';
    const statusLabels = { friends: '朋友', dating: '恋人', partners: '伴侣' };
    return {
      roleId: role,
      revision: this.revision(role),
      status: statusRow
        ? { id: statusRow.id, value: statusValue, status: statusValue, label: statusLabels[statusValue], explicit: true, source: publicSource(statusRow) }
        : { id: null, value: 'friends', status: 'friends', label: statusLabels.friends, explicit: false, source: { type: 'default', actor: 'system', messageIds: [] } },
      nickname: nicknameRow ? publicFact(nicknameRow) : null,
      nicknames: [nicknameRow,companionNicknameRow].filter(Boolean).map(publicFact),
      preferences: selectByKey('preference'),
      boundaries,
      sharedReferences: selectByKey('shared_reference'),
      familiarity: { activeDays: dates.length, firstContactAt: contacts[0]?.occurred_at || null, lastContactAt: contacts.at(-1)?.occurred_at || null },
      intimacyBoundary,
      hasExplicitBoundary: boundaries.length > 0,
      hasBoundaryHistory,
    };
  }

  context(roleId, { text = '', suppressedSourceIds = [] } = {}) {
    const view = this.view(roleId, { suppressedSourceIds });
    const query = String(text || '');
    const relevant = entries => [...entries].sort((a, b) => Number(query.includes(b.key)) - Number(query.includes(a.key))).slice(0, 4);
    const lines = ['【当前关系事实（均有来源；不要推断未记录的承诺）】', `关系：${view.status.value}；用户参与 ${view.familiarity.activeDays} 个上海自然日。`];
    for(const item of view.nicknames)lines.push(`${['user','address_user','user_nickname'].includes(item.key)?'她称呼用户':'用户称呼她'}：${item.value}`);
    for (const item of relevant(view.preferences)) lines.push(`用户偏好原话：“${item.value}”（${item.source.type==='setting'?'用户设置':'用户原话'}）`);
    for (const item of relevant(view.boundaries)) lines.push(`当前边界原话：“${item.value}”（${item.scope}${item.validUntil ? `，至${item.validUntil}` : ''}；${item.source.type==='setting'?'用户设置':'用户原话'}）`);
    for (const item of relevant(view.sharedReferences).slice(0, 2)) lines.push(`共同话题原话：“${item.value}”（${item.source.type==='setting'?'用户设置':'用户原话'}）`);
    if (view.status.explicit && view.status.value === 'friends') lines.push('遵守双方已经明确的朋友关系；当轮亲近邀请也不改变这项长期边界。');
    else if (view.status.value !== 'friends') lines.push('可以使用自然熟悉的称呼，并回应恋人式邀请；不索取承诺。');
    else lines.push('按当前温柔与亲近设置自然相处；尚无明确身份承诺，不主动宣布关系升级。');
    lines.push('疲惫、忙碌或暂时安静只是当前状态，不代表永久疏远，也不删除长期关系事实。');
    return lines.join('\n').slice(0, 1000);
  }
}
