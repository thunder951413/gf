import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';
import {setTimeout as delay} from 'node:timers/promises';

const catalog={items:[{id:'test-nails',kind:'manicure',title:'换梅子色指甲',location:'苏州的美甲店',phases:[
  {id:'doing',label:'正在做',detail:'正在比较梅子色和豆沙色，还没有涂好。',durationMs:60*60000},
  {id:'recent',label:'最近的事',detail:'最后选了梅子色，拇指留了一点细闪。',durationMs:167*3600000},
]}]};
const eventIndex=request=>request.messages.findIndex(m=>m.content.startsWith('【她的日常近况'));
async function fixture(t,extra={}){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'daily-life-integration-'));
  let now=new Date('2026-09-08T13:00:00Z'),respond=()=>({reply:'我在呢，今天也想跟你聊聊。',extra:''});const requests=[];
  const app=await createApp({dataDir,initialFeeds:[],startProactive:false,startRecall:false,startLife:false,startLifeThreads:false,startDossiers:false,startResearch:false,startChatQueue:false,startRuntime:false,replySleep:async()=>{},clock:()=>new Date(now),random:()=>.1,dailyLifeRandom:()=>0,dailyLifeCatalog:catalog,
    env:{LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture'},fetchImpl:async(_url,init)=>{const request=JSON.parse(init.body);requests.push(request);return Response.json({choices:[{message:{content:JSON.stringify(await respond(request))}}]});},...extra});
  app.preferences.setReplyPace('instant');const {port}=await app.listen(0);
  t.after(async()=>{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  return {app,requests,set:at=>{now=new Date(at);},respond:fn=>{respond=fn;},request:async(route,body)=>{const r=await fetch(`http://127.0.0.1:${port}${route}`,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,...await r.json()};}};
}

test('ordinary, proactive and desktop preparation share life events without a forced craft anchor',async t=>{
  const f=await fixture(t);
  const view=await f.request('/api/companion-runtime');
  assert.equal(view.dailyLife.events[0].phase,'doing');
  assert.equal(view.current.title,'换梅子色指甲');
  assert.deepEqual(view.events.map(e=>e.type),['phased','meter','meter','meter']);
  const ordinary=f.app.roleContext('miyue',{initiating:false,text:'今天过得怎么样'});
  const proactive=f.app.roleContext('miyue',{initiating:true});
  assert.equal(ordinary.eventContext,proactive.eventContext);
  assert.match(proactive.eventContext,/梅子色/);
  assert.equal(proactive.policyPlan.anchor,'');
  const reply=await f.request('/api/desktop/attention',{requestId:'daily-opening-001',level:'care'});
  assert.equal(reply.status,200,JSON.stringify(reply));assert.equal(reply.messages.length,1);
  assert.match(f.requests.at(-1).messages[eventIndex(f.requests.at(-1))].content,/梅子色/);
  assert.ok(f.requests.at(-1).messages.some(m=>m.content.includes('生活参与方式')));
  assert.ok(f.app.store.getMessages('miyue').every(m=>m.speaker==='assistant'));
  const typed=await f.request('/api/chat',{role:'miyue',text:'我今天上班有点累。'});
  assert.equal(typed.status,200,JSON.stringify(typed));
  assert.equal(eventIndex(f.requests.at(-1)),-1,'unrelated fatigue reply does not receive detailed manicure material');
  assert.equal(f.requests[0].messages[0].content,f.requests.at(-1).messages[0].content,'persona remains stable');
  assert.match(f.requests.at(-1).messages.map(m=>m.content).join('\n'),/地点：苏州的美甲店/,'physical state remains available');
});

test('a successfully saved direct event reply marks its context exposure, while explicit follow-up can select it',async t=>{
  const f=await fixture(t);
  const sent=await f.request('/api/chat',{role:'miyue',text:'你今天换梅子色指甲怎么样？'});
  assert.equal(sent.status,200,JSON.stringify(sent));
  const event=f.app.companionRuntime.advance().dailyLife.events[0];
  assert.ok(event);
  assert.deepEqual(f.app.eventMaterials.select([event]),[],'a direct saved reply must not leave the same material fresh for the next opening');
  assert.deepEqual(f.app.eventMaterials.select([event],{explicit:true}),[event],'an explicit follow-up may ask for the same material');
});

test('a new daily material remains ahead of a pending own-life thread, while an ordinary user update receives neither',async t=>{
  const f=await fixture(t,{startLifeThreads:true,startPursuits:false});
  const thread=f.app.lifeThreads.get('miyue');
  assert.ok(thread?.pendingKey);
  const ownLife=await f.request('/api/chat',{role:'miyue',text:'你最近有件自己想讲的小事吗？'});
  assert.equal(ownLife.status,200,JSON.stringify(ownLife));
  const sharePrompt=f.requests.at(-1).messages.map(message=>message.content).join('\n');
  assert.match(sharePrompt,/换梅子色指甲/);
  assert.doesNotMatch(sharePrompt,/【本轮唯一分享材料｜虚构角色生活】/);
  const ordinary=await f.request('/api/chat',{role:'miyue',text:'我今天开会有点累。'});
  assert.equal(ordinary.status,200,JSON.stringify(ordinary));
  const ordinaryPrompt=f.requests.at(-1).messages.map(message=>message.content).join('\n');
  assert.doesNotMatch(ordinaryPrompt,/【她的日常近况/);
  assert.doesNotMatch(ordinaryPrompt,/【本轮唯一分享材料｜虚构角色生活】/);
});

test('timer transitions into recent phase, prepares a sharing opportunity, and expiry preserves chat history',async t=>{
  const f=await fixture(t,{startRuntime:true,runtimeIntervalMs:10});
  await delay(30);const first=f.app.companionRuntime.advance();
  f.app.store.saveChatTurn({role:'miyue',text:'这个梅子色很好看。',reply:'我也挺喜欢它的。'});
  f.set('2026-09-08T14:01:00Z');await delay(35);
  const stored=JSON.parse(f.app.store.db.prepare("SELECT value FROM metadata WHERE key='companion_runtime:miyue'").get().value);
  assert.ok(stored.revision>first.revision);
  const recent=f.app.companionRuntime.advance();assert.equal(recent.dailyLife.events[0].phase,'recent');
  assert.equal(recent.pending.type,'daily-life-transition');
  assert.notEqual(recent.current.title,'换梅子色指甲');
  assert.equal(f.requests.length,0,'clock advancement never calls model');
  f.set('2026-09-16T03:00:00Z');await delay(35);
  const expired=f.app.roleContext('miyue',{initiating:false,text:'你好'});
  assert.equal(expired.eventContext,'');assert.equal(expired.runtime.dailyLife.events.length,0);
  assert.equal(f.app.store.getMessages('miyue').length,2);
});

test('actual proactive delivery receives event context and consumes its opportunity exactly once',async t=>{
  const f=await fixture(t);f.app.companionRuntime.advance();f.set('2026-09-08T14:01:00Z');
  f.app.proactiveRepo.saveSettings({enabled:true,activeStart:'00:00',activeEnd:'23:59',dailyLimit:10});
  f.respond(()=>({skip:false,contentId:null,reason:'分享近况',message:'新做的梅子色指甲在灯下会有一点细闪，比想象中耐看。',extra:''}));
  const result=await f.app.proactive.runNow({roleId:'miyue'});
  assert.equal(result.delivered,true,JSON.stringify(result));
  assert.match(f.requests.at(-1).messages[eventIndex(f.requests.at(-1))].content,/最后选了梅子色/);
  assert.equal(f.app.companionRuntime.advance().pending,null);
  assert.equal(f.app.store.getMessages('miyue').filter(m=>m.speaker==='assistant').length,1);
});

function addLifeSource(app) {
  const feed = app.store.addFeed('https://example.com/life/feed', '生活杂志');
  app.store.addContent(feed, [{title:'社区书店的旧书交换角',url:'https://example.com/life/books',publishedAt:'2026-09-08T12:00:00Z',summary:'社区书店在靠窗的位置设置了旧书交换角，读者可以留下自己读过的书和一张简短的推荐卡。店员说，大家最喜欢看的往往是卡片上那些很个人的小感想，交换不需要购买新书，也不要求留下联系方式。'}],feed.title);
  return app.store.listContent()[0];
}

test('subscription reading is frozen across polling and a delivered source remains available for followup',async t=>{
  const f=await fixture(t,{dailyLifeRandom:()=>.999});
  const item=addLifeSource(f.app);
  const first=f.app.roleContext('miyue',{initiating:false,text:'你今天过得怎么样'});
  assert.equal(first.runtime.dailyLife.events[0].origin,'subscription');
  assert.equal(first.runtime.dailyLife.events[0].source.contentId,item.id);
  assert.match(first.eventContext,/只读过所给摘录/);
  f.app.store.db.prepare('UPDATE content SET summary=? WHERE id=?').run('更新后的来源文字',item.id);
  f.set('2026-09-08T13:10:00Z');
  assert.equal(f.app.roleContext('miyue',{initiating:true}).eventContext,first.eventContext);
  assert.equal(f.requests.length,0,'source selection and polling are local');
  f.respond(()=>({reply:`刚读到《${item.title}》的一段介绍，大家会留下自己的推荐卡。我挺喜欢这种能看到陌生人阅读感受的角落。${item.url}`,extra:''}));
  const reply=await f.request('/api/desktop/attention',{requestId:'external-opening-001',level:'care'});
  assert.equal(reply.status,200,JSON.stringify(reply));
  const messages=f.app.store.getMessages('miyue');
  assert.equal(messages.length,1);assert.equal(messages[0].speaker,'assistant');
  assert.equal(f.app.store.getRecentContent('miyue').id,item.id);
  const receipt=f.app.store.db.prepare('SELECT packet_json FROM shared_experiences WHERE assistant_message_id=?').get(messages[0].id);
  assert.ok(receipt,'only delivered sharing is recorded');
  assert.equal(JSON.parse(receipt.packet_json).detail,first.runtime.dailyLife.events[0].source.excerpt,'frozen evidence survives source changes');
  const followup=f.app.roleContext('miyue',{initiating:false,text:'这篇文章还讲了什么？'});
  assert.ok(followup.sharedExperience,'followup resolves the actual shared article');
  assert.equal(followup.sharedExperience.source.url,item.url);
  assert.equal(f.requests.length,1,'no separate extraction or review model call');
  f.set('2026-09-12T03:00:00Z');
  const afterExpiry=f.app.roleContext('miyue',{initiating:false,text:'这篇文章还讲了什么？'});
  assert.equal(afterExpiry.runtime.dailyLife.events.length,0);
  assert.ok(afterExpiry.sharedExperience,'expiry removes current life context, not the shared memory');
});

test('an unmentioned reading event is not falsely recorded as shared',async t=>{
  const f=await fixture(t,{dailyLifeRandom:()=>.999});addLifeSource(f.app);
  f.app.companionRuntime.advance();
  const reply=await f.request('/api/desktop/attention',{requestId:'external-unshared-001',level:'care'});
  assert.equal(reply.status,200,JSON.stringify(reply));
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS count FROM shared_experiences').get().count,0);
  assert.equal(f.app.store.getRecentContent('miyue'),null);
});

test('a source with omitted contentId is recorded, excluded across life phases and still available for user followup',async t=>{
  const f=await fixture(t,{dailyLifeRandom:()=>.999});
  const feed=f.app.store.addFeed('https://example.com/suzhou','知乎观点');
  f.app.store.addContent(feed,[{title:'苏州这座城市是不是过誉了? - 知乎｜知乎观点',url:'https://example.com/suzhou/question',publishedAt:'2026-09-08T12:00:00Z',summary:'关于旅游城市生活的讨论，游客看到的是园林、小桥流水，而住在苏州的人还会关注每天买菜、通勤和办理社保的便利。有人分享留电话之后，社区真的打回电话提醒可以办理手续，这种体验也影响他对城市的看法。'}],feed.title);
  const item=f.app.store.listContent()[0];
  f.app.proactiveRepo.saveSettings({enabled:true,activeStart:'00:00',activeEnd:'23:59',dailyLimit:10});
  f.respond(()=>({skip:false,contentId:null,reason:'分享读到的文章',message:'我刚读到“苏州这座城市是不是过誉了”这个讨论，游客和居民看城市的角度确实不同。有人提到社区主动打电话提醒办理手续，我觉得这种小事更能看出生活是否方便。',extra:''}));
  const first=await f.app.proactive.runNow({roleId:'miyue'});
  assert.equal(first.delivered,true,JSON.stringify({first,runtime:f.app.proactiveRepo.getRuntime()}));
  const saved=f.app.store.getMessages('miyue')[0];
  assert.equal(f.app.store.db.prepare('SELECT content_id FROM messages WHERE id=?').get(saved.id).content_id,item.id,'title without the publisher suffix links the source');
  assert.equal(f.app.proactiveRepo.recent()[0].sourceUrl,item.url);
  f.set('2026-09-08T14:01:00Z');
  const opener=f.app.roleContext('miyue',{initiating:true});
  assert.doesNotMatch(opener.eventContext,/过誉/,'a later life phase cannot offer this article as fresh material');
  assert.doesNotMatch(f.app.roleContext('miyue',{initiating:false,opening:true}).eventContext,/过誉/,'desktop openings share the exclusion');
  const prepared=f.app.proactive.getPreparedCandidates(f.app.proactiveRepo.getCandidates(),'miyue');
  assert.ok(!prepared.some(x=>x.id===item.id));
  const duplicate=await f.app.proactive.runNow({roleId:'miyue'});
  assert.equal(duplicate.delivered,false,JSON.stringify(duplicate));
  assert.match(duplicate.reason,/已经聊过/);
  assert.equal(f.app.store.getMessages('miyue').length,1,'even a model repeating history cannot send it again');
  let attentionCalls=0;
  f.respond(()=>({reply:++attentionCalls===1?'我刚读到“苏州这座城市是不是过誉了”的讨论，游客和居民的看法还挺不一样。':'我刚把桌面整理了一下，腾出一小块地方放茶杯，看着舒服多了。',extra:''}));
  const desktop=await f.request('/api/desktop/attention',{requestId:'source-repeat-care',level:'care'});
  assert.equal(desktop.status,200,JSON.stringify(desktop));
  assert.equal(attentionCalls,2,'desktop invitation repairs a repeated source at most once');
  assert.doesNotMatch(desktop.messages[0].text,/过誉/);
  f.respond(()=>({reply:'这篇讨论里让我在意的，就是社区真的打回电话提醒可以办手续。这样的具体经历，比一个城市排名更容易让人有感觉。',extra:''}));
  const followup=await f.request('/api/chat',{role:'miyue',text:'这篇文章还讲了什么？'});
  assert.equal(followup.status,200,JSON.stringify(followup));
  assert.match(JSON.stringify(f.requests.at(-1).messages),/苏州这座城市是不是过誉/,'the user can still ask about the shared source');
});

const choiceCatalog={items:[{id:'test-shirt',kind:'shopping',title:'挑亚麻衬衫',location:'苏州的家中',choice:{key:'color',label:'颜色',options:['米白','浅蓝'],default:'米白',editablePhases:['browsing']},phases:[
  {id:'browsing',label:'正在挑选',detail:'目前偏向{{choice}}，还没有下单。',durationMs:25*60000},
  {id:'waiting',label:'等送达',detail:'{{choice}}衬衫已经下单，正在等送达。',durationMs:42*3600000},
  {id:'arrived',label:'刚收到',detail:'{{choice}}衬衫送到了。',durationMs:8*3600000},
  {id:'recent',label:'最近穿过',detail:'{{choice}}衬衫挂在衣架上。',durationMs:3*86400000}
]}]};

test('an explicit chat choice works without model annotations and persists through delivery stages',async t=>{
  const f=await fixture(t,{dailyLifeCatalog:choiceCatalog});
  const initial=await f.request('/api/companion-runtime');
  assert.equal(initial.dailyLife.events[0].choice.selected,'米白');
  f.respond(()=>({reply:'好，就选浅蓝，听你的。',extra:''}));
  const sent=await f.request('/api/chat',{role:'miyue',text:'选浅蓝吧。'});
  assert.equal(sent.status,200,JSON.stringify(sent));
  assert.equal(f.requests.length,1,'no second extraction call');
  const chosen=await f.request('/api/companion-runtime');
  assert.equal(chosen.dailyLife.events[0].choice.selected,'浅蓝');
  assert.equal(chosen.dailyLife.events[0].choice.adopted,true);
  assert.equal(chosen.dailyLife.events[0].choice.userMessageId,sent.messages[0].id);
  f.set('2026-09-08T13:26:00Z');
  const waiting=f.app.roleContext('miyue',{initiating:true});
  assert.match(waiting.eventContext,/浅蓝/);assert.doesNotMatch(waiting.runtime.dailyLife.events[0].detail,/米白/);
  assert.equal(waiting.runtime.dailyLife.events[0].choice.editable,false);
  f.set('2026-09-10T07:26:00Z');
  const arrived=f.app.roleContext('miyue',{initiating:true});
  assert.equal(arrived.runtime.dailyLife.events[0].phase,'arrived');
  assert.match(arrived.runtime.dailyLife.events[0].detail,/浅蓝/);
  const once=f.app.store.db.prepare("SELECT count(*) AS n FROM inner_state_events WHERE event_id LIKE 'daily:%'").get().n;
  assert.equal(once,1,'arrival changes mood via code');
  await f.request('/api/companion-runtime');
  assert.equal(f.app.store.db.prepare("SELECT count(*) AS n FROM inner_state_events WHERE event_id LIKE 'daily:%'").get().n,once);
});

test('manual event correction rejects stale/late updates and cannot change time, location or arbitrary fields',async t=>{
  const f=await fixture(t,{dailyLifeCatalog:choiceCatalog});
  const first=await f.request('/api/companion-runtime');const eventId=first.dailyLife.events[0].id,revision=first.dailyLife.revision;
  const changed=await f.request('/api/companion-runtime/choice',{revision,eventId,value:'浅蓝'});
  assert.equal(changed.status,200,JSON.stringify(changed));
  assert.equal(changed.dailyLife.events[0].choice.selected,'浅蓝');
  assert.equal((await f.request('/api/companion-runtime/choice',{revision,eventId,value:'米白'})).status,409);
  assert.equal((await f.request('/api/companion-runtime/choice',{revision:changed.dailyLife.revision,eventId,value:'米白',location:'上海'})).status,400);
  f.set('2026-09-08T13:26:00Z');const waiting=await f.request('/api/companion-runtime');
  assert.equal((await f.request('/api/companion-runtime/choice',{revision:waiting.dailyLife.revision,eventId,value:'米白'})).status,409);
  assert.equal(f.requests.length,0);
});

test('model annotations with a fake quote and double-click without a user cannot mutate event choices',async t=>{
  const f=await fixture(t,{dailyLifeCatalog:choiceCatalog});
  const first=await f.request('/api/companion-runtime');const eventId=first.dailyLife.events[0].id;
  f.respond(()=>({reply:'好，就选浅蓝。',extra:'',companionship:{life:[{eventId,action:'choose',value:'浅蓝',evidence:'选浅蓝吧。',responseEvidence:'好，就选浅蓝。'}]}}));
  assert.equal((await f.request('/api/chat',{role:'miyue',text:'今天好累。'})).status,200);
  assert.equal((await f.request('/api/companion-runtime')).dailyLife.events[0].choice.selected,'米白');
  assert.equal((await f.request('/api/desktop/attention',{requestId:'choice-no-user-001',level:'care'})).status,200);
  const after=await f.request('/api/companion-runtime');
  assert.equal(after.dailyLife.events[0].choice.selected,'米白');
  assert.ok(after.dailyLife.recentChanges.some(row=>row.status==='rejected'));
});

test('unprompted event contradictions are repaired once before saving and the next turn sees only the valid reply',async t=>{
  const f=await fixture(t,{dailyLifeCatalog:choiceCatalog});f.app.companionRuntime.advance();
  let calls=0;f.respond(()=>({reply:++calls===1?'辛苦啦。我刚把衬衫下单了。':'辛苦啦，先坐下缓一会，我听你说。',extra:''}));
  const response=await f.request('/api/chat',{role:'miyue',text:'今天开会好累。'});
  assert.equal(response.status,200,JSON.stringify(response));assert.equal(calls,2);
  assert.ok(f.app.store.getMessages('miyue').every(row=>!row.text.includes('衬衫下单了')));
  const current=f.app.companionRuntime.advance();assert.equal(current.dailyLife.events[0].phase,'browsing');
});

test('proactive invalid JSON is retried at most once and produces only one saved message',async t=>{
  const f=await fixture(t,{dailyLifeCatalog:choiceCatalog});f.app.companionRuntime.advance();f.set('2026-09-08T13:26:00Z');
  f.app.proactiveRepo.saveSettings({enabled:true,activeStart:'00:00',activeEnd:'23:59',dailyLimit:10});
  let calls=0;f.respond(()=>++calls===1?'broken JSON':{skip:false,contentId:null,reason:'分享近况',message:'米白的亚麻衬衫在路上了，等它到了我想试试配牛仔裤。',extra:''});
  const result=await f.app.proactive.runNow({roleId:'miyue'});
  assert.equal(result.delivered,true,JSON.stringify(result));assert.equal(calls,2);
  assert.equal(f.app.store.getMessages('miyue').filter(row=>row.speaker==='assistant').length,1);
});

test('failed choice persistence rolls back the chat, choice and receipt together before a clean retry',async t=>{
  const f=await fixture(t,{dailyLifeCatalog:choiceCatalog});f.app.companionRuntime.advance();
  f.respond(()=>({reply:'好，就选浅蓝，听你的。',extra:''}));
  f.app.store.db.exec("CREATE TRIGGER reject_choice BEFORE UPDATE ON metadata WHEN NEW.key='daily_life_state' AND json_extract(NEW.value,'$.events[0].choice.adopted')=1 BEGIN SELECT RAISE(ABORT,'test write failure'); END;");
  const failed=await f.request('/api/chat',{role:'miyue',text:'选浅蓝吧。'});assert.equal(failed.status,500);
  assert.equal(f.app.store.getMessages('miyue').length,0);
  assert.equal(f.app.store.db.prepare('SELECT count(*) AS n FROM daily_life_choice_receipts').get().n,0);
  assert.equal(f.app.companionRuntime.advance().dailyLife.events[0].choice.selected,'米白');
  f.app.store.db.exec('DROP TRIGGER reject_choice');
  const retry=await f.request('/api/chat',{role:'miyue',text:'选浅蓝吧。'});assert.equal(retry.status,200,JSON.stringify(retry));
  assert.equal(f.app.store.getMessages('miyue').length,2);
  assert.equal(f.app.store.db.prepare('SELECT count(*) AS n FROM daily_life_choice_receipts').get().n,1);
});
