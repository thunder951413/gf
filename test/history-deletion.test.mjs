import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createApp} from '../server.mjs';
import {historySourceHash} from '../lib/history-edits.mjs';

async function fixture(t){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'history-deletion-')),calls=[];
  const app=await createApp({dataDir,activeRoleIds:['miyue'],initialFeeds:[],disableStory:true,sessionDialogue:true,sessionGuidance:false,dynamicCompanion:true,
    startProactive:false,startRecall:false,startResearch:false,startDossiers:false,startLife:false,startLifeThreads:false,startRuntime:false,startDailyLife:false,startPursuits:false,startDiscovery:false,startWeixin:false,startChatQueue:false,
    clock:()=>new Date('2026-09-28T03:00:00Z'),replySleep:async()=>{},
    env:{LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture'},fetchImpl:async(_url,init)=>{calls.push(JSON.parse(init.body));return Response.json({choices:[{message:{content:JSON.stringify({reply:'我们可以接着聊你现在的想法。'})}}]});}});
  app.preferences.setReplyPace('instant');const {port}=await app.listen(0);
  t.after(async()=>{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  const req=async(route,body)=>{const r=await fetch(`http://127.0.0.1:${port}${route}`,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});return {status:r.status,body:await r.json()};};
  return {app,req,calls,dataDir};
}

test('hard deletion removes transcript and directly derived memories, preserves unrelated data, and excludes text from later prompts',async t=>{
  const {app,req,calls}=await fixture(t),db=app.store.db;
  const removed=app.store.saveChatTurn({role:'miyue',text:'删除标记：蓝色沙漏在天台。',reply:'删除标记：我会记住蓝色沙漏。'});
  const retained=app.store.saveChatTurn({role:'miyue',text:'保留标记：我喜欢阅读。',reply:'可以一起聊阅读。'});
  app.store.addMemory('miyue','独立填写的记忆');
  app.episodes.remember('miyue',removed.map(row=>row.id));
  app.episodes.remember('miyue',retained.map(row=>row.id));
  app.historyEdits.set('miyue',[{id:removed[1].id,sourceHash:historySourceHash(removed[1].text),replacement:'修订标记：另一份要删除的文本。',reason:'修订'}]);
  db.prepare("UPDATE recall_state SET summary='删除标记：旧自动摘要',summary_origin='automatic' WHERE role_id='miyue'").run();
  const memory={id:'erase-memory',scope:'miyue',subject:'user',kind:'fact',topic:'沙漏',summary:'删除标记：蓝色沙漏',status:'current',evidence:JSON.stringify([{messageId:removed[0].id,quote:removed[0].text}])};
  db.prepare('INSERT INTO consolidated_memories(id,scope,subject,kind,topic,summary,status,evidence_json,first_at,last_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(memory.id,memory.scope,memory.subject,memory.kind,memory.topic,memory.summary,memory.status,memory.evidence,removed[0].createdAt,removed[0].createdAt);
  db.prepare('INSERT INTO proactive_material_deliveries VALUES(?,?,?,?,?,?,?)').run(removed[1].id,'miyue','book','reading',removed[1].text,JSON.stringify({detail:removed[1].text}),removed[1].createdAt);
  const revision=app.historyEdits.revision('miyue');
  const result=await req('/api/chat/history/delete',{role:'miyue',ids:removed.map(row=>row.id)});
  assert.equal(result.status,200,JSON.stringify(result.body));assert.equal(result.body.count,2);
  for(const row of removed)assert.equal(app.store.getMessage(row.id),null);
  assert.equal(app.store.getMessages('miyue').length,2);assert.equal(app.store.listMemories('miyue').length,1);
  assert.equal(db.prepare('SELECT count(*) n FROM consolidated_memories WHERE id=?').get(memory.id).n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM proactive_material_deliveries').get().n,0);
  assert.equal(app.historyEdits.list('miyue').length,0);assert.ok(app.historyEdits.revision('miyue')>revision);
  assert.equal(db.prepare("SELECT count(*) n FROM episodic_memory_quotes WHERE text LIKE '%删除标记%'").get().n,0);
  assert.ok(db.prepare("SELECT count(*) n FROM episodic_memory_quotes WHERE text LIKE '%保留标记%'").get().n>0);
  assert.equal((await req('/api/chat',{role:'miyue',text:'聊聊近况吧。'})).status,200);
  const prompt=JSON.stringify(calls.at(-1).messages);assert.doesNotMatch(prompt,/删除标记|修订标记/);assert.match(prompt,/保留标记/);
  assert.equal((await req('/api/history-corrections/restore',{ids:[removed[1].id]})).body.count,0);
});

test('history pagination includes hidden originals and rejects invalid/cross-role batches atomically',async t=>{
  const {app,req}=await fixture(t);
  const rows=app.store.saveChatTurn({role:'miyue',text:'第一页用户',reply:'第一页助手'});
  app.historyEdits.set('miyue',[{id:rows[1].id,sourceHash:historySourceHash(rows[1].text),replacement:'',reason:'原先隐藏'}]);
  const other=app.store.saveChatTurn({role:'wenxi',text:'另一个角色',reply:'保留'});
  let response=await req('/api/chat/history?role=miyue&limit=1');assert.equal(response.status,200);assert.equal(response.body.messages[0].text,rows[1].text);
  response=await req('/api/chat/history?role=miyue&limit=1&before='+response.body.nextBefore);assert.equal(response.body.messages[0].id,rows[0].id);assert.equal(response.body.nextBefore,null);
  for(const ids of [[],[rows[0].id,rows[0].id],[rows[0].id,other[0].id],[rows[0].id,'missing']]){
    response=await req('/api/chat/history/delete',{role:'miyue',ids});assert.ok(response.status>=400);assert.ok(app.store.getMessage(rows[0].id));
  }
  assert.equal((await req('/api/chat/history?role=miyue&before=-1')).status,400);
});

test('deleting latest messages never reuses durable rowids, including from another connection',async t=>{
  const {app,dataDir}=await fixture(t),db=app.store.db;
  const rows=app.store.saveChatTurn({role:'miyue',text:'旧一',reply:'旧二'});
  const floor=db.prepare('SELECT max(rowid) n FROM messages').get().n;
  app.historyDeletion.delete('miyue',rows.map(row=>row.id));
  const next=app.store.saveChatTurn({role:'miyue',text:'新一',reply:'新二'});
  assert.ok(db.prepare('SELECT rowid n FROM messages WHERE id=?').get(next[0].id).n>floor);
  assert.equal(db.prepare('SELECT count(DISTINCT rowid) n FROM messages').get().n,2);
  app.historyDeletion.delete('miyue',[next[1].id]);
  app.store.addAssistantMessage('miyue','再一条');
  assert.equal(db.prepare('SELECT max(rowid) n FROM messages').get().n,floor+3);
  const other=new DatabaseSync(path.join(dataDir,'life.sqlite'));
  try{
    app.historyDeletion.delete('miyue',app.store.getMessages('miyue').map(row=>row.id));
    other.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)').run('reopened','miyue','user','新连接的消息','chat',new Date().toISOString());
    assert.equal(other.prepare('SELECT rowid n FROM messages WHERE id=?').get('reopened').n,floor+4);
  }finally{other.close();}
});

test('deletion removes linked plans but keeps independent settings and manual recall',async t=>{
  const {app,req}=await fixture(t),db=app.store.db;
  const rows=app.store.saveChatTurn({role:'miyue',text:'和你一起去散步。',reply:'好。'});
  app.recallRepo.replace('miyue','用户独立修订的摘要');
  const state={schema:1,roleId:'miyue',revision:2,plans:[{id:'p1',sourceMessageId:rows[0].id,title:'删除计划'},{id:'p2',title:'保留计划'}],opportunities:[{id:'o1',planId:'p1'}],interests:[],processedMessageIds:[rows[0].id]};
  db.prepare('INSERT OR REPLACE INTO companion_agenda_state(role_id,revision,state_json,updated_at) VALUES(?,?,?,?)').run('miyue',2,JSON.stringify(state),rows[0].createdAt);
  assert.equal((await req('/api/chat/history/delete',{role:'miyue',ids:[rows[0].id]})).status,200);
  const saved=JSON.parse(db.prepare("SELECT state_json FROM companion_agenda_state WHERE role_id='miyue'").get().state_json);
  assert.deepEqual(saved.plans,[{id:'p2',title:'保留计划'}]);assert.deepEqual(saved.opportunities,[]);
  assert.equal(app.recallRepo.get('miyue').summary,'用户独立修订的摘要');
});

test('a failed database delete rolls back messages, receipts, memories and history revision together',async t=>{
  const {app,req}=await fixture(t),db=app.store.db;
  const rows=app.store.saveChatTurn({role:'miyue',text:'保留用户',reply:'保留助手'});
  app.historyEdits.set('miyue',[{id:rows[1].id,sourceHash:historySourceHash(rows[1].text),replacement:'保留修订',reason:'测试'}]);
  const revision=app.historyEdits.revision('miyue');
  db.exec("CREATE TRIGGER test_delete_failure BEFORE DELETE ON messages WHEN OLD.speaker='assistant' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  assert.ok((await req('/api/chat/history/delete',{role:'miyue',ids:rows.map(row=>row.id)})).status>=400);
  assert.equal(app.store.getMessages('miyue').length,2);assert.equal(app.historyEdits.revision('miyue'),revision);assert.equal(app.historyEdits.list('miyue').length,1);
});

test('active reply delivery blocks deletion without changing selected history',async t=>{
  const {app,req}=await fixture(t);
  const rows=app.store.saveChatTurn({role:'miyue',text:'旧消息',reply:'旧回复'});
  app.replyDelivery.enqueue('miyue',['仍在发送的后半段']);
  const response=await req('/api/chat/history/delete',{role:'miyue',ids:[rows[0].id]});
  assert.equal(response.status,409);assert.equal(response.body.code,'HISTORY_BUSY');assert.ok(app.store.getMessage(rows[0].id));
});
