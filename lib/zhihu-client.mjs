import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { domainToASCII } from 'node:url';

const ORIGIN = 'https://developer.zhihu.com';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SEARCH_TIMEOUT_MS = 25_000;
const ANSWER_TIMEOUT_MS = 90_000;
const MODELS = new Set(['zhida-fast-1p5', 'zhida-thinking-1p5', 'zhida-agent']);

export const ZHIHU_DEFAULTS = Object.freeze({
  enabled: true,
  model: 'zhida-agent',
  dailyRequestLimit: 20,
  dailyAgentLimit: 4,
  topicsPerRun: 2,
  useHotList: true,
  useNewsSearch: true,
});

const SETTING_KEYS = new Set(Object.keys(ZHIHU_DEFAULTS));
const SAVE_KEYS = new Set([...SETTING_KEYS, 'accessSecret', 'clearKey']);

function clientError(message, code, status = 400) {
  const error = new Error(message); error.code = code; error.status = status; return error;
}
function invalid(message) { return clientError(message, 'INVALID_ZHIHU_CONFIG', 400); }
function requestFailure(message = '知乎接口暂时无法连接', code = 'ZHIHU_REQUEST_FAILED', status = 502) {
  return clientError(message, code, status);
}
function cleanText(value, limit) {
  if (typeof value !== 'string') return '';
  const withoutBlocks = value.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const withoutTags = withoutBlocks.replace(/<[^>]*>/g, ' ');
  const decoded = withoutTags.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (match, entity) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
    const number = entity[0] === '#' ? Number.parseInt(entity.slice(entity[1]?.toLowerCase() === 'x' ? 2 : 1), entity[1]?.toLowerCase() === 'x' ? 16 : 10) : NaN;
    try { return Number.isFinite(number) ? String.fromCodePoint(number) : match; } catch { return match; }
  });
  return decoded.replace(/\s+/g, ' ').trim().slice(0, limit);
}
function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    return url.toString();
  } catch { return null; }
}
function optionalNumber(value) { return typeof value === 'number' && Number.isFinite(value) ? value : undefined; }
function optionalInteger(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function publishedAt(value) {
  if (!Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value * 1000); return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}
function normalizedSearchItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const title = cleanText(item.Title, 1000); const url = safeUrl(item.Url);
  if (!title || !url) return null;
  const comments = Array.isArray(item.CommentInfoList)
    ? item.CommentInfoList.slice(0, 3).map((entry) => cleanText(entry?.Content, 500)).filter(Boolean)
    : [];
  const result = {
    title, url, summary: cleanText(item.ContentText, 6000),
    publishedAt: publishedAt(item.EditTime),
  };
  const author = cleanText(item.AuthorName, 300); if (author) result.author = author;
  const votes = optionalNumber(item.VoteUpCount); if (votes !== undefined) result.votes = votes;
  if (comments.length) result.comments = comments;
  const kind = cleanText(item.ContentType, 100); if (kind) result.kind = kind;
  const authority = cleanText(String(item.AuthorityLevel ?? ''), 100); if (authority) result.authority = authority;
  return result;
}
function normalizedHotItem(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const title = cleanText(item.Title, 1000); const url = safeUrl(item.Url);
  if (!title || !url) return null;
  return { title, url, summary: cleanText(item.Summary, 6000), publishedAt: null, kind: 'hot' };
}
function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw requestFailure('知乎接口返回格式无效', 'ZHIHU_RESPONSE_INVALID');
  return value;
}
function requireSuccess(value) {
  const data = requireObject(value);
  if (data.Code === 0) return data;
  if (data.Code === 20001) throw requestFailure('知乎接口鉴权失败，请检查 Access Secret', 'ZHIHU_AUTH_FAILED', 401);
  if (data.Code === 30001) throw requestFailure('知乎接口请求过于频繁，请稍后重试', 'ZHIHU_RATE_LIMITED', 429);
  throw requestFailure('知乎接口返回业务错误', 'ZHIHU_API_ERROR', 502);
}
function validateCount(value, maximum, name) {
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw invalid(`${name} 必须是 1 到 ${maximum} 的整数`);
}
function validateQuery(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 1000) throw invalid('搜索关键词必须是 1 到 1000 个字符');
  return value.trim();
}
function validatePrompt(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 20_000) throw invalid('直答问题必须是 1 到 20000 个字符');
  return value.trim();
}
function validateOptions(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('请求选项格式无效');
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw invalid('包含不支持的请求选项');
}
function validateHost(value) {
  if (typeof value !== 'string' || !value || value.length > 253 || /[/:@?#"'\\\s]/.test(value)) throw invalid('搜索站点必须是公共域名');
  let host;
  try { host = domainToASCII(value.toLowerCase().replace(/\.$/, '')); } catch { throw invalid('搜索站点必须是公共域名'); }
  if (!host || !host.includes('.') || host === 'localhost' || host === 'zhihu.com' || host.endsWith('.zhihu.com') ||
      !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host)) {
    throw invalid('搜索站点必须是公共域名');
  }
  return host;
}
function validateProxy(value) {
  if (!value) return null;
  try {
    const proxy = new URL(value);
    if (proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' || proxy.username || proxy.password ||
        (proxy.pathname && proxy.pathname !== '/') || proxy.search || proxy.hash) throw new Error();
    const port = Number(proxy.port || 80);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error();
    return { hostname: '127.0.0.1', port };
  } catch { throw clientError('知乎代理配置无效', 'ZHIHU_PROXY_INVALID', 503); }
}
function validateSettings(value) {
  for (const key of ['enabled', 'useHotList', 'useNewsSearch']) if (typeof value[key] !== 'boolean') throw invalid(`${key} 必须是布尔值`);
  if (!MODELS.has(value.model)) throw invalid('知乎模型选项无效');
  if (!Number.isInteger(value.dailyRequestLimit) || value.dailyRequestLimit < 1 || value.dailyRequestLimit > 100) throw invalid('dailyRequestLimit 必须是 1 到 100 的整数');
  if (!Number.isInteger(value.dailyAgentLimit) || value.dailyAgentLimit < 0 || value.dailyAgentLimit > 20 || value.dailyAgentLimit > value.dailyRequestLimit) throw invalid('dailyAgentLimit 必须是 0 到 20 且不超过每日总量的整数');
  if (!Number.isInteger(value.topicsPerRun) || value.topicsPerRun < 1 || value.topicsPerRun > 3) throw invalid('topicsPerRun 必须是 1 到 3 的整数');
}

async function readFetchBody(response, limit) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > limit) throw requestFailure('知乎接口响应过大', 'ZHIHU_RESPONSE_TOO_LARGE');
  if (!response.body) return Buffer.alloc(0);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    const buffer = Buffer.from(chunk); size += buffer.length;
    if (size > limit) throw requestFailure('知乎接口响应过大', 'ZHIHU_RESPONSE_TOO_LARGE');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function consumeNodeResponse(response, finish) {
  const chunks = []; let size = 0;
  const declared = Number(response.headers['content-length']);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    response.destroy(); finish(requestFailure('知乎接口响应过大', 'ZHIHU_RESPONSE_TOO_LARGE')); return;
  }
  response.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_RESPONSE_BYTES) { response.destroy(requestFailure('知乎接口响应过大', 'ZHIHU_RESPONSE_TOO_LARGE')); return; }
    chunks.push(chunk);
  });
  response.on('end', () => finish(null, { status: response.statusCode, body: Buffer.concat(chunks) }));
  response.on('error', (error) => finish(error?.code?.startsWith?.('ZHIHU_') ? error : requestFailure()));
}

function nodeTransport(url, { method, headers, body, timeoutMs, proxyValue }) {
  return new Promise((resolve, reject) => {
    let settled = false; let activeRequest; let activeSocket; let activeAgent;
    const cleanup = () => {
      activeRequest?.destroy();
      activeSocket?.destroy();
      activeAgent?.destroy();
      activeRequest = undefined; activeSocket = undefined; activeAgent = undefined;
    };
    const finish = (error, result) => {
      if (settled) return; settled = true; clearTimeout(timer);
      cleanup();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(requestFailure('知乎接口响应超时', 'ZHIHU_TIMEOUT', 504)), timeoutMs);
    const send = (agent = false) => {
      if (settled) {
        agent?.destroy?.(); activeSocket?.destroy();
        return;
      }
      if (agent) activeAgent = agent;
      const options = {
        protocol: 'https:', hostname: url.hostname, port: 443, method, path: `${url.pathname}${url.search}`,
        headers, agent,
      };
      let request;
      try {
        request = https.request(options, (response) => {
          if (settled) { response.destroy(); return; }
          consumeNodeResponse(response, finish);
        });
      }
      catch { finish(requestFailure()); return; }
      activeRequest = request;
      request.on('error', (error) => finish(error?.code?.startsWith?.('ZHIHU_') ? error : requestFailure()));
      if (settled) { request.destroy(); return; }
      try { if (body) request.write(body); request.end(); } catch { finish(requestFailure()); }
    };
    let proxy;
    try { proxy = validateProxy(proxyValue); } catch (error) { finish(error); return; }
    if (!proxy) { send(); return; }
    const connect = http.request({
      hostname: proxy.hostname, port: proxy.port, method: 'CONNECT', path: `${url.hostname}:443`,
      headers: { Host: `${url.hostname}:443` }, agent: false,
    });
    activeRequest = connect;
    connect.on('connect', (response, socket, head) => {
      if (settled) { socket.destroy(); return; }
      if (response.statusCode !== 200) { socket.destroy(); finish(requestFailure('知乎代理连接失败', 'ZHIHU_PROXY_FAILED')); return; }
      activeSocket = socket; if (head?.length) socket.unshift(head);
      const agent = new https.Agent({ keepAlive: false, maxSockets: 1 });
      agent.createConnection = (options, callback) => {
        if (settled) { socket.destroy(); return socket; }
        const secureSocket = tls.connect({ ...options, socket, servername: url.hostname, rejectUnauthorized: true }, callback);
        activeSocket = secureSocket;
        secureSocket.once('error', () => finish(requestFailure('知乎代理安全连接失败', 'ZHIHU_PROXY_FAILED')));
        return secureSocket;
      };
      send(agent);
    });
    connect.on('response', (response) => {
      if (settled) { response.destroy(); return; }
      response.resume(); finish(requestFailure('知乎代理连接失败', 'ZHIHU_PROXY_FAILED'));
    });
    connect.on('error', () => finish(requestFailure('知乎代理连接失败', 'ZHIHU_PROXY_FAILED')));
    connect.end();
  });
}

export class ZhihuClient {
  constructor({ dataDir, env = process.env, fetchImpl, clock = () => new Date(), onUsage }) {
    this.onUsage = onUsage;
    this.dataDir = path.resolve(dataDir); this.file = path.join(this.dataDir, 'zhihu.json');
    this.env = env; this.fetchImpl = fetchImpl; this.clock = clock;
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 }); fs.chmodSync(this.dataDir, 0o700);
  }
  readDisk() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw clientError('知乎配置文件无法读取', 'ZHIHU_CONFIG_INVALID', 500);
    }
  }
  effective() {
    const disk = this.readDisk();
    const settings = Object.fromEntries(Object.keys(ZHIHU_DEFAULTS).map((key) => [key, disk[key] ?? ZHIHU_DEFAULTS[key]]));
    const envSecret = typeof this.env.LIFE_ZHIHU_ACCESS_SECRET === 'string' && this.env.LIFE_ZHIHU_ACCESS_SECRET.trim() ? this.env.LIFE_ZHIHU_ACCESS_SECRET : '';
    const diskSecret = typeof disk.accessSecret === 'string' && disk.accessSecret.trim() ? disk.accessSecret : '';
    return { settings, accessSecret: envSecret || diskSecret, revision: Number.isSafeInteger(disk.revision) && disk.revision >= 0 ? disk.revision : 0, isEnvManaged: Boolean(envSecret) };
  }
  publicConfig() {
    const current = this.effective();
    return { ...current.settings, configured: Boolean(current.accessSecret), hasKey: Boolean(current.accessSecret), isEnvManaged: current.isEnvManaged, revision: current.revision };
  }
  settingsSnapshot() { return this.publicConfig(); }
  save(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalid('知乎配置格式无效');
    for (const key of Object.keys(patch)) if (!SAVE_KEYS.has(key)) throw invalid('包含不支持的知乎配置字段');
    if ('clearKey' in patch && typeof patch.clearKey !== 'boolean') throw invalid('clearKey 必须是布尔值');
    if ('accessSecret' in patch && typeof patch.accessSecret !== 'string') throw invalid('accessSecret 必须是字符串');
    if (typeof patch.accessSecret === 'string' && (patch.accessSecret.length > 4096 || /[\0\r\n]/.test(patch.accessSecret))) throw invalid('accessSecret 格式无效');
    const disk = this.readDisk(); const current = this.effective();
    const settings = { ...current.settings };
    for (const key of SETTING_KEYS) if (key in patch) settings[key] = patch[key];
    validateSettings(settings);
    const next = { ...settings, revision: current.revision + 1 };
    const priorSecret = typeof disk.accessSecret === 'string' ? disk.accessSecret : '';
    if (patch.clearKey === true) next.accessSecret = '';
    else if (typeof patch.accessSecret === 'string' && patch.accessSecret.trim()) next.accessSecret = patch.accessSecret.trim();
    else next.accessSecret = priorSecret;
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 }); fs.chmodSync(temporary, 0o600); fs.renameSync(temporary, this.file);
    } finally { try { fs.unlinkSync(temporary); } catch {} }
    return this.publicConfig();
  }
  async request(pathname, { method = 'GET', body, timeoutMs = SEARCH_TIMEOUT_MS } = {}) {
    const current = this.effective();
    if (!current.accessSecret) throw clientError('请先配置知乎 Access Secret', 'ZHIHU_NOT_CONFIGURED', 503);
    if (current.accessSecret.length > 4096 || /[\0\r\n]/.test(current.accessSecret)) throw clientError('知乎 Access Secret 配置无效', 'ZHIHU_CONFIG_INVALID', 503);
    const url = new URL(pathname, ORIGIN);
    if (url.origin !== ORIGIN) throw requestFailure('知乎请求地址无效', 'ZHIHU_ENDPOINT_INVALID');
    const at = this.clock(); const timestamp = Math.floor(new Date(at).valueOf() / 1000);
    if (!Number.isFinite(timestamp)) throw requestFailure('本地时间无效', 'ZHIHU_CLOCK_INVALID', 500);
    const headers = { Authorization: `Bearer ${current.accessSecret}`, 'X-Request-Timestamp': String(timestamp), 'Content-Type': 'application/json' };
    let response;
    if (this.fetchImpl) {
      const controller = new AbortController(); let timer;
      const operation = (async () => {
        let fetched;
        try { fetched = await this.fetchImpl(url.toString(), { method, headers, ...(body ? { body } : {}), redirect: 'manual', signal: controller.signal }); }
        catch (error) { if (error?.code?.startsWith?.('ZHIHU_')) throw error; throw requestFailure(); }
        if (fetched.status >= 300 && fetched.status < 400) { await fetched.body?.cancel?.().catch?.(() => {}); throw requestFailure('知乎接口拒绝重定向', 'ZHIHU_REDIRECT_REJECTED'); }
        if (!fetched.ok) { await fetched.body?.cancel?.().catch?.(() => {}); throw this.httpError(fetched.status); }
        return { status: fetched.status, body: await readFetchBody(fetched, MAX_RESPONSE_BYTES) };
      })();
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(requestFailure('知乎接口响应超时', 'ZHIHU_TIMEOUT', 504)); }, timeoutMs);
      });
      try { response = await Promise.race([operation, deadline]); }
      catch (error) { if (error?.code?.startsWith?.('ZHIHU_')) throw error; throw requestFailure(); }
      finally { clearTimeout(timer); }
    } else {
      response = await nodeTransport(url, { method, headers, body, timeoutMs, proxyValue: this.env.LIFE_ZHIHU_PROXY || this.env.LIFE_FEED_PROXY });
      if (response.status >= 300 && response.status < 400) throw requestFailure('知乎接口拒绝重定向', 'ZHIHU_REDIRECT_REJECTED');
      if (response.status < 200 || response.status >= 300) throw this.httpError(response.status);
    }
    try { return JSON.parse(response.body.toString('utf8')); }
    catch { throw requestFailure('知乎接口返回格式无效', 'ZHIHU_RESPONSE_INVALID'); }
  }
  httpError(status) {
    if (status === 401 || status === 403) return requestFailure('知乎接口鉴权失败，请检查 Access Secret', 'ZHIHU_AUTH_FAILED', status);
    if (status === 429) return requestFailure('知乎接口请求过于频繁，请稍后重试', 'ZHIHU_RATE_LIMITED', 429);
    return requestFailure('知乎接口请求失败', 'ZHIHU_HTTP_ERROR', 502);
  }
  async hotList(options = {}) {
    validateOptions(options, ['limit']); const { limit = 10 } = options;
    validateCount(limit, 30, 'limit');
    const value = requireSuccess(await this.request(`/api/v1/content/hot_list?${new URLSearchParams({ Limit: String(limit) })}`));
    if (!Array.isArray(value.Data?.Items)) throw requestFailure('知乎热榜返回格式无效', 'ZHIHU_RESPONSE_INVALID');
    return value.Data.Items.map(normalizedHotItem).filter(Boolean);
  }
  async search(query, options = {}) {
    validateOptions(options, ['count']); const { count = 5 } = options;
    validateCount(count, 10, 'count');
    const params = new URLSearchParams({ Query: validateQuery(query), Count: String(count) });
    const value = requireSuccess(await this.request(`/api/v1/content/zhihu_search?${params}`));
    if (!Array.isArray(value.Data?.Items)) throw requestFailure('知乎搜索返回格式无效', 'ZHIHU_RESPONSE_INVALID');
    return value.Data.Items.map(normalizedSearchItem).filter(Boolean);
  }
  async globalSearch(query, options = {}) {
    validateOptions(options, ['count', 'since', 'hosts']); const { count = 10, since, hosts } = options;
    validateCount(count, 20, 'count'); const params = new URLSearchParams({ Query: validateQuery(query), Count: String(count), SearchDB: 'realtime' });
    const filters = [];
    if (hosts !== undefined) {
      if (!Array.isArray(hosts) || hosts.length > 20) throw invalid('hosts 最多包含 20 个公共域名');
      const domains = [...new Set(hosts.map(validateHost))];
      if (domains.length) filters.push(domains.length === 1 ? `host=="${domains[0]}"` : `(${domains.map((host) => `host=="${host}"`).join(' OR ')})`);
    }
    if (since !== undefined) {
      if (!(since instanceof Date) && (typeof since !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(since))) throw invalid('since 必须是有效的 ISO 时间或 Date');
      const date = new Date(since);
      if (Number.isNaN(date.valueOf())) throw invalid('since 必须是有效的 ISO 时间或 Date');
      filters.push(`publish_time>=${Math.floor(date.valueOf() / 1000)}`);
    }
    if (filters.length) params.set('Filter', filters.join(' AND '));
    const value = requireSuccess(await this.request(`/api/v1/content/global_search?${params}`));
    if (!Array.isArray(value.Data?.Items)) throw requestFailure('知乎全网搜索返回格式无效', 'ZHIHU_RESPONSE_INVALID');
    return value.Data.Items.map(normalizedSearchItem).filter(Boolean);
  }
  async answer(prompt, options = {}) {
    validateOptions(options, ['model']); const { model } = options;
    const text = validatePrompt(prompt); const selectedModel = model ?? this.publicConfig().model;
    if (!MODELS.has(selectedModel)) throw invalid('知乎模型选项无效');
    const body = JSON.stringify({ model: selectedModel, messages: [{ role: 'user', content: text }], stream: false });
    let usage, status = 'failed'; const started = Date.now();
    try {
    const response = await this.request('/v1/chat/completions', { method: 'POST', body, timeoutMs: ANSWER_TIMEOUT_MS });
    const value = response && typeof response === 'object' && !Array.isArray(response) && Object.hasOwn(response, 'Code')
      ? requireSuccess(response)
      : requireObject(response);
    usage = value.usage;
    const answer = value.choices?.[0]?.message?.content;
    if (typeof answer !== 'string' || !answer.trim()) throw requestFailure('知乎直答没有返回有效内容', 'ZHIHU_RESPONSE_INVALID');
    if (answer.length > 24_000) throw requestFailure('知乎直答返回内容过长', 'ZHIHU_RESPONSE_TOO_LARGE');
    status = 'success'; return { text: answer.trim(), model: selectedModel };
    } finally {
      this.onUsage?.({ usage, provider: new URL(ORIGIN).hostname, model: selectedModel, purpose: 'research', status, durationMs: Date.now() - started });
    }
  }
  async quota() {
    const params = new URLSearchParams({ APIIDs: 'global_search,zhihu_search,hot_list,zhida_openai' });
    const value = requireSuccess(await this.request(`/api/v1/quota?${params}`));
    if (!Array.isArray(value.Data)) throw requestFailure('知乎额度返回格式无效', 'ZHIHU_RESPONSE_INVALID');
    return value.Data.filter((item) => item && typeof item === 'object').map((item) => ({
      id: cleanText(item.APIID, 100), name: cleanText(item.APIName, 200),
      total: optionalInteger(item.TotalQuota), used: optionalInteger(item.TotalUsed), remaining: optionalInteger(item.RemainingQuota),
    })).filter((item) => item.id);
  }
}
