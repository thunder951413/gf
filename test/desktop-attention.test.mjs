import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { DesktopAttention } from '../lib/desktop-attention.mjs';
import { ClosenessMemory } from '../lib/closeness-memory.mjs';

const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function fixture(t, extra = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-attention-'));
  const requests = [];
  let generate = async () => '想你了呀，我也想多陪你聊一会儿。';
  const app = await createApp({ dataDir, initialFeeds: [], startProactive: false, startRecall: false,
    startRuntime: false, startLifeThreads: false, startDossiers: false, startChatQueue: false,
    clock: () => new Date('2026-09-10T01:00:00Z'), random: () => .5, replySleep: async () => {},
    env: { LIFE_MODEL_BASE_URL: 'https://fixture.test/v1', LIFE_MODEL_NAME: 'fixture' },
    ...extra,
    fetchImpl: async (url, init) => {
      const request = JSON.parse(init.body); requests.push(request);
      const reply = await generate(request, init.signal);
      return Response.json({ choices: [{ message: { content: JSON.stringify(typeof reply==='object'?reply:{ reply, extra: '' }) } }] });
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

async function fixtureWithCloseness(t) {
  const f = await fixture(t, { materialPresentation: 'generated', startLifeThreads: true });
  const rows = f.app.store.saveChatTurn({ role: 'miyue', text: '亲亲你。', reply: '隔着聊天亲吻你，觉得很开心。' });
  for (const row of rows) f.app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run('2026-09-09T01:00:00Z', row.id);
  const memory = new ClosenessMemory(f.app.store, { clock: () => new Date('2026-09-10T01:00:00Z') });
  assert.equal(memory.select()?.kind, '接吻', 'the old memory must actually be eligible');
  f.app.inner.initiative = () => null;
  return { ...f, memory };
}

test('desktop invitation keeps its life topic despite an eligible closeness memory', async t => {
  const f = await fixtureWithCloseness(t);
  f.generate(async () => '我刚收好桌上的纸边，想先坐一会儿。');
  const result = await f.attention('life-with-memory-001');
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.requests.length, 1, 'an unrelated recall is not a reason to regenerate');
  assert.equal(result.messages[0].text, '我刚收好桌上的纸边，想先坐一会儿。');
  assert.doesNotMatch(f.requests[0].messages.map(m => m.content).join('\n'), /【一条可延续的亲近回忆/);
  assert.notEqual(f.app.interactionPolicy.receipt(result.messages[0].id).behavior.turnPlan.focus?.kind, 'closeness');
  assert.equal(f.app.store.db.prepare('SELECT recalled_at FROM closeness_moments').get().recalled_at, null);
});

test('explicit recall and a selected closeness need still receive source-linked memory', async t => {
  const f = await fixtureWithCloseness(t);
  const explicit = f.app.roleContext('miyue', { initiating: false, text: '你记得上次亲吻时的感受吗？' });
  assert.equal(explicit.closenessMoment?.kind, '接吻');
  assert.match(explicit.closenessMoment.context, /隔着聊天亲吻你/);
  f.app.inner.initiative = () => ({ key: 'test-need', needChannel: 'emotional', context: '想被惦记，想和他亲近。' });
  const need = f.app.roleContext('miyue', { initiating: true });
  assert.equal(need.opportunity.kind, 'need');
  assert.equal(need.closenessMoment?.messageId, explicit.closenessMoment.messageId);
  assert.equal(need.closenessMoment.purpose,'support');
  assert.equal(need.turnPlan.focus.kind,'need','background memory must not replace the selected initiative');
});

test('scheduled closeness can express a current wish once without narrating its supporting memory', async t => {
  const f=await fixtureWithCloseness(t);
  f.app.proactiveRepo.saveSettings({enabled:true,activeStart:'00:00',activeEnd:'23:59',desktopNotifications:false});
  f.app.inner.initiative=()=>({key:'inner:test-need',needChannel:'emotional',context:'想和他说说话。'});
  const consumed=[];f.app.inner.markInitiated=(...args)=>{consumed.push(args);return true;};
  const text='有点想你了，想多听听你今天的事。';
  f.generate(async()=>({skip:false,contentId:null,reason:'想和他交流',message:text,extra:''}));
  const sent=await f.app.proactive.runNow({roleId:'miyue'});
  assert.equal(sent.delivered,true,JSON.stringify(sent));
  assert.equal(sent.message.text,text);assert.equal(f.requests.length,1);
  assert.equal(consumed.length,1);
  const context=f.requests[0].messages.map(m=>m.content).join('\n');
  assert.match(context,/事件类型：聊天表达/);
  assert.match(context,/这次联系是因为你有陪伴或亲近的需要/);
  assert.doesNotMatch(context,/本轮材料：那次接吻/);
  assert.equal(f.app.interactionPolicy.receipt(sent.message.id).behavior.turnPlan.focus.kind,'need');
  assert.equal(f.app.store.db.prepare('SELECT recalled_at FROM closeness_moments').get().recalled_at,null);
});

test('explicit recall of feelings delivers without repeating activity keywords, then remains in history', async t => {
  const f=await fixture(t,{materialPresentation:'generated'});
  const rows=f.app.store.saveChatTurn({role:'miyue',text:'想抱抱你。',reply:'想抱就抱，我不躲。先想靠近，接着有一点紧张。'});
  for(const row of rows)f.app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run('2026-09-09T01:00:00Z',row.id);
  new ClosenessMemory(f.app.store,{clock:()=>new Date('2026-09-10T01:00:00Z')});
  const reply='记得，那句我没改口——是先想靠近，接着才有点紧张，两件事是连着的。';
  f.generate(async()=>reply);
  const result=await f.request('/api/chat',{role:'miyue',text:'你还记得上次聊拥抱的时候，你说自己有一点紧张吗？'});
  assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(result.messages.filter(m=>m.speaker==='assistant').map(m=>m.text).join('\n'),reply);
  assert.equal(f.requests.length,1,'no forced rewrite solely to insert activity keywords');
  assert.ok(f.app.store.db.prepare('SELECT recalled_at FROM closeness_moments').get().recalled_at);
  f.generate(async()=> '现在更多的是开心。');
  const next=await f.request('/api/chat',{role:'miyue',text:'那现在是什么心情？'});
  assert.equal(next.status,200,JSON.stringify(next));
  assert.match(f.requests.at(-1).messages.map(m=>m.content).join('\n'),/先想靠近，接着才有点紧张/);
});

for (const presentation of [{ name: 'legacy natural material delivery', options: { naturalMaterialDelivery: true } }, { name: 'explicit generated presentation', options: { naturalMaterialDelivery: false, materialPresentation: 'generated' } }]) test(`${presentation.name} keeps a desktop opening assistant-only and does not add a hidden authored prefix`, async t => {
  const f = await fixture(t, { ...presentation.options, startLifeThreads: true });
  const before = f.app.lifeThreads.get('miyue');f.generate(async () => '我刚收好桌上的纸边，想先坐一会儿。');
  const r = await f.attention('material-care-001');assert.equal(r.status, 200, JSON.stringify(r));
  assert.deepEqual(r.messages.map(message => message.speaker), ['assistant']);assert.equal(r.messages[0].text,'我刚收好桌上的纸边，想先坐一会儿。');
  assert.doesNotMatch(r.messages[0].text,new RegExp(before.beat.text));
  assert.equal(f.app.store.getMessages('miyue').every(message => message.speaker === 'assistant'),true);
});

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
  assert.match(prompt, /本轮由角色主动开口，没有新的用户原话/);
  assert.doesNotMatch(prompt, /用户当前话是|哄哄我，想被你关心/);
  assert.equal(f.app.interactionPolicy.receipt(r.messages[0].id).behavior.intent, 'affection_reply');
  assert.deepEqual(f.app.proactiveRepo.getSettings(), settings);
  assert.equal(f.app.store.getSettings().quiet, true);
  assert.equal(f.app.proactiveRepo.countContactsSince('2020-01-01'), 0);
});

test('desktop invitation never treats the final historical user message as a new input', async t => {
  const f = await fixture(t);
  f.app.store.saveChatTurn({ role: 'miyue', text: '好呢', reply: '那我先画两笔。' });
  const result = await f.attention('history-not-current-001');
  assert.equal(result.status, 200, JSON.stringify(result));
  const messages = f.requests.at(-1).messages;
  const triggerIndex = messages.findIndex(message => /本轮触发方式：独立邀请/.test(message.content));
  const historicalIndex = messages.findIndex(message => message.role === 'user' && message.content.includes('好呢'));
  assert.ok(historicalIndex >= 0 && historicalIndex < triggerIndex);
  assert.match(messages[triggerIndex].content, /不是用户刚发来的文字/);
  assert.doesNotMatch(messages.slice(triggerIndex + 1).map(message => message.content).join('\n'), /好呢/);
  assert.deepEqual(result.messages.map(message => message.speaker), ['assistant']);
});

test('care and affection gestures carry intent without fake speech, while subsequent typed words stay real',async t=>{
 const f=await fixture(t);
 for(const level of ['care','affection']){
  f.generate(async()=> '今天挺想你的，也想亲近一点。');
  const result=await f.attention('provenance-'+level,level);
  assert.equal(result.status,200,JSON.stringify(result));
  const prompt=f.requests.at(-1).messages.map(m=>m.content).join('\n');
  assert.doesNotMatch(prompt,/用户当前话是|亲亲我，抱抱我，哄哄我|哄哄我，想被你关心/);
  assert.match(prompt,/非语言亲近邀请/);
 }
 assert.equal(f.app.store.getMessages('miyue').filter(m=>m.speaker==='user').length,0);
 f.generate(async()=> '今天是累了呀，我在听。');
 const reply=await f.request('/api/chat',{role:'miyue',text:'哄哄我，今天有点累'});
 assert.equal(reply.status,200,JSON.stringify(reply));
 assert.match(f.requests.at(-1).messages.map(m=>m.content).join('\n'),/用户当前话是“哄哄我，今天有点累”/);
 assert.equal(f.app.store.getMessages('miyue').filter(m=>m.speaker==='user').at(-1).text,'哄哄我，今天有点累');
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

test('desktop invitations stop after two messages before generating, replay safely, and resume after a typed reply', async t => {
  const f = await fixture(t);
  const first = await f.attention('limit-first-001');
  assert.equal(first.status, 200);
  assert.equal((await f.attention('limit-second-001', 'affection')).status, 200);
  const calls = f.requests.length;
  const blocked = await f.attention('limit-third-001');
  assert.equal(blocked.status, 409); assert.equal(blocked.code, 'UNANSWERED_MESSAGE_LIMIT');
  assert.equal(f.requests.length, calls);
  const replay = await f.attention('limit-first-001');
  assert.deepEqual(replay.messages.map(row => row.id), first.messages.map(row => row.id));
  assert.equal(f.app.store.getMessages('miyue').length, 2);
  f.generate(async () => '河边今天怎么样，风大吗？');
  assert.equal((await f.request('/api/chat', { role: 'miyue', text: '刚刚去散步了。' })).status, 200);
  assert.equal(f.app.store.unansweredAssistantCount('miyue'), 1);
  f.generate(async () => '我刚收好桌上的纸边，想先坐一会儿。');
  assert.equal((await f.attention('limit-resumed-001')).status, 200);
  assert.equal((await f.attention('limit-resumed-third')).code, 'UNANSWERED_MESSAGE_LIMIT');
});

test('a desktop draft cannot become a third message if another delivery takes its slot during generation', async t => {
  const f = await fixture(t);
  f.app.store.saveChatTurn({ role: 'miyue', text: '我先忙一会儿。', reply: '好呀。' });
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  f.generate(() => new Promise(resolve => { release = () => resolve('忽然有点想和你说说话。'); started(); }));
  const pending = f.attention('limit-race-001');
  await entered;
  f.app.store.addAssistantMessage('miyue', '一条已送达的提醒。');
  release();
  const blocked = await pending;
  assert.equal(blocked.status, 409); assert.equal(blocked.code, 'UNANSWERED_MESSAGE_LIMIT');
  assert.equal(f.app.store.getMessages('miyue').filter(row => row.speaker === 'assistant').length, 2);
  assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM desktop_attention_receipts').get().n, 0);
});
