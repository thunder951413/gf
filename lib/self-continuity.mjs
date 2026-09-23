const WINDOW_MS = 36 * 60 * 60 * 1000;
const MAX_ROWS = 24;
const MAX_FACTS = 4;
const MAX_CONTEXT_CHARS = 600;

const clean = value => String(value ?? '').replace(/[\r\n]+/gu, ' ').replace(/\s+/gu, ' ').trim();
const messageDate = row => row?.createdAt ?? row?.created_at ?? null;

function dateOf(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function ownText(value) {
  // Do not turn a user quote, copied chat line, or an explicitly attributed line
  // into a fact about the companion.
  return clean(value)
    .replace(/[“「『][^”」』]{0,500}[”」』]/gu, '')
    .replace(/(?:你|用户|他|她)(?:说|问|写道|提到)[：:]?[^。！？!?]{0,500}/gu, '');
}

function isNegated(text) {
  return /(?:还没|没有|未|准备|打算|快要|快|正在|马上|差(?:最后)?一点|还差|没(?:有)?弄完|没(?:有)?看完)/u.test(text);
}

function completedTopic(text) {
  if (isNegated(text)) return null;
  if (/(?:稿子|设计稿|包装稿|方案|这版|那版|项目|文件).{0,28}(?:弄完|做完|收了尾|收尾了|交(?:了|出去)|定稿|完成)|(?:我这边|我).{0,16}(?:稿子|设计|包装|方案).{0,24}(?:弄完|做完|收了尾|收尾了|交(?:了|出去)|定稿|完成)|客户.{0,18}(?:没问题|通过|确认).{0,20}(?:稿|设计|包装|方案|我这边)?/u.test(text)) return 'work';
  if (/(?:我).{0,12}(?:读完|看完).{0,20}(?:书|小说|文章|短篇)|(?:书|小说|文章|短篇).{0,20}(?:我.{0,8})?(?:读完|看完)/u.test(text)) return 'reading';
  if (/(?:我).{0,12}看完.{0,20}(?:电影|片子|纪录片|剧)|(?:电影|片子|纪录片|剧).{0,20}(?:我.{0,8})?看完/u.test(text)) return 'film';
  if (/(?:我).{0,12}(?:下单|买了|收到|取到了).{0,28}(?:纸|笔|书|衣|东西|材料|包裹)|(?:纸|笔|书|衣|材料|包裹).{0,20}(?:下单|买了|收到|取到了)/u.test(text)) return 'shopping';
  return null;
}

function factFrom(row) {
  if (!row || row.speaker !== 'assistant') return null;
  const createdAt = messageDate(row);
  if (!dateOf(createdAt)) return null;
  // A later sentence about the user or the next activity does not negate a
  // completed action. Scope negation to the clause containing that action.
  for (const clause of ownText(row.text).split(/[，,。！？!?；;\n]/u)) {
    if (/^\s*(?:你|他|她|用户)/u.test(clause)) continue;
    const topic = completedTopic(clause);
    if (topic) return { sourceId: String(row.id ?? ''), createdAt, text: clean(clause).slice(0, 90), topic };
  }
  return null;
}

function contextFor(completed) {
  const lines = ['【已分享的本人近况｜连续性核对】', '以下是已说过的自己的明确完成事实，同一件事不能退回未完成；泛泛的“工作时段”不代表那份稿子还没交。不为圆场临时编返工理由；用户指出矛盾时直接承认说混了。仅用于连续性，不必提及。'];
  for (const item of completed) lines.push(`${item.createdAt.slice(0, 10)}｜${item.topic}｜${item.text}（来源 ${item.sourceId || '无'}）`);
  return lines.join('\n').slice(0, MAX_CONTEXT_CHARS);
}

export function selfContinuityPlan({ conversation, userText = '', now = new Date() } = {}) {
  const reference = dateOf(now);
  if (!Array.isArray(conversation) || !reference) return { context: '', completed: [], repeatedTopics: [] };
  const rows = conversation
    .filter(row => row?.speaker === 'assistant' && dateOf(messageDate(row)) && reference - dateOf(messageDate(row)) <= WINDOW_MS && reference >= dateOf(messageDate(row)))
    .slice(-MAX_ROWS);
  const all = rows.map(factFrom).filter(Boolean);
  const seen = new Set();
  const completed = all.reverse().filter(item => !seen.has(item.topic) && seen.add(item.topic)).slice(0, MAX_FACTS).reverse();
  const repeatedTopics = [...new Set(all.filter(item => item.topic).map(item => item.topic).filter(topic => all.filter(item => item.topic === topic).length > 1))];
  return { context: completed.length ? contextFor(completed) : '', completed, repeatedTopics };
}

function explicitNewOrRework(text) {
  return /(?:新(?:的)?(?:稿|版|任务|项目|方案)|另一版|下一版|客户.{0,16}(?:又|要求|让).{0,16}(?:改|修|返工)|(?:改|修|返工).{0,16}(?:稿|版|方案))/u.test(text);
}

export function selfContinuityIssues(reply, plan) {
  const text = ownText(reply);
  if (!Array.isArray(plan?.completed) || explicitNewOrRework(text)) return [];
  const completedWork = plan.completed.some(item => item.topic === 'work');
  const sameWorkRegression = /(?:这|那)(?:版|份)?(?:稿子|设计稿|包装稿|方案).{0,28}(?:还差|还剩.{0,10}(?:收尾|没)|还在收尾|没弄完|还没(?:弄完|收尾)|最后一点(?:没|还))/u.test(text);
  return completedWork && sameWorkRegression ? ['completed_work_regression'] : [];
}
