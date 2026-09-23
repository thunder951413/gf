import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';
import {historySourceHash} from '../lib/history-edits.mjs';

const now=()=>new Date('2026-09-16T12:00:00.000Z');
const decision=(text,extra={})=>({intent:'recall',continuity:'new',focusMessageId:null,ownLife:false,advice:false,emotionalDetail:false,imagined:false,correction:false,acceptsOffer:false,source:'none',retrievalQuery:'',evidence:text,...extra});

async function fixture(t,{enabled=true,classify=text=>decision(text),reply='我记得这件事。',onBody}={}){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'dialogue-memory-http-')),calls=[];let app;
 app=await createApp({dataDir,clock:now,dialogueMemory:enabled,semanticUnderstanding:true,materialPresentation:'generated',initialFeeds:[],startWeixin:false,startChatQueue:false,startProactive:false,startRecall:false,startResearch:false,startPursuits:false,startLife:false,startLifeThreads:false,startDossiers:false,startRuntime:false,replySleep:async()=>{},env:{LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture'},
  fetchImpl:async(_url,init)=>{const body=JSON.parse(init.body),semantic=body.messages[0]?.content?.startsWith('Classify the current Chinese companion-dialogue turn.');calls.push({semantic,body});const text=semantic?body.messages.at(-1).content.split('CURRENT USER MESSAGE:\n').at(-1):'';if(!semantic)await onBody?.({app,body});const content=semantic?await classify(text,body):(typeof reply==='function'?reply(body):reply);return Response.json({choices:[{message:{content:typeof content==='string'?JSON.stringify({reply:content,extra:''}):JSON.stringify(content)}}],usage:{prompt_tokens:30,completion_tokens:10}});}});
 app.preferences.setReplyPace('instant');const {port}=await app.listen(0);const base=`http://127.0.0.1:${port}`;
 t.after(async()=>{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});});
 const request=async(route,{method='GET',body}={})=>{const response=await fetch(base+route,{method,headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});let payload;try{payload=await response.json();}catch{payload=null;}return{status:response.status,...payload};};
 return{app,calls,request,chat:text=>request('/api/chat',{method:'POST',body:{role:'miyue',text}})};
}

function seed(app,{role='miyue',text,reply,at='2026-08-20T01:00:00.000Z'}){
 const rows=app.store.saveChatTurn({role,text,reply});for(const row of rows){app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(at,row.id);row.createdAt=at;}return rows;
}
function distract(app,count=7){for(let i=0;i<count;i++)seed(app,{text:`近期无关话题${i}：整理桌面。`,reply:`近期无关回应${i}。`,at:`2026-09-15T0${i}:00:00.000Z`});}
const bodyText=f=>JSON.stringify(f.calls.findLast(call=>!call.semantic)?.body.messages||[]);

test('old paraphrased memory reaches the final HTTP prompt and trace without an extra model call',async t=>{
 const f=await fixture(t,{classify:text=>decision(text,{retrievalQuery:'陶艺 杯子 表姐 杯沿 海浪'}),reply:'你送给了表姐，杯沿歪得像一小段海浪。'});
 const rows=seed(f.app,{text:'上个月我把陶艺课捏的第一只杯子送给了表姐。',reply:'杯沿歪得像一小段海浪，但她很喜欢。'});distract(f.app);
 const result=await f.chat('之前那件手作后来给谁了？');assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.calls.length,2,'retrieval reuses the semantic result and adds no model call');
 assert.match(bodyText(f),/表姐/);assert.match(bodyText(f),/杯沿歪得像一小段海浪/);
 const trace=(await f.request('/api/dialogue-traces?role=miyue&limit=1')).traces[0];assert.equal(trace.outcome.status,'delivered');assert.ok(trace.retrieval.selected.some(item=>item.sourceIds.some(id=>rows.some(row=>row.id===id))),JSON.stringify(trace.retrieval));
});

test('recent transcript evidence is represented once rather than duplicated as a memory block',async t=>{
 const f=await fixture(t,{classify:text=>decision(text,{retrievalQuery:'蓝色 杯子 窗边'}),reply:'是窗边那个蓝色杯子。'});
 const rows=seed(f.app,{text:'我喜欢蓝色杯子。',reply:'蓝色杯子放在窗边。',at:'2026-09-16T11:00:00.000Z'});
 const result=await f.chat('刚才杯子放在哪？');assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.calls.length,2);
 assert.equal(bodyText(f).split('蓝色杯子放在窗边').length-1,1);
 const trace=f.app.dialogueTraces.list({roleId:'miyue',limit:1})[0];assert.ok(trace.retrieval.represented.some(item=>item.sourceIds.includes(rows[1].id)));assert.ok(!trace.retrieval.selected.some(item=>item.sourceIds.includes(rows[1].id)));
});

test('factual recall preserves the full recent window when its completed state is outside the short reconnect tail',async t=>{
 const f=await fixture(t,{classify:text=>decision(text,{retrievalQuery:'薄荷 换盆 新叶'}),reply:'已经换完盆，长了三片新叶。'});
 seed(f.app,{text:'阳台薄荷快枯了，准备换盆。',reply:'先放在散射光那里。'});
 const done=seed(f.app,{at:'2026-09-10T02:00:00.000Z',text:'薄荷已经换完盆，长了三片新叶。',reply:'已经缓过来了。'});
 distract(f.app,8);
 const result=await f.chat('薄荷原来的换盆计划还需要做吗？');assert.equal(result.status,200);
 assert.match(bodyText(f),/薄荷已经换完盆，长了三片新叶/);
 assert.equal(bodyText(f).split('薄荷已经换完盆，长了三片新叶').length-1,1);
 assert.ok(f.app.dialogueTraces.list({roleId:'miyue',limit:1})[0].retrieval.represented.some(item=>item.sourceIds.includes(done[0].id)));
 assert.ok(f.calls.findLast(call=>!call.semantic).body.messages[0].content.includes('本轮只核对聊天中已经发生的事实'));
});

test('episode correction and history projection suppress obsolete text in the final request',async t=>{
 const f=await fixture(t,{classify:text=>decision(text,{retrievalQuery:'咖啡 牛奶 燕麦 普通'}),reply:'现在用普通牛奶。'});
 const rows=seed(f.app,{text:'以后点咖啡都要燕麦奶。',reply:'记住了，固定用燕麦奶。'}),entry=f.app.episodes.remember('miyue',rows.map(row=>row.id));
 f.app.episodes.correct('miyue',entry.id,'用户更正：现在咖啡只用普通牛奶，不再用燕麦奶。');
 const noisy=seed(f.app,{text:'我喜欢蓝色。',reply:'保留句。审阅删除的坏样板。'}),assistant=noisy[1],end=assistant.text.indexOf('审阅删除');
 f.app.historyEdits.set('miyue',[{id:assistant.id,sourceHash:historySourceHash(assistant.text),keptSpans:[{start:0,end}],reason:'移除坏样板'}]);distract(f.app);
 const result=await f.chat('我现在喝拿铁用什么奶？');assert.equal(result.status,200,JSON.stringify(result));const prompt=bodyText(f);
 assert.match(prompt,/普通牛奶/);assert.doesNotMatch(prompt,/固定用燕麦奶|以后点咖啡都要燕麦奶|审阅删除的坏样板/);assert.equal(f.app.store.getMessage(assistant.id).text,'保留句。审阅删除的坏样板。');
});

test('retrieval preserves user and character provenance and excludes wrong-role and story rows',async t=>{
 const f=await fixture(t,{classify:text=>decision(text,{ownLife:true,retrievalQuery:'修旧书 阿岚 书脊 青岛 周闻'}),reply:'我跟阿岚学修旧书；你在青岛跟周闻学过划桨板。'});
 const user=seed(f.app,{text:'我在青岛跟周闻学会了划桨板。',reply:'你第一次站起来时膝盖一直抖。'}),character=seed(f.app,{text:'你最近学了什么？',reply:'我跟阿岚学了修旧书，先练补书脊。'});
 seed(f.app,{role:'wenxi',text:'你学了什么？',reply:'错误角色独有木版画。'});
 f.app.store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)').run('story-memory-excluded','miyue','assistant','故事独有玻璃城堡。','story','2026-08-20T01:00:00.000Z');distract(f.app);
 const result=await f.chat('我们两个人以前各自学过什么？');assert.equal(result.status,200,JSON.stringify(result));const prompt=bodyText(f);
 assert.match(prompt,/青岛跟周闻学会了划桨板/);assert.match(prompt,/阿岚学了修旧书/);assert.doesNotMatch(prompt,/错误角色独有木版画|故事独有玻璃城堡/);
 const selected=f.app.dialogueTraces.list({roleId:'miyue',limit:1})[0].retrieval.selected.flatMap(item=>item.sourceIds);assert.ok(user.some(row=>selected.includes(row.id)));assert.ok(character.some(row=>selected.includes(row.id)));
});

test('enabled and disabled HTTP surfaces agree with runtime behavior',async t=>{
 const enabled=await fixture(t,{enabled:true,classify:text=>decision(text,{retrievalQuery:'独有旧标记 纸灯'}),reply:'记得那盏纸灯。'});seed(enabled.app,{text:'独有旧标记：我做了一盏橙色纸灯。',reply:'灯穗用了白线。'});distract(enabled.app);await enabled.chat('以前做的灯是什么？');
 assert.equal((await enabled.request('/api/health')).dialogueMemory,true);assert.equal((await enabled.request('/api/dialogue-traces')).enabled,true);assert.equal((await enabled.request('/api/dialogue-traces')).traces.length,1);assert.match(bodyText(enabled),/橙色纸灯/);
 const disabled=await fixture(t,{enabled:false,classify:text=>decision(text,{retrievalQuery:'独有旧标记 纸灯'}),reply:'我不确定是哪一盏。'});seed(disabled.app,{text:'独有旧标记：我做了一盏橙色纸灯。',reply:'灯穗用了白线。'});distract(disabled.app);await disabled.chat('以前做的灯是什么？');
 assert.equal((await disabled.request('/api/health')).dialogueMemory,false);const traces=await disabled.request('/api/dialogue-traces');assert.equal(traces.enabled,false);assert.deepEqual(traces.traces,[]);assert.doesNotMatch(bodyText(disabled),/独有旧标记|橙色纸灯|灯穗用了白线/);assert.equal(disabled.calls.length,2);
});

test('stale-memory save failure rolls back chat rows and records a failed trace',async t=>{
 let corrected=false,entry;const f=await fixture(t,{classify:text=>decision(text,{retrievalQuery:'旧偏好 红茶'}),reply:'你以前偏好红茶。',onBody:({app})=>{if(!corrected){app.episodes.correct('miyue',entry.id,'用户更正：这条偏好已经撤销。');corrected=true;}}});
 const rows=seed(f.app,{text:'我的旧偏好是红茶。',reply:'记下了。'});entry=f.app.episodes.remember('miyue',rows.map(row=>row.id));distract(f.app);const before=f.app.store.getMessages('miyue').length;
 const result=await f.chat('我以前偏好什么？');assert.equal(result.status,409,JSON.stringify(result));assert.equal(result.code,'STALE_MEMORY');assert.equal(f.app.store.getMessages('miyue').length,before,'failed save transaction must not leave the user or assistant row');
 const trace=f.app.dialogueTraces.list({roleId:'miyue',limit:1})[0];assert.equal(trace.outcome.status,'failed');assert.equal(trace.outcome.code,'STALE_MEMORY');assert.deepEqual(trace.messageIds,[]);
});

test('one generation repair remains visible in the delivered dialogue trace',async t=>{
 let drafts=0;const f=await fixture(t,{classify:text=>decision(text,{retrievalQuery:'旧相机 胶卷'}),reply:()=>++drafts===1?{reply:'',extra:''}:{reply:'那台旧相机装的是黑白胶卷。',extra:''}});
 seed(f.app,{text:'旧相机里装的是黑白胶卷。',reply:'拍完再一起去冲洗。'});distract(f.app);
 const result=await f.chat('以前那台相机装了什么？');assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.calls.length,3,'semantic, rejected draft, and one repair call');
 const trace=f.app.dialogueTraces.list({roleId:'miyue',limit:1})[0];assert.equal(trace.outcome.status,'delivered');assert.ok(trace.repairIssues.includes('invalid_reply_envelope'),JSON.stringify(trace));
});

test('semantic memory alias selects source-backed non-overlapping evidence without another model call',async t=>{
 let seenCandidates='';
 const f=await fixture(t,{classify:(_text,body)=>{
  seenCandidates=body.messages.find(message=>message.content.startsWith('MEMORY CANDIDATES'))?.content||'';
  const alias=seenCandidates.match(/(m\d+)[^\n]*: 我把第一次做的陶杯送给表姐，杯沿歪得像海浪。/)?.[1];
  assert.ok(alias,seenCandidates);
  return decision('那件不太规整的手作最后去了谁那里？',{intent:'ask_question',retrievalQuery:'',memoryRefs:[alias]});
 },reply:'那只陶杯送给了表姐，杯沿像海浪。'});
 const rows=seed(f.app,{text:'我把第一次做的陶杯送给表姐，杯沿歪得像海浪。',reply:'这是你自己做出的第一只杯子。'});distract(f.app);
 const result=await f.chat('那件不太规整的手作最后去了谁那里？');assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.calls.length,2,'memory alias uses the existing semantic call plus the normal reply call');
 assert.match(seenCandidates,/subject:user/);assert.match(bodyText(f),/送给表姐，杯沿歪得像海浪/);
 const trace=f.app.dialogueTraces.list({roleId:'miyue',limit:1})[0];assert.ok(trace.retrieval.selected.some(item=>item.sourceIds.includes(rows[0].id)),JSON.stringify(trace.retrieval));
});

test('optional collector failure keeps recent evidence, hides old text, and records retrieval fallback',async t=>{
 const f=await fixture(t,{classify:text=>decision(text,{intent:'ask_question',retrievalQuery:'',memoryRefs:[]}),reply:'茉莉花茶。刚才那句我记住了，没有和以前的口味混在一起。'});
 seed(f.app,{text:'旧原话独有标记：以前只喝浓咖啡。',reply:'旧回应独有标记：每天两杯。'});distract(f.app);
 seed(f.app,{text:'今天改喝茉莉花茶。',reply:'好，我记下这次变化。',at:'2026-09-16T11:00:00.000Z'});
 const original=f.app.episodes.suppressedSourceIds.bind(f.app.episodes);
 f.app.episodes.suppressedSourceIds=scope=>{const stack=new Error().stack||'';if(stack.includes('collectConversationMemory'))throw Object.assign(Error('synthetic collector failure'),{code:'SYNTHETIC_COLLECTOR_FAILURE'});return original(scope);};
 const result=await f.chat('我刚说今天改喝什么？');assert.equal(result.status,200,JSON.stringify(result));assert.match(result.messages.at(-1).text,/茉莉花茶/);const prompt=bodyText(f);
 assert.match(prompt,/今天改喝茉莉花茶/);assert.doesNotMatch(prompt,/旧原话独有标记|旧回应独有标记/);
 const trace=f.app.dialogueTraces.list({roleId:'miyue',limit:1})[0];assert.equal(trace.outcome.status,'delivered');assert.equal(trace.retrieval.status,'fallback');assert.equal(trace.retrieval.errorCode,'MEMORY_RETRIEVAL_UNAVAILABLE');
});
