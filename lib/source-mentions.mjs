import { companionSourceInternals } from './companion-sources.mjs';

const { canonicalUrl } = companionSourceInternals;

// A source title needs enough content to be an attribution, rather than a
// generic word that happens to occur in a conversational reply.
const MIN_SUBSTANTIVE_CHARS = 6;
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`，。！？；：、）】}]+/giu;
const SOURCE_SUFFIX = /\s*(?:[-–—]\s*(?:知乎(?:[｜|]\s*知乎观点)?|微信公众号|微信公众平台|澎湃新闻|新浪新闻|腾讯新闻|网易新闻|今日头条|凤凰网|人民网|新华网|BBC(?:\s+News)?|The\s+New\s+York\s+Times|NYTimes|Reuters|AP\s+News|Associated\s+Press|[\p{Letter}\p{Number}][\p{Letter}\p{Number}\s]{0,30}(?:新闻|资讯|观点|日报|周刊|网|报|媒体)))(?:\s*[｜|]\s*(?:知乎观点|观点|新闻|资讯))?\s*$/iu;
const TRAILING_PIPE_SUFFIX = /\s*[｜|]\s*(?:知乎观点|观点|新闻|资讯)\s*$/iu;
const DESCRIPTIVE_TITLE_PHRASES = /这座城市/gu;

function clean(value) {
  return String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

function compact(value) {
  return clean(value).toLocaleLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, '');
}

function substantive(value) {
  return compact(value).length >= MIN_SUBSTANTIVE_CHARS;
}

function titleVariants(value) {
  const title = clean(value);
  if (!title) return [];
  const stripped = title.replace(TRAILING_PIPE_SUFFIX, '').replace(SOURCE_SUFFIX, '').trim();
  const concise = stripped.replace(DESCRIPTIVE_TITLE_PHRASES, '');
  return [...new Set([title, stripped, concise].map(compact).filter(substantive))];
}

function urlsIn(text) {
  const urls = new Set();
  for (const raw of clean(text).match(URL_IN_TEXT) || []) {
    const url = canonicalUrl(raw);
    if (url) urls.add(url);
  }
  return urls;
}

function titleMentioned(text, variants) {
  const haystack = compact(text);
  return variants.some((title) => haystack.includes(title));
}

/**
 * Returns source items that the assistant explicitly attributes by URL or by a
 * sufficiently substantive article title.  It intentionally does no semantic
 * matching, so ordinary discussion of a subject cannot create an attribution.
 */
export function mentionedSources(text, items) {
  if (typeof text !== 'string' || !Array.isArray(items)) return [];
  const urls = urlsIn(text);
  return items.filter((item) => {
    const url = canonicalUrl(item?.url);
    if (url && urls.has(url)) return true;
    return titleMentioned(text, titleVariants(item?.title));
  });
}

export const sourceMentionInternals = { titleVariants, compact, urlsIn };
