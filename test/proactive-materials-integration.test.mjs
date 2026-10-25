import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';
import {proactiveMaterialSlate, validateProactiveSelection} from '../lib/proactive-materials.mjs';

// Preparation/review calls share the writer's stable prefix; their own
// instruction follows it, so look past the prefix for the call kind.
const callIs = (body, marker) => body.messages.some(m => m.role === 'system' && (m.content.startsWith(marker) || m.content.startsWith('【以上是正文角色') && m.content.includes(marker)));

const NOW=new Date('2026-09-28T02:00:00Z');
const book={id:'city-book',kind:'reading',title:'城市里的散步',aliases:[],category:'books',sessionMinutes:60,stageWaitHours:48,restHours:48,
  source:{title:'阅读素材',url:'https://example.org/book',scope:'当前章节摘录'},
  stages:Array.from({length:4},(_,i)=>({label:`第${i+1}节`,action:`读到第${i+1}节`,detail:'这一节谈到街边长椅如何让人愿意停下脚步，也给陌生人留出短暂交谈的机会。'}))};
function slate(messages){const line=messages.flatMap(m=>m.content.split('\n')).find(line=>line.startsWith('可供主动分享的材料：'));return line?JSON.parse(line.slice('可供主动分享的材料：'.length).replace(/。$/u,'')):[];}
function share(material, state='open') {
  const message='街边的长椅让人愿意停下脚步，也给陌生人留出短暂交谈的机会。我觉得一座城市好不好逛，常常就在这种小地方。';
  return {skip:false,contentId:material.contentId||null,reason:'分享一个有意思的内容',message,initiative:{state,materialId:material.id,quote:'街边的长椅让人愿意停下脚步'}};
}
async function fixture(t,{reading=false,respond,discussion=false,sessionGuidance=false,sessionReview=false,clock=()=>new Date(NOW)}={}) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'proactive-materials-'));
  const calls=[];let app;
  app=await createApp({dataDir,initialFeeds:[],activeRoleIds:['miyue'],disableStory:true,sessionDialogue:true,sessionGuidance,sessionReview,dynamicCompanion:true,
    startPursuits:reading,pursuitCatalog:{lifePlanning:true,items:[book]},discussionTopics:discussion,discussionCatalog:[{id:"city-life",category:"society",title:"城市空间",premise:"街边的长椅让人愿意停下脚步，也给陌生人留出短暂交谈的机会。",sources:[{title:"城市生活",url:"https://example.org/city"}]}],
    startProactive:false,startLife:false,startRuntime:false,startDailyLife:false,startLifeThreads:false,startDiscovery:false,startWeixin:false,startRecall:false,startResearch:false,startDossiers:false,startChatQueue:false,
    clock,random:()=>0.99,replySleep:async()=>{},env:{LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture'},
    fetchImpl:async(_url,init)=>{const body=JSON.parse(init.body);calls.push(body);const result=await respond({app,body,calls});return Response.json({choices:[{message:{content:JSON.stringify(result)}}]});}});
  app.preferences.setReplyPace('instant');
  app.proactiveRepo.saveSettings({enabled:true,activeStart:'00:00',activeEnd:'23:59',dailyLimit:12,desktopNotifications:false});
  if(reading)app.pursuits.prepareSession({current:{kind:'home',remainingMinutes:90}});
  const {port}=await app.listen(0);
  t.after(async()=>{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  return {app,calls,port};
}
function seedArticle(app) {
  const feed=app.store.addFeed('https://example.org/feed','城市阅读');
  app.store.addContent(feed,[{title:'城市长椅与公共空间',url:'https://example.org/seats',summary:'城市沿着河岸增加了长椅和无障碍通道，让居民可以在散步途中停下来休息。新的公共空间连接两处广场，并为附近步行出行的人保留了连续的树荫，报道也讨论了这一设计怎样改变日常生活。',publishedAt:NOW.toISOString()}],'城市阅读');
}
const countReceipts=app=>app.store.db.prepare('SELECT count(*) n FROM proactive_material_deliveries').get().n;

test('open dialogue can choose an article regardless of the old 45 percent draw',async t=>{
  const f=await fixture(t,{respond:({body})=>share(slate(body.messages)[0])});seedArticle(f.app);
  const result=await f.app.proactive.runNow({roleId:'miyue'});
  assert.equal(result.delivered,true,JSON.stringify(f.app.proactiveRepo.getRuntime()));
  assert.equal(f.app.proactiveRepo.recent()[0].kind,'content');assert.equal(countReceipts(f.app),1);assert.equal(f.calls.length,1);
});

test('missing initiative receives a complete repair schema and can recover',async t=>{
  const f=await fixture(t,{respond:({body,calls})=>{
    const material=slate(body.messages)[0];
    if(calls.length===1)return {skip:false,contentId:material.contentId,reason:'分享一条资料',message:'街边的长椅让人愿意停下脚步。'};
    return share(material);
  }});seedArticle(f.app);
  const result=await f.app.proactive.runNow({roleId:'miyue'});
  assert.equal(result.delivered,true,JSON.stringify(f.app.proactiveRepo.getRuntime()));
  assert.equal(f.calls.length,2);
  assert.match(f.calls[0].messages.map(m=>m.content).join('\n'),/发送时 initiative 必填/u);
  assert.match(f.calls[1].messages.map(m=>m.content).join('\n'),/发送时 initiative 必填/u);
  assert.equal(countReceipts(f.app),1);
});

test('unfinished dialogue may continue without consuming offered news',async t=>{
  const f=await fixture(t,{respond:()=>({skip:false,contentId:null,reason:'接着用户没说完的话',message:'你刚才说还有一件事没讲，我在听，接着说就好。',initiative:{state:'unfinished',materialId:null,quote:''}})});seedArticle(f.app);
  const result=await f.app.proactive.runNow({roleId:'miyue'});
  assert.equal(result.delivered,true);assert.equal(countReceipts(f.app),0);
  assert.equal(f.app.proactiveRepo.getCandidates().some(item=>item.used),false);
});

test('continuity state is advisory and a valid material can support an unfinished exchange',async t=>{
  const f=await fixture(t,{respond:({body})=>share(slate(body.messages)[0],'unfinished')});seedArticle(f.app);
  const result=await f.app.proactive.runNow({roleId:'miyue'});
  assert.equal(result.delivered,true);assert.equal(countReceipts(f.app),1);assert.equal(f.app.store.getMessages('miyue').length,1);assert.equal(f.calls.length,1);
});

test('reading stages are offered, consumed only on delivery, and retained for a followup',async t=>{
  const f=await fixture(t,{reading:true,respond:({body})=>slate(body.messages).length?share(slate(body.messages).find(item=>item.kind==='reading')):{reply:'那一节说的是让人有地方停下来的公共空间。'}});
  const result=await f.app.proactive.runNow({roleId:'miyue'});
  assert.equal(result.delivered,true,JSON.stringify(f.app.proactiveRepo.getRuntime()));
  assert.equal(countReceipts(f.app),1);assert.equal(f.app.pursuits.pending('miyue'),null);
  const response=await fetch(`http://127.0.0.1:${f.port}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:'miyue',text:'书里具体怎么说的？'})});
  assert.equal(response.status,200);
  assert.match(f.calls.at(-1).messages.map(m=>m.content).join('\n'),/这一节谈到街边长椅如何让人愿意停下脚步/u);
});

test('skipping a reading opportunity preserves its pending stage',async t=>{
  const f=await fixture(t,{reading:true,respond:()=>({skip:true,contentId:null,reason:'她刚说还要接着讲，先听她说',message:''})});
  const result=await f.app.proactive.runNow({roleId:'miyue'});
  assert.equal(result.delivered,false);assert.ok(f.app.pursuits.pending('miyue'));assert.equal(countReceipts(f.app),0);
});

test('slate preserves material boundaries and gives less recently shared kinds room',()=>{
  const items=proactiveMaterialSlate({articles:[{id:'a',title:'新文章',summary:'摘要'}],pursuit:{...book,pendingKey:'book:1',readable:true,stage:book.stages[0],version:2},recent:[{kind:'article',createdAt:NOW.toISOString()}]});
  assert.equal(items[0].kind,'reading');assert.equal(items[0].detail,book.stages[0].detail);
  assert.throws(()=>validateProactiveSelection({...share(items[0]),initiative:{state:'open',materialId:'missing',quote:'街边的长椅让人愿意停下脚步'}},items));
  assert.throws(()=>validateProactiveSelection({...share(items[0]),contentId:'a'},items));
  const rewritten={...share(items[0]),initiative:{state:'open',materialId:items[0].id,quote:'这一句来自来源而非消息正文'}};
  assert.equal(validateProactiveSelection(rewritten,items).quote,rewritten.message);
  const article=proactiveMaterialSlate({articles:[{id:'a',title:'新文章',summary:'摘要'}]})[0];
  assert.equal(validateProactiveSelection({...share(article),initiative:{state:'open',materialId:'a',quote:'街边的长椅让人愿意停下脚步'}},[article]).material.id,article.id);
});

function history(app){return app.store.saveChatTurn({role:'miyue',text:'我还有后半段没讲完。',reply:'嗯，我听着，你接着说。'});}
const isGate=body=>body.messages[0].content.startsWith('你只判断一段对话');

test('unfinished assessment retains evidence and lets the final model choose to skip; assessment cache is reused',async t=>{
  const f=await fixture(t,{respond:({body})=>{
    if(isGate(body)){const rows=JSON.parse(body.messages[1].content);return {state:'unfinished',reason:'用户还没讲完',evidence:[{messageId:rows[0].id,quote:rows[0].text}]};}
    assert.equal(slate(body.messages).length,1);
    assert.ok(body.messages.some(message=>message.content.includes('【对话接续参考评估】{"state":"unfinished"')));
    return {skip:true,contentId:null,reason:'先等用户把后半段说完',message:''};
  }});
  seedArticle(f.app);history(f.app);
  assert.equal((await f.app.proactive.runNow({roleId:'miyue'})).delivered,false);
  assert.equal((await f.app.proactive.runNow({roleId:'miyue'})).delivered,false);
  assert.equal(f.calls.length,3);assert.equal(countReceipts(f.app),0);assert.equal(f.app.store.getMessages('miyue').length,2);
});

test('the final model can revise a preliminary assessment and deliver its own selection',async t=>{
  const f=await fixture(t,{respond:({body})=>{
    if(isGate(body)){const rows=JSON.parse(body.messages[1].content);return {state:'unfinished',reason:'旧提问未回答',evidence:[{messageId:rows[1].id,quote:rows[1].text}]};}
    return share(slate(body.messages)[0],'open');
  }});
  seedArticle(f.app);
  f.app.store.saveChatTurn({role:'miyue',text:'先到这里，你有想到别的可以跟我说。',reply:'好，要再听那段时随时接着聊。'});
  const result=await f.app.proactive.runNow({roleId:'miyue'});
  assert.equal(result.delivered,true,JSON.stringify(f.app.proactiveRepo.getRuntime()));
  assert.equal(f.calls.length,2);assert.equal(countReceipts(f.app),1);
});

test('an unavailable preliminary assessment still permits evidence-based final generation',async t=>{
  const f=await fixture(t,{respond:({body})=>{
    if(isGate(body))return {state:'open',reason:'无有效依据',evidence:[{messageId:'missing',quote:'不存在'}]};
    assert.ok(body.messages.some(message=>message.content.includes('【对话接续参考评估】{"state":"unknown"')));
    return {skip:false,contentId:null,reason:'接续已有交流',message:'嗯，我听着，你想说的时候接着说就好。',initiative:{state:'unfinished',materialId:null,quote:''}};
  }});
  seedArticle(f.app);history(f.app);
  assert.equal((await f.app.proactive.runNow({roleId:'miyue'})).delivered,true,JSON.stringify(f.app.proactiveRepo.getRuntime()));
  assert.equal(f.calls.length,2);assert.equal(countReceipts(f.app),0);
});

test('new dialogue arriving during continuity assessment prevents generation from stale evidence',async t=>{
  const f=await fixture(t,{respond:({app,body})=>{assert.ok(isGate(body));const rows=JSON.parse(body.messages[1].content);app.store.saveChatTurn({role:'miyue',text:'等等我还要说。',reply:'我在听。'});return {state:'open',reason:'先前收尾',evidence:[{messageId:rows[1].id,quote:rows[1].text}]};}});
  seedArticle(f.app);history(f.app);
  assert.equal((await f.app.proactive.runNow({roleId:'miyue'})).delivered,false);
  assert.equal(f.calls.length,1);assert.equal(countReceipts(f.app),0);
});

test('dynamic proactive guidance permits continuation even when the scheduled opportunity offered content',async t=>{
  const f=await fixture(t,{sessionGuidance:true,respond:({body})=>{
    if(isGate(body)){const rows=JSON.parse(body.messages[1].content);return {state:'unfinished',reason:'还有后半段',evidence:[{messageId:rows[0].id,quote:rows[0].text}]};}
    if(callIs(body,'【本轮提示生成】'))return {guidance:[{instruction:'接住还没说完的后半段，资料只供相关时参考。',quote:'我还有后半段没讲完。'}]};
    assert.ok(body.messages.some(row=>row.content.includes('【本轮具体提示】')));
    return {skip:false,contentId:null,reason:'沿着已有交流接续',message:'你刚才说到还有后半段，想接着说时我在。',initiative:{state:'unfinished',materialId:null,quote:''}};
  }});
  seedArticle(f.app);history(f.app);
  const originalContext=f.app.proactive.getRoleContext;
  f.app.proactive.getRoleContext=async(...args)=>({...await originalContext(...args),opportunity:{kind:'content'}});
  const result=await f.app.proactive.runNow({roleId:'miyue',newsOnly:true});
  assert.equal(result.delivered,true,JSON.stringify(f.app.proactiveRepo.getRuntime()));
  assert.equal(f.calls.length,3);assert.equal(countReceipts(f.app),0);
  assert.equal(f.app.proactiveRepo.recent()[0].kind,'continuation');
  assert.equal(f.app.proactiveRepo.getCandidates().some(item=>item.used),false);
});

test('new dialogue during prompt preparation prevents the proactive writer from using stale evidence',async t=>{
  const f=await fixture(t,{sessionGuidance:true,respond:({app,body})=>{
    if(isGate(body)){const rows=JSON.parse(body.messages[1].content);return {state:'open',reason:'先前暂别',evidence:[{messageId:rows[1].id,quote:rows[1].text}]};}
    assert.ok(callIs(body,'【本轮提示生成】'));
    app.store.saveChatTurn({role:'miyue',text:'等等我还要说。',reply:'我在听。'});
    return {guidance:[]};
  }});
  seedArticle(f.app);history(f.app);
  assert.equal((await f.app.proactive.runNow({roleId:'miyue'})).delivered,false);
  assert.equal(f.calls.length,2);assert.equal(countReceipts(f.app),0);
});

test('proactive review revises model-authored prose before its material receipt is committed',async t=>{
  const f=await fixture(t,{sessionGuidance:true,sessionReview:true,respond:({body})=>{
    if(callIs(body,'【本轮提示生成】'))return {guidance:[]};
    if(callIs(body,'【本轮草稿检查】'))return {guidance:body.messages.at(-1).content.includes('你吃饭了吗')?[{instruction:'保留城市长椅的分享，删除与资料无关的吃饭追问。',quote:'城市长椅与公共空间'}]:[]};
    const result=share(slate(body.messages)[0]);
    if(!body.messages.some(row=>row.content.includes('【本轮模型修改意见】')))result.message+='你吃饭了吗？';
    return result;
  }});seedArticle(f.app);
  const result=await f.app.proactive.runNow({roleId:'miyue'});
  assert.equal(result.delivered,true,JSON.stringify(f.app.proactiveRepo.getRuntime()));
  assert.equal(f.calls.length,5);assert.equal(countReceipts(f.app),1);
  assert.equal(result.message.text,share(slate(f.calls[1].messages)[0]).message);
});

test('proactive review preserves an ongoing shared scene without requiring a material candidate',async t=>{
  const corrected='我还在餐桌边，把青菜放在我们中间，这碗汤的味道刚好。';
  const f=await fixture(t,{sessionGuidance:true,sessionReview:true,respond:({body})=>{
    if(callIs(body,'【本轮提示生成】'))return {guidance:[]};
    if(callIs(body,'【本轮草稿检查】')){
      assert.ok(body.messages.some(m=>m.content.includes('我们还坐在厨房餐桌边吃面')));
      return {ready:true,needsReasoning:false,guidance:[{instruction:'共同吃面尚未结束，不把日程当作转场回执。',quote:'我已经在街口面馆坐下',quoteSource:'draft'}],
        revision:{skip:false,contentId:null,reason:'接续共同吃面',message:corrected,initiative:{state:'unfinished',materialId:null,quote:''}}};
    }
    assert.equal(slate(body.messages).length,0);
    return {skip:false,contentId:null,reason:'说说午饭',message:'我已经在街口面馆坐下，点了一碗面。',initiative:{state:'unfinished',materialId:null,quote:''}};
  }});
  const traces=[];f.app.proactive.onTrace=trace=>traces.push(trace);
  f.app.store.saveChatTurn({role:'miyue',text:'我们一起坐下吃面吧。',reply:'我们还坐在厨房餐桌边吃面，我把青菜挪到中间。'});
  const result=await f.app.proactive.runNow({roleId:'miyue'});
  assert.equal(result.delivered,true,JSON.stringify(f.app.proactiveRepo.getRuntime()));
  assert.equal(f.calls.length,3);assert.equal(result.message.text,corrected);assert.equal(countReceipts(f.app),0);
  assert.equal(traces[0].review.rewritten,true);
  assert.ok(!f.app.store.getMessages('miyue').some(row=>row.text.includes('街口面馆')));
});

test('discussion source is attached and exposure is recorded only with committed prose',async t=>{
  const f=await fixture(t,{discussion:true,respond:({body})=>share(slate(body.messages).find(item=>item.kind==='discussion'))});
  const result=await f.app.proactive.runNow({roleId:'miyue'});
  assert.equal(result.delivered,true,JSON.stringify(f.app.proactiveRepo.getRuntime()));assert.equal(result.message.sourceUrl,'https://example.org/city');
  assert.equal(countReceipts(f.app),1);assert.equal(f.app.store.db.prepare('SELECT count(*) n FROM discussion_topic_deliveries').get().n,1);
});

test('travel API persists multiple stops and normal chat sees current city and return time',async t=>{
  let now=new Date(NOW);
  const f=await fixture(t,{clock:()=>now,respond:()=>({reply:'我在南京的住处，晚些再出去走走。'})});
  const plan={departAt:'2026-09-29T00:00:00Z',returnAt:'2026-10-02T12:00:00Z',stops:[{city:'扬州',arriveAt:'2026-09-29T02:00:00Z',leaveAt:'2026-09-30T04:00:00Z'},{city:'南京',arriveAt:'2026-09-30T06:00:00Z',leaveAt:'2026-10-02T09:00:00Z'}]};
  const post=async(path,body)=>{const response=await fetch(`http://127.0.0.1:${f.port}${path}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  let response=await post('/api/life/travel',plan);assert.equal(response.status,200,JSON.stringify(response.body));assert.equal(response.body.life.travel.status,'planned');
  assert.equal((await post('/api/life/travel',plan)).status,409);
  now=new Date('2026-10-01T02:00:00Z');
  response=await post('/api/chat',{role:'miyue',text:'你现在在哪里？什么时候回来？'});assert.equal(response.status,200,JSON.stringify(response.body));
  const prompt=f.calls.at(-1).messages.map(m=>m.content).join('\n');assert.match(prompt,/"currentCity":"南京"/);assert.match(prompt,/2026-10-02T12:00:00.000Z/);
  assert.equal(f.app.groundedLife.location().city,'南京');
  now=new Date(plan.returnAt);assert.equal(f.app.groundedLife.location().city,'苏州');
  assert.match(f.app.companionRuntime.advance().current.location,/苏州/);
});
