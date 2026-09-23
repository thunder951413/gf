const ROLE_ID = 'miyue';
const MAX_ITEMS = { needs: 8, feelings: 6, threads: 12 };
const MAX_TEXT = { id: 80, label: 80, description: 360, cause: 360, subject: 160, progress: 360, openQuestion: 260, evidence: 500 };
const MAX_PROPOSAL_BYTES = 16 * 1024;
const MAX_AUDIT = 80;

const DEFAULT_SETTINGS = Object.freeze({
  expressionPreferences: '热恋时可以自然、敢于表达爱意；生气可以简短说明感受，但不惩罚、不冷暴力。让表达随当下处境自然变化。',
  enabled: true,
  discoveryEnabled: true,
  city: '苏州',
  interests: '展览、设计、阅读、散步',
  dailyDiscoveryCalls: 2,
  dailyDiscoveryTokens: 16000,
});

export const dynamicsProtocol = `可选地在最终 JSON 中附加 dynamics（缺失或格式不完整时照常完成对话）：
{"dynamics":{"needs":[{"id":"need-rest","label":"想安静一会儿","intensity":68,"description":"此刻更想慢下来","cause":"刚才连续说了很多话","evidence":"想慢下来"}],"feelings":[{"id":"feeling-miss","label":"想念","intensity":62,"description":"告别后仍想多待一会儿","cause":"刚才的告别","evidence":"想和你多待一会儿"}],"threads":[{"id":"thread-book","subject":"那本书","progress":"已经说到第三章","openQuestion":"还想知道你的感受","status":"open","evidence":"第三章"}],"remove":[{"id":"old-id","evidence":"这件事已经过去了"}]}}
id 必须复用既有项目的 id 才能更新；intensity 是 0 到 100 的整数；thread.status 只能是 open 或 resolved。只提交本次有证据的变化。evidence 必须是本轮用户消息或最终已送达助手回复中的逐字子串；助手回复只可作为她自己的主观感受依据，不能把用户事实或双方同意写成她的状态。状态没有固定情绪词表，不要按时间机械衰减；未解决的感受和线索保留到有明确的新表达、解决或移除为止。`;

const clone = value => structuredClone(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const nowIso = clock => date(clock()).toISOString();
function date(value) { const result = new Date(value); if (!Number.isFinite(result.getTime())) throw new TypeError('clock must return a valid date'); return result; }
function error(message, status = 400, code = 'INVALID_COMPANION_DYNAMICS') { const result = new TypeError(message); result.status = status; result.code = code; return result; }
function text(value, name, maximum, { optional = false } = {}) {
  if (value === undefined && optional) return undefined;
  if (typeof value !== 'string') throw error(`${name} 必须是文本`);
  const result = value.normalize('NFC').trim();
  if (optional && !result) return '';
  if (!result || result.length > maximum || Buffer.byteLength(result, 'utf8') > maximum * 3) throw error(`${name} 长度无效`);
  return result;
}
function id(value, name = 'id') { const result = text(value, name, MAX_TEXT.id); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result)) throw error(`${name} 格式无效`); return result; }
function intensity(value, name) { if (!Number.isInteger(value) || value < 0 || value > 100) throw error(`${name} 必须是 0 到 100 的整数`); return value; }
function state() { return { needs: [], feelings: [], threads: [] }; }
function parse(value, fallback) { try { const result = JSON.parse(value); return plain(result) ? result : fallback; } catch { return fallback; } }
function equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function validateSettings(patch) {
  if (!plain(patch) || !Object.keys(patch).length) throw error('设置修改不能为空');
  if (Object.keys(patch).some(key => !Object.hasOwn(DEFAULT_SETTINGS, key))) throw error('设置包含未知字段');
  const next = {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'expressionPreferences') { if (typeof value !== 'string' || value.length > 2400) throw error('expressionPreferences 长度无效'); next[key] = value.normalize('NFC').trim(); }
    else if (key === 'city') next[key] = text(value, key, 80);
    else if (key === 'interests') { if (typeof value !== 'string' || value.length > 400) throw error('interests 长度无效'); next[key] = value.normalize('NFC').trim(); }
    else if (key === 'enabled' || key === 'discoveryEnabled') { if (typeof value !== 'boolean') throw error(`${key} 必须是布尔值`); next[key] = value; }
    else if (key === 'dailyDiscoveryCalls') { if (!Number.isInteger(value) || value < 0 || value > 6) throw error('dailyDiscoveryCalls 必须是 0 到 6 的整数'); next[key] = value; }
    else if (key === 'dailyDiscoveryTokens') { if (!Number.isInteger(value) || value < 2000 || value > 100000) throw error('dailyDiscoveryTokens 必须是 2000 到 100000 的整数'); next[key] = value; }
  }
  return next;
}

function validateChange(kind, input) {
  if (!plain(input)) throw error(`${kind} 项必须是对象`);
  const base = { id: id(input.id, `${kind}.id`), evidence: text(input.evidence, `${kind}.evidence`, MAX_TEXT.evidence) };
  if (kind === 'threads') {
    if (Object.keys(input).some(key => !['id', 'subject', 'progress', 'openQuestion', 'status', 'evidence'].includes(key))) throw error('thread 包含未知字段');
    if (!['open', 'resolved'].includes(input.status)) throw error('thread.status 无效');
    return { ...base, subject: text(input.subject, 'thread.subject', MAX_TEXT.subject), progress: text(input.progress, 'thread.progress', MAX_TEXT.progress), openQuestion: text(input.openQuestion, 'thread.openQuestion', MAX_TEXT.openQuestion, { optional: true }), status: input.status };
  }
  if (Object.keys(input).some(key => !['id', 'label', 'intensity', 'description', 'cause', 'evidence'].includes(key))) throw error(`${kind} 包含未知字段`);
  return { ...base, label: text(input.label, `${kind}.label`, MAX_TEXT.label), intensity: intensity(input.intensity, `${kind}.intensity`), description: text(input.description, `${kind}.description`, MAX_TEXT.description), cause: text(input.cause, `${kind}.cause`, MAX_TEXT.cause) };
}

function projected(row, projectSource) {
  if (!row || typeof row.text !== 'string') return null;
  const value = projectSource(row);
  if (value === false || value == null || (plain(value) && value.visible === false)) return null;
  if (typeof value === 'string') return { ...row, text: value };
  if (plain(value)) return { ...row, ...value, text: typeof value.text === 'string' ? value.text : row.text };
  return row;
}

export class CompanionDynamics {
  constructor(store, { clock = () => new Date(), projectSource = row => row } = {}) {
    if (!store?.db) throw new TypeError('store.db is required');
    if (typeof projectSource !== 'function') throw new TypeError('projectSource must be a function');
    this.store = store; this.clock = clock; this.projectSource = projectSource;
    store.db.exec(`CREATE TABLE IF NOT EXISTS companion_dynamics_settings (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, settings_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_dynamics_states (role_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, state_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_dynamics_receipts (assistant_message_id TEXT PRIMARY KEY, role_id TEXT NOT NULL, receipt_json TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS companion_dynamics_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, role_id TEXT NOT NULL, revision INTEGER NOT NULL, at TEXT NOT NULL, accepted_json TEXT NOT NULL, rejected_json TEXT NOT NULL);`);
    store.db.prepare('INSERT OR IGNORE INTO companion_dynamics_settings(id,revision,settings_json) VALUES(1,0,?)').run(JSON.stringify(DEFAULT_SETTINGS));
  }

  settings() { const row = this.store.db.prepare('SELECT * FROM companion_dynamics_settings WHERE id=1').get(); return { revision: Number(row.revision), ...DEFAULT_SETTINGS, ...parse(row.settings_json, DEFAULT_SETTINGS) }; }
  saveSettings(patch, expectedRevision) {
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw error('设置版本无效');
    const edit = validateSettings(patch);
    return this.store.transaction(() => {
      const current = this.settings();
      if (current.revision !== expectedRevision) throw error('设置已被更新，请刷新后重试', 409, 'STALE_COMPANION_DYNAMICS_SETTINGS');
      const next = { ...DEFAULT_SETTINGS, ...current, ...edit }; delete next.revision;
      if (equal(next, Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map(key => [key, current[key]])))) return current;
      const revision = current.revision + 1;
      this.store.db.prepare('UPDATE companion_dynamics_settings SET revision=?,settings_json=? WHERE id=1').run(revision, JSON.stringify(next));
      return { revision, ...next };
    });
  }

  #row(role) { return this.store.db.prepare('SELECT * FROM companion_dynamics_states WHERE role_id=?').get(role); }
  #visible(item) {
    const sources = Array.isArray(item.sources) ? item.sources : [];
    return sources.some(source => {
      const row = projected(this.store.getMessage?.(source.id) || this.store.db.prepare('SELECT id,role,speaker,text FROM messages WHERE id=?').get(source.id), this.projectSource);
      return row && row.role === item.role && typeof source.evidence === 'string' && row.text.includes(source.evidence);
    });
  }
  get(role = ROLE_ID) {
    if (role !== ROLE_ID) throw error('角色无效');
    const row = this.#row(role); const raw = row ? parse(row.state_json, state()) : state();
    const visible = kind => (Array.isArray(raw[kind]) ? raw[kind] : []).filter(item => this.#visible({ ...item, role })).map(({ sources, ...item }) => clone(item));
    return { revision: row ? Number(row.revision) : 0, updatedAt: row?.updated_at || null, needs: visible('needs'), feelings: visible('feelings'), threads: visible('threads') };
  }

  commit(role = ROLE_ID, proposal, { rows = [], expectedRevision } = {}) {
    if (role !== ROLE_ID) throw error('角色无效');
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw error('状态版本无效');
    const actualRows = Array.isArray(rows) ? rows.filter(item => item && typeof item === 'object').map(item => projected(item, this.projectSource)).filter(Boolean) : [];
    const messageId = [...actualRows].reverse().find(item => item.role === role && item.speaker === 'assistant' && typeof item.id === 'string')?.id;
    return this.store.transaction(() => {
      if (messageId) { const prior = this.store.db.prepare('SELECT * FROM companion_dynamics_receipts WHERE assistant_message_id=?').get(messageId); if (prior) { if (prior.role_id !== role) throw error('消息回执属于另一角色', 409, 'COMPANION_DYNAMICS_RECEIPT_CONFLICT'); return parse(prior.receipt_json, { accepted: [], rejected: [], revision: this.get(role).revision }); } }
      const currentRow = this.#row(role); const currentRevision = currentRow ? Number(currentRow.revision) : 0;
      if (currentRevision !== expectedRevision) throw error('状态已被更新，请刷新后重试', 409, 'STALE_COMPANION_DYNAMICS');
      const receipt = this.#apply(role, currentRow, proposal, actualRows);
      if (messageId) this.store.db.prepare('INSERT INTO companion_dynamics_receipts(assistant_message_id,role_id,receipt_json,created_at) VALUES(?,?,?,?)').run(messageId, role, JSON.stringify(receipt), nowIso(this.clock));
      this.store.db.prepare('INSERT INTO companion_dynamics_audit(role_id,revision,at,accepted_json,rejected_json) VALUES(?,?,?,?,?)').run(role, receipt.revision, nowIso(this.clock), JSON.stringify(receipt.accepted), JSON.stringify(receipt.rejected));
      this.store.db.prepare('DELETE FROM companion_dynamics_audit WHERE id NOT IN (SELECT id FROM companion_dynamics_audit ORDER BY id DESC LIMIT ?)').run(MAX_AUDIT);
      return receipt;
    });
  }

  #apply(role, row, proposal, rows) {
    const current = row ? parse(row.state_json, state()) : state();
    const accepted = [], rejected = [];
    const dynamics = plain(proposal) && plain(proposal.dynamics) ? proposal.dynamics : null;
    if (!dynamics || Buffer.byteLength(JSON.stringify(dynamics), 'utf8') > MAX_PROPOSAL_BYTES) return { accepted, rejected: dynamics ? [{ reason: 'malformed_dynamics' }] : rejected, revision: row ? Number(row.revision) : 0 };
    if (Object.keys(dynamics).some(key => !['needs', 'feelings', 'threads', 'remove'].includes(key))) return { accepted, rejected: [{ reason: 'malformed_dynamics' }], revision: row ? Number(row.revision) : 0 };
    const sourceRows = Array.isArray(rows) ? rows.filter(item => item && typeof item === 'object').map(item => projected(item, this.projectSource)).filter(Boolean) : [];
    const lastAssistant = [...sourceRows].reverse().find(item => item.role === role && item.speaker === 'assistant');
    const evidence = value => {
      const source = sourceRows.find(item => item.role === role && typeof item.id === 'string' && typeof item.text === 'string' && item.text.includes(value) && (item.speaker === 'user' || (lastAssistant && item.id === lastAssistant.id)));
      return source ? { id: source.id, evidence: value, speaker: source.speaker } : null;
    };
    const next = clone(current); let changed = false;
    for (const kind of ['needs', 'feelings', 'threads']) {
      if (dynamics[kind] === undefined) continue;
      if (!Array.isArray(dynamics[kind]) || dynamics[kind].length > MAX_ITEMS[kind]) { rejected.push({ kind, reason: 'malformed' }); continue; }
      for (const input of dynamics[kind]) try {
        const item = validateChange(kind, input), source = evidence(item.evidence);
        if (!source) { rejected.push({ kind, id: input?.id, reason: 'invalid_evidence' }); continue; }
        const stored = { ...item, sources: [source], updatedAt: nowIso(this.clock) }; delete stored.evidence;
        const index = next[kind].findIndex(entry => entry.id === item.id);
        if (index < 0 && next[kind].length >= MAX_ITEMS[kind]) { rejected.push({ kind, id: item.id, reason: 'limit' }); continue; }
        if (index >= 0 && equal(next[kind][index], stored)) continue;
        if (index >= 0) next[kind][index] = stored; else next[kind].push(stored);
        changed = true; accepted.push({ kind, id: item.id });
      } catch { rejected.push({ kind, id: input?.id, reason: 'malformed' }); }
    }
    if (dynamics.remove !== undefined) {
      if (!Array.isArray(dynamics.remove) || dynamics.remove.length > 24) rejected.push({ kind: 'remove', reason: 'malformed' });
      else for (const entry of dynamics.remove) try {
        const removal = plain(entry) ? { id: id(entry.id, 'remove.id'), evidence: text(entry.evidence, 'remove.evidence', MAX_TEXT.evidence) } : null;
        if (!removal || !evidence(removal.evidence)) { rejected.push({ kind: 'remove', id: entry?.id, reason: 'invalid_evidence' }); continue; }
        let removed = false; for (const kind of ['needs', 'feelings', 'threads']) { const index = next[kind].findIndex(item => item.id === removal.id); if (index >= 0) { next[kind].splice(index, 1); removed = changed = true; } }
        if (removed) accepted.push({ kind: 'remove', id: removal.id });
      } catch { rejected.push({ kind: 'remove', id: entry?.id, reason: 'malformed' }); }
    }
    if (!changed) return { accepted, rejected, revision: row ? Number(row.revision) : 0 };
    const revision = (row ? Number(row.revision) : 0) + 1, updatedAt = nowIso(this.clock);
    this.store.db.prepare('INSERT INTO companion_dynamics_states(role_id,revision,updated_at,state_json) VALUES(?,?,?,?) ON CONFLICT(role_id) DO UPDATE SET revision=excluded.revision,updated_at=excluded.updated_at,state_json=excluded.state_json').run(role, revision, updatedAt, JSON.stringify(next));
    return { accepted, rejected, revision };
  }

  context(role = ROLE_ID, { now = this.clock(), baseline = '' } = {}) {
    const view = this.get(role), settings = this.settings(), current = date(now);
    const age = view.updatedAt ? Math.max(0, Math.round((current.getTime() - Date.parse(view.updatedAt)) / 60000)) : null;
    const short = (value, maximum = 48) => typeof value === 'string' && value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
    const affect = value => ({ id: value.id, label: short(value.label), intensity: value.intensity, cause: short(value.cause), updatedAt: value.updatedAt });
    const thread = value => ({ id: value.id, subject: short(value.subject), progress: short(value.progress), openQuestion: short(value.openQuestion), status: value.status, updatedAt: value.updatedAt });
    const data = { version: 1, stateRevision: view.revision, settingsRevision: settings.revision, updatedAt: view.updatedAt, ageMinutes: age, settings: { expressionPreferences: short(settings.expressionPreferences, 300), enabled: settings.enabled, discoveryEnabled: settings.discoveryEnabled, city: short(settings.city), interests: short(settings.interests), dailyDiscoveryCalls: settings.dailyDiscoveryCalls, dailyDiscoveryTokens: settings.dailyDiscoveryTokens }, data: { needs: view.needs.map(affect), feelings: view.feelings.map(affect), threads: view.threads.map(thread) } };
    return [String(baseline || '').trim().slice(0, 500), '【伴侣动态数据】', JSON.stringify(data), '【使用】结合经过时间与新事件重新判断；不要机械衰减，保留未解决和已解决线索；这些是角色主观提示，不替代现实身体状况、用户事实或双方同意。'].filter(Boolean).join('\n');
  }
}
