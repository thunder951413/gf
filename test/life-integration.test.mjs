import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createApp} from '../server.mjs';import {Store} from '../lib/store.mjs';import {RecallRepository} from '../lib/recall.mjs';
const roleId='miyue';const json=(body,method='POST')=>({method,headers:{'content-type':'application/json'},body:JSON.stringify(body)});
async function fixture(t,{fetchImpl,...options}={}){
 const dataDir=options.dataDir||fs.mkdtempSync(path.join(os.tmpdir(),'life-event-api-'));let time=new Date('2026-09-07T02:00:00Z');const calls=[];
 const app=await createApp({startPursuits:false, replySleep: async () => {}, dataDir,initialFeeds:[],startProactive:false,startLifeThreads:false,startRecall:false,clock:()=>new Date(time),lifeRandom:()=>0,random:()=>.5,env:{LIFE_MODEL_BASE_URL:'https://model.test/v1',LIFE_MODEL_NAME:'fixture'},integrations:{fetchFeed:async()=>({items:[]})},...options,fetchImpl:async(...args)=>{calls.push(JSON.parse(args[1].body));return fetchImpl?fetchImpl(...args):Response.json({usage:{prompt_tokens:100,completion_tokens:40},choices:[{message:{content:calls.at(-1).messages.some(message=>message.content.includes('【本轮触发方式：主动联系】'))?JSON.stringify({skip:false,contentId:null,reason:'当前旅行阶段有进展',message:'【测试】分享此刻行程。'}):'【测试】继续聊当前的事情。'}}]})}});
 app.proactiveRepo.saveSettings({activeStart:'00:00',activeEnd:'23:59',desktopNotifications:false,dailyLimit:12});const {port}=await app.listen(0);
 t.after(async()=>{await app.close();fs.rmSync(dataDir,{recursive:true,force:true})});
 return {app,calls,setTime:value=>time=new Date(value),advance:hours=>time=new Date(+time+hours*3600000),now:()=>new Date(time),request:async(url,body,method)=>{const r=await fetch(`http://127.0.0.1:${port}${url}`,body===undefined?{}:json(body,method));return {status:r.status,body:await r.json()}}};
}
test('upgrade archives old persona recall, preserves raw messages and user preferences, and excludes retired assistant history',async t=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'life-event-migrate-'));const store=new Store({dataDir,story:JSON.parse(fs.readFileSync('app-data/story.json','utf8'))});const repo=new RecallRepository(store);store.saveChatTurn({role:roleId,text:'我喝茶不要太浓。',reply:'旧人物独有秘密：毕业那天我们一起修书。'});repo.replace(roleId,'旧摘要：我们是老同学。');store.addMemory(roleId,'我喜欢具体、有来有回的分享。');store.close();
 const {app,request,calls}=await fixture(t,{dataDir});assert.equal(app.store.getMessages(roleId).length,2);assert.match(app.store.db.prepare('SELECT summary FROM persona_recall_archive').get().summary,/老同学/);
 await request('/api/chat',{role:roleId,text:'从现在认识，你先说说自己。'});const quoted=calls.at(-1).messages.filter(m=>m.role!=='system').map(m=>m.content).join('\n');assert.match(quoted,/我喝茶不要太浓/);assert.match(quoted,/具体、有来有回/);assert.doesNotMatch(quoted,/旧人物独有秘密|旧摘要|老同学/);assert.equal(app.store.getMessages(roleId).length,4);
});
test('API advances conversation angles within the same trip phase and accounts for life tokens',async t=>{
 const {app,request,advance,now,calls}=await fixture(t);const start=(await request('/api/life')).body;assert.equal(start.active.type,'travel');assert.equal(start.active.phase.id,'plan');
 const first=await app.proactive.runNow();assert.equal(first.delivered,true);assert.equal(first.message.role,roleId);assert.equal(first.message.proactiveKind,'life');assert.ok(calls[0].messages.some(message=>message.content.includes('【本轮触发方式：主动联系】')));assert.equal((await request('/api/life')).body.discussion.angle.id,'culture');
 assert.ok((await request('/api/life')).body.discussion.angles.find(angle=>angle.id==='food').shared);assert.equal(app.usage.snapshot().byPurpose.find(row=>row.purpose==='life').totalTokens,140);
 advance(2);app.proactiveRepo.respondToRole(roleId,now().toISOString());const away=app.life.get(roleId);assert.equal(away.active.destination,start.active.destination);assert.equal(away.active.phase.id,'plan');
 const next=await app.proactive.runNow();assert.equal(next.delivered,true);assert.ok((await request('/api/life')).body.discussion.angles.find(angle=>angle.id==='culture').shared);assert.equal(app.store.db.prepare("SELECT COUNT(*) n FROM proactive_events WHERE topic_key LIKE 'life-topic:%'").get().n,2);
 const before=app.life.get(roleId).active.id;assert.equal((await request('/api/life/settings',{weeklyTravelChance:.5})).status,200);assert.equal(app.life.get(roleId).active.id,before);assert.equal((await request('/api/life/settings',{weeklyTravelChance:2})).status,400);
});
test('a stale proactive travel opportunity is withheld when the authoritative runtime changes during generation',async t=>{
 let release,started;const ready=new Promise(resolve=>started=resolve);const {app,advance}=await fixture(t,{fetchImpl:async()=>{started();await new Promise(resolve=>release=resolve);return Response.json({usage:{prompt_tokens:20,completion_tokens:10},choices:[{message:{content:JSON.stringify({skip:false,contentId:null,reason:'准备出发',message:'当地饮食的差别很适合慢慢聊。'})}}]})}});
 const pending=app.proactive.runNow();await ready;advance(28);release();const result=await pending;assert.equal(result.delivered,false);assert.match(result.reason,/已变化/u);assert.equal(app.store.getMessages(roleId).length,0);assert.equal(app.usage.snapshot().allTime.totalTokens,30);
});
test('ordinary chat completes normally when a background phase advances',async t=>{
 let release,started,attempts=0;const ready=new Promise(resolve=>started=resolve);const {app,request,advance}=await fixture(t,{fetchImpl:async()=>{attempts++;started();if(attempts===1)await new Promise(resolve=>release=resolve);return Response.json({usage:{prompt_tokens:20,completion_tokens:10},choices:[{message:{content:'可以聊聊你感兴趣的当地文化。'}}]})}});
 const pending=request('/api/chat',{role:roleId,text:'我们聊聊当地文化？'});await ready;advance(28);release();const result=await pending;assert.equal(result.status,200);assert.equal(app.store.getMessages(roleId).length,2);
});

test('regional material survives unrelated feed competition and enters proactive and ordinary follow-up contexts',async t=>{
 const {app,request,calls}=await fixture(t,{fetchImpl:async(_url,options)=>{const payload=JSON.parse(options.body);const all=payload.messages.map(m=>m.content).join('\n');const id=all.match(/ID:([^\n]+)/)?.[1]||null;const proactive=payload.messages.some(message=>message.content.includes('【本轮触发方式：主动联系】'));return Response.json({choices:[{message:{content:proactive?JSON.stringify({skip:false,contentId:id,reason:'当地饮食可以聊开',message:'【测试】这段扬州饮食资料让我想到慢慢吃饭的节奏。'}):'【测试】可以接着聊这个差别。'}}]})}});
 const feed=app.store.addFeed('https://source.test/rss','测试来源');app.store.addContent(feed,[...Array.from({length:30},(_,i)=>({title:`技术新闻${i}`,url:`https://source.test/news/${i}`,summary:'这是与当地生活无关的技术新闻摘要，长度超过二十个字符。'})),{title:'扬州饮食与生活',url:'https://source.test/yangzhou',summary:'【资料证据】扬州饮食文化可以从家庭餐桌、吃饭的节奏与地方生活的关系展开讨论。'}]);
 const sent=await app.proactive.runNow();assert.equal(sent.delivered,true);assert.equal(sent.message.sourceUrl,'https://source.test/yangzhou');assert.match(calls[0].messages.map(m=>m.content).join('\n'),/资料证据/);
 await request('/api/chat',{role:roleId,text:'你说的吃饭节奏有什么意思？'});const followup=calls.at(-1).messages.map(m=>m.content).join('\n');assert.match(followup,/资料证据/);assert.match(followup,/https:\/\/source.test\/yangzhou/);
 // Even before an article is explicitly selected, relevant material is available.
 app.store.db.prepare('UPDATE messages SET content_id=NULL WHERE role=?').run(roleId);
 await request('/api/chat',{role:roleId,text:'再聊聊当地饮食吧'});assert.match(calls.at(-1).messages.map(m=>m.content).join('\n'),/生活话题参考资料开始/);
});

test('the authoritative runtime activity drives API and model context across travel deadlines',async t=>{
 const {app,request,calls,setTime}=await fixture(t);
 const start=(await request('/api/life')).body,trip=start.active;
 assert.equal(start.world.event.phase.id,'plan');
 assert.equal(start.world.location,'苏州的家中');
 assert.match(start.world.activity,/整理去/);
 assert.notEqual(start.world.activity,trip.title);
 const tuning=app.companionTuning.get();
 for(const phase of trip.phases){
   setTime(new Date(Date.parse(trip.startedAt)+phase.offsetHours*3600000));
   const snapshot=(await request('/api/life')).body;
   const runtime=(await request('/api/companion-runtime')).body;
   assert.equal(snapshot.world.location,runtime.world.location);
   assert.equal(snapshot.world.activity,runtime.world.activity);
   assert.ok(snapshot.world.activity);
   assert.equal(snapshot.world.event.phase.id,phase.id);
   assert.ok(Date.parse(snapshot.world.nextTransitionAt)>Date.parse(snapshot.world.at));
   assert.deepEqual(snapshot.world.traits,tuning.values);
   const proactive=app.proactive.getRoleContext('miyue').characterContext;
   assert.ok(proactive.includes(`地点：${snapshot.world.location}`));
   assert.ok(proactive.includes(`正在做：${snapshot.world.activity}`));
   assert.ok(proactive.includes(`阶段：${phase.title}`));
   const sent=await request('/api/chat',{role:roleId,text:'你现在在哪儿，在做什么？'});
   assert.equal(sent.status,200);
   const context=calls.at(-1).messages.find(m=>m.content.startsWith('【本轮背景开始】')).content;
   assert.ok(context.includes(`地点：${snapshot.world.location}`));
   assert.ok(context.includes(`正在做：${snapshot.world.activity}`));
   assert.match(context,/身心状态（0—100）：疲劳\d+/);
   assert.match(context,/人物属性（0—100）：讨好倾向\d+/);
 }
 app.life.saveSettings({weeklyTravelChance:0});
 app.life.random=()=>.99;
 setTime(trip.endsAt);
 const ended=(await request('/api/life')).body;
 const endedRuntime=(await request('/api/companion-runtime')).body;
 assert.equal(ended.active,null);
 assert.equal(ended.world.event,null);
 assert.equal(ended.world.location,endedRuntime.world.location);
 assert.ok(!ended.world.activity.includes('返程'));
 const receipt=ended.recent.find(event=>event.id===trip.id);
 assert.equal(receipt.status,'completed');
 assert.equal(receipt.completedAt,trip.endsAt);
 assert.deepEqual(app.companionTuning.get(),tuning);
});
