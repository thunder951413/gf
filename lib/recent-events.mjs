// A bounded, chronological digest of recorded life, without a scoring model or
// another generation call. Pending reading/story stages are deliberately absent.
export const RECENT_EVENTS_BUDGET_CHARS = 850;
const DAY = 86400000;
const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const keyOf = value => clean(value).replace(/[《》\s]/gu, '').toLowerCase();

// Never cut a sentence halfway through a correction or a negation. If the first
// sentence is too large, omit the detail; its title and recorded stage remain.
function excerpt(value, max = 150) {
  const text = clean(value);
  if (text.length <= max) return text;
  let result = '';
  for (const sentence of text.match(/[^。！？!?]+[。！？!?]?/gu) || []) {
    if (result.length + sentence.length > max) break;
    result += sentence;
  }
  return result ? `${result}（节选）` : '';
}

export function recentEventDigest({ now = new Date(), life = {}, thread = {}, pursuit = {}, experiences = [], runtime = null } = {}) {
  const currentTime = new Date(now).getTime();
  if (!Number.isFinite(currentTime)) throw new TypeError('now must be a valid date');
  const candidates = new Map();
  function add(key, date, title, status, detail) {
    const time = Date.parse(date);
    if (!Number.isFinite(time) || time > currentTime || time < currentTime - 30 * DAY) return;
    const name = excerpt(title, 80);
    if (!name) return;
    const item = { key, time, name, status: excerpt(status, 60), detail: excerpt(detail) };
    if (!candidates.has(key) || time >= candidates.get(key).time) candidates.set(key, item);
  }
  const authoritative = runtime?.current && typeof runtime.current === 'object' ? runtime.current : null;
  const samePlace = (left, right) => {
    const a = clean(left); const b = clean(right);
    return a && b && (a === b || a.includes(b) || b.includes(a));
  };
  // Read only the phase already reached, never the array of scheduled phases.
  for (const event of [...(life?.recent || []), ...(life?.active ? [life.active] : [])]) {
    const phase = event.phase || {};
    const active = event.id === life?.active?.id;
    if (active && authoritative) {
      const eventActivity = clean(phase.activity);
      const runtimeActivity = clean(authoritative.title || runtime?.world?.activity);
      const coherent = samePlace(phase.location || event.location, authoritative.location || runtime?.world?.location)
        && eventActivity && runtimeActivity
        && (eventActivity === runtimeActivity || eventActivity.includes(runtimeActivity) || runtimeActivity.includes(eventActivity));
      if (coherent) {
        add(`life:${event.id}`, authoritative.startedAt || event.startedAt, event.title,
          '当前（以持续生活安排为准）',
          [authoritative.location || runtime?.world?.location, runtimeActivity].filter(Boolean).join('，'));
      } else if (event.type === 'travel') {
        // Travel may remain the broader setting while the authoritative routine
        // is a meal or rest. Keep only that setting, never the unscheduled phase act.
        add(`life:${event.id}`, event.startedAt, event.title, '进行中的旅行背景', phase.location || event.destination);
      }
      continue;
    }
    add(`life:${event.id}`, event.startedAt, event.title,
      active ? `当前：${phase.title || '进行中'}` : '此前的生活记录',
      [phase.location || event.location, phase.activity].filter(Boolean).join('，'));
  }
  // One latest delivered progress per project, rather than contradictory old
  // and new stages. The current beat can still be an unsent author draft.
  const latestThread = [...(thread?.history || [])].sort((a, b) => Date.parse(b.deliveredAt) - Date.parse(a.deliveredAt))[0];
  if (latestThread) add(`thread:${thread.id}`, latestThread.deliveredAt, thread.title,
    `上次分享：${latestThread.title || '项目进展'}`, latestThread.text);
  for (const item of pursuit?.completed || []) {
    add(`work:${keyOf(item.title)}`, item.completedAt, item.title, '已完成的阅读或观影', item.lastAction);
  }
  for (const item of pursuit?.history || []) {
    add(`work:${keyOf(pursuit.title)}`, item.deliveredAt, pursuit.title,
      `已分享：${item.label || '阅读或观影进展'}`, item.action);
  }
  for (const item of experiences || []) {
    add(`work:${keyOf(item.title)}`, item.createdAt, item.title, '聊天中提到的自身经历', item.summary);
  }
  const lines = [];
  const header = '【林雨薇近期经历简记｜虚构角色连续性】\n仅作聊天背景，不逐条播报、不强行转场；这些是她的经历，不是用户的。日期为记录时间，旧记录不代表现在仍在做；本轮状态和用户最新更正优先。';
  for (const item of [...candidates.values()].sort((a, b) => b.time - a.time || a.key.localeCompare(b.key))) {
    const date = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(item.time);
    const line = `${date}｜${item.name}｜${item.status}${item.detail ? `：${item.detail}` : ''}`;
    if ([header, ...lines, line].join('\n').length > RECENT_EVENTS_BUDGET_CHARS) continue;
    lines.push(line);
    if (lines.length === 6) break;
  }
  return lines.length ? [header, ...lines].join('\n') : '';
}
