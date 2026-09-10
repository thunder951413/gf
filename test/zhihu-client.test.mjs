import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ZhihuClient, ZHIHU_DEFAULTS } from '../lib/zhihu-client.mjs';

const fixedClock = () => new Date('2026-09-06T12:34:56.000Z');
function temporaryClient(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-zhihu-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return { dataDir, client: new ZhihuClient({ dataDir, env: { LIFE_ZHIHU_ACCESS_SECRET: 'test-secret', ...(options.env || {}) }, fetchImpl: options.fetchImpl, clock: options.clock || fixedClock }) };
}
const apiResponse = (data) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

test('configuration is strict, atomic, protected, revisioned, and never returns the secret', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-zhihu-config-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const client = new ZhihuClient({ dataDir, env: {}, clock: fixedClock });
  assert.deepEqual(client.publicConfig(), { ...ZHIHU_DEFAULTS, configured: false, hasKey: false, isEnvManaged: false, revision: 0 });
  const saved = client.save({ accessSecret: '  local-secret  ', model: 'zhida-fast-1p5', dailyRequestLimit: 8, dailyAgentLimit: 3, topicsPerRun: 1 });
  assert.equal(saved.configured, true); assert.equal(saved.revision, 1); assert.equal(saved.model, 'zhida-fast-1p5');
  assert.doesNotMatch(JSON.stringify(saved), /local-secret/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'zhihu.json'), 'utf8')).accessSecret, 'local-secret');
  assert.equal(fs.statSync(dataDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dataDir, 'zhihu.json')).mode & 0o777, 0o600);
  assert.equal(client.save({ accessSecret: '   ' }).revision, 2);
  assert.equal(client.publicConfig().hasKey, true);
  assert.equal(client.save({ clearKey: true }).configured, false);
  assert.equal(client.publicConfig().revision, 3);
  assert.equal(fs.readdirSync(dataDir).filter((name) => name.endsWith('.tmp')).length, 0);

  for (const patch of [
    null, [], { surprise: true }, { model: 'other' }, { dailyRequestLimit: 0 },
    { dailyRequestLimit: 2, dailyAgentLimit: 3 }, { topicsPerRun: 4 }, { accessSecret: 'x'.repeat(4097) },
    { accessSecret: 'valid\r\nX-Injected: true' }, { accessSecret: 'valid\0suffix' }, { clearKey: 'yes' },
  ]) assert.throws(() => client.save(patch), (error) => error.status === 400 && error.code === 'INVALID_ZHIHU_CONFIG');
});

test('environment secret overrides disk state without being exposed', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-zhihu-env-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const disk = new ZhihuClient({ dataDir, env: {} }); disk.save({ accessSecret: 'disk-secret' });
  const managed = new ZhihuClient({ dataDir, env: { LIFE_ZHIHU_ACCESS_SECRET: 'env-secret' } });
  const result = managed.publicConfig();
  assert.equal(result.configured, true); assert.equal(result.isEnvManaged, true); assert.equal(result.hasKey, true);
  assert.doesNotMatch(JSON.stringify(result), /disk-secret|env-secret/);
  assert.deepEqual(managed.settingsSnapshot(), result);
});

test('hot list and search use fixed official endpoints, required auth headers, and safe normalized data', async (t) => {
  const calls = [];
  const responses = [
    apiResponse({ Code: 0, Data: { Items: [
      { Title: '<b>热榜 &amp; 话题</b>', Url: 'https://www.zhihu.com/question/1?utm_source=openapi', Summary: '' },
      { Title: '危险项', Url: 'javascript:alert(1)', Summary: 'x' },
    ] } }),
    apiResponse({ Code: 0, Data: { Items: [{
      Title: '<em>RAG</em> 方法', ContentType: 'Article', ContentID: 'answer-1',
      ContentText: `<p>摘要 &lt;可信&gt;</p>${'长'.repeat(7000)}`, Url: 'https://zhuanlan.zhihu.com/p/1?utm_medium=openapi_platform&utm_source=trace',
      AuthorName: '<b>作者</b>', EditTime: 1710000000, VoteUpCount: 128, AuthorityLevel: '2',
      CommentInfoList: [{ Content: '<i>评论一</i>' }, { Content: '评'.repeat(600) }, { Content: '评论三' }, { Content: '评论四' }],
    }] } }),
  ];
  const { client } = temporaryClient(t, { fetchImpl: async (url, options) => { calls.push({ url, options }); return responses.shift(); } });
  const hot = await client.hotList({ limit: 10 });
  assert.deepEqual(hot, [{ title: '热榜 & 话题', url: 'https://www.zhihu.com/question/1?utm_source=openapi', summary: '', publishedAt: null, kind: 'hot' }]);
  const searched = await client.search('检索问题', { count: 5 });
  assert.equal(searched.length, 1); assert.equal(searched[0].summary.length, 6000); assert.equal(searched[0].comments.length, 3);
  assert.equal(searched[0].comments[1].length, 500); assert.equal(searched[0].publishedAt, '2024-03-09T16:00:00.000Z');
  assert.match(searched[0].url, /utm_medium=openapi_platform&utm_source=trace/);
  assert.equal(searched[0].author, '作者'); assert.equal(searched[0].votes, 128); assert.equal(searched[0].kind, 'Article');
  assert.equal(new URL(calls[0].url).origin, 'https://developer.zhihu.com');
  assert.equal(new URL(calls[0].url).pathname, '/api/v1/content/hot_list');
  assert.equal(new URL(calls[1].url).pathname, '/api/v1/content/zhihu_search');
  for (const call of calls) {
    assert.equal(call.options.headers.Authorization, 'Bearer test-secret');
    assert.equal(call.options.headers['X-Request-Timestamp'], '1788698096');
    assert.equal(call.options.headers['Content-Type'], 'application/json');
    assert.equal(call.options.redirect, 'manual'); assert.ok(call.options.signal instanceof AbortSignal);
  }
});

test('global search builds only validated host and publish-time filters', async (t) => {
  let captured;
  const { client } = temporaryClient(t, { fetchImpl: async (url) => { captured = new URL(url); return apiResponse({ Code: 0, Data: { Items: [] } }); } });
  await client.globalSearch('近期大事', { count: 20, since: new Date('2026-09-01T00:00:00.000Z'), hosts: ['News.Example.com', 'example.org', 'news.example.com'] });
  assert.equal(captured.origin, 'https://developer.zhihu.com'); assert.equal(captured.pathname, '/api/v1/content/global_search');
  assert.equal(captured.searchParams.get('SearchDB'), 'realtime'); assert.equal(captured.searchParams.get('Count'), '20');
  assert.equal(captured.searchParams.get('Filter'), '(host=="news.example.com" OR host=="example.org") AND publish_time>=1788220800');
  for (const options of [
    { hosts: ['example.com" OR publish_time>0'] }, { hosts: ['127.0.0.1'] }, { hosts: ['zhihu.com'] },
    { since: 1788220800000 }, { since: 'September 1, 2026' }, { count: 21 }, { filter: 'host=="evil.test"' },
  ]) await assert.rejects(client.globalSearch('话题', options), (error) => error.status === 400 && error.code === 'INVALID_ZHIHU_CONFIG');
  await client.globalSearch('无站点限制', { hosts: [] });
  assert.equal(captured.searchParams.has('Filter'), false);
});

test('answer sends only the documented body, maps business envelopes, and never returns reasoning content', async (t) => {
  let call; let response = apiResponse({ model: 'zhida-thinking-1p5', choices: [{ message: { reasoning_content: 'private chain', content: '公开回答' } }] });
  const { client } = temporaryClient(t, { fetchImpl: async (url, options) => {
    call = { url, options };
    return response;
  } });
  const answer = await client.answer('请研究这个公开话题', { model: 'zhida-thinking-1p5' });
  assert.deepEqual(answer, { text: '公开回答', model: 'zhida-thinking-1p5' });
  assert.equal(new URL(call.url).pathname, '/v1/chat/completions');
  assert.deepEqual(JSON.parse(call.options.body), { model: 'zhida-thinking-1p5', messages: [{ role: 'user', content: '请研究这个公开话题' }], stream: false });
  assert.doesNotMatch(JSON.stringify(answer), /private chain/);
  response = apiResponse({ Code: 20001, Message: 'upstream secret detail' });
  await assert.rejects(client.answer('问题'), (error) => error.code === 'ZHIHU_AUTH_FAILED' && error.status === 401 && !error.message.includes('secret'));
  response = apiResponse({ Code: 30001, Message: 'upstream throttle detail' });
  await assert.rejects(client.answer('问题'), (error) => error.code === 'ZHIHU_RATE_LIMITED' && error.status === 429 && !error.message.includes('throttle'));
  await assert.rejects(client.answer('问题', { model: 'not-a-model' }), (error) => error.status === 400);
  await assert.rejects(client.answer('问题', null), (error) => error.status === 400);
});

test('quota preserves zero and maps missing or invalid numbers to null', async (t) => {
  let requested;
  const { client } = temporaryClient(t, { fetchImpl: async (url) => {
    requested = new URL(url);
    return apiResponse({ Code: 0, Data: [
      { APIID: 'hot_list', APIName: '热榜', TotalQuota: 100, TotalUsed: 0, RemainingQuota: 100 },
      { APIID: 'zhida_openai', APIName: '直答', TotalQuota: '4', TotalUsed: null, RemainingQuota: -1 },
    ] });
  } });
  assert.deepEqual(await client.quota(), [
    { id: 'hot_list', name: '热榜', total: 100, used: 0, remaining: 100 },
    { id: 'zhida_openai', name: '直答', total: null, used: null, remaining: null },
  ]);
  assert.equal(requested.searchParams.get('APIIDs'), 'global_search,zhihu_search,hot_list,zhida_openai');
});

test('HTTP, redirect, business, schema, and transport failures are safe and redacted', async (t) => {
  const secret = 'do-not-leak';
  const cases = [
    { response: new Response(`upstream ${secret}`, { status: 401 }), code: 'ZHIHU_AUTH_FAILED' },
    { response: new Response(`upstream ${secret}`, { status: 429 }), code: 'ZHIHU_RATE_LIMITED' },
    { response: new Response('', { status: 302, headers: { location: `https://evil.test/?secret=${secret}` } }), code: 'ZHIHU_REDIRECT_REJECTED' },
    { response: apiResponse({ Code: 20001, Message: secret }), code: 'ZHIHU_AUTH_FAILED' },
    { response: apiResponse({ Code: 30001, Message: secret }), code: 'ZHIHU_RATE_LIMITED' },
    { response: apiResponse({ Code: 0, Data: { Items: null } }), code: 'ZHIHU_RESPONSE_INVALID' },
  ];
  for (const item of cases) {
    const { client } = temporaryClient(t, { env: { LIFE_ZHIHU_ACCESS_SECRET: secret }, fetchImpl: async () => item.response });
    await assert.rejects(client.hotList(), (error) => error.code === item.code && !error.message.includes(secret));
  }
  const { client } = temporaryClient(t, { env: { LIFE_ZHIHU_ACCESS_SECRET: secret }, fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error(secret)); } })) });
  await assert.rejects(client.hotList(), (error) => error.code === 'ZHIHU_REQUEST_FAILED' && !error.message.includes(secret));
});

test('successful response bodies are limited to 2MB', async (t) => {
  const { client } = temporaryClient(t, { fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200 }) });
  await assert.rejects(client.hotList(), (error) => error.code === 'ZHIHU_RESPONSE_TOO_LARGE' && error.status === 502);
});

test('transport deadline covers a response body that stalls after headers', async (t) => {
  const { client } = temporaryClient(t, { fetchImpl: async () => new Response(new ReadableStream({ start() {} }), { status: 200 }) });
  await assert.rejects(client.request('/api/v1/quota', { timeoutMs: 5 }), (error) => error.code === 'ZHIHU_TIMEOUT' && error.status === 504);
});

test('missing key prevents transport and all method options are validated', async (t) => {
  let calls = 0; const { dataDir } = temporaryClient(t);
  const client = new ZhihuClient({ dataDir, env: {}, fetchImpl: async () => { calls += 1; return apiResponse({}); } });
  await assert.rejects(client.quota(), (error) => error.code === 'ZHIHU_NOT_CONFIGURED' && error.status === 503);
  assert.equal(calls, 0);
  const configured = new ZhihuClient({ dataDir, env: { LIFE_ZHIHU_ACCESS_SECRET: 'key' }, fetchImpl: async () => apiResponse({}) });
  for (const call of [
    () => configured.hotList(null), () => configured.hotList({ limit: 31 }), () => configured.hotList({ unknown: true }),
    () => configured.search('', {}), () => configured.search('q', null), () => configured.search('q', { count: 11 }),
    () => configured.globalSearch('q', []), () => configured.answer('', {}),
  ]) await assert.rejects(call(), (error) => error.status === 400 && error.code === 'INVALID_ZHIHU_CONFIG');

  const invalidEnvironment = new ZhihuClient({ dataDir, env: { LIFE_ZHIHU_ACCESS_SECRET: 'key\r\ninjected' }, fetchImpl: async () => { calls += 1; return apiResponse({}); } });
  await assert.rejects(invalidEnvironment.quota(), (error) => error.code === 'ZHIHU_CONFIG_INVALID' && error.status === 503);
  assert.equal(calls, 0);
});

test('CONNECT proxy is restricted to credential-free 127.0.0.1 and never receives Authorization', async (t) => {
  let connectRequest;
  const proxy = http.createServer();
  proxy.on('connect', (request, socket) => {
    connectRequest = request;
    socket.end('HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n');
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => proxy.close(resolve)));
  const address = proxy.address();
  const { client } = temporaryClient(t, { fetchImpl: undefined, env: { LIFE_ZHIHU_PROXY: `http://127.0.0.1:${address.port}` } });
  await assert.rejects(client.quota(), (error) => error.code === 'ZHIHU_PROXY_FAILED');
  assert.equal(connectRequest.url, 'developer.zhihu.com:443');
  assert.equal(connectRequest.headers.authorization, undefined);
  assert.equal(connectRequest.headers.host, 'developer.zhihu.com:443');

  const invalid = temporaryClient(t, { fetchImpl: undefined, env: { LIFE_ZHIHU_PROXY: `http://user:pass@127.0.0.1:${address.port}` } }).client;
  await assert.rejects(invalid.quota(), (error) => error.code === 'ZHIHU_PROXY_INVALID' && !error.message.includes('user:pass'));
});

test('a proxy CONNECT arriving after the deadline cannot start TLS or send credentials and body', async (t) => {
  let connectRequest; let lateReplyAttempted = false; let tunnelBytes = 0;
  const sockets = new Set();
  const proxy = http.createServer();
  proxy.on('connection', (socket) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
  });
  proxy.on('connect', (request, socket) => {
    connectRequest = request;
    socket.on('data', (chunk) => { tunnelBytes += chunk.length; });
    setTimeout(() => {
      lateReplyAttempted = true;
      if (!socket.destroyed) socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    }, 70);
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => proxy.close(resolve));
  });
  const address = proxy.address();
  const { client } = temporaryClient(t, { fetchImpl: undefined, env: { LIFE_ZHIHU_PROXY: `http://127.0.0.1:${address.port}` } });
  await assert.rejects(client.request('/v1/chat/completions', {
    method: 'POST', body: '{"sentinel":"must-not-be-sent-after-timeout"}', timeoutMs: 20,
  }), (error) => error.code === 'ZHIHU_TIMEOUT' && error.status === 504);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(lateReplyAttempted, true);
  assert.equal(connectRequest.headers.authorization, undefined);
  assert.equal(tunnelBytes, 0);
});
