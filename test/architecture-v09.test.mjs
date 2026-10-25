import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createApp} from '../server.mjs';
const TEST_ROLES=[
 {id:'miyue',name:'林晓薇',systemPrompt:'自然回应当前用户。',interaction:{mode:'companion',lifeEvents:true}},
 {id:'wenxi',name:'闻溪',systemPrompt:'自然回应当前用户。',interaction:{mode:'information'}},
 {id:'zhixia',name:'知夏',systemPrompt:'自然回应当前用户。',interaction:{mode:'scenario'}},
];
async function fixture(t,handler=()=> '这件事确实还有得聊。',extra={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'architecture-v09-'));let now=new Date('2026-09-07T03:00:00Z');const calls=[];
 const app=await createApp({startPursuits:false,dataDir:dir,roles:TEST_ROLES,initialFeeds:[],startProactive:false,startRecall:false,replySleep:async()=>{},clock:()=>new Date(now),random:()=>.5,lifeRandom:()=>.99,lifeThreadRandom:()=>0,integrations:{fetchFeed:async()=>({items:[]})},env:{LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture'},fetchImpl:async(_u,o)=>{const body=JSON.parse(o.body);calls.push(body);return Response.json({choices:[{message:{content:await handler(body)}}],usage:{prompt_tokens:10,completion_tokens:10}});},...extra});
 const {port}=await app.listen(0);t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
 const req=async(url,body)=>{const r=await fetch(`http://127.0.0.1:${port}${url}`,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});return {status:r.status,...await r.json()};};
 return{app,req,calls,advance:hours=>now=new Date(+now+hours*3600000)};
}
test('actual chat constrains questions, persists explicit preference, and writes only real evidence',async t=>{
 const {app,req,calls}=await fixture(t,()=> '你做得很棒。你之前说过你去过火星。我也喜欢这种慢悠悠的感觉。你喜欢吗？为什么呢？');
 const first=await req('/api/chat',{role:'wenxi',text:'别老问我，我喜欢慢悠悠的聊天。'});assert.equal(first.status,200);const reply=first.messages.at(-1);assert.equal(reply.text,'我也喜欢这种慢悠悠的感觉。');assert.equal(app.interactionPolicy.get('wenxi').preferences.noQuestions,true);assert.equal(app.interactionPolicy.receipt(reply.id).questionCount,0);
 const episodes=(await req('/api/episodes?roleId=wenxi')).items;assert.equal(episodes.length,1);assert.equal(episodes[0].quotes[1].text,reply.text);assert.doesNotMatch(JSON.stringify(episodes),/火星/);
 await req('/api/chat',{role:'wenxi',text:'继续说说'});assert.equal(calls.length,2);assert.doesNotMatch(app.store.getMessages('wenxi').at(-1).text,/[？?]/);assert.equal((await req('/api/episodes?roleId=miyue')).items.length,0);
});
test('corrected memory suppresses old rolling summary and raw source; removed entries do not reappear',async t=>{
 const {app,req,calls}=await fixture(t,()=> '我会按这次更正来理解。');const rows=app.store.saveChatTurn({role:'wenxi',text:'我喜欢唯一暗号青石咖啡。',reply:'青石咖啡我记下了。'});const entry=app.episodes.remember('wenxi',rows.map(r=>r.id));app.recallRepo.replace('wenxi','旧摘要独有标志：用户只喝青石咖啡。');
 await req('/api/episodes',{roleId:'wenxi',action:'correct',id:entry.id,note:'我现在喜欢青石茶，咖啡已经不喝了。'});
 await req('/api/chat',{role:'wenxi',text:'青石茶的事你还有印象吗'});const prompt=JSON.stringify(calls.at(-1));assert.doesNotMatch(prompt,/旧摘要独有标志/);assert.match(prompt,/我现在喜欢青石茶/);assert.equal(calls.at(-1).messages.some(m=>m.role==='user'&&m.content==='我喜欢唯一暗号青石咖啡。'),false);
 await req('/api/episodes',{roleId:'wenxi',action:'remove',id:entry.id});app.episodes.observe('wenxi',rows);assert.equal(app.episodes.list('wenxi',{status:'active'}).some(e=>e.id===entry.id),false);assert.equal(app.store.getMessage(rows[0].id).text,rows[0].text);
 assert.equal((await req('/api/episodes',{roleId:'miyue',action:'remember',messageIds:[rows[0].id]})).status,400);
});
test('memory change during model generation atomically rejects reply, state, and receipts',async t=>{
 let release,start;const ready=new Promise(r=>start=r);const {app,req}=await fixture(t,async()=>{start();await new Promise(r=>release=r);return '我喜欢这次的选择。';});
 const rows=app.store.saveChatTurn({role:'wenxi',text:'我喜欢老照片。',reply:'我们可以聊老照片。'}),entry=app.episodes.remember('wenxi',rows.map(r=>r.id));const before=app.store.getMessages('wenxi').length;
 const pending=req('/api/chat',{role:'wenxi',text:'老照片还有什么可聊'});await ready;await req('/api/episodes',{roleId:'wenxi',action:'remove',id:entry.id});release();const result=await pending;assert.equal(result.status,409);assert.equal(result.code,'STALE_MEMORY');assert.equal(app.store.getMessages('wenxi').length,before);assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM conversation_receipts').get().n,0);
});
test('authored life beat is delivered even when model ignores it; choices affect a later delivered beat',async t=>{
 const {app,req,advance}=await fixture(t,()=>JSON.stringify({reply:'我先把手里的事情慢慢做好。',signals:{}}));const initial=(await req('/api/life')).thread;
 const shared=await req('/api/chat',{role:'miyue',text:'说说你的近况'});assert.equal(shared.status,200);assert.ok(shared.messages.at(-1).text.startsWith(initial.beat.text));let thread=app.lifeThreads.get('miyue');assert.equal(thread.history.length,1);assert.equal(thread.pendingKey,null);
 const choice=thread.choices[0];const selected=await req('/api/chat',{role:'miyue',text:choice.label,lifeChoiceId:choice.id,lifeVersion:thread.version});assert.equal(selected.status,200);assert.match(JSON.stringify(app.lifeThreads.get('miyue').knownFacts),/用户/);
 advance(30);app.lifeThreads.tick('miyue',app.life.get('miyue'));thread=app.lifeThreads.get('miyue');assert.notEqual(thread.beat.id,initial.beat.id);assert.match(thread.beat.text,/你/);const next=await req('/api/chat',{role:'miyue',text:'说说你的近况'});assert.ok(next.messages.at(-1).text.startsWith(thread.beat.text));
 assert.equal((await req('/api/chat',{role:'miyue',text:choice.label,lifeChoiceId:choice.id,lifeVersion:initial.version})).status,409);
});
test('failed life choice reply cannot change the durable branch',async t=>{
 const {app,req}=await fixture(t,()=> '你应该好好休息。');const current=app.lifeThreads.get('miyue'),choice=current.choices[0];await req('/api/interaction-preferences',{roleId:'miyue',preferences:{noQuestions:true}});
 const before=current.version;const bad=await req('/api/chat',{role:'miyue',text:'不存在的选项',lifeChoiceId:choice.id,lifeVersion:before});assert.equal(bad.status,409);assert.equal(app.lifeThreads.get('miyue').version,before);assert.equal(app.store.getMessages('miyue').length,0);
});
for (const presentation of [{name:'legacy authored presentation',options:{},authored:true},{name:'generated presentation',options:{naturalMaterialDelivery:false,materialPresentation:'generated'},authored:false}]) test(`proactive life beat commits its receipt with ${presentation.name}`,async t=>{
 const message='刚才忙完手里的事，坐下来歇一会儿。';const {app}=await fixture(t,()=>JSON.stringify({skip:false,contentId:null,reason:'分享近况',message}),presentation.options);app.proactiveRepo.saveSettings({activeStart:'00:00',activeEnd:'23:59',desktopNotifications:false});const initial=app.lifeThreads.get('miyue');const result=await app.proactive.runNow();assert.equal(result.delivered,true,JSON.stringify(app.proactiveRepo.getRuntime()));if(presentation.authored)assert.ok(result.message.text.startsWith(initial.beat.text));else assert.equal(result.message.text,message);const receipt=app.interactionPolicy.receipt(result.message.id);assert.equal(receipt.hasAuthoredAnchor,presentation.authored);const delivery=app.lifeThreads.get('miyue').history[0];assert.equal(delivery.messageId,result.message.id);if(!presentation.authored)assert.equal(delivery.actualReply,result.message.text);const version=app.lifeThreads.get('miyue').version;assert.equal(app.lifeThreads.markDelivered(initial.pendingKey,result.message.id),false);assert.equal(app.lifeThreads.get('miyue').version,version);
});
test('natural material delivery keeps an unparticipated life thread out of an HTTP own-life turn',async t=>{
 const {app,req}=await fixture(t,()=>JSON.stringify({reply:'刚收好桌上的纸边，想先坐一会儿。',extra:''}),{naturalMaterialDelivery:true});
 const initial=app.lifeThreads.get('miyue');const result=await req('/api/chat',{role:'miyue',text:'你最近有件自己想讲的小事吗？'});
 assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.messages.at(-1).text,'刚收好桌上的纸边，想先坐一会儿。');
 assert.equal(app.interactionPolicy.receipt(result.messages.at(-1).id).hasAuthoredAnchor,false);
 assert.equal(app.lifeThreads.get('miyue').history.length,0);assert.equal(app.lifeThreads.get('miyue').pendingKey,initial.pendingKey);
});

test('generated presentation exposes an ordinarily shared pending life thread without changing its eligibility',async t=>{
 const reply='刚收好桌上的纸边，想先坐一会儿。';const {app,req}=await fixture(t,()=>JSON.stringify({reply,extra:''}),{naturalMaterialDelivery:false,materialPresentation:'generated'});
 const initial=app.lifeThreads.get('miyue');const result=await req('/api/chat',{role:'miyue',text:'说说你的近况'});
 assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.messages.at(-1).text,reply);assert.doesNotMatch(result.messages.at(-1).text,new RegExp(initial.beat.text));
 const receipt=app.lifeThreads.get('miyue').history[0];assert.equal(receipt.selectedText,initial.beat.text);assert.equal(receipt.actualReply,reply);assert.equal(receipt.delivery,'material_exposure');assert.equal(app.interactionPolicy.receipt(result.messages.at(-1).id).hasAuthoredAnchor,false);
 const followup=app.roleContext('miyue',{initiating:false,text:'你那个包装后来呢？',semantic:{continuity:'continue',focusMessageId:result.messages.at(-1).id}});assert.equal(followup.sharedExperience?.key,initial.pendingKey);
});

const openShareSemanticHandler=body=>body.messages.some(message=>String(message.content).includes('Classify the current Chinese companion-dialogue turn'))
 ? JSON.stringify({intent:'invite_character_share',continuity:'new',focusMessageId:null,ownLife:true,needsCurrentState:false,advice:false,emotionalDetail:false,imagined:false,correction:false,acceptsOffer:false,source:'none',retrievalQuery:'',evidence:'你自己有没有什么想说的'})
 : JSON.stringify({reply:'我这会儿正忙着手边的事。',extra:''});
function conflictingLifeAndRuntimeFixture(){
 const values=[.5,0,.32,.3,0,0];
 return {clock:()=>new Date('2026-09-15T12:30:00Z'),lifeRandom:()=>values.shift()??.99,runtimeRandom:()=>.24,startDailyLife:false,startLifeThreads:false,semanticUnderstanding:true};
}
test('natural material delivery gives an open self-share the authoritative runtime activity over a conflicting active LifeEvent',async t=>{
 const {app,req,calls}=await fixture(t,openShareSemanticHandler,{naturalMaterialDelivery:true,...conflictingLifeAndRuntimeFixture()});
 const life=app.life.get('miyue').active;const runtime=app.companionRuntime.prepare({trigger:'user_message',text:''});
 assert.equal(life.category,'clothing');assert.match(life.title,/灰蓝色日常搭配/);assert.match(life.phase.location,/衣柜前/);
 assert.match(runtime.current.title,/小酒馆/);assert.match(runtime.current.location,/小酒馆/);assert.notEqual(runtime.world.activity,life.phase.activity);
 const result=await req('/api/chat',{role:'miyue',text:'你自己有没有什么想说的？'});assert.equal(result.status,200,JSON.stringify(result));
 const prompt=JSON.stringify(calls.find(call=>call.messages.some(message=>String(message.content).includes('【本轮背景开始】'))));
 assert.match(prompt,new RegExp(`正在做：${runtime.world.activity}`));assert.doesNotMatch(prompt,/日常活动中（连续性背景）|灰蓝色日常搭配|衣柜前/);
});
test('default delivery keeps the same open self-share compact despite a conflicting active LifeEvent',async t=>{
 const {app,req,calls}=await fixture(t,openShareSemanticHandler,conflictingLifeAndRuntimeFixture());
 const life=app.life.get('miyue').active;const runtime=app.companionRuntime.prepare({trigger:'user_message',text:''});
 assert.equal(life.category,'clothing');assert.match(life.title,/灰蓝色日常搭配/);assert.match(runtime.current.title,/小酒馆/);assert.notEqual(runtime.world.activity,life.phase.activity);
 const result=await req('/api/chat',{role:'miyue',text:'你自己有没有什么想说的？'});assert.equal(result.status,200,JSON.stringify(result));
 const prompt=JSON.stringify(calls.find(call=>call.messages.some(message=>String(message.content).includes('【本轮背景开始】'))));
 assert.match(prompt,/正在做：日常活动中（连续性背景）/);assert.doesNotMatch(prompt,new RegExp(`正在做：${runtime.world.activity}`));assert.doesNotMatch(prompt,/灰蓝色日常搭配|衣柜前/);
});

test('natural material delivery does not turn a specific book question into a runtime report',async t=>{
 const handler=body=>body.messages.some(message=>String(message.content).includes('Classify the current Chinese companion-dialogue turn'))
   ? JSON.stringify({intent:'ask_question',continuity:'new',focusMessageId:null,ownLife:true,needsCurrentState:false,advice:false,emotionalDetail:false,imagined:false,correction:false,acceptsOffer:false,source:'none',retrievalQuery:'书',evidence:'你看的那本书怎么样'})
   : JSON.stringify({reply:'那本书我还在慢慢看。',extra:''});
 const {app,req,calls}=await fixture(t,handler,{naturalMaterialDelivery:true,semanticUnderstanding:true,startDailyLife:false});
 const activity=app.companionRuntime.prepare({trigger:'user_message',text:''}).world.activity;
 const result=await req('/api/chat',{role:'miyue',text:'你看的那本书怎么样？'});assert.equal(result.status,200,JSON.stringify(result));
 const prompt=JSON.stringify(calls.find(call=>call.messages.some(message=>String(message.content).includes('【本轮背景开始】'))));
 assert.match(prompt,/正在做：工作时段（连续性背景）/);assert.doesNotMatch(prompt,new RegExp(`正在做：${activity}`));
});

test('a semantic preference keeps recent history but does not re-inject its focused story',async t=>{
 let focusId='';const handler=body=>body.messages.some(message=>String(message.content).includes('Classify the current Chinese companion-dialogue turn'))
   ? JSON.stringify({intent:'conversation_preference',continuity:'continue',focusMessageId:focusId,ownLife:false,needsCurrentState:false,advice:false,emotionalDetail:false,imagined:false,correction:false,acceptsOffer:false,source:'none',retrievalQuery:'',evidence:'少说一点'})
   : JSON.stringify({reply:'好，我收着点。',extra:''});
 const {app,req,calls}=await fixture(t,handler,{semanticUnderstanding:true});const saved=app.store.saveChatTurn({role:'miyue',text:'你那盆植物后来呢？',reply:'植物故事唯一标记。'});focusId=saved.at(-1).id;
 const result=await req('/api/chat',{role:'miyue',text:'少说一点就行。'});assert.equal(result.status,200,JSON.stringify(result));
 const prompt=JSON.stringify(calls.find(call=>call.messages.some(message=>String(message.content).includes('【本轮背景开始】'))));
 assert.match(prompt,/植物故事唯一标记/);assert.doesNotMatch(prompt,/本轮语义定位的历史原话|用户正在追问、回顾或明确表达边界/);
});

test('natural material delivery keeps a selected daily material on its existing prompt path',async t=>{
 const at=new Date('2026-09-07T13:00:00Z');const handler=body=>body.messages.some(message=>String(message.content).includes('Classify the current Chinese companion-dialogue turn'))
   ? JSON.stringify({intent:'invite_character_share',continuity:'new',focusMessageId:null,ownLife:true,needsCurrentState:false,advice:false,emotionalDetail:false,imagined:false,correction:false,acceptsOffer:false,source:'none',retrievalQuery:'',evidence:'你自己有没有什么想说的'})
   : JSON.stringify({reply:'我说说这件小事。',extra:''});
 const {app,req,calls}=await fixture(t,handler,{naturalMaterialDelivery:true,semanticUnderstanding:true,clock:()=>new Date(at),dailyLifeRandom:()=>0});
 const event=app.companionRuntime.prepare({trigger:'user_message',text:''}).dailyLife.events[0];assert.ok(event,JSON.stringify(app.companionRuntime.prepare({trigger:'user_message',text:''})));
 const result=await req('/api/chat',{role:'miyue',text:'你自己有没有什么想说的？'});assert.equal(result.status,200,JSON.stringify(result));
 const prompt=JSON.stringify(calls.find(call=>call.messages.some(message=>String(message.content).includes('【本轮背景开始】'))));
 assert.match(prompt,new RegExp(event.detail));assert.match(prompt,/她的日常近况/);
});

test('natural material delivery permits a life thread after an explicit title reference',async t=>{
 const {app,req}=await fixture(t,()=>JSON.stringify({reply:'刚收好桌上的纸边，想先坐一会儿。',extra:''}),{naturalMaterialDelivery:true});
 const initial=app.lifeThreads.get('miyue');const result=await req('/api/chat',{role:'miyue',text:`说说你的${initial.title}吧。`});
 assert.equal(result.status,200,JSON.stringify(result));assert.equal(result.messages.at(-1).text,'刚收好桌上的纸边，想先坐一会儿。');
 const receipt=app.lifeThreads.get('miyue').history[0];assert.equal(receipt.selectedText,initial.beat.text);assert.equal(receipt.actualReply,result.messages.at(-1).text);assert.equal(receipt.delivery,'material_exposure');
});

test('natural material delivery follows a shorthand question through the latest shared receipt',async t=>{
 const {app,req}=await fixture(t,()=>JSON.stringify({reply:'刚收好桌上的纸边，想先坐一会儿。',extra:''}),{naturalMaterialDelivery:true});
 const initial=app.lifeThreads.get('miyue');const first=await req('/api/chat',{role:'miyue',text:`说说你的${initial.title}吧。`});assert.equal(first.status,200,JSON.stringify(first));
 const context=app.roleContext('miyue',{initiating:false,text:'你那个包装后来呢？',semantic:{continuity:'continue',focusMessageId:first.messages.at(-1).id}});assert.equal(context.sharedExperience?.key,initial.pendingKey);
});

test('natural material delivery preserves a user-selected life branch',async t=>{
 const {app,req}=await fixture(t,()=>JSON.stringify({reply:'我先把这一步留在手边。',extra:''}),{naturalMaterialDelivery:true});
 const initial=app.lifeThreads.get('miyue'),choice=initial.choices[0];
 const selected=await req('/api/chat',{role:'miyue',text:choice.label,lifeChoiceId:choice.id,lifeVersion:initial.version});
 assert.equal(selected.status,200,JSON.stringify(selected));assert.equal(app.lifeThreads.get('miyue').userDirected,true);
 const result=await req('/api/chat',{role:'miyue',text:'说说你的近况'});assert.equal(result.status,200,JSON.stringify(result));
 assert.equal(app.lifeThreads.get('miyue').history.length,1);assert.equal(app.lifeThreads.get('miyue').history[0].actualReply,result.messages.at(-1).text);
});

test('natural material delivery keeps delivered thread history available for explicit recall',async t=>{
 const {app}=await fixture(t,()=> '不会调用模型。',{naturalMaterialDelivery:true});const initial=app.lifeThreads.get('miyue');
 const rows=app.store.saveChatTurn({role:'miyue',text:'先记下这件事。',reply:initial.beat.text});assert.equal(app.lifeThreads.markDelivered(initial.pendingKey,rows.at(-1).id),true);
 const context=app.roleContext('miyue',{initiating:false,text:`还记得${initial.title}吗？`});assert.match(context.characterContext,new RegExp(initial.title));
});

test('natural material delivery does not proactively expose an unparticipated thread',async t=>{
 const {app}=await fixture(t,()=>JSON.stringify({skip:false,contentId:null,reason:'分享近况',message:'刚收好桌上的纸边，想先坐一会儿。'}),{naturalMaterialDelivery:true});
 app.proactiveRepo.saveSettings({activeStart:'00:00',activeEnd:'23:59',desktopNotifications:false});const initial=app.lifeThreads.get('miyue');const result=await app.proactive.runNow();
 assert.equal(app.lifeThreads.get('miyue').history.length,0);assert.equal(app.lifeThreads.get('miyue').pendingKey,initial.pendingKey);
 if(result.delivered)assert.equal(result.message.text.includes(initial.beat.text),false);
});

test('tracked source differences show exact old/new wording without claiming verified news',async t=>{
 const {app,req}=await fixture(t);const feed=app.store.addFeed('https://source.test/rss','来源');app.store.addContent(feed,[{title:'月河计划启动',url:'https://source.test/old',summary:'月河计划今年预计会覆盖20个城市，相关配套服务仍在准备中。'},{title:'月河计划覆盖城市调整',url:'https://source.test/new',summary:'月河计划今年预计会覆盖30个城市，相关配套服务仍在准备中。'}]);const old=app.store.listContent().find(i=>i.url.endsWith('/old'));await req('/api/topics',{action:'follow',contentId:old.id,terms:['月河计划']});const tracked=(await req('/api/topics')).items[0];assert.equal(tracked.change.kind,'figures_differ');assert.equal(tracked.change.verified,false);assert.match(tracked.change.numericDifferences[0].before,/20/);assert.match(tracked.change.numericDifferences[0].after,/30/);
});
for (const presentation of [{name:'legacy generated-material compatibility',options:{naturalMaterialDelivery:true}},{name:'explicit generated presentation',options:{naturalMaterialDelivery:false,materialPresentation:'generated'}}]) test(`authored scenario consequence is shown despite an uncooperative model with ${presentation.name}`,async t=>{
 const {app,req,calls}=await fixture(t,()=> {throw new Error('authored transitions must not call the model');},presentation.options);app.scenarios.select('paper-moon',app.scenarios.get().version);
 // Follow the actual graph to the scene with a committed creative choice.
 for(let n=0;n<10;n++){const current=app.scenarios.get();if(current.scene.id==='rehearsal')break;const choice=current.choices.find(c=>['keep-human','feed-rerecord','move-title','share-cut'].includes(c.id))||current.choices[0];assert.ok(choice);const result=await req('/api/chat',{role:'zhixia',text:choice.label,scenarioChoiceId:choice.id,scenarioVersion:current.version});assert.equal(result.status,200);if(app.scenarios.get().scene.callback){assert.equal(calls.length,0);assert.ok(result.messages.at(-1).text.startsWith(app.scenarios.get().scene.callback.text));return;}}
 assert.fail('authored callback should be reached');
});
test('relevant episodic excerpts are appended after unchanged transcript for prefix caching',async t=>{const {app,req,calls}=await fixture(t,()=> '雨声和音乐确实很搭。');const rows=app.store.saveChatTurn({role:'wenxi',text:'我喜欢独有暗号雨声音乐。',reply:'我们可以慢慢聊雨声音乐。'});app.episodes.remember('wenxi',rows.map(r=>r.id));await req('/api/chat',{role:'wenxi',text:'再聊聊雨声音乐'});const messages=calls.at(-1).messages,history=messages.findIndex(m=>m.content.endsWith('\n'+rows[0].text)&&m.content.startsWith('【历史消息·')),evidence=messages.findIndex(m=>m.content.includes('共同经历证据'));assert.ok(history>0&&evidence>history);});
test('source difference receipts remain available after delivery and for follow-up questions',async t=>{const {app,req,calls}=await fixture(t,()=> '两份摘录的数字不同，还需要核对原公告。');const feed=app.store.addFeed('https://source.test/rss','来源');app.store.addContent(feed,[{title:'月河计划启动',url:'https://source.test/old',summary:'月河计划今年预计会覆盖20个城市，相关配套服务仍在准备中。'},{title:'月河计划覆盖城市调整',url:'https://source.test/new',summary:'月河计划今年预计会覆盖30个城市，相关配套服务仍在准备中。'}]);const old=app.store.listContent().find(i=>i.url.endsWith('/old')),fresh=app.store.listContent().find(i=>i.url.endsWith('/new'));await req('/api/topics',{action:'follow',contentId:old.id,terms:['月河计划']});await req('/api/chat',{role:'wenxi',text:'跟之前的比较一下',contentId:fresh.id});assert.equal((await req('/api/topics')).items[0].change.kind,'figures_differ');await req('/api/chat',{role:'wenxi',text:'刚才的数字是哪里来的'});assert.match(JSON.stringify(calls.at(-1)),/20个城市/);assert.match(JSON.stringify(calls.at(-1)),/30个城市/);});
