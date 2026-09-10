// Bounded offline experiment: lexical retrieval only. No production stores,
// embeddings, model calls, timers, or external services are used here.
import { salience } from '../attention-simulation/attention.mjs';

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const PRONOUN_ONLY = /^(?:(?:那(?:个|件事|件|次|些)?|它|这(?:个|件事|件|次|些)?|刚才(?:那个)?|之前(?:那个)?|他|她)(?:呢|怎么样|如何|还好吗|后来呢)?|接着说|继续(?:说)?)[？?。！!]*$/u;
const NEGATION = /(?:别(?:再)?|不要|不用|不想|不愿|不聊|不说|不提|算了|取消|改期|没去|没有去|并非|不是|never|don't|do not|stop|cancel(?:led)?)/iu;
const DURABLE_CHANGE = /(?:取消|改期|不去了|没去成|已经不是|不再|cancel(?:led)?|postpon(?:e|ed))/iu;
const SWITCH = /(?:换个话题|换一(?:个|件)|说点别的|聊点别的|先不聊|不说.+了|改聊|聊聊|说说|speaking of|change (?:the )?subject|let'?s talk about)/iu;
const QUESTION = /[?？]|^(?:谁|什么|哪|怎么|怎样|为何|为什么|是否|能否|可不可以|how|what|why|when|where|who|is|are|do|does|did|can|could|would|should)\b/iu;
const STOP = new Set(['的', '了', '呢', '吗', '吧', '啊', '我', '你', '他', '她', '它', '这', '那', '一个', '一下', '现在', '今天', '最近', '换个', '话题', '聊聊', '说说', '接着', '后来', '怎么样', '再提', '别再', 'the', 'a', 'an', 'to', 'of', 'and', 'or', 'is', 'are', 'i', 'you', 'it', 'this', 'that', 'about', 'please']);

const copy = value => value == null ? value : structuredClone(value);
const norm = text => String(text ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();

function lexicalTokens(text) {
  const clean = norm(text);
  if (!clean) return [];
  const out = [];
  const segmenter = typeof Intl?.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'word' }) : null;
  const words = segmenter
    ? [...segmenter.segment(clean)].filter(x => x.isWordLike).map(x => x.segment)
    : clean.match(/[\p{L}\p{N}]+/gu) || [];
  for (const word of words) {
    if (!STOP.has(word) && word.length > 1) out.push(`w:${word}`);
    if (CJK.test(word)) {
      const chars = [...word].filter(ch => CJK.test(ch));
      for (let i = 0; i + 1 < chars.length; i++) {
        const gram = chars[i] + chars[i + 1];
        if (!STOP.has(gram)) out.push(`c:${gram}`);
      }
    }
  }
  return out;
}

const unique = xs => [...new Set(xs)];
const frequencies = tokens => {
  const map = new Map();
  for (const token of tokens) map.set(token, (map.get(token) || 0) + 1);
  return map;
};

function memoryTokens(memory) {
  // Keywords and topic are searchable labels, not aliases supplied by turns.
  return lexicalTokens([memory.topic, ...(memory.keywords || []), memory.text].join(' '));
}

function lexicalRank(memories, query) {
  const queryTokens = unique(lexicalTokens(query));
  const docs = memories.map(memoryTokens);
  const lengths = docs.map(x => x.length);
  const avgdl = lengths.reduce((a, b) => a + b, 0) / Math.max(1, lengths.length) || 1;
  const df = new Map();
  for (const doc of docs) for (const token of new Set(doc)) df.set(token, (df.get(token) || 0) + 1);
  const scores = new Map();
  const evidence = new Map();
  for (let i = 0; i < memories.length; i++) {
    const tf = frequencies(docs[i]);
    let score = 0; const hits = [];
    for (const token of queryTokens) {
      const f = tf.get(token) || 0;
      if (!f) continue;
      hits.push(token);
      const idf = Math.log(1 + (memories.length - (df.get(token) || 0) + 0.5) / ((df.get(token) || 0) + 0.5));
      score += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * lengths[i] / avgdl));
    }
    const qWords = queryTokens.filter(x => x.startsWith('w:'));
    const qCjk = queryTokens.filter(x => x.startsWith('c:'));
    const wordHitCount = hits.filter(x => x.startsWith('w:')).length;
    const topicWords = new Set(lexicalTokens(memories[i].topic).filter(x => x.startsWith('w:')));
    const exactTopic = qWords.some(x => topicWords.has(x));
    const exactWord = exactTopic || (wordHitCount > 0 && (qWords.length <= 2 || wordHitCount / qWords.length >= 0.5));
    const cjkCoverage = qCjk.length ? hits.filter(x => x.startsWith('c:')).length / qCjk.length : 0;
    // A shared fragment in a longer phrase is not enough. This is deliberately
    // conservative because lexical resemblance is not semantic relevance.
    const supported = exactWord || (qCjk.length === 1 && cjkCoverage === 1) || cjkCoverage >= 0.5;
    scores.set(memories[i].id, supported ? score : 0);
    evidence.set(memories[i].id, { hits, queryTokenCount: queryTokens.length, cjkCoverage, supported });
  }
  return { scores, evidence, queryTokens };
}

function clauseAnalysis(memories, raw) {
  const clauses = String(raw ?? '').split(/[，,。；;]|\b(?:but|however|instead)\b|(?:但是|不过|然后|转而)/iu).map(x => x.trim()).filter(Boolean);
  const negativeClauses = clauses.filter(x => NEGATION.test(x));
  const positiveClauses = clauses.filter(x => !NEGATION.test(x));
  const positiveText = positiveClauses.join(' ');
  const positiveRank = lexicalRank(memories, positiveText);
  const negativeTopics = new Set();
  for (const clause of negativeClauses) {
    const r = lexicalRank(memories, clause);
    for (const memory of memories) if ((r.scores.get(memory.id) || 0) > 0) negativeTopics.add(memory.topic);
  }
  return { positiveText, positiveRank, negativeTopics, negativeClauses, positiveClauses };
}

function duplicate(a, b) {
  const A = new Set(lexicalTokens(a.text)); const B = new Set(lexicalTokens(b.text));
  if (norm(a.text) === norm(b.text)) return true;
  let common = 0; for (const token of A) if (B.has(token)) common++;
  return common / Math.max(1, Math.min(A.size, B.size)) >= 0.82;
}

function substantive(text) {
  const clean = norm(text);
  return clean.length >= 4 && unique(lexicalTokens(clean)).length > 0;
}

function xorshift32(seed) {
  let state = (seed >>> 0) || 0x9e3779b9;
  return () => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) / 2 ** 32;
  };
}

function publicMemory(memory, score, strength, lexicalScore) {
  const result = copy(memory);
  return { ...result, score, strength, lexicalScore };
}

export class AttentionMemory {
  constructor({ memories = [], halfLife = 3, maxChars = 1200, seed = 42 } = {}) {
    this.halfLife = halfLife;
    this.maxChars = maxChars;
    this.seed = seed >>> 0;
    this._random = xorshift32(this.seed);
    this._memories = copy(memories).map((m, i) => ({
      mentions: [], exposures: [], type: 'user', base: 8, ...m,
      id: String(m.id ?? `memory-${i + 1}`), keywords: copy(m.keywords || []),
      mentions: copy(m.mentions || []), exposures: copy(m.exposures || []),
    }));
    this._turns = [];
    this._focus = [];
    this._blocks = [];
    this._lastAssistantDiagnostics = { assessments: [], uncertainExposure: false, episodicStored: false };
    this._nextId = 1;
  }

  observeUser({ text, day, turnId } = {}) {
    const raw = String(text ?? '');
    const id = String(turnId ?? `user-${this._turns.length + 1}`);
    const eligible = this._memories.filter(m => m.born <= day && !m.superseded);
    const analysis = clauseAnalysis(eligible, raw);
    const rank = analysis.positiveRank;
    const negative = analysis.negativeClauses.length > 0;
    const isSwitch = SWITCH.test(raw);
    const positiveMatched = eligible
      .filter(m => (rank.scores.get(m.id) || 0) > 0)
      .sort((a, b) => (rank.scores.get(b.id) || 0) - (rank.scores.get(a.id) || 0));
    const affectedTopics = [...analysis.negativeTopics].slice(0, 3);

    if (negative) {
      const until = day + (DURABLE_CHANGE.test(raw) ? 30 : 3);
      for (const topic of affectedTopics) this._blocks.push({ topic, at: day, until, turnId: id, reason: DURABLE_CHANGE.test(raw) ? 'correction-or-cancellation' : 'scoped-refusal' });
    }
    {
      const seenTopics = new Set();
      for (const memory of positiveMatched.slice(0, 4)) {
        if (seenTopics.has(memory.topic)) continue;
        memory.mentions.push({ at: day, who: 'user', turn: id });
        seenTopics.add(memory.topic);
      }
      if (positiveMatched.length) {
        this._focus.unshift({ day, turnId: id, topics: unique(positiveMatched.slice(0, 2).map(m => m.topic)) });
        this._focus = this._focus.slice(0, 6);
      }
    }
    if (isSwitch) this._focus = positiveMatched.length ? [{ day, turnId: id, topics: unique(positiveMatched.slice(0, 2).map(m => m.topic)) }] : [];

    this._turns.push({ role: 'user', text: raw, day, turnId: id });
    if (substantive(raw)) {
      this._memories.push({
        id: `observed-user-${this._nextId++}`, topic: positiveMatched[0]?.topic || affectedTopics[0] || `utterance:${id}`, text: raw,
        born: day, base: QUESTION.test(raw) ? 2 : 4, mentions: [], exposures: [], type: 'user',
        recordKind: 'user_utterance', asserted: !QUESTION.test(raw), sourceTurnId: id,
      });
    }
    return { matchedIds: positiveMatched.map(m => m.id), blockedTopics: affectedTopics, negative, switched: isSwitch, storedRaw: substantive(raw) };
  }

  select({ text = '', day, mode = 'reply', maxItems = 5 } = {}) {
    const suppliedText = String(text ?? '');
    const raw = mode === 'proactive' ? suppliedText : suppliedText || [...this._turns].reverse().find(t => t.role === 'user')?.text || '';
    const currentTurn = [...this._turns].reverse().find(t => t.role === 'user' && t.text === raw)?.turnId;
    const candidates = this._memories.filter(m => m.born <= day && !m.superseded && !(currentTurn && m.sourceTurnId === currentTurn));
    const analysis = clauseAnalysis(candidates, raw);
    const rank = analysis.positiveRank;
    const blocked = new Set(this._blocks.filter(b => b.at <= day && day <= b.until).map(b => b.topic));
    const pronoun = PRONOUN_ONLY.test(norm(raw));
    const recentFocus = unique(this._focus.filter(f => f.day <= day && day - f.day <= 7).slice(0, 3).flatMap(f => f.topics)).slice(0, 2);
    const rows = [];

    for (const memory of candidates) {
      if (mode === 'proactive' && blocked.has(memory.topic)) continue;
      const lexicalScore = rank.scores.get(memory.id) || 0;
      const focusMatch = pronoun && recentFocus.includes(memory.topic);
      if (mode === 'reply' && (!lexicalScore && !focusMatch || analysis.negativeTopics.has(memory.topic))) continue;
      const strength = salience(memory, day, { halfLife: this.halfLife, mentionHalfLife: this.halfLife });
      let score = strength + lexicalScore * 12 + (focusMatch ? 9 : 0);
      const priorExposures = memory.exposures.filter(x => x <= day);
      const lastExposure = priorExposures.length ? Math.max(...priorExposures) : -Infinity;
      if (mode === 'proactive') {
        if (strength < 1.5) continue;
        const exposureCount = priorExposures.length;
        const recencyPenalty = Number.isFinite(lastExposure) ? 0.8 * 2 ** (-(day - lastExposure) / 4) : 0;
        score *= Math.max(0.08, (1 - recencyPenalty) / Math.sqrt(1 + exposureCount));
      }
      rows.push({ memory, score, strength, lexicalScore });
    }

    rows.sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id));
    if (mode === 'proactive' && rows.length > 1) {
      const top = rows[0].score;
      const near = rows.filter(r => r.score >= top * 0.88);
      for (const row of near) row.score *= 0.97 + this._random() * 0.06;
      rows.sort((a, b) => b.score - a.score || a.memory.id.localeCompare(b.memory.id));
    }

    const selected = []; const topicCounts = new Map(); let chars = 0;
    for (const row of rows) {
      if (selected.length >= Math.max(0, maxItems)) break;
      if (chars + row.memory.text.length > this.maxChars) continue;
      if ((topicCounts.get(row.memory.topic) || 0) >= 2) continue;
      if (selected.some(x => duplicate(x, row.memory))) continue;
      selected.push(publicMemory(row.memory, row.score, row.strength, row.lexicalScore));
      topicCounts.set(row.memory.topic, (topicCounts.get(row.memory.topic) || 0) + 1);
      chars += row.memory.text.length;
    }
    return {
      selected,
      diagnostics: {
        lexicalOnly: true,
        semanticGuarantee: false,
        queryPreserved: raw,
        queryTokens: rank.queryTokens,
        pronounFallback: pronoun,
        recentFocus,
        activeBlocks: [...blocked],
        negativeClauseTopics: [...analysis.negativeTopics],
        eligibleCount: candidates.length,
        rankedCount: rows.length,
        selectedChars: chars,
        charBudget: this.maxChars,
        uncertainExposure: this._lastAssistantDiagnostics.uncertainExposure,
      },
    };
  }

  observeAssistant({ text, day, turnId, selectedIds = [] } = {}) {
    const raw = String(text ?? '');
    const selected = new Set(selectedIds.map(String));
    const assessments = [];
    for (const memory of this._memories) {
      if (!selected.has(memory.id)) continue;
      const rank = lexicalRank([memory], raw);
      const e = rank.evidence.get(memory.id);
      const wordHits = unique((e?.hits || []).filter(x => x.startsWith('w:')));
      const cjkHits = unique((e?.hits || []).filter(x => x.startsWith('c:')));
      // Repeating only the topic label (for example, "I like diving") does
      // not prove that a selected detail (island, date, sensation) was used.
      const supported = Boolean(e?.supported && (wordHits.length >= 2 || cjkHits.length >= 3));
      if (supported) memory.exposures.push(day);
      assessments.push({ id: memory.id, used: supported, basis: supported ? 'conservative-lexical-overlap' : 'uncertain-no-exposure-recorded' });
    }
    const usedTopics = unique(assessments.filter(x => x.used).map(x => this._memories.find(m => m.id === x.id)?.topic).filter(Boolean));
    if (usedTopics.length) {
      this._focus.unshift({ day, turnId: String(turnId ?? `assistant-${this._turns.length + 1}`), topics: usedTopics.slice(0, 2), source: 'assistant-supported-use' });
      this._focus = this._focus.slice(0, 6);
    }
    this._turns.push({ role: 'assistant', text: raw, day, turnId: String(turnId ?? `assistant-${this._turns.length + 1}`), selectedIds: [...selected] });
    // Automatic extraction of claimed assistant experience is deliberately
    // disabled: lexical rules cannot reliably separate fiction from real sources.
    this._lastAssistantDiagnostics = {
      assessments,
      uncertainExposure: assessments.some(x => !x.used),
      episodicStored: false,
      extractionSkipped: 'assistant self-experience/source verification is unsafe without provenance',
    };
    return copy(this._lastAssistantDiagnostics);
  }

  snapshot(day) {
    return {
      day,
      memories: this._memories.map(m => publicMemory(m, salience(m, day, { halfLife: this.halfLife, mentionHalfLife: this.halfLife }), salience(m, day, { halfLife: this.halfLife, mentionHalfLife: this.halfLife }), 0)),
      futureCount: this._memories.filter(m => m.born > day).length,
      recentFocus: copy(this._focus.filter(f => f.day <= day && day - f.day <= 7)),
      focus: copy(this._focus.filter(f => f.day <= day && day - f.day <= 7)),
      activeBlocks: copy(this._blocks.filter(b => b.at <= day && day <= b.until)),
      lastAssistantDiagnostics: copy(this._lastAssistantDiagnostics),
      limitations: ['lexical matching is not semantic understanding', 'assistant experience extraction is disabled without provenance'],
    };
  }
}
