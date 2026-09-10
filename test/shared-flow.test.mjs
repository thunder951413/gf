import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { importSharedExperiences } from '../lib/shared-experience-import.mjs';

const catalog = { items: ['窗边读书', '另一部电影'].map((title, item) => ({
  id:`focus-${item}`,kind:item?'film':'reading',title,aliases:[title],
  source:{title:`${title}资料`,url:`https://fixture.test/${item}`,scope:'测试摘录，非真实资讯'},
  stages:Array.from({length:4},(_,stage)=>({label:`阶段${stage}`,action:`我读《${title}》到第${stage+1}部分了。`,detail:`${title}阶段${stage}细节标记：讨论人物如何作出自己的选择。`})),
})) };

async function fixture(t,{answer}={}) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'shared-flow-'));
  let now=new Date('2026-09-08T01:00:00Z');
  const calls=[];
  const app=await createApp({dataDir,initialFeeds:[],pursuitCatalog:catalog,startPursuits:true,startProactive:false,startRecall:false,startLifeThreads:false,replySleep:async()=>{},lifeRandom:()=>.99,random:()=>.5,
    clock:()=>new Date(now),env:{LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture'},
    fetchImpl:async(_url,init)=>{
      const body=JSON.parse(init.body);calls.push(body);
      const generated=answer?.(body,calls.length) ?? {reply:'我在意的是她明明犹豫，却还是说出了自己的想法。',extra:''};
      return Response.json({choices:[{message:{content:typeof generated==='string'?generated:JSON.stringify(generated)}}]});
    },
  });
  const {port}=await app.listen(0);
  t.after(async()=>{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  return {app,calls,advance:hours=>{now=new Date(+now+hours*3600000);},chat:async(text,role='miyue')=>{
    const r=await fetch(`http://127.0.0.1:${port}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role,text})});
    return {status:r.status,...await r.json()};
  }};
}
const prompt = call => call.messages.map(m=>m.content).join('\n');

test('a sent reading remains the reply material across silent progress and several elliptical replies',async t=>{
  const {app,calls,chat,advance}=await fixture(t);
  const first=await chat('说说你的近况');assert.equal(first.status,200);
  const original=first.messages.at(-1),key=app.interactionPolicy.receipt(original.id).focus.key;
  advance(80);
  for(const text of ['后来呢','为什么呀','这点我也挺有共鸣','继续说']){
    const r=await chat(text);assert.equal(r.status,200,JSON.stringify({text,result:r,request:calls.at(-1).messages.at(-1)}));
    const receipt=app.interactionPolicy.receipt(r.messages.at(-1).id);
    assert.equal(receipt.focus.key,key);assert.equal(receipt.focus.continuation,true);
    assert.equal(receipt.behavior.extra,null);
    assert.match(prompt(calls.at(-1)),/窗边读书阶段0细节标记/);
    assert.doesNotMatch(prompt(calls.at(-1)),/窗边读书阶段2细节标记|本轮唯一分享材料/);
    assert.doesNotMatch(r.messages.at(-1).text,/我读《窗边读书》到第1部分了/);
  }
  assert.equal(app.pursuits.get('miyue').stage.index,2);
  assert.equal(app.pursuits.get('miyue').history.length,1,'new progress was not falsely recorded as sent');
  const progress=await chat('这本书现在读到哪里了？');assert.equal(progress.status,200);
  assert.match(progress.messages.at(-1).text,/到第3部分/);
  assert.match(prompt(calls.at(-1)),/窗边读书阶段2细节标记/);
});

test('named historical material survives a new activity; explicit topic changes release its focus',async t=>{
  const {app,calls,chat,advance}=await fixture(t);
  await chat('说说你的近况');advance(200);
  const old=await chat('窗边读书那一段，为什么让你在意？');assert.equal(old.status,200);
  assert.equal(app.pursuits.get('miyue').title,'另一部电影');
  assert.match(prompt(calls.at(-1)),/窗边读书阶段0细节标记/);
  assert.doesNotMatch(prompt(calls.at(-1)),/另一部电影阶段0细节标记/);
  const other=await chat('换个话题，我今天准备做炒饭。');assert.equal(other.status,200);
  assert.equal(app.interactionPolicy.receipt(other.messages.at(-1).id).focus,undefined);
  assert.doesNotMatch(prompt(calls.at(-1)),/窗边读书阶段0细节标记/);
});

test('explicit affection overrides a reading continuation while keeping tuning effective',async t=>{
  const {app,chat,calls}=await fixture(t,{answer:()=>({reply:'我先把书合上。',extra:'让我赖着你聊两句嘛。'})});
  app.companionTuning.set({warmth:100,coyness:100,pleasing:100},0);
  await chat('说说你的近况');
  const r=await chat('撒个娇给我听');assert.equal(r.status,200);
  assert.match(r.messages.at(-1).text,/赖着你/);
  const receipt=app.interactionPolicy.receipt(r.messages.at(-1).id);
  assert.equal(receipt.behavior.extra,'tender');assert.equal(receipt.focus,undefined);
  assert.doesNotMatch(prompt(calls.at(-1)),/窗边读书阶段0细节标记/);
});

test('returning to an already sent book establishes a fresh link without replaying its opener',async t=>{
  const {app,calls,chat}=await fixture(t);
  await chat('说说你的近况');
  await chat('换个话题，我想做炒饭。');
  // No title or shared-message reference: the current reading route selects it.
  const reopened=await chat('你最近在读什么？');assert.equal(reopened.status,200);
  assert.doesNotMatch(reopened.messages.at(-1).text,/我读《窗边读书》到第1部分了/);
  const r=await chat('怎么说？');assert.equal(r.status,200);
  assert.equal(app.interactionPolicy.receipt(r.messages.at(-1).id).focus.key,app.interactionPolicy.receipt(reopened.messages.at(-1).id).focus.key);
  assert.match(prompt(calls.at(-1)),/窗边读书阶段0细节标记/);
});

test('upgrade imports actual old delivery receipts once without rewriting conversation',async t=>{
  const {app,chat}=await fixture(t);
  const first=await chat('说说你的近况'),messages=app.store.getMessages('miyue');
  app.store.db.exec("DELETE FROM shared_experiences; DELETE FROM metadata WHERE key='shared_experiences_import_v1'");
  importSharedExperiences(app.store,app.sharedExperiences,{pursuits:app.pursuits,thread:app.lifeThreads.get('miyue')});
  const packet=app.sharedExperiences.resolve('miyue',{conversation:messages,text:'后来呢',holdsTopic:true});
  assert.equal(packet.sourceMessageId,first.messages.at(-1).id);
  assert.match(packet.detail,/窗边读书阶段0细节标记/);
  const count=app.store.db.prepare('SELECT COUNT(*) n FROM shared_experiences').get().n;
  importSharedExperiences(app.store,app.sharedExperiences,{pursuits:app.pursuits});
  assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM shared_experiences').get().n,count);
  assert.deepEqual(app.store.getMessages('miyue'),messages);
});

test('a deletion during generation cannot commit the followup link or its new messages',async t=>{
  let remove=null;
  const {app,chat}=await fixture(t,{answer:()=>{remove?.();return {reply:'我还想聊聊那一段。',extra:''};}});
  const first=await chat('说说你的近况');
  const count=app.store.db.prepare('SELECT COUNT(*) n FROM shared_experiences').get().n;
  remove=()=>app.store.db.prepare('DELETE FROM messages WHERE id=?').run(first.messages.at(-1).id);
  const response=await chat('后来呢');assert.notEqual(response.status,200);
  assert.equal(app.store.getMessages('miyue').length,1);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM shared_experiences').get().n,count);
});

test('malformed model protocol gets one repair and writes only the successful turn',async t=>{
  const {app,calls,chat}=await fixture(t,{answer:(_body,index)=>index===1?'{"reply":':{reply:'这一段我想慢慢读。',extra:''}});
  const r=await chat('说说你的近况');assert.equal(r.status,200);
  assert.equal(calls.length,2);assert.equal(app.store.getMessages('miyue').length,2);
  assert.equal(app.pursuits.get('miyue').history.length,1);
  assert.equal(app.interactionPolicy.receipt(r.messages.at(-1).id).behavior.retries,1);
});

test('two malformed drafts create no sent memory or false progress receipt',async t=>{
  const {app,calls,chat}=await fixture(t,{answer:()=>'{"reply":'});
  const r=await chat('说说你的近况');assert.equal(r.status,502);assert.equal(r.code,'MODEL_REPLY_INVALID');
  assert.equal(calls.length,2);assert.equal(app.store.getMessages('miyue').length,0);
  assert.equal(app.pursuits.get('miyue').history.length,0);
});

test('short, playful, and analytical model voices share the same delivery and continuation contract',async t=>{
  for(const reply of ['这段我挺喜欢的。','她最后那一下犹豫，我看得都替她着急。','我更在意她为什么改变了主意，前后的选择其实不矛盾。']){
    await t.test(reply,async t=>{
      const {app,chat}=await fixture(t,{answer:()=>({reply,extra:'硬塞进来的无关撒娇。'})});
      const first=await chat('说说你的近况');const next=await chat('继续说');
      assert.equal(first.status,200);assert.equal(next.status,200);
      assert.equal(next.messages.at(-1).text,reply);
      assert.equal(app.interactionPolicy.receipt(next.messages.at(-1).id).focus.key,app.interactionPolicy.receipt(first.messages.at(-1).id).focus.key);
    });
  }
});
