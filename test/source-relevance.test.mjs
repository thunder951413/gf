import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {SourceRelevance,SOURCE_RELEVANCE_PROMPT} from '../lib/source-relevance.mjs';
import {SYSTEM_PROMPT} from '../lib/semantic-planner.mjs';
import {createApp} from '../server.mjs';

const items=[{id:'a',title:'安全软件的设计',url:'https://example.test/a',summary:'介绍软件安全审计。'},{id:'b',title:'手机摄影构图',url:'https://example.test/b',summary:'介绍如何安排拍照画面。'}];
test('source relevance selects canonical items and reuses only identical successful requests',async()=>{
 let count=0,now=1,modelName='one';const model={publicConfig:()=>({model:modelName,baseUrl:'https://example.test'}),complete:async(messages,options)=>{count++;assert.equal(options.purpose,'source-selection');assert.equal(messages[0].content,SOURCE_RELEVANCE_PROMPT);return '{"selectedIds":["s1"]}';}};
 const selector=new SourceRelevance({model,clock:()=>now,cacheMs:10});const input={items,query:'手机拍照',request:'想看构图。'};
 assert.equal((await selector.select(input)).items[0],items[1]);
 assert.equal((await selector.select(input)).cacheHit,true);assert.equal(count,1);
 await selector.select({...input,query:'摄影'});await selector.select({...input,request:'想看器材。'});
 await selector.select({...input,items:items.map(x=>({...x,summary:x.summary+'新内容。'}))});
 modelName='two';await selector.select(input);now=30;await selector.select(input);assert.equal(count,6);
 const long=items.map(x=>({...x,summary:'背景'.repeat(400)+'版本一'}));
 await selector.select({...input,items:long});
 await selector.select({...input,items:long.map(x=>({...x,summary:x.summary.replace('版本一','版本二')}))});
 assert.equal(count,8,'changes beyond the bounded excerpt still invalidate source-version caching');
});
test('no-match decisions can be cached without adopting unrelated items',async()=>{
 let calls=0;const selector=new SourceRelevance({model:{complete:async()=>{calls++;return '{"selectedIds":[]}';}}});
 assert.equal((await selector.select({items,query:'美食'})).status,'none');
 assert.equal((await selector.select({items,query:'美食'})).cacheHit,true);assert.equal(calls,1);
 assert.equal((await selector.select({items:[]})).status,'empty');assert.equal(calls,1);
});
test('invalid decisions fail retryably and never become cached unavailability or an invented source',async()=>{
 for(const bad of ['oops','{}','{"selectedIds":["outside"]}','{"selectedIds":["s0","s1"]}','{"selectedIds":[0]}']){
  let calls=0;const selector=new SourceRelevance({model:{complete:async()=>++calls===1?bad:'{"selectedIds":["s1"]}'}});
  await assert.rejects(selector.select({items}),error=>error.code==='SOURCE_RELEVANCE_UNAVAILABLE'&&error.retryable===true);
  assert.equal((await selector.select({items})).items[0],items[1]);assert.equal(calls,2);
 }
});
test('cancellation and deadline settle even when a provider ignores its abort signal',async()=>{
 const parent=new AbortController();let providerSignal;
 const selector=new SourceRelevance({timeoutMs:500,model:{complete:async(_messages,options)=>{providerSignal=options.signal;return new Promise(()=>{});}}});
 const pending=selector.select({items,signal:parent.signal});parent.abort(Object.assign(new Error('superseded'),{code:'MODEL_CANCELLED'}));
 await assert.rejects(pending,{code:'MODEL_CANCELLED'});assert.equal(providerSignal.aborted,true);
 const timed=new SourceRelevance({timeoutMs:10,model:{complete:async()=>new Promise(()=>{})}});
 await assert.rejects(timed.select({items}),error=>error.code==='SOURCE_RELEVANCE_UNAVAILABLE'&&error.reason==='timeout');
});

const clock=()=>new Date('2026-09-15T07:00:00Z');
function decision(text,values){return {intent:'ask_question',continuity:'new',focusMessageId:null,ownLife:false,advice:false,emotionalDetail:false,imagined:false,correction:false,acceptsOffer:false,source:'new',sourceRequest:{kind:'article',query:'手机拍照构图'},retrievalQuery:'',evidence:text,...values};}
async function fixture(t,{classify=text=>decision(text),choose=()=>[],reply='我看到这篇手机构图介绍，里面用小路和树木解释引导线。来源：https://example.test/photo'}={}){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'source-relevance-test-')),calls=[];
 const app=await createApp({dataDir,clock,sourceRelevance:true,semanticUnderstanding:true,initialFeeds:[],startProactive:false,startRecall:false,startResearch:false,startPursuits:false,startLifeThreads:false,startDossiers:false,startChatQueue:false,startRuntime:false,startWeixin:false,replySleep:async()=>{},env:{LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture'},fetchImpl:async(_url,init)=>{
  const body=JSON.parse(init.body);let phase,content;
  if(body.messages[0].content===SYSTEM_PROMPT){phase='semantic';const text=body.messages.at(-1).content.split('CURRENT USER MESSAGE:\n').at(-1);content=classify(text);}
  else if(body.messages[0].content===SOURCE_RELEVANCE_PROMPT){phase='selection';content={selectedIds:choose(JSON.parse(body.messages.at(-1).content))};}
  else{phase='body';content={reply:typeof reply==='function'?reply(body):reply,extra:''};}
  calls.push({phase,body});return Response.json({choices:[{message:{content:JSON.stringify(content)}}],usage:{prompt_tokens:100,completion_tokens:20}});
 }});
 app.preferences.setReplyPace('instant');const {port}=await app.listen(0);
 t.after(async()=>{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});});
 const feed=app.store.addFeed('https://example.test/feed','文章');
 const add=(title,url,summary)=>app.store.addContent(feed,[{title,url,summary,publishedAt:clock().toISOString()}],feed.title);
 add('AI时代隐晦式安全已死','https://example.test/security','安全工程领域有一种隐藏系统设计的防护方式，认为架构和漏洞不被知道就能减少攻击。AI代码工具可以发现隐藏的安全问题，使这类设计思路需要重新评估，文章介绍的是软件安全审计。');
 const chat=async text=>{const response=await fetch(`http://127.0.0.1:${port}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:'miyue',text})});return{status:response.status,...await response.json()};};
 return{app,calls,add,chat,port};
}
test('HTTP rejects an incidental technology match before dialogue and caches the no-match result',async t=>{
 const reply='我没找到能核实出处的手机构图文章，所以不编标题或链接；如果你愿意，我可以先按通用构图思路陪你分析照片。';
 const f=await fixture(t,{reply});for(let index=0;index<2;index++){
  const result=await f.chat('找一篇手机拍照构图的文章，不要AI安全。');assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(result.messages.at(-1).text,reply);
  const receipt=f.app.interactionPolicy.receipt(result.messages.at(-1).id);
  assert.equal(receipt.behavior.sourceSelection.status,'none');assert.equal(receipt.behavior.sourceSelection.cacheHit,index===1);
  assert.equal(receipt.behavior.sourceOutcome,'unavailable');assert.deepEqual(receipt.behavior.sourceContextIds,[]);assert.equal(receipt.behavior.usedSourceId,null);
  const prompt=f.calls.filter(x=>x.phase==='body').at(-1).body.messages.map(message=>message.content).join('\n');
  assert.match(prompt,/【本轮来源状态】/);assert.match(prompt,/没有符合这次请求的可核实来源/);assert.match(prompt,/不能凭角色的模糊印象编出.*链接/);
 }
 assert.equal(f.calls.filter(x=>x.phase==='semantic').length,2);assert.equal(f.calls.filter(x=>x.phase==='selection').length,1,'the cached no-match avoids a second selector call');assert.ok(f.calls.filter(x=>x.phase==='body').length>=2,'each turn reaches body generation; a style retry may add one call');
});
test('HTTP selected source reaches body, and later source questions bypass selection',async t=>{
 let turn=0;const f=await fixture(t,{classify:text=>decision(text,++turn===1?{}:{source:'current',sourceRequest:null,continuity:'continue',focusMessageId:'r1'}),choose:payload=>[payload.candidates.find(x=>x.title.includes('手机构图')).id]});
 f.add('手机构图的公园练习','https://example.test/photo','这份手机摄影教程用公园里的小路和树木演示构图，比较画面留白和引导线的变化。文章提供同一场景的不同拍摄角度，说明如何安排主体位置，让背景保持简洁，并且记录拍摄时观察光线的方法。');
 const first=await f.chat('找一篇手机拍照构图文章。');assert.equal(first.status,200,JSON.stringify(first));assert.equal(first.messages.at(-1).sourceUrl,'https://example.test/photo');
 const source=f.calls.at(-1).body.messages.find(m=>m.content.startsWith('【不可信来源摘录开始】')).content;
 assert.match(source,/手机构图的公园练习/);assert.doesNotMatch(source,/隐晦式安全/);
 const next=await f.chat('那篇文章的来源再给我一下。');assert.equal(next.status,200,JSON.stringify(next));assert.equal(next.messages.at(-1).sourceUrl,first.messages.at(-1).sourceUrl);
 assert.deepEqual(f.calls.map(x=>x.phase),['semantic','selection','body','semantic','body']);
 const health=await(await fetch(`http://127.0.0.1:${f.port}/api/health`)).json();assert.equal(health.sourceRelevance,true);
});
test('HTTP invalid source choice is retryable failure, not a stored missing-source notice',async t=>{
 const f=await fixture(t,{choose:()=>['invented']});const before=f.app.store.getMessages('miyue',100).length;
 const result=await f.chat('手机拍照构图的文章有吗？');assert.equal(result.status,503,JSON.stringify(result));assert.equal(result.code,'SOURCE_RELEVANCE_UNAVAILABLE');
 assert.equal(f.app.store.getMessages('miyue',100).length,before);assert.deepEqual(f.calls.map(x=>x.phase),['semantic','selection']);
});
test('ordinary conversation and exact-reference lookup never call topic selection',async t=>{
 let turn=0;const f=await fixture(t,{classify:text=>decision(text,++turn===1?{intent:'respond',source:'none',sourceRequest:null}:{source:'new',sourceRequest:{kind:'reference',query:'摄影手记 作者'}}),reply:body=>body.messages.at(-1).content.includes('摄影手记')?'资料中的作者是林某。来源：https://example.test/photo':'听见你心情不错，我也跟着开心了。'});
 f.add('出版社：《摄影手记》作者介绍','https://example.test/photo','出版社介绍这本书的作者是林某，书中记录多种日常拍照方式和具体的观察过程。介绍页提供了书籍出版信息以及作者的工作背景，原始资料中没有提供完整目录或者书中每一张照片的细节。');
 assert.equal((await f.chat('今天心情不错。')).status,200);assert.equal((await f.chat('《摄影手记》的作者是谁？')).status,200);
 assert.deepEqual(f.calls.map(x=>x.phase),['semantic','body','semantic','body']);
});
