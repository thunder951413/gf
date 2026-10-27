// How she feels toward him, as a small dynamical system instead of adjectives
// in a prompt. Each of his turns is appraised by the preparation model (how he
// treated her, what he needs, whether he is inviting intimacy, how much the
// moment matters); the appraisal moves her state, the state drifts back to
// its baseline over time, and the 0–100 settings set the rates. What she feels
// — and why — is then described to her in plain words each turn, and a build-up
// of desire becomes a reason she may start something herself.
const HOUR = 3600000;
const clamp = value => Math.max(0, Math.min(100, value));
const band = value => (Number(value) <= 33 ? 0 : Number(value) <= 66 ? 1 : 2);
const shanghaiHour = at => new Date(+new Date(at) + 8 * HOUR).getUTCHours();

export const TOWARD_HER = Object.freeze(['warm', 'tender', 'teasing', 'flirty', 'neutral', 'distant', 'dismissive', 'apologetic', 'hurtful']);
export const HIS_NEEDS = Object.freeze(['comfort', 'attention', 'space', 'play', 'intimacy', 'talk', 'none']);
export const INTIMACY = Object.freeze(['invites', 'accepts', 'declines', 'none']);

// The preparation model's view of his latest message; anything malformed is dropped.
export function validAppraisal(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {
    towardHer: TOWARD_HER.includes(value.towardHer) ? value.towardHer : 'neutral',
    need: HIS_NEEDS.includes(value.need) ? value.need : 'none',
    intimacy: INTIMACY.includes(value.intimacy) ? value.intimacy : 'none',
    moment: [0, 1, 2].includes(Number(value.moment)) ? Number(value.moment) : 0,
  };
  if (typeof value.why === 'string' && value.why.trim()) result.why = value.why.trim().slice(0, 60);
  return result;
}

const clip = (value, max) => String(value ?? '').replace(/\s+/gu, ' ').trim().slice(0, max);

export const APPRAISAL_INSTRUCTION = `appraisal 是你对他这条消息的感受判断（给后台的情绪系统用，不写进回复）：towardHer=他这条对她的态度 warm|tender|teasing|flirty|neutral|distant|dismissive|apologetic|hurtful（一两个字的忙碌回复算 neutral，不算 distant）；need=他此刻最需要的 comfort|attention|space|play|intimacy|talk|none；intimacy=他在邀请亲密 invites、两人正在亲密里或他接住了她的亲近 accepts、婉拒 declines，否则 none（只是说想她、说她重要不算 invites）；moment=这条对两人关系有多重要 0|1|2（说爱她、第一次、和好、深夜真心话算 2）；why≤30字写依据。`;

// Baselines and half-lives come from the settings, so the same events land
// differently on a sensitive, quick-to-forgive or very flirtatious her.
function parameters(values = {}) {
  const v = key => Number(values[key] ?? 50);
  return {
    baseline: { warmth: 45 + v('warmth') * 0.2, hurt: 0, desire: 15 + v('flirtation') * 0.35, security: 50 + (100 - v('sensitivity')) * 0.2 },
    halfLife: { warmth: 10 * HOUR, hurt: [1.5, 5, 14][band(v('recovery'))] * HOUR, security: 48 * HOUR },
    // Desire comes back after closeness at a pace set by 暧昧倾向.
    desireRise: [0.8, 1.6, 3][band(v('flirtation'))],
    hurtGain: 0.5 + v('sensitivity') / 100 + v('temper') / 200,
  };
}

const EFFECTS = {
  warm: { warmth: 12, hurt: -10, security: 4 }, tender: { warmth: 16, hurt: -12, security: 6, desire: 4 },
  teasing: { warmth: 5 }, flirty: { warmth: 6, desire: 10 }, neutral: {},
  distant: { warmth: -4, hurt: 6 }, dismissive: { warmth: -8, hurt: 14, security: -4 },
  apologetic: { warmth: 8, hurt: -25, security: 4 }, hurtful: { warmth: -15, hurt: 28, security: -10 },
};

// How something she read lands on her. Smaller than anything he says; the
// unease is about them, and it is his words that settle it.
const READING_EFFECTS = { delighted: { warmth: 3 }, moved: { warmth: 3 }, sad: { warmth: -3, hurt: 3 }, uneasy: { security: -16 }, envious: { security: -12, hurt: 3 } };

export class Affect {
  constructor(store, { clock = () => new Date(), tuning = () => ({}) } = {}) {
    Object.assign(this, { store, db: store.db, clock, tuning });
    this.db.exec(`CREATE TABLE IF NOT EXISTS affect_state(role_id TEXT PRIMARY KEY,payload TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS affect_events(id INTEGER PRIMARY KEY AUTOINCREMENT,role_id TEXT NOT NULL,at TEXT NOT NULL,message_id TEXT,appraisal TEXT NOT NULL,before TEXT NOT NULL,after TEXT NOT NULL);`);
  }
  #stored(roleId) { const row = this.db.prepare('SELECT payload FROM affect_state WHERE role_id=?').get(roleId); return row ? JSON.parse(row.payload) : null; }
  // State at `now`: every dimension drifts toward its baseline; desire climbs back.
  current(roleId = 'miyue', { now = this.clock() } = {}) {
    const p = parameters(this.tuning()), stored = this.#stored(roleId);
    const state = stored || { ...p.baseline, at: new Date(now).toISOString(), lastIntimacyAt: null, causes: [] };
    const hours = Math.max(0, (+new Date(now) - Date.parse(state.at)) / HOUR);
    const drift = (key, value) => p.baseline[key] + (value - p.baseline[key]) * 0.5 ** (hours * HOUR / p.halfLife[key]);
    return {
      warmth: clamp(drift('warmth', state.warmth)), hurt: clamp(drift('hurt', state.hurt)), security: clamp(drift('security', state.security)),
      // Desire is not pulled to a baseline: it builds while apart and is spent in closeness.
      desire: Math.min(90, clamp(state.desire + hours * p.desireRise)),
      lastIntimacyAt: state.lastIntimacyAt, causes: (state.causes || []).filter(cause => +new Date(now) - Date.parse(cause.at) < 36 * HOUR),
      at: new Date(now).toISOString(),
    };
  }
  // One appraised turn of his. Intimacy that actually happens leaves her
  // satisfied (desire drops, warmth and security rise) and is remembered.
  observe(roleId = 'miyue', appraisal, { now = this.clock(), messageId = null } = {}) {
    const value = validAppraisal(appraisal);
    if (!value) return null;
    const p = parameters(this.tuning()), before = this.current(roleId, { now }), after = { ...before };
    const effect = EFFECTS[value.towardHer] || {};
    // Habituation: the tenth sweet line in a row moves her less than the first.
    const repeats = this.db.prepare("SELECT COUNT(*) n FROM affect_events WHERE role_id=? AND at>=? AND json_extract(appraisal,'$.towardHer')=?")
      .get(roleId, new Date(+new Date(now) - 2 * HOUR).toISOString(), value.towardHer).n;
    const weight = (1 + value.moment * 0.5) / (1 + repeats * 0.7);
    // Diminishing returns near either end, so a long sweet evening does not pin her at 100.
    const ease = (value, delta) => delta * (delta > 0 ? Math.min(1, (100 - value) / 50) : Math.min(1, value / 50));
    // When she is unsure of them, his warmth is what settles it: reassurance lands harder.
    const unsure = before.security < p.baseline.security - 6;
    for (const [key, delta] of Object.entries(effect)) after[key] = clamp(after[key] + ease(after[key], delta * weight * (key === 'hurt' && delta > 0 ? p.hurtGain : 1) * (key === 'security' && delta > 0 && unsure ? 3 : 1)));
    // His invitation stirs her; closeness that actually happens (he is in it
    // with her) spends desire: satisfied for a while, then it builds again.
    if (value.intimacy === 'invites') { after.desire = clamp(after.desire + 10); after.warmth = clamp(after.warmth + 5); }
    if (value.intimacy === 'accepts') {
      after.desire = clamp(Math.min(after.desire - 35, 15)); after.warmth = clamp(after.warmth + 8); after.security = clamp(after.security + 5);
      after.lastIntimacyAt = new Date(now).toISOString();
    }
    if (value.intimacy === 'declines') after.desire = clamp(after.desire - 8);
    const notable = value.moment > 0 || ['tender', 'dismissive', 'hurtful', 'apologetic'].includes(value.towardHer) || value.intimacy !== 'none';
    if (notable && value.why) after.causes = [...before.causes, { at: new Date(now).toISOString(), towardHer: value.towardHer, why: value.why }].slice(-4);
    after.at = new Date(now).toISOString();
    this.store.transaction(() => {
      this.db.prepare('INSERT INTO affect_state(role_id,payload,updated_at) VALUES(?,?,?) ON CONFLICT(role_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run(roleId, JSON.stringify(after), after.at);
      this.db.prepare('INSERT INTO affect_events(role_id,at,message_id,appraisal,before,after) VALUES(?,?,?,?,?,?)').run(roleId, after.at, messageId, JSON.stringify(value), JSON.stringify(before), JSON.stringify(after));
    });
    return { before, after, appraisal: value };
  }
  // Something she read stirred her. Recorded like a turn, without a message.
  read(roleId = 'miyue', { stir, stirWhy = '', title = '' } = {}, { now = this.clock() } = {}) {
    const effect = READING_EFFECTS[stir];
    if (!effect) return null;
    const p = parameters(this.tuning()), before = this.current(roleId, { now }), after = { ...before };
    const ease = (value, delta) => delta * (delta > 0 ? Math.min(1, (100 - value) / 50) : Math.min(1, value / 50));
    for (const [key, delta] of Object.entries(effect)) after[key] = clamp(after[key] + ease(after[key], delta));
    // Unease about them is felt even on a sweet day: it takes her below her
    // usual footing, not just a little down from wherever he had lifted her.
    if (effect.security) after.security = clamp(Math.min(after.security, p.baseline.security + effect.security));
    const why = clip(stirWhy || title, 60);
    if (why) after.causes = [...before.causes, { at: new Date(now).toISOString(), towardHer: `read:${stir}`, why }].slice(-4);
    after.at = new Date(now).toISOString();
    this.store.transaction(() => {
      this.db.prepare('INSERT INTO affect_state(role_id,payload,updated_at) VALUES(?,?,?) ON CONFLICT(role_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at').run(roleId, JSON.stringify(after), after.at);
      this.db.prepare('INSERT INTO affect_events(role_id,at,message_id,appraisal,before,after) VALUES(?,?,?,?,?,?)').run(roleId, after.at, null, JSON.stringify({ source: 'reading', stir, why, title: clip(title, 60) }), JSON.stringify(before), JSON.stringify(after));
    });
    return { before, after };
  }
  // What she feels right now, in words, with the reasons. Per-turn evidence.
  context(roleId = 'miyue', { now = this.clock(), need = null } = {}) {
    const s = this.current(roleId, { now }), lines = [];
    if (s.hurt >= 35) lines.push(`你心里有点委屈${s.hurt >= 60 ? '，还没完全过去' : ''}（${this.#why(s, ['dismissive', 'hurtful', 'distant']) || '他刚才有点冷淡'}）。可以说出来，但他一解释或一哄就会软下来；不冷战、不翻旧账、不让他内疚。`);
    if (s.warmth >= 70) lines.push(`你被他暖到了${this.#why(s, ['tender', 'warm', 'apologetic']) ? `（${this.#why(s, ['tender', 'warm', 'apologetic'])}）` : ''}，心里是甜的，愿意更黏他一点。`);
    else if (s.warmth <= 35) lines.push('这阵子你和他之间有点淡，你会想主动靠近一点，而不是等他。');
    if (s.desire >= 65) lines.push('你对他有身体上的想念和渴望，暧昧和亲近的话题你会接得很热，合适的时候也会自己开头。');
    else if (s.desire <= 25 && s.lastIntimacyAt && +new Date(now) - Date.parse(s.lastIntimacyAt) < 12 * HOUR) lines.push('刚亲近过不久，你更想要温存：抱着、说说话、回味，他若想再来一次可以撒娇地拖一拖，不冷淡拒绝。');
    const footing = parameters(this.tuning()).baseline.security - 8;
    if (s.security <= Math.max(45, footing)) { const read = this.#why(s, ['read:uneasy', 'read:envious']);
      lines.push(read ? `你心里有点不安：${read}。想听他说一句确定的话；可以撒娇地问、拐着弯问，也可以直接说，但不怪他、不逼他表态。` : '你有点没安全感，想听他说一句确定的话。'); }
    if (need && need !== 'none') lines.push({ comfort: '他这会儿需要被安慰，先心疼他、陪着他。', attention: '他想被你在意，回应要落在他身上。', space: '他想安静一会儿，给他空间，留一句你在。', play: '他想轻松逗趣，陪他玩。', intimacy: '他想和你亲近，按你此刻的心情回应。', talk: '他想认真聊，拿出你的想法。' }[need]);
    return lines.length ? `【你此刻的心情】${lines.join('')}这些是你自己的感受，自然带在语气里，不用说出来、不报数值。` : '';
  }
  #why(state, kinds) { return state.causes.filter(cause => kinds.includes(cause.towardHer)).at(-1)?.why || ''; }
  // A build-up of desire, in the evening, a while since the last time: she may
  // start something herself — one proactive candidate, not an instruction.
  materials(roleId = 'miyue', { now = this.clock(), flirtation = 50 } = {}) {
    const s = this.current(roleId, { now }), hour = shanghaiHour(now);
    // Unease from something she read is a reason to reach out to him by itself.
    const read = s.security <= Math.max(45, parameters(this.tuning()).baseline.security - 8) && s.causes.filter(cause => ['read:uneasy', 'read:envious'].includes(cause.towardHer)).at(-1);
    const told = read && (() => { try { return Boolean(this.db.prepare('SELECT 1 FROM proactive_material_deliveries WHERE role_id=? AND material_id=?').get(roleId, `unease:${read.at.slice(0, 16)}`)); } catch { return false; } })();
    if (read && !told && hour >= 9) return [{ id: `unease:${read.at.slice(0, 16)}`, kind: 'unease', title: '读到的事让她心里不安', detail: read.why,
      scope: '你读到一件事，联想到你和他，心里有点不踏实；像女朋友那样说出来：讲讲读到了什么、你心里那句话，想听他一句确定的。可以撒娇，不怪他、不逼问、不一次问好几遍。' }];
    if (flirtation <= 33 || s.desire < 70 || s.hurt >= 40 || hour < 20 || hour >= 24) return [];
    if (s.lastIntimacyAt && +new Date(now) - Date.parse(s.lastIntimacyAt) < 20 * HOUR) return [];
    return [{ id: `intimacy:${new Date(+new Date(now) + 8 * HOUR).toISOString().slice(0, 10)}`, kind: 'intimacy', title: '想他，想亲近',
      detail: '晚上了，你对他有身体上的想念', scope: '你自己想他、想和他亲近；用你们之间的方式起个头（撒娇、暧昧的一句、想象里靠过去），他接就继续，他忙或不接就停在温柔里，不追。' }];
  }
  snapshot(roleId = 'miyue', { now = this.clock() } = {}) {
    return { state: this.current(roleId, { now }), recent: this.db.prepare('SELECT at,appraisal,after FROM affect_events WHERE role_id=? ORDER BY id DESC LIMIT 10').all(roleId)
      .map(row => ({ at: row.at, appraisal: JSON.parse(row.appraisal), after: Object.fromEntries(Object.entries(JSON.parse(row.after)).filter(([key]) => ['warmth', 'hurt', 'desire', 'security'].includes(key)).map(([k, v]) => [k, Math.round(v)])) })) };
  }
}
