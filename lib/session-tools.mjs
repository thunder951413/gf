import { collectConversationMemory } from './conversation-memory.mjs';
import { selectTurnMemory } from './turn-memory.mjs';

const TOOL_NAMES = new Set(['recall', 'sources', 'state','explore']);
const MAX_QUERY_CHARS = 500;
const MAX_ITEMS = 6;
const MAX_RECALL_CHARS = 3600;
const MAX_RECALL_TEXT_CHARS = 2800;
const MAX_EVIDENCE_CHARS = 700;
const STATE_SECTION_BUDGETS = Object.freeze({
  at: 100,
  current: 600,
  life: 550,
  relationship: 700,
  agenda: 700,
  reminders: 1000,
  social: 450,
  interests: 450,
  dynamics: 1100,
  growth: 1400,
  recordingProtocol: 2200,
  note: 350,
});
const MAX_STATE_ITEMS_CHARS = 10000;

const SYNONYMS = [
  ['礼物', '送给', '赠送', '纪念品'],
  ['工作', '上班', '项目', '职业'],
  ['吃饭', '早餐', '午餐', '晚餐', '餐厅'],
  ['旅行', '旅游', '出游', '行程'],
  ['电影', '影片', '影视'],
  ['书', '读书', '阅读', '小说'],
  ['喜欢', '偏好', '最爱'],
  ['约定', '答应', '承诺', '计划'],
  ['取消', '不去了', '作废'],
  ['更正', '改成', '纠正'],
  ['呼吸', '换气', '气息'],
  ['来源', '文章', '资料', '链接'],
];

const QUERY_STOP = new Set([
  '我', '你', '她', '他', '我们', '你们', '之前', '以前', '上次', '过去', '最近', '现在', '当时',
  '记得', '还记得', '查一下', '找一下', '回忆', '说过', '聊过', '提过', '那个', '这个', '什么',
  '怎么', '怎样', '情况', '内容', '有关', '关于', '一下', '还有', '请问', 'please', 'remember',
  'recall', 'find', 'search', 'about', 'what', 'when', 'where', 'the', 'and',
]);

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'word' });

function failure(message, code) {
  return Object.assign(new Error(message), { code });
}

function abortReason(signal) {
  return signal?.reason ?? new DOMException('The operation was aborted', 'AbortError');
}

function checkAbort(signal) {
  if (signal?.aborted) throw abortReason(signal);
}

function clean(value, limit = Infinity) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, limit);
}

function iso(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.valueOf())) throw failure('clock returned an invalid date', 'INVALID_SESSION_CLOCK');
  return date.toISOString();
}

function expandQuery(query) {
  const additions = [];
  for (const group of SYNONYMS) {
    if (group.some(term => query.toLocaleLowerCase().includes(term.toLocaleLowerCase()))) additions.push(...group);
  }
  return [...new Set([query, ...additions])].join(' ');
}

function terms(value) {
  const result = new Set();
  let han = '';
  const flush = () => {
    for (let size = 2; size <= Math.min(4, han.length); size += 1) {
      for (let start = 0; start <= han.length - size; start += 1) {
        const token = han.slice(start, start + size);
        if (!QUERY_STOP.has(token)) result.add(token);
      }
    }
    han = '';
  };
  for (const part of segmenter.segment(clean(value).toLocaleLowerCase())) {
    if (!part.isWordLike) { flush(); continue; }
    const token = part.segment.replace(/^[\p{P}\p{S}]+|[\p{P}\p{S}]+$/gu, '');
    if (/^[\p{Script=Han}]$/u.test(token)) { han += token; continue; }
    flush();
    if (token.length > 1 && !QUERY_STOP.has(token)) result.add(token);
  }
  flush();
  return result;
}

function lexicalScore(query, value) {
  const expanded = expandQuery(query).toLocaleLowerCase();
  const haystack = clean(value, 12000).toLocaleLowerCase();
  const queryTerms = terms(expanded);
  if (!queryTerms.size) return 0;
  let score = 0;
  for (const term of queryTerms) if (haystack.includes(term)) score += term.length;
  return score;
}

function fitString(value, maxChars) {
  if (JSON.stringify(value).length <= maxChars) return value;
  let low = 0, high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (JSON.stringify(`${value.slice(0, middle)}…`).length <= maxChars) low = middle;
    else high = middle - 1;
  }
  return `${value.slice(0, low)}…`;
}

function fitValue(value, maxChars, depth = 0, seen = new WeakSet()) {
  if (value == null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return fitString(value, maxChars);
  if (typeof value !== 'object' || depth >= 6) return clean(value, Math.min(120, maxChars));
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  const output = Array.isArray(value) ? [] : {};
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value);
  for (const [key, child] of entries) {
    const fitted = fitValue(child, Math.max(80, Math.floor(maxChars / 2)), depth + 1, seen);
    if (Array.isArray(output)) output.push(fitted); else output[clean(key, 80)] = fitted;
    if (JSON.stringify(output).length > maxChars) {
      if (Array.isArray(output)) output.pop(); else delete output[clean(key, 80)];
      if (Array.isArray(output)) output.push('[truncated]'); else output._truncated = true;
      break;
    }
  }
  seen.delete(value);
  return output;
}

function exceedsJsonBudget(value, maxChars) {
  try { return JSON.stringify(value).length > maxChars; } catch { return true; }
}

function evidenceText(item) {
  const value = item?.evidence ?? item?.summary ?? item?.snippet ?? item?.text ?? '';
  if (Array.isArray(value)) return value.map(part => clean(part, 260)).filter(Boolean).join('；').slice(0, MAX_EVIDENCE_CHARS);
  if (value && typeof value === 'object') return clean(JSON.stringify(fitValue(value, MAX_EVIDENCE_CHARS)), MAX_EVIDENCE_CHARS);
  return clean(value, MAX_EVIDENCE_CHARS);
}

function sourceItems(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.results)) return value.results;
  return [];
}

function normalizeSource(item, index) {
  if (!item || typeof item !== 'object') return null;
  const title = clean(item.title ?? item.name, 240);
  const url = clean(item.url ?? item.link, 2048);
  const evidence = evidenceText(item);
  if (!title && !url && !evidence) return null;
  const date = item.publishedAt ?? item.published_at ?? item.date ?? null;
  const publishedAt = date && Number.isFinite(+new Date(date)) ? new Date(date).toISOString() : null;
  return { id: clean(item.id, 180) || `source-${index + 1}`, title: title || '未命名来源', url: url || null, publishedAt, evidence };
}

function compactReminders(value, maxChars) {
  const source = Array.isArray(value) ? value : [];
  const items = [];
  let clipped = !Array.isArray(value);
  for (const row of source) {
    if (!row || typeof row !== 'object') { clipped = true; continue; }
    const reminder = {
      id: clean(row.id, 180),
      role: clean(row.role, 80) || null,
      text: clean(row.text, 300),
      dueAt: clean(row.dueAt ?? row.due_at, 80) || null,
      status: clean(row.status, 40) || null,
    };
    clipped ||= reminder.id !== clean(row.id) || reminder.text !== clean(row.text);
    const candidate = { total: source.length, items: [...items, reminder] };
    if (JSON.stringify(candidate).length > maxChars) { clipped = true; break; }
    items.push(reminder);
  }
  if (items.length < source.length) clipped = true;
  return { value: { total: source.length, items }, truncated: clipped };
}

function compactStateSection(section, value) {
  const budget = STATE_SECTION_BUDGETS[section];
  if (section === 'reminders') return compactReminders(value, budget);
  const fitted = fitValue(value, budget);
  return { value: fitted, truncated: exceedsJsonBudget(value, budget) };
}

function enforceStateBudget(items) {
  const result = items.map(item => ({ ...item }));
  const order = ['social', 'interests', 'life', 'current', 'agenda', 'relationship', 'note', 'recordingProtocol', 'reminders', 'at'];
  let size = JSON.stringify(result).length;
  for (const section of order) {
    if (size <= MAX_STATE_ITEMS_CHARS) break;
    const item = result.find(candidate => candidate.section === section);
    if (!item) continue;
    const current = JSON.stringify(item.value).length;
    const minimum = section === 'recordingProtocol' ? 1000 : section === 'reminders' ? 500 : 80;
    const target = Math.max(minimum, current - (size - MAX_STATE_ITEMS_CHARS) - 80);
    if (target >= current) continue;
    item.value = fitValue(item.value, target);
    item.truncated = true;
    size = JSON.stringify(result).length;
  }
  return { items: result, truncated: size > MAX_STATE_ITEMS_CHARS || result.some(item => item.truncated) };
}

/**
 * Creates read-only, on-demand tools for a companion model session.
 * execute() returns JSON-safe evidence and never authors conversation messages.
 * Public information reads may populate their separate detail cache.
 */
export function createSessionReadTools({ store, recallRepo, episodes, historyEdits, roleId = 'miyue', clock = () => new Date(), getState, searchSources, exploreInformation,hybridRecall, onRetrieval, recallModel, onCall } = {}) {
  if (!store?.db || typeof store.listContent !== 'function') throw new TypeError('createSessionReadTools requires a store');
  if (typeof recallRepo?.consolidated?.snapshot !== 'function') throw new TypeError('createSessionReadTools requires recallRepo');
  if (typeof episodes?.suppressedSourceIds !== 'function' || typeof episodes?.list !== 'function') throw new TypeError('createSessionReadTools requires episodes');
  if (typeof historyEdits?.project !== 'function') throw new TypeError('createSessionReadTools requires historyEdits');
  if (typeof getState !== 'function') throw new TypeError('createSessionReadTools requires getState');
  if (searchSources != null && typeof searchSources !== 'function') throw new TypeError('searchSources must be a function');
  const scopeRole = clean(roleId, 160);
  if (!scopeRole) throw new TypeError('roleId must be a non-empty string');

  return async function execute(input, { signal } = {}) {
    checkAbort(signal);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('tool request must be an object', 'INVALID_SESSION_TOOL_REQUEST');
    const name = clean(input.name);
    if (!TOOL_NAMES.has(name)) throw failure(`unknown session tool: ${name || '(empty)'}`, 'UNKNOWN_SESSION_TOOL');
    if (typeof input.query !== 'string' || !input.query.trim()) throw failure('tool query must be a non-empty string', 'INVALID_SESSION_TOOL_QUERY');
    if (input.query.length > MAX_QUERY_CHARS) throw failure(`tool query exceeds ${MAX_QUERY_CHARS} characters`, 'INVALID_SESSION_TOOL_QUERY');
    const query = clean(input.query, MAX_QUERY_CHARS);
    const now = new Date(clock());
    const asOf = iso(now);
    if(name==='explore'){
      if(!exploreInformation)return {name,unknown:true,notice:'日常信息读取暂不可用'};
      const value=await exploreInformation(query,{signal});checkAbort(signal);return value;
    }

    if (name === 'recall') {
      const candidates = collectConversationMemory({ store, recallRepo, episodes, historyEdits, scope: scopeRole, now });
      checkAbort(signal);
      const selection = { roleId: scopeRole, query, semanticQuery: expandQuery(query), candidates, now, budgetChars: MAX_RECALL_CHARS, maxItems: MAX_ITEMS, signal, model:recallModel, onCall };
      const result = hybridRecall ? await hybridRecall.search(selection) : selectTurnMemory(selection);
      onRetrieval?.(result);
      checkAbort(signal);
      let remainingText = MAX_RECALL_TEXT_CHARS;
      let textWasTruncated = false;
      const items = [];
      for (const item of result.selected) {
        if (remainingText <= 0) { textWasTruncated = true; break; }
        const allowance = Math.min(900, remainingText);
        const text = String(item.text).slice(0, allowance);
        const textTruncated = text.length < String(item.text).length;
        textWasTruncated ||= textTruncated;
        remainingText -= text.length;
        items.push({
          id: item.id, kind: item.kind, subject: item.subject, authorId: item.subject === 'character' ? scopeRole : item.subject, text, textTruncated, at: item.at,
          sourceIds: item.sourceIds, status: item.status, corrected: item.corrected,
        });
      }
      const truncated = textWasTruncated || result.rejected.some(item => item.reason === 'budget' || item.reason === 'item-limit');
      const notice = [
        `仅检索角色 ${scopeRole} 在 ${asOf} 之前可见、未抑制且经过历史更正投影的会话证据。`,
        truncated ? '结果受条目或字符预算限制，可能还有相关证据未返回。' : '未达到本工具的条目或字符预算上限。',
      ];
      if (!items.length) notice.push('没有找到足够相关且有可见来源的记录；未知细节不能据此推断。');
      return { name, query, scope: { roleId: scopeRole, through: asOf, evidence: 'visible-source-backed-conversation', searchedItems: candidates.length, retrieval: result.retrieval?.status || 'lexical' }, items, truncated, unknown: items.length === 0, notice };
    }

    if (name === 'sources') {
      let raw;
      if (searchSources) {
        raw = await searchSources(query, { signal });
        checkAbort(signal);
      } else {
        raw = store.listContent();
        checkAbort(signal);
      }
      let ranked = sourceItems(raw).map(normalizeSource).filter(Boolean).map((item, index) => ({
        item,
        index,
        score: lexicalScore(query, `${item.title} ${item.evidence}`),
      }));
      const broad = terms(expandQuery(query)).size === 0;
      if (!broad) ranked = ranked.filter(entry => entry.score > 0);
      ranked.sort((left, right) => right.score - left.score || left.index - right.index);
      const available = ranked.length;
      const items = ranked.slice(0, 5).map(entry => entry.item);
      const providerScope = searchSources && raw && !Array.isArray(raw) && raw.scope != null
        ? fitValue(raw.scope, 600)
        : null;
      const scope = searchSources
        ? { coverage: 'caller-provided-search', internetSearched: null, provider: providerScope, searchedAt: asOf }
        : { coverage: 'local-cache-only', internetSearched: false, cacheReadAt: asOf };
      const truncated = available > items.length;
      const notice = [searchSources
        ? '结果来自调用方提供的来源检索；覆盖范围和时效仅以 provider scope 为准，未声明部分视为未知。'
        : '结果只来自本地缓存，没有执行互联网搜索，也不能据此断言这是最新信息。'];
      if (items.some(item => !item.publishedAt)) notice.push('部分来源没有发布时间，不能把收集或检索时间当作发布时间。');
      if (truncated) notice.push('结果受五条上限限制。');
      if (!items.length) notice.push('在所述范围内没有找到匹配来源。');
      return { name, query, scope, items, truncated, unknown: items.length === 0, notice };
    }

    const snapshot = await getState();
    checkAbort(signal);
    const safeSnapshot = snapshot && typeof snapshot === 'object' && !Array.isArray(snapshot) ? snapshot : {};
    const keys = Object.keys(STATE_SECTION_BUDGETS).filter(key => Object.hasOwn(safeSnapshot, key));
    const sections = keys.map(section => {
      const compact = compactStateSection(section, safeSnapshot[section]);
      return { section, ...compact };
    });
    const bounded = enforceStateBudget(sections);
    const { items, truncated } = bounded;
    const notice = [`这是角色 ${scopeRole} 在 ${asOf} 读取到的完整可用会话状态快照，包括当前活动、生活、关系、日程、待处理提醒、社交、兴趣和可选记录协议。`];
    if (truncated) notice.push('一个或多个状态分区受字符预算限制。');
    if (!items.length) notice.push('当前快照没有与查询对应的状态字段；未知细节不能据此推断。');
    return { name, query, scope: { roleId: scopeRole, readAt: asOf, evidence: 'current-session-snapshot', maxItemsChars: MAX_STATE_ITEMS_CHARS }, items, truncated, unknown: items.length === 0, notice };
  };
}
