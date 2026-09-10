import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildChatMessages } from '../lib/model.mjs';
import { buildProactiveMessages } from '../lib/proactive.mjs';
import { requestEmotionEnvelope } from '../lib/emotion-dialogue.mjs';
import { Store } from '../lib/store.mjs';
import { CharacterRepository } from '../lib/characters.mjs';
const role=JSON.parse(fs.readFileSync('app-data/roles.json','utf8')).find(r=>r.id==='miyue');
const transcript=[{speaker:'user',text:'我喜欢清淡一点的茶。'},{speaker:'assistant',text:'那就记着这个口味，下次聊茶可以接着说。'}];
const common={role,memories:[{text:'用户不喜欢被催回复'}],recallContext:'累计回忆：下次想聊江南饮食',conversation:[...transcript,{speaker:'user',text:'继续聊聊'}]};
const indexOf=(messages,text)=>messages.findIndex(m=>m.content.includes(text));

test('changing time, place, mood and sources leaves persona, memory and transcript prefix identical',()=>{
 const first=requestEmotionEnvelope(buildChatMessages({...common,characterContext:'现在在苏州，上午，心情轻松',content:{title:'茶叶',summary:'绿茶相关材料'}}));
 const second=requestEmotionEnvelope(buildChatMessages({...common,characterContext:'现在在丽江，晚上，有点累；保持朋友距离',content:{title:'食物',summary:'另一份资料'}}));
 const boundary=indexOf(first,'【本轮背景开始】');
 assert.deepEqual(first.slice(0,boundary),second.slice(0,boundary));
 assert.ok(indexOf(first,'我喜欢清淡一点的茶')<boundary);
 assert.match(second[boundary].content,/丽江.*有点累.*朋友距离/);
 assert.doesNotMatch(second[0].content,/现在在丽江|现在在苏州/);
 assert.equal(second.at(-1).content,'继续聊聊');
 assert.deepEqual(JSON.parse(second[indexOf(second,'下次聊茶')].content).reply,transcript[1].text);
});
test('new user input and new conversation extend the available history without mutating old rows',()=>{
 const before=structuredClone(common);
 const first=buildChatMessages({...common,characterContext:'旧状态'});
 const conversation=[...common.conversation,{speaker:'assistant',text:'可以，先聊茶。'},{speaker:'user',text:'那么你爱喝什么？'}];
 const second=buildChatMessages({...common,conversation,characterContext:'新状态'});
 const boundary=indexOf(first,'【本轮背景开始】');
 assert.deepEqual(first.slice(0,boundary),second.slice(0,boundary));
 assert.equal(second[boundary].content,'继续聊聊');
 assert.equal(second.at(-1).content,'那么你爱喝什么？');
 assert.deepEqual(common,before);
});
test('rolling summary changes preserve the fixed persona and explicit memories and replace stale summary',()=>{
 const old=buildChatMessages({...common,characterContext:'旧状态'});
 const updated=buildChatMessages({...common,recallContext:'累计回忆：用户更正了口味',characterContext:'新状态'});
 assert.deepEqual(old.slice(0,2),updated.slice(0,2));
 assert.match(updated[2].content,/更正了口味/);
 assert.ok(!updated.some(m=>m.content.includes('下次想聊江南饮食')));
});
test('proactive plan and environment changes do not rewrite the fixed system or memories',()=>{
 const input={...common,topics:'日常',candidates:[],kind:'life',characterContext:'苏州做饭'};
 const first=buildProactiveMessages(input),second=buildProactiveMessages({...input,kind:'conversation',characterContext:'丽江旅行'});
 const boundary=indexOf(first,'【本轮背景开始】');
 assert.deepEqual(first.slice(0,boundary),second.slice(0,boundary));
 assert.match(second[boundary].content,/丽江旅行/);
 assert.ok(second.some(m=>m.content==='计划类型：conversation。'));
});
test('user and proactive triggers share the exact persona, memory, recall and historical prefix',()=>{
 const base={role,memories:common.memories,recallContext:common.recallContext,conversation:transcript,story:null,characterContext:'同一份当前状态'};
 const user=requestEmotionEnvelope(buildChatMessages({...base,currentUserText:'继续聊聊'}));
 const proactive=buildProactiveMessages({...base,currentUserText:null,topics:'日常',candidates:[],kind:'life'});
 const userBoundary=indexOf(user,'【本轮背景开始】');
 const proactiveBoundary=indexOf(proactive,'【本轮背景开始】');
 assert.ok(userBoundary>0&&proactiveBoundary>0);
 assert.deepEqual(user.slice(0,userBoundary),proactive.slice(0,proactiveBoundary));
 assert.deepEqual(user.slice(0,userBoundary).map(message=>message.role),['system','user','user','user','assistant']);
 assert.doesNotMatch(user.slice(0,userBoundary).map(message=>message.content).join('\n'),/【本轮触发方式|现在在苏州|苏州做饭/);
});
test('state serialization omits counters and timestamps while reflecting meaningful state and boundary changes',t=>{
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'cache-state-'));
 const store=new Store({dataDir,story:JSON.parse(fs.readFileSync('app-data/story.json','utf8')),initialFeeds:[]});
 t.after(()=>{store.close();fs.rmSync(dataDir,{recursive:true,force:true})});
 const chars=new CharacterRepository(store,{clock:()=>new Date('2026-09-06T07:30:00Z'),random:()=>.5});
 const initial=chars.context('zhixia'),state=chars.get('zhixia');
 chars.persist('zhixia',{...state,energy:state.energy-1,interactions:state.interactions+1,updatedAt:'2026-09-06T07:30:11Z'});
 assert.equal(chars.context('zhixia'),initial);
 assert.doesNotMatch(initial,/updatedAt|nextChangeAt|interactions|eventIndex/);
 chars.afterTurn('zhixia','别撒娇');assert.match(chars.context('zhixia'),/保持友好距离/);
 assert.notEqual(chars.context('zhixia'),initial);
});
