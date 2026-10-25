import { replyReplayPlan, replyReplayIssues } from './reply-replay.mjs';
import { topicSaturationPlan, topicSaturationIssues } from './topic-saturation.mjs';
// A small, deliberately conservative duplicate detector.  It tells a caller
// when to retry a draft; it never edits prose or invents a replacement.
const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const assistantRow = row => /^(?:assistant|ai|bot)$/iu.test(String(row?.speaker ?? row?.role ?? row?.author ?? ''));
const rowText = row => clean(typeof row === 'string' ? row : row?.text ?? row?.content ?? row?.message);
const rowTime = row => {
  const value = row?.createdAt ?? row?.created_at ?? row?.timestamp ?? row?.time;
  const time = value instanceof Date ? +value : Date.parse(value);
  return Number.isFinite(time) ? time : null;
};
const splitSentences = text => (String(text ?? '').match(/[^。！？!?；;\n]+[。！？!?；;]*/gu) || [])
  .map(clean).filter(Boolean);
const comparable = text => clean(text).replace(/[\s\p{P}\p{S}]/gu, '');
const grams = text => {
  const value = comparable(text);
  const result = new Set();
  for (let index = 0; index <= value.length - 3; index += 1) result.add(value.slice(index, index + 3));
  return result;
};
const similarity = (left, right) => {
  const a = grams(left), b = grams(right);
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const gram of a) if (b.has(gram)) common += 1;
  // A short shared fragment must not stand in for an otherwise different
  // sentence. Require the same evidence floor on both sides, so adding new
  // content cannot be ignored merely because the other segment is shorter.
  return common / Math.max(a.size, b.size);
};
const characterSimilarity = (left, right) => {
  const a = new Set(comparable(left)), b = new Set(comparable(right));
  if (!a.size || !b.size) return 0;
  let common = 0;
  for (const character of a) if (b.has(character)) common += 1;
  return common / Math.min(a.size, b.size);
};
// A lone 一 in “一下” or “一点” is not a changed numeric fact.  Chinese
// numerals become comparable numbers only when they carry a count unit.
const numberTokens = text => (String(text).match(/\d+(?:\.\d+)?|[零一二两三四五六七八九十百千万半]+(?=(?:个|天|小时|分钟|秒|页|次|张|件|杯|本|版|年|月|周|公里))/gu) || []).join('|');
const completionState = text => {
  const value = String(text);
  if (/(?:还没|尚未|没有|未).{0,4}(?:完成|弄完|洗完|收好|结束)/u.test(value)) return 'pending';
  if (/(?:已经|都).{0,4}(?:完成|弄完|洗完|收好|结束)|(?:完成|弄完|洗完|收好|结束)了/u.test(value)) return 'complete';
  return null;
};
const progressWords = text => new Set((String(text).match(/(?:完成|弄完|收好|结束|开始|取消|恢复|好了)/gu) || []));
const stateChanged = (left, right) => {
  if (numberTokens(left) !== numberTokens(right)) return true;
  const negative = value => /(?:不再|不喜欢|不想|不愿意|不打算|没有(?:买|去|看|读|完成|洗|收到)|还没|尚未)/u.test(value);
  if (negative(left) !== negative(right)) return true;
  const leftCompletion = completionState(left), rightCompletion = completionState(right);
  if (leftCompletion && rightCompletion && leftCompletion !== rightCompletion) return true;
  const a = progressWords(left), b = progressWords(right);
  // A new surrounding clause is not progress by itself.  Only contrast two
  // actual progress statements; “刚” and a transient “没挪窝” are not one.
  if (!a.size || !b.size) return false;
  for (const word of a) if (!b.has(word)) return true;
  for (const word of b) if (!a.has(word)) return true;
  return false;
};
const reviewingOldMatter = text => /(?:还记得|记得.{0,8}(?:吗|没)|刚才|刚刚|上次|之前|前面|前一轮|你说过|你刚说|回顾|复述|再说说(?:那个|刚才|上次)|那个.{0,10}(?:怎么|后来|结果)|继续(?:说|讲|聊)|后来(?:呢|怎么样|如何)|(?:还在|已经|有没有|是否|洗了).{0,12}(?:吗|没|呢))/u.test(text);

function correctionTarget(text) {
  const match = String(text).match(/(?:不要|别|不用|不必|停止)(?:再|总是|老是|一直|反复|每次|总)?(?:再)?(?:说|提|写|讲|用)(?:那个|这种|这个)?(.{2,18}?)(?:了|啦|，|。|！|!|$)/u);
  const target = clean(match?.[1]).replace(/^(?:要|你|我)/u, '').trim();
  return target.length >= 2 && target.length <= 18 ? target : null;
}

function repeatsCorrection(reply, target) {
  const expected = comparable(target);
  const key = [...new Set(expected.replace(/[的一了要个我你会在是着得]/gu, ''))];
  for (const sentence of splitSentences(reply)) {
    const actual = comparable(sentence);
    if (actual.includes(expected)) return true;
    if (expected.length > 8 || key.length < 2) continue;
    const positions = key.map(character => actual.indexOf(character));
    if (positions.every(position => position >= 0) && Math.max(...positions) - Math.min(...positions) <= Math.max(8, expected.length + 3)) return true;
  }
  return false;
}

function recentGroups(conversation, now) {
  // Keep row position outside the returned public data so adjacent assistant
  // bubbles after one user turn become one comparison unit.
  const marked = [];
  for (const [index, row] of (Array.isArray(conversation) ? conversation : []).entries()) marked.push({ ...row, __replyNoveltyIndex: index });
  const cutoff = now - 6 * 60 * 60 * 1000;
  const groups = [];
  for (const row of marked) {
    if (!assistantRow(row)) continue;
    const text = rowText(row); if (!text) continue;
    const at = rowTime(row); if (at !== null && at < cutoff) continue;
    const previous = groups.at(-1);
    if (previous && previous.lastIndex === row.__replyNoveltyIndex - 1) {
      previous.text = clean(`${previous.text}\n${text}`); previous.lastIndex = row.__replyNoveltyIndex; previous.at = at ?? previous.at;
    } else groups.push({ text, at, lastIndex: row.__replyNoveltyIndex });
  }
  return groups.slice(-4).map(({ text, at }) => ({ text, at }));
}

export function replyNoveltyPlan({ conversation = [], userText = '', focusText = '', initiating = false, now = new Date() } = {}) {
  const timestamp = now instanceof Date ? +now : Date.parse(now);
  const safeNow = Number.isFinite(timestamp) ? timestamp : Date.now();
  const recent = recentGroups(conversation, safeNow);
  const priorSentences = recent.flatMap(group => splitSentences(group.text))
    .filter(sentence => comparable(sentence).length >= 12).slice(-16);
  const currentText = clean(userText);
  const reviewing = reviewingOldMatter(currentText);
  const correction = correctionTarget(currentText);
  const saturation = topicSaturationPlan({ conversation, userText: currentText, focusText, now: new Date(safeNow) });
  const context = clean(`【避免重复】最近${recent.length}轮已说内容只作背景，不需要再次汇报；原话已在历史中，不重复附录。${reviewing ? '用户正在明确回顾或追问旧事，可以直接回应相关内容。' : '对已经说过且没有新变化的内容直接省略，不靠换词重讲。接当前用户的话即可，不要求每轮都开新话题。'} 状态持续只表示她还在那里，不要求反复说同一地点、动作和感受；没有新进展时也可以只回应用户。${saturation.context ? ` ${saturation.context}` : ''}${correction ? `用户明确要求停止重复${JSON.stringify(correction)}，不要再使用这个说法、动作或换序复述；简短承认并接当前话题。` : ''}`).slice(0, 900);
  return { initiating: Boolean(initiating), currentText, reviewing, correction, recent, priorSentences, saturation, context,
    replay:replyReplayPlan({userText:currentText,conversation,now:new Date(safeNow)}) };
}

function sentenceSpans(value) {
  const source = String(value ?? ''); const spans = []; const pattern = /[^。！？!?；;\n]+[。！？!?；;]*/gu;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    const text = clean(match[0]);
    if (text) spans.push({ text, start: match.index, end: match.index + match[0].length });
  }
  return spans;
}

const socialShort = text => /^(?:(?:我也)?想你|晚安|早安|抱抱(?:你)?|我在呢|好呀|嗯嗯)[。！？!?～~]*$/u.test(clean(text));
function comparisonSegments(text) {
  const clauses = String(text ?? '').split(/[，,、:：]/u).map(clean).filter(Boolean);
  const segments = [...clauses];
  // Adjacent clauses preserve a compact fact such as “人窝在…，毯子盖着”,
  // where neither clause alone has enough characters to be distinctive.
  for (let index = 0; index < clauses.length - 1; index += 1) segments.push(`${clauses[index]}，${clauses[index + 1]}`);
  return segments.filter(segment => comparable(segment).length >= 8 && !socialShort(segment));
}

function comparableOverlap(left, right) {
  if (stateChanged(left, right)) return null;
  const ngramSimilarity = similarity(left, right);
  const sharedCharacters = characterSimilarity(left, right);
  if (ngramSimilarity < 0.25 || sharedCharacters < 0.7) return null;
  return { confidence: Math.min(1, (ngramSimilarity + sharedCharacters) / 2), ngramSimilarity, sharedCharacters };
}

// This is intentionally a high bar: enough shared three-character runs to
// avoid coincidental topic overlap, plus broad character overlap for harmless
// word-order changes.  Dynamic facts are never normalized away.
export function replyNoveltyMatches(reply, plan = {}) {
  if (plan.reviewing) return [];
  const previous = Array.isArray(plan.priorSentences) ? plan.priorSentences : [];
  const matches = [];
  for (const candidate of sentenceSpans(reply)) {
    let best = null;
    if (comparable(candidate.text).length < 8 || socialShort(candidate.text)) continue;
    for (const prior of previous) {
      const overlap = comparableOverlap(candidate.text, prior);
      if (overlap && (!best || overlap.confidence > best.confidence)) best = { ...candidate, previousText: prior, ...overlap };
    }
    if (best) {
      // Loose overlap can request a rewrite, but cannot justify removing a
      // sentence that also contains a new clause, number or meaningful detail.
      best.exact = best.text === clean(best.previousText);
      matches.push(best);
    }
  }
  return matches;
}

export function replyNoveltyIssues(reply, plan = {}) {
  const replayIssues=replyReplayIssues(reply,plan.replay);
  const correctionIssues=plan.correction&&repeatsCorrection(reply,plan.correction)?['repeated_corrected_content']:[];
  const saturationIssues=topicSaturationIssues(reply,plan.saturation);
  if (plan.reviewing) return [...replayIssues,...correctionIssues,...saturationIssues];
  const previous = Array.isArray(plan.priorSentences) ? plan.priorSentences : [];
  for (const candidate of sentenceSpans(reply)) {
    if (socialShort(candidate.text)) continue;
    for (const prior of previous) {
      // A changed count or completed/pending state applies to the whole
      // sentence, even if one unchanged comma clause happens to overlap.
      if (stateChanged(candidate.text, prior)) continue;
      for (const left of comparisonSegments(candidate.text)) for (const right of comparisonSegments(prior)) {
        if (comparableOverlap(left, right)) return [...replayIssues,...correctionIssues,...saturationIssues,'repeated_reply_content'];
      }
    }
  }
  return [...replayIssues,...correctionIssues,...saturationIssues];
}
