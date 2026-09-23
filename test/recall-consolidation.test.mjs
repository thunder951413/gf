import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { RecallRepository, RecallEngine } from '../lib/recall.mjs';
import { createApp } from '../server.mjs';

const now=new Date('2026-09-20T03:00:00Z');
const story={start:'start',nodes:{start:{id:'start',title:'start',body:'',choices:[]}}};
function add(store,id,text,{at='2026-09-01T00:00:00Z',speaker='user',role='miyue'}={}){
  store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)').run(id,role,speaker,text,'chat',at);
}
function extract(messages){
  const {existing,conversation}=JSON.parse(messages[1].content);
  const rows=conversation.filter(row=>row.text==='我喜欢无糖茶。');
  return {items:rows.map(row=>({...(existing[0]?{targetId:existing[0].id}:{}),subject:'user',kind:'preference',topic:'饮料口味',summary:'用户喜欢无糖茶。',status:'current',evidence:[{messageId:row.id,quote:row.text}]})),ignored:conversation.filter(row=>!rows.includes(row)).map(row=>({messageId:row.id,reason:'filler'}))};
}
function fixture(t,{complete=async messages=>JSON.stringify(extract(messages)),hidden=[]}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'recall-consolidation-'));
  const store=new Store({dataDir:dir,story,initialFeeds:[]});
  const repo=new RecallRepository(store,{clock:()=>now,getSuppressedSourceIds:()=>hidden});
  const calls=[];const model={publicConfig:()=>({configured:true,model:'fixture'}),complete:async(messages,options)=>{calls.push({messages,options});return complete(messages,options);}};
  const engine=new RecallEngine({repo,model,roles:[{id:'miyue'}],clock:()=>now});
  t.after(async()=>{await engine.stop();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {store,repo,engine,calls};
}

test('old summary cursor does not skip raw migration; repeated batches remain one memory and preserve recent text',async t=>{
  const f=fixture(t);
  for(let i=0;i<80;i++)add(f.store,'old-'+i,'我喜欢无糖茶。');
  add(f.store,'recent','最近的完整对话不能压缩',{at:'2026-09-19T00:00:00Z'});
  f.repo.get('miyue');
  f.store.db.prepare("UPDATE recall_state SET through_rowid=80,summary='旧摘要',summary_origin='automatic' WHERE role_id='miyue'").run();
  for(let i=0;i<4;i++){const result=await f.engine.run('miyue',{force:true});assert.equal(result.status,'updated',JSON.stringify(result));}
  const items=f.repo.consolidated.snapshot('miyue').items;
  assert.equal(items.length,1);assert.equal(items[0].summary,'用户喜欢无糖茶。');assert.equal(items[0].mentions,80);
  assert.ok(items[0].evidence.length<=6);
  assert.deepEqual(f.repo.shortTermConversation('miyue').map(row=>row.id),['recent']);
  assert.doesNotMatch(f.repo.longTermContext('miyue'),/旧摘要/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM messages').get().n,81);
  const before=f.repo.longTermContext('miyue');assert.equal(before,f.repo.longTermContext('miyue'));
  assert.equal((await f.engine.run('miyue',{force:true})).reason,'short-term-window');
});

test('invalid extraction does not advance either cursor and backs off instead of silently dropping messages',async t=>{
  const f=fixture(t,{complete:async()=>JSON.stringify({items:[],ignored:[]})});
  add(f.store,'old','必须有明确去向');add(f.store,'recent','新消息',{at:'2026-09-19T00:00:00Z'});
  const before=f.repo.consolidated.snapshot('miyue');
  assert.equal((await f.engine.run('miyue',{force:true})).status,'failed');
  assert.deepEqual(f.repo.consolidated.snapshot('miyue'),before);
  assert.equal((await f.engine.run('miyue')).reason,'backoff');
  assert.equal(f.calls.length,2);
});

test('suppressed sources never go to extraction and source suppression removes derived context and review evidence',async t=>{
  const hidden=['private'];const f=fixture(t,{hidden});
  add(f.store,'private','秘密原文');add(f.store,'old','我喜欢无糖茶。');add(f.store,'recent','新消息',{at:'2026-09-19T00:00:00Z'});
  assert.equal((await f.engine.run('miyue',{force:true})).status,'updated');
  assert.doesNotMatch(JSON.stringify(f.calls),/秘密原文/);
  assert.match(f.repo.longTermContext('miyue'),/无糖茶/);
  hidden.push('old');assert.doesNotMatch(f.repo.longTermContext('miyue'),/无糖茶/);
  assert.doesNotMatch(JSON.stringify(f.repo.consolidated.review('miyue')),/无糖茶/);
});

test('manual correction during model work wins and blocks stale automatic writes',async t=>{
  let release;const hold=new Promise(resolve=>{release=resolve;});
  const f=fixture(t,{complete:async messages=>{await hold;return JSON.stringify(extract(messages));}});
  add(f.store,'old','我喜欢无糖茶。');add(f.store,'recent','新消息',{at:'2026-09-19T00:00:00Z'});
  const job=f.engine.run('miyue',{force:true});while(!f.calls.length)await new Promise(resolve=>setImmediate(resolve));
  f.repo.replace('miyue','用户刚刚修订的记忆');release();
  assert.equal((await job).status,'stale');assert.equal(f.repo.get('miyue').summary,'用户刚刚修订的记忆');
  assert.equal(f.repo.consolidated.snapshot('miyue').items.length,0);
});

test('a small old remainder is consolidated automatically without waiting for forty new messages',async t=>{
  const f=fixture(t);add(f.store,'old','我喜欢无糖茶。');add(f.store,'recent','新消息',{at:'2026-09-19T00:00:00Z'});
  const result=await f.engine.run('miyue');assert.equal(result.status,'updated');assert.equal(result.summarizedCount,1);
});

test('HTTP review exposes source comparisons and prompt receives old deduplicated memory with recent raw',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memory-review-api-')),calls=[];
  const app=await createApp({dataDir:dir,initialFeeds:[],clock:()=>now,startWeixin:false,startChatQueue:false,startProactive:false,startRecall:false,startResearch:false,startRuntime:false,startLifeThreads:false,startDossiers:false,replySleep:async()=>{},env:{LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture'},fetchImpl:async(_url,options)=>{
    const body=JSON.parse(options.body);calls.push(body);
    const content=body.messages[0].content.includes('你整理林晓薇')?JSON.stringify(extract(body.messages)):JSON.stringify({reply:'我记得你喜欢无糖茶。',extra:''});
    return Response.json({choices:[{message:{content}}]});
  }});
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  add(app.store,'old','我喜欢无糖茶。');add(app.store,'recent','最近我提到过一件小事',{at:'2026-09-19T00:00:00Z'});
  assert.equal((await app.recall.run('miyue',{force:true})).status,'updated');
  const {port}=await app.listen(0);const base=`http://127.0.0.1:${port}`;
  const review=await(await fetch(base+'/api/recall/miyue/review')).json();
  assert.equal(review.shortTerm.messages,1);assert.equal(review.longTerm.items.length,1);
  assert.ok(review.longTerm.runs[0].sources.some(row=>row.id==='old'&&row.text==='我喜欢无糖茶。'));
  const response=await fetch(base+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:'miyue',text:'我喜欢什么饮料？'})});
  assert.equal(response.status,200,JSON.stringify(await response.json()));
  const prompt=JSON.stringify(calls.at(-1).messages);assert.match(prompt,/用户喜欢无糖茶/);assert.match(prompt,/最近我提到过一件小事/);
});
