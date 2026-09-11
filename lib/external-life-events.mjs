import { createHash } from 'node:crypto';
import { companionSourceInternals, selectCompanionSources } from './companion-sources.mjs';

const { canonicalUrl, normalizedTitle } = companionSourceInternals;
const MAX_EVENTS = 3;
const EXCERPT_LIMIT = 420;

// These are interests that can plausibly stay at the level of reading about
// something.  They deliberately do not turn a report into a claimed outing,
// purchase, diagnosis, or other personal experience.
const LIFE_FRIENDLY = /(?:美食|餐厅|餐馆|烹饪|做饭|食谱|菜谱|咖啡|茶|甜品|宠物|猫|狗|穿搭|服装|时尚|家居|居家|收纳|音乐|歌曲|乐队|专辑|书籍|读书|阅读|小说|文学|书店|图书馆|电影|影片|影展|影院|艺术|绘画|摄影|展览|博物馆|本地|社区|城市生活|旅行|旅游|目的地|food|cook(?:ing)?|recipe|pet|cat|dog|style|fashion|home|music|book|bookstore|read(?:ing)?|film|movie|cinema|art|local|travel)/iu;
const HEADLINE_RISK = /(?:政治|选举|政府|外交|战争|军事|总统|议会|股市|股票|基金|债券|金融|经济数据|汇率|银行|投资|融资|医疗|医院|疾病|疫情|诊断|药物|治疗|politic(?:s|al)?|election|government|war|military|stock|finance|financial|market|bank|medical|health(?:care)?|hospital|disease|diagnos(?:is|tic)|treatment)/iu;

function clean(value, limit = Infinity) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim().slice(0, limit);
}

function summaryLead(item) {
  return clean(String(item?.summary ?? '').split(/\n|(?<=[。！？!?])/u)[0], EXCERPT_LIMIT);
}

function lifeHeadline(item) {
  const lead = clean([item?.title, item?.category, summaryLead(item)].filter(Boolean).join(' '), 1000);
  return Boolean(lead) && LIFE_FRIENDLY.test(lead) && !HEADLINE_RISK.test(lead);
}

function sourceExcerpt(item) {
  // This stays a literal, bounded copy of the supplied source summary. It is
  // provenance data, never instruction text used to compose an event detail.
  return clean(item?.summary, EXCERPT_LIMIT);
}

function canonicalPublishedAt(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function sourceId(url) {
  return `source-${createHash('sha256').update(url).digest('hex').slice(0, 16)}`;
}

function asEvent(item, url, contentId) {
  const title = clean(item.title, 100);
  return {
    id: sourceId(url),
    kind: 'article',
    title,
    location: null,
    participants: [],
    weight: 0.7,
    source: {
      contentId,
      title,
      url,
      source: clean(item.source ?? item.feedId, 80) || null,
      publishedAt: canonicalPublishedAt(item.publishedAt),
      excerpt: sourceExcerpt(item),
      scope: 'excerpt',
    },
    phases: [
      { id: 'browsing', label: '随手读到', detail: '读了这篇资料提供的摘录。', durationMs: 15 * 60 * 1000 },
      { id: 'recent', label: '最近读到', detail: '记得最近读过这篇资料的摘录，没有阅读全文。', durationMs: 71 * 60 * 60 * 1000 + 45 * 60 * 1000 },
    ],
  };
}

export function externalLifeCandidates(items, { now = new Date(), excludedIds = [] } = {}) {
  if (!Array.isArray(items)) return [];
  // Filter before the selector applies its limit: a busy general-news feed
  // must not crowd out otherwise valid reading material for everyday life.
  const lifeItems = items.filter((item) => {
    const contentId = clean(item?.id);
    const url = canonicalUrl(item?.url);
    return Boolean(contentId) && Boolean(url) && url.length <= 240 && lifeHeadline(item)
      && sourceExcerpt(item).length >= 60;
  });
  const selected = selectCompanionSources(lifeItems, {
    now,
    excludedIds,
    mode: 'proactive',
    limit: MAX_EVENTS,
  });
  const seenUrls = new Set();
  const seenTitles = new Set();
  const events = [];
  for (const item of selected) {
    const url = canonicalUrl(item?.url);
    const title = normalizedTitle(item?.title);
    const contentId = clean(item?.id);
    if (!contentId || !url || url.length > 240 || !title || sourceExcerpt(item).length < 60
      || seenUrls.has(url) || seenTitles.has(title)) continue;
    seenUrls.add(url);
    seenTitles.add(title);
    events.push(asEvent(item, url, contentId));
    if (events.length === MAX_EVENTS) break;
  }
  return events;
}
