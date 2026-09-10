import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';
import {withCompanionshipProtocol,parseCompanionshipUpdates} from '../lib/companion-updates.mjs';
const post=body=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
async function fixture(t){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'companionship-integration-'));let now=new Date(),reply='好，阿舟，慢慢说，我在听。';const requests=[];
 const app=await createApp({dataDir,initialFeeds:[],startProactive:false,startRecall:false,startPursuits:false,startLifeThreads:false,startDossiers:false,replySleep:async()=>{},clock:()=>new Date(now),random:()=>.5,env:{LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture'},fetchImpl:async(url,init)=>{requests.push(JSON.parse(init.body));return Response.json({choices:[{message:{content:typeof reply==='string'?JSON.stringify({reply,extra:''}):JSON.stringify(reply)}}]});}});
 const save=app.store.saveChatTurn.bind(app.store);app.store.saveChatTurn=options=>save({...options,afterSave:rows=>{for(const row of rows){row.createdAt=now.toISOString();app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(row.createdAt,row.id);}options.afterSave?.(rows);}});
 const {port}=await app.listen(0),base=`http://127.0.0.1:${port}`;
 t.after(async()=>{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});});
 return {app,requests,setReply:value=>reply=value,advance:hours=>now=new Date(+now+hours*3600000),now:()=>now,async request(route,body){const response=await fetch(base+route,body===undefined?undefined:post(body));return {status:response.status,...await response.json()};},async chat(text){const response=await fetch(base+'/api/chat',post({role:'miyue',text}));return {status:response.status,...await response.json()};}};
}
test('same-call annotations stay optional, bounded, and outside the stable system prefix',()=>{
 const messages=[{role:'system',content:'persona'},{role:'user',content:'dynamic'},{role:'user',content:'current'}];
 const result=withCompanionshipProtocol(messages,'fixed protocol');assert.equal(result[0].content,'persona');assert.match(result[1].content,/fixed protocol/);assert.equal(result.at(-1).content,'current');assert.equal(messages.length,3);
 assert.deepEqual(parseCompanionshipUpdates('plain reply'),{relationship:[],agenda:[]});assert.equal(parseCompanionshipUpdates({companionship:{agenda:Array(12).fill({action:'x'})}}).agenda.length,3);
});
test('real chat writes explicit nickname and preference without model metadata and next prompt uses both',async t=>{
 const f=await fixture(t);assert.equal((await f.chat('以后叫我阿舟就好。')).status,200);
 assert.equal((await f.chat('我烦的时候喜欢你先听我说，别急着给建议。')).status,200);
 const state=await f.request('/api/companionship');assert.equal(state.relationship.nickname.value,'阿舟');assert.equal(state.relationship.preferences.length,1);
 await f.chat('今天遇到了一点小麻烦。');const context=f.requests.at(-1).messages.map(m=>m.content).join('\n');assert.match(context,/她称呼用户：阿舟/);assert.match(context,/先听我说/);
});
test('confirmed romance persists while a temporary boundary expires in the actual inner state',async t=>{
 const f=await fixture(t);f.setReply('愿意呀。以后有开心的事，我也想先说给你听。');assert.equal((await f.chat('做我女朋友吧。')).status,200);
 assert.equal(f.app.companionRelationship.view('miyue').status.value,'dating');f.setReply('好，今天就正常聊，我听你的。');assert.equal((await f.chat('今天别暧昧啦，我们正常聊。')).status,200);
 assert.equal(f.app.inner.get('miyue').intimacyBoundary,'friendly');f.advance(26);assert.equal(f.app.inner.get('miyue').intimacyBoundary,'open');assert.equal(f.app.companionRelationship.view('miyue').status.value,'dating');
});
test('settings update actual selection weights, reject stale writes, and cancelled invitations cannot remain pending',async t=>{
 const f=await fixture(t);let state=await f.request('/api/companionship');const before=f.app.companionAgenda.itemWeight({kind:'film',title:'悬疑电影'});
 const changed=await f.request('/api/companionship/agenda',{revision:state.agenda.revision,action:'interest',title:'悬疑电影',value:2});assert.equal(changed.status,200);assert.ok(f.app.companionAgenda.itemWeight({kind:'film',title:'悬疑电影'})>before);
 assert.equal((await f.request('/api/companionship/agenda',{revision:state.agenda.revision,action:'interest',title:'其他',value:1})).status,409);
 state=await f.request('/api/companionship/agenda',{revision:changed.agenda.revision,action:'create',kind:'film',title:'周末电影',owner:'joint',dueAt:new Date(+f.now()+3600000).toISOString()});f.advance(2);state=await f.request('/api/companionship');assert.equal(state.agenda.plans[0].status,'awaiting_confirmation');assert.ok(f.app.companionAgenda.pending('miyue'));
 state=await f.request('/api/companionship/agenda',{revision:state.agenda.revision,action:'cancel',id:state.agenda.plans[0].id});assert.equal(state.status,200);assert.equal(f.app.companionAgenda.pending('miyue'),null);
});
test('proactive delivery anchors the actual due plan and saves one receipt',async t=>{
 const f=await fixture(t);f.app.companionAgenda.update('miyue',{revision:0,action:'create',kind:'chat',title:'分享周末趣事',owner:'joint',dueAt:new Date(+f.now()+1000).toISOString()});f.advance(1);
 f.setReply({skip:false,contentId:null,reason:'到了约好的聊天时间',message:'我留了一件小事，等你有空说。',extra:''});
 f.app.proactiveRepo.saveSettings({enabled:true,activeStart:'00:00',activeEnd:'23:59',dailyLimit:10});const response=await f.request('/api/proactive/run',{role:'miyue'});
 assert.equal(response.status,200,JSON.stringify(response));const saved=f.app.store.getMessages('miyue').filter(m=>m.speaker==='assistant');assert.equal(saved.length,1,JSON.stringify(response));assert.match(saved[0].text,/分享周末趣事/);assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM companion_agenda_deliveries').get().n,1);assert.equal(f.app.companionAgenda.pending('miyue'),null);
});
test('explicit romance invitation is accepted once even if the model repeats the authored acceptance',async t=>{const f=await fixture(t);f.setReply('愿意呀，我们在一起吧。说好了，以后开心的事我也想先跟你说。');const r=await f.chat('雨薇，做我女朋友吧。');assert.equal(r.status,200);assert.equal(r.messages.at(-1).text.split('愿意呀，我们在一起吧。').length-1,1);assert.equal(f.app.companionRelationship.view('miyue').status.value,'dating');});
test('a recall answer keeps its facts while a separate trailing question is removed without another model call',async t=>{const f=await fixture(t);f.setReply('我们聊的是《城南旧事》。你想接着聊哪一段？');const r=await f.chat('还记得我们聊的那本书吗？');assert.equal(r.status,200);assert.match(r.messages.at(-1).text,/城南旧事/);assert.doesNotMatch(r.messages.at(-1).text,/[？?]/u);assert.equal(f.requests.length,1);});
test('quiet activity replies stay short and do not require a followup question',async t=>{const f=await fixture(t);f.setReply('嗯，好。我就在这儿陪着你。你想开口的时候再说。要不要先跟我讲讲今天遇到的事情？');const r=await f.chat('陪我安静待十分钟吧。');assert.equal(r.status,200);assert.ok(r.messages.at(-1).text.length<=80);assert.doesNotMatch(r.messages.at(-1).text,/[？?]/u);assert.equal(f.app.companionAgenda.view('miyue').plans[0].status,'active');});
