import { RecallRepository } from '../lib/recall.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { HybridRecall } from '../lib/hybrid-recall.mjs';
import { collectConversationMemory } from '../lib/conversation-memory.mjs';
import { CharacterGrowth } from '../lib/character-growth.mjs';
import { HistoryDeletion } from '../lib/history-deletion.mjs';
import { exportSession, forkSession, restoreSession, isolatedOptions } from '../lib/session-snapshot.mjs';
import { sessionReviewEvidence } from '../lib/session-history.mjs';
import { buildSessionMessages } from '../lib/session-dialogue.mjs';
import { SegmentedSpeech, splitSpeech } from '../lib/segmented-speech.mjs';
import { importHistoricalMessages } from './support/history-fixtures.mjs';
const NOW=new Date('2026-09-25T02:00:00Z');
function fixture(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'companion-upgrade-'));const store=new Store({dataDir:dir,clock:()=>NOW,story:{start:'x',nodes:{x:{id:'x',choices:[]}}}});new RecallRepository(store,{clock:()=>NOW});t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});return {dir,store};}
const memoryInput=store=>({store,scope:'miyue',now:NOW,recallRepo:{consolidated:{snapshot:()=>({items:[]})}},episodes:{suppressedSourceIds:()=>[],list:()=>[]},historyEdits:{project:(_role,rows)=>rows}});

test('full-history recall finds an original before the former 2000-message boundary with its author',async t=>{
  const {store}=fixture(t);
  store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)').run('old','miyue','assistant','我更喜欢树莓色的书封设计。','chat','2026-07-01T00:00:00Z');
  const insert=store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)');store.transaction(()=>{for(let i=0;i<2010;i++)insert.run(`m${i}`,'miyue',i%2?'assistant':'user','无关的天气闲聊','chat','2026-08-01T00:00:00Z');});
  const candidates=collectConversationMemory(memoryInput(store));assert.equal(candidates.length,2011);
  const result=await new HybridRecall(store).search({roleId:'miyue',candidates,query:'树莓色书封',now:NOW});
  assert.ok(result.selected.some(i=>i.sourceIds.includes('old')&&i.subject==='character'));
});

test('vector retrieval uses actual cosine ranking and never returns a stale or hidden candidate',async t=>{
  const {store}=fixture(t);const embed=async texts=>texts.map(text=>text.includes('猫')||text.includes('毛茸茸')?[1,0]:[0,1]);
  const recall=new HybridRecall(store,{embed,embeddingModel:'test-vector'});
  const cat={id:'raw:cat',kind:'raw',subject:'character',text:'我很喜欢猫。',sourceIds:['cat'],at:NOW.toISOString()};
  const result=await recall.search({roleId:'miyue',candidates:[cat,{...cat,id:'raw:book',text:'读书',sourceIds:['book']}],query:'毛茸茸的小伙伴',now:NOW});
  assert.equal(result.retrieval.status,'hybrid-vector');assert.ok(result.selected.some(i=>i.id==='raw:cat'));
  const removed=await recall.search({roleId:'miyue',candidates:[],query:'毛茸茸的小伙伴',now:NOW});assert.equal(removed.selected.length,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM recall_vectors').get().n,0);
  const corrected=await recall.search({roleId:'miyue',candidates:[{...cat,text:'我现在偏好读书。'}],query:'毛茸茸的小伙伴',now:NOW});assert.equal(corrected.selected.length,0);
});

test('semantic query expansion retrieves paraphrases as source evidence and degrades safely when unavailable',async t=>{
  const {store}=fixture(t);const candidates=[{id:'raw:design',kind:'raw',subject:'user',text:'客户评审里，我的版式留白被挑出来了。',sourceIds:['design'],at:NOW.toISOString()}];
  const model={complete:async()=>JSON.stringify({queries:['版式 留白 评审']})};
  const result=await new HybridRecall(store,{model,semantic:true}).search({roleId:'miyue',candidates,query:'以前老板挑毛病那次',now:NOW});assert.equal(result.selected[0].id,'raw:design');
  model.complete=async()=>{throw new Error('down');};const fallback=await new HybridRecall(store,{model,semantic:true}).search({roleId:'miyue',candidates,query:'版式',now:NOW});assert.equal(fallback.retrieval.status,'query-unavailable');assert.equal(fallback.selected[0].id,'raw:design');
});

test('review evidence preserves both authors, source IDs and event metadata without impersonating the reviewer',()=>{
  const history=[{id:'u1',speaker:'user',text:'我喜欢大红色。'},{id:'a1',speaker:'assistant',text:'我更喜欢灰蓝色。',kind:'proactive'}];
  const messages=buildSessionMessages({role:{id:'miyue',name:'林晓薇'},history:{rows:history},userText:'灰蓝色是谁说的？',trigger:{type:'user_message'}});
  assert.deepEqual(messages.filter(m=>m.role==='assistant').map(m=>m.content),['我更喜欢灰蓝色。']);
  const evidence=sessionReviewEvidence(messages);assert.equal(evidence.filter(m=>m.role==='assistant').length,0);
  assert.ok(evidence.some(m=>m.content.includes('【历史原话｜角色本人】')&&m.content.includes('灰蓝色')));
  assert.ok(evidence.some(m=>m.content.includes('"id":"a1"')&&m.content.includes('"authorId":"miyue"')));
  assert.deepEqual(evidence.filter(m=>m.role==='user'),[{role:'user',content:'灰蓝色是谁说的？'}]);
});

test('reflection persists independently grounded tendencies and excludes user preferences and invented evidence',async t=>{
  const {store}=fixture(t);let replies=[];const growth=new CharacterGrowth(store,{model:{complete:async()=>JSON.stringify(replies.shift())},clock:()=>NOW});
  const rows=store.saveChatTurn({role:'miyue',text:'我喜欢亮红色。',reply:'我更喜欢灰蓝色，留白会让我觉得轻松。'});
  const proof={messageId:rows[1].id,speaker:'林晓薇本人',quote:'我更喜欢灰蓝色'};
  replies.push({diary:'我想继续试试灰蓝色的设计。',evidence:[proof],items:[{id:'blue',kind:'interest',scope:'enduring',text:'偏好灰蓝色设计',evidence:[proof]},{id:'red',kind:'interest',scope:'enduring',text:'偏好亮红色',evidence:[{messageId:rows[0].id,speaker:'user',quote:'我喜欢亮红色'}]}]});
  const result=await growth.reflect('miyue',{force:true});assert.equal(result.status,'recorded');assert.ok(result.rejected.includes('red'));assert.equal(growth.get().items[0].tier,'emerging');assert.equal(growth.context(),'');
  const next=store.saveChatTurn({role:'miyue',text:'你又在画什么？',reply:'我还是喜欢灰蓝色，想画一张书封。'});const second={messageId:next[1].id,speaker:'assistant',quote:'还是喜欢灰蓝色'};
  replies.push({diary:'',evidence:[],items:[{id:'blue',kind:'interest',scope:'enduring',text:'偏好灰蓝色设计',evidence:[second]}]});await growth.reflect('miyue',{force:true});assert.equal(growth.get().items[0].tier,'emerging');assert.deepEqual(growth.get().items[0].support,{turns:2,days:1});
  new HistoryDeletion(store).delete('miyue',[rows[1].id]);assert.equal(growth.get().items.length,0);assert.equal(growth.get().reflections.length,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM character_reflections').get().n,0);
});

test('growth requires different user-initiated days and excludes repeated proactive, desktop and transient scenes',async t=>{
  const {store}=fixture(t);let response,now=NOW;
  const growth=new CharacterGrowth(store,{clock:()=>now,model:{complete:async()=>JSON.stringify(response)}});
  const initial=store.saveChatTurn({role:'miyue',text:'你喜欢什么配色？',reply:'我偏好灰蓝色。'});
  const proof=row=>({messageId:row.id,speaker:'assistant',quote:'灰蓝色'});
  const item=(evidence,scope='enduring')=>({id:'blue',kind:'interest',scope,text:'偏好灰蓝色',evidence});
  response={diary:'',evidence:[],items:[item([proof(initial[1])])]};await growth.reflect('miyue',{force:true});
  now=new Date(+NOW+86400000);const insert=store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)');
  importHistoricalMessages(store,()=>{
    insert.run('proactive-next','miyue','assistant','我又想到灰蓝色。','proactive',now.toISOString());
    insert.run('desktop-next','miyue','assistant','灰蓝色还是很好看。','chat',now.toISOString());
  });
  response={diary:'',evidence:[],items:[item([proof({id:'proactive-next'}),proof({id:'desktop-next'})])]};await growth.reflect('miyue',{force:true});
  assert.equal(growth.get().items[0].tier,'emerging');assert.equal(growth.get().items[0].support.days,1);
  insert.run('new-user','miyue','user','今天想聊书封配色。','chat',now.toISOString());insert.run('new-reply','miyue','assistant','我偏好灰蓝色。','chat',now.toISOString());
  response={diary:'',evidence:[],items:[item([proof({id:'new-reply'})])]};await growth.reflect('miyue',{force:true});
  assert.equal(growth.get().items[0].tier,'stable');assert.equal(growth.get().items[0].support.days,2);
  assert.match(growth.context(),/灰蓝色/);assert.doesNotMatch(growth.context(),/evidence|quote|reflections/);
  insert.run('scene-user','miyue','user','今天先暖一暖手。','chat',now.toISOString());insert.run('scene-reply','miyue','assistant','灰蓝色的杯子暖着手。','chat',now.toISOString());
  response={diary:'',evidence:[],items:[item([proof({id:'scene-reply'})],'session')]};await growth.reflect('miyue',{force:true});
  assert.equal(growth.get().items[0].scope,'session');assert.equal(growth.get().items[0].evidence.length,1);assert.equal(growth.context(),'');
});

test('legacy stable claims are demoted until model scope reassessment and evidence edits invalidate its result',async t=>{
  const {store}=fixture(t);const rows=store.saveChatTurn({role:'miyue',text:'随便聊聊。',reply:'今天我想慢一点，手指有点凉。'});
  const legacy={id:'slow',kind:'habit',text:'聊天时总要慢一点',tier:'stable',at:NOW.toISOString(),evidence:[{messageId:rows[1].id,speaker:'assistant',quote:'今天我想慢一点'}]};
  let edit=false;
  const growth=new CharacterGrowth(store,{clock:()=>NOW,model:{complete:async()=>{
    if(edit)store.db.prepare('UPDATE messages SET text=? WHERE id=?').run('已更正。',rows[1].id);
    return JSON.stringify({items:[{id:'slow',scope:'session'}]});
  }}});
  store.db.prepare('INSERT INTO character_growth_items VALUES(?,?,?)').run('miyue',legacy.id,JSON.stringify(legacy));
  store.db.prepare('INSERT INTO character_growth_state(role_id) VALUES(?)').run('miyue');
  assert.equal(growth.get().items[0].tier,'emerging');assert.equal(growth.context(),'');
  edit=true;assert.equal((await growth.reassess()).status,'stale');assert.equal(growth.state().revision,0);
  store.db.prepare('UPDATE messages SET text=? WHERE id=?').run(rows[1].text,rows[1].id);edit=false;
  assert.equal((await growth.reassess()).status,'classified');assert.equal(growth.get().items[0].scope,'session');assert.equal(growth.context(),'');
});

test('a source edited during reflection cannot commit the old diary',async t=>{
  const {store}=fixture(t);const rows=store.saveChatTurn({role:'miyue',text:'聊一聊配色。',reply:'我喜欢灰蓝色。'});
  const growth=new CharacterGrowth(store,{clock:()=>NOW,model:{complete:async()=>{store.db.prepare('UPDATE messages SET text=? WHERE id=?').run('这句话已被更正。',rows[1].id);return JSON.stringify({diary:'我喜欢灰蓝色。',evidence:[{messageId:rows[1].id,speaker:'assistant',quote:'灰蓝色'}],items:[]});}}});
  assert.equal((await growth.reflect('miyue',{force:true})).status,'stale');assert.equal(growth.get().reflections.length,0);
});

test('snapshot export/import and SQLite forks preserve independent state and strip external credentials',async t=>{
  const {store,dir}=fixture(t);store.saveChatTurn({role:'miyue',text:'原来的对话',reply:'独立的历史'});
  store.db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run('weixin_bridge_v1','SECRET');
  store.db.exec(`CREATE TABLE reply_delivery(id TEXT PRIMARY KEY,text TEXT);INSERT INTO reply_delivery VALUES('pending','尚未投递')`);
  const snapshot=exportSession(store,{clock:()=>NOW});assert.equal(JSON.stringify(snapshot).includes('SECRET'),false);assert.equal(snapshot.tables.reply_delivery.length,0);
  const imported=path.join(dir,'imported'),forked=path.join(dir,'forked');restoreSession(snapshot,imported);
  await forkSession(store,{targetDir:forked,provider:{model:'test',baseUrl:'https://example.test',apiKey:'private-key'}});
  const branch=new Store({dataDir:forked,clock:()=>NOW,story:store.story});t.after(()=>branch.close());
  branch.saveChatTurn({role:'miyue',text:'仅分支修改',reply:'不会回写'});assert.equal(store.getMessages('miyue').length,2);assert.equal(branch.getMessages('miyue').length,4);assert.equal(branch.db.prepare('SELECT COUNT(*) n FROM reply_delivery').get().n,0);
  assert.equal(branch.db.prepare('SELECT value FROM metadata WHERE key=?').get('weixin_bridge_v1'),undefined);
  assert.equal(isolatedOptions(forked).startWeixin,false);assert.equal(isolatedOptions(forked).startReminders,false);
  assert.equal(fs.statSync(path.join(forked,'provider.json')).mode&0o777,0o600);
});

test('segmented speech starts only two jobs, preserves text and cancels every in-flight job',async()=>{
  const text='先说这句话。'.repeat(70),chunks=splitSpeech(text);assert.equal(chunks.join(''),text);assert.ok(chunks[0].length<=100);
  let seq=0;const started=[],closed=[];const integrations={startSpeech:async value=>{const jobId=`job-${seq++}`;started.push(value);return {jobId};},readSpeechStatus:async()=>({state:'finished'}),closeSpeech:async id=>{closed.push(id);},getSpeechAudio:async()=>({body:Buffer.from('audio'),contentType:'audio/wav'})};
  const speech=new SegmentedSpeech(integrations);try{
    const {sessionId}=speech.start({id:'a1',role:'miyue',text});await new Promise(resolve=>setImmediate(resolve));assert.equal(started.length,2);
    await speech.status(sessionId);assert.equal((await speech.audio(sessionId,0)).body.toString(),'audio');await speech.advance(sessionId,0);await new Promise(resolve=>setImmediate(resolve));assert.equal(started.length,3);
    await speech.close(sessionId);assert.ok(closed.includes('job-0')&&closed.includes('job-1')&&closed.includes('job-2'));assert.equal(speech.sessions.size,0);
  }finally{await speech.stop();}
});

test('voice cancellation while a segment is starting closes its late job and rejects deleted source audio',async()=>{
  let release,closed=[];let visible=true;const integrations={startSpeech:()=>new Promise(resolve=>release=resolve),closeSpeech:async id=>closed.push(id),readSpeechStatus:async()=>({state:'finished'}),getSpeechAudio:async()=>({body:Buffer.from('x')})};
  const speech=new SegmentedSpeech(integrations,{isVisible:()=>visible});try{
    const {sessionId}=speech.start({id:'a1',text:'很短的一句话。'});const closing=speech.close(sessionId);release({jobId:'late'});await closing;assert.ok(closed.includes('late'));
    integrations.startSpeech=async()=>({jobId:'new'});const next=speech.start({id:'a2',text:'另一句话。'});await new Promise(resolve=>setImmediate(resolve));visible=false;await assert.rejects(speech.status(next.sessionId),/原消息已删除/);assert.ok(closed.includes('new'));
  }finally{await speech.stop();}
});


test('empty diary evidence and a user first-person preference cannot become character growth',async t=>{
  const {store}=fixture(t);const rows=store.saveChatTurn({role:'miyue',text:'我喜欢红色。',reply:'我们可以有不同的偏好。'});
  const growth=new CharacterGrowth(store,{clock:()=>NOW,model:{complete:async()=>JSON.stringify({diary:'我喜欢红色。',evidence:[],items:[{id:'red',kind:'interest',text:'喜欢红色',evidence:[{messageId:rows[0].id,quote:'我喜欢红色',speaker:'assistant'}]}]})}});
  const result=await growth.reflect('miyue',{force:true});assert.equal(result.accepted.length,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM character_reflections').get().n,0);assert.equal(growth.get().items.length,0);
});

test('an embedding completed after source deletion neither resurrects a vector nor returns it',async t=>{
  const {store}=fixture(t);let candidates=[{id:'raw:gone',kind:'raw',subject:'character',text:'我喜欢猫。',sourceIds:['gone'],at:NOW.toISOString()}];
  const recall=new HybridRecall(store,{embeddingModel:'test-vector',getCandidates:()=>candidates,embed:async texts=>{candidates=[];return texts.map(()=>[1,0]);}});
  const result=await recall.search({roleId:'miyue',candidates,query:'毛茸茸',now:NOW});assert.equal(result.selected.length,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM recall_vectors').get().n,0);
});
