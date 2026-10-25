import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { RecallRepository } from '../lib/recall.mjs';
import { PreferencesRepository } from '../lib/preferences.mjs';
import { DailyDialogueMemory, dailyCompressionSlot, shanghaiDayStart } from '../lib/daily-dialogue-memory.mjs';
import { HistoryEdits, historySourceHash } from '../lib/history-edits.mjs';
import { HistoryDeletion } from '../lib/history-deletion.mjs';
import { buildSessionMessages } from '../lib/session-dialogue.mjs';
import { createApp } from '../server.mjs';
import { ensurePruneTable, dailyItemRef } from '../lib/history-prunes.mjs';

const NOW = new Date('2026-09-30T15:00:00Z');
const story={start:'start',nodes:{start:{id:'start',title:'start',body:'',choices:[]}}};
const extract=messages=>({items:JSON.parse(messages[1].content).conversation.map(row=>({subject:row.speaker==='user'?'user':'character',kind:'event',status:'unknown',text:row.text,evidence:[{id:row.id,quote:row.text}]})),omitted:[]});
function fixture(t,{complete,hidden=[],clock=()=>NOW}={}) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'daily-dialogue-'));
  const store=new Store({dataDir:dir,story,initialFeeds:[]}),prefs=new PreferencesRepository(store);
  const repo=new RecallRepository(store,{clock,getHistoryWindow:()=>prefs.getHistoryWindow(),getSuppressedSourceIds:()=>hidden});
  const calls=[],model={publicConfig:()=>({configured:true}),complete:async(messages,options)=>{calls.push({messages,options});return JSON.stringify(complete?await complete(messages,options):options.purpose==='daily-compression-review'?{ok:true,issues:[]}:extract(messages));}};
  const memory=new DailyDialogueMemory(store,{repo,model,clock,enabled:true});
  const add=(id,text,speaker='user',at='2026-09-28T08:00:00Z',role='miyue')=>store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)').run(id,role,speaker,text,'chat',at);
  t.after(async()=>{await memory.stop();store.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {store,prefs,repo,memory,add,calls};
}

test('Shanghai daily slots and calendar boundaries use 02:00 and midnight',()=>{
  assert.equal(dailyCompressionSlot('2026-09-30T17:59:59Z'),'2026-09-29T18:00:00.000Z');
  assert.equal(dailyCompressionSlot('2026-09-30T18:00:00Z'),'2026-09-30T18:00:00.000Z');
  assert.equal(shanghaiDayStart('2026-09-30T15:59:59Z'),'2026-09-29T16:00:00.000Z');
  assert.equal(shanghaiDayStart('2026-09-30T16:00:00Z'),'2026-09-30T16:00:00.000Z');
  assert.equal(dailyCompressionSlot('2026-09-30T23:31:00Z','07:30'),'2026-09-30T23:30:00.000Z');
});
test('core context derives Shanghai sending time from original messages without treating a future plan as execution',async t=>{
  const f=fixture(t,{complete:(_messages,options)=>options.purpose==='daily-compression-review'?{ok:true,issues:[]}:
    {items:[{kind:'event',status:'planned',text:'角色提议2026-09-29晚上沿平江路散步，用户后来接受；没有执行结果。',evidence:['s1','s2']}],omitted:[]}});
  f.add('proposal','今晚要不要沿平江路散步？','assistant','2026-09-29T00:05:00Z');
  f.add('acceptance','可以，晚上去。','user','2026-09-29T00:10:00Z');
  assert.equal((await f.memory.run()).status,'updated');
  const core=f.memory.context('miyue');assert.match(core,/发送08:05~08:10/);assert.match(core,/2026-09-29晚上/);assert.match(core,/不是事件执行时间/);
  assert.equal(f.store.db.prepare('SELECT text FROM messages WHERE id=?').get('proposal').text,'今晚要不要沿平江路散步？');
});
test('daily mode migrates raw window to one day and validates settings atomically',t=>{
  const f=fixture(t);assert.equal(f.prefs.getHistoryWindow().historyWindowDays,1);
  assert.equal(f.memory.settings().time,'02:00');assert.equal(f.memory.settings().rawMode,'calendar-day');
  assert.throws(()=>f.memory.configure({enabled:false,time:'25:00'}));assert.equal(f.memory.settings().enabled,true);
  for(const time of ['01:59','12:00','22:30'])assert.throws(()=>f.memory.configure({enabled:false,time}));
  assert.equal(f.memory.settings().enabled,true);
  f.memory.configure({time:'07:30'});assert.equal(f.memory.settings().time,'07:30');
});
test('program calls configured model for extraction and quality check once per slot',async t=>{
  const f=fixture(t);f.add('old','明天15点看牙，结果还不知道。');f.add('new','刚到家。','user','2026-09-30T14:00:00Z');
  const result=await f.memory.run();assert.equal(result.status,'updated');assert.equal(result.sourceCount,1);
  assert.deepEqual(f.calls.map(c=>c.options.purpose),['daily-compression','daily-compression-review']);
  assert.equal((await f.memory.run()).reason,'scheduled');assert.equal(f.calls.length,2);
  assert.equal(f.memory.history('miyue').rows.length,1);assert.match(f.memory.context('miyue'),/15点看牙/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM messages').get().n,2);
});
test('context-only omission labels never replace coverage of the current batch',async t=>{
  const f=fixture(t,{complete:(messages,options)=>options.purpose==='daily-compression-review'?{ok:true,issues:[],omitted:[{id:'c1',reason:'repeat'}]}:{items:[{kind:'event',status:'planned',text:'用户接受角色的周六散步建议。',evidence:['c1','s1']}],omitted:[{id:'c1',reason:'repeat'}]}});
  const context=[{id:'prior',speaker:'assistant',text:'周六散步吧。',kind:'chat',created_at:'2026-09-28T07:00:00Z'}];
  const rows=[{id:'current',speaker:'user',text:'好，周六散步。',kind:'chat',created_at:'2026-09-28T08:00:00Z'}];
  const result=await f.memory.compress('miyue',rows,AbortSignal.timeout(1000),context);
  assert.equal(result.items[0].subject,'shared');assert.deepEqual(result.omitted,[]);assert.equal(f.calls.length,2);
  assert.throws(()=>f.memory.validate({items:[],omitted:[{id:'s9',reason:'repeat'}]},rows,context),/省略原因或来源无效/);
});
test('calendar raw window excludes yesterday even when it is within the last 24 hours',async t=>{
  const f=fixture(t);f.add('edge','边界处原文。','user',new Date(+NOW-86400000).toISOString());f.add('fresh','这一小时原文。','user',new Date(+NOW-3600000).toISOString());
  assert.deepEqual(f.memory.history('miyue').rows.map(r=>r.id),['fresh']);
  assert.deepEqual(f.memory.pending('miyue').map(r=>r.id),['edge']);
  await f.memory.run();assert.deepEqual(f.memory.history('miyue').rows.map(r=>r.id),['fresh']);
  assert.match(f.memory.context('miyue'),/边界处原文/);
});
test('compression retains multiple events, numbers, ownership and original absolute dates',async t=>{
  const f=fixture(t,{complete:(messages,options)=>options.purpose==='daily-compression-review'?{ok:true,issues:[]}:{items:[
    {subject:'user',kind:'event',status:'planned',text:'用户计划2026-09-29下午15点看牙，结果未知。',evidence:[{id:'s1',quote:'明天下午15点看牙'}]},
    {subject:'user',kind:'preference',status:'unknown',text:'用户预算240元，偏好墨绿。',evidence:[{id:'s1',quote:'预算240元，偏好墨绿'}]},
    {subject:'character',kind:'view',status:'unknown',text:'角色提出灰蓝封面。',evidence:[{id:'s2',quote:'我提出灰蓝封面'}]},
  ],omitted:[]}});
  f.add('u','明天下午15点看牙；预算240元，偏好墨绿。');f.add('a','我提出灰蓝封面。','assistant');
  assert.equal((await f.memory.run()).status,'updated');
  const context=f.memory.context('miyue');assert.match(context,/2026-09-29下午15点/);assert.match(context,/240元/);assert.match(context,/character\/view/);
  assert.equal(JSON.parse(f.calls[0].messages[1].content).conversation[0].dateContext.明天,'2026-09-29');
});
test('missing coverage and invented quote keep stored originals; the morning interaction proceeds degraded',async t=>{
  for(const type of ['coverage','quote']){
    const f=fixture(t,{complete:(messages,options)=>{if(options.purpose==='daily-compression-review')return {ok:true,issues:[]};const v=extract(messages);if(type==='coverage')v.items=[];if(type==='quote')v.items[0].evidence[0].quote='不存在的内容';return v;}});
    f.add('old','用户自己的重要事实。');assert.equal((await f.memory.run()).status,'failed');
    assert.equal(f.memory.snapshot().sourceMessages,0);assert.equal(f.store.getMessages('miyue')[0].text,'用户自己的重要事实。');
    assert.equal(f.memory.history('miyue').rows.length,0);assert.equal(f.calls.length,type==='coverage'?6:3);
    const ready=await f.memory.ensureBeforeInteraction();assert.equal(ready.status,'degraded');assert.equal(ready.pending,1);
  }
});
test('an unreachable model does not use up the daily retry limit',async t=>{
  const f=fixture(t,{complete:()=>{throw Object.assign(new Error('offline'),{code:'MODEL_NETWORK_ERROR'});}});
  f.add('old','用户自己的重要事实。');const result=await f.memory.run();
  assert.equal(result.status,'failed');assert.equal(result.failedAttempts,0);
  assert.match(f.memory.snapshot().lastError,/连不上模型服务（第1次）.*15分钟/u);
});
test('source authors are computed by the program rather than chosen by the compressor',async t=>{
  const f=fixture(t,{complete:(messages,options)=>{if(options.purpose==='daily-compression-review')return {ok:true,issues:[]};const v=extract(messages);v.items[0].subject='character';return v;}});
  f.add('u','用户自己的偏好。');await f.memory.run();assert.equal(f.memory.chunks('miyue')[0].items[0].subject,'user');
  assert.throws(()=>f.memory.validate({items:[{subject:'character',kind:'view',status:'current',text:'用户自己的偏好。',evidence:['s1']}],omitted:[]},[f.memory.source('miyue','u')]),/作者归属/);
});
test('a text that assigns the character preference to the user is rejected and repaired before review',async t=>{
  const f=fixture(t,{complete:(messages,options)=>options.purpose==='daily-compression-review'?{ok:true,issues:[]}:messages[0].content.startsWith('你只修复')?{replace:[{index:0,item:{kind:'preference',status:'current',text:'角色喜欢灰蓝和留白。',evidence:['s1']}}],append:[],omitted:[]}:{items:[{kind:'preference',status:'current',text:'用户喜欢灰蓝和留白。',evidence:['s1']}],omitted:[]}});
  f.add('a','我喜欢灰蓝和留白。','assistant');assert.equal((await f.memory.run()).status,'updated');
  const item=f.memory.chunks('miyue')[0].items[0];assert.equal(item.subject,'character');assert.equal(item.text,'角色喜欢灰蓝和留白。');
  assert.deepEqual(f.calls.map(c=>c.options.purpose),['daily-compression','daily-compression','daily-compression-review']);
});
test('a stored core with a conflicting primary author is invalidated instead of entering a later prompt',async t=>{
  const f=fixture(t);f.add('a','我喜欢灰蓝。','assistant');await f.memory.run();
  const chunk=f.memory.chunks('miyue')[0];chunk.items[0].text='用户喜欢灰蓝。';
  f.store.db.prepare('UPDATE daily_dialogue_chunks SET payload=? WHERE id=?').run(JSON.stringify(chunk),chunk.id);
  assert.equal(f.memory.chunks('miyue').length,0);assert.equal(f.memory.requiredPending('miyue').length,1);
  assert.doesNotMatch(f.memory.context('miyue'),/用户喜欢灰蓝/);
});
test('semantic omissions reported by the model cause one repair and no unreviewed commit',async t=>{
  const f=fixture(t,{complete:(messages,options)=>options.purpose==='daily-compression-review'?{ok:false,issues:['s1遗漏数量240元']} : messages[0].content.startsWith('你只修复')?{replace:[],append:[],omitted:[]}:extract(messages)});
  f.add('old','预算240元。');assert.equal((await f.memory.run()).status,'failed');assert.equal(f.calls.length,6);assert.equal(f.memory.chunks('miyue').length,0);
  assert.equal((await f.memory.run()).reason,'backoff');
});
test('an inconsistent audit retries the audit format without rewriting correct core records',async t=>{
  let audits=0;const f=fixture(t,{complete:(messages,options)=>options.purpose==='daily-compression-review'?++audits===1?{ok:false,issues:[]}:{ok:true,issues:[]}:extract(messages)});
  f.add('u','预算240元，下雨取消。');assert.equal((await f.memory.run()).status,'updated');
  assert.deepEqual(f.calls.map(c=>c.options.purpose),['daily-compression','daily-compression-review','daily-compression-review']);
  assert.match(f.calls[2].messages.at(-1).content,/核对格式修复/);assert.equal(f.memory.chunks('miyue')[0].review.ok,true);
});
test('too many audit observations require a corrected audit and never bypass a real omission',async t=>{
  let audits=0;const f=fixture(t,{complete:(messages,options)=>options.purpose==='daily-compression-review'?{ok:false,issues:++audits===1?Array.from({length:5},()=> 's1需要核对'):['s1遗漏240元']}:messages[0].content.startsWith('你只修复')?{replace:[],append:[],omitted:[]}:extract(messages)});
  f.add('u','预算240元。');assert.equal((await f.memory.run()).status,'failed');assert.equal(f.memory.chunks('miyue').length,0);
  assert.equal(f.calls.filter(c=>c.options.purpose==='daily-compression').length,3);
});
test('a dense batch that fails semantic review is split into smaller reviewed batches',async t=>{
  const f=fixture(t,{complete:(messages,options)=>{
    const input=JSON.parse(messages[1].content);
    if(options.purpose==='daily-compression-review')return input.conversation.length>5?{ok:false,issues:['s1核心遗漏']}:{ok:true,issues:[]};
    return messages[0].content.startsWith('你只修复')?{replace:[],append:[],omitted:[]}:extract(messages);
  }});
  for(let i=0;i<10;i++)f.add(`dense-${i}`,`用户计划事项${i}。`);
  const result=await f.memory.run();assert.equal(result.status,'updated');assert.equal(result.sourceCount,10);assert.equal(result.batches,2);
  assert.equal(f.memory.chunks('miyue').length,2);assert.equal(f.memory.pending('miyue').length,0);
  assert.ok(f.memory.chunks('miyue').every(chunk=>chunk.review.ok===true&&chunk.sources.length===5));
});
test('manual failure after a completed slot still retries, with three failed runs per daily slot',async t=>{
  let reject=false;
  const f=fixture(t,{complete:(messages,options)=>options.purpose==='daily-compression-review'?{ok:!reject,issues:reject?['s1核心遗漏']:[]}:messages[0].content.startsWith('你只修复')?{replace:[],append:[],omitted:[]}:extract(messages)});
  await f.memory.run();f.add('retry-source','用户有未完成的计划。');reject=true;
  assert.equal((await f.memory.run('miyue',{force:true})).status,'failed');assert.equal((await f.memory.run()).reason,'backoff');
  for(let i=1;i<=2;i++){f.memory.clock=()=>new Date(+NOW+i*16*60_000);assert.equal((await f.memory.run()).failedAttempts,i+1);}
  f.memory.clock=()=>new Date(+NOW+48*60_000);const count=f.calls.length;
  assert.equal((await f.memory.run()).reason,'retry-limit');assert.equal(f.calls.length,count);assert.equal(f.memory.pending('miyue').length,1);
  reject=false;f.memory.clock=()=>new Date(+NOW+86400000);assert.equal((await f.memory.run()).status,'updated');assert.equal(f.memory.snapshot().failedAttempts,0);
});
test('manual partial work resumes automatically even after the daily slot had completed',async t=>{
  const f=fixture(t);await f.memory.run();
  for(let i=0;i<21;i++)f.add(`backfill-${i}`,`用户计划事项${i}。`);
  assert.equal((await f.memory.run('miyue',{force:true,maxBatches:1})).status,'partial');assert.equal(f.memory.pending('miyue').length,1);
  const resumed=await f.memory.run();assert.equal(resumed.status,'updated');assert.equal(resumed.sourceCount,1);
  assert.equal((await f.memory.run()).reason,'scheduled');
});
test('suppressed and edited sources invalidate compressed records and can be recompressed',async t=>{
  const hidden=[],f=fixture(t,{hidden});f.add('u','我的偏好是墨绿。');f.add('a','我喜欢蓝色。','assistant');
  await f.memory.run();assert.equal(f.memory.chunks('miyue').length,1);
  const edits=new HistoryEdits(f.store);f.repo.projectSource=row=>edits.project('miyue',[{...row,role:'miyue'}])[0]||null;
  edits.set('miyue',[{id:'a',sourceHash:historySourceHash('我喜欢蓝色。'),replacement:'我改为喜欢灰蓝。',reason:'更正'}]);
  assert.equal(f.memory.chunks('miyue').length,0);assert.doesNotMatch(f.memory.context('miyue'),/喜欢蓝色/);
  await f.memory.run('miyue',{force:true});assert.match(f.memory.context('miyue'),/灰蓝/);
  hidden.push('u');assert.equal(f.memory.chunks('miyue').length,0);assert.doesNotMatch(f.memory.context('miyue'),/墨绿/);
});
test('deleting a source removes daily summary and its stored evidence',async t=>{
  const f=fixture(t);f.add('u','需要完全删除的秘密。');await f.memory.run();
  new HistoryDeletion(f.store).delete('miyue',['u']);assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM daily_dialogue_chunks').get().n,0);
});
test('an edit during compression rejects the stale result',async t=>{
  let release;const hold=new Promise(resolve=>release=resolve);
  const f=fixture(t,{complete:async(messages,options)=>{await hold;return options.purpose==='daily-compression-review'?{ok:true,issues:[]}:extract(messages);}});
  f.add('u','原始事实。');const job=f.memory.run();while(!f.calls.length)await new Promise(r=>setImmediate(r));
  f.store.db.prepare('UPDATE messages SET text=? WHERE id=?').run('最新事实。','u');release();assert.equal((await job).status,'stale');assert.equal(f.memory.chunks('miyue').length,0);
});
test('adjacent context preserves an accepted proposal across a day boundary',async t=>{
  const f=fixture(t,{complete:(messages,options)=>{
    if(options.purpose==='daily-compression-review')return {ok:true,issues:[]};
    const input=JSON.parse(messages[1].content);
    return input.context.length?{items:[{subject:'shared',kind:'agreement',status:'planned',text:'角色提出周六去平江路，用户接受并要求下雨取消。',evidence:[{id:'c1',quote:'周六去平江路'}, {id:'s1',quote:'可以，但下雨就取消'}]}],omitted:[]}:extract(messages);
  }});
  f.add('a','周六去平江路。','assistant','2026-09-27T15:59:00Z');f.add('u','可以，但下雨就取消。','user','2026-09-27T16:01:00Z');
  assert.equal((await f.memory.run()).status,'updated');assert.match(f.memory.context('miyue'),/shared\/agreement\/planned/);
  f.store.db.prepare('UPDATE messages SET text=? WHERE id=?').run('改成去美术馆。','a');assert.equal(f.memory.chunks('miyue').length,0);
});

test('daily compression adjacent context follows sending time rather than insertion order',async t=>{
  const f=fixture(t,{complete:(messages,options)=>{
    if(options.purpose==='daily-compression-review')return {ok:true,issues:[]};
    const input=JSON.parse(messages[1].content);
    if(input.conversation[0].text==='后来的确认。')assert.deepEqual(input.context.map(m=>m.text),['较早的提议。']);
    return extract(messages);
  }});
  f.add('later','后来的确认。','user','2026-09-28T16:01:00Z');
  f.add('earlier','较早的提议。','assistant','2026-09-28T15:59:00Z');
  assert.equal((await f.memory.run()).status,'updated');
  assert.equal(f.memory.chunks('miyue').length,2);
});
test('new user activity during a batch defers its commit until an idle run',async t=>{
  const f=fixture(t,{complete:(messages,options)=>{if(options.purpose==='daily-compression-review'){f.memory.isBusy=()=>true;return {ok:true,issues:[]};}return extract(messages);}});
  f.add('u','不应打断新聊天。');assert.equal((await f.memory.run()).status,'partial');assert.equal(f.memory.chunks('miyue').length,0);
});
test('targeted semantic repair preserves already correct details',async t=>{
  let reviews=0;
  const f=fixture(t,{complete:(messages,options)=>{
    if(options.purpose==='daily-compression-review')return ++reviews===1?{ok:false,issues:['s1缺少预算240元']}:{ok:true,issues:[]};
    if(messages[0].content.startsWith('你只修复'))return {replace:[],append:[{kind:'fact',status:'current',text:'用户预算240元。',evidence:['s1']}],omitted:[]};
    return {items:[{kind:'event',status:'planned',text:'用户计划明天15点看牙。',evidence:['s1']}],omitted:[]};
  }});
  f.add('u','明天15点看牙，预算240元。');assert.equal((await f.memory.run()).status,'updated');
  const items=f.memory.chunks('miyue')[0].items;assert.equal(items.length,2);assert.match(items[0].text,/15点/);assert.match(items[1].text,/240元/);assert.equal(f.calls.length,4);
});
test('calendar window keeps a today answer to a yesterday question without importing the question',t=>{
  const f=fixture(t,{clock:()=>new Date('2026-09-30T18:01:00Z')});
  f.add('yesterday','我们周六去平江路？','user','2026-09-30T15:59:59Z');
  f.add('midnight','好，下雨取消。','assistant','2026-09-30T16:00:00Z');
  f.add('today','今天先休息。','user','2026-09-30T18:00:00Z');
  f.add('future','明天的原文不应出现。','user','2026-10-01T16:00:00Z');
  const history=f.memory.history('miyue');
  assert.deepEqual(history.rows.map(r=>[r.id,r.speaker]),[['midnight','assistant'],['today','user']]);
  assert.match(history.notice.content,/当日原文窗口/);assert.doesNotMatch(JSON.stringify(history),/我们周六去|明天的原文/);
  assert.deepEqual(f.memory.pending('miyue').map(r=>r.id),['yesterday']);
});
test('no automatic compression before 02:00, then first interaction compresses yesterday first',async t=>{
  let now=new Date('2026-09-30T17:59:59Z');const f=fixture(t,{clock:()=>now});
  f.add('yesterday','约定周六散步，下雨取消。','user','2026-09-30T15:50:00Z');
  assert.equal((await f.memory.run()).reason,'before-morning');
  assert.equal((await f.memory.ensureBeforeInteraction()).reason,'before-morning');assert.equal(f.calls.length,0);
  now=new Date('2026-09-30T18:00:00Z');f.memory.isBusy=()=>true;let waiting=0;
  assert.equal((await f.memory.ensureBeforeInteraction('miyue',{onWaiting:()=>waiting++})).status,'ready');
  assert.equal(waiting,1);assert.equal(f.calls.length,2);assert.equal(f.memory.snapshot().lastReadyDay,'2026-10-01');
  assert.match(f.memory.context('miyue'),/下雨取消/);assert.equal(f.memory.history('miyue').rows.length,0);
  await f.memory.ensureBeforeInteraction();assert.equal(f.calls.length,2);
});
test('late morning restart catches up and does not depend on an evening slot',async t=>{
  const f=fixture(t,{clock:()=>new Date('2026-10-01T01:30:00Z')});
  f.add('yesterday','昨晚确认预算240元。','user','2026-09-30T14:00:00Z');
  assert.equal((await f.memory.run()).status,'updated');assert.equal(f.calls.length,2);
  await f.memory.ensureBeforeInteraction();assert.equal(f.calls.length,2);
  assert.equal((await f.memory.run()).reason,'scheduled');
});
test('a later selected morning time never postpones the first interaction after 02:00',async t=>{
  const f=fixture(t,{clock:()=>new Date('2026-09-30T18:05:00Z')});
  f.memory.configure({time:'07:30'});f.add('old','昨晚确认了约定。','user','2026-09-30T15:00:00Z');
  assert.equal((await f.memory.run()).reason,'before-morning');
  assert.equal((await f.memory.ensureBeforeInteraction()).status,'ready');assert.equal(f.calls.length,2);
});
test('yesterday retry limits reset at 02:00 even when automatic compression is scheduled later',async t=>{
  let now=NOW,reject=true;const f=fixture(t,{clock:()=>now,complete:(messages,options)=>options.purpose==='daily-compression-review'?{ok:!reject,issues:reject?['s1遗漏核心']:[]}:messages[0].content.startsWith('你只修复')?{replace:[],append:[],omitted:[]}:extract(messages)});
  f.memory.configure({time:'07:30'});f.add('old','未完成的重要约定。');
  for(let i=0;i<3;i++)await f.memory.run('miyue',{force:true});assert.equal(f.memory.snapshot().failedAttempts,3);
  now=new Date('2026-09-30T18:05:00Z');reject=false;
  assert.equal((await f.memory.ensureBeforeInteraction()).status,'ready');assert.equal(f.memory.snapshot().failedAttempts,0);
  assert.equal(f.memory.snapshot().lastSlot,'2026-09-30T18:00:00.000Z');
});
test('interaction joins an in-progress background batch without duplicate compression',async t=>{
  let release;const hold=new Promise(resolve=>release=resolve);
  const f=fixture(t,{complete:async(messages,options)=>{await hold;return options.purpose==='daily-compression-review'?{ok:true,issues:[]}:extract(messages);}});
  f.add('old','未完成的安排。');const background=f.memory.run();
  while(!f.calls.length)await new Promise(r=>setImmediate(r));
  const interaction=f.memory.ensureBeforeInteraction();release();
  assert.equal((await background).status,'updated');assert.equal((await interaction).status,'ready');assert.equal(f.calls.length,2);
});
test('initial archive backfill does not block readiness, while new pending days never age out',async t=>{
  let now=NOW;const f=fixture(t,{clock:()=>now});
  f.add('archive','很久以前的资料。','user','2026-08-01T08:00:00Z');
  assert.equal((await f.memory.ensureBeforeInteraction()).status,'ready');assert.equal(f.calls.length,0);
  assert.equal(f.memory.snapshot().pendingMessages,1);assert.equal(f.memory.snapshot().requiredMessages,0);
  f.add('new-old','上线后尚未整理的约定。','user','2026-09-29T14:00:00Z');
  now=new Date('2026-10-15T02:00:00Z');
  assert.equal(f.memory.requiredPending('miyue').length,1);
  await f.memory.ensureBeforeInteraction();assert.equal(f.calls.length,2);assert.equal(f.memory.requiredPending('miyue').length,0);
  assert.equal(f.memory.pending('miyue').length,1);assert.equal(f.memory.snapshot().lastSlot,null);
});
test('former evening schedule migrates once and a selected morning schedule survives restart',t=>{
  const f=fixture(t);f.store.db.prepare("UPDATE daily_dialogue_settings SET time='22:30'").run();
  f.store.db.prepare("DELETE FROM metadata WHERE key='daily_dialogue_calendar_policy'").run();
  const restarted=new DailyDialogueMemory(f.store,{repo:f.repo,model:{},clock:()=>NOW});
  assert.equal(restarted.settings().time,'02:00');restarted.configure({time:'07:30'});
  const again=new DailyDialogueMemory(f.store,{repo:f.repo,model:{},clock:()=>NOW});assert.equal(again.settings().time,'07:30');
});
test('cancelling morning preparation never commits its interrupted draft or counts a model failure',async t=>{
  const f=fixture(t,{complete:async(_messages,options)=>new Promise((_,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}))});
  f.add('old','原文仍保存。');const control=new AbortController();
  const work=f.memory.ensureBeforeInteraction('miyue',{signal:control.signal});
  while(!f.calls.length)await new Promise(r=>setImmediate(r));control.abort();
  await assert.rejects(work,{name:'AbortError'});await Promise.allSettled([...f.memory.jobs.values()]);
  assert.equal(f.memory.chunks('miyue').length,0);assert.equal(f.memory.snapshot().failedAttempts,0);
  assert.equal(f.memory.requiredPending('miyue').length,1);
});
test('compact transport retains exact raw wording and speakers with much smaller metadata',()=>{
  const rows=Array.from({length:40},(_,i)=>({id:`00000000-0000-0000-0000-${String(i).padStart(12,'0')}`,speaker:i%2?'assistant':'user',text:`第${i}条完整原文。`,createdAt:'2026-09-30T02:00:00Z'}));
  const options={role:{id:'miyue',name:'林晓薇'},history:{rows},userText:'现在说什么？'};
  const normal=buildSessionMessages(options),compact=buildSessionMessages({...options,compactHistory:true});
  assert.ok(JSON.stringify(compact).length<JSON.stringify(normal).length*.8);
  const archive=JSON.parse(compact.find(m=>m.content.startsWith('【历史原文记录】')).content.split('\n').slice(1).join('\n'));
  assert.equal(archive[0].text,rows[0].text);assert.equal(archive[1].speaker,'assistant');assert.equal(archive[0].id,'h1');
});
test('HTTP mode uses daily core in chat and exposes scheduling controls',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'daily-api-')),calls=[];
  const app=await createApp({dataDir:dir,dailyCompression:true,sessionDialogue:true,dynamicCompanion:true,sessionGuidance:false,clock:()=>NOW,initialFeeds:[],activeRoleIds:['miyue'],disableStory:true,
    startWeixin:false,startRecall:false,startProactive:false,startResearch:false,startRuntime:false,startChatQueue:false,startLife:false,startDiscovery:false,startCharacterGrowth:false,startReminders:false,
    env:{LIFE_MODEL_BASE_URL:'https://model.example/v1',LIFE_MODEL_NAME:'fixture',LIFE_MODEL_API_KEY:'fixture'},fetchImpl:async(_url,init)=>{
      const body=JSON.parse(init.body);calls.push(body);const isReview=body.messages[0].content.startsWith('你核对原文');const isCompression=body.messages[0].content.startsWith('你将一天');
      const value=isReview?{ok:true,issues:[]}:isCompression?extract(body.messages):{reply:'记得，是你计划明天下午看牙，结果还没有告诉我。'};
      return Response.json({choices:[{message:{content:JSON.stringify(value)}}],usage:{prompt_tokens:10,completion_tokens:10}});
    }});
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});app.preferences.setReplyPace('instant');const address=await app.listen(0),url=`http://127.0.0.1:${address.port}`;
  app.store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)').run('old','miyue','user','我准备明天下午看牙。','chat','2026-09-28T08:00:00Z');
  const post=body=>({method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  assert.equal((await (await fetch(url+'/api/daily-memory/compress',post({}))).json()).status,'updated');
  assert.equal((await fetch(url+'/api/preferences',post({historyWindowDays:7}))).status,400);
  assert.equal((await fetch(url+'/api/daily-memory/settings',post({time:'07:30'}))).status,200);
  assert.equal((await fetch(url+'/api/chat',post({role:'miyue',text:'还记得看牙的安排吗？'}))).status,200);
  assert.match(JSON.stringify(calls.at(-1)),/按日压缩的历史核心记录/);
  const snapshot=await (await fetch(url+'/api/daily-memory?brief=1')).json();assert.equal(snapshot.chunks,undefined);assert.equal(snapshot.sourceMessages,1);
});

async function morningHTTP(t,{review=()=>true,holdCompression,sessionDialogue=true}={}){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'morning-api-')),stages=[];
  const app=await createApp({dataDir:dir,dailyCompression:true,sessionDialogue,dynamicCompanion:true,sessionGuidance:false,clock:()=>NOW,initialFeeds:[],activeRoleIds:['miyue'],disableStory:true,chatDebounceMs:600000,
    startWeixin:false,startRecall:false,startProactive:false,startResearch:false,startRuntime:false,startChatQueue:false,startLife:false,startDiscovery:false,startCharacterGrowth:false,startReminders:false,
    env:{LIFE_MODEL_BASE_URL:'https://model.example/v1',LIFE_MODEL_NAME:'fixture',LIFE_MODEL_API_KEY:'fixture'},fetchImpl:async(_url,init)=>{
      const body=JSON.parse(init.body),content=body.messages[0].content;
      const stage=content.startsWith('你核对原文')?'audit':content.startsWith('你将一天')||content.startsWith('你只修复')?'compress':'writer';stages.push(stage);
      if(stage==='compress'&&holdCompression)await holdCompression(init.signal);
      const value=stage==='audit'?{ok:review(),issues:review()?[]:['s1遗漏核心']}:stage==='compress'?content.startsWith('你只修复')?{replace:[],append:[],omitted:[]}:extract(body.messages):{reply:stages.filter(s=>s==='writer').length>1?'嗯，那就看明天天气。':'下雨就取消散步，这个约定记得。'};
      return Response.json({choices:[{message:{content:JSON.stringify(value)}}],usage:{prompt_tokens:10,completion_tokens:10}});
    }});
  app.preferences.setReplyPace('instant');const address=await app.listen(0),url=`http://127.0.0.1:${address.port}`;
  app.store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)').run('yesterday','miyue','user','我们约定周六散步，下雨取消。','chat','2026-09-29T14:00:00Z');
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const req=async(route,body)=>{const response=await fetch(url+route,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});return {status:response.status,...await response.json()};};
  return {app,stages,req};
}
test('first HTTP reply waits for extraction and audit; a second same-day reply reuses core',async t=>{
  const {app,stages,req}=await morningHTTP(t);
  assert.equal((await req('/api/chat',{role:'miyue',text:'昨天散步的约定呢？'})).status,200);
  assert.deepEqual(stages,['compress','audit','writer']);assert.equal(app.dailyMemory.requiredPending('miyue').length,0);
  assert.equal((await req('/api/chat',{role:'miyue',text:'好，知道了。'})).status,200);
  assert.deepEqual(stages,['compress','audit','writer','writer']);
});
test('proactive context also waits for morning preparation before reading calendar history',async t=>{
  const {app,stages}=await morningHTTP(t);
  const context=await app.proactive.getRoleContext('miyue');
  assert.deepEqual(stages,['compress','audit']);assert.equal(context.conversation.length,0);
  assert.match(`${context.sessionOptions.stableContext}\n${context.sessionOptions.recallContext}`,/下雨取消/);assert.equal(app.dailyMemory.requiredPending('miyue').length,0);
});
test('legacy dialogue fallback also performs morning preparation before generating',async t=>{
  const {app,stages,req}=await morningHTTP(t,{sessionDialogue:false});
  app.store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)').run('within24','miyue','assistant','角色昨晚的提议。','chat','2026-09-29T15:45:00Z');
  assert.equal((await req('/api/chat',{role:'miyue',text:'昨天的安排呢？'})).status,200);
  assert.deepEqual(stages.slice(0,3),['compress','audit','writer']);
  const context=app.roleContext('miyue',{sessionMode:false,text:'昨天的安排呢？'});
  assert.equal(context.dialogueHistory.rows.some(row=>row.id==='within24'),false);
  assert.match(context.dialogueHistory.notice.content,/当日原文窗口/);assert.match(`${context.stableContext||''}\n${context.recallContext||''}`,/按日压缩的历史核心记录/);
});
test('a failed morning preparation still answers the queued input once',async t=>{
  let approved=false;const {app,stages,req}=await morningHTTP(t,{review:()=>approved});
  await req('/api/chat/send',{role:'miyue',text:'昨天散步的约定呢？',clientId:'morning-first-001'});
  await app.chatQueue.run('miyue');
  assert.equal(app.chatQueue.get('miyue').phase,'idle');assert.equal(stages.filter(s=>s==='writer').length,1);
  assert.equal(app.store.getMessages('miyue').filter(r=>r.text==='昨天散步的约定呢？').length,1);
  approved=true;assert.equal((await req('/api/daily-memory/compress',{})).status,'updated');
  // Background repair afterwards does not answer the same input a second time.
  assert.equal(app.chatQueue.get('miyue').phase,'idle');assert.equal(stages.filter(s=>s==='writer').length,1);
});
test('queued cancellation during morning compression exposes its phase and never generates a reply',async t=>{
  const {app,stages,req}=await morningHTTP(t,{holdCompression:signal=>new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))});
  await req('/api/chat/send',{role:'miyue',text:'昨天散步的约定呢？',clientId:'morning-cancel-001'});
  const work=app.chatQueue.run('miyue');while(!stages.length)await new Promise(r=>setImmediate(r));
  assert.equal(app.chatQueue.get('miyue').phase,'compressing');assert.equal(app.chatQueue.busy('miyue'),true);
  await req('/api/chat/cancel',{role:'miyue'});await work;
  assert.equal(app.chatQueue.get('miyue').phase,'idle');assert.equal(stages.includes('writer'),false);
  assert.equal(app.dailyMemory.snapshot().sourceMessages,0);assert.equal(app.store.getMessages('miyue').length,1);
});
test('a persisted compressing queue resumes preparation on startup and saves the input only once',async t=>{
  const {app,stages,req}=await morningHTTP(t);
  await req('/api/chat/send',{role:'miyue',text:'昨天散步的约定呢？',clientId:'morning-restart-001'});
  app.store.db.prepare("UPDATE chat_queue SET state='compressing' WHERE role_id='miyue'").run();
  app.chatQueue.start();assert.equal(app.chatQueue.get('miyue').phase,'queued');
  await app.chatQueue.run('miyue');assert.equal(app.chatQueue.get('miyue').phase,'idle');
  assert.deepEqual(stages,['compress','audit','writer']);
  assert.equal(app.store.getMessages('miyue').filter(r=>r.text==='昨天散步的约定呢？').length,1);
});
test('a blocked interaction retries even after the automatic retry limit and backoff',async t=>{
  let reject=true;const f=fixture(t,{complete:(messages,options)=>options.purpose==='daily-compression-review'?{ok:!reject,issues:reject?['s1遗漏核心']:[]}:messages[0].content.startsWith('你只修复')?{replace:[],append:[],omitted:[]}:extract(messages)});
  f.add('old','未完成的重要约定。');
  for(let i=0;i<3;i++)await f.memory.run('miyue',{force:true});assert.equal(f.memory.snapshot().failedAttempts,3);
  reject=false;
  assert.equal((await f.memory.ensureBeforeInteraction()).status,'ready');assert.equal(f.memory.snapshot().failedAttempts,0);
});
test('a pruned record disappears from every context but keeps the other records at their index',async t=>{
  const f=fixture(t,{complete:(_messages,options)=>options.purpose==='daily-compression-review'?{ok:true,issues:[]}:
    {items:[{kind:'preference',status:'current',text:'角色晚饭又想煮汤面。',evidence:['s1']},{kind:'preference',status:'current',text:'用户喜欢山塘街坐船听曲。',evidence:['s2']}],omitted:[]}});
  f.add('soup','晚上煮汤面吧','assistant','2026-09-29T10:00:00Z');f.add('boat','想去山塘街坐船听曲','user','2026-09-29T10:05:00Z');
  assert.equal((await f.memory.run()).status,'updated');
  const [chunk]=f.memory.chunks('miyue');
  ensurePruneTable(f.store.db);
  f.store.db.prepare('INSERT INTO history_prunes VALUES(?,?,?,?,?)').run('miyue','daily_item',dailyItemRef(chunk.id,0),'her-routine',NOW.toISOString());
  const [pruned]=f.memory.chunks('miyue');
  assert.equal(pruned.items[0],undefined);assert.match(pruned.items[1].text,/山塘街/,'the next record keeps index 1');
  const stable=f.memory.context('miyue',{mode:'stable'});
  assert.doesNotMatch(stable,/汤面/);assert.match(stable,/山塘街/);
  assert.equal(f.memory.context('miyue',{mode:'query',query:'汤面'}),'');
  assert.ok(f.memory.snapshot('miyue').chunks[0].items.every(Boolean),'the diagnostics view has no holes');
  f.store.db.prepare('DELETE FROM history_prunes').run();
  assert.match(f.memory.context('miyue',{mode:'stable'}),/汤面/,'removing the prune restores it');
});
