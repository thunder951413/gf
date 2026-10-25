import { testRoles } from './support/role-fixtures.mjs';
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createApp} from '../server.mjs';
async function fixture(t) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'roles-v07-'));const calls=[];
 const app=await createApp({roles:testRoles(), replySleep: async () => {}, dataDir:dir,env:{LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture'},initialFeeds:[],startProactive:false,startRecall:false,clock:()=>new Date('2026-09-07T02:00:00Z'),lifeRandom:()=>.99,random:()=>.5,integrations:{fetchFeed:async()=>({items:[]})},fetchImpl:async(_u,o)=>{calls.push(JSON.parse(o.body));return Response.json({choices:[{message:{content:'【测试】我先听你说，我们接着这里聊。'}}],usage:{prompt_tokens:100,completion_tokens:20}})}});
 const {port}=await app.listen(0);t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true})});
 const req=async(url,body)=>{const r=await fetch(`http://127.0.0.1:${port}${url}`,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});return {status:r.status,body:await r.json()}};
 return {app,calls,req};
}
test('role order and three distinct modes are public; scenario choices and chat are atomic with separate recall scopes',async t=>{
 const {app,calls,req}=await fixture(t);const boot=(await req('/api/bootstrap')).body;assert.deepEqual(boot.roles.map(r=>[r.id,r.interaction.mode]),[['miyue','companion'],['wenxi','information'],['zhixia','scenario']]);
 const initial=app.scenarios.get();app.store.saveChatTurn({role:'zhixia',text:'旧世界不该出现的地点',reply:'旧人物共同前史'});
 const first=await req('/api/chat',{role:'zhixia',text:'本情境里我想先慢慢观察'});assert.equal(first.status,200);assert.doesNotMatch(JSON.stringify(calls.at(-1)),/旧世界不该出现|旧人物共同前史/);
 const choice=initial.choices[0];assert.equal((await req('/api/chat',{role:'zhixia',text:choice.label,scenarioChoiceId:choice.id,scenarioVersion:initial.version})).status,200);
 const advanced=app.scenarios.get();assert.notEqual(advanced.scene.id,initial.scene.id);assert.equal(advanced.state.history.length,1);
 const scope=`zhixia::scenario:${initial.current.id}`;assert.equal(app.recallRepo.get(scope).pendingCount,4);app.recallRepo.replace(scope,'这个世界独有的回忆线索');
 const another=initial.scenarios.find(s=>s.id!==initial.current.id);await req('/api/scenarios',{action:'select',id:another.id,version:advanced.version});
 await req('/api/chat',{role:'zhixia',text:'说说现在的事情'});assert.doesNotMatch(JSON.stringify(calls.at(-1)),/这个世界独有的回忆线索|本情境里我想先慢慢观察/);
 await req('/api/scenarios',{action:'select',id:initial.current.id,version:app.scenarios.get().version});assert.equal(app.scenarios.get().scene.id,advanced.scene.id);
 await req('/api/chat',{role:'zhixia',text:'我们回来了'});assert.match(JSON.stringify(calls.at(-1)),/这个世界独有的回忆线索/);
 const n=calls.length;assert.equal((await req('/api/chat',{role:'zhixia',text:choice.label,scenarioChoiceId:choice.id,scenarioVersion:initial.version})).status,409);assert.equal(calls.length,n);
});
test('failure during scenario commit rolls back the chat and scope together',async t=>{
 const {app,req}=await fixture(t);const before=app.scenarios.get();const original=app.scenarios.commitTurn.bind(app.scenarios);app.scenarios.commitTurn=(...args)=>{original(...args);throw new Error('controlled commit failure')};
 const result=await req('/api/chat',{role:'zhixia',text:before.choices[0].label});assert.equal(result.status,500);assert.equal(app.store.getMessages('zhixia').length,0);assert.equal(app.scenarios.get().scene.id,before.scene.id);assert.equal(app.store.db.prepare('SELECT count(*) n FROM scenario_message_scope').get().n,0);
});
test('information chat uses cached original detail and related differences without another fetch or analysis call',async t=>{
 const {app,calls,req}=await fixture(t);const feed=app.store.addFeed('https://example.org/rss','验收公开来源');app.store.addContent(feed,[{title:'城市阅读计划公布试点细则',url:'https://example.org/a',summary:'这是一份明确用于验收的公开资料摘要。'.repeat(6)},{title:'城市阅读计划公布试点细则！',url:'https://example.org/b',summary:'另一来源补充：试点仅限周末，不代表全市常态运行。'.repeat(4)}],feed.title);
 let fetched=0;const items=app.store.listContent();await app.dossiers.prepare(items,{fetchArticle:async url=>{fetched++;return {url,extracted:true,text:('【验收原文细节】借阅凭证使用橙色编号，每周六开放三小时。\n').repeat(12)}},limit:2});
 const chosen=items[0];assert.equal((await req('/api/chat',{role:'wenxi',text:'具体怎么参加？',contentId:chosen.id})).status,200);
 assert.equal(calls.length,1);assert.equal(fetched,2);const prompt=JSON.stringify(calls[0]);assert.match(prompt,/橙色编号|每周六开放三小时/);assert.match(prompt,/不代表交叉核验/);assert.match(prompt,/原始|片段/);
 await req('/api/chat',{role:'wenxi',text:'刚才那个时间细节再说说'});assert.equal(fetched,2);assert.match(JSON.stringify(calls[1]),/橙色编号/);
});
test('gentle correction is attached only to the current offending turn and retains the fixed cache prefix',async t=>{
 const {app,calls,req}=await fixture(t);await req('/api/chat',{role:'wenxi',text:'你只管听我的，别自己决定。'});assert.match(JSON.stringify(calls.at(-1)),/本轮相处提示/);const system=calls.at(-1).messages[0];
 await req('/api/chat',{role:'wenxi',text:'你只管听我的'});assert.deepEqual(calls.at(-1).messages[0],system);assert.match(JSON.stringify(calls.at(-1)),/当前不要再次主动纠正/);assert.equal(app.store.db.prepare('SELECT turns FROM gentle_feedback WHERE role_id=?').get('wenxi').turns,2);
});
test('scenario compound pause utterance persists and the opening names are supplied to ordinary chat',async t=>{
 const {app,calls,req}=await fixture(t);await req('/api/chat',{role:'zhixia',text:'你来起头'});assert.match(JSON.stringify(calls.at(-1)),/银河影院/);
 await req('/api/chat',{role:'zhixia',text:'先暂停故事，今天有点累，陪我说两句吧。'});assert.equal(app.scenarios.get().state.paused,true);assert.match(JSON.stringify(calls.at(-1)),/退出现场描写/);
});
