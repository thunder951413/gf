import assert from 'node:assert/strict';
import http from 'node:http';
import { after, test } from 'node:test';
import { closeSpeech, fetchFeed, getSpeechAudio, parseFeed, probeTts, readSpeechStatus, startSpeech, transcribeAudio } from '../lib/integrations.mjs';

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Example</title><item><title><![CDATA[<b>标题</b>]]></title><link>/post?a=1&amp;b=2</link><description><![CDATA[<p>来源 <strong>摘要</strong><script>bad()</script></p>]]></description><pubDate>Tue, 02 Jan 2024 03:04:05 GMT</pubDate></item><item><title>Bad</title><link>javascript:alert(1)</link><description>plain</description><pubDate>not a date</pubDate></item></channel></rss>`;

test('parseFeed handles RSS CDATA, HTML, dates, relative links, and unsafe item links', () => {
  const result = parseFeed(RSS, 'https://feeds.example/news.xml');
  assert.equal(result.title, 'Example');
  assert.deepEqual(result.items[0], {
    title: '标题', url: 'https://feeds.example/post?a=1&b=2', summary: '来源 摘要', publishedAt: '2024-01-02T03:04:05.000Z',
  });
  assert.equal(result.items[1].url, null);
  assert.equal(result.items[1].publishedAt, null);
});

test('parseFeed supports Atom namespaces and alternate links', () => {
  const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><entry><title>A</title><link rel="self" href="/self"/><link rel="alternate" href="https://article.example/a"/><summary>&lt;p&gt;Safe &amp;amp; clear&lt;/p&gt;</summary><updated>2025-05-06T01:02:03Z</updated></entry></feed>`;
  const result = parseFeed(xml, 'https://feed.example/root');
  assert.equal(result.items[0].url, 'https://article.example/a');
  assert.equal(result.items[0].summary, 'Safe & clear');
  assert.equal(result.items[0].publishedAt, '2025-05-06T01:02:03.000Z');
});

test('parseFeed rejects malformed XML and non-feed documents', () => {
  assert.throws(() => parseFeed('<rss><channel></rss>', 'https://feed.example'), /XML/);
  assert.throws(() => parseFeed('<html><body>x</body></html>', 'https://feed.example'), /RSS 或 Atom/);
});

test('fetchFeed rejects loopback, private IPv4, and IPv6 before transport', async () => {
  for (const url of ['http://127.0.0.1/rss', 'http://10.1.2.3/rss', 'http://192.168.1.3/rss', 'http://[::1]/rss', 'http://[::ffff:127.0.0.1]/rss', 'http://[fc00::1]/rss', 'http://[fe80::1]/rss']) {
    await assert.rejects(fetchFeed(url), /本机或私有网络/);
  }
});

test('fetchFeed validates DNS results and every redirect before parsing', async () => {
  const calls = [];
  const lookup = async (host) => {
    calls.push(`dns:${host}`);
    return [{ address: host === 'origin.example' ? '93.184.216.34' : '8.8.8.8', family: 4 }];
  };
  const transport = async (url, pinned) => {
    calls.push(`${url.hostname}:${pinned.address}`);
    if (url.hostname === 'origin.example') return { statusCode: 302, headers: { location: 'https://final.example/feed' }, body: Buffer.alloc(0) };
    return { statusCode: 200, headers: { 'content-type': 'application/rss+xml' }, body: Buffer.from(RSS) };
  };
  const result = await fetchFeed('https://origin.example/feed', { lookup, transport });
  assert.equal(result.items.length, 2);
  assert.deepEqual(calls, ['dns:origin.example', 'origin.example:93.184.216.34', 'dns:final.example', 'final.example:8.8.8.8']);
  await assert.rejects(fetchFeed('https://origin.example/feed', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }], transport,
  }), /本机或私有网络/);
  await assert.rejects(fetchFeed('https://origin.example/feed', {
    lookup, transport: async () => ({ statusCode: 302, headers: { location: 'http://127.0.0.1/internal' }, body: Buffer.alloc(0) }),
  }), /本机或私有网络/);
});

test('fetchFeed refuses HTML responses even when their body resembles a feed', async () => {
  await assert.rejects(fetchFeed('https://origin.example/feed', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: async () => ({ statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(RSS) }),
  }), /不是订阅/);
});

test('fetchFeed uses the explicitly trusted local proxy for fake-IP public hostnames', async () => {
  let observedUrl = '';
  const proxy = http.createServer((request, response) => {
    observedUrl = request.url;
    response.setHeader('content-type', 'application/rss+xml');
    response.end(RSS);
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const previous = process.env.LIFE_FEED_PROXY;
  process.env.LIFE_FEED_PROXY = `http://127.0.0.1:${proxy.address().port}`;
  try {
    const result = await fetchFeed('http://feed.example/rss', {
      lookup: async () => [{ address: '198.18.0.12', family: 4 }],
    });
    assert.equal(result.title, 'Example');
    assert.equal(observedUrl, 'http://feed.example/rss');
    await assert.rejects(fetchFeed('http://127.0.0.1/rss'), /代理不能访问本机/);
    await assert.rejects(fetchFeed('http://printer.local/rss', {
      lookup: async () => [{ address: '198.18.0.12', family: 4 }],
    }), /代理不能访问本机/);
  } finally {
    if (previous === undefined) delete process.env.LIFE_FEED_PROXY;
    else process.env.LIFE_FEED_PROXY = previous;
    await new Promise((resolve) => proxy.close(resolve));
  }
});

test('fetchFeed bounds a stalled DNS resolution by the total deadline', async () => {
  await assert.rejects(fetchFeed('https://feed.example/rss', {
    timeoutMs: 10,
    lookup: async () => new Promise(() => {}),
  }), /超时/);
});

let calls = [];
const ttsServer = http.createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = Buffer.concat(chunks);
  calls.push({ path: request.url, method: request.method, headers: request.headers, body: body.toString() });
  if (request.url === '/api/health') return response.end(JSON.stringify({ state: 'ready', tts_enabled: true, stt: { state: 'ready', available: true } }));
  if (request.url === '/api/generate-stream/start') return response.end(JSON.stringify({ job_id: 'job_123' }));
  if (request.url === '/api/generate-stream/job_123/status') return response.end(JSON.stringify({ state: 'finished' }));
  if (request.url === '/api/generate-stream/job_123/result-audio') {
    response.setHeader('Content-Type', 'audio/wav');
    return response.end(Buffer.from('RIFF'));
  }
  if (request.url === '/api/generate-stream/job_123/close') return response.end('{}');
  if (request.url === '/v1/audio/transcriptions') return response.end(JSON.stringify({ text: '  你好  ' }));
  response.statusCode = 404;
  response.end('{}');
});
await new Promise((resolve) => ttsServer.listen(0, '127.0.0.1', resolve));
after(() => new Promise((resolve) => ttsServer.close(resolve)));
const tts = { baseUrl: `http://127.0.0.1:${ttsServer.address().port}`, env: { QWEN_TTS_ACCESS_PASSWORD: 'test-password' }, envFile: '/not-read' };

test('TTS adapter uses documented endpoints without playback and supports transcription', async () => {
  calls = [];
  assert.deepEqual(await probeTts(tts), { available: true, state: 'ready', stt: { available: true, state: 'ready' } });
  assert.deepEqual(await startSpeech('你好', tts), { jobId: 'job_123' });
  assert.match(calls.at(-1).body, /ephemeral_audio=1/);
  assert.equal(calls.at(-1).headers.authorization, 'Bearer test-password');
  assert.deepEqual(await readSpeechStatus('job_123', tts), { state: 'finished' });
  assert.deepEqual(await getSpeechAudio('job_123', tts), { body: Buffer.from('RIFF'), contentType: 'audio/wav' });
  assert.deepEqual(await closeSpeech('job_123', tts), { ok: true });
  assert.deepEqual(await transcribeAudio(Buffer.from('audio'), 'audio/webm', tts), { text: '你好' });
  assert.equal(calls.find((call) => call.path.includes('result-audio')).path, '/api/generate-stream/job_123/result-audio');
  assert.match(calls.find((call) => call.path === '/v1/audio/transcriptions').headers['content-type'], /^multipart\/form-data;/);
});

test('speech adapter validates job IDs and recording bounds before making requests', async () => {
  await assert.rejects(readSpeechStatus('../other', tts), /标识无效/);
  await assert.rejects(transcribeAudio(Buffer.alloc(0), 'audio/webm', tts), /不能为空/);
  await assert.rejects(transcribeAudio(Buffer.from('x'), 'text/plain', tts), /不支持/);
});

test('speech response reads are bounded after headers arrive', async () => {
  let timer;
  const stream = new ReadableStream({
    start(controller) { timer = setTimeout(() => controller.enqueue(new TextEncoder().encode('{"state":"finished"}')), 100); },
    cancel() { clearTimeout(timer); },
  });
  await assert.rejects(readSpeechStatus('job_123', {
    baseUrl: 'http://127.0.0.1:1', env: {}, envFile: '/not-read', timeoutMs: 10,
    fetchImpl: async () => new Response(stream, { headers: { 'content-type': 'application/json' } }),
  }), /超时/);
});
