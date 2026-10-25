import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
const NOW=new Date('2026-10-06T04:20:00Z');
const sources=[{id:'food',category:'food',title:'菜谱来源',url:'https://example.org/food'},{id:'series',category:'series',title:'剧集来源',url:'https://example.org/series'}];
async function fixture(t,respond,extra={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'daily-info-integration-'));let app,reads=0;const calls=[];
 app=await createApp({dataDir:dir,initialFeeds:[],activeRoleIds:['miyue'],disableStory:true,dynamicCompanion:true,sessionDialogue:true,dialogueMemory:true,sessionGuidance:false,sessionReview:false,dailyInformationSources:sources,
  clock:()=>NOW,startProactive:false,startLife:false,startRuntime:false,startDiscovery:false,startDailyInformation:false,startWeixin:false,startResearch:false,startRecall:false,startDailyLife:false,startLifeThreads:false,startPursuits:false,startDossiers:false,startChatQueue:false,
  integrations:{fetchArticle:async()=>{reads++;return {text:'原文说明这部剧围绕一组邻居经营社区小店，主要看他们之间的关系变化。'};}},env:{LIFE_MODEL_BASE_URL:'https://example.test/v1',LIFE_MODEL_NAME:'fixture'},
  fetchImpl:async(_url,init)=>{const body=JSON.parse(init.body);calls.push(body);const result=await respond(app,body,calls);return Response.json({choices:[{message:{content:typeof result==='string'?result:JSON.stringify(result)}}]});},...extra});
 app.preferences.setReplyPace('instant');
 app.dailyInformation.ingest(sources[0],[{title:'清爽番茄面',url:'https://example.org/noodles',summary:'家常午饭'}]);
 for(let i=0;i<10;i++)app.dailyInformation.ingest(sources[1],[{title:`社区小店剧${i}`,url:`https://example.org/series-${i}`,summary:'电视剧线索'}]);
 const {port}=await app.listen(0);t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 const request=async(route,body)=>{const res=await fetch(`http://127.0.0.1:${port}${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:res.status,body:await res.json()};};
 return {app,calls,request,get reads(){return reads;}};
}
test('ordinary chat reads chosen public detail and only records it after an actual delivered reply',async t=>{
 const f=await fixture(t,(app,body,calls)=>{
  const material=app.dailyInformation.material(app.dailyInformation.list({category:'series'})[0].id);
  assert.match(body.messages.map(m=>m.content).join('\n'),/可选日常信息线索|外部工具回执/);
  return calls.length===1?{request:{name:'explore',query:material.id}}:{reply:'我对邻居共同经营小店这个设定感兴趣，应该很适合放松的时候看。',informationId:material.id.slice('daily-info:'.length)};
 });
 assert.equal(f.reads,0);assert.equal(f.app.dailyInformation.recent().length,0);
 const result=await f.request('/api/chat',{role:'miyue',text:'你想看什么剧？先读一读。'});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(f.reads,1);assert.equal(f.calls.length,2);
 assert.equal(f.app.dailyInformation.recent().length,1);const trace=f.app.dialogueTraces.list()[0];assert.equal(trace.toolCalls[0].name,'explore');
 assert.ok(f.calls[1].messages.some(m=>m.content.includes('社区小店')&&m.content.startsWith('【外部工具回执')));
});
test('category lookup expands selectable candidates beyond the small prompt slate',async t=>{
 let picked;
 const f=await fixture(t,(app,_body,calls)=>{
  if(calls.length===1)return {request:{name:'explore',query:'series'}};
  picked=app.dailyInformation.material(app.dailyInformation.list({category:'series'})[5].id);
  return {reply:'这个社区小店的片名让我想起人与人之间慢慢熟起来的感觉，我有点想看看。',informationId:picked.id};
 });
 const initial=f.app.dailyInformation.slate();assert.equal(initial.some(i=>i.id===f.app.dailyInformation.material(f.app.dailyInformation.list({category:'series'})[5].id).id),false);
 const result=await f.request('/api/chat',{role:'miyue',text:'看看有没有别的剧。'});assert.equal(result.status,200);assert.equal(f.reads,0);assert.equal(f.app.dailyInformation.recent()[0].item_id,picked.id.slice('daily-info:'.length));
});
test('the existing preparation call selects a category and expands real titles without another model call',async t=>{
 let picked;const f=await fixture(t,(app,body,calls)=>{
  if(calls.length===1){assert.ok(body.messages.some(m=>m.role==='system'&&/informationCategory/.test(m.content)));return {guidance:[],informationCategory:'series'};}
  picked=app.dailyInformation.material(app.dailyInformation.list({category:'series'})[5].id);
  assert.ok(body.messages.some(m=>m.content.includes('按本轮模型判断扩展的日常标题目录')&&m.content.includes(picked.id)));
  return {reply:'这个社区小店的片名听着很有意思，我想看看这种慢慢熟起来的关系。',informationId:picked.id};
 },{sessionGuidance:true});
 const result=await f.request('/api/chat',{role:'miyue',text:'聊一个你自己想看的剧。'});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(f.calls.length,2);assert.equal(f.reads,0);
 assert.equal(f.app.dailyInformation.recent()[0].item_id,picked.id.slice('daily-info:'.length));assert.equal(f.app.dialogueTraces.list()[0].informationSelection.category,'series');
});
test('proactive selection can read public detail in its bounded session and preserve source receipts',async t=>{
 const f=await fixture(t,(app,_body,calls)=>{
  const material=app.dailyInformation.material(app.dailyInformation.list({category:'series'})[0].id);
  return calls.length===1?{request:{name:'explore',query:material.id}}:{skip:false,message:'看到一部邻居共同经营社区小店的剧，我有点喜欢这种慢慢熟起来的关系。',reason:'分享一个影视兴趣',contentId:null,initiative:{state:'open',materialId:material.id.slice('daily-info:'.length),quote:'邻居共同经营社区小店的剧'},informationId:material.id};
 });
 f.app.proactiveRepo.saveSettings({enabled:true,activeStart:'00:00',activeEnd:'23:59',dailyLimit:12,desktopNotifications:false});
 const result=await f.app.proactive.runNow({roleId:'miyue'});assert.equal(result.delivered,true,JSON.stringify(f.app.proactiveRepo.getRuntime()));assert.equal(f.reads,1);assert.equal(f.calls.length,2);
 assert.equal(f.app.dailyInformation.recent().length,1);assert.equal(result.message.sourceUrl,'https://example.org/series-0');
 assert.equal(f.app.store.getMessages('miyue').some(m=>m.speaker==='user'),false);
});
test('public title collection is available without sending any messages',async t=>{
 const f=await fixture(t,()=>{throw Error('model must not run');});
 const status=f.app.dailyInformation.status();assert.equal(status.total,11);assert.equal(f.calls.length,0);assert.equal(f.app.store.getMessages('miyue').length,0);
});
test('auxiliary information receipts accept the same fenced and literal-newline envelopes as the reply parser',async t=>{
 const f=await fixture(t,app=>{
  const id=app.dailyInformation.material(app.dailyInformation.list({category:'food'})[0].id).id;
  return '```json\n{"reply":"我想吃番茄面。\n\n清淡一点就好。","informationId":"'+id+'"}\n```';
 });
 const result=await f.request('/api/chat',{role:'miyue',text:'想吃什么？'});assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(f.app.dailyInformation.recent().length,1);
 // One reply is one chat message: short multi-line replies are joined.
 assert.equal(result.body.messages.at(-1).text,'我想吃番茄面。清淡一点就好。');
});
