import { createHash, randomUUID } from 'node:crypto';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MAX_DUE = 365 * DAY;
const KINDS = new Set(['reading', 'film', 'cooking', 'quiet', 'chat', 'ritual', 'outing']);
const BASE_INTERESTS = [
  ['设计', 0.45], ['食物', 0.35], ['书', 0.5], ['旅行', 0.3],
];

const clone = value => structuredClone(value);
const clean = value => String(value ?? '').normalize('NFKC').trim();
const norm = value => clean(value).toLocaleLowerCase('zh-CN').replace(/[\s，。！？、,.!?《》“”'"：:；;（）()\[\]]+/gu, '');
const clip = (value, n) => clean(value).length <= n ? clean(value) : `${clean(value).slice(0, n - 1)}…`;
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 20);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const iso = value => {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw invalid('日期无效');
  return date.toISOString();
};
const invalid = (message, code = 'INVALID_COMPANION_AGENDA') => Object.assign(new Error(message), { status: 400, code });

function chineseNumber(value) {
  if (/^\d+$/u.test(value)) return Number(value);
  const digits = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (value === '十') return 10;
  const match = value.match(/^([一二两三四五六七八九])?十([一二三四五六七八九])?$/u);
  if (match) return (match[1] ? digits[match[1]] : 1) * 10 + (match[2] ? digits[match[2]] : 0);
  return digits[value] || 0;
}

function dbMessage(row) {
  if (!row) return null;
  return {
    id: clean(row.id), role: clean(row.role ?? row.role_id), speaker: clean(row.speaker),
    text: String(row.text ?? ''), createdAt: clean(row.createdAt ?? row.created_at),
  };
}

function speakerSource(speaker) { return speaker === 'user' ? 'user' : speaker === 'assistant' ? 'assistant' : null; }

function parseShanghaiDate(text, now) {
  const input = clean(text);
  let dayOffset;
  let hour = 20;
  if (/今晚/u.test(input)) dayOffset = 0;
  else if (/明天/u.test(input)) dayOffset = 1;
  else if (/周末/u.test(input)) {
    const local = new Date(now.getTime() + 8 * HOUR);
    const weekday = local.getUTCDay();
    dayOffset = weekday === 6 ? 0 : weekday === 0 ? 0 : 6 - weekday;
    hour = 10;
  } else return null;
  const local = new Date(now.getTime() + 8 * HOUR);
  const due = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayOffset, hour - 8, 0, 0);
  return new Date(Math.max(due, now.getTime())).toISOString();
}

function occurrenceId(plan, at) {
  const local = new Date(at.getTime() + 8 * HOUR);
  const date = `${local.getUTCFullYear()}-${String(local.getUTCMonth() + 1).padStart(2, '0')}-${String(local.getUTCDate()).padStart(2, '0')}`;
  return `${plan.id}:${date}`;
}

function nextOccurrence(plan, after) {
  const recurrence = plan.recurrence;
  if (!recurrence) return null;
  const [hh, mm] = clean(recurrence.time || '20:00').split(':').map(Number);
  const local = new Date(after.getTime() + 8 * HOUR);
  let next = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), clamp(hh || 0, 0, 23) - 8, clamp(mm || 0, 0, 59));
  if (next <= after.getTime()) next += DAY;
  if (recurrence.frequency === 'weekly') {
    const wanted = Number.isInteger(recurrence.weekday) ? clamp(recurrence.weekday, 0, 6) : local.getUTCDay();
    const candidate = new Date(next + 8 * HOUR);
    let days = (wanted - candidate.getUTCDay() + 7) % 7;
    if (!days && next <= after.getTime()) days = 7;
    next += days * DAY;
  }
  return new Date(next).toISOString();
}

function mostRecentOccurrence(plan, now) {
  if (!plan.recurrence) return null;
  let cursor = new Date(now.getTime() - 8 * DAY), latest = null;
  for (let steps = 0; steps < 10; steps += 1) {
    const candidate = nextOccurrence(plan, cursor);
    if (!candidate || Date.parse(candidate) > now.getTime()) break;
    latest = candidate; cursor = new Date(Date.parse(candidate));
  }
  return latest;
}

function titleFromRecommendation(text) {
  const book = text.match(/推荐你(?:看看|读读|读|看)?\s*[《「『](.{1,80}?)[》」』]/u);
  if (book) return { title: book[1].trim(), kind: /电影|影片/u.test(text)?'film':'reading' };
  const tryIt = text.match(/你可以试试\s*([^，。！？!?]{2,40})/u);
  if (tryIt) return { title: tryIt[1].trim(), kind: /面|饭|菜|汤|烤|煮|做/u.test(tryIt[1]) ? 'cooking' : 'quiet' };
  return null;
}

function jointFromText(text) {
  let match = text.match(/(?:今晚|明天|周末)?\s*一起读\s*[《「『](.{1,80}?)[》」』]/u);
  if (match) return { title: match[1].trim(), kind: 'reading' };
  match = text.match(/(?:今晚|明天|周末)?\s*一起看\s*[《「『]?([^》」』，。！？!?]{1,80})/u);
  if (match) return { title: match[1].trim(), kind: 'film' };
  match = text.match(/陪我(?:安静)?待\s*([一二三四五六七八九十\d]+)\s*分钟/u);
  if (match) return { title: `安静待${match[1]}分钟`, kind: 'quiet', durationMinutes: chineseNumber(match[1]) || 10 };
  return null;
}

function candidateId(roleId, row, candidate, index) {
  return candidate.id ? clean(candidate.id) : `agenda-${hash(JSON.stringify([roleId, row.id, candidate.action, candidate.kind, candidate.title, index]))}`;
}

function supportsAction(action, evidence) {
  const value = clean(evidence);
  if (!value || /(?:如果|假如|假设|台词|他说|她说|有人说)/u.test(value)) return false;
  if(['complete','start','resume','recommend','propose'].includes(action)&&/(?:没|还没|尚未|(?<!要)不要|别|不想|并未|不能).{0,6}(?:完成|结束|读完|看完|开始|继续|一起|推荐)/u.test(value))return false;
  if (action === 'complete') return /完成|完了|结束|看完|读完|做完|听完|结束了|finished|completed/iu.test(value);
  if (action === 'cancel') return /取消|算了|不想|不去了|不看了|不读了|改天|别再|cancel/iu.test(value);
  if (action === 'recommend') return /推荐|可以试试|不妨试试|recommend/iu.test(value);
  if (action === 'propose') return /一起|要不要|想不想|打算|计划|陪我|约|我会|答应|说好|promise|would you|shall we/iu.test(value);
  if (action === 'accept') return /^(?:嗯[，,\s]*)?(?:好|好呀|好啊|可以|行|那就|没问题|同意|愿意)|一起|就这么定|accept|agree/iu.test(value);
  if (action === 'progress') return value.length >= 2 && !/^(?:好|嗯|行|可以|知道了)$/u.test(value);
  if (action === 'start') return /开始|现在来|现在做|start/iu.test(value);
  if (action === 'pause') return /暂停|先停|歇一下|pause/iu.test(value);
  if (action === 'resume') return /继续|接着|resume/iu.test(value);
  return value.length >= 2;
}

function publicPlan(plan) {
  const copy = clone(plan);
  delete copy.opportunityIds;
  return copy;
}

export function itemWeight(item, interests = []) {
  const semanticKind = { reading: '书 阅读', film: '电影', cooking: '食物 烹饪', travel: '旅行', design: '设计' }[item?.kind] || '';
  const haystack = norm([item?.title, item?.kind, semanticKind, ...(item?.interests ?? []), ...(item?.tags ?? [])].join(' '));
  let result = 1;
  for (const interest of interests ?? []) {
    if (interest?.audience === 'user' || interest?.status === 'suppressed') continue;
    const title = norm(interest?.title);
    if (!title || !haystack.includes(title)) continue;
    result *= Math.pow(1.32, clamp(Number(interest.value) || 0, -2, 2));
  }
  return clamp(Number(result.toFixed(4)), 0.25, 3);
}

export function promptInstruction() {
  return '可在同一次回复的 companionship.agenda 数组中附带0到3个候选。字段：action=propose|accept|start|pause|resume|progress|complete|cancel|recommend|interest；kind=reading|film|cooking|quiet|chat|ritual|outing；source=user|assistant；evidence必须逐字来自对应已保存消息；可选 id/title/owner=character|user|joint/dueAt/progress/sentiment/location（仅她自己的出门活动）。id用于续接已有计划。提议和接受分开记录；到期不等于完成；不得声称用户做过未确认的事。';
}

export const COMPANION_AGENDA_PROMPT_INSTRUCTION = promptInstruction();

export class CompanionAgenda {
  constructor(store, { clock = () => new Date(), random = Math.random, getSuppressedSourceIds=()=>[] } = {}) {
    if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('CompanionAgenda requires a transactional store');
    this.store = store;
    this.clock = clock;
    this.random = random;this.getSuppressedSourceIds=getSuppressedSourceIds;
    store.db.exec(`
      CREATE TABLE IF NOT EXISTS companion_agenda_state (
        role_id TEXT PRIMARY KEY, revision INTEGER NOT NULL, state_json TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS companion_agenda_deliveries (
        role_id TEXT NOT NULL, opportunity_key TEXT NOT NULL, version INTEGER NOT NULL,
        message_id TEXT NOT NULL, delivered_at TEXT NOT NULL,
        PRIMARY KEY(role_id, opportunity_key), UNIQUE(role_id, message_id)
      );
    `);
  }

  #now() {
    const date = this.clock();
    const result = date instanceof Date ? new Date(date) : new Date(date);
    if (!Number.isFinite(result.getTime())) throw new TypeError('CompanionAgenda clock returned an invalid date');
    return result;
  }

  #initial(roleId) {
    const now = this.#now().toISOString();
    return {
      schema: 1, roleId, revision: 0, createdAt: now,
      plans: [], opportunities: [], processedMessageIds: [], tombstones: [],
      interests: BASE_INTERESTS.map(([title, value]) => ({ id: `base-${hash(title)}`, title, value, audience: 'character', source: 'base', quotes: [] })),
    };
  }

  #load(roleId) {
    const row = this.store.db.prepare('SELECT state_json FROM companion_agenda_state WHERE role_id=?').get(roleId);
    if (!row) return this.#initial(roleId);
    try { return JSON.parse(row.state_json); } catch { throw new Error(`Invalid companion agenda state for ${roleId}`); }
  }

  #save(state, now = this.#now()) {
    state.plans = state.plans.slice(-100);
    state.opportunities = state.opportunities.slice(-160);
    state.processedMessageIds = state.processedMessageIds.slice(-500);
    state.interests = state.interests.slice(-60);
    this.store.db.prepare(`
      INSERT INTO companion_agenda_state(role_id,revision,state_json,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(role_id) DO UPDATE SET revision=excluded.revision,state_json=excluded.state_json,updated_at=excluded.updated_at
    `).run(state.roleId, state.revision, JSON.stringify(state), now.toISOString());
  }

  #opportunity(state, plan, type, anchor, detail, sourceMessageId, at = this.#now()) {
    const existing = state.opportunities.find(item => item.planId === plan.id && item.type === type && item.occurrenceId === (plan.currentOccurrenceId ?? null) && !item.expiredAt);
    if (existing) return existing;
    const sequence = state.opportunities.filter(item => item.planId === plan.id && item.type === type).length + 1;
    let naturalAnchor = anchor;
    if (type === 'opening') {
      if (plan.owner === 'joint') naturalAnchor = `我们约的${['reading', 'film'].includes(plan.kind) ? `《${plan.title}》` : plan.title}到时间了，你这会儿方便开始吗？`;
      else if (plan.recommendation) naturalAnchor = plan.kind === 'cooking'
        ? `你前面推荐的${plan.title}，我开始试着做了。`
        : `你前面推荐的《${plan.title}》，我开始看了。`;
      else naturalAnchor = `我开始${plan.title}了。`;
    } else if (type === 'finish-check') naturalAnchor = plan.kind === 'quiet' ? '刚才约的安静时间到了。' : `刚才约的${plan.title}到时间了。`;
    else if (type === 'followup') naturalAnchor = `之前说的${plan.title}，你还想继续吗？`;
    else if (type === 'outcome') naturalAnchor = plan.recommendation
      ? `你前面推荐的${['reading', 'film'].includes(plan.kind) ? `《${plan.title}》` : plan.title}，我做完后还想跟你说说。`
      : `${plan.title}这件事有结果了。`;
    const opportunity = {
      key: `agenda:${plan.id}:${type}:${sequence}`, version: 1, title: plan.title, kind: plan.kind,
      anchor: clip(naturalAnchor, 160), detail: clip(`${detail}；正文直接承接这句，不要复述开头`, 500), planId: plan.id, type,
      sourceMessageId: sourceMessageId || plan.sourceMessageId || null,
      occurrenceId: plan.currentOccurrenceId ?? null, createdAt: at.toISOString(), expiresAt: new Date(at.getTime() + 48 * HOUR).toISOString(),
      deliveredAt: null, expiredAt: null,
    };
    state.opportunities.push(opportunity);
    return opportunity;
  }

  #addInterest(state, { title, value, audience, source, row }) {
    const normalized = norm(title);
    if (!normalized) return;
    const duplicate = state.interests.find(entry => entry.sourceMessageIds?.includes(row.id) && norm(entry.title) === normalized);
    if (duplicate) return;
    let entry = state.interests.find(item => item.audience === audience && norm(item.title) === normalized);
    if (!entry) {
      entry = { id: `interest-${hash(`${audience}:${normalized}`)}`, title: clip(title, 60), value: 0, audience, source, quotes: [], sourceMessageIds: [] };
      state.interests.push(entry);
    }
    entry.value = clamp((Number(entry.value) || 0) + clamp(Number(value) || 0, -2, 2), -2, 2);
    entry.quotes = [...(entry.quotes || []), { id: row.id, speaker: row.speaker, text: clip(row.text, 240) }].slice(-5);
    entry.sourceMessageIds = [...new Set([...(entry.sourceMessageIds || []), row.id])].slice(-12);
  }

  #newPlan(state, data, row, now) {
    const id = data.id || `plan-${hash(`${state.roleId}:${row.id}:${data.kind}:${data.title}`)}`;
    const existing = state.plans.find(plan => plan.id === id);
    if (existing) return existing;
    const plan = {
      id, kind: data.kind, title: clip(data.title || data.kind, 120), owner: data.owner,
      status: data.status || 'proposed', proposer: row.speaker === 'user' ? 'user' : 'character',
      createdAt: now.toISOString(), updatedAt: now.toISOString(), dueAt: data.dueAt || null,
      progress: data.progress ?? null, sourceMessageId: row.id,
      sources: [{ messageId: row.id, speaker: row.speaker, quote: clip(row.text, 300) }],
      recommendation: Boolean(data.recommendation), durationMinutes: data.durationMinutes || null,
      location: data.location || null,
      recurrence: data.recurrence || null, currentOccurrenceId: null, finishCheckCreated: false,
    };
    state.plans.push(plan);
    return plan;
  }

  #validateDue(value, createdAt, { allowPast = false } = {}) {
    if (value == null || value === '') return null;
    const dueAt = iso(value);
    const delta = Date.parse(dueAt) - Date.parse(createdAt);
    if ((!allowPast && delta < 0) || delta > MAX_DUE) throw invalid('计划日期必须在创建后365天内');
    return dueAt;
  }

  #adjacent(plan, row) {
    const current = this.store.db.prepare('SELECT rowid FROM messages WHERE id=? AND role=?').get(row.id, row.role);
    if (!current) return false;
    const previous = this.store.db.prepare('SELECT id,speaker FROM messages WHERE role=? AND rowid<? ORDER BY rowid DESC LIMIT 1').get(row.role, current.rowid);
    return previous?.id === plan.sourceMessageId && previous.speaker !== row.speaker;
  }

  #resolveCommandPlan(state, row, statuses) {
    const eligible = state.plans.filter(plan => statuses.includes(plan.status));
    const byTitle = eligible.filter(plan => norm(row.text).includes(norm(plan.title)));
    if (byTitle.length === 1) return byTitle[0];
    if (byTitle.length > 1) return null;
    const current = this.store.db.prepare('SELECT rowid FROM messages WHERE id=? AND role=?').get(row.id, row.role);
    const previous = current && this.store.db.prepare('SELECT id FROM messages WHERE role=? AND rowid<? ORDER BY rowid DESC LIMIT 1').get(row.role, current.rowid);
    if (previous) {
      const linked = eligible.filter(plan => state.opportunities.some(opportunity => opportunity.planId === plan.id && opportunity.messageId === previous.id));
      if (linked.length === 1) return linked[0];
    }
    return eligible.length === 1 ? eligible[0] : null;
  }

  #applyCandidate(state, candidate, row, index, now) {
    const action = clean(candidate.action);
    if (!['propose', 'accept', 'start', 'pause', 'resume', 'progress', 'complete', 'cancel', 'recommend', 'interest'].includes(action)) return false;
    if (!supportsAction(action, candidate.evidence)) return false;
    if(['complete','start','resume','recommend','propose'].includes(action)&&/(?:没|还没|尚未|(?<!要)不要|别|不想|并未|不能).{0,6}(?:完成|结束|读完|看完|开始|继续|一起|推荐)/u.test(row.text))return false;
    const kind = clean(candidate.kind || 'chat');
    if (!KINDS.has(kind)) return false;
    const id = candidateId(state.roleId,row,candidate,index);
    if(['propose','recommend'].includes(action)&&state.plans.some(p=>p.id===id))return false;
    const title = clip(candidate.title || candidate.evidence || kind, 120);
    if(['propose','recommend'].includes(action)&&['reading','film'].includes(kind)&&!norm(row.text).includes(norm(title)))return false;
    if (action === 'recommend') {
      if (row.speaker !== 'user') return false;
      if (candidate.title && clean(candidate.evidence) !== clean(row.text) && !norm(row.text).includes(norm(title))) return false;
      if (state.plans.filter(plan => plan.status === 'suggested').length >= 30) return false;
      const dueAt = new Date(now.getTime() + (24 + clamp(Number(this.random()) || 0, 0, .999999) * 24) * HOUR).toISOString();
      const plan = this.#newPlan(state, { id, kind, title, owner: 'character', status: 'suggested', dueAt, recommendation: true }, row, now);
      plan.provenance = `你前面推荐的${kind === 'reading' || kind === 'film' ? `《${plan.title}》` : plan.title}`;
      this.#addInterest(state, { title: plan.title, value: .35, audience: 'character', source: 'user-recommendation', row });
      return true;
    }
    if (action === 'interest') {
      if(!norm(row.text).includes(norm(title))||!/(?:喜欢|偏爱|感兴趣|爱看|不喜欢|讨厌|不爱)/u.test(row.text))return false;
      const direction=/(?:不喜欢|讨厌|不爱)/u.test(row.text)?-1:1;
      this.#addInterest(state, {
        title, value: direction*Math.min(1,Math.abs(Number(candidate.sentiment??candidate.value)||.25)),
        audience: row.speaker === 'assistant' ? 'character' : 'user', source: 'observation', row,
      });
      return true;
    }
    let plan = candidate.id ? state.plans.find(item => item.id === clean(candidate.id)) : null;
    if (action === 'propose') {
      if (candidate.title && clean(candidate.evidence) !== clean(row.text) && !norm(row.text).includes(norm(title))) return false;
      const owner = candidate.owner === 'character' ? 'character' : candidate.owner === 'user' ? 'user' : 'joint';
      const dueAt = this.#validateDue(candidate.dueAt || parseShanghaiDate(row.text, now), now.toISOString());
      plan = this.#newPlan(state, { id, kind, title, owner, status: 'proposed', dueAt, durationMinutes: candidate.durationMinutes }, row, now);
      if (row.speaker === 'assistant') {
        const followAt = new Date(dueAt ? Date.parse(dueAt) : now.getTime() + 24 * HOUR);
        this.#opportunity(state, plan, 'followup', plan.title, `此前提出过${plan.title}，可以轻轻确认；没有回应就不追问`, row.id, followAt);
      }
      return true;
    }
    if(candidate.id&&!plan)return false;
    if (!plan && ['start', 'pause', 'resume', 'progress', 'complete', 'cancel'].includes(action)) {
      const statuses = action === 'start' ? ['planned', 'awaiting_confirmation']
        : action === 'pause' ? ['active'] : action === 'resume' ? ['paused']
          : ['planned', 'active', 'paused', 'awaiting_confirmation'];
      plan = this.#resolveCommandPlan(state, row, statuses);
    } else if (!plan) {
      const candidates = state.plans.filter(item => !['completed', 'cancelled'].includes(item.status));
      plan = candidates.reverse().find(item => action !== 'accept' || item.status === 'proposed');
    }
    if (!plan) return false;
    if (action === 'accept') {
      if (plan.status !== 'proposed' || plan.proposer === (row.speaker === 'user' ? 'user' : 'character')) return false;
      if (!this.#adjacent(plan, row)) return false;
      plan.status = 'planned'; plan.acceptedAt = now.toISOString(); plan.acceptedBy = row.speaker === 'user' ? 'user' : 'character';
      if(plan.kind==='quiet'&&!plan.dueAt){plan.status='active';plan.startedAt=now.toISOString();plan.endAt=new Date(now.getTime()+(plan.durationMinutes||10)*60000).toISOString();}
      for (const opportunity of state.opportunities) {
        if (opportunity.planId === plan.id && opportunity.type === 'followup' && !opportunity.deliveredAt && !opportunity.expiredAt) opportunity.expiredAt = now.toISOString();
      }
    } else if (['start', 'pause', 'resume'].includes(action)) {
      if (plan.owner === 'joint' && row.speaker !== 'user') return false;
      if (action === 'start' && !['planned', 'awaiting_confirmation'].includes(plan.status)) return false;
      if (action === 'pause' && plan.status !== 'active') return false;
      if (action === 'resume' && plan.status !== 'paused') return false;
      if (action === 'pause') {
        if (plan.kind === 'quiet' && plan.endAt) plan.remainingMs = Math.max(0, Date.parse(plan.endAt) - now.getTime());
        plan.status = 'paused';
        for (const opportunity of state.opportunities) if (opportunity.planId === plan.id && !opportunity.deliveredAt && !opportunity.expiredAt) opportunity.expiredAt = now.toISOString();
      } else {
        plan.status = 'active'; plan.startedAt = now.toISOString();
        if (plan.kind === 'quiet' && plan.durationMinutes) {
          const duration = action === 'resume' && Number.isFinite(plan.remainingMs) ? plan.remainingMs : plan.durationMinutes * 60_000;
          plan.endAt = new Date(now.getTime() + duration).toISOString(); delete plan.remainingMs;
        }
      }
    } else if (action === 'progress') {
      if (['cancelled', 'completed', 'proposed'].includes(plan.status)) return false;
      if(plan.owner==='joint'&&row.speaker!=='user'||plan.owner==='user'&&row.speaker!=='user')return false;
      plan.status = plan.status === 'paused' ? 'paused' : 'active';
      plan.progress = clip(candidate.evidence,240); plan.lastProgressActor = row.speaker === 'user' ? 'user' : 'character';
      plan.nextStep = typeof candidate.nextStep==='string'&&row.text.includes(candidate.nextStep)?candidate.nextStep:null;
    } else if (action === 'complete') {
      if (plan.status === 'proposed' || plan.status === 'cancelled') return false;
      if (plan.owner === 'character' && row.speaker !== 'assistant') return false;
      if (['joint','user'].includes(plan.owner) && row.speaker !== 'user') return false;
      for (const opportunity of state.opportunities) {
        if (opportunity.planId === plan.id && !opportunity.deliveredAt && !opportunity.expiredAt) opportunity.expiredAt = now.toISOString();
      }
      plan.status = 'completed'; plan.completedAt = now.toISOString(); plan.completedBy = row.speaker === 'user' ? 'user' : 'character';
      this.#opportunity(state, plan, 'outcome', plan.title, plan.owner === 'character' ? `说清这次${plan.title}的实际结果，并承接此前推荐` : `确认${plan.title}的共同结果`, row.id, now);
      if (plan.recurrence) plan.dueAt = nextOccurrence(plan, now);
    } else if (action === 'cancel') {
      if(['joint','user'].includes(plan.owner)&&row.speaker!=='user')return false;
      for (const opportunity of state.opportunities) {
        if (opportunity.planId === plan.id && !opportunity.deliveredAt && !opportunity.expiredAt) opportunity.expiredAt = now.toISOString();
      }
      plan.status = 'cancelled'; plan.cancelledAt = now.toISOString(); plan.cancelledBy = row.speaker === 'user' ? 'user' : 'character';
    }
    plan.sources.push({ messageId: row.id, speaker: row.speaker, quote: clip(row.text, 300) });
    plan.updatedAt = now.toISOString();
    return true;
  }

  observe(roleId, savedRows, candidates = []) {
    const role = clean(roleId);
    if (!role || !Array.isArray(savedRows)) return this.view(role);
    const now = this.#now();
    return this.store.transaction(() => {
      const state = this.#load(role);
      let changed = false;
      const rows = savedRows.map(input => {
        const id = clean(input?.id);
        if (!id) return null;
        return dbMessage(this.store.getMessage?.(id) ?? this.store.db.prepare('SELECT * FROM messages WHERE id=?').get(id));
      }).filter(row => row?.id && row.role === role && ['user', 'assistant'].includes(row.speaker) && row.text);
      const explicit = Array.isArray(candidates) ? candidates.slice(0, 3) : [];
      const work = [];
      explicit.forEach((candidate, index) => {
        if (!candidate || typeof candidate !== 'object') return;
        const evidence = String(candidate.evidence ?? '').trim();
        if (!evidence) return;
        const row = [...rows].reverse().find(entry => entry.text.includes(evidence)&&(!candidate.source||candidate.source===entry.speaker));
        if (!row || state.processedMessageIds.includes(row.id) || (candidate.source && candidate.source !== speakerSource(row.speaker))) return;
        work.push({ candidate, row, index });
      });
      for (const row of rows) {
        if (state.processedMessageIds.includes(row.id)) continue;
        if (row.speaker === 'user') {
          const recommendation = titleFromRecommendation(row.text);
          if (recommendation && !work.some(entry => entry.row.id === row.id && entry.candidate.action === 'recommend')) {
            work.push({ candidate: { action: 'recommend', ...recommendation, evidence: row.text }, row, index: work.length });
          }
          const joint = jointFromText(row.text);
          if (joint && !work.some(entry => entry.row.id === row.id && entry.candidate.action === 'propose')) {
            work.push({ candidate: { action: 'propose', ...joint, evidence: row.text }, row, index: work.length });
          }
          if (/^(?:好|好呀|好啊|可以|行|那就|没问题)(?:[，,。.!！\s]|$)/u.test(row.text.trim())) {
            const proposed = [...state.plans].reverse().find(plan => plan.status === 'proposed' && plan.proposer === 'character');
            if (proposed && !work.some(entry => entry.row.id === row.id && entry.candidate.action === 'accept')) {
              work.push({ candidate: { action: 'accept', id: proposed.id, kind: proposed.kind, evidence: row.text }, row, index: work.length });
            }
          }
          const command = /先?暂停一下|先停一下/u.test(row.text) ? 'pause'
            : /现在开始吧|现在开始|开始吧/u.test(row.text) ? 'start'
              : /继续刚才那个|继续吧|接着来/u.test(row.text) ? 'resume' : null;
          if (command && !work.some(entry => entry.row.id === row.id && entry.candidate.action === command)) {
            work.push({ candidate: { action: command, kind: 'chat', evidence: row.text }, row, index: work.length });
          }
        }
        if(!work.some(entry=>entry.row.id===row.id&&['progress','complete'].includes(entry.candidate.action))) {
          for(const sentence of row.text.split(/[。！？!?\n]/u).filter(Boolean)) {
            if(!/(?:读完|看完|读到|看到第|还剩|剩最后)/u.test(sentence)||/(?:想|打算|准备|将|要|没|还没|不能|如果|假如).{0,8}(?:读完|看完|读到|看到第)/u.test(sentence))continue;
            const kind=/读|书|章/u.test(sentence)?'reading':'film';
            const eligible=state.plans.filter(plan=>plan.kind===kind&&['active','paused','planned','awaiting_confirmation'].includes(plan.status)&&(row.speaker==='assistant'?plan.owner==='character':plan.owner!=='character'));
            const named=eligible.filter(plan=>norm(row.text).includes(norm(plan.title)));
            const plan=named.length===1?named[0]:!/[《「『]/u.test(row.text)&&eligible.length===1?eligible[0]:null;
            if(!plan)continue;
            const action=/(?:读完|看完)/u.test(sentence)&&!/(?:读完|看完).{0,3}(?:前|后再|以后|就|的话)/u.test(sentence)?'complete':'progress';
            if(action==='complete'&&/(?:读完|看完).{0,8}(?:第[一二三四五六七八九十\d]+章|一章|几页)/u.test(sentence)&&!/(?:最后|全书|整本|整部)/u.test(sentence))continue;
            work.push({candidate:{action,id:plan.id,kind,evidence:sentence,source:row.speaker},row,index:work.length});break;
          }
        }
        state.processedMessageIds.push(row.id);
      }
      const rowOrder = new Map(rows.map((row, index) => [row.id, index]));
      work.sort((a, b) => (rowOrder.get(a.row.id) ?? 0) - (rowOrder.get(b.row.id) ?? 0)
        || Number(b.candidate.action === 'propose') - Number(a.candidate.action === 'propose'));
      const seen = new Set();
      for (const entry of work.slice(0, 3)) {
        const key = `${entry.row.id}:${entry.candidate.action}:${entry.candidate.id || norm(entry.candidate.title)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        changed = this.#applyCandidate(state, entry.candidate, entry.row, entry.index, now) || changed;
      }
      // An explicit user invitation followed by a delivered acceptance is
      // sufficient even when the model omitted optional metadata.
      for(const row of rows.filter(r=>r.speaker==='assistant')){
        const plan=[...state.plans].reverse().find(p=>p.status==='proposed'&&p.proposer==='user'&&this.#adjacent(p,row));
        if(plan&&/^(?:嗯[，, ]*)?(?:好|可以|行|没问题|陪你|我陪你)/u.test(row.text)) {
          changed=this.#applyCandidate(state,{action:'accept',id:plan.id,kind:plan.kind,evidence:row.text},row,0,now)||changed;
          if(plan.status==='planned'&&plan.kind==='quiet'&&!plan.dueAt){plan.status='active';plan.startedAt=now.toISOString();plan.endAt=new Date(now.getTime()+(plan.durationMinutes||10)*60000).toISOString();}
        }
      }
      if (changed) { state.revision += 1; this.#save(state, now); }
      else this.#save(state,now);
      return this.#viewState(state);
    });
  }

  #advance(state, now) {
    const suppressed=new Set(this.getSuppressedSourceIds(state.roleId)||[]);
    let changed = false;
    for (const opportunity of state.opportunities) {
      if (!opportunity.deliveredAt && !opportunity.expiredAt && now.getTime() >= Date.parse(opportunity.expiresAt)) {
        opportunity.expiredAt = now.toISOString(); changed = true;
      }
    }
    let busy = state.plans.some(plan => this.#planVisible(plan,suppressed)&&plan.status === 'active');
    if (!busy) {
      const eligible = state.plans.filter(plan => this.#planVisible(plan,suppressed)&&plan.status === 'suggested' && plan.dueAt && now.getTime() >= Date.parse(plan.dueAt));
      if (eligible.length) {
        const weighted = eligible.map(plan => ({ plan, weight: itemWeight({ title: plan.title, kind: plan.kind }, state.interests.filter(i=>this.#interestVisible(i,suppressed))) }));
        const total = weighted.reduce((sum, entry) => sum + entry.weight, 0);
        let cursor = clamp(Number(this.random()) || 0, 0, .999999) * total;
        let selected = weighted.at(-1).plan;
        for (const entry of weighted) { cursor -= entry.weight; if (cursor < 0) { selected = entry.plan; break; } }
        selected.status = 'planned'; selected.selectedAt = now.toISOString(); selected.dueAt = now.toISOString(); changed = true;
      }
    }
    for (const plan of state.plans) {
      if(!this.#planVisible(plan,suppressed))continue;
      if(plan.status==='awaiting_confirmation'&&plan.recurrence&&plan.startedAt&&now.getTime()>=Date.parse(nextOccurrence(plan,new Date(plan.startedAt)))){
        // A missed occurrence stays missed. Only the current occurrence can
        // invite again; offline weeks are never replayed as a backlog.
        plan.missedOccurrences=(plan.missedOccurrences||0)+1;
        plan.lastOccurrenceId=plan.currentOccurrenceId;plan.currentOccurrenceId=null;
        for(const op of state.opportunities)if(op.planId===plan.id&&!op.deliveredAt&&!op.expiredAt)op.expiredAt=now.toISOString();
        plan.status='planned';plan.dueAt=mostRecentOccurrence(plan,now) || now.toISOString();changed=true;
      }
      if (plan.status === 'completed' && plan.recurrence && plan.dueAt && now.getTime() >= Date.parse(plan.dueAt)) {
        plan.status = 'planned'; plan.lastOccurrenceId = plan.currentOccurrenceId; plan.currentOccurrenceId = null;
        plan.dueAt = now.toISOString(); changed = true;
      }
      if (plan.status === 'planned' && plan.dueAt && now.getTime() >= Date.parse(plan.dueAt)) {
        if (plan.owner === 'character' && busy) continue;
        const durationMs = Number.isInteger(plan.durationMinutes) ? plan.durationMinutes * 60_000 : 2 * HOUR;
        const staleAfter = Date.parse(plan.dueAt) + Math.min(durationMs, 2 * HOUR);
        if (!plan.recurrence && plan.owner === 'character' && now.getTime() >= staleAfter) {
          plan.status = 'awaiting_confirmation'; plan.missed = true; plan.missedAt = now.toISOString(); plan.updatedAt = now.toISOString(); changed = true;
          for (const opportunity of state.opportunities) if (opportunity.planId === plan.id && !opportunity.deliveredAt && !opportunity.expiredAt) opportunity.expiredAt = now.toISOString();
          continue;
        }
        if (plan.kind === 'ritual' && plan.recurrence) {
          const current = occurrenceId(plan, now);
          if (plan.lastOccurrenceId === current) { plan.dueAt = nextOccurrence(plan, now); changed = true; continue; }
          plan.currentOccurrenceId = current;
        }
        plan.status = plan.owner === 'joint' || plan.kind === 'ritual' ? 'awaiting_confirmation' : 'active';
        if (plan.status === 'active') busy = true;
        plan.startedAt = now.toISOString(); plan.updatedAt = now.toISOString(); changed = true;
        if (plan.status === 'active' && plan.owner === 'character' && plan.durationMinutes) plan.endAt = new Date(now.getTime() + plan.durationMinutes * 60_000).toISOString();
        const anchor = plan.recommendation ? plan.provenance : plan.title;
        this.#opportunity(state, plan, 'opening', anchor, plan.owner === 'joint' ? `计划已到时间，先确认是否开始${plan.title}` : `可以自然提到开始了${plan.title}`, plan.sourceMessageId, now);
      }
      if (plan.status === 'active' && plan.durationMinutes && now.getTime() >= Date.parse(plan.endAt || plan.startedAt) + (plan.endAt ? 0 : plan.durationMinutes * 60_000)) {
        plan.status = 'awaiting_confirmation'; plan.updatedAt = now.toISOString(); changed = true;
        for (const opportunity of state.opportunities) if (opportunity.planId === plan.id && opportunity.type === 'opening' && !opportunity.deliveredAt && !opportunity.expiredAt) opportunity.expiredAt = now.toISOString();
        if (!plan.finishCheckCreated) {
          this.#opportunity(state, plan, 'finish-check', plan.title, plan.kind === 'quiet' ? `安静时间到了，只询问感受；不能声称用户完成` : `活动时间到了，只确认是否有想说的；不能声称已经完成`, plan.sourceMessageId, now);
          plan.finishCheckCreated = true;
        }
      }
    }
    if (changed) state.revision += 1;
    return changed;
  }

  tick(roleId) {
    const role = clean(roleId);
    const now = this.#now();
    return this.store.transaction(() => {
      const state = this.#load(role);
      if (this.#advance(state, now)) this.#save(state, now);
      return this.#viewState(state);
    });
  }

  #viewState(state, suppressed = new Set()) {
    const plans = state.plans.filter(plan => this.#planVisible(plan, suppressed)).map(publicPlan);
    const interests = state.interests.filter(item => this.#interestVisible(item, suppressed)).map(clone);
    return { revision: state.revision, plans, interests };
  }

  #sourceVisible(id, suppressed) {
    if (!id || id.startsWith('ui-')) return true;
    return !suppressed.has(id) && Boolean(this.store.getMessage?.(id) ?? this.store.db.prepare('SELECT 1 FROM messages WHERE id=?').get(id));
  }

  #planVisible(plan, suppressed) { return plan.sources.every(source => this.#sourceVisible(source.messageId, suppressed)); }
  #interestVisible(item, suppressed) { return (item.sourceMessageIds || []).every(id => this.#sourceVisible(id, suppressed)); }

  view(roleId, { suppressedSourceIds = [] } = {}) {
    const state = this.#load(clean(roleId));
    return this.#viewState(state, new Set([...suppressedSourceIds,...(this.getSuppressedSourceIds(clean(roleId))||[])]));
  }

  revision(roleId) { return this.#load(clean(roleId)).revision; }

  pending(roleId, { suppressedSourceIds = [] } = {}) {
    const role = clean(roleId);
    this.tick(role);
    const state = this.#load(role);
    const now = this.#now().getTime();
    const suppressed = new Set([...suppressedSourceIds,...(this.getSuppressedSourceIds(clean(roleId))||[])]);
    const validStatus = (op, plan) => ({
      opening: ['active', 'awaiting_confirmation'], 'finish-check': ['awaiting_confirmation'],
      outcome: ['completed'], followup: ['proposed'], invitation: ['proposed'],
    }[op.type] || []).includes(plan.status);
    const item = state.opportunities.find(op => {
      const plan = state.plans.find(entry => entry.id === op.planId);
      return plan && this.#planVisible(plan, suppressed) && validStatus(op, plan)
        && !op.deliveredAt && !op.expiredAt && Date.parse(op.createdAt) <= now && now < Date.parse(op.expiresAt);
    });
    return item ? { ...clone(item), version: state.revision } : null;
  }

  context(roleId, { text = '', suppressedSourceIds = [] } = {}) {
    const state = this.#load(clean(roleId));
    const suppressed = new Set([...suppressedSourceIds,...(this.getSuppressedSourceIds(clean(roleId))||[])]);
    const query = norm(text);
    const visiblePlans = state.plans.filter(plan => this.#planVisible(plan, suppressed));
    const relevant = visiblePlans.filter(plan => !['cancelled'].includes(plan.status) && (!query || norm(`${plan.title}${plan.kind}`).includes(query) || query.includes(norm(plan.title))));
    const plans = (relevant.length ? relevant : visiblePlans.filter(plan => !['cancelled', 'completed'].includes(plan.status))).slice(-5);
    const interests = state.interests.filter(item => item.audience === 'character' && item.value !== 0 && this.#interestVisible(item, suppressed)).slice(-8);
    const lines = ['【共同计划与她自己的兴趣；只按状态表达，不把到期写成完成】'];
    for (const plan of plans) lines.push(`计划 ${plan.id}：${plan.title}；归属=${plan.owner}；状态=${plan.status}${plan.dueAt ? `；时间=${plan.dueAt}` : ''}${plan.progress ? `；进度=${clip(plan.progress, 100)}` : ''}${plan.recommendation ? `；出处=${plan.provenance}` : ''}`);
    if (interests.length) lines.push(`她的兴趣：${interests.map(item => `${item.title}(${item.value > 0 ? '+' : ''}${item.value})`).join('、')}`);
    return clip(lines.join('\n'), 1200);
  }

  markDelivered(roleId, key, messageId, version) {
    const role = clean(roleId), opportunityKey = clean(key), id = clean(messageId);
    if (!role || !opportunityKey || !id || !Number.isSafeInteger(version)) return false;
    const now = this.#now();
    return this.store.transaction(() => {
      const replay = this.store.db.prepare('SELECT message_id,version FROM companion_agenda_deliveries WHERE role_id=? AND opportunity_key=?').get(role, opportunityKey);
      if (replay) return replay.message_id === id && replay.version === version;
      const state = this.#load(role);
      const opportunity = state.opportunities.find(item => item.key === opportunityKey);
      const plan = state.plans.find(item => item.id === opportunity?.planId);
      const validStatus = plan && ({ opening: ['active', 'awaiting_confirmation'], 'finish-check': ['awaiting_confirmation'], outcome: ['completed'], followup: ['proposed'], invitation: ['proposed'] }[opportunity.type] || []).includes(plan.status);
      if (!opportunity || !plan || !this.#planVisible(plan, new Set()) || !validStatus || state.revision !== version || opportunity.deliveredAt || opportunity.expiredAt || now.getTime() >= Date.parse(opportunity.expiresAt)) return false;
      const message = dbMessage(this.store.getMessage?.(id) ?? this.store.db.prepare('SELECT * FROM messages WHERE id=?').get(id));
      if (!message || message.role !== role || message.speaker !== 'assistant' || !message.text.includes(opportunity.anchor)) return false;
      this.store.db.prepare('INSERT INTO companion_agenda_deliveries(role_id,opportunity_key,version,message_id,delivered_at) VALUES(?,?,?,?,?)')
        .run(role, opportunityKey, version, id, now.toISOString());
      opportunity.deliveredAt = now.toISOString(); opportunity.messageId = id;
      state.revision += 1; this.#save(state, now);
      return true;
    });
  }

  update(roleId, command = {}) {
    const role = clean(roleId), now = this.#now();
    if (!Number.isSafeInteger(command.revision)) throw invalid('缺少有效版本', 'STALE_COMPANION_AGENDA');
    return this.store.transaction(() => {
      const state = this.#load(role);
      if (state.revision !== command.revision) throw Object.assign(new Error('计划已更新，请刷新'), { status: 409, code: 'STALE_COMPANION_AGENDA' });
      const action = clean(command.action);
      if (action === 'interest') {
        const title = clip(command.title, 60);
        if (!title) throw invalid('兴趣名称不能为空');
        const value=Number(command.value);if(!Number.isFinite(value)||value < -2||value > 2)throw invalid('兴趣倾向必须在-2到2之间');
        let entry = state.interests.find(item => item.audience === 'character' && norm(item.title) === norm(title));
        if (!entry) { entry = { id: `interest-${hash(`character:${norm(title)}`)}`, title, value: 0, audience: 'character', source: 'ui', quotes: [], sourceMessageIds: [] }; state.interests.push(entry); }
        entry.value = value;entry.source='ui';entry.sourceMessageIds=[];entry.quotes=[];
      } else if (action === 'create') {
        if (!KINDS.has(command.kind)) throw invalid('计划类型无效');
        if (!['character', 'joint'].includes(command.owner)) throw invalid('只能创建她自己或共同的虚构计划');
        const title = clean(command.title);
        if (!title || title.length > 120) throw invalid('计划标题必须是1到120个字符');
        if (command.durationMinutes !== undefined && (!Number.isInteger(command.durationMinutes) || command.durationMinutes < 1 || command.durationMinutes > 1440)) throw invalid('时长必须是1到1440分钟的整数');
        const location = command.location === undefined ? '' : clean(command.location);
        if (location.length > 120) throw invalid('地点不能超过120个字符');
        if (location && command.owner !== 'character') throw invalid('共同安排不能替用户设定地点');
        const row = { id: `ui-${randomUUID()}`, speaker: 'assistant', text: title };
        let dueAt = this.#validateDue(command.dueAt, now.toISOString());
        let recurrence = null;
        if (command.kind === 'ritual') {
          if (!command.recurrence || !['daily', 'weekly'].includes(command.recurrence.frequency)) throw invalid('习惯必须指定daily或weekly周期');
          const timeMatch = clean(command.recurrence.time).match(/^(\d{2}):(\d{2})$/u);
          if (!timeMatch || Number(timeMatch[1]) > 23 || Number(timeMatch[2]) > 59) throw invalid('习惯时间必须是有效的HH:MM');
          if (command.recurrence.frequency === 'weekly' && (!Number.isInteger(command.recurrence.weekday) || command.recurrence.weekday < 0 || command.recurrence.weekday > 6)) throw invalid('每周习惯必须指定0到6的weekday');
          recurrence = { frequency: command.recurrence.frequency, time: command.recurrence.time, ...(command.recurrence.frequency === 'weekly' ? { weekday: command.recurrence.weekday } : {}) };
        } else if (command.recurrence !== undefined) throw invalid('只有ritual可设置周期');
        if (!dueAt && recurrence) dueAt = nextOccurrence({ recurrence }, new Date(now.getTime() - 1000));
        this.#newPlan(state, { id: clean(command.id) || undefined, kind: command.kind, title, owner: command.owner, status: 'planned', dueAt, recurrence, durationMinutes: command.durationMinutes, location }, row, now);
      } else {
        const plan = state.plans.find(item => item.id === clean(command.id));
        if (!plan) throw invalid('计划不存在');
        if (action === 'edit') {
          if (['completed', 'cancelled'].includes(plan.status)) throw invalid('已结束计划不能再编辑');
          if (command.title !== undefined) {
            const title = clean(command.title);
            if (!title || title.length > 120) throw invalid('计划标题必须是1到120个字符');
            plan.title = title;
          }
          if (command.dueAt !== undefined) {
            plan.dueAt = this.#validateDue(command.dueAt, now.toISOString());
            plan.status = 'planned';
            delete plan.startedAt; delete plan.endAt; delete plan.remainingMs; delete plan.finishCheckCreated; delete plan.missed;
            for (const opportunity of state.opportunities) if (opportunity.planId === plan.id && !opportunity.deliveredAt && !opportunity.expiredAt) opportunity.expiredAt = now.toISOString();
          }
          if (command.durationMinutes !== undefined) {
            if (!Number.isInteger(command.durationMinutes) || command.durationMinutes < 1 || command.durationMinutes > 1440) throw invalid('时长必须是1到1440分钟的整数');
            plan.durationMinutes = command.durationMinutes;
            if (plan.status === 'active' && plan.owner === 'character') plan.endAt = new Date(now.getTime() + plan.durationMinutes * 60_000).toISOString();
          }
          if (command.location !== undefined) {
            const location = clean(command.location);
            if (location.length > 120) throw invalid('地点不能超过120个字符');
            if (location && plan.owner !== 'character') throw invalid('共同安排不能替用户设定地点');
            plan.location = location || null;
          }
        } else if (action === 'state' || ['start', 'pause', 'resume', 'progress', 'complete', 'cancel', 'reschedule'].includes(action)) {
          if (['completed', 'cancelled'].includes(plan.status)) throw invalid('已结束计划不能恢复');
          const aliases = { start: 'active', pause: 'paused', resume: 'active', progress: plan.status, complete: 'completed', cancel: 'cancelled', reschedule: 'planned' };
          const target = action === 'state' ? clean(command.state) : aliases[action];
          const allowed = new Set(['proposed', 'planned', 'active', 'paused', 'awaiting_confirmation', 'completed', 'cancelled']);
          if (!allowed.has(target)) throw invalid('计划状态无效');
          const transitions = {
            suggested: new Set(['planned', 'cancelled']), proposed: new Set(['planned', 'cancelled']),
            planned: new Set(['active', 'awaiting_confirmation', 'cancelled']),
            awaiting_confirmation: new Set(['active', 'completed', 'cancelled', 'planned']),
            active: new Set(['paused', 'awaiting_confirmation', 'completed', 'cancelled', 'planned']),
            paused: new Set(['active', 'completed', 'cancelled', 'planned']),
          };
          if (target !== plan.status && !transitions[plan.status]?.has(target)) throw invalid('不允许的计划状态转换');
          if (action === 'pause' && plan.status !== 'active') throw invalid('只有进行中的计划可以暂停');
          if (action === 'resume' && plan.status !== 'paused') throw invalid('只有暂停的计划可以恢复');
          if (action === 'start' && !['planned', 'awaiting_confirmation'].includes(plan.status)) throw invalid('计划当前不能开始');
          if (action === 'reschedule' && command.dueAt === undefined) throw invalid('改期需要dueAt');
          if (target === 'completed' && plan.owner === 'joint' && command.confirmed !== true) throw invalid('共同计划完成需要明确确认');
          if (action === 'pause' && plan.kind === 'quiet' && plan.endAt) plan.remainingMs = Math.max(0, Date.parse(plan.endAt) - now.getTime());
          plan.status = target;
          if (target === 'active') {
            plan.startedAt = now.toISOString();
            if (plan.kind === 'quiet' && plan.durationMinutes) {
              const duration = action === 'resume' && Number.isFinite(plan.remainingMs) ? plan.remainingMs : plan.durationMinutes * 60_000;
              plan.endAt = new Date(now.getTime() + duration).toISOString(); delete plan.remainingMs;
            } else if (plan.owner === 'character' && plan.durationMinutes) {
              plan.endAt = new Date(now.getTime() + plan.durationMinutes * 60_000).toISOString();
            }
          }
          if (target === 'completed') { plan.completedAt = now.toISOString(); if (plan.recurrence) plan.dueAt = nextOccurrence(plan, now); }
          if (target === 'cancelled') plan.cancelledAt = now.toISOString();
          if (command.progress !== undefined) plan.progress = clip(command.progress, 240);
          if (command.dueAt !== undefined) { plan.dueAt = this.#validateDue(command.dueAt, now.toISOString()); delete plan.startedAt; delete plan.endAt; delete plan.remainingMs; delete plan.finishCheckCreated; delete plan.missed; }
          if (['pause', 'reschedule', 'cancel'].includes(action) || ['paused', 'planned', 'cancelled'].includes(target)) {
            for (const opportunity of state.opportunities) if (opportunity.planId === plan.id && !opportunity.deliveredAt && !opportunity.expiredAt) opportunity.expiredAt = now.toISOString();
          }
          if (target === 'completed') this.#opportunity(state, plan, 'outcome', plan.title, `说明${plan.title}的实际结果，不替用户补写经历`, plan.sourceMessageId, now);
        } else throw invalid('操作无效');
        plan.updatedAt = now.toISOString();
      }
      state.revision += 1; this.#save(state, now);
      return this.#viewState(state);
    });
  }

  itemWeight(item, roleId = 'miyue', { suppressedSourceIds = [] } = {}) {
    if (roleId && typeof roleId === 'object') { suppressedSourceIds = roleId.suppressedSourceIds || []; roleId = 'miyue'; }
    const suppressed = new Set([...suppressedSourceIds,...(this.getSuppressedSourceIds(clean(roleId))||[])]);
    const interests = this.#load(clean(roleId)).interests.filter(entry => this.#interestVisible(entry, suppressed));
    return itemWeight(item, interests);
  }
  promptInstruction() { return promptInstruction(); }
}
