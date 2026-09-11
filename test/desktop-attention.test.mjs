import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { DesktopAttention } from '../lib/desktop-attention.mjs';

const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-attention-'));
  const requests = [];
  let generate = async () => '想你了呀，我也想多陪你聊一会儿。';
  const app = await createApp({ dataDir, initialFeeds: [], startProactive: false, startRecall: false,
    startRuntime: false, startLifeThreads: false, startDossiers: false, startChatQueue: false,
    clock: () => new Date('2026-09-10T01:00:00Z'), random: () => .5, replySleep: async () => {},
    env: { LIFE_MODEL_BASE_URL: 'https://fixture.test/v1', LIFE_MODEL_NAME: 'fixture' },
    fetchImpl: async (url, init) => {
      const request = JSON.parse(init.body); requests.push(request);
      const reply = await generate(request, init.signal);
      return Response.json({ choices: [{ message: { content: JSON.stringify({ reply, extra: '' }) } }] });
    },
  });
  app.preferences.setReplyPace('instant');
  const { port } = await app.listen(0);
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const request = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, post(body));
    return { status: response.status, ...await response.json() };
  };
  return { app, requests, request, generate: fn => { generate = fn; },
    attention: (requestId, level = 'care') => request('/api/desktop/attention', { requestId, level }) };
}

test('double-click receives contextual care even with scheduled contact disabled and quiet mode', async t => {
  const f = await fixture(t);
  f.app.proactiveRepo.saveSettings({ enabled: false, activeStart: '22:00', activeEnd: '23:00', dailyLimit: 1 });
  f.app.store.setSettings({ quiet: true });
  f.app.store.saveChatTurn({ role: 'miyue', text: '刚才整理书架去了。', reply: '收拾好了也歇一会儿呀。' });
  const settings = f.app.proactiveRepo.getSettings();
  const r = await f.attention('care-click-001');
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].speaker, 'assistant');
  assert.equal(f.app.store.getMessages('miyue').filter(m=>m.speaker==='user').length, 1);
  assert.doesNotMatch(f.app.store.getMessages('miyue').map(m=>m.text).join('\n'), /双击|桌面互动/);
  const prompt = f.requests.at(-1).messages.map(m => m.content).join('\n');
  assert.match(prompt, /整理书架/);
  assert.match(prompt, /本轮内部交流意图/);
  assert.match(prompt, /感觉他也在想你/);
  assert.match(prompt, /不是用户说出的原话/);
  assert.doesNotMatch(prompt, /可以补充自己的虚构阅读经历/);
  assert.equal(f.app.interactionPolicy.receipt(r.messages[0].id).behavior.intent, 'affection_reply');
  assert.deepEqual(f.app.proactiveRepo.getSettings(), settings);
  assert.equal(f.app.store.getSettings().quiet, true);
  assert.equal(f.app.proactiveRepo.countContactsSince('2020-01-01'), 0);
});

test('second double-click requests hugs and kisses while keeping the previous answer', async t => {
  const f = await fixture(t);
  await f.attention('care-click-002');
  f.generate(async () => '再给你一个抱抱，亲一下。今天也很想你。');
  const r = await f.attention('affection-002', 'affection');
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].speaker, 'assistant');
  assert.match(r.messages[0].text, /抱抱|亲/);
  const prompt = f.requests.at(-1).messages.map(m => m.content).join('\n');
  assert.match(prompt, /想你了呀/);
  assert.match(prompt, /刚才的亲近基础上/);
  assert.match(prompt, /无需再次问他要不要聊天/);
  assert.equal(f.app.store.getMessages('miyue').length, 2);
  assert.ok(f.app.store.getMessages('miyue').every(m=>m.speaker==='assistant'));
});

test('duplicate concurrent requests share generation and durable receipt prevents resending', async t => {
  const f = await fixture(t);
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  f.generate(() => new Promise(resolve => { release = () => resolve('我在呀，想陪你多说两句。'); started(); }));
  const first = f.attention('same-click-001');
  await entered;
  const second = f.attention('same-click-001');
  // A different click is not allowed to generate concurrently.
  assert.equal((await f.attention('other-click-001')).status, 409);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200, JSON.stringify(a)); assert.equal(b.status, 200);
  assert.deepEqual(a.messages.map(m => m.id), b.messages.map(m => m.id));
  assert.equal(f.requests.length, 1);
  const restarted = new DesktopAttention(f.app.store, { execute: () => { throw Error('must not generate'); }, isBusy: () => true, getRevision: () => 0 });
  const replay = await restarted.request({ requestId: 'same-click-001', level: 'care' });
  assert.deepEqual(replay.messages.map(m => m.id), a.messages.map(m => m.id));
  assert.equal((await f.attention('same-click-001', 'affection')).status, 409);
  assert.equal(f.app.store.getMessages('miyue').length, 1);
});

test('invalid input and failed pending chat do not lose or replace a draft', async t => {
  const f = await fixture(t);
  assert.equal((await f.attention('bad', 'care')).status, 400);
  assert.equal((await f.attention('valid-click-003', 'wrong')).status, 400);
  f.app.chatQueue.submit('miyue', '我这里还没说完。', 'normal-draft-001');
  f.app.store.db.exec("UPDATE chat_queue SET state='failed' WHERE role_id='miyue'");
  const before = f.app.chatQueue.get('miyue');
  assert.equal((await f.attention('valid-click-003')).status, 409);
  assert.deepEqual(f.app.chatQueue.get('miyue'), before);
  assert.equal(f.requests.length, 0);
});

test('typed message cancels in-flight care and remains available for a normal reply', async t => {
  const f = await fixture(t);
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  f.generate((request, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }); started();
  }));
  const care = f.attention('cancel-click-001');
  await entered;
  const typed = await f.request('/api/chat/send', { role: 'miyue', text: '先听我说今天的事情。', clientId: 'normal-draft-002' });
  assert.equal(typed.status, 202);
  assert.equal((await care).status, 409);
  assert.equal(f.app.store.getMessages('miyue').length, 0);
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM desktop_attention_receipts').get().n, 0);
  f.generate(async () => '好，你说，我认真听着。');
  await f.app.chatQueue.run('miyue');
  assert.equal(f.app.chatQueue.get('miyue').phase, 'idle');
  assert.equal(f.app.store.getMessages('miyue')[0].text, '先听我说今天的事情。');
});

test('failed model call has no false successful receipt and the same click may retry', async t => {
  const f = await fixture(t);
  f.generate(async () => { throw new Error('fixture network failure'); });
  const failed = await f.attention('retry-click-001');
  assert.ok(failed.status >= 400);
  assert.equal(f.app.store.getMessages('miyue').length, 0);
  f.generate(async () => '我在呢，今天也很惦记你。');
  assert.equal((await f.attention('retry-click-001')).status, 200);
  assert.equal(f.app.store.getMessages('miyue').length, 1);
});

test('operation wording is repaired before delivery and never saved as a user message', async t => {
  const f = await fixture(t);
  f.generate(async () => f.requests.length === 1 ? '看到你双击我啦，我也想你了。' : '刚刚忽然觉得你在想我，我也有点想你了。');
  const r = await f.attention('natural-care-001');
  assert.equal(r.status, 200, JSON.stringify(r));
  assert.equal(f.requests.length, 2);
  assert.equal(r.messages.length, 1);
  assert.match(r.messages[0].text, /觉得你在想我/);
  assert.ok(f.app.store.getMessages('miyue').every(m=>m.speaker==='assistant'&&!/双击|桌面互动/.test(m.text)));
});

test('an ordinary typed reply after a gesture keeps its own user message', async t => {
  const f = await fixture(t);
  await f.attention('natural-care-002');
  f.generate(async () => '好呀，今天过得怎么样？');
  const r=await f.request('/api/chat',{role:'miyue',text:'我想和你聊聊今天的事。',userTexts:[]});
  assert.equal(r.status,200,JSON.stringify(r));
  assert.deepEqual(f.app.store.getMessages('miyue').map(m=>m.speaker),['assistant','user','assistant']);
  assert.equal(r.messages[0].text,'我想和你聊聊今天的事。');
});
