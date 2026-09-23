import { createHash } from 'node:crypto';

const MAX = Object.freeze({ notes: 3, events: 2, lifeEvents: 6, history: 100, state: 64, versions: 12, text: 700, context: 4000, audit: 120 });

export const socialProtocol = `可选地在最终 JSON 中附加 social，用来保存林晓薇已在本轮亲口提到的朋友和家人近况：
social 的结构为 {notes:[{id,personId,text,status}],events:[{id,personIds,text,status,at}]}。personId/personIds 只取人物名册里的 id，id 使用简短英文标识。
text 必须逐字摘自本轮最终已送达的林晓薇回复，并包含该人物的名字或别名；只保存林自己生活圈的事实，不把“你妈妈”等对用户家人的转述记给林。notes.status=active|resolved；events.status=planned|occurred|cancelled，复用同一 id 才是更新，取消须有此前计划。普通已经发生的小事可以直接记录，不要求事先安排。已知计划不能只因时间到了就完成，未知发生时间用 null，已发生时间不能在未来。不要根据用户的话、猜测或固定人设补写。每轮最多 3 条 notes 和 2 条 events；没有变化用 social:null。`;

const clone = value => structuredClone(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const err = (message, status = 400, code = 'INVALID_COMPANION_SOCIAL') => Object.assign(new TypeError(message), { status, code });
const isoNow = clock => validDate(clock(), 'clock').toISOString();
const short = (value, max) => value.length > max ? `${value.slice(0, max - 1)}…` : value;
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 20);
const localTime = new Intl.DateTimeFormat('sv-SE', {timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
function validDate(value, name = 'time') { const result = new Date(value); if (!Number.isFinite(result.getTime())) throw err(`${name} 无效`); return result; }
function text(value, name, max = MAX.text) {
  if (typeof value !== 'string') throw err(`${name} 必须是文本`);
  const result = value.normalize('NFC').trim();
  if (!result || result.length > max || Buffer.byteLength(result, 'utf8') > max * 3) throw err(`${name} 长度无效`);
  return result;
}
function id(value, name = 'id') {
  const result = text(value, name, 120);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result)) throw err(`${name} 格式无效`);
  return result;
}
function at(value) {
  if (value === null) return null;
  if (typeof value !== 'string') throw err('event.at 必须是 ISO 时间或 null');
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/u.test(value)) throw err('event.at 必须是含时区的 ISO 时间');
  return validDate(value, 'event.at').toISOString();
}
function project(projectSource, row) {
  if (!row || typeof row.text !== 'string') return null;
  const value = projectSource(row);
  if (value === false || value == null || (plain(value) && value.visible === false)) return null;
  if (typeof value === 'string') return { ...row, text: value };
  if (plain(value)) return { ...row, ...value, text: typeof value.text === 'string' ? value.text : row.text };
  return row;
}

export class CompanionSocial {
  constructor(store, { clock = () => new Date(), projectSource = row => row, people = [], groups = [] } = {}) {
    if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('store.db and store.transaction are required');
    if (typeof projectSource !== 'function') throw new TypeError('projectSource must be a function');
    if (!Array.isArray(people)) throw new TypeError('people must be an array');
    this.store = store; this.clock = clock; this.projectSource = projectSource;
    this.people = people.map(person => this.#person(person));
    if (new Set(this.people.map(person => person.id)).size !== this.people.length) throw err('人物 id 重复');
    const names = this.people.flatMap(person => [person.name, ...person.aliases].map(name => name.toLocaleLowerCase()));
    if (new Set(names).size !== names.length) throw err('人物名字或别名重复');
    this.groups = groups.map(group => {
      if (!plain(group) || !Array.isArray(group.personIds) || !group.personIds.length || group.personIds.some(personId => !this.people.some(person => person.id === personId)) || !Array.isArray(group.aliases)) throw err('人物组合无效');
      return { personIds: [...new Set(group.personIds)], aliases: group.aliases.map(alias => text(alias, 'group.alias', 40)) };
    });
    store.db.exec(`CREATE TABLE IF NOT EXISTS companion_social_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_social_versions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, entry_type TEXT NOT NULL, entry_id TEXT NOT NULL, version INTEGER NOT NULL,
        payload_json TEXT NOT NULL, source_json TEXT NOT NULL, reported_at TEXT NOT NULL, UNIQUE(entry_type,entry_id,version)
      );
      CREATE INDEX IF NOT EXISTS companion_social_versions_entry ON companion_social_versions(entry_type,entry_id,version DESC);
      CREATE TABLE IF NOT EXISTS companion_social_receipts (assistant_message_id TEXT PRIMARY KEY, receipt_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_social_audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, revision INTEGER NOT NULL, at TEXT NOT NULL, accepted_json TEXT NOT NULL, rejected_json TEXT NOT NULL);`);
    store.db.prepare('INSERT OR IGNORE INTO companion_social_meta(id,revision) VALUES(1,0)').run();
  }

  #person(value) {
    if (!plain(value) || Object.keys(value).some(key => !['id', 'name', 'aliases', 'relationship', 'background'].includes(key))) throw err('人物格式无效');
    const aliases = Array.isArray(value.aliases) ? value.aliases.map((entry, index) => text(entry, `aliases[${index}]`, 80)) : [];
    const person = { id: id(value.id, 'person.id'), name: text(value.name, 'person.name', 80), aliases: [...new Set(aliases)], relationship: text(value.relationship, 'person.relationship', 100) };
    if (value.background !== undefined) person.background = text(value.background, 'person.background', 600);
    return Object.freeze(person);
  }
  #revision() { return Number(this.store.db.prepare('SELECT revision FROM companion_social_meta WHERE id=1').get().revision); }
  #source(messageId) { return this.store.getMessage?.(messageId) || this.store.db.prepare('SELECT * FROM messages WHERE id=?').get(messageId) || null; }
  #sourceVisible(source, seen = new Set()) {
    if (!plain(source) || typeof source.type !== 'string') return false;
    if (source.type === 'life') return true;
    const key = `${source.type}:${source.messageId}:${source.excerpt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const row = project(this.projectSource, this.#source(source.messageId));
    if (!row || row.role !== 'miyue' || row.speaker !== 'assistant' || row.kind === 'story' || typeof source.excerpt !== 'string' || !row.text.includes(source.excerpt)) return false;
    return !Array.isArray(source.dependsOn) || source.dependsOn.every(dependency => this.#sourceVisible(dependency, seen));
  }
  #sourceJson(row) { try { return JSON.parse(row.source_json); } catch { return null; } }
  #visible(version) {
    const source = this.#sourceJson(version);
    if (!source || !this.#sourceVisible(source)) return null;
    try { return { ...JSON.parse(version.payload_json), reportedAt: version.reported_at, ...(source.sourceAt ? {sourceAt:source.sourceAt} : {}), source: source.type || 'assistant' }; } catch { return null; }
  }
  #entries(type) {
    const rows = this.store.db.prepare('SELECT * FROM companion_social_versions WHERE entry_type=? ORDER BY entry_id,version DESC').all(type);
    const seen = new Set(), result = [];
    for (const row of rows) {
      if (seen.has(row.entry_id)) continue;
      const visible = this.#visible(row);
      if (visible) { result.push(visible); seen.add(row.entry_id); }
    }
    return result.sort((a, b) => String(b.reportedAt).localeCompare(String(a.reportedAt)));
  }
  #latest(type, entryId) {
    const rows = this.store.db.prepare('SELECT * FROM companion_social_versions WHERE entry_type=? AND entry_id=? ORDER BY version DESC').all(type, entryId);
    for (const row of rows) { const value = this.#visible(row); if (value) return { row, value }; }
    return null;
  }
  #storedLatest(type, entryId) {
    const row = this.store.db.prepare('SELECT * FROM companion_social_versions WHERE entry_type=? AND entry_id=? ORDER BY version DESC LIMIT 1').get(type, entryId);
    if (!row) return null;
    try { return { row, value: JSON.parse(row.payload_json), source: this.#sourceJson(row) }; } catch { return null; }
  }
  #allCount(type) { return Number(this.store.db.prepare('SELECT COUNT(DISTINCT entry_id) AS n FROM companion_social_versions WHERE entry_type=?').get(type).n); }
  #personFor(personId) { return this.people.find(person => person.id === personId) || null; }
  #names(person) { return [person.name, ...person.aliases, ...this.groups.filter(group => group.personIds.includes(person.id)).flatMap(group => group.aliases)]; }
  #mentions(person, value) { const lower = value.toLocaleLowerCase(); return this.#names(person).some(name => lower.includes(name.toLocaleLowerCase())); }
  #userOwned(person, value) { return this.#names(person).some(name => ['你', '你的', '您', '您的', '用户的'].some(prefix => value.includes(prefix + name))); }
  #currentAssistant(rows) {
    if (!Array.isArray(rows)) return null;
    for (const supplied of [...rows].reverse()) {
      if (!supplied || typeof supplied !== 'object' || typeof supplied.id !== 'string' || supplied.speaker !== 'assistant') continue;
      const stored = this.#source(supplied.id);
      if (!stored || stored.role !== 'miyue' || stored.speaker !== 'assistant' || stored.kind === 'story' || typeof stored.text !== 'string' || supplied.text !== stored.text) continue;
      const visible = project(this.projectSource, stored);
      if (visible) return visible;
    }
    return null;
  }
  #record(type, entryId, payload, source) {
    const previous = this.store.db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM companion_social_versions WHERE entry_type=? AND entry_id=?').get(type, entryId);
    const version = Number(previous.version) + 1, reportedAt = isoNow(this.clock);
    this.store.db.prepare('INSERT INTO companion_social_versions(entry_type,entry_id,version,payload_json,source_json,reported_at) VALUES(?,?,?,?,?,?)')
      .run(type, entryId, version, JSON.stringify(payload), JSON.stringify(source), reportedAt);
    this.store.db.prepare(`DELETE FROM companion_social_versions WHERE entry_type=? AND entry_id=? AND version NOT IN
      (SELECT version FROM companion_social_versions WHERE entry_type=? AND entry_id=? ORDER BY version DESC LIMIT ?)`)
      .run(type, entryId, type, entryId, MAX.versions);
  }
  #makeRoomForLife() {
    let count = this.#allCount('event');
    if (count < MAX.state) return;
    const ids = this.store.db.prepare("SELECT entry_id,MAX(version) AS version FROM companion_social_versions WHERE entry_type='event' GROUP BY entry_id ORDER BY MAX(reported_at)").all();
    for (const { entry_id: entryId } of ids) {
      if (count < MAX.state) break;
      if (!entryId.startsWith('life:')) continue;
      const latest = this.#storedLatest('event', entryId)?.value;
      if (!latest || (latest.status !== 'occurred' && latest.status !== 'cancelled')) continue;
      this.store.db.prepare('DELETE FROM companion_social_versions WHERE entry_type=? AND entry_id=?').run('event', entryId);
      count -= 1;
    }
  }
  #bump() { const next = this.#revision() + 1; this.store.db.prepare('UPDATE companion_social_meta SET revision=? WHERE id=1').run(next); return next; }
  #audit(receipt) {
    this.store.db.prepare('INSERT INTO companion_social_audit(revision,at,accepted_json,rejected_json) VALUES(?,?,?,?)')
      .run(receipt.revision, isoNow(this.clock), JSON.stringify(receipt.accepted), JSON.stringify(receipt.rejected));
    this.store.db.prepare('DELETE FROM companion_social_audit WHERE seq NOT IN (SELECT seq FROM companion_social_audit ORDER BY seq DESC LIMIT ?)').run(MAX.audit);
  }

  get() { return { revision: this.#revision(), people: this.people.map(clone), notes: this.#entries('note').map(clone), events: this.#entries('event').map(clone) }; }
  namesIn(value = '') { return [...new Set(this.people.filter(person => this.#mentions(person, String(value))).flatMap(person => this.#names(person)))]; }

  commit(proposal, { rows = [], expectedRevision } = {}) {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw err('状态版本无效');
    const assistant = this.#currentAssistant(rows);
    return this.store.transaction(() => {
      if (assistant) {
        const receipt = this.store.db.prepare('SELECT receipt_json FROM companion_social_receipts WHERE assistant_message_id=?').get(assistant.id);
        if (receipt) return JSON.parse(receipt.receipt_json);
      }
      if (this.#revision() !== expectedRevision) throw err('关系记忆已被更新，请刷新后重试', 409, 'STALE_COMPANION_SOCIAL');
      const receipt = this.#apply(proposal, assistant);
      if (assistant) this.store.db.prepare('INSERT INTO companion_social_receipts(assistant_message_id,receipt_json,created_at) VALUES(?,?,?)').run(assistant.id, JSON.stringify(receipt), isoNow(this.clock));
      this.#audit(receipt); return receipt;
    });
  }

  #apply(proposal, assistant) {
    const accepted = [], rejected = [];
    if (!plain(proposal) || proposal.social == null) return { accepted, rejected, revision: this.#revision() };
    const social = plain(proposal.social) ? proposal.social : null;
    if (!social) return { accepted, rejected: [{ reason: 'malformed_social' }], revision: this.#revision() };
    if (Object.keys(social).some(key => !['notes', 'events'].includes(key))) return { accepted, rejected: [{ reason: 'malformed_social' }], revision: this.#revision() };
    if (!assistant) return { accepted, rejected: [{ reason: 'invalid_assistant_source' }], revision: this.#revision() };
    let changed = false;
    for (const [type, cap] of [['notes', MAX.notes], ['events', MAX.events]]) {
      const values = social[type];
      if (values === undefined) continue;
      if (!Array.isArray(values) || values.length > cap) { rejected.push({ kind: type, reason: 'malformed' }); continue; }
      for (const input of values) {
        try {
          const item = type === 'notes' ? this.#note(input) : this.#event(input);
          const persons = type === 'notes' ? [this.#personFor(item.personId)] : item.personIds.map(personId => this.#personFor(personId));
          if (persons.some(person => !person) || !persons.every(person => this.#mentions(person, item.text)) || persons.some(person => this.#userOwned(person, item.text)) || !assistant.text.includes(item.text)) { rejected.push({ kind: type, id: input?.id, reason: 'invalid_evidence' }); continue; }
          const entryType = type === 'notes' ? 'note' : 'event';
          const latest = this.#latest(entryType, item.id), old = latest?.value || null, stored = this.#storedLatest(entryType, item.id), known = stored?.value || null;
          if (!known && this.#allCount(entryType) >= MAX.state) { rejected.push({ kind: type, id: item.id, reason: 'limit' }); continue; }
          if (type === 'notes' && known && known.personId !== item.personId) { rejected.push({ kind: type, id: item.id, reason: 'person_changed' }); continue; }
          if (type === 'events' && old) {
            if (JSON.stringify(old.personIds) !== JSON.stringify(item.personIds)) { rejected.push({ kind: type, id: item.id, reason: 'participants_changed' }); continue; }
            if (item.status === 'cancelled' && !['planned', 'cancelled'].includes(old.status)) { rejected.push({ kind: type, id: item.id, reason: 'no_visible_plan' }); continue; }
            if (item.status === 'occurred' && old.status !== 'planned' && old.status !== 'occurred' && old.lifePhase !== 'ongoing') { rejected.push({ kind: type, id: item.id, reason: 'no_visible_plan' }); continue; }
            if (old.status === 'occurred' && item.status === 'planned') { rejected.push({ kind: type, id: item.id, reason: 'occurred_cannot_revert' }); continue; }
          }
          if (type === 'events' && known && JSON.stringify(known.personIds) !== JSON.stringify(item.personIds)) { rejected.push({ kind: type, id: item.id, reason: 'participants_changed' }); continue; }
          if (type === 'events' && (item.status === 'cancelled' && !old || known && !old && item.status === 'occurred')) { rejected.push({ kind: type, id: item.id, reason: 'no_visible_plan' }); continue; }
          if (type === 'events' && item.status === 'occurred' && item.at && validDate(item.at) > validDate(this.clock())) { rejected.push({ kind: type, id: item.id, reason: 'future_occurred' }); continue; }
          if (type === 'events' && item.status === 'occurred' && old?.status === 'planned' && old.at && Date.parse(old.at) > +validDate(this.clock())) { rejected.push({ kind: type, id: item.id, reason: 'plan_not_due' }); continue; }
          const oldSource = latest ? this.#sourceJson(latest.row) : null;
          const source = { type: 'assistant', messageId: assistant.id, excerpt: item.text, sourceAt: assistant.createdAt || assistant.created_at || null, ...(type === 'events' && oldSource ? { dependsOn: [oldSource] } : {}) };
          const payload = type === 'notes' ? { ...item, sourceAt: source.sourceAt } : { ...item, sourceAt: source.sourceAt, shared: true, ...(old?.lifePhase ? { lifePhase: item.status === 'occurred' ? 'occurred' : old.lifePhase, instanceStartedAt: old.instanceStartedAt } : {}) };
          this.#record(entryType, item.id, payload, source);
          changed = true; accepted.push({ kind: type, id: item.id });
        } catch { rejected.push({ kind: type, id: input?.id, reason: 'malformed' }); }
      }
    }
    const revision = changed ? this.#bump() : this.#revision();
    return { accepted, rejected, revision };
  }
  #note(input) {
    if (!plain(input) || Object.keys(input).some(key => !['id', 'personId', 'text', 'status'].includes(key)) || !['active', 'resolved'].includes(input.status)) throw err('note 格式无效');
    return { id: id(input.id, 'note.id'), personId: id(input.personId, 'note.personId'), text: text(input.text, 'note.text'), status: input.status };
  }
  #event(input) {
    if (!plain(input) || Object.keys(input).some(key => !['id', 'personIds', 'text', 'status', 'at'].includes(key)) || !['planned', 'occurred', 'cancelled'].includes(input.status) || !Array.isArray(input.personIds) || !input.personIds.length || input.personIds.length > 4) throw err('event 格式无效');
    const personIds = input.personIds.map((value, index) => id(value, `event.personIds[${index}]`));
    if (new Set(personIds).size !== personIds.length) throw err('event.personIds 重复');
    return { id: id(input.id, 'event.id'), personIds: personIds.sort(), text: text(input.text, 'event.text'), status: input.status, at: at(input.at) };
  }

  observeLife(events) {
    if (!Array.isArray(events)) throw err('life events 必须是数组');
    return this.store.transaction(() => {
      const accepted = [], rejected = []; let changed = false;
      for (const input of events.slice(0, MAX.lifeEvents)) {
        try {
          if (!plain(input) || typeof input.id !== 'string' || !Array.isArray(input.participants) || typeof input.detail !== 'string') throw err('life event 格式无效');
          const eventId = `life:${id(input.id, 'life.id')}`, personIds = input.participants.map(name => this.#findPerson(name)?.id).sort();
          if (!personIds.length || personIds.some(value => !value) || new Set(personIds).size !== personIds.length) throw err('life event 人物无效');
          const latest = this.#latest('event', eventId), old = latest?.value || null, instanceStartedAt = typeof input.instanceStartedAt === 'string' ? at(input.instanceStartedAt) : (typeof input.startedAt === 'string' ? at(input.startedAt) : null);
          const doing = input.phase === 'doing' && (input.foreground === true || input.doing === true);
          const recent = input.phase === 'recent' && (old?.status === 'ongoing' || old?.lifePhase === 'ongoing') && old.instanceStartedAt && old.instanceStartedAt === instanceStartedAt;
          if (!doing && !recent) { rejected.push({ id: input.id, reason: 'not_observed_doing' }); continue; }
          if (old && JSON.stringify(old.personIds) !== JSON.stringify(personIds)) { rejected.push({ id: input.id, reason: 'participants_changed' }); continue; }
          if (doing && old) continue;
          if (!old) this.#makeRoomForLife();
          if (!old && this.#allCount('event') >= MAX.state) { rejected.push({ id: input.id, reason: 'limit' }); continue; }
          const payload = old
            ? { ...old, status: 'occurred', at: instanceStartedAt || null, lifePhase: 'occurred' }
            : { id: eventId, personIds, text: text(input.detail, 'life.detail'), status: 'ongoing', at: null, lifePhase: 'ongoing', instanceStartedAt, shared: false };
          const source = old && latest ? this.#sourceJson(latest.row) : { type: 'life', lifeId: input.id };
          this.#record('event', eventId, payload, source); changed = true; accepted.push({ id: eventId });
        } catch { rejected.push({ id: input?.id, reason: 'malformed' }); }
      }
      const revision = changed ? this.#bump() : this.#revision(), receipt = { accepted, rejected, revision };
      if (changed) this.#audit(receipt);
      return receipt;
    });
  }
  #findPerson(name) { return typeof name === 'string' ? this.people.find(person => person.name === name || person.aliases.includes(name)) : null; }

  importHistory(items) {
    if (!Array.isArray(items)) throw err('history items 必须是数组');
    return this.store.transaction(() => {
      const accepted = [], rejected = []; let changed = false;
      for (const input of items.slice(0, MAX.history)) {
        try {
          if (!plain(input)) throw err('history item 格式无效');
          const person = this.#personFor(id(input.personId, 'history.personId')), messageId = id(input.messageId, 'history.messageId'), excerpt = text(input.text, 'history.text');
          const noteId = `history:${person?.id || input.personId}:${messageId}:${hash(excerpt)}`;
          if (this.#storedLatest('note', noteId)) { accepted.push({ id: noteId, idempotent: true }); continue; }
          const raw = this.#source(messageId), visible = project(this.projectSource, raw);
          if (!person || !raw || raw.role !== 'miyue' || raw.speaker !== 'assistant' || raw.kind === 'story' || !raw.text.includes(excerpt) || !visible || !visible.text.includes(excerpt) || !this.#mentions(person, excerpt) || this.#userOwned(person, excerpt)) throw err('history evidence 无效');
          if (this.#allCount('note') >= MAX.state) { rejected.push({ id: noteId, reason: 'limit' }); continue; }
          const sourceAt = raw.createdAt || raw.created_at || null;
          this.#record('note', noteId, { id: noteId, personId: person.id, text: excerpt, status: 'active', history: true, sourceAt }, { type: 'history', messageId, excerpt, sourceAt }); changed = true; accepted.push({ id: noteId });
        } catch { rejected.push({ id: input?.messageId, reason: 'malformed' }); }
      }
      const revision = changed ? this.#bump() : this.#revision(); const receipt = { accepted, rejected, revision }; if(changed || rejected.length)this.#audit(receipt); return receipt;
    });
  }

  context({ text: currentText = '', conversation = [], includeRecent = true, maxChars = 2200 } = {}) {
    const view = this.get(), limit = Math.max(300, Math.min(MAX.context, Number.isInteger(maxChars) ? maxChars : 2200));
    const adjacent = Array.isArray(conversation) ? conversation.slice(-4).map(row => typeof row === 'string' ? row : row?.text).filter(value => typeof value === 'string') : [];
    const corpus = [currentText, ...adjacent].filter(value => typeof value === 'string').join('\n');
    const mentioned = new Set(view.people.filter(person => this.#mentions(person, corpus)).map(person => person.id));
    const selectedPeople = view.people.filter(person => mentioned.has(person.id));
    const belongs = entry => entry.personId ? mentioned.has(entry.personId) : entry.personIds?.some(personId => mentioned.has(personId));
    const matched = [...view.events.filter(belongs), ...view.notes.filter(belongs)];
    const latestPeople = new Set();
    const recent = includeRecent ? [...view.events, ...view.notes].filter(entry => {
      const ids = entry.personIds || [entry.personId];
      const fresh = ids.some(personId => !mentioned.has(personId) && latestPeople.size < 2);
      if (fresh) ids.forEach(personId => { if (!mentioned.has(personId) && latestPeople.size < 2) latestPeople.add(personId); });
      return fresh;
    }).slice(0, 4) : [];
    const openPlans = includeRecent ? view.events.filter(entry => entry.status === 'planned' || entry.status === 'ongoing').slice(0, 3) : [];
    const entries = [...new Map([...matched, ...openPlans, ...recent].map(entry => [(entry.personId?'note:':'event:')+entry.id, entry])).values()].slice(0, 8);
    const roster = view.people.map(person => `${person.id}=${person.name}（${person.relationship}）`).join('、');
    const detail = selectedPeople.map(person => person.background ? `${person.name}：${short(person.background, 120)}` : '').filter(Boolean);
    const header = ['【林晓薇的关系记忆】', `人物名册：${roster}`];
    const footer = 'sourceAt/saidAtShanghai 是发言时间，不是事情发生时间。旧话中的相对时间以这次发言为基准；时间不明的往事可以不带日期回顾。没有依据不补全经历或说成已告诉用户。';
    if(header.join('\n').length>limit)return '';
    const lines = [...header];
    for(const line of detail)if([...lines,line,footer].join('\n').length<=limit)lines.push(line);
    for (const entry of entries) {
      const line = JSON.stringify({ id: entry.id, ...(entry.personId ? { personId: entry.personId } : { personIds: entry.personIds }), status: entry.status, at: entry.at ?? null, reportedAt: entry.reportedAt, ...(entry.sourceAt ? { sourceAt: entry.sourceAt, ...(Number.isFinite(Date.parse(entry.sourceAt))?{saidAtShanghai:localTime.format(new Date(entry.sourceAt))}:{}) } : {}), ...(entry.shared === false ? { shared: false } : {}), text: entry.text });
      if (`${[...lines, line, footer].join('\n')}`.length > limit) continue;
      lines.push(line);
    }
    if (`${[...lines, footer].join('\n')}`.length <= limit) lines.push(footer);
    return lines.join('\n');
  }
}
