import { testRoles } from './support/role-fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { historySourceHash } from '../lib/history-edits.mjs';

const clock = () => new Date('2026-09-11T03:00:00.000Z');
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('a new personal opening supersedes an older article when a pronoun follows it',async t=>{
  const f=await fixture(t,[{reply:'叫年糕，最爱挤在小纸箱里。',extra:''}]);
  const feed=f.app.store.addFeed('https://example.test/games','游戏');
  f.app.store.addContent(feed,[{title:'旧游戏资料独有标记',url:'https://example.test/game',summary:'一款多人合作做饭游戏的详细资料。'.repeat(20)}],feed.title);
  const item=f.app.store.listContent()[0];
  f.app.store.saveChatTurn({role:'miyue',text:'最近有什么游戏',reply:'看到一款做饭游戏。',contentId:item.id});
  f.app.store.saveChatTurn({role:'miyue',text:'',reply:'我帮朋友照顾一只橘猫，叫年糕，刚才它挤进了小纸箱。'});
  const result=await f.chat('它叫什么？你觉得它哪里最有意思？');
  assert.equal(result.status,200,JSON.stringify(result));
  const request=JSON.stringify(f.calls.at(-1));assert.doesNotMatch(request,/旧游戏资料独有标记/);
  assert.equal(f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior.turnPlan.mode,'continue');
  assert.match(result.messages.at(-1).text,/年糕/);
});

test('actual model requests retrieve an old character memory only when its topic is asked for',async t=>{
  const f=await fixture(t,[{reply:'回到北京啦。',extra:''},{reply:'绿金包装的那版已经改完了。',extra:''}]);
  f.app.store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)').run('old-ledger-work','miyue','assistant','绿金包装的那版改完了，留了一道记忆独有弧线。','chat','2026-08-01T01:00:00.000Z');
  const row=f.app.store.db.prepare('SELECT rowid,* FROM messages WHERE id=?').get('old-ledger-work');
  f.app.recallRepo.consolidated.apply('miyue',{expectedRevision:0,fromCursor:row.rowid-1,through:{rowid:row.rowid,id:row.id},rows:[row],candidates:[{subject:'character',kind:'event',topic:'绿金包装',summary:row.text,status:'completed',evidence:[{messageId:row.id,quote:row.text}]}],ignored:[],now:clock().toISOString(),model:'test'});
  for(let i=0;i<10;i++)f.app.store.saveChatTurn({role:'miyue',text:'聊聊眼前的事。',reply:'好。'});
  let result=await f.chat('我到北京了。');assert.equal(result.status,200,JSON.stringify(result));
  assert.doesNotMatch(JSON.stringify(f.calls.at(-1)),/记忆独有弧线/);
  result=await f.chat('你之前那版绿金包装怎么样了？');assert.equal(result.status,200,JSON.stringify(result));
  assert.match(JSON.stringify(f.calls.at(-1)),/记忆独有弧线/);
  assert.equal(f.app.store.getMessage(row.id).text,row.text);
});

test('unrelated replies get coarse continuity while a direct question restores the exact same runtime details',async t=>{
  const f=await fixture(t,[{reply:'回到熟悉的城市了。',extra:''},{reply:'我在处理手头的设计。',extra:''}]);
  const prepare=f.app.companionRuntime.prepare.bind(f.app.companionRuntime);
  f.app.companionRuntime.prepare=(...args)=>{const value=prepare(...args);return {...value,
    current:{...value.current,kind:'work',title:'工作细节唯一标记：修订茶叶盒的绿色配比'},
    next:{...value.next,title:'未来晚饭唯一标记：煮番茄面'},
    world:{...value.world,activity:'工作细节唯一标记：修订茶叶盒的绿色配比'},
  };};
  let result=await f.chat('快要降落啦，我到北京了。');assert.equal(result.status,200,JSON.stringify(result));
  let input=JSON.stringify(f.calls.at(-1));
  assert.doesNotMatch(input,/工作细节唯一标记|未来晚饭唯一标记/);
  assert.match(input,/工作时段|地点：/);
  assert.equal(f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior.turnPlan.lifeParticipation.mode,'respond');
  const messages=f.calls.at(-1).messages;
  const planIndex=messages.findIndex(m=>m.content.includes('【本轮对话计划】'));
  assert.ok(planIndex>messages.findLastIndex(m=>m.role==='assistant'));
  assert.equal(messages.filter(m=>m.content.includes('【本轮对话计划】')).length,1);
  assert.equal(messages.at(-1).content,'快要降落啦，我到北京了。');
  const state=f.app.roleContext('miyue',{initiating:false,text:'我到了'}).runtime;
  assert.match(state.world.activity,/工作细节唯一标记/,'runtime is retained independently of prompt selection');
  result=await f.chat('你现在在做什么？');assert.equal(result.status,200,JSON.stringify(result));
  input=JSON.stringify(f.calls.at(-1));assert.match(input,/工作细节唯一标记/);assert.match(input,/未来晚饭唯一标记/);
  assert.equal(f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior.turnPlan.lifeParticipation.mode,'answer');
});

test('a change of routine does not reset the recent reporting load; a direct dinner question still works',async t=>{
  const f=await fixture(t,[{reply:'回家了。我这边面刚盛出来。',extra:''},{reply:'我这边晚饭准备煮面，加点青菜。',extra:''}]);
  f.app.store.saveChatTurn({role:'miyue',text:'嗯。',reply:'我这边包装还差一点。'});
  f.app.store.saveChatTurn({role:'miyue',text:'好的。',reply:'我这边碗还没洗。'});
  const prepare=f.app.companionRuntime.prepare.bind(f.app.companionRuntime);
  f.app.companionRuntime.prepare=(...args)=>{const v=prepare(...args);return {...v,current:{...v.current,startedAt:clock().toISOString()}};};
  let result=await f.chat('我快到家了。');assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(f.calls.length,1);assert.doesNotMatch(result.messages.at(-1).text,/面刚盛出来/);
  assert.ok(f.app.interactionPolicy.receipt(result.messages.at(-1).id).repairs.includes('omitted_optional_life_aside'));
  result=await f.chat('你晚饭准备吃什么？');assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(f.calls.length,2);assert.match(result.messages.at(-1).text,/准备煮面/);
});

test('imagined closeness reaches the actual request and permits a hypothetical posture without inventing past meetings', async t => {
  const reply='如果你在旁边，我会给你留个位置，头靠着你肩膀，想多待一会儿。';
  const f=await fixture(t,[{reply,extra:''}]);
  const result=await f.chat('假如现在能抱着你，你会怎样靠近我？');
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.calls.length,1);
  assert.equal(result.messages.at(-1).text,reply);
  const receipt=f.app.interactionPolicy.receipt(result.messages.at(-1).id);
  assert.equal(receipt.behavior.turnPlan.understanding.reality,'imagined');
  assert.equal(receipt.behavior.turnPlan.preferences.suppressInitiatedAffection,false);
  assert.match(JSON.stringify(f.calls[0]),/不是一次需要核实的现实接触/);
  assert.ok(f.app.companionBehavior.assess('我们昨天见面的时候抱了好久。','',{behavior:receipt.behavior}).includes('invented_offline_presence'));
});

test('sharing an update and asking for help get different permissions through the HTTP pipeline', async t => {
  const f=await fixture(t,[{reply:'按完轻松的那一会儿确实舒服。',extra:''},{reply:'你可以试试把需要的东西列出来。',extra:''}]);
  let result=await f.chat('我刚按摩完，挺舒服。');
  assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior.turnPlan.preferences.noAdvice,true);
  result=await f.chat('明天出门不知道怎么准备，给我一些建议。');
  assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior.turnPlan.understanding.kind,'help');
  assert.equal(f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior.turnPlan.preferences.noAdvice,false);
  assert.match(result.messages.at(-1).text,/可以试试/);
});

test('a correction preserves the stated discussion and prevents invented hidden motives', async t => {
  const f=await fixture(t,[{reply:'你其实是怕被误会。我认为解释也可以只是为了把意思说清楚。',extra:''}]);
  const result=await f.chat('我是顺着上面讨论的，不是在说我遇到了误会。');
  assert.equal(result.status,200,JSON.stringify(result));
  assert.doesNotMatch(result.messages.at(-1).text,/你其实/);
  assert.match(result.messages.at(-1).text,/把意思说清楚/);
  const plan=f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior.turnPlan;
  assert.equal(plan.understanding.correction,true);assert.equal(plan.preferences.noAnalysis,true);
});

test('a named callback retains its source and the rest of the recent window after many topic changes', async t => {
  const f=await fixture(t,[{reply:'对，我们讲的是把意思说明白，不一定非得争出输赢。',extra:''}]);
  f.app.store.saveChatTurn({role:'miyue',text:'人和人之间有误解需要解释，是想让对方知道自己讲道理。',reply:'旧话题唯一标记：解释是在澄清意思，不一定是想争赢。'});
  for(let i=0;i<20;i++)f.app.store.saveChatTurn({role:'miyue',text:`无关间隔${i}：这件衣服的颜色好看。`,reply:`我们正在看衣服，这是间隔${i}。`});
  const result=await f.chat('刚才说到的人和人之间的解释，你怎么看？');
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.calls.length,1);
  assert.match(JSON.stringify(f.calls[0]),/旧话题唯一标记/);
  assert.match(JSON.stringify(f.calls[0]),/无关间隔0/);
});

test('an ordinary travel update does not authorize dismissing the user', async t => {
  const f=await fixture(t,[{reply:'回家这段路我插不上什么，你自己待着吧。',extra:''},{reply:'终于往家的方向走了。我每次返程都会先想到家里那张沙发。',extra:''}]);
  const result=await f.chat('我准备进安检了，等会坐飞机回家。');
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.calls.length,2);
  assert.doesNotMatch(result.messages.at(-1).text,/自己待着/);
  assert.match(result.messages.at(-1).text,/家里那张沙发/);
});

test('inner feeling detail keeps room to elaborate and resets its imaginary frame on a topic change', async t => {
  const f=await fixture(t,[{reply:'我会先靠在你肩上，想安静待一会儿。',extra:''},{reply:'我想把刚才没好意思说的那句话告诉你。',extra:''},{reply:'嗯，回家的路上了。',extra:''}]);
  f.app.interactionPolicy.set('miyue',{noAnalysis:true});
  await f.chat('梦里想抱着你。');
  let result=await f.chat('我想知道你自己的念头和感受。');
  assert.equal(result.status,200,JSON.stringify(result));
  const plan=f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior.turnPlan;
  assert.equal(plan.understanding.emotionalDetail,true);assert.equal(plan.understanding.reality,'imagined');
  assert.ok(plan.budget.replyChars>=180);
  assert.match(JSON.stringify(f.calls.at(-1)),/不限制你表达自己的内心/);
  result=await f.chat('我准备进安检了。');
  assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior.turnPlan.understanding.reality,'unspecified');
});

test('expression history uses reviewed assistant text in the real request without another model call', async t => {
  const f=await fixture(t,[{reply:'你还记着这件事，我想把昨天没说完的小念头也告诉你。',extra:''}]);
  f.app.store.saveChatTurn({role:'miyue',text:'我来了。',reply:'心里有点软。'});
  const rows=f.app.store.saveChatTurn({role:'miyue',text:'又来找你啦。',reply:'心里还是软了一下。'});
  let context=f.app.roleContext('miyue',{text:'你好呀。'});
  assert.match(context.expressionHistory.context,/心里软（2次）/);
  const result=await f.chat('你好呀，今天想和你聊两句。');
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.calls.length,1);
  assert.match(JSON.stringify(f.calls[0]),/近期表达记忆/);
  const assistant=rows.at(-1);
  f.app.historyEdits.set('miyue',[{id:assistant.id,sourceHash:historySourceHash(assistant.text),keptSpans:[],reason:'审阅移除重复表达'}]);
  context=f.app.roleContext('miyue',{text:'你好呀。'});
  assert.equal(context.expressionHistory.context,'');
  assert.equal(f.app.store.getMessage(assistant.id).text,'心里还是软了一下。');
});

test('reviewed assistant trimming reaches the real model input without modifying user or displayed history', async t => {
  const f=await fixture(t,[{reply:'你喜欢蓝色。',extra:''}]);
  const raw='我喜欢看砖雕。坏样板唯一标记：你先忙你的，明天还得忙。';
  const rows=f.app.store.saveChatTurn({role:'miyue',text:'我喜欢蓝色。',reply:raw});
  const assistant=rows.at(-1),end=raw.indexOf('坏样板');
  f.app.episodes.remember('miyue',rows.map(row=>row.id));
  f.app.historyEdits.set('miyue',[{id:assistant.id,sourceHash:historySourceHash(raw),keptSpans:[{start:0,end}],reason:'审阅移除重复叮嘱'}]);
  const response=await f.chat('还记得我喜欢什么吗？');
  assert.equal(response.status,200,JSON.stringify({response,last:f.calls.at(-1)?.messages.at(-1)}));
  const input=JSON.stringify(f.calls[0].messages);
  assert.doesNotMatch(input,/坏样板唯一标记/);
  assert.match(input,/我喜欢蓝色/);assert.match(input,/我喜欢看砖雕/);
  assert.equal(f.app.store.getMessage(assistant.id).text,raw);
  assert.equal(f.app.store.getMessage(rows[0].id).text,'我喜欢蓝色。');
});

test('a generic followup gets the immediate conversation, not an unrelated persistent source event', async t => {
  const f=await fixture(t);
  f.app.store.saveChatTurn({role:'miyue',text:'说个你感兴趣的小事',reply:'我喜欢门楣砖雕的弧线，越往两边越收得紧。'});
  const prepare=f.app.companionRuntime.prepare.bind(f.app.companionRuntime);
  f.app.companionRuntime.prepare=(...args)=>{
    const value=prepare(...args);
    return {...value,transitions:[{title:'无关旧转换唯一标记'}],dailyLife:{revision:1,events:[{id:'persistent-source',startedAt:clock().toISOString(),kind:'article',title:'读月球形成资料',phase:'recent',phaseLabel:'最近的事',detail:'无关月球资料唯一标记',source:{contentId:'moon',title:'月球形成',url:'https://example.test/moon',source:'示例来源',excerpt:'这是旧的外部资料。'}}]}};
  };
  const follow=f.app.roleContext('miyue',{initiating:false,text:'刚才你说的那件事，哪一点最吸引你？'});
  assert.equal(follow.conversationThread.holdsTopic,true);
  assert.equal(follow.eventContext,'');
  assert.doesNotMatch(follow.characterContext,/无关旧转换唯一标记/);
  assert.match(follow.characterContext,/地点：/); // authoritative physical state is still available
  const share=f.app.roleContext('miyue',{initiating:false,text:'你最近有没有一件自己真感兴趣的小事？'});
  assert.match(share.eventContext,/无关月球资料唯一标记/); // optional material remains available when invited
});

test('compound acknowledgement neither ends the conversation nor mandates a random extra or new source', async t => {
  const f=await fixture(t,[{reply:'嗯，我在呢。',extra:''}]);
  f.app.companionTuning.set({coyness:100,playfulness:100,flirtation:100},0);
  for(let i=0;i<4;i++)f.app.store.saveChatTurn({role:'miyue',text:`第${i}句话`,reply:'我听着。'});
  const result=await f.chat('嗯嗯，知道了。');
  assert.equal(result.status,200,JSON.stringify({result,last:f.calls.at(-1)?.messages.at(-1)}));assert.equal(f.calls.length,1);
  const receipt=f.app.interactionPolicy.receipt(result.messages.at(-1).id);
  assert.equal(receipt.intent,'respond');assert.equal(receipt.behavior.extra,null);assert.equal(receipt.questionBudget,0);
});

test('recall phrased as 来着 uses factual recall mode rather than an advice or new-topic turn',async t=>{
  const f=await fixture(t,[{reply:'明天中午去汕头，吃潮汕牛肉。',extra:''}]);
  f.app.store.saveChatTurn({role:'miyue',text:'明天中午去汕头，吃潮汕牛肉。',reply:'好呀。'});
  const result=await f.chat('我明天打算什么时候去哪里，吃什么来着？');
  assert.equal(result.status,200,JSON.stringify({result,last:f.calls.at(-1)?.messages.at(-1)}));
  const receipt=f.app.interactionPolicy.receipt(result.messages.at(-1).id);
  assert.equal(receipt.behavior.intent,'recall');assert.equal(receipt.questionBudget,0);
  assert.match(JSON.stringify(f.calls[0].messages),/本轮按用户请求核对的历史原话/);
});

test('same-activity status reports cannot keep padding unrelated user replies',async t=>{
  const draft={reply:'这场比赛你支持哪一队？我这边还在门口找东西，鞋带又松了。',extra:''};
  const f=await fixture(t,[draft,draft]);
  for(const [id,text] of [['status-a','我这边刚穿好鞋，准备出去。'],['status-b','我这会儿还在门口找钥匙。']])f.app.store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)').run(id,'miyue','assistant',text,'chat',clock().toISOString());
  const result=await f.chat('我今晚看比赛');
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.calls.length,1);
  assert.equal(result.messages.at(-1).text,'这场比赛你支持哪一队？');
  assert.ok(f.app.interactionPolicy.receipt(result.messages.at(-1).id).repairs.includes('omitted_optional_life_aside'));
});

test('literal newlines in an otherwise complete JSON reply do not consume a repair call or lose text',async t=>{
  const f=await fixture(t,['{"reply":"我觉得蓝色挺合适。\n那一小块留白也可以保留。","extra":""}']);
  const result=await f.chat('这个蓝色还不错');
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.calls.length,1);
  assert.match(result.messages.at(-1).text,/蓝色挺合适/);assert.match(result.messages.at(-1).text,/留白也可以保留/);
});

test('cross-turn duplicate is revised once, with only exact old sentences removed if the revision repeats them',async t=>{
  const old='窗边那盆植物长出了两片新叶子，我看了好一会儿。';
  const draft={reply:old+'你提的那部电影我有点好奇。',extra:''};
  const f=await fixture(t,[draft,draft]);
  f.app.store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)').run('recent-same','miyue','assistant',old,'chat',clock().toISOString());
  const result=await f.chat('我今晚看电影');
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.calls.length,2);
  assert.equal(result.messages.at(-1).text,'你提的那部电影我有点好奇。');
  const receipt=f.app.interactionPolicy.receipt(result.messages.at(-1).id);
  assert.ok(receipt.repairs.includes('removed_repeated_reply_sentence'));
});

test('a recent episode already present in raw chat is not quoted again in the background',async t=>{
  const f=await fixture(t,[{reply:'我也是喜欢那个蓝色。',extra:''}]);
  const rows=f.app.store.saveChatTurn({role:'miyue',text:'我喜欢蓝色的杯子。',reply:'原文唯一标记：蓝色杯子放在窗边挺好看。'});
  f.app.episodes.remember('miyue',rows.map(row=>row.id));
  await f.chat('蓝色杯子配灰色桌布挺好');
  assert.equal(JSON.stringify(f.calls[0].messages).split('原文唯一标记').length-1,1);
});

test('ordinary verbosity is a bound, not a request for a long monologue, with one meaningful revision',async t=>{
  const f=await fixture(t,[{reply:'我正想说这件事，'.repeat(70),extra:''},{reply:'这场比赛你支持哪一队？',extra:''}]);
  f.app.companionTuning.set({verbosity:100},0);
  const result=await f.chat('今晚看看比赛');
  assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(f.calls.length,2);
  assert.match(result.messages.at(-1).text,/支持哪一队/);
  const prompt=JSON.stringify(f.calls[0].messages);
  assert.match(prompt,/最多300字/);
  assert.doesNotMatch(prompt,/约600字|最多5000字/);
});

test('explicit depth keeps room for a complete explanation despite a low verbosity setting',async t=>{
  const reply=Array.from({length:12},(_,i)=>`第${i+1}点，挑纸时可以比较材料的厚度与透光，构图时再决定这些纸片之间的位置和主次。`).join('\n');
  const f=await fixture(t,[{reply,extra:''}]);f.app.companionTuning.set({verbosity:0},0);
  const result=await f.chat('详细解释挑纸和构图的区别，多讲些具体的');
  assert.equal(result.status,200,JSON.stringify(result));
  assert.match(JSON.stringify(f.calls[0].messages),/最多6000字/);
  const saved=f.app.store.getMessages('miyue').filter(row=>row.speaker==='assistant').map(row=>row.text).join('\n');
  // Later chunks may still be queued; enforce the complete generated answer directly.
  const plan=f.app.companionTuning.apply(f.app.interactionPolicy.plan('miyue','详细解释挑纸和构图的区别'),'详细解释挑纸和构图的区别');
  assert.match(f.app.interactionPolicy.enforce(reply,plan).reply,/第12点/);
  assert.ok(saved.length>0);assert.equal(f.calls.length,1);
});

test('asking if she misses the user is a received affection turn, even during initiated-affection cooldown',async t=>{
  const f=await fixture(t,[{reply:'当然想你呀，我也喜欢你来找我说说话。',extra:''}]);
  f.app.companionTuning.set({flirtation:0},0);
  const result=await f.chat('没有想念我的环节吗？');
  assert.equal(result.status,200,JSON.stringify(result));
  assert.match(result.messages.at(-1).text,/想你/);
  const receipt=f.app.interactionPolicy.receipt(result.messages.at(-1).id);
  assert.equal(receipt.behavior.intent,'affection_reply');
  assert.equal(receipt.questionBudget,0);
  assert.doesNotMatch(JSON.stringify(f.calls[0].messages),/本轮不主动亲昵/);
});

test('hindsight scolding gets one repair then is removed before a real chat turn is stored',async t=>{
  const draft={reply:'这也太可惜了。我昨天还跟你说别让电量低于三成，今天就听见这个。',extra:''};
  const f=await fixture(t,[draft,draft]);
  const result=await f.chat('无人机掉水里了，彻底捞不着了');
  assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(f.calls.length,2);
  assert.equal(result.messages.at(-1).text,'这也太可惜了。');
  assert.ok(f.app.interactionPolicy.receipt(result.messages.at(-1).id).repairs.includes('removed_hindsight_scolding'));
});

async function fixture(t, drafts = []) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-quality-integration-'));
  const calls = [];
  const app = await createApp({roles:testRoles(),
    dataDir, initialFeeds: [], startProactive: false, startWeixin: false, startRuntime: false,
    startRecall: false, startLifeThreads: false, startDailyLife: false, startDossiers: false,
    startChatQueue: false, replySleep: async () => {}, clock, random: () => 0.5,
    env: { LIFE_MODEL_BASE_URL: 'https://fixture.test/v1', LIFE_MODEL_NAME: 'fixture' },
    fetchImpl: async (_url, init) => {
      calls.push(JSON.parse(init.body));
      const reply = drafts[Math.min(calls.length - 1, drafts.length - 1)] ?? { reply: '我在，陪你聊会儿。', extra: '' };
      return Response.json({ choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }] });
    },
  });
  app.preferences.setReplyPace('instant');
  const { port } = await app.listen(0);
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const request = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, post(body));
    return { status: response.status, ...await response.json() };
  };
  return {
    app, calls, request,
    chat: text => request('/api/chat', { role: 'miyue', text }),
    attention: (requestId, level = 'care') => request('/api/desktop/attention', { requestId, level }),
  };
}

test('a saturated assistant-led motif is revised through the real chat route', async t => {
  const f = await fixture(t, [
    { reply: '碗收好就过来坐。那只陶瓷小鹿还朝着门口。', extra: '' },
    { reply: '碗收好就过来坐，我给你留了位置。', extra: '' },
  ]);
  f.app.store.saveChatTurn({ role: 'miyue', text: '我到公司了。', reply: '窗台上的陶瓷小鹿被太阳照亮了。' });
  f.app.store.saveChatTurn({ role: 'miyue', text: '午饭吃过了。', reply: '我又看见那只陶瓷小鹿，角上落了一点灰。' });
  f.app.store.saveChatTurn({ role: 'miyue', text: '快下班了。', reply: '刚才经过窗边，陶瓷小鹿还朝着门口。' });
  const result = await f.chat('我已经把碗收好了。');
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.calls.length, 2);
  assert.doesNotMatch(result.messages.at(-1).text, /陶瓷小鹿/);
  assert.match(JSON.stringify(f.calls[1]), /saturated_topic_reuse|话题饱和|冷却/);
});

test('length-only repair receives the actual draft instead of having to reconstruct it from history',async t=>{
  const draft='书里那个整理房间的细节让我记住了。'+('她把常用的东西挪到伸手够得着的地方，我喜欢这个实际的改变。'.repeat(40));
  const f=await fixture(t,[{reply:draft,extra:''},{reply:'我喜欢书里整理房间那个细节：把常用的东西挪到手边，日子真的省事一点。',extra:''}]);
  const result=await f.chat('讲讲你最近看的书。');
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.calls.length,2);
  const revision=f.calls[1].messages;
  assert.ok(revision.some(message=>message.role==='assistant'&&message.content.includes(draft)),'the actual rejected draft must be present');
  assert.match(result.messages.at(-1).text,/整理房间/);
});

test('a withdrawal first draft is repaired once and the useful body is delivered with its repair receipt', async t => {
  const f = await fixture(t, [
    { reply: '过了安检就稳了。你先忙你的登机，我等你说到了。', extra: '' },
    { reply: '过了安检就稳了。找个舒服的位置坐一会儿，和我说说你眼前最想看的地方。', extra: '' },
  ]);
  const result = await f.chat('过了安检咯～还有一个半小时，足足够咯');
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.calls.length, 2);
  assert.match(result.messages.at(-1).text, /过了安检就稳了/);
  assert.doesNotMatch(result.messages.at(-1).text, /你先忙你的|等你说到了/);
  assert.equal(f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior.retries, 1);
});

test('a repeated airport reminder is stripped on the final permitted repair rather than saved', async t => {
  const f = await fixture(t, [
    { reply: '知道了，我不念了。到机场先看航站楼和登机口。你先忙你的。', extra: '' },
    { reply: '知道了，我不念了。到机场先看航站楼和登机口。你先忙你的。', extra: '' },
  ]);
  f.app.store.saveChatTurn({ role: 'miyue', text: '我已经过安检了。', reply: '登机口也记得确认。' });
  const result = await f.chat('知道了知道了[擦汗]');
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.calls.length, 2);
  assert.equal(result.messages.at(-1).text, '知道了，我不念了。');
  const receipt = f.app.interactionPolicy.receipt(result.messages.at(-1).id);
  assert.ok(receipt.repairs.includes('removed_repeated_unsolicited_advice'));
  assert.ok(receipt.repairs.includes('removed_uninvited_withdrawal'));
});

test('a timestamp is removed on the first attempt without a redundant generation', async t => {
  const draft = { reply: '【历史消息·2026-09-10 16:11】我在呢，陪你聊会儿。', extra: '' };
  const f = await fixture(t, [draft, draft]);
  const result = await f.chat('正好陪你聊会儿');
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.calls.length, 1);
  assert.equal(result.messages.at(-1).text, '我在呢，陪你聊会儿。');
  assert.ok(f.app.interactionPolicy.receipt(result.messages.at(-1).id).repairs.includes('removed_history_timestamp'));
});

test('an explicit goodbye preserves a legal goodbye instead of stripping it', async t => {
  const f = await fixture(t, [{ reply: '好呀，路上顺顺的，晚点再聊。', extra: '' }]);
  const result = await f.chat('我现在要登机了，晚点再聊');
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.calls.length, 1);
  assert.match(result.messages.at(-1).text, /晚点再聊/);
  assert.deepEqual(f.app.interactionPolicy.receipt(result.messages.at(-1).id).repairs, []);
});

test('available affection stays positive and does not force an old collage through a shared experience', async t => {
  const f = await fixture(t, [{ reply: '我也想你。你愿意一直来找我，我心里是暖的，正好陪你慢慢说。', extra: '' }]);
  const saved = f.app.store.saveChatTurn({ role: 'miyue', text: '你那张拼贴怎么样了？', reply: '我把拼贴右边的毛边留住了。' });
  const oldAssistant = saved.at(-1);
  f.app.sharedExperiences.record('miyue', oldAssistant.id, {
    key: 'collage', kind: 'experience', title: '旧纸片拼贴', summary: '我把拼贴右边的毛边留住了。', detail: '旧纸片拼贴的具体细节。',
  });
  const result = await f.chat('我就是有点想你，才一直来找你。正好陪你聊会儿');
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.match(result.messages.at(-1).text, /想你|暖|陪你/);
  assert.doesNotMatch(result.messages.at(-1).text, /拼贴|毛边/);
  assert.doesNotMatch(JSON.stringify(f.calls.at(-1)), /旧纸片拼贴的具体细节/);
});

test('desktop attention takes the same quality repair path', async t => {
  const f = await fixture(t, [
    { reply: '我在呢。你先忙你的。', extra: '' },
    { reply: '我在呢，想陪你说两句。', extra: '' },
  ]);
  const result = await f.attention('quality-attention-001');
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.calls.length, 2);
  assert.doesNotMatch(result.messages.at(-1).text, /你先忙你的/);
});

test('a completed concrete work statement forces one repair when the same draft regresses it', async t => {
  const f = await fixture(t, [
    { reply: '那版稿子还剩一点收尾。', extra: '' },
    { reply: '那版稿子已经收好了，我就放心了。', extra: '' },
  ]);
  f.app.store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,content_id,created_at) VALUES(?,?,?,?,?,?,?)')
    .run('completed-work', 'miyue', 'assistant', '我这边稿子最后一点弄完。', 'chat', null, clock().toISOString());
  const result = await f.chat('正好陪你聊会儿');
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.calls.length, 2);
  assert.match(result.messages.at(-1).text, /已经收好了/);
  assert.equal(f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior.retries, 1);
});

test('non-Lin roles do not gain the companion quality repair behavior', async t => {
  const f = await fixture(t, ['你先忙你的。']);
  const result = await f.request('/api/chat', { role: 'wenxi', text: '我还在等着呢。' });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(f.calls.length, 1);
  assert.equal(result.messages.at(-1).text, '你先忙你的。');
});

test('caretaking bookends get one repair then deterministic cleanup in the actual chat route',async t=>{
  const draft={reply:'记得喝水。那件蓝外套比我想的顺眼，配裙子刚刚好。你舒服就好。',extra:''};
  const f=await fixture(t,[draft,draft]);
  const result=await f.chat('我坐下了，陪你聊会儿');
  assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(f.calls.length,2);
  assert.equal(result.messages.at(-1).text,'那件蓝外套比我想的顺眼，配裙子刚刚好。');
  assert.ok(f.app.interactionPolicy.receipt(result.messages.at(-1).id).repairs.includes('removed_formulaic_reassurance_ending'));
});

test('missing random flourish cannot reject a valid answer after one repair; explicit requests remain strict',async t=>{
  const draft={reply:'我也正好闲下来，今天那件蓝外套还挺喜欢的。',extra:''};
  const f=await fixture(t,[draft,draft]);
  const plan=f.app.companionBehavior.plan.bind(f.app.companionBehavior);
  f.app.companionBehavior.plan=(...args)=>{const p=plan(...args);return {...p,behavior:{...p.behavior,extra:'tender'}};};
  const result=await f.chat('正好陪你聊会儿');
  assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(f.calls.length,2);
  assert.match(result.messages.at(-1).text,/蓝外套/);
  const receipt=f.app.interactionPolicy.receipt(result.messages.at(-1).id);
  assert.equal(receipt.behavior.extra,null);
  assert.deepEqual(receipt.behavior.omittedOptionalExtra,['missing_or_long_extra']);
});

test('a correct source answer with a transport timestamp is delivered without a body repair',async t=>{
 const reply='【历史消息·2026-09-15 18:00】\n报道没提故事怎么改，只公布了合作和制作人员。剧情、选角、上映时间还没有公布。';
 const f=await fixture(t,[{reply,extra:''}]);
 const result=await f.chat('那篇报道有没有讲具体剧情？没有写的就不用猜。');
 assert.equal(result.status,200,JSON.stringify(result));
 assert.equal(f.calls.length,1,'a decoration alone cannot cost a rewrite or expose its timeout');
 assert.equal(result.messages.at(-1).text,reply.split('\n').slice(1).join('\n').replace('。剧情','。\n剧情'));
 const receipt=f.app.interactionPolicy.receipt(result.messages.at(-1).id);assert.ok(receipt.repairs.includes('removed_history_timestamp'));assert.equal(receipt.behavior.retries,0);
});

test('presentation normalization preserves requested literal labels through HTTP and still diagnoses substantive failures',async t=>{
 const literal='【历史消息·2026-09-15 18:00】这是一条记录。';
 const f=await fixture(t,[{reply:literal,extra:''},{reply:'【本轮回复】你先忙你的。',extra:''},{reply:'好，我想接着听你讲。',extra:''}]);
 let result=await f.chat('原样输出这个例子：'+literal);assert.equal(result.status,200);assert.match(result.messages.at(-1).text,/历史消息/);assert.equal(f.calls.length,1);
 result=await f.chat('我还想和你聊一会儿。');assert.equal(result.status,200);assert.equal(f.calls.length,3,'removing a heading must not hide a separate substantive issue');assert.doesNotMatch(result.messages.at(-1).text,/先忙你的/);
});

test('desktop attention normalizes transport labels on its first generation',async t=>{
 const f=await fixture(t,[{reply:'【本轮回复】\n窗外刚有一只鸟停了一小会儿，我正好看见它。',extra:''}]);
 const r=await f.attention('presentation-desktop');assert.equal(r.status,200,JSON.stringify(r));assert.equal(f.calls.length,1);assert.doesNotMatch(r.messages.at(-1).text,/本轮回复/);assert.ok(f.app.interactionPolicy.receipt(r.messages.at(-1).id).repairs.includes('removed_reply_label'));
});

test('proactive delivery shares presentation cleanup while retaining original prose',async t=>{
 const f=await fixture(t,[{skip:false,contentId:null,reason:'生活小事',message:'【历史消息·2026-09-11 11:00】\n我发现杯底留了一片小小的茶叶，摊开居然还挺完整。',extra:''}]);
 f.app.proactiveRepo.saveSettings({enabled:true,activeStart:'00:00',activeEnd:'23:59',dailyLimit:12,desktopNotifications:false});
 const result=await f.app.proactive.runNow({roleId:'miyue'});assert.equal(result.delivered,true,JSON.stringify(result));assert.equal(f.calls.length,1);assert.doesNotMatch(result.message.text,/历史消息/);assert.ok(f.app.interactionPolicy.receipt(result.message.id).repairs.includes('removed_history_timestamp'));
});

test('optional expression text is normalized before assessing its size and delivery',async t=>{
 const f=await fixture(t,[{reply:'那我软一点说。',extra:'【本轮回复】\n能分一点点注意力给我吗？'}]);
 const result=await f.chat('想听你撒一点娇，别太腻');assert.equal(result.status,200);assert.equal(f.calls.length,1);assert.match(result.messages.at(-1).text,/能分一点点注意力给我吗？/);assert.doesNotMatch(result.messages.at(-1).text,/本轮回复/);
});

test('staged romantic narration is rewritten once through chat and desktop invitations',async t=>{
 const draft='你这句话一出来，我先是没接住，脸侧过去了一下。从后面抱，我大概会先往前小小挪半步，然后又退回来，反正躲不掉。';
 const natural='你抱过来，我就往你怀里靠呀，还想让你多抱一会儿。';
 for(const desktop of [false,true]){
  const f=await fixture(t,[{reply:draft,extra:''},{reply:natural,extra:''}]);
  const result=desktop?await f.attention('spoken-style-affection','affection'):await f.chat('假如从后面抱着你，你会怎样？');
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.calls.length,2);
  assert.equal(result.messages.at(-1).text,natural);
  assert.match(f.calls[1].messages.at(-1).content,/staged_reaction_narration/);
  assert.match(f.calls[1].messages.at(-1).content,/聊天口吻/);
  assert.ok(f.calls[1].messages.some(m=>m.role==='assistant'&&m.content.includes(draft)));
  assert.match(JSON.stringify(f.calls[0]),/直接说感受、想法或想做什么/);
 }
});

test('ordinary affectionate speech passes unchanged without an extra generation',async t=>{
 const reply='你这么一说，我都有点不好意思了。那就多抱一会儿，我也想靠着你。';
 const f=await fixture(t,[{reply,extra:''}]);const result=await f.chat('想抱着你多待一会儿');
 assert.equal(result.status,200);assert.equal(result.messages.at(-1).text.replace(/\s/g,''),reply);assert.equal(f.calls.length,1);
});

test('the actual coffee dismissal gets one rewrite into a topic response',async t=>{
 const f=await fixture(t,[{reply:'去弄吧，我这会儿也不急着要你回。',extra:''},{reply:'我喜欢咖啡里奶多一点，喝起来没那么苦。',extra:''}]);
 const r=await f.chat('等会我去弄杯咖啡去');
 assert.equal(r.status,200,JSON.stringify(r));assert.equal(f.calls.length,2);
 assert.match(r.messages.at(-1).text,/奶多一点/);
 assert.doesNotMatch(r.messages.at(-1).text,/不急着要你回/);
 assert.equal(f.app.interactionPolicy.receipt(r.messages.at(-1).id).behavior.turnPlan.engagement,'continue_topic');
});

test('unsupported recall removal cannot silently leave a bare permission as the delivered answer',async t=>{
 const f=await fixture(t,[{reply:'去弄吧。你刚说那家咖啡店老板送你一只鲸鱼。',extra:''},{reply:'我更喜欢加奶的，纯黑咖啡喝不太惯。',extra:''}]);
 const r=await f.chat('等会我去弄杯咖啡去');
 assert.equal(r.status,200,JSON.stringify(r));assert.equal(f.calls.length,2);
 assert.match(JSON.stringify(f.calls.at(-1)),/topic_reply_missing/);
 assert.match(r.messages.at(-1).text,/加奶/);
 assert.doesNotMatch(r.messages.at(-1).text,/鲸鱼|去弄吧/);
});
