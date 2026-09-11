import crypto from 'node:crypto';

export const WEIXIN_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com';
const TRUSTED_HOSTS = new Set(['ilinkai.weixin.qq.com']);
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const LOGIN_TIMEOUT_MS = 40_000;
const LONG_POLL_TIMEOUT_MS = 40_000;
const SEND_TIMEOUT_MS = 20_000;
const OFFICIAL_CHANNEL_VERSION = '2.4.9-beta.0';
const OFFICIAL_BOT_AGENT = 'OpenClaw';

function failure(message, code, status = 502, flags = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  Object.assign(error, flags);
  return error;
}
function invalid(message) { return failure(message, 'WEIXIN_INVALID_REQUEST', 400); }
function isPlainObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function requireString(value, name, max = 16384) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n]/.test(value)) throw invalid(`${name} is invalid`);
  return value.trim();
}
function requireText(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 12_000 || value.includes('\0')) throw invalid('text is invalid');
  return value;
}
function requireQrContent(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0')) throw failure('微信二维码响应格式无效。', 'WEIXIN_RESPONSE_INVALID');
  return value;
}
function trustedBaseUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw invalid('baseUrl is invalid');
  let url;
  try { url = new URL(value); } catch { throw invalid('baseUrl is invalid'); }
  if (url.protocol !== 'https:' || !TRUSTED_HOSTS.has(url.hostname) || url.username || url.password || url.port || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw invalid('baseUrl is not a trusted iLink endpoint');
  return url.origin;
}
function uin() { return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), 'utf8').toString('base64'); }
function messageFor(code) {
  if (code === 'WEIXIN_SESSION_EXPIRED') return '微信登录已过期，请重新连接。';
  if (code === 'WEIXIN_CONTEXT_EXPIRED') return '这段微信会话已过期，请等待对方发送新消息。';
  if (code === 'WEIXIN_RATE_LIMITED') return '微信请求过于频繁，请稍后再试。';
  return '微信服务暂时不可用，请稍后重试。';
}
function classifyBusiness(response, operation) {
  const ret = Number(response?.ret);
  const errcode = Number(response?.errcode);
  if ((Number.isFinite(ret) && ret !== 0) || (Number.isFinite(errcode) && errcode !== 0)) {
    const text = String(response?.errmsg ?? '').toLowerCase();
    let code = 'WEIXIN_API_FAILED';
    if (ret === -2 || errcode === -2 || /context.*(?:expired|invalid)|context_token/.test(text)) code = 'WEIXIN_CONTEXT_EXPIRED';
    else if (ret === -14 || errcode === -14 || /session.*(?:expired|timeout)|token.*(?:expired|invalid)/.test(text)) code = 'WEIXIN_SESSION_EXPIRED';
    else if (ret === 429 || errcode === 429 || /rate|frequen|too many|limit/.test(text)) code = 'WEIXIN_RATE_LIMITED';
    throw failure(messageFor(code), code, code === 'WEIXIN_RATE_LIMITED' ? 429 : code.includes('EXPIRED') ? 401 : 502, operation === 'send' ? { uncertain: false, ...(code === 'WEIXIN_RATE_LIMITED' ? { retryable: true } : {}) } : {});
  }
}
function normalizedLogin(response) {
  if (!isPlainObject(response) || typeof response.status !== 'string') throw failure('微信登录响应格式无效。', 'WEIXIN_RESPONSE_INVALID');
  const result = { status: response.status };
  for (const [source, target] of [['bot_token', 'botToken'], ['ilink_bot_id', 'botId'], ['ilink_user_id', 'userId'], ['redirect_host', 'redirectHost']]) {
    if (typeof response[source] === 'string' && response[source]) result[target] = response[source];
  }
  if (typeof response.baseurl === 'string' && response.baseurl) result.baseUrl = trustedBaseUrl(response.baseurl);
  if (response.status === 'need_verifycode') result.challenge = 'verify_code';
  if (response.status === 'confirmed') {
    if (!result.botToken || !result.botId) throw failure('微信登录响应缺少凭据。', 'WEIXIN_RESPONSE_INVALID');
    result.baseUrl ??= WEIXIN_ILINK_BASE_URL;
  }
  return result;
}

export class WeixinClient {
  constructor({ fetchImpl = globalThis.fetch, appId = 'bot', appClientVersion = '132105', longPollTimeoutMs = LONG_POLL_TIMEOUT_MS } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    this.fetchImpl = fetchImpl;
    this.appId = requireString(appId, 'appId', 128);
    this.appClientVersion = requireString(String(appClientVersion), 'appClientVersion', 32);
    this.longPollTimeoutMs = Number.isInteger(longPollTimeoutMs) && longPollTimeoutMs >= 1_000 && longPollTimeoutMs <= 120_000 ? longPollTimeoutMs : LONG_POLL_TIMEOUT_MS;
  }

  async startLogin({ signal } = {}) {
    const response = await this.#request({ baseUrl: WEIXIN_ILINK_BASE_URL, endpoint: 'ilink/bot/get_bot_qrcode?bot_type=3', method: 'POST', body: { local_token_list: [] }, signal, timeoutMs: LOGIN_TIMEOUT_MS });
    if (!isPlainObject(response)) throw failure('微信二维码响应格式无效。', 'WEIXIN_RESPONSE_INVALID');
    return { qrcode: requireString(response.qrcode, 'qrcode', 4096), qrcodeUrl: requireQrContent(response.qrcode_img_content) };
  }

  async pollLogin(qrcode, { signal } = {}) {
    qrcode = requireString(qrcode, 'qrcode');
    const endpoint = `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    const response = await this.#request({ baseUrl: WEIXIN_ILINK_BASE_URL, endpoint, method: 'GET', signal, timeoutMs: this.longPollTimeoutMs });
    return normalizedLogin(response);
  }

  async getUpdates({ token, baseUrl, cursor = '', signal } = {}) {
    token = requireString(token, 'token'); baseUrl = trustedBaseUrl(baseUrl);
    if (typeof cursor !== 'string' || cursor.length > 65536) throw invalid('cursor is invalid');
    const response = await this.#request({ baseUrl, endpoint: 'ilink/bot/getupdates', method: 'POST', token, body: { get_updates_buf: cursor, base_info: this.#baseInfo() }, signal, timeoutMs: this.longPollTimeoutMs, operation: 'updates' });
    classifyBusiness(response, 'updates');
    if (!isPlainObject(response) || (response.msgs !== undefined && !Array.isArray(response.msgs))) throw failure('微信消息响应格式无效。', 'WEIXIN_RESPONSE_INVALID');
    return { cursor: typeof response.get_updates_buf === 'string' ? response.get_updates_buf : cursor, messages: response.msgs ?? [] };
  }

  async sendText({ token, baseUrl, to, contextToken, text, clientId, signal } = {}) {
    token = requireString(token, 'token'); baseUrl = trustedBaseUrl(baseUrl); to = requireString(to, 'to'); contextToken = requireString(contextToken, 'contextToken'); text = requireText(text); clientId = requireString(clientId, 'clientId', 256);
    let response;
    try {
      response = await this.#request({ baseUrl, endpoint: 'ilink/bot/sendmessage', method: 'POST', token, body: { msg: { from_user_id: '', to_user_id: to, client_id: clientId, message_type: 2, message_state: 2, context_token: contextToken, item_list: [{ type: 1, text_item: { text } }] }, base_info: this.#baseInfo() }, signal, timeoutMs: SEND_TIMEOUT_MS, operation: 'send' });
    } catch (error) {
      if (error.code === 'WEIXIN_REQUEST_FAILED' || error.code === 'WEIXIN_TIMEOUT') error.uncertain = true;
      throw error;
    }
    classifyBusiness(response, 'send');
    if (!isPlainObject(response) || Number(response.ret) !== 0 || (response.message_id !== undefined && typeof response.message_id !== 'string' && typeof response.message_id !== 'number')) throw failure('微信发送响应格式无效。', 'WEIXIN_RESPONSE_INVALID', 502, { uncertain: true });
    return { messageId: response.message_id === undefined ? undefined : String(response.message_id), clientId };
  }

  async #request({ baseUrl, endpoint, method, body, token, signal, timeoutMs, operation }) {
    const url = new URL(endpoint, `${baseUrl}/`);
    const controller = new AbortController();
    const externalAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason); else signal?.addEventListener('abort', externalAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = { 'iLink-App-Id': this.appId, 'iLink-App-ClientVersion': this.appClientVersion };
    if (method === 'POST') Object.assign(headers, { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': uin() });
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      const response = await this.fetchImpl(url.toString(), { method, headers, ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal, redirect: 'manual' });
      if (!response || response.type === 'opaqueredirect' || response.status >= 300 && response.status < 400) throw failure('微信服务返回了不受信任的跳转。', 'WEIXIN_REDIRECT_REJECTED', 502, operation === 'send' ? { uncertain: true } : {});
      const raw = await this.#read(response);
      if (!response.ok) {
        const code = response.status === 401 || response.status === 403 ? 'WEIXIN_SESSION_EXPIRED' : response.status === 429 ? 'WEIXIN_RATE_LIMITED' : 'WEIXIN_HTTP_FAILED';
        throw failure(messageFor(code), code, response.status, operation === 'send' ? code === 'WEIXIN_RATE_LIMITED' ? { uncertain: false, retryable: true } : response.status >= 500 ? { uncertain: true } : {} : {});
      }
      try { return JSON.parse(raw); } catch { throw failure('微信服务返回格式无效。', 'WEIXIN_RESPONSE_INVALID'); }
    } catch (error) {
      if (error?.code?.startsWith?.('WEIXIN_')) {
        if (operation === 'send' && ['WEIXIN_RESPONSE_INVALID', 'WEIXIN_RESPONSE_TOO_LARGE'].includes(error.code)) error.uncertain = true;
        throw error;
      }
      if (controller.signal.aborted && !signal?.aborted) throw failure('微信请求超时。', 'WEIXIN_TIMEOUT', 504, operation === 'send' ? { uncertain: true } : {});
      if (signal?.aborted) throw failure('微信请求已取消。', 'WEIXIN_ABORTED', 499);
      throw failure('微信服务暂时无法连接。', 'WEIXIN_REQUEST_FAILED', 502, operation === 'send' ? { uncertain: true } : {});
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', externalAbort); }
  }

  async #read(response) {
    const length = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) throw failure('微信响应过大。', 'WEIXIN_RESPONSE_TOO_LARGE');
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) throw failure('微信响应过大。', 'WEIXIN_RESPONSE_TOO_LARGE');
    return text;
  }

  #baseInfo() { return { channel_version: OFFICIAL_CHANNEL_VERSION, bot_agent: OFFICIAL_BOT_AGENT }; }
}
