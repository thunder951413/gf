const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });

const STOPWORDS = new Set([
  '刚才', '刚刚', '之前', '上次', '说到', '提到', '聊到', '这个', '那个', '这里', '那里',
  '我们', '你们', '他们', '什么', '怎么', '如何', '为什么', '一下', '就是', '还是', '觉得',
  '人和人', '之间', '关于', '有关', '一个', '一些', '那件事', '这件事', '事情', '话题',
]);
const REFERENCE = /(?:(?:刚才|刚刚)\s*(?:说到|提到)|之前\s*(?:聊到|说到|提到)|上次\s*(?:聊到|说到|提到))/u;

function outsideQuotes(value) {
  return String(value ?? '').replace(/[“"「『][^”"」』]*[”"」』]/gu, ' ');
}

function terms(value) {
  return new Set([...segmenter.segment(String(value ?? ''))]
    .filter(part => part.isWordLike)
    .map(part => part.segment.toLowerCase())
    .filter(term => term.length >= 2 && !STOPWORDS.has(term)));
}

function topicTerms(text) {
  const unquoted = outsideQuotes(text);
  const match = unquoted.match(REFERENCE);
  if (!match) return null;
  const subject = unquoted.slice(match.index + match[0].length)
    .split(/[，。！？!?；;\n]/u, 1)[0]
    .replace(/^(?:的|了|是|在|一下|那个|这件|那件)*/u, '');
  const result = terms(subject);
  return result.size ? result : null;
}

function exchanges(history) {
  const groups = [];
  for (let index = 0; index < history.length; index += 1) {
    const row = history[index];
    if (row?.speaker !== 'user' || typeof row.text !== 'string') continue;
    const rows = [row];
    for (let next = index + 1; next < history.length && history[next]?.speaker !== 'user'; next += 1) {
      if (history[next]?.speaker === 'assistant' && typeof history[next].text === 'string') rows.push(history[next]);
    }
    // A callback needs the earlier exchange, rather than a bare user line.
    if (rows.length > 1) groups.push({ index, rows });
  }
  return groups;
}

/**
 * Select complete historical exchanges for an explicit reference to an older
 * topic. This is a read-only prompt projection: it does not alter history or
 * manufacture a summary when the wording provides no usable topic.
 */
export function referencedTopicHistory(text, history, { maxGroups = 2, maxChars = 2_000 } = {}) {
  const query = topicTerms(text);
  if (!query || !Array.isArray(history)) return [];
  const safeGroups = Math.max(1, Math.min(2, Math.trunc(maxGroups) || 2));
  const budget = Math.max(1, Math.min(2_000, Math.trunc(maxChars) || 2_000));
  const groups = exchanges(history);
  const frequency = new Map([...query].map(term => [term, groups.filter(group => group.rows[0].text.includes(term)).length]));
  const candidates = groups.map(group => {
    let score = 0;
    for (const term of query) if (group.rows[0].text.includes(term)) score += 1 / Math.sqrt(frequency.get(term) || 1);
    return { ...group, score };
  }).filter(group => group.score > 0)
    .sort((left, right) => right.score - left.score || right.index - left.index)
    .slice(0, safeGroups)
    .sort((left, right) => left.index - right.index);

  const selected = [];
  let used = 0;
  for (const group of candidates) {
    const size = group.rows.reduce((total, row) => total + row.text.length, 0);
    if (used + size > budget) continue;
    selected.push(...group.rows);
    used += size;
  }
  return selected;
}
