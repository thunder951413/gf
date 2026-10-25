import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { historySourceHash } from '../lib/history-edits.mjs';

async function fixture(t, replies, { onModelRequest, semanticUnderstanding=false, dialogueMemory=false, clock, extraOptions={} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dynamic-companion-')); const calls = []; let index = 0;
  let app; app = await createApp({ ...extraOptions, dataDir, dynamicCompanion: true, startDiscovery: false, semanticUnderstanding, dialogueMemory, clock, initialFeeds: [], startWeixin: false, startChatQueue: false, startProactive: false, startRecall: false, startResearch: false, startLife: false, startRuntime: false, startLifeThreads: false, startPursuits: false, startDossiers: false, replySleep: async () => {}, env: { LIFE_MODEL_BASE_URL: 'https://fixture.test/v1', LIFE_MODEL_NAME: 'fixture' }, fetchImpl: async (_url, init) => { calls.push(JSON.parse(init.body)); await onModelRequest?.(app); return Response.json({ choices: [{ message: { content: JSON.stringify(replies[Math.min(index++, replies.length - 1)]) } }], usage: { prompt_tokens: 20, completion_tokens: 10 } }); } });
  app.preferences.setReplyPace('instant'); const { port } = await app.listen(0); const request = async (route, body) => { const response = await fetch(`http://127.0.0.1:${port}${route}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); let value; try { value = await response.json(); } catch { value = null; } return { status: response.status, body: value }; };
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); }); return { app, calls, request };
}

const reply = dynamics => ({ reply: '嗯。', signals: { tone: 'neutral', closeness: 'unspecified', evidence: '' }, experience: null, dynamics, groundedLife: null });

test('a prompt-origin question repairs a claim of independent feelings before saving a reply', async t => {
  const bad = '这些想法不是提示词给的，程序管不了我的心。';
  const good = '我是虚构角色。我说的愿望是模型结合设定、状态和你的话生成的，没有脱离程序独立存在的身体感受或欲望。';
  const f = await fixture(t, [{ reply: bad, dynamics: null }, { reply: good, dynamics: null }]);
  const result = await f.request('/api/chat', { role: 'miyue', text: '如果没有提示词让你回应，你自己的欲望是什么？' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.messages.at(-1).text, good);
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0].messages.map(row => row.content).join('\n'), /【本轮真实性问题】/);
  assert.match(f.calls[1].messages.at(-1).content, /没有独立于程序的身体感受/);
  assert.ok(!f.app.store.getMessages('miyue').some(row => row.text === bad));
});

test('two misleading drafts do not become a delivered answer', async t => {
  const bad = '这不是提示词的影响，是我自己真实的身体欲望。';
  const f = await fixture(t, [{ reply: bad, dynamics: null }]);
  const result = await f.request('/api/chat', { role: 'miyue', text: '这些欲望是提示词塑造的，还是你独立产生的？' });
  assert.equal(result.status, 502, JSON.stringify(result.body));
  assert.equal(f.calls.length, 2);
  assert.ok(!f.app.store.getMessages('miyue').some(row => row.speaker === 'assistant' && row.text === bad));
});

test('a correction repairs a repeated action even when its words are reversed', async t => {
  const bad = '好，我刚进门，脚一跺就把鞋上的水甩掉了。';
  const good = '好，我不再反复讲那个动作了。你躺着就好，我继续说刚才的事。';
  const f = await fixture(t, [{ reply: bad, dynamics: null }, { reply: good, dynamics: null }]);
  f.app.store.saveChatTurn({ role: 'miyue', text: '你到家了吗？', reply: '到了门口，鞋底沾了水。' });
  const result = await f.request('/api/chat', { role: 'miyue', text: '躺着呢，你不用一直说要跺一脚了，我知道了。' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.messages.at(-1).text, good);
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0].messages.map(row => row.content).join('\n'), /停止重复/);
  assert.match(f.calls[1].messages.at(-1).content, /完全省去这一细节/);
});

test('dynamic generation receives read-only repetition guidance while keeping model prose and call count',async t=>{
  const authored='想听你继续讲，我对你刚才那句话有点好奇。';
  const f=await fixture(t,[{reply:authored,dynamics:null}],{clock:()=>new Date('2026-09-21T02:00:00Z')});
  f.app.store.saveChatTurn({role:'miyue',text:'我想你',reply:'听到你这样说，我心里软了一下。'});
  f.app.store.saveChatTurn({role:'miyue',text:'真的',reply:'想到你，我心里软了一下。'});
  const result=await f.request('/api/chat',{role:'miyue',text:'我是真的想你'});
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(f.calls.length,1);
  assert.equal(result.body.messages.at(-1).text,authored);
  const prompt=f.calls[0].messages.map(row=>row.content).join('\n');
  assert.match(prompt,/这些表达已在不同回复中多次用过/);assert.match(prompt,/【避免重复】/);
  assert.match(prompt,/不设每轮字数或话题配额/);
});
test('an ordinary open turn can share fresh sourced material and persist the source only when spoken',async t=>{
  const now=new Date('2026-09-23T03:00:00Z');
  const decision={intent:'open',continuity:'new',focusMessageId:null,ownLife:false,needsCurrentState:false,advice:false,emotionalDetail:false,imagined:false,correction:false,acceptsOffer:false,source:'none',retrievalQuery:'',evidence:'',turnMeaning:'用户愿意轻松聊天。'};
  const url='https://example.test/reading';
  const f=await fixture(t,[decision,{reply:'我刚看到一篇谈阅读习惯的文章，里面提到有人会把读到一半的疑问记在页边。来源：'+url,dynamics:null},decision,{reply:'嗯，我还想听听你怎么想。',dynamics:null}],{semanticUnderstanding:true,clock:()=>now,extraOptions:{random:()=>.8}});
  const feed=f.app.store.addFeed('https://example.test/feed','测试来源');
  f.app.store.addContent(feed,[{title:'在书页边记下阅读时的疑问',url,publishedAt:'2026-09-22T12:00:00Z',summary:'这篇文章记录几位读者在书页边写下疑问的习惯。有的人把不理解的地方先做标记，读完后再回看；也有人记录当时的联想和不同意见，让第二次阅读可以看到自己的想法怎样变化。'}],'测试来源');
  const result=await f.request('/api/chat',{role:'miyue',text:'我们聊会儿。'});
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(f.calls.length,2,'selection reuses the existing semantic and reply calls');
  assert.match(f.calls[1].messages.map(row=>row.content).join('\n'),/在书页边记下阅读时的疑问|可选主动性/);
  assert.equal(result.body.messages.at(-1).sourceUrl,url);
  assert.equal(f.app.store.getRecentContent('miyue',1)?.url,url);
  assert.equal(f.app.interactionPolicy.receipt(result.body.messages.at(-1).id).behavior.spontaneousIntroduced,'source');
  const next=await f.request('/api/chat',{role:'miyue',text:'嗯。'});
  assert.equal(next.status,200,JSON.stringify(next.body));
  assert.doesNotMatch(f.calls[3].messages.map(row=>row.content).join('\n'),/【普通聊天的可选主动性】/);
});

test('dynamic chat is one model-led request, saves only reply prose, and carries stable causal state forward', async t => {
  const dynamics = { feelings: [{ id: 'quiet-miss', label: '想念', intensity: 61, description: '想再多待一会儿', cause: '听到你说晚点见', evidence: '我也想再多待一会儿' }], threads: [{ id: 'book-thread', subject: '那本书', progress: '你说已经读到第三章', openQuestion: '还想听你的感受', status: 'open', evidence: '第三章' }] };
  const f = await fixture(t, [{...reply(dynamics),reply:'听你说晚点见，我也想再多待一会儿。'}, reply(null)]);
  const first = await f.request('/api/chat', { role: 'miyue', text: '晚点见，我已经读到第三章了。' }); assert.equal(first.status, 200, JSON.stringify(first.body)); assert.equal(first.body.messages.at(-1).text, '听你说晚点见，我也想再多待一会儿。'); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].messages.at(-1).content, '晚点见，我已经读到第三章了。'); assert.doesNotMatch(first.body.messages.at(-1).text, /第三章|dynamics/);
  const state = f.app.companionDynamics.get(); assert.equal(state.revision, 1); assert.equal(state.feelings[0].id, 'quiet-miss'); assert.equal(state.feelings[0].cause, '听到你说晚点见');
  const second = await f.request('/api/chat', { role: 'miyue', text: '继续说吧。' }); assert.equal(second.status, 200); assert.equal(f.calls.length, 2); const prompt = f.calls[1].messages.map(row => row.content).join('\n'); assert.match(prompt, /quiet-miss/); assert.match(prompt, /book-thread/); assert.match(prompt, /听到你说晚点见/);
});

test('malformed optional state does not fail a valid reply; API settings are atomic and unconfigured discovery costs nothing', async t => {
  const f = await fixture(t, [reply('not-an-object')]); const chat = await f.request('/api/chat', { role: 'miyue', text: '好。' }); assert.equal(chat.status, 200); assert.equal(chat.body.messages.at(-1).text, '嗯。'); assert.equal(f.app.companionDynamics.get().revision, 0);
  const before = await f.request('/api/companion-dynamics'); assert.equal(before.status, 200); const saved = await f.request('/api/companion-dynamics', { revision: before.body.settings.revision, city: '杭州', dailyDiscoveryCalls: 3 }); assert.equal(saved.status, 200); assert.equal(saved.body.settings.city, '杭州'); const stale = await f.request('/api/companion-dynamics', { revision: 0, city: '南京' }); assert.equal(stale.status, 409);
  const discovery = await f.request('/api/companion-dynamics/discover', {}); assert.equal(discovery.status, 200); assert.equal(discovery.body.life.daily.calls, 0); assert.equal(discovery.body.life.daily.tokens, 0); assert.equal(f.calls.length, 1);
});

test('ordinary story mode retains normal dialogue and cannot commit dynamic annotations', async t => {
  const f = await fixture(t, [reply({ feelings: [{ id: 'no-story', label: '不会保存', intensity: 10, description: '普通剧情', cause: '剧情', evidence: '嗯' }] })]); const result = await f.request('/api/chat', { role: 'miyue', text: '嗯', storyMode: true }); assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(f.app.companionDynamics.get().revision, 0); assert.equal(f.calls.length, 1); assert.doesNotMatch(f.calls[0].messages.map(row => row.content).join('\n'), /伴侣动态数据/);
});

test('dynamic proactive delivery saves its own evidenced state without old-style additions and exposes it on the next turn', async t => {
  const proactive = { skip: false, contentId: null, reason: '想自然说一句', message: '我刚把那本书的第三章合上。', dynamics: { threads: [{ id: 'proactive-book', subject: '那本书', progress: '刚合上第三章', openQuestion: '', status: 'open', evidence: '第三章' }] }, groundedLife: null };
  const f = await fixture(t, [proactive, reply(null)]); f.app.proactiveRepo.saveSettings({ enabled: true, activeStart: '00:00', activeEnd: '23:59', dailyLimit: 10, desktopNotifications: false });
  const delivered = await f.app.proactive.runNow({ roleId: 'miyue' }); assert.equal(delivered.delivered, true, JSON.stringify(delivered)); assert.equal(delivered.message.text, '我刚把那本书的第三章合上。'); assert.doesNotMatch(delivered.message.text, /【|dynamics|想自然说一句/); assert.equal(f.app.companionDynamics.get().threads[0].id, 'proactive-book');
  const chat = await f.request('/api/chat', { role: 'miyue', text: '你刚才读到哪了？' }); assert.equal(chat.status, 200); const nextPrompt = f.calls.at(-1).messages.map(row => row.content).join('\n'); assert.match(nextPrompt, /proactive-book/); assert.match(nextPrompt, /刚合上第三章/);
});

test('a reply to her proactive black-hole topic repairs a reversed topic attribution', async t => {
  const proactive={skip:false,contentId:null,reason:'想聊星星',message:'脑子里还挂着昨晚跟你说的黑洞那事。刚才抬头看星星，忽然觉得时空的尺度很奇妙。',dynamics:null,groundedLife:null};
  const semantic={intent:'user_update',continuity:'continue',focusMessageId:'r1',ownLife:false,needsCurrentState:false,advice:false,emotionalDetail:false,imagined:false,correction:false,acceptsOffer:false,source:'none',retrievalQuery:'',evidence:'你还真是感性的人呢',memoryRefs:[],turnMeaning:'用户回应助手刚说的黑洞与星星，并表达自己觉得人很渺小。'};
  const bad='你今天怎么忽然接这个的，是刚练完，还是走在路上抬头看了一眼？';
  const good='是啊，想到时空这么大，人会觉得渺小。我刚才自己提起黑洞和星星，也是因为抬头那一下忽然安静了。';
  const f=await fixture(t,[proactive,semantic,{reply:bad,dynamics:null},{reply:good,dynamics:null}],{semanticUnderstanding:true,clock:()=>new Date('2026-09-23T03:13:47Z')});
  f.app.proactiveRepo.saveSettings({enabled:true,activeStart:'00:00',activeEnd:'23:59',dailyLimit:10,desktopNotifications:false});
  const delivered=await f.app.proactive.runNow({roleId:'miyue'});
  assert.equal(delivered.delivered,true,JSON.stringify(delivered));
  const result=await f.request('/api/chat',{role:'miyue',text:'你还真是感性的人呢，看星星想想时空的尺度，确实是让人平静，我们实在是太渺小了。'});
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.equal(result.body.messages.at(-1).text,good);
  assert.equal(f.calls.length,4);
  assert.match(f.calls[2].messages.map(row=>row.content).join('\n'),/【本轮话题归属】.*你主动发出/);
  assert.match(f.calls[3].messages.map(row=>row.content).join('\n'),/用户是在回应你紧邻的上一条消息/);
});

test('a history correction made while a dynamic reply is generated rejects the stale projected context', async t => {
  let revised = false;
  const f = await fixture(t, [reply(null)], { onModelRequest: app => {
    if (revised) return;
    revised = true;
    const prior = app.store.getMessages('miyue').findLast(row => row.speaker === 'assistant');
    app.historyEdits.set('miyue', [{ id: prior.id, sourceHash: historySourceHash(prior.text), keptSpans: [], reason: '在生成期间恢复历史投影' }]);
  } });
  f.app.store.saveChatTurn({ role: 'miyue', text: '之前的话', reply: '一段需要修订的旧回复。' });
  const result = await f.request('/api/chat', { role: 'miyue', text: '接着聊。' });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.code, 'STALE_HISTORY_EDITS');
});

test('model-authored turn meaning and the actual historical focus reach dynamic generation with elapsed time', async t => {
  let now=new Date('2026-09-20T03:29:00Z');
  const input='我觉得你说的很对，事物发展都是多个因素在影响';
  const semantic={intent:'user_update',continuity:'continue',focusMessageId:'r1',ownLife:false,needsCurrentState:false,advice:false,emotionalDetail:false,imagined:false,correction:false,acceptsOffer:false,source:'none',retrievalQuery:'',evidence:'我觉得你说的很对',memoryRefs:[],turnMeaning:'用户在回应助手提出的观点，不是在报告一件自己的新经历。',replyDirection:'回应他的认可，再补充自己对多种原因的看法，不另起工作近况。'};
  const f=await fixture(t,[semantic,{reply:'是呀，同一个结果背后可能有不同原因。',dynamics:null}],{semanticUnderstanding:true,dialogueMemory:true,clock:()=>new Date(now)});
  const rows=f.app.store.saveChatTurn({role:'miyue',text:'说说你的想法。',reply:'刚在桥上看水，想到一次结果不能当规律。'});
  now=new Date('2026-09-20T06:26:00Z');
  const result=await f.request('/api/chat',{role:'miyue',text:input});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(f.calls.length,2);
  const messages=f.calls[1].messages;assert.equal(messages.at(-1).content,input);
  const block=messages.find(row=>row.content.startsWith('【眼前交流的定位'));
  const data=JSON.parse(block.content.slice(block.content.indexOf('】')+1).split('\n焦点')[0]);
  assert.equal(data.interpretation.meaning,semantic.turnMeaning);assert.equal(data.interpretation.replyDirection,undefined);assert.doesNotMatch(JSON.stringify(messages),new RegExp(semantic.replyDirection));assert.equal(data.focus.id,rows.at(-1).id);assert.equal(data.focus.ageMinutes,177);assert.match(data.focus.text,/桥上看水/);
  const facts=messages.find(row=>row.content.startsWith('【当前事实数据'));assert.match(facts.content,new RegExp(rows.at(-1).id));
  const world=JSON.parse(facts.content.slice(facts.content.indexOf('】')+1)).world;assert.equal(world.feelings,undefined);assert.equal(world.needs,undefined);assert.equal(world.traits,undefined);assert.ok(world.location);
  const trace=await f.request('/api/dialogue-traces?role=miyue&limit=1');assert.equal(trace.body.traces[0].dynamicsStatus,'unchanged');assert.equal(trace.body.traces[0].semantic.meaningChars,semantic.turnMeaning.length);
});

test('final HTTP model requests receive canonical affection, quiet, and close purposes',async t=>{
  const semantic=(text,extra)=>({intent:'respond',continuity:'new',focusMessageId:null,ownLife:false,needsCurrentState:false,advice:false,emotionalDetail:false,imagined:false,correction:false,acceptsOffer:false,source:'none',retrievalQuery:'',evidence:text,memoryRefs:[],turnMeaning:text,...extra});
  const f=await fixture(t,[
    semantic('想你了',{intent:'affection'}),reply(null),
    semantic('陪我安静待会儿'),reply(null),
    semantic('我先睡了，晚安',{intent:'close'}),reply(null),
  ],{semanticUnderstanding:true});
  for(const text of ['想你了','不用找话题，陪我安静待会儿','我先睡了，晚安']){
    const result=await f.request('/api/chat',{role:'miyue',text});assert.equal(result.status,200,JSON.stringify(result.body));
  }
  assert.equal(f.calls.length,6);
  const authored=[1,3,5].map(index=>f.calls[index].messages.map(row=>row.content).join('\n'));
  assert.match(authored[0],/【本轮唯一交流目的】/);assert.match(authored[0],/亲近与想念/);
  assert.match(authored[1],/安静陪伴/);assert.match(authored[1],/不展开新话题或追问/);
  assert.match(authored[2],/【本轮唯一交流目的】/);assert.match(authored[2],/回应用户这次道别/);
});

test('an omitted state annotation is observable without an extra generation or a fabricated emotional change',async t=>{
  const f=await fixture(t,[{reply:'对，是我刚才问岔了。'}],{dialogueMemory:true});
  const result=await f.request('/api/chat',{role:'miyue',text:'这话不是你跟我说的么'});assert.equal(result.status,200);assert.equal(f.calls.length,1);assert.equal(f.app.companionDynamics.get().revision,0);
  const trace=await f.request('/api/dialogue-traces?role=miyue&limit=1');assert.equal(trace.body.traces[0].dynamicsStatus,'omitted');
});

test('social plans persist across days, cancel with the same people, and need no additional model call', async t => {
  let now = new Date('2026-09-20T11:00:00Z');
  const plan = '我和小郁约了明晚吃饭，还要等她确认下班时间。';
  const cancellation = '小郁今天临时加班，我们那顿饭先取消了。';
  const f = await fixture(t, [
    { reply: plan, social: { events: [{ id: 'dinner-yu', personIds: ['xiaoyu'], text: plan, status: 'planned', at: '2026-09-21T11:00:00Z' }] } },
    { reply: cancellation, social: { events: [{ id: 'dinner-yu', personIds: ['xiaoyu'], text: cancellation, status: 'cancelled', at: null }] } },
    { reply: '和小郁那顿饭取消了，还没有重新约。' },
  ], { clock: () => new Date(now) });
  assert.equal((await f.request('/api/chat', { role: 'miyue', text: '你和小郁有什么安排？' })).status, 200);
  assert.equal(f.app.companionSocial.get().events[0].status, 'planned');
  now = new Date('2026-09-22T11:00:00Z');
  assert.equal(f.app.companionSocial.get().events[0].status, 'planned', 'elapsed time alone must not complete a plan');
  const second = await f.request('/api/chat', { role: 'miyue', text: '小郁那边后来怎么说？' });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(f.app.companionSocial.get().events[0].status, 'cancelled');
  now = new Date('2026-10-02T11:00:00Z');
  assert.equal((await f.request('/api/chat', { role: 'miyue', text: '小郁那顿饭后来吃了吗？' })).status, 200);
  const block = f.calls.at(-1).messages.find(row => row.content.includes('dinner-yu'));
  assert.ok(block); assert.match(block.content, /cancelled/);
  assert.equal(f.calls.length, 3);
  const snapshot = await f.request('/api/companion-dynamics');
  assert.equal(snapshot.body.social.people.length, 4);
  assert.equal(snapshot.body.social.events[0].personIds[0], 'xiaoyu');
});

test('social facts must come from her saved reply and corrected sources disappear from subsequent context', async t => {
  const statement = '小郁这周在忙工作，等她空下来再联系。';
  const f = await fixture(t, [
    { reply: statement, social: { notes: [{ id: 'yu-work', personId: 'xiaoyu', text: statement, status: 'active' }] } },
    { reply: '嗯，你妈妈最近挺忙的。', social: { notes: [{ id: 'bad-user-mother', personId: 'mother', text: '我妈妈最近忙着搬办公室', status: 'active' }] } },
    { reply: '小郁是我的朋友。' },
  ]);
  const saved = await f.request('/api/chat', { role: 'miyue', text: '小郁近况怎么样？' }); assert.equal(saved.status, 200);
  const row = saved.body.messages.findLast(item => item.speaker === 'assistant');
  assert.equal(f.app.companionSocial.get().notes.length, 1);
  assert.equal((await f.request('/api/chat', { role: 'miyue', text: '我妈妈最近忙着搬办公室' })).status, 200);
  assert.equal(f.app.companionSocial.get().notes.length, 1, 'user family evidence cannot become a character fact');
  f.app.historyEdits.set('miyue', [{ id: row.id, sourceHash: historySourceHash(row.text), keptSpans: [], reason: '撤下未经确认的朋友近况' }]);
  assert.equal(f.app.companionSocial.get().notes.length, 0);
  assert.equal((await f.request('/api/chat', { role: 'miyue', text: '小郁最近怎么样？' })).status, 200);
  assert.doesNotMatch(f.calls.at(-1).messages.map(item => item.content).join('\n'), /小郁这周在忙工作/);
  assert.equal(f.calls.length, 3);
});

test('proactive social sharing persists and invalid optional social data never blocks an otherwise valid reply', async t => {
  const text = '妈妈今天说家里的花开了，我听了有点开心。';
  const f = await fixture(t, [
    { skip: false, contentId: null, reason: '想分享家里近况', message: text, social: { notes: [{ id: 'mother-flowers', personId: 'mother', text, status: 'active' }] } },
    { reply: '嗯。', social: 'invalid' },
  ]);
  f.app.proactiveRepo.saveSettings({ enabled: true, activeStart: '00:00', activeEnd: '23:59', dailyLimit: 10, desktopNotifications: false });
  const result = await f.app.proactive.runNow({ roleId: 'miyue' });
  assert.equal(result.delivered, true, JSON.stringify(result));
  assert.equal(f.app.companionSocial.get().notes[0].personId, 'mother');
  assert.equal((await f.request('/api/chat', { role: 'miyue', text: '嗯，挺好。' })).status, 200);
  assert.equal(f.calls.length, 2);
});

test('ordinary family contact enters private social continuity through runtime without a model request', async t => {
  let now = new Date('2026-09-20T11:00:00Z');
  const catalog = [{ id: 'mother-call', kind: 'family_chat', title: '和妈妈通电话', participants: ['妈妈'], location: '苏州的家中', phases: [
    { id: 'doing', label: '通话中', detail: '正在和妈妈通电话，具体内容尚未记录。', durationMs: 20 * 60000 },
    { id: 'recent', label: '最近的联系', detail: '和妈妈这次通话已经结束。', durationMs: 86400000 },
  ] }];
  const f = await fixture(t, [reply(null)], { clock: () => new Date(now), extraOptions: { dailyLifeCatalog: catalog, runtimeRandom: () => 0, dailyLifeRandom: () => 0, lifeRandom: () => .99 } });
  f.app.companionRuntime.advance();
  const first = f.app.companionSocial.get();
  assert.equal(first.events.length, 1); assert.equal(first.events[0].shared, false);
  assert.equal(first.events[0].status, 'ongoing'); assert.equal(f.calls.length, 0);
  f.app.companionRuntime.advance(); assert.equal(f.app.companionSocial.get().revision, first.revision);
  const selected=f.app.roleContext('miyue',{initiating:true});
  assert.match(selected.dynamicOptions.materialContext,/正在和妈妈通电话/);
  assert.equal(selected.dynamicOptions.turnPlan.selectedOpportunity.kind,'material');
  assert.ok(selected.dynamicOptions.turnPlan.selectedOpportunity.key);
  assert.equal(selected.dynamicOptions.facts.dailyLife.length,1);
  const ordinary=f.app.roleContext('miyue',{initiating:false,text:'代码跑通了',semantic:{intent:'answer',ownLife:false,needsCurrentState:false,source:'none'}});
  assert.deepEqual(ordinary.dynamicOptions.facts.dailyLife,[]);
  assert.equal(ordinary.dynamicOptions.materialContext,'');
  now = new Date('2026-09-20T11:30:00Z'); f.app.companionRuntime.advance();
  const later = f.app.companionSocial.get().events[0];
  assert.equal(later.status, 'occurred'); assert.equal(later.shared, false); assert.equal(f.calls.length, 0);
});

test('concurrent relationship-memory changes invalidate a draft before it is saved', async t => {
  let source, changed = false;
  const f = await fixture(t, [reply(null)], { onModelRequest: app => {
    if (changed) return; changed = true;
    app.companionSocial.importHistory([{ personId: 'xiaoyu', messageId: source.id, text: source.text }]);
  } });
  source = f.app.store.saveChatTurn({ role: 'miyue', text: '以前呢？', reply: '我以前和小郁一起听过歌。' }).at(-1);
  const result = await f.request('/api/chat', { role: 'miyue', text: '继续。' });
  assert.equal(result.status, 409, JSON.stringify(result.body)); assert.equal(result.body.code, 'STALE_COMPANION_SOCIAL');
});

test('an agreed family visit enters her own itinerary without asking the user to accept and respects corrected evidence', async t => {
  let now = new Date('2026-09-20T10:00:00Z');
  const text = '我已经和妈妈约好明晚回苏州父母家吃饭，留一个小时。';
  const f = await fixture(t, [{ reply:text, companionship:{agenda:[{id:'mother-dinner',action:'arrange',source:'assistant',owner:'character',kind:'outing',title:'回苏州父母家吃饭',location:'苏州父母家',dueAt:'2026-09-21T10:00:00Z',durationMinutes:60,evidence:text}]}, social:{events:[{id:'mother-dinner',personIds:['mother'],text,status:'planned',at:'2026-09-21T10:00:00Z'}]} }], {clock:()=>new Date(now)});
  const result = await f.request('/api/chat',{role:'miyue',text:'最近有什么安排？'});
  assert.equal(result.status,200,JSON.stringify(result.body));
  const plan = f.app.companionAgenda.view('miyue').plans.find(item=>item.id==='mother-dinner');
  assert.equal(plan.owner,'character');assert.equal(plan.status,'planned');assert.equal(plan.location,'苏州父母家');
  now = new Date('2026-09-21T10:10:00Z');
  assert.equal(f.app.companionRuntime.advance().current.location,'苏州父母家');
  assert.equal(f.app.companionSocial.get().events[0].status,'planned','starting an itinerary is not evidence of having completed a meeting');
  const source=result.body.messages.findLast(item=>item.speaker==='assistant');
  f.app.historyEdits.set('miyue',[{id:source.id,sourceHash:historySourceHash(source.text),keptSpans:[],reason:'撤下失效安排'}]);
  assert.equal(f.app.companionAgenda.view('miyue').plans.length,0);assert.equal(f.app.companionSocial.get().events.length,0);
  assert.notEqual(f.app.companionRuntime.advance().current.location,'苏州父母家');assert.equal(f.calls.length,1);
});

test('social history verification uses the relevant person records and cannot save newly invented outcomes', async t => {
  const semantic={intent:'recall',continuity:'new',focusMessageId:null,ownLife:true,needsCurrentState:false,advice:false,emotionalDetail:false,imagined:false,correction:false,acceptsOffer:false,source:'none',retrievalQuery:'阿澜 看展',evidence:'阿澜之前约的展',memoryRefs:[]};
  const invented='阿澜临时有事，展没去成。';
  const f=await fixture(t,[semantic,{reply:invented,social:{notes:[{id:'invented',personId:'alan',text:invented,status:'active'}]},dynamics:{threads:[{id:'also-invented',subject:'阿澜看展',progress:invented,openQuestion:'',status:'resolved',evidence:invented}]}}],{semanticUnderstanding:true,dialogueMemory:true,clock:()=>new Date('2026-09-20T11:00:00Z')});
  f.app.store.saveChatTurn({role:'miyue',text:'随便聊聊。',reply:'我在桥上想起一个完全无关的旧故事。'});
  const source=f.app.store.saveChatTurn({role:'miyue',text:'你有什么安排？',reply:'阿澜约我明天去看展。'}).at(-1);
  f.app.companionSocial.commit({social:{events:[{id:'alan-plan',personIds:['alan'],text:source.text,status:'planned',at:null}]}},{rows:[source],expectedRevision:f.app.companionSocial.get().revision});
  const result=await f.request('/api/chat',{role:'miyue',text:'阿澜之前约的展已经去过了吗？'});
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(f.calls.length,2);
  const prompt=f.calls[1].messages.map(row=>row.content).join('\n');
  assert.match(prompt,/alan-plan/);assert.match(prompt,/保留结果未知/);
  assert.doesNotMatch(prompt,/完全无关的旧故事|阿澜约我周六去看展|可补充自己的虚构经历/);
  assert.equal(f.app.companionSocial.get().notes.length,0);assert.equal(f.app.companionDynamics.get().threads.length,0);
  assert.equal(f.app.companionSocial.get().events[0].status,'planned');
});
