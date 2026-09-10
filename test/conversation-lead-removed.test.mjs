import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createApp} from '../server.mjs';
async function setup(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'lead-integration-'));let reply='那种鲜亮的橙色，确实很让人记得住。';const calls=[];
 const app=await createApp({dataDir:dir,env:{LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture'},initialFeeds:[],startProactive:false,startRecall:false,startPursuits:false,startLifeThreads:false,startDossiers:false,replySleep:async()=>{},random:()=>.5,fetchImpl:async(_url,init)=>{calls.push(JSON.parse(init.body));return Response.json({choices:[{message:{content:JSON.stringify({reply,extra:'这件小事我也挺想和你聊聊。'})}}]});}});const {port}=await app.listen(0);t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 return{app,calls,setReply:text=>reply=text,seed(){app.store.saveChatTurn({role:'miyue',text:'早上还在下雨，现在大太阳了。',reply:'太阳出来，颜色也显得明亮了。'});app.store.saveChatTurn({role:'miyue',text:'喝了薄荷柠檬水，还加了冰。',reply:'你这是抓紧享受夏天的清凉呢。'});},async chat(text){const r=await fetch(`http://127.0.0.1:${port}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:'miyue',text})});return{status:r.status,...await r.json()};}};}
const orange='你说的是呢。以前可喜欢夏天在阳光里放一杯橙汁，那明艳的橙色真的充满活力';

for (const text of [orange,'嗯','确实']) test(`ordinary replies never inject a prepared next topic: ${text}`,async t=>{
 const f=await setup(t);f.seed();f.setReply('我也喜欢那个颜色。阳光照着的时候尤其好看。');const result=await f.chat(text);assert.equal(result.status,200,JSON.stringify(result));
 const assistant=result.messages.at(-1),receipt=f.app.interactionPolicy.receipt(assistant.id);assert.equal(receipt.conversationLead,undefined);assert.equal(receipt.hasAuthoredAnchor,false);assert.doesNotMatch(assistant.text,/气泡水|还没实践的小念头/);assert.ok(assistant.text.includes('阳光照着的时候尤其好看'));
 assert.equal(f.app.store.db.prepare('SELECT COUNT(*) n FROM shared_experiences WHERE assistant_message_id=?').get(assistant.id).n,0);
 assert.doesNotMatch(JSON.stringify(f.calls.at(-1)),/本轮由她接过话题|橙汁、气泡和一点薄荷/);
});
test('an explicit request still lets her speak, without a canned topic appended',async t=>{
 const f=await setup(t);f.setReply('我最近想整理几张随手拍的照片，挑出光线最好的一张。');const result=await f.chat('换个话题，你来说点什么吧');assert.equal(result.status,200,JSON.stringify(result));const assistant=result.messages.at(-1);
 assert.match(assistant.text,/整理几张随手拍的照片/);assert.equal(f.app.interactionPolicy.receipt(assistant.id).conversationLead,undefined);assert.doesNotMatch(assistant.text,/你想聊什么|还没实践的小念头/);
});
