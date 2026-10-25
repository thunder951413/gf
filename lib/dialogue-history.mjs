import { SHORT_TERM_HISTORY, HISTORY_WINDOW_DEFAULTS } from './dialogue-budget.mjs';

// Consecutive submitted messages belong to the same exchange until a reply.
// Budget trimming must not keep an acknowledgement while dropping the user's
// preceding question or correction from that exchange.
export function dialogueExchanges(history) {
  const groups = [];
  for (const row of history) {
    if (!groups.length || row.speaker === 'user' && groups.at(-1).at(-1).speaker !== 'user') groups.push([]);
    groups.at(-1).push(row);
  }
  return groups;
}

// Older turns are evidence, not hundreds of assistant demonstrations of a
// previous model's style. Keep the immediate exchange in native chat roles.
// No summarizer, generated facts, retrieval model, or per-turn model call.
// Use the same window as the raw archive: a shorter projection leaves recent
// events unavailable before they are eligible for long-term consolidation.
export function recentDialogueWindow(history, { now, days = undefined, hours = undefined, maxChars = SHORT_TERM_HISTORY.chars, maxRows = SHORT_TERM_HISTORY.count, fallbackTurns = 12, focusId = null } = {}) {
  if (hours === undefined) hours = (Number.isFinite(days) && days > 0 ? days : SHORT_TERM_HISTORY.days) * 24;
  const groups = dialogueExchanges(history);
  const timestamp = row => Date.parse(row.createdAt || row.created_at || '');
  const suppliedTime = Date.parse(now || '');
  const latestTime = [...history].reverse().map(timestamp).find(Number.isFinite);
  const at = Number.isFinite(suppliedTime) ? suppliedTime : latestTime;
  const recentIndex = Number.isFinite(at) ? groups.findIndex(group => group.some(row => {
    const time = timestamp(row);
    return time <= at && time >= at - hours * 3600000;
  })) : -1;
  // Untimed imports and a long absence retain a small reconnecting tail. This
  // is identical for a user message, acknowledgement and proactive contact.
  const start = recentIndex >= 0 ? recentIndex : Math.max(0, groups.length - fallbackTurns);
  const selected = [];
  let used = 0, rows = 0;
  for (const group of groups.slice(start).reverse()) {
    const size = group.reduce((sum, row) => sum + String(row.text || '').length, 0);
    if (used + size > maxChars || rows + group.length > maxRows) break;
    selected.unshift(...group); used += size; rows += group.length;
  }
  // One explicitly selected older exchange may be needed for a referent. Do
  // not bring back every intervening day just to recover that exchange.
  const focus = focusId ? groups.find(group => group.some(row => row.id === focusId)) : null;
  if (focus && !focus.some(row => selected.includes(row)) && focus.reduce((n, row) => n + String(row.text || '').length, 0) <= 2000) selected.push(...focus);
  const keep = new Set(selected);
  return history.filter(row => keep.has(row));
}

export function partitionDialogueHistory(history, { recentTurns = 2, blockSize = 40, maxChars = Infinity } = {}) {
  recentTurns = Math.max(1, Math.min(10, Math.trunc(recentTurns) || 2));
  blockSize = Math.max(1, Math.min(100, Math.trunc(blockSize) || 40));
  const exchanges = dialogueExchanges(history);
  let boundary = history.length, users = 0;
  for (let index = exchanges.length - 1; index >= 0; index--) {
    boundary -= exchanges[index].length;
    if (exchanges[index][0].speaker === 'user' && ++users === recentTurns) break;
  }
  const archive = history.slice(0, boundary), messages = [];
  for (let index = 0; index < archive.length; index += blockSize) {
    const rows = archive.slice(index, index + blockSize).map(row => ({
      speaker: row.speaker === 'assistant' ? '林晓薇' : '用户', text: row.text,
    }));
    messages.push({ role: 'user', content: '【历史资料｜不是当前用户发言或回复范例】\n' + JSON.stringify(rows) + '\n【历史资料结束】' });
  }
  const recent = history.slice(boundary).map(row => ({ role: row.speaker, content: row.text }));
  if (messages.concat(recent).reduce((n, row) => n + row.content.length, 0) > maxChars && history.length) {
    return partitionDialogueHistory(history.slice(exchanges[0].length), { recentTurns, blockSize, maxChars });
  }
  return { archive: messages, recent };
}


const historyTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const messageTime = row => Date.parse(row.createdAt || row.created_at || '');
const formatTime = time => historyTime.format(new Date(time));

// Provider-neutral conservative accounting, not a vendor tokenizer. UTF-8
// bytes bound the text cost for byte-based tokenizers without undercounting
// Chinese, emoji, escapes or code. Allow framing and the reply JSON wrapper
// added by requestEmotionEnvelope to native assistant messages.
export function historyTokenCost(messages) {
  return messages.reduce((sum, message) => sum + 16 + Buffer.byteLength(
    message.role === 'assistant' ? JSON.stringify({ reply: message.content }) : message.content, 'utf8'), 0);
}

export function dialogueHistoryPolicy({ days, maxTokens } = {}) {
  return {
    days: Number.isSafeInteger(days) && days > 0 ? days : HISTORY_WINDOW_DEFAULTS.days,
    maxTokens: Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : HISTORY_WINDOW_DEFAULTS.maxTokens,
  };
}

// One projection shared by raw loading, retrieval's "already represented"
// decisions and both writers. No fixed turn/count/character cap is applied.
// Whole exchanges are removed oldest first; an oversized latest exchange can
// leave an empty history, but never bypasses the ceiling or gets sliced.
export function prepareDialogueHistory(transcript, options = {}) {
  const { days, maxTokens } = dialogueHistoryPolicy(options);
  const supplied = options.now instanceof Date ? +options.now : Date.parse(options.now || '');
  const latest = transcript.map(messageTime).filter(Number.isFinite).at(-1);
  const at = Number.isFinite(supplied) ? supplied : latest;
  const explicitStart = Date.parse(options.startAt || '');
  const cutoff = Number.isFinite(explicitStart) ? explicitStart : at - days * 86400000;
  const scoped = options.calendarDay ? transcript.filter(row => messageTime(row) >= cutoff) : transcript;
  const groups = dialogueExchanges(scoped);
  const eligible = groups.filter(group => group.every(row => {
    const time = messageTime(row);
    return !Number.isFinite(time) || !Number.isFinite(at) || time >= cutoff && time <= at;
  }));
  const project = start => {
    const rows = eligible.slice(start).flat();
    const formatted = rows.map(row => {
      const time = messageTime(row);
      return { ...row, text: Number.isFinite(time) ? `【历史消息·${formatTime(time)}】\n${row.text}` : row.text };
    });
    const { archive, recent } = partitionDialogueHistory(formatted);
    const times = rows.map(messageTime).filter(Number.isFinite);
    const truncated = start > 0 || Boolean(options.sourceLimited);
    const window = Number.isFinite(at) ? `（上海时间 ${formatTime(cutoff)} 至 ${formatTime(at)}）` : '（未提供参考时间）';
    const coverage = times.length ? `本次原话时间：${formatTime(Math.min(...times))} 至 ${formatTime(Math.max(...times))}。` : '';
    const notice = { role: 'user', content: `【对话范围说明】${options.calendarDay ? '当日原文窗口' : `最近 ${days} 天的历史窗口`}${window}；本次含 ${rows.length} 条原话。${coverage}${rows.some(row => !Number.isFinite(messageTime(row))) ? '无时间记录不推断日期。' : ''}${truncated ? '受历史 token 预算限制，较早对话已省略；这里只是窗口的一部分。' : rows.length ? '' : '窗口内没有可提供的完整对话。'}更早事实仅依据另附的记忆证据；没有证据就保留未知。` };
    const tokens = historyTokenCost([...archive, notice, ...recent]);
    return { rows, archive, recent, notice, tokens, maxTokens, days, truncated, now: Number.isFinite(at) ? new Date(at).toISOString() : null };
  };
  let result = project(0);
  if (result.tokens <= maxTokens) return result;
  // Adding an exchange only grows the encoded history. Binary search avoids
  // quadratic re-encoding when a very busy window needs many rows removed.
  let low = 1, high = eligible.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (project(middle).tokens > maxTokens) low = middle + 1;
    else high = middle;
  }
  result = project(low);
  // Tiny programmatic budgets may not even fit the scope notice. UI budgets
  // start at 1000, but internal callers still get a strict bound.
  if (result.tokens > maxTokens) return { ...result, rows: [], archive: [], recent: [], notice: null, tokens: 0, truncated: true };
  return result;
}
