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

export function noveltyContext(rows = [], options = {}) {
  const over = motifCounts(rows, options).filter(motif => motif.count >= motif.perWeek);
  const { asked, of } = questionShare(rows);
  const questions = of >= 6 && asked / of >= 0.6 ? `【少用问句收尾】你最近 ${of} 条里有 ${asked} 条都用问句结尾，像在采访他。这条说完自己的感受、看法或一件事就停，让他来接。` : '';
  if (!over.length) return questions;
  return `${questions ? questions + '\n' : ''}【最近说太多的】这一周你已经说了很多：${over.map(motif => `${motif.label}（${motif.count}次）`).join('、')}。这些今天除非他问起就别再提，换点别的：你这周的生活里发生的事、你在想的问题、他的事、你们之间的事。`;
}
