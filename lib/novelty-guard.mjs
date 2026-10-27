// Keeps her from circling the same few things (COMPANION-ALIVENESS.md 5.7):
// counts the motifs in what she said over the last week and, when one is over
// its weekly allowance, says so plainly in this turn's background.
const DAY = 86400000;
export const MOTIFS = Object.freeze([
  { key: 'meal', label: '吃饭和吃了什么', pattern: /汤面|面条|面馆|泡面|吃面|粥|馄饨|早饭|早餐|午饭|晚饭|吃饭|外卖|小炒|煎蛋|热汤|喝汤/u, perWeek: 6 },
  { key: 'coffee', label: '咖啡奶茶豆浆', pattern: /咖啡|奶茶|豆浆/u, perWeek: 4 },
  { key: 'work', label: '改稿配色和工作进度', pattern: /改稿|稿子|初稿|配色|色卡|画图|交稿|客户/u, perWeek: 5 },
  { key: 'game', label: '游戏资讯', pattern: /游戏|试玩|Steam|新品节/u, perWeek: 2 },
  { key: 'routine', label: '洗漱起床钻被窝这类作息', pattern: /洗漱|刷牙|起床|钻被窝|躺下了|洗澡/u, perWeek: 4 },
  { key: 'nag', label: '叮嘱他吃饭穿衣早点睡', pattern: /记得吃|多穿|早点睡|别冻着|多喝水|别熬夜|到了说一声/u, perWeek: 3 },
]);

// rows: her recent messages {speaker,text,createdAt}
export function motifCounts(rows = [], { now = new Date(), days = 7 } = {}) {
  const since = +new Date(now) - days * DAY;
  const hers = rows.filter(row => row.speaker === 'assistant' && Date.parse(row.createdAt) >= since);
  return MOTIFS.map(motif => ({ ...motif, count: hers.filter(row => motif.pattern.test(row.text)).length, of: hers.length }));
}

// Ending nearly every message on a question reads like an interview.
export function questionShare(rows = [], { last = 8 } = {}) {
  const hers = rows.filter(row => row.speaker === 'assistant').slice(-last);
  return { asked: hers.filter(row => /[？?][\s～~😏]*$/u.test(row.text.trim())).length, of: hers.length };
}

// Words she keeps coming back to, found in what she actually said rather than
// in a list someone wrote. A word counts when it turns up in several of her
// messages this week far more often than in her own earlier weeks (so her
// ordinary vocabulary is not flagged) and more than he has been using it (so
// answering him is not flagged). Whatever she is wearing out shows up here
// by itself, and drops out once she stops.
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });
const PARTICLES = /[的了是着呢吧吗啊嘛呀哦哈嘿嗯]/u;
// Names and dishes the dictionary does not know come out of the segmenter as
// single characters (烧|鸭, 张|居|正); runs of those are glued back together,
// stopping at the everyday single-character words that stand on their own.
const BREAK = /^[我你他她它们的了是在有和与就都也很太还去来说看想要吃喝给让把被从到对会能不没又再才只好多少大小新老上下里外前后这那哪谁啊呀呢吧吗嘛哦嗯哈嘿一二三两个着过为跟像先最更别真挺却而且但如果可]$/u;
function* tokens(text) {
  let run = '';
  const flush = function* () { if ([...run].length >= 2) yield run; run = ''; };
  for (const part of segmenter.segment(String(text))) {
    const word = part.segment, single = [...word].length === 1;
    if (part.isWordLike && single && /\p{Script=Han}/u.test(word) && !BREAK.test(word)) { run += word; continue; }
    yield* flush();
    if (part.isWordLike && !single) yield word;
  }
  yield* flush();
}
function wordDocs(rows) {
  const counts = new Map();
  for (const row of rows) {
    const seen = new Set();
    for (const word of tokens(row.text)) {
      if ([...word].length < 2 || PARTICLES.test(word) || !/\p{Script=Han}/u.test(word) || seen.has(word)) continue;
      seen.add(word); counts.set(word, (counts.get(word) || 0) + 1);
    }
  }
  return counts;
}
export function repeatedPhrases(rows = [], { now = new Date(), days = 7, baselineDays = 28, min = 3, burst = 3 } = {}) {
  const at = row => Date.parse(row.createdAt), since = +new Date(now) - days * DAY, from = since - baselineDays * DAY;
  const hers = rows.filter(row => row.speaker === 'assistant' && at(row) >= since);
  const earlierRows = rows.filter(row => row.speaker === 'assistant' && at(row) >= from && at(row) < since);
  // Without a few weeks of her own talk to compare against there is no judgement to make.
  if (hers.length < 10 || earlierRows.length < 30) return [];
  const recent = wordDocs(hers), earlier = wordDocs(earlierRows);
  const his = wordDocs(rows.filter(row => row.speaker === 'user' && at(row) >= since));
  const earlierTotal = earlierRows.length;
  return [...recent].filter(([word, count]) => count >= min && (his.get(word) || 0) < count
    && (count / hers.length) >= burst * ((earlier.get(word) || 0) + 0.5) / (earlierTotal + 20))
    .sort((a, b) => b[1] - a[1]).slice(0, 8).map(([word, count]) => ({ word, count, of: hers.length }));
}

export function noveltyContext(rows = [], options = {}) {
  const over = motifCounts(rows, options).filter(motif => motif.count >= motif.perWeek);
  const { asked, of } = questionShare(rows);
  const questions = of >= 6 && asked / of >= 0.6 ? `【少用问句收尾】你最近 ${of} 条里有 ${asked} 条都用问句结尾，像在采访他。这条说完自己的感受、看法或一件事就停，让他来接。` : '';
  const repeated = repeatedPhrases(rows, options);
  const worn = repeated.length ? `【你最近老提的】这一周你 ${repeated[0].of} 条里反复出现：${repeated.map(item => `${item.word}（${item.count}次）`).join('、')}。除非他先提，今天换别的词、别的事。` : '';
  const head = [questions, worn].filter(Boolean).join('\n');
  if (!over.length) return head;
  return `${head ? head + '\n' : ''}【最近说太多的】这一周你已经说了很多：${over.map(motif => `${motif.label}（${motif.count}次）`).join('、')}。这些今天除非他问起就别再提，换点别的：你这周的生活里发生的事、你在想的问题、他的事、你们之间的事。`;
}
