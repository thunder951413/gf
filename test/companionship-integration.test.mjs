import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';
import {withCompanionshipProtocol,parseCompanionshipUpdates} from '../lib/companion-updates.mjs';
const post=body=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
async function fixture(t,extra={}){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'companionship-integration-'));let now=new Date(),reply='好，阿舟，慢慢说，我在听。';const requests=[];
 const app=await createApp({dataDir,initialFeeds:[],startProactive:false,startRecall:false,startPursuits:false,startLifeThreads:false,startDossiers:false,replySleep:async()=>{},clock:()=>new Date(now),random:()=>.5,env:{LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture'},fetchImpl:async(url,init)=>{requests.push(JSON.parse(init.body));return Response.json({choices:[{message:{content:typeof reply==='string'?JSON.stringify({reply,extra:''}):JSON.stringify(reply)}}]});},...extra});
 const save=app.store.saveChatTurn.bind(app.store);app.store.saveChatTurn=options=>save({...options,afterSave:rows=>{for(const row of rows){row.createdAt=now.toISOString();app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(row.createdAt,row.id);}options.afterSave?.(rows);}});
 const {port}=await app.listen(0),base=`http://127.0.0.1:${port}`;
 t.after(async()=>{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});});
 return {app,requests,setReply:value=>reply=value,advance:hours=>now=new Date(+now+hours*3600000),now:()=>now,async request(route,body){const response=await fetch(base+route,body===undefined?undefined:post(body));return {status:response.status,...await response.json()};},async chat(text){const response=await fetch(base+'/api/chat',post({role:'miyue',text}));return {status:response.status,...await response.json()};}};
}
test('same-call annotations stay optional, bounded, and outside the stable system prefix',()=>{
 const messages=[{role:'system',content:'persona'},{role:'user',content:'dynamic'},{role:'user',content:'current'}];
 const result=withCompanionshipProtocol(messages,'fixed protocol');assert.equal(result[0].content,'persona');assert.match(result[1].content,/fixed protocol/);assert.equal(result.at(-1).content,'current');assert.equal(messages.length,3);
 assert.deepEqual(parseCompanionshipUpdates('plain reply'),{relationship:[],agenda:[],life:[]});assert.equal(parseCompanionshipUpdates({companionship:{agenda:Array(12).fill({action:'x'})}}).agenda.length,3);
 assert.equal(parseCompanionshipUpdates({companionship:{life:Array(12).fill({action:'choose'})}}).life.length,3);
});
test('a clarification about a prior mention remains intact through HTTP delivery and the next context',async t=>{
 const f=await fixture(t,{materialPresentation:'generated'});
 f.setReply('阿盛是你以前提过的那个朋友吗？我不太记得了。');
 const result=await f.chat('明天下午我和阿盛约在旧书店见面。');
 assert.equal(result.status,200,JSON.stringify(result));
 const assistant=result.messages.find(m=>m.speaker==='assistant');
 assert.equal(assistant.text,'阿盛是你以前提过的那个朋友吗？\n我不太记得了。');
 const receipt=f.app.interactionPolicy.receipt(assistant.id);
 assert.equal(receipt.questionCount,1);assert.ok(!receipt.repairs.includes('removed_unsupported_recall'));
 assert.equal(f.requests.length,1);
 f.setReply('原来是你表弟，我刚才不确定。');
 assert.equal((await f.chat('没有提过，他是我表弟。')).status,200);
 assert.match(f.requests.at(-1).messages.map(m=>m.content).join('\n'),/阿盛是你以前提过的那个朋友吗/);
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
for (const presentation of [{name:'legacy natural material delivery',options:{naturalMaterialDelivery:true}},{name:'explicit generated presentation',options:{naturalMaterialDelivery:false,materialPresentation:'generated'}}]) test(`${presentation.name} consumes a proactive agenda opportunity without inserting its anchor or completing the plan`,async t=>{
 const f=await fixture(t,presentation.options);f.app.companionAgenda.update('miyue',{revision:0,action:'create',kind:'chat',title:'分享周末趣事',owner:'joint',dueAt:new Date(+f.now()+1000).toISOString()});f.advance(1);
 const pending=f.app.companionAgenda.pending('miyue');f.setReply({skip:false,contentId:null,reason:'到了约好的聊天时间',message:'我留了一件小事，等你有空说。',extra:''});
 f.app.proactiveRepo.saveSettings({enabled:true,activeStart:'00:00',activeEnd:'23:59',dailyLimit:10});const response=await f.request('/api/proactive/run',{role:'miyue'});
 assert.equal(response.status,200,JSON.stringify(response));const saved=f.app.store.getMessages('miyue').find(m=>m.speaker==='assistant');assert.equal(saved.text,'我留了一件小事，等你有空说。');assert.doesNotMatch(saved.text,new RegExp(pending.anchor));
 assert.equal(f.app.companionAgenda.pending('miyue'),null);assert.equal(f.app.companionAgenda.view('miyue').plans[0].status,'awaiting_confirmation');
 const delivery=f.app.store.db.prepare('SELECT actual_reply FROM companion_agenda_deliveries WHERE message_id=?').get(saved.id);assert.equal(delivery.actual_reply,saved.text);
});

test('proactive delivery anchors the actual due plan and saves one receipt',async t=>{
 const f=await fixture(t);f.app.companionAgenda.update('miyue',{revision:0,action:'create',kind:'chat',title:'分享周末趣事',owner:'joint',dueAt:new Date(+f.now()+1000).toISOString()});f.advance(1);
 f.setReply({skip:false,contentId:null,reason:'到了约好的聊天时间',message:'我留了一件小事，等你有空说。',extra:''});
 f.app.proactiveRepo.saveSettings({enabled:true,activeStart:'00:00',activeEnd:'23:59',dailyLimit:10});const response=await f.request('/api/proactive/run',{role:'miyue'});
 assert.equal(response.status,200,JSON.stringify(response));const saved=f.app.store.getMessages('miyue').filter(m=>m.speaker==='assistant');assert.equal(saved.length,1,JSON.stringify({response,runtime:f.app.proactiveRepo.getRuntime()}));assert.match(saved[0].text,/分享周末趣事/);assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM companion_agenda_deliveries').get().n,1);assert.equal(f.app.companionAgenda.pending('miyue'),null);
});
for (const presentation of [{name:'legacy natural material delivery',options:{naturalMaterialDelivery:true}},{name:'explicit generated presentation',options:{naturalMaterialDelivery:false,materialPresentation:'generated'}}]) test(`explicit romance invitation remains authored with ${presentation.name}`,async t=>{const f=await fixture(t,presentation.options);f.setReply('愿意呀，我们在一起吧。说好了，以后开心的事我也想先跟你说。');const r=await f.chat('晓薇，做我女朋友吧。');assert.equal(r.status,200);assert.equal(r.messages.at(-1).text.split('愿意呀，我们在一起吧。').length-1,1);assert.equal(f.app.companionRelationship.view('miyue').status.value,'dating');});
test('a recall answer and its question remain intact without another model call',async t=>{const f=await fixture(t);f.setReply('我们聊的是《城南旧事》。你想接着聊哪一段？');const r=await f.chat('还记得我们聊的那本书吗？');assert.equal(r.status,200);assert.match(r.messages.at(-1).text,/城南旧事/);assert.match(r.messages.at(-1).text,/你想接着聊哪一段？/u);assert.equal(f.requests.length,1);});
test('HTTP context uses the established relationship while preserving a temporary closeness boundary',async t=>{
 const f=await fixture(t);
 f.app.companionRelationship.update('miyue',{kind:'status',value:'dating',revision:0});
 f.app.companionRelationship.update('miyue',{kind:'boundary',key:'affection',value:'今天先别亲我',scope:'today',revision:1});
 f.setReply('是恋人呀。今天就好好说话。');
 assert.equal((await f.chat('我们现在是什么关系呀？')).status,200);
 const context=f.requests.at(-1).messages.map(m=>m.content).join('\n');
 assert.match(context,/你们目前是恋人。/);
 assert.match(context,/延续已经建立的恋人关系/);
 assert.match(context,/当前边界原话：“今天先别亲我”/);
 assert.equal(f.app.companionRelationship.view('miyue').status.source.type,'setting');
});
test('quiet activity keeps its duration and records a model ignoring the no-followup preference',async t=>{const f=await fixture(t);f.setReply('嗯，好。我就在这儿陪着你。你想开口的时候再说。要不要先跟我讲讲今天遇到的事情？');const r=await f.chat('陪我安静待十分钟吧。');assert.equal(r.status,200);assert.ok(r.messages.at(-1).text.length<=80);const receipt=f.app.interactionPolicy.receipt(r.messages.at(-1).id);assert.equal(receipt.questionBudget,0);assert.ok(receipt.warnings.includes('question_punctuation_over_budget'));assert.match(r.messages.at(-1).text,/要不要先跟我讲讲今天遇到的事情？/);assert.equal(f.app.companionAgenda.view('miyue').plans[0].status,'active');});

for (const optionalTail of ['missing', 'invalid-key', 'valid-broad-key']) test(`HTTP semantic tonight limit survives ${optionalTail} annotation and reaches the next turn without ending romance`,async t=>{
 const text='今晚先不亲亲了，就这样靠着，普通聊聊天。不是不喜欢你了。';
 const calls=[];let isBoundary=true;
 const f=await fixture(t,{semanticUnderstanding:true,naturalMaterialDelivery:true,fetchImpl:async(_url,init)=>{
  const body=JSON.parse(init.body);calls.push(body);
  const classifier=body.messages.some(m=>String(m.content).includes('Classify the current Chinese companion-dialogue turn'));
  const content=classifier
   ? {intent:isBoundary?'decline_closeness':'user_update',continuity:'new',focusMessageId:null,ownLife:false,needsCurrentState:false,advice:false,emotionalDetail:false,imagined:false,correction:false,acceptsOffer:false,source:'none',retrievalQuery:'',evidence:isBoundary?'今晚先不亲亲了':'今天的事挺有意思'}
   : {reply:isBoundary?'好，就靠着聊会儿。':'嗯，我在听。',signals:isBoundary?{tone:'supportive',closeness:'declined',evidence:text}:{},...(optionalTail!=='missing'&&isBoundary?{companionship:{relationship:[{kind:'boundary',key:optionalTail==='valid-broad-key'?'intimacy':'tonight_no_kissing',source:'user',scope:'today',evidence:text.split('不是')[0]}]}}:{})};
  return Response.json({choices:[{message:{content:JSON.stringify(content)}}]});
 }});
 f.app.companionRelationship.update('miyue',{kind:'status',value:'dating',revision:0});
 assert.equal((await f.chat(text)).status,200);
 const view=f.app.companionRelationship.view('miyue');assert.equal(view.boundaries.length,1);assert.equal(view.boundaries[0].key,'stated_limit');assert.equal(view.boundaries[0].value,text);assert.equal(view.status.value,'dating');assert.equal(view.intimacyBoundary,'open');
 isBoundary=false;assert.equal((await f.chat('今天的事挺有意思。')).status,200);
 const background=calls.at(-1).messages.filter(m=>String(m.content).includes('【本轮背景开始】')).map(m=>m.content).join('\n');
 assert.ok(background.includes(`当前边界原话：“${text}”`));assert.match(background,/你们目前是恋人。/);assert.doesNotMatch(background,/用户明确要求朋友距离|直到用户明确重新邀请/);assert.equal(f.app.inner.get('miyue').intimacyBoundary,'open');
 f.advance(26);assert.equal(f.app.companionRelationship.view('miyue').boundaries.length,0);assert.equal(f.app.companionRelationship.view('miyue').status.value,'dating');
});
