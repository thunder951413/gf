const MAX_EVENTS = 2;
const SHOPPING_OBJECTS = /衬衫|衣服|衣裳|杯子|马克杯|包裹|快递|物流|外套|裙|裤|鞋|包(?!括)/u;
const GENERIC_TERMS = Object.freeze({
  manicure: /美甲|指甲|甲油|色卡/u, pet: /猫|狗|宠物/u, friend_chat: /朋友|聊天|见面/u,
  cooking: /做饭|烹饪|烤|厨房/u, plants: /花草|植物|浇水/u, outfit: /穿搭|搭配|衣服|裙|外套/u,
  music_exercise: /音乐|听歌|运动|锻炼|跑步/u,
});
const localTime = value => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
};
const textOf = item => typeof item === 'string' ? item : String(item?.text || '');
const clean = value => String(value || '').replace(/[\r\n]+/gu, ' ').trim();
const clip = (value, length) => { const text = clean(value); return text.length <= length ? text : `${text.slice(0, Math.max(0, length - 1))}…`; };
const physical = event => event?.kind === 'shopping' && !event?.source && event?.origin !== 'subscription';

function shoppingMatches(event, text) {
  const objects = clean(event.title).match(new RegExp(SHOPPING_OBJECTS.source, 'gu')) || [];
  if (text.includes(clean(event.title)) || objects.some(object => text.includes(object))) return true;
  const options = event.choice?.options || [];
  return /选|挑|要|买|下单|改|换|定/u.test(text) && options.some(option => text.includes(option));
}
function eventMatches(event, text) {
  if (!text) return false;
  if (event.kind === 'shopping') return shoppingMatches(event, text);
  return text.includes(clean(event.title)) || Boolean(GENERIC_TERMS[event.kind]?.test(text));
}
function priority(event) { return event.foreground ? 2 : event.phase === 'paused' ? 0 : 1; }
function genericFollowup(text) {
  return /^(?:然后呢|后来呢|到了吗|到没|什么颜色|这个呢|那件呢|怎么样|进展呢|物流呢)[。！!？?\s]*$/u.test(clean(text));
}

/** Select only currently relevant events; ordinary user topics stay unforced. */
export function focusLifeEvents(view, { text = '', conversation = [], opening = false } = {}) {
  const events = Array.isArray(view?.events) ? view.events.filter(event => event && typeof event === 'object') : Array.isArray(view) ? view.filter(event => event && typeof event === 'object') : [];
  const query = clean(text);
  // A user's old workplace purchase is not a follow-up to this fictional event.
  const historicalWork = /(?:以前|之前|曾经|上次).{0,12}(?:工作|上班|公司)|(?:工作|上班|公司).{0,12}(?:以前|之前|曾经|上次)/u.test(query);
  const direct = historicalWork ? [] : events.filter(event => eventMatches(event, query));
  if (direct.length) return direct.sort((a, b) => priority(b) - priority(a)).slice(0, MAX_EVENTS);
  const last = textOf(conversation.at?.(-1));
  const followup = genericFollowup(query) ? events.filter(event => eventMatches(event, last)) : [];
  if (followup.length) return followup.sort((a, b) => priority(b) - priority(a)).slice(0, MAX_EVENTS);
  return opening ? [...events].sort((a, b) => priority(b) - priority(a)).slice(0, MAX_EVENTS) : [];
}

export function lifeEventTurnContext(events, { sharing = false } = {}) {
  const list = (Array.isArray(events) ? events : []).slice(0, MAX_EVENTS);
  if (!list.length) return '';
  const lines = ['【当前相关生活事件｜仅在用户话题相关时采用】', '这些是林晓薇自己的生活，用户在参谋，不是用户在购物或穿这件衣服。没记下的尺码、付款或收货日期不补成确定事实。'];
  for (const event of list) {
    const stage = clean(event.phaseLabel || event.phase);
    const detail = clip(event.detail, 130);
    let choice = '';
    if (event.choice?.selected) {
      choice = event.choice.editable
        ? `；当前可改选${clean(event.choice.selected)}`
        : `；已选${clean(event.choice.selected)}，当前阶段不能改动`;
      if (event.choice.adopted && event.choice.evidence) choice += `；此前确认：“${clip(event.choice.evidence, 42)}”`;
    }
    lines.push(`${clean(event.title)}：当前${stage}（本阶段开始于${localTime(event.startedAt)}）。${detail}${choice}`);
  }
  if (list.some(event => event.choice && !event.choice.editable)) lines.push('旧聊天只表示当时；以当前进度为准，不能顺着提议改写已发生的选择。');
  lines.push(sharing?'本轮允许你分享这件生活小事，可讲一个具体细节和自己的想法；正在做的例行活动仅供保持连续性，不另加一段汇报。只说当前阶段已经发生的事，不汇报内部字段。':'只在用户话题相关时采用；没有相关话题时不主动把它当作下一话题。只说当前阶段已经发生的事，不汇报内部字段。');
  return lines.join('\n').slice(0, 700);
}

function hypothetical(reply) { return /(?:如果|要是|假如|下次|另一件|以后)/u.test(reply); }
function historical(reply) { return /(?:上次|之前|曾经|原来我说|以前)/u.test(reply); }
const clauses = reply => clean(reply).split(/[。！？!?；;\n]+/u).map(clean).filter(Boolean);

/** High-precision physical-state checks for authored shopping events only. */
export function lifeEventReplyIssues(reply, events, {now} = {}) {
  const value = clean(reply);
  if (!value) return [];
  const issues = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!physical(event)) continue;
    const phase = event.phase;
    const day=at=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
    if(phase==='arrived'&&now&&Number.isFinite(Date.parse(event.startedAt))&&day(now)===day(event.startedAt)&&/(?:昨天|前天)(?:下午|早上|晚上|上午)?(?:刚|就|已经)?(?:拿到|收到|收货|到货|到了)/u.test(value))issues.push('shopping_arrival_date_contradiction');
    for (const clause of clauses(value)) {
      if (hypothetical(clause) || historical(clause)) continue;
      if (phase === 'browsing' && /(?:已经|都|刚刚|刚|终于)(?:下(?:完|好|过)?单|付(?:完|好)?款|收货|收到|到货)|(?:下(?:完|好|过)?单|付(?:完|好)?款|收货|收到|到货)了/u.test(clause)) issues.push('shopping_browsing_claims_completed');
      if (phase === 'waiting' && /(?:还没|尚未|没有)(?:下单|付款)|未付款|(?:已经|都|刚刚|刚|终于)(?:收到|收货|到货)|(?:收到|收货|到货)了|包裹到了/u.test(clause)) issues.push('shopping_waiting_claims_wrong_state');
      if (['arrived', 'recent'].includes(phase) && /(?:还没到|尚未到|没有到|还在路上)/u.test(clause)) issues.push('shopping_arrived_claims_in_transit');
      const choice = event.choice;
      if (choice && !choice.editable) {
        for (const option of choice.options || []) {
          if (option === choice.selected) continue;
          const escaped = option.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
          if (new RegExp(`(?:那就算|改回|买的就是)${escaped}|${escaped}(?:下单|买了)`, 'u').test(clause)) issues.push('shopping_locked_choice_contradiction');
        }
      }
    }
  }
  return [...new Set(issues)];
}
