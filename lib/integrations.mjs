import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { readFile } from 'node:fs/promises';

const MAX_FEED_BYTES = 2 * 1024 * 1024;
const FEED_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const MAX_AUDIO_BYTES = 30 * 1024 * 1024;
const MAX_TRANSCRIPTION_BYTES = 20 * 1024 * 1024;
const ENV_FILE = '/Users/surfing/tools/tts_generator_moss/.env.macos';
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function publicError(message) {
  return new Error(message);
}

function localName(name = '') {
  return name.split(':').at(-1).toLowerCase();
}

function decodeEntities(value) {
  const named = { amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"' };
  return String(value || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, entity) => {
    const lower = entity.toLowerCase();
    if (lower[0] === '#') {
      const code = lower[1] === 'x' ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
      if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return all; }
      }
      return all;
    }
    return named[lower] ?? all;
  });
}

function cleanText(value) {
  // XML decoding exposes HTML entities such as `&amp;lt;p&amp;gt;` in many Atom feeds.
  return decodeEntities(decodeEntities(String(value || '')))
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\s*(script|style|template)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseAttributes(source) {
  const attributes = {};
  const attribute = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  for (const match of source.matchAll(attribute)) {
    attributes[localName(match[1])] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

function parseXml(xml) {
  if (typeof xml !== 'string' || !xml.trim()) throw publicError('内容源返回了空的订阅内容');
  if (Buffer.byteLength(xml, 'utf8') > MAX_FEED_BYTES) throw publicError('订阅内容过大');

  const root = { name: '#root', local: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const token = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[^]*?\?>|<([^>]+)>|([^<]+)/g;
  let match;
  while ((match = token.exec(xml))) {
    if (match[1] !== undefined) {
      stack.at(-1).text += match[1];
      continue;
    }
    if (match[3] !== undefined) {
      stack.at(-1).text += match[3];
      continue;
    }
    if (match[2] === undefined) continue;
    const tag = match[2].trim();
    if (!tag || tag.startsWith('!') || tag.startsWith('?')) continue;
    if (tag.startsWith('/')) {
      const expected = localName(tag.slice(1).trim());
      if (stack.length === 1 || stack.at(-1).local !== expected) throw publicError('订阅 XML 格式无效');
      stack.pop();
      continue;
    }
    const selfClosing = /\/\s*$/.test(tag);
    const source = selfClosing ? tag.replace(/\/\s*$/, '') : tag;
    const name = source.match(/^([^\s/>]+)/)?.[1];
    if (!name) throw publicError('订阅 XML 格式无效');
    const node = { name, local: localName(name), attrs: parseAttributes(source.slice(name.length)), children: [], text: '' };
    stack.at(-1).children.push(node);
    if (!selfClosing) stack.push(node);
  }
  if (stack.length !== 1 || root.children.length !== 1) throw publicError('订阅 XML 格式无效');
  return root.children[0];
}

function nodeText(node) {
  return node.text + node.children.map(nodeText).join('');
}

function direct(node, ...names) {
  const wanted = new Set(names);
  return node.children.filter((child) => wanted.has(child.local));
}

function firstText(node, ...names) {
  for (const name of names) {
    const child = node.children.find((candidate) => candidate.local === name);
    if (child) return cleanText(nodeText(child));
  }
  return '';
}

function safeItemUrl(value, baseUrl) {
  if (!value) return null;
  try {
    const url = new URL(value.trim(), baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

function normalizedDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function parseRss(root, baseUrl) {
  const channel = direct(root, 'channel')[0];
  if (!channel) throw publicError('内容源不是有效的 RSS 订阅');
  const items = direct(channel, 'item').map((item) => ({
    title: firstText(item, 'title'),
    url: safeItemUrl(firstText(item, 'link', 'guid'), baseUrl),
    summary: firstText(item, 'description', 'summary', 'encoded', 'content'),
    publishedAt: normalizedDate(firstText(item, 'pubdate', 'published', 'date', 'updated')),
  }));
  return { title: firstText(channel, 'title'), items };
}

function atomLink(entry, baseUrl) {
  const links = direct(entry, 'link');
  const preferred = links.find((link) => !link.attrs.rel || link.attrs.rel.toLowerCase() === 'alternate') ?? links[0];
  return safeItemUrl(preferred?.attrs.href || '', baseUrl);
}

function parseAtom(root, baseUrl) {
  const items = direct(root, 'entry').map((entry) => ({
    title: firstText(entry, 'title'),
    url: atomLink(entry, baseUrl),
    summary: firstText(entry, 'summary', 'content'),
    publishedAt: normalizedDate(firstText(entry, 'published', 'updated')),
  }));
  return { title: firstText(root, 'title'), items };
}

/** Parse an RSS 2.0 or Atom feed without evaluating XML entities or HTML. */
export function parseFeed(xml, baseUrl) {
  let base;
  try { base = new URL(baseUrl); } catch { throw publicError('订阅地址无效'); }
  const root = parseXml(xml);
  if (root.local === 'rss') return parseRss(root, base);
  if (root.local === 'feed') return parseAtom(root, base);
  throw publicError('内容源不是 RSS 或 Atom 订阅');
}

function isPublicIpv4(address) {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = octets;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && (b === 0 || b === 168)) return false;
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return false;
  if (a === 203 && b === 0) return false;
  return true;
}

function isFakeProxyIpv4(address) {
  const octets = address.split('.').map(Number);
  return octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && octets[0] === 198 && (octets[1] === 18 || octets[1] === 19);
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const lower = address.toLowerCase().replace(/^\[|\]$/g, '');
  const parts = lower.includes('.')
    ? lower.replace(/:(\d+\.\d+\.\d+\.\d+)$/, (_, ipv4) => {
      const bytes = ipv4.split('.').map(Number);
      return `:${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
    }).split('::')
    : lower.split('::');
  const left = parts[0] ? parts[0].split(':').filter(Boolean) : [];
  const right = parts[1] ? parts[1].split(':').filter(Boolean) : [];
  if (parts.length > 2 || left.length + right.length > 8 || [...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return false;
  const groups = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  if (groups.length !== 8) return false;
  const number = groups.reduce((result, group) => (result << 16n) + BigInt(`0x${group}`), 0n);
  if (number === 0n || number === 1n || (number >> 120n) === 0xffn) return false;
  if ((number >> 121n) === 0x7en || (number >> 118n) === 0x3fan) return false; // ULA and link-local
  const high96 = number >> 32n;
  if (high96 === 0n || high96 === 0xffffn) {
    const ipv4 = [24n, 16n, 8n, 0n].map((shift) => Number((number >> shift) & 0xffn)).join('.');
    return isPublicIpv4(ipv4);
  }
  return true;
}

function safeRemoteUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw publicError('订阅地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || !url.hostname) throw publicError('订阅地址必须是公网 HTTP(S) 地址');
  return url;
}

function remainingTime(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw publicError('获取订阅超时');
  return remaining;
}

function beforeDeadline(promise, deadline, message = '获取订阅超时') {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timeout = setTimeout(() => reject(publicError(message)), remainingTime(deadline)); }),
  ]).finally(() => clearTimeout(timeout));
}

function proxyConfiguration() {
  /**
   * LIFE_FEED_PROXY is intentionally process configuration, never a feed/API option.
   * A loopback proxy is trusted to resolve only already-validated public hostnames when
   * this network substitutes the non-routable 198.18.0.0/15 fake-IP range. HTTPS still
   * sends CONNECT using the hostname and verifies the origin certificate end to end.
   */
  const raw = String(process.env.LIFE_FEED_PROXY || '').trim();
  if (!raw) return null;
  let proxy;
  try { proxy = new URL(raw); } catch { throw publicError('订阅代理地址无效'); }
  // A proxy is an explicit local trust boundary: it may resolve fake-IP names for us.
  if (proxy.protocol !== 'http:' || proxy.username || proxy.password || proxy.hostname !== '127.0.0.1' || proxy.pathname !== '/' || proxy.search || proxy.hash) {
    throw publicError('订阅代理地址无效');
  }
  return proxy;
}

function assertProxyTargetHost(url) {
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host) || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw publicError('订阅代理不能访问本机或私有网络');
  }
}

async function resolvePublic(url, lookup = dnsLookup, { allowFakeProxy = false, deadline } = {}) {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (allowFakeProxy) assertProxyTargetHost(url);
  const literalFamily = net.isIP(host);
  if (literalFamily) {
    if (!isPublicAddress(host)) throw publicError('订阅地址不能指向本机或私有网络');
    return { address: host, family: literalFamily };
  }
  let records;
  try {
    records = await beforeDeadline(lookup(host, { all: true, verbatim: true }), deadline);
  } catch (error) {
    if (error?.message === '获取订阅超时') throw error;
    throw publicError('无法解析订阅地址');
  }
  const allPublic = Array.isArray(records) && records.length > 0 && records.every((record) => record?.address && isPublicAddress(record.address));
  const allFake = Array.isArray(records) && records.length > 0 && records.every((record) => record?.family === 4 && isFakeProxyIpv4(record.address));
  if (!allPublic && !(allowFakeProxy && allFake)) {
    throw publicError('订阅地址不能指向本机或私有网络');
  }
  return { address: records[0].address, family: records[0].family || net.isIP(records[0].address) };
}

function readResponse(response, maxBytes) {
  return new Promise((resolve, reject) => {
    const declared = Number(response.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      response.destroy();
      reject(publicError('订阅内容过大'));
      return;
    }
    const chunks = [];
    let size = 0;
    response.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        response.destroy(publicError('订阅内容过大'));
        return;
      }
      chunks.push(chunk);
    });
    response.on('error', () => reject(publicError('读取上游响应失败')));
    response.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function feedHeaders(url) {
  return {
    Host: url.host,
    Accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.1',
  };
}

function webPageHeaders(url) {
  return {
    Host: url.host,
    Accept: 'text/html, application/xhtml+xml;q=0.9, */*;q=0.1',
    'User-Agent': 'Youjian/0.6 public-article-reader',
  };
}

function collectFeedResponse(createRequest, deadline, maxBytes) {
  return new Promise((resolve, reject) => {
    let request;
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      request?.destroy(publicError('获取订阅超时'));
      finish(reject, publicError('获取订阅超时'));
    }, remainingTime(deadline));
    request = createRequest((response) => {
      readResponse(response, maxBytes)
        .then((body) => finish(resolve, { statusCode: response.statusCode || 0, headers: response.headers, body }))
        .catch((error) => finish(reject, error));
    });
    request.on('error', () => finish(reject, publicError('无法获取订阅内容')));
    request.end();
  });
}

function requestFeed(url, pinned, deadline, maxBytes, _proxy, headers = feedHeaders(url)) {
  const transport = url.protocol === 'https:' ? https : http;
  return collectFeedResponse((onResponse) => transport.request({
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || undefined,
    path: `${url.pathname}${url.search}`,
    method: 'GET',
    headers,
    servername: url.hostname.replace(/^\[|\]$/g, ''),
    lookup(host, options, callback) {
      if (host.replace(/^\[|\]$/g, '').toLowerCase() !== url.hostname.replace(/^\[|\]$/g, '').toLowerCase()) {
        callback(publicError('订阅地址解析异常'));
        return;
      }
      const record = { address: pinned.address, family: pinned.family };
      if (options?.all) callback(null, [record]);
      else callback(null, record.address, record.family);
    },
  }, onResponse), deadline, maxBytes);
}

function requestHttpViaProxy(url, proxy, deadline, maxBytes, headers = feedHeaders(url)) {
  return collectFeedResponse((onResponse) => http.request({
    protocol: 'http:', hostname: proxy.hostname, port: proxy.port || 80, method: 'GET', path: url.href,
    headers,
  }, onResponse), deadline, maxBytes);
}

function requestHttpsViaProxy(url, proxy, deadline, maxBytes, headers = feedHeaders(url)) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let connectRequest;
    let upstreamRequest;
    let tunnel;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      connectRequest?.destroy(); upstreamRequest?.destroy(); tunnel?.destroy();
      finish(reject, publicError('获取订阅超时'));
    }, remainingTime(deadline));
    const targetHost = url.hostname.replace(/^\[|\]$/g, '');
    connectRequest = http.request({
      protocol: 'http:', hostname: proxy.hostname, port: proxy.port || 80, method: 'CONNECT',
      path: `${targetHost}:${url.port || 443}`, headers: { Host: `${targetHost}:${url.port || 443}` },
    });
    connectRequest.on('connect', (response, socket, head) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        finish(reject, publicError('订阅代理连接失败'));
        return;
      }
      if (head?.length) socket.unshift(head);
      tunnel = tls.connect({ socket, servername: targetHost, rejectUnauthorized: true });
      tunnel.once('error', () => finish(reject, publicError('无法获取订阅内容')));
      tunnel.once('secureConnect', () => {
        upstreamRequest = https.request({
          protocol: 'https:', hostname: targetHost, port: url.port || 443, path: `${url.pathname}${url.search}`,
          // With agent:false Node creates a new default Agent and ignores this
          // supplied connection. Omit agent so HTTPS uses the verified tunnel.
          method: 'GET', headers, servername: targetHost,
          createConnection: () => tunnel,
        }, (response) => {
          readResponse(response, maxBytes)
            .then((body) => finish(resolve, { statusCode: response.statusCode || 0, headers: response.headers, body }))
            .catch((error) => finish(reject, error));
        });
        upstreamRequest.on('error', () => finish(reject, publicError('无法获取订阅内容')));
        upstreamRequest.end();
      });
    });
    connectRequest.on('error', () => finish(reject, publicError('订阅代理不可用')));
    connectRequest.end();
  });
}

function requestFeedViaProxy(url, _pinned, deadline, maxBytes, proxy, headers = feedHeaders(url)) {
  return url.protocol === 'https:'
    ? requestHttpsViaProxy(url, proxy, deadline, maxBytes, headers)
    : requestHttpViaProxy(url, proxy, deadline, maxBytes, headers);
}

/** Fetch a public RSS/Atom feed. Optional dependencies are test-only injection points. */
export async function fetchFeed(value, options = {}) {
  let url = safeRemoteUrl(value);
  const deadline = Date.now() + (options.timeoutMs ?? FEED_TIMEOUT_MS);
  const lookup = options.lookup ?? dnsLookup;
  const proxy = proxyConfiguration();
  const transport = options.transport ?? (proxy ? requestFeedViaProxy : requestFeed);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    remainingTime(deadline);
    const pinned = await resolvePublic(url, lookup, { allowFakeProxy: Boolean(proxy), deadline });
    let response;
    try { response = await transport(url, pinned, deadline, MAX_FEED_BYTES, proxy); }
    catch (error) { throw error?.message?.startsWith('订阅') || error?.message?.startsWith('获取') ? error : publicError('无法获取订阅内容'); }
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = Array.isArray(response.headers?.location) ? response.headers.location[0] : response.headers?.location;
      if (!location || redirects === MAX_REDIRECTS) throw publicError('订阅重定向无效');
      try { url = safeRemoteUrl(new URL(location, url).href); } catch { throw publicError('订阅重定向无效'); }
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) throw publicError('内容源请求失败');
    const type = String(response.headers?.['content-type'] || '').toLowerCase();
    if (type.startsWith('text/html')) throw publicError('内容源返回的不是订阅');
    if (!response.body || response.body.length > MAX_FEED_BYTES) throw publicError('订阅内容过大');
    try { return parseFeed(Buffer.from(response.body).toString('utf8'), url.href); }
    catch (error) { throw error?.message?.startsWith('订阅') || error?.message?.startsWith('内容源') ? error : publicError('订阅内容无法解析'); }
  }
  throw publicError('订阅重定向无效');
}

function articleText(html) {
  return decodeEntities(String(html || ''))
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\s*(script|style|template|noscript|svg|canvas|form|button|nav|aside|footer|header|dialog)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*\/\s*(?:p|div|section|article|main|h[1-6]|li|blockquote|pre)\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[\t \f\v]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function jsonLdArticle(html) {
  for (const match of String(html).matchAll(/<script\b[^>]*type\s*=\s*(?:["']application\/ld\+json["']|application\/ld\+json)[^>]*>([\s\S]*?)<\/script\s*>/gi)) {
    let value;
    try { value = JSON.parse(decodeEntities(match[1]).trim()); } catch { continue; }
    const queue = [value];
    while (queue.length) {
      const entry = queue.shift();
      if (Array.isArray(entry)) { queue.push(...entry); continue; }
      if (!entry || typeof entry !== 'object') continue;
      if (typeof entry.articleBody === 'string' && articleText(entry.articleBody).length >= 200) {
        return { text: articleText(entry.articleBody), title: articleText(entry.headline || entry.name || '') };
      }
      if (entry['@graph']) queue.push(entry['@graph']);
    }
  }
  return null;
}

function metaContent(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const first = new RegExp(`<meta\\b[^>]*(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*content\\s*=\\s*(["'])([\\s\\S]*?)\\1[^>]*>`, 'i').exec(html);
  const reverse = new RegExp(`<meta\\b[^>]*content\\s*=\\s*(["'])([\\s\\S]*?)\\1[^>]*(?:property|name)\\s*=\\s*["']${escaped}["'][^>]*>`, 'i').exec(html);
  return decodeEntities((first || reverse)?.[2] || '').trim();
}

function parseArticleHtml(html) {
  const source = String(html || '');
  const structured = jsonLdArticle(source);
  let selected = '';
  for (const tag of ['article', 'main']) {
    const regions = [...source.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'gi'))].map((match) => match[1]);
    const candidate = articleText(regions.join('\n'));
    if (candidate.length > selected.length) selected = candidate;
  }
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(source)?.[1] || source;
  const fallback = articleText(body);
  const text = (structured?.text && structured.text.length >= selected.length ? structured.text : selected || fallback)
    .slice(0, 24_000).trim();
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source)?.[1] || '';
  const title = (structured?.title || metaContent(source, 'og:title') || articleText(titleTag)).slice(0, 500).trim();
  return { text, title };
}

function unusableArticle(text, title) {
  if (text.length < 200) return true;
  const sample = `${title}\n${text.slice(0, 1800)}`.toLowerCase();
  const wall = /(captcha|verify you are human|enable javascript|sign in to continue|log in to continue|subscribe to continue|subscription required|access denied|人机验证|安全验证|登录后(?:查看|阅读)|请先登录|订阅后阅读|付费阅读|会员专享)/i.test(sample);
  return wall;
}

/**
 * Fetch a public article using the feed fetcher's DNS pinning, redirect checks,
 * byte bound and total deadline. Returned text is an extracted excerpt, never a
 * guarantee that the complete article was available.
 */
export async function fetchArticle(value, options = {}) {
  let url = safeRemoteUrl(value);
  const deadline = Date.now() + (options.timeoutMs ?? FEED_TIMEOUT_MS);
  const lookup = options.lookup ?? dnsLookup;
  const proxy = proxyConfiguration();
  const transport = options.transport ?? (proxy ? requestFeedViaProxy : requestFeed);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    remainingTime(deadline);
    const pinned = await resolvePublic(url, lookup, { allowFakeProxy: Boolean(proxy), deadline });
    let response;
    try { response = await transport(url, pinned, deadline, MAX_FEED_BYTES, proxy, webPageHeaders(url)); }
    catch (error) { throw /(超时|私有网络|内容过大|代理|地址)/.test(error?.message || '') ? error : publicError('无法获取文章内容'); }
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = Array.isArray(response.headers?.location) ? response.headers.location[0] : response.headers?.location;
      if (!location || redirects === MAX_REDIRECTS) throw publicError('文章重定向无效');
      try { url = safeRemoteUrl(new URL(location, url).href); } catch { throw publicError('文章重定向无效'); }
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) throw publicError('文章请求失败');
    const type = String(response.headers?.['content-type'] || '').toLowerCase();
    if (type && !type.includes('text/html') && !type.includes('application/xhtml+xml')) throw publicError('页面不是可读取的文章');
    if (!response.body || response.body.length > MAX_FEED_BYTES) throw publicError('文章内容过大');
    const parsed = parseArticleHtml(Buffer.from(response.body).toString('utf8'));
    if (unusableArticle(parsed.text, parsed.title)) throw publicError('页面没有可用的公开文章正文');
    return { text: parsed.text, url: url.href, ...(parsed.title ? { title: parsed.title } : {}), extracted: true };
  }
  throw publicError('文章重定向无效');
}

export const SINA_HOT_URL = 'https://sinanews.sina.cn/h5/top_news_list.d.html';

export function parseSinaHotTopics(html, at = new Date()) {
  // The public page embeds its displayed list as JSON. Never execute its scripts.
  const scripts = String(html).matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi);
  let data;
  for (const match of scripts) {
    const assignment = match[1].trim().match(/^(?:window\.)?SM\s*=\s*(\{[\s\S]*\})\s*;?\s*$/);
    if (!assignment) continue;
    try { data = JSON.parse(assignment[1]); } catch { throw publicError('新浪热榜的数据格式已变化'); }
    break;
  }
  const items = data?.data?.data?.hotList;
  if (!Array.isArray(items)) throw publicError('新浪热榜的数据格式已变化');
  const responseTime = Number(data?.data?.resTime);
  if (!Number.isFinite(responseTime) || Math.abs(at.valueOf() - responseTime) > 6 * 3600_000) throw publicError('新浪热榜返回了过期数据');
  const seen = new Set();
  return { observedAt: new Date(responseTime).toISOString(), items: items.slice(0, 50).flatMap(item => {
    const title = String(item.info?.title || '').trim().slice(0, 300);
    let url; try { url = new URL(item.base?.base?.url); } catch { return []; }
    if (!title || seen.has(title) || url.protocol !== 'https:' || !['so.sina.cn', 'news.sina.cn', 'sinanews.sina.cn', 'news.sina.com.cn'].includes(url.hostname) || url.username || url.password) return [];
    seen.add(title); return [{ title, url: url.href, source: '新浪热榜', summary: '', publishedAt: null, observedAt: new Date(responseTime).toISOString() }];
  }) };
}

export async function fetchSinaHotTopics(options = {}) {
  const url = new URL(SINA_HOT_URL), deadline = Date.now() + (options.timeoutMs ?? 20_000);
  const proxy = proxyConfiguration(), lookup = options.lookup ?? dnsLookup;
  const pinned = await resolvePublic(url, lookup, { allowFakeProxy: Boolean(proxy), deadline });
  const transport = options.transport ?? (proxy ? requestFeedViaProxy : requestFeed);
  const response = await transport(url, pinned, deadline, MAX_FEED_BYTES, proxy);
  if (response.statusCode !== 200) throw publicError('新浪热榜暂时无法读取');
  if (!response.body || response.body.length > MAX_FEED_BYTES) throw publicError('新浪热榜内容过大');
  return parseSinaHotTopics(Buffer.from(response.body).toString('utf8'), options.clock?.() || new Date());
}

async function readPassword(env = process.env, envFile = ENV_FILE) {
  const password = String(env.QWEN_TTS_ACCESS_PASSWORD || '').trim();
  if (password) return password;
  try {
    const content = await readFile(envFile, 'utf8');
    for (const raw of content.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const match = line.match(/^QWEN_TTS_ACCESS_PASSWORD\s*=\s*(.*)$/);
      if (match) {
        const value = match[1].trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
        return value;
      }
    }
  } catch { /* An unset local password is valid for an unauthenticated service. */ }
  return '';
}

function serviceUrl(path, options = {}) {
  const raw = options.baseUrl ?? process.env.LIFE_TTS_BASE_URL ?? 'http://127.0.0.1:7866';
  let base;
  try { base = new URL(raw); } catch { throw publicError('语音服务地址无效'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) throw publicError('语音服务地址无效');
  return new URL(path, base.href.endsWith('/') ? base.href : `${base.href}/`);
}

async function serviceFetch(path, init = {}, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  const timeout = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
  const password = await readPassword(options.env, options.envFile);
  const headers = new Headers(init.headers || {});
  headers.set('Accept', init.accept ?? 'application/json');
  if (password) headers.set('Authorization', `Bearer ${password}`);
  try {
    const { accept: _accept, ...requestInit } = init;
    const response = await fetchImpl(serviceUrl(path, options), { ...requestInit, headers, signal: controller.signal });
    return { response, deadline, finish: () => clearTimeout(timeout) };
  } catch {
    clearTimeout(timeout);
    throw publicError('语音服务不可用');
  }
}

function checkedJobId(jobId) {
  if (typeof jobId !== 'string' || !JOB_ID.test(jobId)) throw publicError('语音任务标识无效');
  return jobId;
}

async function readServiceBytes(request, maxBytes, failure) {
  const { response, deadline } = request;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    request.finish();
    throw publicError('语音服务响应过大');
  }
  const reader = response.body?.getReader();
  if (!reader) {
    request.finish();
    throw publicError(failure);
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel();
  }, Math.max(1, deadline - Date.now()));
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        void reader.cancel();
        throw publicError('语音服务响应过大');
      }
      chunks.push(Buffer.from(value));
    }
    if (timedOut) throw publicError('语音服务响应超时');
    return Buffer.concat(chunks);
  } catch (error) {
    if (error?.message?.startsWith('语音服务')) throw error;
    throw publicError(timedOut ? '语音服务响应超时' : failure);
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
    request.finish();
  }
}

async function responseJson(request, failure) {
  if (!request.response.ok) {
    request.finish();
    throw publicError(failure);
  }
  try { return JSON.parse((await readServiceBytes(request, 1024 * 1024, failure)).toString('utf8')); }
  catch (error) {
    if (error?.message?.startsWith('语音服务')) throw error;
    throw publicError('语音服务返回无效数据');
  }
}

function sttStatus(value) {
  return {
    available: Boolean(value?.available ?? value?.ready),
    state: String(value?.state || (value?.available || value?.ready ? 'ready' : 'unavailable')),
  };
}

/** Read-only health probe. It never starts or stops either local runtime. */
export async function probeTts(options = {}) {
  try {
    const request = await serviceFetch('/api/health', {}, options);
    const payload = await responseJson(request, '语音服务不可用');
    const available = request.response.ok && payload.tts_enabled !== false && payload.available !== false;
    return { available, state: String(payload.state || (available ? 'ready' : 'unavailable')), stt: sttStatus(payload.stt) };
  } catch (error) {
    return { available: false, state: 'unavailable', stt: { available: false, state: 'unavailable' }, error: error?.message || '语音服务不可用' };
  }
}

export async function startSpeech(text, options = {}) {
  if (typeof text !== 'string' || !text.trim()) throw publicError('朗读内容不能为空');
  if (text.length > 6_000) throw publicError('朗读内容过长');
  const body = new URLSearchParams({ text: text.trim(), streaming_generation: '0', ephemeral_audio: '1', use_service_settings: '1' });
  if (options.voice) {
    const voice=options.voice, settings=options.settings||{};
    if (!voice.referencePath || typeof voice.referencePath !== 'string') throw publicError('所选音色没有参考音频');
    body.set('use_service_settings','0'); body.set('voice_name',voice.name); body.set('example_audio_path',voice.referencePath);
    for(const [key,field] of Object.entries({model_profile:'model_profile',qwen_max_new_tokens:'max_new_tokens',qwen_chunk_size:'codec_chunk_frames',qwen_seed:'seed',qwen_temperature:'temperature',qwen_top_p:'top_p',qwen_top_k:'top_k',qwen_repetition_penalty:'repetition_penalty',qwen_non_streaming_mode:'qwen_non_streaming_mode',qwen_append_silence:'qwen_append_silence',qwen_min_new_tokens:'qwen_min_new_tokens'})) if(settings[key]!==undefined) body.set(field,typeof settings[key]==='boolean' ? settings[key]?'1':'0' : String(settings[key]));
    body.set('qwen_clone_mode',voice.transcript && settings.qwen_clone_mode==='icl'?'icl':'xvec');
    body.set('qwen_reference_text',voice.transcript||'');
  }
  const request = await serviceFetch('/api/generate-stream/start', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, options);
  const payload = await responseJson(request, '语音生成服务不可用');
  return { jobId: checkedJobId(String(payload.job_id || '')) };
}

export async function readSpeechStatus(jobId, options = {}) {
  const id = checkedJobId(jobId);
  const request = await serviceFetch(`/api/generate-stream/${encodeURIComponent(id)}/status`, {}, options);
  const payload = await responseJson(request, '无法读取语音任务状态');
  const state = String(payload.state || 'unknown');
  return state === 'error' ? { state, error: '语音生成失败' } : { state };
}

export async function getSpeechAudio(jobId, options = {}) {
  const id = checkedJobId(jobId);
  const request = await serviceFetch(`/api/generate-stream/${encodeURIComponent(id)}/result-audio`, { accept: 'audio/*' }, options);
  if (!request.response.ok) {
    request.finish();
    throw publicError('语音音频暂不可用');
  }
  const body = await readServiceBytes(request, MAX_AUDIO_BYTES, '语音音频不可用');
  const supplied = request.response.headers.get('content-type') || '';
  const contentType = /^audio\/[a-z0-9.+-]+(?:\s*;.*)?$/i.test(supplied) ? supplied : 'audio/wav';
  return { body, contentType };
}

export async function closeSpeech(jobId, options = {}) {
  const id = checkedJobId(jobId);
  const request = await serviceFetch(`/api/generate-stream/${encodeURIComponent(id)}/close`, { method: 'POST' }, options);
  request.finish();
  if (!request.response.ok) throw publicError('无法关闭语音任务');
  return { ok: true };
}

function audioFilename(contentType) {
  if (/^audio\/(wav|x-wav)/i.test(contentType)) return 'recording.wav';
  if (/^audio\/mp4/i.test(contentType)) return 'recording.mp4';
  if (/^audio\/ogg/i.test(contentType)) return 'recording.ogg';
  return 'recording.webm';
}

export async function transcribeAudio(buffer, contentType, options = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw publicError('录音内容不能为空');
  if (buffer.length > MAX_TRANSCRIPTION_BYTES) throw publicError('录音文件不能超过 20MB');
  if (!/^audio\/(webm|wav|x-wav|mp4|ogg)(?:\s*;.*)?$/i.test(String(contentType || ''))) throw publicError('不支持的录音格式');
  const form = new FormData();
  form.set('file', new Blob([buffer], { type: contentType }), audioFilename(contentType));
  form.set('language', 'zh');
  form.set('response_format', 'json');
  const request = await serviceFetch('/v1/audio/transcriptions', { method: 'POST', body: form }, options);
  const payload = await responseJson(request, '语音转写服务不可用');
  if (typeof payload.text !== 'string') throw publicError('语音转写服务返回无效数据');
  return { text: payload.text.trim() };
}

/** Read available reference voices and current synthesis parameters without changing the service. */
export async function listSpeechVoices(options = {}) {
  const [catalog, active] = await Promise.all([
    serviceFetch('/api/voices', {}, options).then(request => responseJson(request, '无法读取音色列表')),
    serviceFetch('/api/service-settings', {}, options).then(request => responseJson(request, '无法读取语音设置')),
  ]);
  const voices=(Array.isArray(catalog.voices)?catalog.voices:[]).filter(v=>v && typeof v.id==='string' && typeof(v.audio_path||v.path)==='string').slice(0,500).map(v=>({id:v.id,name:String(v.name||v.id).slice(0,160),description:String(v.description||'').slice(0,500),language:String(v.language||'Chinese'),referencePath:v.audio_path||v.path,transcript:String(v.transcript||'').slice(0,12000)}));
  return {voices,settings:active.settings||{}};
}
