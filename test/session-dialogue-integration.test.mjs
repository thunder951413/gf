import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

const NOW = new Date('2026-09-25T02:00:00Z');
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function until(check, message = 'condition timed out') {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function fixture(t, initial = [], extraOptions = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-dialogue-integration-'));
  const calls = [];
  const responses = [...initial];
  let app;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const call = { body, signal: init.signal, index: calls.length };
    calls.push(call);
    if (!responses.length) throw new Error(`missing fixture response for model call ${calls.length}`);
    const next = responses.shift();
    const value = typeof next === 'function' ? await next({ app, body, signal: init.signal, index: call.index }) : next;
    const content = typeof value === 'string' ? value : JSON.stringify(value);
    return Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 30, completion_tokens: 12 } });
  };
  app = await createApp({
    dataDir,
    sessionDialogue: true,
    sessionGuidance: false,
    sessionReview: false,
    dynamicCompanion: true,
    semanticUnderstanding: true,
    dialogueMemory: true,
    startDiscovery: false,
    initialFeeds: [],
    startWeixin: false,
    startChatQueue: false,
    startProactive: false,
    startRecall: false,
    startResearch: false,
    startLife: false,
    startRuntime: false,
    startDailyLife: false,
    startLifeThreads: false,
    startPursuits: false,
    startDossiers: false,
    replySleep: async () => {},
    clock: () => new Date(NOW),
    random: () => 0.5,
    env: { LIFE_MODEL_BASE_URL: 'https://fixture.test/v1', LIFE_MODEL_NAME: 'fixture' },
    fetchImpl,
    ...extraOptions,
  });
  app.preferences.setReplyPace('instant');
  const { port } = await app.listen(0);
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, body === undefined ? { method } : { ...post(body), method });
    let value = null;
    try { value = await response.json(); } catch {}
    return { status: response.status, body: value };
  };
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { app, calls, request, enqueue: (...items) => responses.push(...items) };
}

const contents = call => call.body.messages.map(message => message.content).join('\n');
const historyEvidence = messages => {
  const block=messages.find(m=>m.role==='system'&&m.content.startsWith('【历史原文记录】'));
  const archive=block?JSON.parse(block.content.slice(block.content.indexOf('\n')+1)):[];
  // Native messages directly precede their 【相邻对话】 metadata block.
  const metaIndex=messages.findIndex(m=>m.role==='system'&&m.content.startsWith('【相邻对话】'));
  let first=metaIndex;while(first>0&&['user','assistant'].includes(messages[first-1].role))first--;
  const meta=metaIndex<0?[]:JSON.parse(messages[metaIndex].content.slice(messages[metaIndex].content.indexOf('\n')+1));
  const recent=metaIndex<0?[]:messages.slice(first,metaIndex).map((m,i)=>({...meta[i],speaker:m.role,text:m.content}));
  return [...archive,...recent].map(row=>({speaker:row.speaker,...(row.kind==='proactive'?{kind:row.kind}:{}),text:row.text,...(row.dateContext?{dateContext:row.dateContext}:{})}));
};

test('a draft with a confirmed unsupported scene cannot commit when its revision still fails review',async t=>{
  const draft={reply:'就是图片右边那个人，你刚才看过。'};
  const finding={guidance:[{instruction:'没有图片证据，删去位置和用户看过图片的断言。',quote:'图片右边那个人',quoteSource:'draft'}]};
  const {app,request,calls}=await fixture(t,[{guidance:[]},draft,finding,draft,finding],{sessionGuidance:true,sessionReview:true});
  const response=await request('/api/chat',{role:'miyue',text:'接着讲那个观点，不用问我。'});
  assert.equal(response.status,502);assert.equal(response.body.code,'SESSION_REVISION_FAILED');
  assert.equal(app.store.getMessages('miyue').length,0);assert.equal(calls.length,5);
  const trace=app.dialogueTraces.list({roleId:'miyue',limit:1})[0];
  assert.equal(trace.review.verification.count,1);assert.equal(trace.outcome.status,'failed');
});
test('an explicitly hypothetical corrected explanation is saved only after its second review',async t=>{
  const {app,request,calls}=await fixture(t,[{guidance:[]},{reply:'图片右边那个人会先被看见。'},
    {guidance:[{instruction:'改成明确的假设例子，不能假装有图片。',quote:'图片右边那个人',quoteSource:'draft'}]},
    {reply:'举个假设的例子：留白可以让视线先停在主体上，再移动到周围。'},{guidance:[]}],{sessionGuidance:true,sessionReview:true});
  assert.equal((await request('/api/chat',{role:'miyue',text:'讲讲留白如何影响观看顺序。'})).status,200);
  assert.equal(calls.length,5);assert.equal(app.store.getMessages('miyue').length,2);
  assert.match(app.store.getMessages('miyue').at(-1).text,/举个假设/);
});
const sessionFacts = messages => {
  const block = messages.find(message => message.role === 'system' && message.content.startsWith('【本轮背景证据】'));
  assert.ok(block, 'current session facts should be present in the provider payload');
  const prefix = '当前事实：';
  const line = block.content.split('\n').find(value => value.startsWith(prefix));
  assert.ok(line, 'background evidence should include current facts');
  return JSON.parse(line.slice(prefix.length));
};

test('a regressed character step is independently corrected before storage while schedule stays scoped',async t=>{
  const history=[
    ['user','就看已经打印的这一张，不用再打印。'],
    ['assistant','这张色带已在窗边晾了半小时，现在已经凉透，我去揭起来看。'],
  ];
  const corrected='我把已经凉透的那张色带揭起来，米白和灰橘的边界很清楚。';
  const f=await fixture(t,[
    {guidance:[{instruction:'保留同一张纸已经晾好、凉透的进度。',quote:'现在已经凉透'}]},
    ({body})=>{assert.match(sessionFacts(body.messages).character.activityScope,/日程.*不是.*转场/u);return {reply:'纸刚从打印机出来，还带点温，先等它晾干。'};},
    ({body})=>{
      assert.ok(body.messages.some(m=>m.role==='system'&&/同一物件的已完成步骤退回未完成/u.test(m.content)));
      assert.ok(body.messages.some(m=>m.content.includes(history[1][1])));
      return {ready:true,needsReasoning:false,guidance:[{instruction:'同一张色带已凉透，不能退回刚打印和等待晾干。',quote:'纸刚从打印机出来',quoteSource:'draft'}],revision:{reply:corrected}};
    },
  ],{sessionGuidance:true,sessionReview:true});
  f.app.store.saveChatTurn({role:'miyue',text:history[0][1],reply:history[1][1]});
  const response=await f.request('/api/chat',{role:'miyue',text:'你去揭吧。'});
  assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(f.calls.length,3);
  assert.equal(f.app.store.getMessages('miyue').at(-1).text,corrected);
  const trace=f.app.dialogueTraces.list({roleId:'miyue',limit:1})[0];
  assert.equal(trace.review.rewritten,true);assert.equal(trace.review.verification.mode,'inline');
  assert.ok(!f.app.store.getMessages('miyue').some(row=>row.text.includes('纸刚从打印机出来')));
});

test('session stores model-authored wording without keyword filtering; a verbatim repeat gets one rewrite request and the model may keep it', async t => {
  const reply = '你应该先听听自己的想法。你想说的时候我听着，今天想吃点什么？';
  const f = await fixture(t, [{ reply }, ({ body }) => { assert.match(body.messages.at(-1).content, /【别复读】/u); return { reply }; }]);
  f.app.store.saveChatTurn({ role: 'miyue', text: '我想歇一会儿。', reply });
  const response = await f.request('/api/chat', { role: 'miyue', text: '你刚才是怎么说的，再说一遍。' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(f.calls.length, 2);
  assert.equal(f.app.store.getMessages('miyue').at(-1).text, reply);
  assert.equal(f.app.dialogueTraces.list({ roleId: 'miyue' })[0].length.code, 'STILL_REPEATING');
  // Earlier replies are not re-echoed as a separate block (it fed self-imitation).
  assert.doesNotMatch(contents(f.calls[0]), /【近期表达参照】/u);
});

test('a reply that reuses a phrase from the previous turn is rewritten once without touching stored history', async t => {
  const previous = '那就赖着呗，谁先动谁是小狗。';
  const f = await fixture(t, [{ reply: '好呀，谁先动谁是小狗，我不动。' }, { reply: '好呀，那我也不动了。' }]);
  f.app.store.saveChatTurn({ role: 'miyue', text: '我不想动', reply: previous });
  const response = await f.request('/api/chat', { role: 'miyue', text: '那就这样抱着' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(f.calls.length, 2);
  assert.equal(f.app.store.getMessages('miyue').at(-1).text, '好呀，那我也不动了。');
  assert.equal(f.app.store.getMessages('miyue').filter(row => row.speaker === 'assistant')[0].text, previous);
  assert.equal(f.app.dialogueTraces.list({ roleId: 'miyue' })[0].length.reason, 'repeat-phrase');
});

test('session uses model-generated turn guidance before writing the native reply', async t => {
  const userText = '我准备了很久的方案被一句以后再说带过去了，你先听我说。';
  const reply = '准备了那么久，却没得到认真回应，难受是可以理解的。你慢慢说。';
  const f = await fixture(t, [
    { guidance: [{ instruction: '先倾听被忽视的感受；准备时间不等于会议上的发言时间。', quote: '准备了很久的方案' }] },
    ({ body }) => {
      assert.ok(body.messages.some(row => row.content.includes('【本轮具体提示】')));
      assert.deepEqual(body.messages.filter(row => row.role === 'user'), [{ role: 'user', content: userText }]);
      return { reply };
    },
  ], { sessionGuidance: true });
  const response = await f.request('/api/chat', { role: 'miyue', text: userText });
  assert.equal(response.status, 200, JSON.stringify(response.body));assert.equal(f.calls.length, 2);
  assert.equal(f.app.store.getMessages('miyue').at(-1).text, reply);
  assert.deepEqual(f.app.dialogueTraces.list({ roleId: 'miyue' })[0].guidance, { status: 'ready', count: 1,items:[{instruction:'先倾听被忽视的感受；准备时间不等于会议上的发言时间。',quote:'准备了很久的方案'}] });
});

test('unavailable model guidance does not veto a normal reply', async t => {
  const f = await fixture(t, [{ guidance: [{ instruction: '未知依据', quote: '用户不存在的经历' }] }, { reply: '嗯，今天就聊点轻松的。' }], { sessionGuidance: true });
  const response = await f.request('/api/chat', { role: 'miyue', text: '聊点轻松的吧。' });
  assert.equal(response.status, 200, JSON.stringify(response.body));assert.equal(f.calls.length, 2);
  assert.equal(f.app.dialogueTraces.list({ roleId: 'miyue' })[0].guidance.status, 'unavailable');
});

test('model review corrects an unsupported plan outcome without code interpreting the prose', async t => {
  const text='昨天我只说准备去看牙，还没说去没去。你能确定结果吗？';
  const f=await fixture(t,[
    {guidance:[]},
    {reply:'结果还不知道，牙医怎么说？'},
    {guidance:[{instruction:'草稿预设已经就诊；只能说结果未知，不先问牙医结论。',quote:'还没说去没去'}]},
    {reply:'现在不能确定，你还没有说是否去了，也没有报告结果。'},
    {guidance:[]},
  ],{sessionGuidance:true,sessionReview:true});
  const response=await f.request('/api/chat',{role:'miyue',text});
  assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(f.calls.length,5);
  assert.equal(f.app.store.getMessages('miyue').at(-1).text,'现在不能确定，你还没有说是否去了，也没有报告结果。');
  assert.deepEqual(f.app.dialogueTraces.list({roleId:'miyue'})[0].review,{status:'ready',count:1,rewritten:true,items:[{instruction:'草稿预设已经就诊；只能说结果未知，不先问牙医结论。',quote:'还没说去没去'}],verification:{status:'ready',count:0}});
});

test('review rewrite uses a staged reminder receipt without executing the action a second time', async t => {
  const text='2026年9月26日上午9点提醒我浇水';
  const f=await fixture(t,[
    {guidance:[]},
    {request:{name:'reminder',action:'create',text:'浇水',dueAt:'2026-09-26T01:00:00Z',evidence:text}},
    {reply:'设好了，明天9点提醒你浇水。你吃饭了吗？'},
    {guidance:[{instruction:'完成操作后自然收住，删除与提醒无关的生活追问。',quote:text}]},
    ({body})=>{
      assert.ok(body.messages.some(row=>row.content.startsWith('【外部工具回执｜reminder】')));
      return {reply:'设好了，明天上午9点提醒你浇水。'};
    },
    {guidance:[]},
  ],{sessionGuidance:true,sessionReview:true});
  const response=await f.request('/api/chat',{role:'miyue',text});
  assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(f.calls.length,6);
  assert.equal(f.app.store.listReminders().length,1);
  assert.equal(f.app.store.getMessages('miyue').at(-1).text,'设好了，明天上午9点提醒你浇水。');
});

test('an independently reviewed inline correction commits with exactly three model calls',async t=>{
  const revised='现在还不能确定，你没有说是否去了，也没有报告结果。';
  const f=await fixture(t,[{guidance:[]},{reply:'还不知道，牙医怎么说？'},
    {ready:true,revision:{reply:revised},guidance:[{instruction:'删除预设已经就诊的问句。',quote:'牙医怎么说',quoteSource:'draft'}]},
  ],{sessionGuidance:true,sessionReview:true});
  const response=await f.request('/api/chat',{role:'miyue',text:'昨天只说准备去看牙，还没说去没去。你能确定结果吗？'});
  assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(f.calls.length,3);
  assert.deepEqual(f.app.store.getMessages('miyue').map(row=>row.speaker),['user','assistant']);
  assert.equal(f.app.store.getMessages('miyue').at(-1).text,revised);
  const trace=f.app.dialogueTraces.list({roleId:'miyue'})[0];
  assert.equal(trace.review.verification.mode,'inline');assert.equal(trace.review.rewritten,true);
  for(const stage of ['memory','context','guidance','draft','review','delivery','total'])assert.ok(trace.stageTimings[stage]>=0,stage);
});

test('inline review reads the staged reminder receipt and the action commits exactly once',async t=>{
  const text='2026年9月26日上午9点提醒我浇水';
  const f=await fixture(t,[{guidance:[]},
    {request:{name:'reminder',action:'create',text:'浇水',dueAt:'2026-09-26T01:00:00Z',evidence:text}},
    {reply:'设好了，明天9点提醒你浇水。你吃饭了吗？'},
    ({body})=>{
      assert.ok(body.messages.some(row=>row.content.startsWith('【外部工具回执｜reminder】')));
      return {ready:true,revision:{reply:'设好了，明天上午9点提醒你浇水。'},
        guidance:[{instruction:'确认提醒后自然收住，删除无关追问。',quote:'你吃饭了吗？',quoteSource:'draft'}]};
    },
  ],{sessionGuidance:true,sessionReview:true});
  const response=await f.request('/api/chat',{role:'miyue',text});
  assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(f.calls.length,4);
  assert.equal(f.app.store.listReminders().length,1);assert.equal(f.app.store.getMessages('miyue').length,2);
});

test('an unresolved independent review preserves queued input and rolls back a staged reminder',async t=>{
  const text='2026年9月26日上午9点提醒我浇水';
  const f=await fixture(t,[{guidance:[]},
    {request:{name:'reminder',action:'create',text:'浇水',dueAt:'2026-09-26T01:00:00Z',evidence:text}},
    {reply:'设好了，明天9点提醒你浇水。'},
    {ready:false,revision:null,guidance:[]},
    {ready:false,revision:null,guidance:[]},
  ],{sessionGuidance:true,sessionReview:true,startChatQueue:true,chatDebounceMs:5,chatRetryDelaysMs:[]});
  assert.equal((await f.request('/api/chat/send',{role:'miyue',text,clientId:'inline-rejection-001'})).status,202);
  await until(()=>f.app.chatQueue.get('miyue').phase==='failed');
  assert.equal(f.calls.length,5);assert.deepEqual(f.app.store.listReminders(),[]);
  assert.deepEqual(f.app.store.getMessages('miyue'),[]);assert.equal(f.app.chatQueue.get('miyue').items[0].text,text);
  assert.equal(f.app.dialogueTraces.list({roleId:'miyue'})[0].outcome.status,'failed');
  assert.ok(f.app.dialogueTraces.list({roleId:'miyue'})[0].stageTimings.review>=0);
});

test('session mode bypasses semantic classification and carries corrections as speaker-owned history evidence', async t => {
  const f = await fixture(t, [
    { reply: '对，是我的书，我刚才把归属说反了。' },
    { reply: '是我的，这次没有再说反。' },
  ]);
  const seeded = f.app.store.saveChatTurn({ role: 'miyue', text: '那本书是谁的？', reply: '那是放在你桌上的书。' });
  for (const [index, row] of seeded.entries()) {
    f.app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(`2026-09-2${3 + index}T01:00:00Z`, row.id);
  }

  const correction = '那是你的书，不是我的。';
  const first = await f.request('/api/chat', { role: 'miyue', text: correction });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(f.calls.length, 1, 'semanticUnderstanding does not add an intent-model call in session mode');
  const firstMessages = f.calls[0].body.messages;
  assert.deepEqual(historyEvidence(firstMessages), [
    { speaker: 'user', text: '【历史消息·2026-09-23 09:00】\n那本书是谁的？' },
    { speaker: 'assistant', text: '【历史消息·2026-09-24 09:00】\n那是放在你桌上的书。' },
  ]);
  assert.deepEqual(firstMessages.at(-1), { role: 'user', content: correction });
  assert.deepEqual(firstMessages.filter(message => message.role === 'user').at(-1), { role: 'user', content: correction });
  const facts = sessionFacts(firstMessages);
  assert.equal(facts.at, NOW.toISOString());
  assert.equal(facts.character.id, 'miyue');
  assert.equal(facts.character.name, '林晓薇');
  assert.equal(typeof facts.character.location, 'string'); assert.ok(facts.character.location);
  assert.equal(typeof facts.character.activity, 'string'); assert.ok(facts.character.activity);
  assert.equal(Object.hasOwn(facts, 'location'), false);
  assert.equal(Object.hasOwn(facts, 'activity'), false);
  assert.doesNotMatch(contents(f.calls[0]), /【眼前交流的定位|【避免重复】|【本轮唯一交流目的】|【近期交流原文|故事时间/);

  const secondText = '所以这本书到底是谁的？';
  const second = await f.request('/api/chat', { role: 'miyue', text: secondText });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(f.calls.length, 2);
  const secondMessages = f.calls[1].body.messages;
  const secondHistory = historyEvidence(secondMessages);
  assert.ok(secondHistory.some(message => message.speaker === 'user' && message.text.includes(correction)));
  assert.ok(secondHistory.some(message => message.speaker === 'assistant' && message.text.includes('我刚才把归属说反了')));
  assert.deepEqual(secondMessages.at(-1), { role: 'user', content: secondText });
  assert.deepEqual(secondMessages.filter(message => message.role === 'user').at(-1), { role: 'user', content: secondText });
  assert.deepEqual(f.app.store.getMessages('miyue').map(row => row.speaker), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);

  const health = await f.request('/api/health');
  assert.equal(health.body.sessionDialogue, true);
  assert.equal(health.body.semanticUnderstanding, false, 'the legacy semantic planner is absent');
});

test('state tool evidence returns to the same model session and malformed optional metadata cannot kill reply prose', async t => {
  const f = await fixture(t, [
    { request: { name: 'state', query: '现在的关系边界是什么？' } },
    { reply: '现在还是按我们已经说清的边界来相处。' },
    { reply: '这句我正常接住了。', companionship: 'broken', dynamics: ['also-broken'], social: 7 },
  ]);
  const first = await f.request('/api/chat', { role: 'miyue', text: '我们现在的关系边界是什么？' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].body.messages.at(-1).content, '我们现在的关系边界是什么？');
  const toolTranscript = f.calls[1].body.messages;
  const toolRequest = toolTranscript.find(message => message.role === 'assistant' && message.content.includes('"name":"state"'));
  const toolEvidence = toolTranscript.find(message => message.role === 'system' && message.content.includes('【外部工具回执｜state】'));
  assert.ok(toolRequest); assert.ok(toolEvidence);
  assert.match(toolEvidence.content, /"section":"relationship"/);
  assert.deepEqual(toolTranscript.filter(message => message.role === 'user'), [{ role: 'user', content: '我们现在的关系边界是什么？' }]);
  assert.equal(first.body.messages.at(-1).text, '现在还是按我们已经说清的边界来相处。');

  const second = await f.request('/api/chat', { role: 'miyue', text: '好，我知道了。' });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.messages.at(-1).text, '这句我正常接住了。');
  assert.equal(f.app.companionDynamics.get().revision, 0);
});

test('an incomplete provider envelope retries once with system metadata and preserves one real user turn', async t => {
  const f = await fixture(t, ['{"reply":"没有闭合的正文', { reply: '我按完整格式重新接住你了。' }]);
  const input = '接着你真正说过的内容。';
  const result = await f.request('/api/chat', { role: 'miyue', text: input });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(f.calls.length, 2);
  const repaired = f.calls[1].body.messages;
  assert.deepEqual(repaired.filter(row => row.role === 'user'), [{ role: 'user', content: input }]);
  assert.equal(repaired.find(row => row.content.startsWith('【系统格式修复】')).role, 'system');
  assert.deepEqual(f.app.store.getMessages('miyue').map(row => row.text), [input, '我按完整格式重新接住你了。']);
  assert.equal(f.app.dialogueTraces.list({ roleId: 'miyue' })[0].repairCount, 1);
});

test('format recovery cannot re-execute a staged reminder and a second malformed reply rolls everything back', async t => {
  const input = '明天九点提醒我吃药。';
  const request = { name: 'reminder', action: 'create', text: '吃药', dueAt: '2026-09-26T09:00:00+08:00', evidence: input };
  for (const final of [{ request }, '{"reply":"仍然没有闭合']) {
    const f = await fixture(t, [{ request }, '{"reply":"损坏的确认', final]);
    const result = await f.request('/api/chat', { role: 'miyue', text: input });
    assert.equal(result.status, 502, JSON.stringify(result.body));
    assert.equal(result.body.code, 'MODEL_REPLY_INVALID');
    assert.equal(f.calls.length, 3, 'one tool followup and exactly one format retry');
    assert.deepEqual(f.app.store.listReminders(), []);
    assert.deepEqual(f.app.store.getMessages('miyue'), []);
  }
});

test('a new queued message cancels obsolete session generation and only the combined latest turn commits', async t => {
  let abortSeen = false;
  const f = await fixture(t, [
    ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => {
      abortSeen = true;
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true })),
    { reply: '好，按你最新说的，今天不去了。' },
  ], { startChatQueue: true, chatDebounceMs: 5 });
  assert.equal((await f.request('/api/chat/send', { role: 'miyue', text: '我今天准备去。', clientId: 'session-abort-001' })).status, 202);
  await until(() => f.calls.length === 1, 'first queued model call did not start');
  assert.equal((await f.request('/api/chat/send', { role: 'miyue', text: '等等，我改主意不去了。', clientId: 'session-abort-002' })).status, 202);
  await until(() => f.app.store.getMessages('miyue').length === 3, 'replacement session turn did not commit');
  assert.equal(abortSeen, true);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.app.store.getMessages('miyue').map(row => row.text), [
    '我今天准备去。', '等等，我改主意不去了。', '好，按你最新说的，今天不去了。',
  ]);
  assert.equal(f.app.usage.snapshot().recent.some(row => row.status === 'cancelled'), true);
});

test('a memory revision changed during generation rejects the stale session reply', async t => {
  let changed = false;
  const f = await fixture(t, [({ app }) => {
    if (!changed) {
      changed = true;
      app.recallRepo.replace('miyue', '生成期间由用户修改的长期记忆。');
    }
    return { reply: '这句基于旧记忆，不应保存。' };
  }]);
  const result = await f.request('/api/chat', { role: 'miyue', text: '继续说刚才的事。' });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.code, 'STALE_SESSION_CONTEXT');
  assert.equal(f.app.store.getMessages('miyue').length, 0);
});

test('editing or deleting manual memory during generation rolls back stale replies', async t => {
  for (const action of ['update', 'delete']) {
    let memory;
    const f = await fixture(t, [({ app }) => {
      if (action === 'update') app.store.updateMemory(memory.id, { text: '已更正的手动记忆。' });
      else app.store.deleteMemory(memory.id);
      return { reply: '这句沿用了已失效的手动记忆。' };
    }]);
    memory = f.app.store.addMemory('shared', '即将撤回的手动记忆。');
    const result = await f.request('/api/chat', { role: 'miyue', text: '你还记得吗？' });
    assert.equal(result.status, 409, JSON.stringify(result.body));
    assert.equal(result.body.code, 'STALE_SESSION_CONTEXT');
    assert.equal(f.app.store.getMessages('miyue').length, 0);
    assert.match(contents(f.calls[0]), /即将撤回的手动记忆/);
  }
});

test('changing the history window during generation rejects the old evidence snapshot', async t => {
  const f = await fixture(t, [({ app }) => {
    app.preferences.setHistoryWindow({ days: 3 });
    return { reply: '这句依据旧的历史窗口，不应保存。' };
  }]);
  const result = await f.request('/api/chat', { role: 'miyue', text: '接着聊。' });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.code, 'STALE_SESSION_CONTEXT');
  assert.equal(f.app.store.getMessages('miyue').length, 0);
});

test('a same-activity runtime revision invalidates the draft and retries from current state', async t => {
  let changed = false;
  const f = await fixture(t, [
    ({ app }) => {
      if (!changed) {
        changed = true;
        const runtime = app.companionRuntime.configuration();
        app.companionRuntime.updateSettings({ revision: runtime.revision, settings: { automaticScenes: !runtime.settings.automaticScenes } });
      }
      return { reply: '这句基于变化前的生活状态，不应保存。' };
    },
    { reply: '我按刚更新的生活状态接着说。' },
  ]);
  const result = await f.request('/api/chat', { role: 'miyue', text: '你现在在做什么？' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.app.store.getMessages('miyue').map(row => row.text), ['你现在在做什么？', '我按刚更新的生活状态接着说。']);
});

test('tuning and interaction preference changes reject stale session replies', async t => {
  const tuning = await fixture(t, [({ app }) => {
    const current = app.companionTuning.get();
    app.companionTuning.set({ ...current.values, warmth: current.values.warmth === 100 ? 99 : current.values.warmth + 1 }, current.revision);
    return { reply: '这句沿用了旧的相处参数。' };
  }]);
  const staleTuning = await tuning.request('/api/chat', { role: 'miyue', text: '陪我说会儿话。' });
  assert.equal(staleTuning.status, 409, JSON.stringify(staleTuning.body));
  assert.equal(staleTuning.body.code, 'STALE_COMPANION_TUNING');
  assert.equal(tuning.app.store.getMessages('miyue').length, 0);

  const policy = await fixture(t, [({ app }) => {
    app.interactionPolicy.set('miyue', { noQuestions: true });
    return { reply: '这句沿用了旧的相处偏好。' };
  }]);
  const stalePolicy = await policy.request('/api/chat', { role: 'miyue', text: '接着聊。' });
  assert.equal(stalePolicy.status, 409, JSON.stringify(stalePolicy.body));
  assert.equal(stalePolicy.body.code, 'STALE_DIALOGUE_POLICY');
  assert.equal(policy.app.store.getMessages('miyue').length, 0);
});

test('create, update, and cancel reminder requests commit atomically with their replies', async t => {
  const userCreate = '明天上午九点提醒我吃药。';
  const f = await fixture(t, [
    { request: { name: 'reminder', action: 'create', text: '吃药', dueAt: '2026-09-26T09:00:00+08:00', evidence: userCreate } },
    { reply: '好，明天上午九点提醒你吃药。' },
  ]);
  const created = await f.request('/api/chat', { role: 'miyue', text: userCreate });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  let [reminder] = f.app.store.listReminders();
  assert.ok(reminder); assert.equal(reminder.text, '吃药'); assert.equal(reminder.dueAt, '2026-09-26T01:00:00.000Z');
  assert.match(contents(f.calls[1]), /validated_for_reply_commit/);

  const userUpdate = '把刚才吃药的提醒改到后天上午十点。';
  f.enqueue(
    { request: { name: 'reminder', action: 'update', id: reminder.id, text: '吃药', dueAt: '2026-09-27T10:00:00+08:00', evidence: userUpdate } },
    { reply: '好，已改到后天上午十点。' },
  );
  const updated = await f.request('/api/chat', { role: 'miyue', text: userUpdate });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  [reminder] = f.app.store.listReminders();
  assert.equal(reminder.dueAt, '2026-09-27T02:00:00.000Z');

  const userCancel = '取消这个吃药提醒。';
  f.enqueue(
    { request: { name: 'reminder', action: 'cancel', id: reminder.id, evidence: userCancel } },
    { reply: '好，这个提醒已取消。' },
  );
  const cancelled = await f.request('/api/chat', { role: 'miyue', text: userCancel });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.deepEqual(f.app.store.listReminders(), []);
  assert.equal(f.calls.length, 6);
});

test('invalid reminder evidence stays uncommitted and a stale staged update rolls back its confirming reply', async t => {
  const invalidUser = '明天提醒我去散步。';
  const f = await fixture(t, [
    { request: { name: 'reminder', action: 'create', text: '散步', dueAt: '2026-09-26T18:00:00+08:00', evidence: '这不是当前原话' } },
    { reply: '这次没能建立提醒，因为操作依据没有通过校验。' },
  ]);
  const invalid = await f.request('/api/chat', { role: 'miyue', text: invalidUser });
  assert.equal(invalid.status, 200, JSON.stringify(invalid.body));
  assert.equal(f.app.store.listReminders().length, 0);
  assert.match(contents(f.calls[1]), /需要当前用户原话作为操作依据/);
  assert.doesNotMatch(invalid.body.messages.at(-1).text, /已设置|已建立/);

  const reminder = f.app.store.addReminder('miyue', '给花浇水', '2026-09-26T01:00:00.000Z');
  const staleUser = '把给花浇水改到后天上午十点。';
  f.enqueue(
    { request: { name: 'reminder', action: 'update', id: reminder.id, text: '给花浇水', dueAt: '2026-09-27T10:00:00+08:00', evidence: staleUser } },
    ({ app }) => {
      app.store.db.prepare('UPDATE reminders SET text=? WHERE id=?').run('外部已修改的提醒', reminder.id);
      return { reply: '好，已改到后天上午十点。' };
    },
  );
  const beforeMessages = f.app.store.getMessages('miyue').length;
  const stale = await f.request('/api/chat', { role: 'miyue', text: staleUser });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, 'STALE_SESSION_ACTION');
  assert.equal(f.app.store.getMessages('miyue').length, beforeMessages, 'the user line and false confirmation roll back together');
  assert.equal(f.app.store.listReminders()[0].text, '外部已修改的提醒');
});

test('session proactive skip, later continuation, and desktop invitation share native continuity without fake user speech', async t => {
  const f = await fixture(t, [
    { skip: true, message: '', reason: '这会儿没有自然想说的', contentId: null },
    { skip: false, message: '忽然有点想你，就来打个招呼。', reason: '想打个招呼', contentId: null },
    { reply: '嗯，我刚才那句就是在想你。' },
    { reply: '我在呢，想过来陪你一会儿。' },
  ]);
  f.app.proactiveRepo.saveSettings({ enabled: true, activeStart: '00:00', activeEnd: '23:59', dailyLimit: 10, desktopNotifications: false });

  const skipped = await f.app.proactive.runNow({ roleId: 'miyue' });
  assert.equal(skipped.delivered, false); assert.equal(f.app.store.getMessages('miyue').length, 0);
  assert.match(contents(f.calls[0]), /"type":"scheduled_opportunity"/);
  assert.match(contents(f.calls[0]), /"skip":boolean/);
  assert.equal(f.calls[0].body.messages.some(message => message.role === 'user'), false);

  const delivered = await f.app.proactive.runNow({ roleId: 'miyue' });
  assert.equal(delivered.delivered, true, JSON.stringify(delivered));
  assert.equal(delivered.message.text, '忽然有点想你，就来打个招呼。');
  assert.equal(f.calls[1].body.messages.some(message => message.role === 'user'), false);
  const reply = await f.request('/api/chat', { role: 'miyue', text: '我也想你了。' });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const continuation = f.calls[2].body.messages;
  assert.ok(historyEvidence(continuation).some(message => message.speaker === 'assistant' && message.text.includes('忽然有点想你')));
  assert.deepEqual(continuation.at(-1), { role: 'user', content: '我也想你了。' });
  assert.deepEqual(continuation.filter(message => message.role === 'user').at(-1), { role: 'user', content: '我也想你了。' });

  const usersBefore = f.app.store.getMessages('miyue').filter(row => row.speaker === 'user').length;
  const attention = await f.request('/api/desktop/attention', { requestId: 'session-attention-001', level: 'affection' });
  assert.equal(attention.status, 200, JSON.stringify(attention.body));
  assert.deepEqual(attention.body.messages.map(row => row.speaker), ['assistant']);
  const invitation = f.calls[3].body.messages;
  const triggerIndex = invitation.findIndex(message => message.role === 'system' && message.content.includes('desktop_invitation'));
  assert.ok(triggerIndex >= 0);
  assert.match(invitation[triggerIndex].content, /"gesture":"affection"/);
  assert.equal(invitation.slice(triggerIndex + 1).some(message => message.role === 'user'), false);
  assert.ok(invitation.some(message => message.role === 'system' && message.content.startsWith('【本轮当前时间】')));
  const invitationHistory = historyEvidence(invitation);
  assert.ok(invitationHistory.some(message => message.speaker === 'assistant' && message.text.includes('忽然有点想你')));
  assert.ok(invitationHistory.some(message => message.speaker === 'user' && message.text.includes('我也想你了')));
  assert.match(invitation[triggerIndex].content, /本轮没有新的用户消息/);
  assert.equal(f.app.store.getMessages('miyue').filter(row => row.speaker === 'user').length, usersBefore);
});

test('session proactive can choose a fresh article and deliver its sourced topic', async t => {
  const f = await fixture(t, [], { random: () => 0.2 });
  const feed = f.app.store.addFeed('https://example.org/feed', '来源测试');
  f.app.store.addContent(feed, [{
    title: '城市步行路线开放新的河岸段',
    url: 'https://example.org/riverside-walk',
    summary: '这条新的河岸步行段连接两处公共广场，沿线增加了连续的树荫和休息座椅，也设置了无障碍入口。报道还提到，路线设计希望让附近居民有更多不必开车就能到达的公共空间。',
    publishedAt: NOW.toISOString(),
  }], '来源测试');
  const article = f.app.store.listContent().find(item => item.title === '城市步行路线开放新的河岸段');
  assert.ok(article);
  f.enqueue({ skip: false, message: '看到一段新开放的河岸步道，连着两处广场，还添了树荫和座椅。我觉得短途散步有这种歇脚处才舒服。', reason: '想聊聊城市里的短途步行', contentId: article.id, initiative:{state:'open',materialId:`source:${article.id}`,quote:'连着两处广场，还添了树荫和座椅'} });
  f.app.proactiveRepo.saveSettings({ enabled: true, activeStart: '00:00', activeEnd: '23:59', dailyLimit: 10, desktopNotifications: false });

  const delivered = await f.app.proactive.runNow({ roleId: 'miyue' });
  assert.equal(delivered.delivered, true, JSON.stringify({delivered,error:f.app.proactiveRepo.getRuntime().lastError}));
  assert.equal(f.app.proactiveRepo.recent()[0].kind, 'content');
  assert.equal(f.app.store.db.prepare('SELECT content_id FROM messages WHERE id=?').get(delivered.message.id)?.content_id, article.id);
  assert.match(contents(f.calls[0]), /先结合原话判断这次联系是否有助于当前交流/u);
  assert.match(contents(f.calls[0]), /城市步行路线开放新的河岸段/u);
});

test('session proactive format retry is system metadata and accepts the four-field envelope', async t => {
  const f = await fixture(t, [
    { skip: false, message: '想和你聊聊今天看到的书。' },
    { skip: false, contentId: null, reason: '继续最近的话题', message: '我刚想起书里的一句话，想和你聊聊。' },
  ]);
  f.app.proactiveRepo.saveSettings({ enabled: true, activeStart: '00:00', activeEnd: '23:59', dailyLimit: 10, desktopNotifications: false });
  const result = await f.app.proactive.runNow({ roleId: 'miyue' });
  assert.equal(result.delivered, true, JSON.stringify(result));
  assert.equal(f.calls.length, 2);
  const retry = f.calls[1].body.messages;
  assert.equal(retry.some(message => message.role === 'user'), false);
  const repair = retry.find(message => message.content.startsWith('【系统格式修复】'));
  assert.equal(repair?.role, 'system');
  assert.match(repair.content, /这不是用户发言/u);
  assert.match(repair.content, /extra 如需提供只能是字符串/u);
});

test('native history carries source receipts for visible messages without importing out-of-window material', async t => {
  const f = await fixture(t, [{ reply: '我读到的是订阅摘要，没读到全文。' }]);
  const feed=f.app.store.addFeed('https://example.org/feed','来源测试');
  f.app.store.addContent(feed,[{title:'白矮星冲击波',url:'https://example.org/star',summary:'研究者尚未解释冲击波的能量来源。',publishedAt:NOW.toISOString()},
    {title:'不应注入的旧来源',url:'https://example.org/old',summary:'OUTSIDE_WINDOW_SOURCE',publishedAt:NOW.toISOString()}],'来源测试');
  const sources=f.app.store.listContent();
  for(const [title,createdAt] of [['白矮星冲击波','2026-09-25T01:00:00Z'],['不应注入的旧来源','2026-08-01T01:00:00Z']]){
    const source=sources.find(item=>item.title===title);
    const rows=f.app.store.saveChatTurn({role:'miyue',text:'说说这个',reply:'这条消息还有未解释之处。',contentId:source.id});
    for(const row of rows)f.app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(createdAt,row.id);
  }
  const result=await f.request('/api/chat',{role:'miyue',text:'你读到的是摘要还是原文？'});
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.match(contents(f.calls[0]),/sourceReceipts/);
  assert.match(contents(f.calls[0]),/https:\/\/example.org\/star/);
  assert.match(contents(f.calls[0]),/订阅缓存摘录/);
  assert.doesNotMatch(contents(f.calls[0]),/OUTSIDE_WINDOW_SOURCE|https:\/\/example.org\/old/);
});

test('session persists its own feelings and supplies them to later turns with diagnostic costs and receipts',async t=>{
  const f=await fixture(t,[{reply:'我想把这件事慢慢想清楚。',dynamics:{feelings:[{id:'thinking',label:'挂念',intensity:35,description:'还在想这次设计',cause:'刚才聊到设计',evidence:'慢慢想清楚'}]}}]);
  const first=await f.request('/api/chat',{role:'miyue',text:'你对这次设计有什么感受？'});assert.equal(first.status,200);assert.equal(f.app.companionDynamics.get().feelings[0].id,'thinking');
  f.enqueue(({body})=>{assert.match(body.messages.map(m=>m.content).join('\n'),/挂念/);return {reply:'还在想那张设计，不过不急着定下来。'};});
  assert.equal((await f.request('/api/chat',{role:'miyue',text:'现在呢？'})).status,200);
  const diagnostics=await f.request('/api/dialogue-diagnostics');assert.equal(diagnostics.status,200);
  const trace=diagnostics.body.traces[0];assert.equal(trace.revisions.dynamics,1);assert.equal(trace.calls.length,1);assert.equal(trace.calls[0].usage.total_tokens,undefined);assert.equal(trace.calls[0].usage.prompt_tokens,30);
  assert.ok(diagnostics.body.history.rows.some(row=>row.speaker==='assistant'&&row.authorId==='miyue'&&row.text.includes('慢慢想清楚')));
});

test('emerging growth remains in original history without duplicating its diary in prompts and deletion removes derived proof',async t=>{
  const f=await fixture(t);const rows=f.app.store.saveChatTurn({role:'miyue',text:'聊聊你喜欢的颜色。',reply:'我喜欢灰蓝色，画面能留得清爽一点。'});
  const proof={messageId:rows[1].id,speaker:'assistant',quote:'我喜欢灰蓝色'};
  f.enqueue({diary:'今天聊到灰蓝色，我想继续试试这个配色。',evidence:[proof],items:[{id:'blue',kind:'interest',scope:'enduring',text:'偏好灰蓝色配色',evidence:[proof]}]});
  assert.equal((await f.request('/api/character-growth/reflect',{})).body.status,'recorded');
  f.enqueue(({body})=>{assert.doesNotMatch(contents({body}),/角色长期倾向|今天聊到灰蓝色，我想继续试试这个配色/);assert.match(contents({body}),/我喜欢灰蓝色，画面能留得清爽一点/);return {reply:'我之前说过自己喜欢灰蓝色。'};});
  assert.equal((await f.request('/api/chat',{role:'miyue',text:'你现在有什么配色偏好？'})).status,200);
  assert.equal(f.app.characterGrowth.get().reflections.length,1);
  f.app.historyDeletion.delete('miyue',[rows[1].id]);assert.equal(f.app.characterGrowth.get().reflections.length,0);assert.equal(f.app.characterGrowth.get().items.length,0);
});

test('proactive sends are observable as role-owned turns without manufacturing user speech',async t=>{
  const f=await fixture(t,[{skip:false,message:'我刚才想到那张画的留白，可以先保留一点空间。',reason:'接续',contentId:null,initiative:{state:'open',materialId:null,quote:''}}]);
  f.app.store.saveChatTurn({role:'miyue',text:'那张画先放一放。',reply:'好，我们慢慢来。'});
  f.app.proactiveRepo.saveSettings({enabled:true,dailyLimit:5,activeStart:'00:00',activeEnd:'23:59',desktopNotifications:false});
  const result=await f.app.proactive.runNow({roleId:'miyue'});assert.equal(result.delivered,true,JSON.stringify(result));
  const trace=f.app.dialogueTraces.list({roleId:'miyue'})[0];assert.equal(trace.trigger.type,'scheduled_opportunity');assert.equal(trace.mode,'session');assert.equal(trace.messageIds[0],result.message.id);assert.equal(trace.calls.length,1);
  assert.equal(f.app.store.getMessages('miyue').filter(m=>m.speaker==='user').length,1);
});
