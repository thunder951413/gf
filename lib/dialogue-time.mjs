const dialoguePurposes = new Set(['chat', 'chat-repair', 'proactive', 'life', 'emotion', 'understanding']);
const formatter = new Intl.DateTimeFormat('zh-CN', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  weekday: 'long', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

export function currentDialogueTime(now) {
  const date = new Date(now);
  if (!Number.isFinite(+date)) throw new TypeError('Dialogue clock must return a valid date');
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return `【本轮当前时间】${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.weekday}（北京时间，Asia/Shanghai，UTC+08:00）。这是本轮模型调用时刻；历史消息、资料和状态快照中的时间不是现在。以此理解今天、明天、今晚等表达，无需每次报时。`;
}

export function withDialogueTime(messages, { purpose = 'chat', now } = {}) {
  if (!dialoguePurposes.has(purpose)) return messages;
  const anchor = { role: 'user', content: currentDialogueTime(now) };
  // Keep the reusable persona/history prefix unchanged and the actual user turn last.
  const index = messages.at(-1)?.role === 'user' ? messages.length - 1 : messages.length;
  return [...messages.slice(0, index), anchor, ...messages.slice(index)];
}
