// This is a small read-only hint for the next reply.  Its data range is the
// latest 64 consecutive assistant chat groups in the supplied conversation;
// user rows and story rows are excluded. It never judges or edits a reply.
const MAX_GROUPS = 64;
const MAX_PHRASES = 5;
const FILLER = /^(?:还是|也|就|其实|确实|真的|忽然|忽地|一下子|总是|会|都|还|有点|有些|稍微|微微|不由得|莫名)\s*/;
const EMOTION = /安心|踏实|难过|开心|高兴|委屈|想哭|心疼|温暖|酸|软|松|发紧|发烫|喜欢|舍不得|想念|害怕|紧张|孤单|孤独|亲近|幸福|轻快|沉甸甸|不是滋味|被接住|被安慰|被看见|感动/;
const CONCRETE_FACT = /[0-9０-９]|(?:[一二三四五六七八九十百千万两]+)(?:个|点|天|月|年|分钟|小时|米|元|岁|次|号)/;
const BODY_HEAT = /(耳朵|耳根|脸颊?|面颊)(?:\s*(?:有点|有些|微微|还是|也|就|都|还|发|有))*\s*(?:热|烫)(?:了)?/g;
// Group a repeated rhetorical move, not just exact synonyms. This remains an
// advisory history hint; a single genuine physical relaxation is always allowed.
const SETTLING = /(?:(?:整个人|身体|肩膀|(?:^|[，,\s])(?:我)?人)[^，。！？；\n]{0,12}|我(?:也)?(?:先|跟着|就|一下)*)(?:松|软)(?:下来|下来了|了(?:一下)?|下去|松的|软的)/;
const LITERAL_SETTLING = /运动|拉伸|按摩|肌肉|跑步|健身|酸痛|肩颈/;
const LITERAL_HEAT = /天气|气温|温度|茶|热水|咖啡|发烧|体温|烫伤/;

function assistantGroup(row) {
  return row?.speaker === 'assistant' && row?.kind !== 'story' && row?.type !== 'story' && row?.mode !== 'story' && !row?.isStory;
}

function withoutQuotes(text) {
  // Quoted user wording is evidence about the user, not a formulation the
  // assistant chose.  Remove both paired Chinese and straight quotes.
  return text
    .replace(/[“”][^“”]*[“”]/g, ' ')
    .replace(/["'「」『』][^"'「」『』]*["'「」『』]/g, ' ');
}

function normalize(marker, tail) {
  let rest = tail.trim();
  while (FILLER.test(rest)) rest = rest.replace(FILLER, '');
  rest = rest.replace(/了?(?:一下)?$/, '');
  rest = rest.replace(/\s+/g, ' ').trim();
  if (!rest || rest.length > 24 || CONCRETE_FACT.test(rest)) return null;
  const phrase = `${marker}${rest}`;
  return EMOTION.test(phrase) ? phrase : null;
}

function emotionalPhrases(text) {
  const phrases = new Set();
  for (const clause of withoutQuotes(String(text || '')).split(/[。！？；\n]+/)) {
    const matcher = /(?:我(?:的)?\s*)?(心里|心口|觉得|有点)(?:\s*(?:还是|也|就|其实|确实|真的|忽然|忽地|一下子|总是|会|都|还|有些|稍微|微微|不由得|莫名))*\s*([^，。！？；\n]{1,30})/g;
    for (const match of clause.matchAll(matcher)) {
      const phrase = normalize(match[1], match[2]);
      if (phrase) phrases.add(phrase);
    }
    if (!LITERAL_SETTLING.test(clause) && SETTLING.test(clause)) phrases.add('用身体松软来表达情绪');
    // These are deliberately limited to common involuntary body reactions.
    // A hot drink or weather report cannot match a body subject, and explicit
    // literal-heat context is excluded before it can become a style hint.
    if (!LITERAL_HEAT.test(clause)) {
      for (const match of clause.matchAll(BODY_HEAT)) {
        const subject = /^(?:耳朵|耳根)$/.test(match[1]) ? '耳朵' : '脸';
        phrases.add(`${subject}${match[0].includes('烫') ? '烫' : '热'}`);
      }
    }
  }
  return phrases;
}

function recentAssistantGroups(conversation) {
  const groups = [];
  let current = null;
  for (const row of Array.isArray(conversation) ? conversation : []) {
    if (!assistantGroup(row)) { current = null; continue; }
    if (!current) { current = []; groups.push(current); }
    current.push(String(row.text || ''));
  }
  return groups.slice(-MAX_GROUPS);
}

function bounded(text, maxChars) {
  if (maxChars <= 0) return '';
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function expressionHistory(conversation, { maxChars = 450 } = {}) {
  const limit = Math.max(0, Math.min(450, Math.trunc(Number(maxChars)) || 0));
  const counts = new Map();
  for (const group of recentAssistantGroups(conversation)) {
    const seen = new Set();
    for (const text of group) for (const phrase of emotionalPhrases(text)) seen.add(phrase);
    for (const phrase of seen) counts.set(phrase, (counts.get(phrase) || 0) + 1);
  }
  const phrases = [...counts]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .slice(0, MAX_PHRASES)
    .map(([phrase, count]) => ({ phrase, count }));
  const listed = phrases.map(({ phrase, count }) => `${phrase}（${count}次）`).join('、');
  const context = listed
    ? `这些表达已在不同回复中多次用过：${listed}。优先写本轮具体缘由、念头或细节，不必换一个身体部位或同义词复述同一种反应；也不硬性禁用某个词。`
    : '';
  return { phrases, context: bounded(context, limit) };
}
