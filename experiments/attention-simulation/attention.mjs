// Offline experiment. Days are simulated; no production stores or timers are used.
export const defaults = Object.freeze({ halfLife: 3, mentionHalfLife: 3, mentionBoost: 10, boostCap: 30, threshold: 5, relevanceBoost: 30, maxItems: 3, charBudget: 600 });
const decay = (age, halfLife) => 2 ** (-Math.max(0, age) / halfLife);

// Retained as a comparison: clipping only the final sum hides accumulated mass.
export function clippedSumScore(item, day, options = {}) {
  const p = { ...defaults, ...options };
  if (item.born > day) return 0;
  const seen = new Set();
  const boost = (item.mentions || []).reduce((sum, mention) => {
    // Only affirmative user references activate a memory. Assistant output is
    // not evidence of user interest. One contribution per topic/conversation turn.
    if (mention.at > day || mention.who !== 'user' || mention.negative || seen.has(mention.turn)) return sum;
    seen.add(mention.turn);
    return sum + p.mentionBoost * decay(day - mention.at, p.mentionHalfLife);
  }, 0);
  return item.base * decay(day - item.born, p.halfLife) + Math.min(p.boostCap, boost);
}

export function salience(item, day, options = {}) {
  const p = { ...defaults, ...options };
  if (item.born > day) return 0;
  const seen = new Set(); let activation = 0, last = item.born;
  const mentions = [...(item.mentions || [])].sort((a, b) => a.at - b.at);
  for (const m of mentions) {
    if (m.at < item.born || m.at > day || m.who !== 'user' || m.negative || seen.has(m.turn)) continue;
    seen.add(m.turn);
    // Saturate at event time, discarding overflow rather than retaining a hidden
    // pile of boosts that keeps the displayed score pinned to its ceiling.
    activation = Math.min(p.boostCap, activation * decay(m.at - last, p.mentionHalfLife) + p.mentionBoost);
    last = m.at;
  }
  return item.base * decay(day - item.born, p.halfLife) + activation * decay(day - last, p.mentionHalfLife);
}

export function naiveScore(item, day, { multiplier = 1.5, halfLife = 3 } = {}) {
  if (item.born > day) return 0;
  const mentions = (item.mentions || []).filter(m => m.at <= day).length;
  return item.base * decay(day - item.born, halfLife) * multiplier ** mentions;
}

export function select(items, { day, mode = 'reply', relevance = {}, activeTopic = null, blockedTopics = [], ...options }) {
  const p = { ...defaults, ...options };
  const ranked = [];
  for (const item of items) {
    if (item.born > day || item.superseded || blockedTopics.includes(item.topic)) continue;
    const strength = salience(item, day, p), related = Math.max(0, Math.min(1, relevance[item.topic] || 0));
    const active = item.topic === activeTopic;
    let score = strength + p.relevanceBoost * related + (active ? 6 : 0);
    if (mode === 'proactive') {
      if (strength < p.threshold) continue;
      const exposed = (item.exposures || []).filter(at => at <= day);
      const age = exposed.length ? day - Math.max(...exposed) : Infinity;
      // Recently sent details are not sent again; later repetition penalty fades.
      if (age < 1) continue;
      score *= 1 - 0.85 * decay(age, 3);
    } else {
      // Do not stuff high-salience but unrelated memories into a direct reply.
      // A relevant old memory remains retrievable below the ambient threshold.
      if (!related && !active) continue;
    }
    ranked.push({ ...item, strength, score });
  }
  ranked.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const selected = [], topics = new Set(); let chars = 0;
  for (const item of ranked) {
    if (topics.has(item.topic) || chars + item.text.length > p.charBudget) continue;
    selected.push(item); topics.add(item.topic); chars += item.text.length;
    if (selected.length >= p.maxItems) break;
  }
  return { ranked, selected, chars };
}

export const fixtures = [
  { id: 'dive', topic: 'sea', born: 0, base: 12, text: '用户说这周五打算去南澳岛，描述潜水像在天上飞、俯瞰海洋。没有记录当地天气、水温或他的潜水资质。', mentions: [{ at: 0, who: 'user', turn: 'u1' }, { at: 1, who: 'user', turn: 'u2' }, { at: 2, who: 'user', turn: 'u3' }] },
  { id: 'work', topic: 'design', born: 0, base: 14, text: '林晓薇的虚构生活：包装设计改到第三稿，客户一直说想要江南感，却没有给具体方向。她烦恼的是不知道该改什么，不是担心用户不理她。', mentions: [] },
  { id: 'book', topic: 'reading', born: 0, base: 10, text: '林晓薇的虚构生活：最近读一本散文集，关注到作者写晾衣服、洗衣机这些普通日常。她觉得生活不必一直好看，也没有那么多感悟。作品名称未设定。', mentions: [] },
  { id: 'tea', topic: 'tea', born: 0, base: 18, text: '林晓薇的虚构生活：前几天泡过桂花乌龙，已经主动讲了两次茶香和窗外的光。', mentions: [{ at: 0, who: 'assistant', turn: 'a1' }, { at: 1, who: 'assistant', turn: 'a2' }], exposures: [0, 1] },
  { id: 'movie', topic: 'sea', born: 0, base: 7, text: '林晓薇的虚构生活：看过一段海洋纪录片，被鱼群从镜头前游过的画面吸引；没有亲自潜水的已知经历。', mentions: [] },
  { id: 'walk', topic: 'walk', born: 0, base: 9, text: '林晓薇的虚构生活：散步时留意过街边招牌的配色，想过有些店的字比装修更有意思。', mentions: [] },
  { id: 'new-book', topic: 'new-reading', born: 7, base: 15, text: '林晓薇的虚构生活：今天看了一篇谈旧衣服的随笔，其中有人一直留着穿旧的外套，因为口袋的位置用习惯了。她发现自己也舍不得扔一件起球的开衫，主要是穿着舒服。文章无已核实标题与链接。', mentions: [] },
];
