const WINDOW_MS = 48 * 60 * 60 * 1000;
const MIN_ASSISTANT_TURNS = 3;
const MAX_TOPICS = 6;

const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const assistantRow = row => /^(?:assistant|ai|bot|miyue)$/iu.test(String(row?.speaker ?? row?.role ?? row?.author ?? ''));
const rowText = row => clean(typeof row === 'string' ? row : row?.text ?? row?.content ?? row?.message);
const rowTime = row => {
  const value = row?.createdAt ?? row?.created_at ?? row?.timestamp ?? row?.time;
  const time = value instanceof Date ? +value : Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

// These are grammatical glue and conversational scaffolding, not subjects.
// The list deliberately contains no clothes, activities, places, names, or
// other domain topics. Topic candidates must retain adjacent lexical content.
const EDGE = new Set([...'我你他她它们的是了在有把被这那哪个件个还就都也不再会要能很可今明昨刚又先别说让到对跟给从着呢吧吗啊呀哦嗯来去上一下前后过得地而且但却才真挺更最没只为于及或并每各某些处本张条口点次']);
const CONTENT_GAP = new Set([...[...EDGE].filter(char => !'内外边里上下前后'.includes(char)), ...'日月年时分秒早晚中']);
const wordSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });

function words(text) {
  return [...wordSegmenter.segment(String(text ?? ''))].filter(item => item.isWordLike).map(item => item.segment);
}

function phraseCandidates(text) {
  const candidates = new Set();
  for (const chunk of String(text ?? '').match(/[\p{Script=Han}]{3,}/gu) || []) {
    for (let length = 3; length <= Math.min(8, chunk.length); length += 1) {
      for (let index = 0; index <= chunk.length - length; index += 1) {
        const phrase = chunk.slice(index, index + length);
        if (EDGE.has(phrase[0]) || EDGE.has(phrase.at(-1))) continue;
        let adjacentContent = false;
        for (let offset = 0; offset < phrase.length - 1; offset += 1) {
          if (!CONTENT_GAP.has(phrase[offset]) && !CONTENT_GAP.has(phrase[offset + 1])) { adjacentContent = true; break; }
        }
        if (adjacentContent) candidates.add(phrase);
      }
    }
  }
  return candidates;
}

function assistantTurns(rows) {
  const turns = [];
  for (const [position, row] of rows.entries()) {
    if (!assistantRow(row)) continue;
    const text = rowText(row);
    if (!text) continue;
    const previous = turns.at(-1);
    if (previous && previous.lastPosition === position - 1) {
      previous.text = `${previous.text}\n${text}`;
      previous.lastPosition = position;
    } else turns.push({ text, firstPosition: position, lastPosition: position });
  }
  return turns;
}

function distinctiveBigrams(phrase) {
  const result = [];
  for (let index = 0; index < phrase.length - 1; index += 1) {
    const pair = phrase.slice(index, index + 2);
    if (![...pair].some(char => CONTENT_GAP.has(char))) result.push(pair);
  }
  return result;
}

function mentioned(text, phrase, { allowHead = false, allowRepeatedHead = false, userTexts = [] } = {}) {
  if (String(text).includes(phrase)) return true;
  if (distinctiveBigrams(phrase).some(pair => String(text).includes(pair))) return true;
  const head = words(phrase).filter(word => ![...word].every(char => CONTENT_GAP.has(char))).at(-1);
  if (!head) return false;
  if (allowHead && words(text).includes(head)) return true;
  return Boolean(allowRepeatedHead && userTexts.filter(value => words(value).includes(head)).length >= 2);
}

function occurrenceStats(turns) {
  const stats = new Map();
  for (const [turnIndex, turn] of turns.entries()) for (const phrase of phraseCandidates(turn.text)) {
    const item = stats.get(phrase) || { phrase, turnIndexes: [], samples: [] };
    item.turnIndexes.push(turnIndex);
    if (item.samples.length < 2) item.samples.push(turn.text.slice(0, 180));
    stats.set(phrase, item);
  }
  return [...stats.values()].filter(item => item.turnIndexes.length >= MIN_ASSISTANT_TURNS);
}

function sameFamily(left, right) {
  return left.includes(right) || right.includes(left)
    || distinctiveBigrams(left).some(pair => right.includes(pair));
}

export function topicSaturationPlan({ conversation = [], userText = '', focusText = '', now = new Date() } = {}) {
  const timestamp = now instanceof Date ? +now : Date.parse(now);
  const safeNow = Number.isFinite(timestamp) ? timestamp : Date.now();
  const rows = (Array.isArray(conversation) ? conversation : []).filter(row => {
    const at = rowTime(row);
    return at === null || safeNow - at <= WINDOW_MS;
  });
  const turns = assistantTurns(rows);
  const userTexts = rows.filter(row => !assistantRow(row)).map(rowText).filter(Boolean);
  const current = clean(`${userText}\n${focusText}`);
  const recurring = occurrenceStats(turns);
  const engaged = recurring.filter(item => mentioned('', item.phrase, { allowRepeatedHead: true, userTexts }));
  const currentTopics = recurring.filter(item => mentioned(current, item.phrase, { allowHead: true }));
  const ranked = recurring
    .filter(item => !engaged.some(other => sameFamily(item.phrase, other.phrase)))
    .filter(item => !currentTopics.some(other => sameFamily(item.phrase, other.phrase)))
    .sort((left, right) => right.turnIndexes.length - left.turnIndexes.length || right.phrase.length - left.phrase.length);
  const topics = [];
  for (const item of ranked) {
    if (topics.some(selected => sameFamily(selected.phrase, item.phrase))) continue;
    topics.push({ phrase: item.phrase, assistantTurns: item.turnIndexes.length, samples: item.samples });
    if (topics.length >= MAX_TOPICS) break;
  }
  const context = topics.length
    ? `【话题饱和】角色近两天已在多个独立轮次主动带回这些细节，而用户没有继续展开：${topics.map(item => item.phrase).join('、')}。它们现在处于冷却状态，本轮不要主动提及，也不要换称呼或改写后带回。用户当前明确问到或紧邻话题确实在继续时才恢复。`
    : '';
  return { topics, context, windowMs: WINDOW_MS, threshold: MIN_ASSISTANT_TURNS };
}

export function topicSaturationIssues(reply, plan = {}) {
  const value = String(reply ?? '');
  return (plan.topics || []).some(topic => mentioned(value, topic.phrase)) ? ['saturated_topic_reuse'] : [];
}

export const TOPIC_SATURATION_LIMITS = Object.freeze({ windowMs: WINDOW_MS, minAssistantTurns: MIN_ASSISTANT_TURNS, maxTopics: MAX_TOPICS });
