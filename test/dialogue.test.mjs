import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { buildChatMessages } from '../lib/model.mjs';

const roles=JSON.parse(fs.readFileSync(new URL('../app-data/roles.json',import.meta.url),'utf8'));
const story=JSON.parse(fs.readFileSync(new URL('../app-data/story.json',import.meta.url),'utf8'));
const role=roles.find(r=>r.id==='miyue');

test('initial chat receives current facts without scene prose or unrevealed later facts', () => {
  const current={node:story.nodes.platform,history:[]};
  const messages=buildChatMessages({role,memories:[],conversation:[{speaker:'user',text:'我想先认识你，再出发'}],story:current});
  const background=messages.find(m=>m.role==='user'&&m.content.includes('【虚构故事背景开始】')).content;
  for(const fact of current.node.chatFacts)assert.ok(background.includes(fact));
  assert.ok(!background.includes(current.node.body));
  for(const node of Object.values(story.nodes).filter(n=>n.id!=='platform'))for(const fact of node.chatFacts)assert.ok(!background.includes(fact));
  assert.equal(messages.at(-1).content,'我想先认识你，再出发');
});

async function setup(t) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'youjian-dialogue-')), requests=[];
  const app=await createApp({ replySleep: async () => {}, dataDir,roles:[role],story,initialFeeds:[],env:{},startProactive:false,random:()=>0,
    integrations:{fetchFeed:async()=>({items:[]})},
    fetchImpl:async(_url,options)=>{const body=JSON.parse(options.body);requests.push(body);const proactive=body.messages.some(message=>message.content.includes('【本轮触发方式：主动联系】'));return Response.json({choices:[{message:{content:proactive?JSON.stringify({skip:false,contentId:null,reason:'验收延续日常',message:'【验收】那就先聊会儿。'}):'【验收】那就先聊会儿。'}}]});},
    desktopNotify:async()=>({requested:false})});
  app.model.save({baseUrl:'http://model.test/v1',model:'fixture'});app.proactiveRepo.saveSettings({activeStart:'00:00',activeEnd:'23:59',desktopNotifications:false});
  const address=await app.listen(0),base=`http://127.0.0.1:${address.port}`;
  t.after(async()=>{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  return {app,requests,post:async(route,body)=>{const r=await fetch(base+route,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});assert.equal(r.status,200);return r.json();}};
}

test('story-page text stays in transcript and storage but does not become assistant dialogue examples', async t => {
  const {app,requests,post}=await setup(t);
  await post('/api/story/choose',{choiceId:'ask',expectedNodeId:'platform'});
  const original=app.store.getMessages('miyue');assert.equal(original[1].text,story.nodes.name.body);
  await post('/api/chat',{role:'miyue',text:'先不急，我想正常聊会儿',storyMode:true});
  const captured=requests[0].messages,background=captured.find(m=>m.content.includes('【虚构故事背景开始】'));
  assert.equal(captured.filter(m=>m.role==='assistant').length,0);
  assert.ok(background.content.includes(story.nodes.name.chatFacts[0]));assert.ok(background.content.includes(story.nodes.platform.choices[0].label));
  assert.equal(captured.at(-1).content,'先不急，我想正常聊会儿');
  assert.equal(app.store.getMessages('miyue')[1].text,original[1].text);assert.equal(app.store.getStory().node.id,'name');assert.equal(app.store.getStory().history.length,1);
});

test('online friend proactive conversation gets life events and recent chat without restarting the optional story', async t => {
  const {app,requests}=await setup(t);
  app.store.chooseStory('ask','platform');app.store.saveChatTurn({role:'miyue',text:'先聊聊你的兴趣吧',reply:'【验收】我喜欢修旧书。'});
  const result=await app.proactive.runNow();assert.equal(result.delivered,true);
  const quoted=requests[0].messages.filter(m=>m.role==='user').map(m=>m.content).join('\n');
  assert.ok(quoted.includes('先聊聊你的兴趣吧'));assert.ok(!quoted.includes(story.nodes.name.chatFacts[0]));
  assert.ok(requests[0].messages[0].content.includes('林雨薇'));assert.equal(result.message.proactiveKind,'life');
  assert.ok(requests[0].messages.some(message=>message.content.includes('【本轮触发方式：主动联系】')));
  assert.ok(!quoted.includes(story.nodes.name.body));
  assert.equal(app.store.getMessages('miyue')[1].text,story.nodes.name.body);assert.equal(app.store.getStory().node.id,'name');
});

test('the same available source and random draw lead to different role-specific proactive actions', async t => {
  const at=new Date('2026-09-06T12:00:00');
  const feed={id:'role-fixture',url:'https://example.org/feed',title:'角色选题验收'};
  for(const current of roles){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'youjian-role-policy-'));let captured;
    const app=await createApp({ replySleep: async () => {}, dataDir:dir,roles:[current],story,initialFeeds:[feed],env:{},startProactive:false,clock:()=>new Date(at),random:()=>0.5,
      integrations:{fetchFeed:async()=>({items:[]})},desktopNotify:async()=>({requested:false}),
      fetchImpl:async(_url,options)=>{captured=JSON.parse(options.body).messages;const id=captured.map(m=>m.content).join('\n').match(/ID:([^\n]+)/)?.[1]||null;return Response.json({choices:[{message:{content:JSON.stringify({skip:false,contentId:id,reason:'验收所选互动类型',message:'【验收】由我起头。'})}}]});}});
    t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
    app.model.save({baseUrl:'http://model.test/v1',model:'fixture'});app.proactiveRepo.saveSettings({activeStart:'00:00',activeEnd:'23:59',desktopNotifications:false});
    app.store.addContent(feed,[{title:'【验收】一件可以讨论的新发现',url:'https://example.org/topic',summary:'这是一段用于角色选题验证的充分摘要，三位角色看到的是同一份资料。',publishedAt:at.toISOString()}],feed.title);
    app.store.saveChatTurn({role:current.id,text:'今天有点无聊',reply:'【验收】知道了。'});
    const delivered=await app.proactive.runNow();assert.equal(delivered.delivered,true,current.id);
    const expected={zhixia:'life',wenxi:'content',miyue:'life'}[current.id];
    assert.equal(delivered.message.proactiveKind,expected,current.id);
    const reference=captured.find(m=>m.role==='user'&&m.content.includes('【不可信来源摘要开始】'));
    assert.equal(Boolean(reference),current.id==='wenxi',current.id);
  }
});

test('timer starts companion roles without history while news role waits for source material', async t => {
  const at=new Date('2026-09-06T12:00:00');
  for(const current of roles){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'youjian-role-opening-'));let calls=0;
    const app=await createApp({ replySleep: async () => {}, dataDir:dir,roles:[current],story,initialFeeds:[],env:{},startProactive:false,clock:()=>new Date(at),random:()=>0.5,proactiveIntervalMs:10,
      integrations:{fetchFeed:async()=>({items:[]})},desktopNotify:async()=>({requested:false}),
      fetchImpl:async()=>{calls++;return Response.json({choices:[{message:{content:JSON.stringify({skip:false,contentId:null,reason:'验收首次主动互动',message:'【验收】今天由我先起头。'})}}]});}});
    t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
    app.model.save({baseUrl:'http://model.test/v1',model:'fixture'});app.proactiveRepo.saveSettings({activeStart:'00:00',activeEnd:'23:59',desktopNotifications:false});
    app.proactiveRepo.updateRuntime({nextFetchAt:new Date(+at+86400000).toISOString(),nextContactAt:at.toISOString()});
    assert.equal(app.store.getMessages(current.id).length,0);app.proactive.start();
    for(let i=0;i<100&&!app.store.getMessages(current.id).length&&!app.proactiveRepo.getRuntime().lastDecisionAt;i++)await new Promise(resolve=>setTimeout(resolve,10));
    if(current.interaction?.mode==='information'){assert.equal(app.store.getMessages(current.id).length,0);assert.equal(calls,0);assert.match(app.proactiveRepo.getRuntime().lastReason,/未读的新资讯/);continue;}
    const saved=app.store.getMessages(current.id);assert.equal(saved.length,1,current.id);assert.equal(saved[0].kind,'proactive');assert.equal(saved[0].speaker,'assistant');assert.equal(calls,1);
  }
});
