import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';
const post=body=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
async function fixture(t){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'inner-state-integration-'));const requests=[];let now=new Date('2026-09-09T04:00:00Z');let transport=async()=>({reply:'今天就慢慢聊吧，我听着呢。',extra:''});
 const app=await createApp({dataDir,initialFeeds:[],startProactive:false,startRecall:false,startPursuits:false,startLifeThreads:false,startDossiers:false,startChatQueue:false,replySleep:async()=>{},clock:()=>new Date(now),random:()=>.5,env:{LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture'},fetchImpl:async(_url,init)=>{requests.push(JSON.parse(init.body));const payload=await transport();return Response.json({choices:[{message:{content:JSON.stringify(payload)}}]});}});
 const {port}=await app.listen(0),base=`http://127.0.0.1:${port}`;
 t.after(async()=>{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});});
 return {app,requests,advance:ms=>now=new Date(+now+ms),setTransport:value=>transport=value,async request(route,body){const response=await fetch(base+route,body===undefined?undefined:post(body));return {status:response.status,...await response.json()};}};
}
test('state API edits all actual metrics; profile/world, partial writes and persisted records agree',async t=>{
 const f=await fixture(t),before=await f.request('/api/companionship');
 assert.equal(before.inner.fields.length,10);
 const values={affection:87,mood:82,security:77,affectionNeed:48,desire:38,playfulness:73,stress:22,fatigue:21,vitality:80,hunger:29};
 const saved=await f.request('/api/companionship/inner',{revision:before.inner.revision,values});
 assert.equal(saved.status,200);assert.deepEqual(saved.inner.values,values);assert.equal(saved.relationship.status.value,before.relationship.status.value);
 assert.equal(saved.inner.revision,before.inner.revision+1);
 const profile=await f.request('/api/characters/miyue');
 // The same repository supplies both compact model world and the profile.
 assert.equal(profile.status,200);assert.equal(profile.state.inner.mood,82);
 const character=f.app.characters.get('miyue');assert.deepEqual(character.world.body,values);
 assert.equal(character.inner.mood,82);assert.equal(character.inner.affection,87);
 const next=await f.request('/api/companionship/inner',{revision:saved.inner.revision,values:{mood:19}});
 assert.equal(next.status,200);assert.deepEqual(next.inner.values,{...values,mood:19});assert.notEqual(next.inner.mode,saved.inner.mode);
 const stored=JSON.parse(f.app.store.db.prepare("SELECT state_json FROM inner_states WHERE role_id='miyue'").get().state_json);assert.equal(stored.affection,87);assert.equal(stored.mood,19);
 assert.equal(f.requests.length,0,'editing requires no model calls');
});
test('bad and conflicting edits return 400/409 without overwriting any state',async t=>{
 const f=await fixture(t),before=await f.request('/api/companionship');
 for(const values of [{mood:101},{mood:'20'},{affection:2.5},{mood:null},{mode:'warm'},{}]){
  const response=await f.request('/api/companionship/inner',{revision:before.inner.revision,values});assert.equal(response.status,400,JSON.stringify(response));
 }
 const saved=await f.request('/api/companionship/inner',{revision:before.inner.revision,values:{mood:76}});assert.equal(saved.status,200);
 const stale=await f.request('/api/companionship/inner',{revision:before.inner.revision,values:{mood:1,affection:1}});assert.equal(stale.status,409);
 const after=await f.request('/api/companionship');assert.deepEqual(after.inner.values,{...before.inner.values,mood:76});
});
test('saved values reach the actual next chat model request in the compact world context',async t=>{
 const f=await fixture(t),before=await f.request('/api/companionship');
 await f.request('/api/companionship/inner',{revision:before.inner.revision,values:{affection:91,mood:18,stress:23,security:76}});
 const reply=await f.request('/api/chat',{role:'miyue',text:'我们随便聊两句。'});assert.equal(reply.status,200,JSON.stringify(reply));
 const context=f.requests[0].messages.map(m=>m.content).join('\n');
 assert.match(context,/喜欢程度91/);assert.match(context,/心情愉悦度18/);assert.match(context,/压力23/);assert.match(context,/安全感76/);
 assert.equal(f.app.store.getMessages('miyue').filter(m=>m.speaker==='assistant').length,1);
});
test('editing during generation rejects the old-state reply atomically and cancels unsent chunks',async t=>{
 const f=await fixture(t);let resolveReply,started;const didStart=new Promise(resolve=>started=resolve),replyReady=new Promise(resolve=>resolveReply=resolve);
 f.setTransport(async()=>{started();await replyReady;return {reply:'今天就慢慢聊吧，我听着呢。',extra:''};});
 const before=await f.request('/api/companionship');const pending=f.request('/api/chat',{role:'miyue',text:'我们随便聊两句。'});
 await didStart;
 f.app.replyDelivery.enqueue('miyue',['旧状态下的下一条']);assert.equal(f.app.replyDelivery.pending('miyue'),1);
 try{const saved=await f.request('/api/companionship/inner',{revision:before.inner.revision,values:{mood:24}});assert.equal(saved.status,200);assert.equal(f.app.replyDelivery.pending('miyue'),0);}finally{resolveReply();}
 const reply=await pending;assert.equal(reply.status,409);assert.equal(reply.code,'STALE_INNER_STATE');
 assert.equal(f.app.store.getMessages('miyue').filter(m=>m.speaker==='assistant').length,0);
 assert.equal(f.app.inner.view('miyue').values.mood,24);
});
test('proactive generation also uses saved state and cannot deliver after a manual state edit',async t=>{
 const f=await fixture(t),before=await f.request('/api/companionship');
 const saved=await f.request('/api/companionship/inner',{revision:before.inner.revision,values:{affection:89,mood:86,stress:10}});assert.equal(saved.status,200);
 f.app.companionAgenda.update('miyue',{revision:0,action:'create',kind:'chat',title:'分享周末趣事',owner:'joint',dueAt:'2026-09-09T04:00:01Z'});f.advance(2000);
 f.app.proactiveRepo.saveSettings({enabled:true,activeStart:'00:00',activeEnd:'23:59',dailyLimit:10});
 let resolveReply,started;const didStart=new Promise(resolve=>started=resolve),replyReady=new Promise(resolve=>resolveReply=resolve);
 f.setTransport(async()=>{started();await replyReady;return {skip:false,contentId:null,reason:'约好的聊天',message:'我留了一件小事，等你有空说。',extra:''};});
 const pending=f.request('/api/proactive/run',{role:'miyue'});await didStart;
 try{const context=f.requests.at(-1).messages.map(m=>m.content).join('\n');assert.match(context,/喜欢程度89/);assert.match(context,/心情愉悦度86/);
 const changed=await f.request('/api/companionship/inner',{revision:saved.inner.revision,values:{mood:25}});assert.equal(changed.status,200);}finally{resolveReply();}
 await pending;assert.equal(f.app.store.getMessages('miyue').filter(m=>m.speaker==='assistant').length,0);assert.ok(f.app.companionAgenda.pending('miyue'),'unserved invitation still available');
});

test('text-only needs stay available and reach relevant exchanges without becoming every casual reply agenda',async t=>{
 const f=await fixture(t),before=await f.request('/api/companionship');
 const needs={emotional:'希望你回应她刚才的分享',physical:'渴望被拥抱、被轻轻抚摸，也想与你接吻'};
 const saved=await f.request('/api/companionship/inner',{revision:before.inner.revision,needs});assert.equal(saved.status,200);assert.deepEqual(saved.inner.needs,needs);assert.deepEqual(saved.inner.values,before.inner.values);
 const profile=await f.request('/api/characters/miyue');assert.deepEqual(profile.state.inner.needs,needs);
 const response=await f.request('/api/chat',{role:'miyue',text:'我们随便聊两句。'});assert.equal(response.status,200);
 const casual=f.requests[0].messages.map(m=>m.content).join('\n');assert.ok(!casual.includes(needs.emotional));assert.ok(!casual.includes(needs.physical));
 f.setTransport(async()=>({reply:'我也想你了，这样聊着就觉得离你近一点。',extra:''}));
 const close=await f.request('/api/chat',{role:'miyue',text:'想你了，抱抱你。'});assert.equal(close.status,200,JSON.stringify(close));
 const context=f.requests.at(-1).messages.map(m=>m.content).join('\n');assert.ok(context.includes(needs.emotional));assert.ok(context.includes(needs.physical));assert.doesNotMatch(context,/欲望\d|亲近需求\d|亲需\d|亲愿\d/);
 assert.equal((await f.request('/api/companionship/inner',{revision:before.inner.revision,needs:{physical:''}})).status,409);
 const latest=await f.request('/api/companionship');
 const cleared=await f.request('/api/companionship/inner',{revision:latest.inner.revision,needs:{physical:''}});assert.equal(cleared.status,200);assert.equal(cleared.inner.needs.physical,'');assert.equal(cleared.inner.needs.emotional,needs.emotional);
});

test('a written emotional need is included verbatim in a real proactive request',async t=>{
 const f=await fixture(t),before=await f.request('/api/companionship');const emotional='希望你回应她刚才的分享';
 await f.request('/api/companionship/inner',{revision:before.inner.revision,needs:{emotional,physical:'想被你轻轻抚摸'}});
 f.app.proactiveRepo.saveSettings({enabled:true,activeStart:'00:00',activeEnd:'23:59',dailyLimit:10});
 f.setTransport(async()=>({skip:false,contentId:null,reason:'想分享近况',message:'我想和你聊聊刚才的小事。',extra:''}));
 const response=await f.request('/api/proactive/run',{role:'miyue'});assert.equal(response.status,200);
 assert.ok(f.requests.length>0);const context=f.requests.at(-1).messages.map(m=>m.content).join('\n');assert.ok(context.includes(emotional));assert.match(context,/想被你轻轻抚摸/);assert.doesNotMatch(context,/欲望\d|亲近需求\d/);
 assert.equal(f.app.store.getMessages('miyue').filter(m=>m.speaker==='assistant').length,1,JSON.stringify(response));
});

test('periodic physical need reaches real proactive delivery; responding lowers the saved value once',async t=>{
 const f=await fixture(t),before=await f.request('/api/companionship');
 const edited=await f.request('/api/companionship/inner',{revision:before.inner.revision,values:{desire:90,affectionNeed:60,affection:80,fatigue:20,stress:10},needCycle:{threshold:85,relief:30,physicalHours:24,cooldownHours:3}});
 assert.equal(edited.status,200);assert.equal(edited.inner.needCycleStatus.physical.due,true);
 f.app.proactiveRepo.saveSettings({enabled:true,activeStart:'00:00',activeEnd:'23:59',dailyLimit:10});
 f.setTransport(async()=>({skip:false,contentId:null,reason:'想亲近',message:'有点想被你抱抱，想和你安静待一会儿。',extra:''}));
 const sent=await f.request('/api/proactive/run',{role:'miyue'});
 assert.equal(sent.delivered,true,JSON.stringify(sent));
 assert.match(f.requests.at(-1).messages.map(m=>m.content).join('\n'),/身体亲近愿望达到阈值/);
 const waiting=await f.request('/api/companionship');assert.equal(waiting.inner.values.desire,90);assert.equal(waiting.inner.needCycleStatus.awaitingReply,true);
 f.setTransport(async()=>({reply:'这一句让我觉得很安心，想多陪你一会儿。',extra:''}));
 const reply=await f.request('/api/chat',{role:'miyue',text:'抱抱你，我在呢。'});assert.equal(reply.status,200,JSON.stringify(reply));
 const after=await f.request('/api/companionship');assert.equal(after.inner.values.desire,60);assert.equal(after.inner.values.affectionNeed,30);assert.equal(after.inner.needCycleStatus.awaitingReply,false);
 assert.equal((await f.request('/api/companionship')).inner.values.desire,60,'reads do not repeat fulfillment');
 assert.equal(f.app.store.db.prepare("SELECT COUNT(*) n FROM closeness_moments WHERE kind='拥抱'").get().n,0,'a reply with no reciprocal act is not invented as a hug memory');
});

test('cycle settings validation and stale generation preserve the pending need without delivery',async t=>{
 const f=await fixture(t),before=await f.request('/api/companionship');
 for(const needCycle of [{enabled:1},{threshold:1},{physicalHours:0},{relief:NaN},{unknown:2},{}])assert.equal((await f.request('/api/companionship/inner',{revision:before.inner.revision,needCycle})).status,400);
 await f.request('/api/companionship/inner',{revision:before.inner.revision,values:{affectionNeed:95,fatigue:25},needCycle:{emotionalHours:12}});
 f.app.proactiveRepo.saveSettings({enabled:true,activeStart:'00:00',activeEnd:'23:59',dailyLimit:10});
 let started,resolve;const begin=new Promise(r=>started=r),end=new Promise(r=>resolve=r);
 f.setTransport(async()=>{started();await end;return {skip:false,contentId:null,reason:'想聊天',message:'想和你说说话，你有空的时候我陪你。',extra:''};});
 const pending=f.request('/api/proactive/run',{role:'miyue'});await begin;
 const current=await f.request('/api/companionship');await f.request('/api/companionship/inner',{revision:current.inner.revision,needCycle:{enabled:false}});resolve();
 const result=await pending;assert.equal(result.delivered,false);assert.equal(f.app.store.getMessages('miyue').length,0);assert.equal(f.app.inner.get().awaitingNeed,null);
});

test('requested closeness recall uses sources without forcing subsequent desktop invitations to reminisce',async t=>{
 const f=await fixture(t);
 f.setTransport(async()=>({reply:'隔着聊天给你一个抱抱，这会儿觉得很安心。',extra:''}));
 const first=await f.request('/api/chat',{role:'miyue',text:'抱抱你。'});assert.equal(first.status,200,JSON.stringify(first));
 const memory=f.app.store.db.prepare('SELECT * FROM closeness_moments').get();assert.ok(memory);assert.match(memory.summary,/拥抱.*安心/);
 f.advance(3600000);
 f.setTransport(async()=>({reply:'记得上次聊起拥抱时的安心，今天也想听你说说话。',extra:''}));
 const second=await f.request('/api/chat',{role:'miyue',text:'还记得上次拥抱时的感受吗？'});assert.equal(second.status,200,JSON.stringify(second));
 assert.ok(f.requests.at(-1).messages.some(m=>m.content.includes('一条可延续的亲近回忆')&&m.content.includes(memory.message_id)));
 assert.ok(f.app.store.db.prepare('SELECT recalled_at FROM closeness_moments WHERE message_id=?').get(memory.message_id).recalled_at);
 f.setTransport(async()=>({reply:'今天也惦记着你，想陪你说会儿话。',extra:''}));
 const third=await f.request('/api/desktop/attention',{requestId:'memory-gesture-02',level:'care'});assert.equal(third.status,200,JSON.stringify(third));
 assert.ok(f.requests.at(-1).messages.every(m=>!m.content.includes('一条可延续的亲近回忆')));
 const requests=f.requests.length;await f.request('/api/desktop/attention',{requestId:'memory-gesture-02',level:'care'});assert.equal(f.requests.length,requests,'retry has no model call or extra memory');
});

test('a short yes only fulfills the immediately preceding need invitation, not a later unrelated topic',async t=>{
 const f=await fixture(t),before=await f.request('/api/companionship');
 await f.request('/api/companionship/inner',{revision:before.inner.revision,values:{affectionNeed:90,fatigue:20}});
 f.app.proactiveRepo.saveSettings({enabled:true,activeStart:'00:00',activeEnd:'23:59',dailyLimit:10});
 f.setTransport(async()=>({skip:false,contentId:null,reason:'想说话',message:'想听你说说话，陪我聊一会儿好吗？',extra:''}));
 assert.equal((await f.request('/api/proactive/run',{role:'miyue'})).delivered,true);
 f.app.store.addAssistantMessage('miyue','刚才那篇文章还有第二部分。');
 f.setTransport(async()=>({reply:'第二部分谈到了一点新的看法。',extra:''}));
 const reply=await f.request('/api/chat',{role:'miyue',text:'好'});assert.equal(reply.status,200,JSON.stringify(reply));
 assert.equal(f.app.inner.get().affectionNeed,90);assert.equal(f.app.inner.get().lastNeedRelief,null);
});

test('explicit closeness recall carries source detail and future wish through actual chat planning',async t=>{
 const f=await fixture(t);
 f.setTransport(async()=>({reply:'抱着你，听你说不用急着讲话，我心里很踏实。下次想靠着你听完一首歌。',extra:''}));
 const first=await f.request('/api/chat',{role:'miyue',text:'抱抱你，靠着我歇一会儿。'});assert.equal(first.status,200,JSON.stringify(first));
 f.advance(3600000);
 f.setTransport(async()=>({reply:'记得上次抱抱时你让我靠着歇一会儿，我喜欢那种不用急着说话的安心。下次想选首你喜欢的歌，一起慢慢听。',extra:''}));
 const recalled=await f.request('/api/chat',{role:'miyue',text:'记得上次抱抱吗？还想怎样和我待着？'});assert.equal(recalled.status,200,JSON.stringify({recalled,repair:f.requests.at(-1).messages.at(-1)}));
 const input=f.requests.at(-1).messages.map(m=>m.content).join('\n');
 assert.match(input,/用户当时说.*靠着我歇一会儿/);assert.match(input,/尚未确认实现的期待.*听完一首歌/);
 assert.doesNotMatch(input,/本轮用一句自己的感受/);
 const receipt=f.app.interactionPolicy.receipt(recalled.messages.at(-1).id);
 assert.equal(receipt.behavior.turnPlan.focus.kind,'closeness');
 assert.equal(receipt.behavior.turnPlan.focus.id,first.messages.at(-1).id);
 assert.equal(f.app.store.db.prepare('SELECT COUNT(*) n FROM closeness_moments').get().n,1,'recalling an embrace is not a newly experienced embrace');
 f.setTransport(async()=>({reply:'下次想选首舒缓的歌，想象靠着你听完，把没说完的话慢慢告诉你。',extra:''}));
 const next=await f.request('/api/chat',{role:'miyue',text:'那下次想怎样待着？'});assert.equal(next.status,200,JSON.stringify(next));
 assert.match(f.requests.at(-1).messages.map(m=>m.content).join('\n'),/直接谈想怎样延续这段亲近/);
 assert.equal(f.app.interactionPolicy.receipt(next.messages.at(-1).id).behavior.turnPlan.focus.kind,'closeness');
});
