// Match public discussion material before the general feed lottery so regional
// culture does not disappear among unrelated breaking news.
export function selectLifeContent(items, topic, { text = '', limit = 3, requireCurrentTopic = false } = {}) {
  if (!topic?.sourceHints?.length) return [];
  const city = topic.publicQuery?.split(/\s+/)[0];
  const hints = topic.sourceHints.filter(value => typeof value === 'string' && value.length > 1);
  // A background event is not a request to keep discussing it. Ordinary replies
  // retrieve sources only when the current message actually opens that subject.
  if (requireCurrentTopic && !hints.some(hint => String(text).includes(hint))
    && !/当地|那边.{0,8}(?:吃|玩|风俗|习俗|文化)|这篇|那篇|原文|出处|来源/.test(text)) return [];
  const queryTerms = String(text).match(/[\p{Script=Han}]{2,6}/gu) || [];
  return items.filter(item => item.summary?.length >= 20 && /^https?:\/\//.test(item.url || '')).map(item => {
    const body = `${item.title || ''} ${item.summary || ''} ${item.research?.lifeTopic || ''}`;
    const cityMatch = city && body.includes(city);
    const hits = hints.filter(term => body.includes(term));
    const match = hits.length && (!topic.travel || cityMatch);
    return { item, score: match ? hits.length + (cityMatch ? 4 : 0) + queryTerms.filter(term => body.includes(term)).length * 3 : 0 };
  }).filter(row => row.score > 0).sort((a, b) => b.score - a.score).slice(0, limit).map(row => row.item);
}
