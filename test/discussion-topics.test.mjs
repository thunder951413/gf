import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DiscussionTopics } from '../lib/discussion-topics.mjs';

class Store {
  constructor(file = ':memory:') {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS messages(
      id TEXT PRIMARY KEY,role TEXT NOT NULL,speaker TEXT NOT NULL,text TEXT NOT NULL,kind TEXT NOT NULL,created_at TEXT NOT NULL)`);
    this.depth = 0;
  }
  getMessage(id) { const r = this.db.prepare('SELECT * FROM messages WHERE id=?').get(id); return r && { id:r.id,role:r.role,speaker:r.speaker,text:r.text,kind:r.kind,createdAt:r.created_at }; }
  transaction(fn) { const savepoint=`nested_${this.depth}`; this.db.exec(this.depth?`SAVEPOINT ${savepoint}`:'BEGIN'); this.depth++; try { const value=fn(); this.depth--; this.db.exec(this.depth?`RELEASE ${savepoint}`:'COMMIT'); return value; } catch(error) { this.depth--; this.db.exec(this.depth?`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`:'ROLLBACK'); throw error; } }
  close(){try{this.db.close();}catch(error){if(error?.code!=='ERR_INVALID_STATE')throw error;}}
}

const catalog = [
  { id:'ship',category:'philosophy',title:'忒修斯之船',aliases:['船'],premise:'换掉全部木板后还是同一艘船吗？',angles:[{id:'identity',detail:'身份连续性'}],sources:[] },
  { id:'stoic',category:'philosophy',title:'控制二分',aliases:['斯多葛'],premise:'我们能控制什么？',angles:[],sources:[] },
  { id:'memory',category:'psychology',title:'记忆重构',aliases:['记忆'],premise:'回忆为何会改变？',angles:[],sources:[] },
  { id:'map',category:'geography',title:'地图投影',aliases:['地图'],premise:'地图怎样改变世界观？',angles:[],sources:[] },
  { id:'silk',category:'history',title:'丝路日常',aliases:['丝路'],premise:'古人如何跨城生活？',angles:[],sources:[] },
];

function seeded(seed=1){return()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2**32;};}
function fixture(t,{file=':memory:',visible=()=>true,random=seeded(),at='2026-09-16T10:00:00.000Z'}={}){
  let now=new Date(at);const store=new Store(file),repo=new DiscussionTopics(store,{catalog,random,isVisible:visible,clock:()=>now});
  t.after(()=>store.close());let seq=0;
  const save=(speaker,text,{role='miyue',kind='chat',time=now.toISOString()}={})=>{const id=`m${++seq}`;store.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(id,role,speaker,text,kind,time);return store.getMessage(id);};
  const expose=(topicId,{role='miyue',trigger='autonomous',text=`我刚想到一个可以慢慢聊的话题：${topicId}。`,exposureId=null}={})=>{const row=save('assistant',text,{role});return repo.recordDelivery({roleId:role,topicId,messageId:row.id,trigger,quote:text,exposureId});};
  const respond=(exposure,state,evidence,{scope='topic',role='miyue'}={})=>{const row=save('user',evidence,{role});return repo.observeResponse({roleId:role,messageId:row.id,exposureId:exposure.id,signal:{state,scope,evidence}});};
  return{store,repo,save,expose,respond,set:value=>{now=new Date(value);}};
}

test('selection is non-consuming, bounded, explores unseen topics and avoids a recent topic for seven days',t=>{
  const {repo,store,expose,set}=fixture(t,{random:()=>0});
  const first=repo.choose();assert.equal(first.id,'ship');assert.equal(store.db.prepare('SELECT count(*) n FROM discussion_topic_exposures').get().n,0);
  expose('ship');assert.notEqual(repo.choose().category,'philosophy','an autonomous opening avoids the immediately repeated category when alternatives exist');
  assert.equal(repo.choose({category:'philosophy'}).id,'stoic');
  set('2026-09-24T10:00:00.000Z');assert.equal(repo.choose({category:'philosophy',force:true}).id,'ship');
});

test('the exploration branch samples unseen candidates uniformly instead of applying preference weights',t=>{
  let call=0,index=0;const repo=fixture(t,{random:()=>++call%2 ? 0 : ((index++%catalog.length)+.1)/catalog.length}).repo;
  const selected=new Set(Array.from({length:catalog.length},()=>repo.choose().id));
  assert.deepEqual(selected,new Set(catalog.map(item=>item.id)));
});

test('explicit force may revisit a blocked category once without clearing its persisted block',t=>{
  const {repo,expose,respond}=fixture(t);const e=expose('ship');
  respond(e,'blocked','以后别主动聊哲学了',{scope:'category'});
  assert.equal(repo.choose({category:'philosophy'}),null);
  assert.ok(repo.choose({category:'philosophy',force:true}));
  assert.equal(repo.profile().categories.find(x=>x.category==='philosophy').blocked,true);
  assert.equal(repo.choose({category:'philosophy'}),null);
});

test('sustained sourced engagement gradually raises category selection probability without farming repeated turns',t=>{
  const f=fixture(t,{random:seeded(17)});let e=f.expose('memory');
  for(let i=0;i<8;i++)f.respond(e,'engaged',`这个角度挺有意思${i}`);
  const psychology=f.repo.profile().categories.find(x=>x.category==='psychology');
  assert.equal(psychology.score,1.14,'only one modest implicit credit is allowed per exposure');
  for(let i=0;i<3;i++){f.set(`2026-09-${17+i}T10:00:00.000Z`);e=f.expose('memory',{trigger:'explicit',text:`继续聊记忆重构的第${i+1}次回应。`});f.respond(e,'wants_more','以后心理学可以多聊一点',{scope:'category'});}
  assert.ok(f.repo.profile().categories.find(x=>x.category==='psychology').score>2);
});

test('repeating explicit wants-more inside one exposure cannot farm category weight',t=>{
  const f=fixture(t),e=f.expose('memory');
  for(let i=0;i<5;i++)f.respond(e,'wants_more',`心理学以后可以多聊一点${i}`,{scope:'category'});
  assert.equal(f.repo.profile().categories.find(x=>x.category==='psychology').score,1.8);
});

test('silence and sparse neutral replies never create negative observations or close an active topic',t=>{
  const {repo,expose,respond,save}=fixture(t);const e=expose('ship');
  assert.equal(repo.profile().responses.length,0);assert.equal(repo.active().id,e.id);
  respond(e,'neutral','嗯');assert.equal(repo.profile().categories.find(x=>x.category==='philosophy').score,1);
  assert.equal(repo.active().id,e.id);
  save('user','好');assert.equal(repo.profile().responses.length,1,'unannotated short replies are not inferred as disinterest');
});

test('topic dislikes stay local and broad negatives require the category to be named',t=>{
  const f=fixture(t);const e=f.expose('ship');
  f.respond(e,'less','这个换船的话题我不太想聊',{scope:'topic'});
  assert.equal(f.repo.profile().categories.find(x=>x.category==='philosophy').score,1);
  assert.equal(f.repo.choose({category:'philosophy'}).id,'stoic');
  const broadRow=f.save('user','以后少聊一点');
  assert.equal(f.repo.observeResponse({messageId:broadRow.id,exposureId:e.id,signal:{state:'less',scope:'category',evidence:'以后少聊一点'}}),null);
  const broad=f.save('user','以后少聊一点哲学');
  assert.ok(f.repo.observeResponse({messageId:broad.id,exposureId:e.id,signal:{state:'less',scope:'category',evidence:'少聊一点哲学'}}));
  assert.ok(f.repo.profile().categories.find(x=>x.category==='philosophy').score<1);
});

test('message row order, rather than equal timestamps, terminates active context on an unrelated assistant turn',t=>{
  const f=fixture(t),e=f.expose('ship'),other=f.save('assistant','这是同一时间保存的另一条无关主动消息。');
  assert.equal(f.repo.active({conversation:[other]}),null);
  assert.ok(e);
});

test('one ordinary acknowledgement after a neutral reply preserves continuity without becoming a delivery',t=>{
  const f=fixture(t),e=f.expose('ship'),neutral=f.save('user','嗯嗯');
  f.repo.observeResponse({messageId:neutral.id,exposureId:e.id,signal:{state:'neutral',scope:'topic',evidence:'嗯嗯'}});
  const acknowledgement=f.save('assistant','嗯，我听着。');
  const active=f.repo.active({conversation:[neutral,acknowledgement]});
  assert.equal(active.id,e.id);assert.equal(active.lastMessageId,e.messageId);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM discussion_topic_deliveries').get().n,1,'acknowledgement is not treated as topical evidence');
  const otherUser=f.save('user','我先说说今天的工作');
  const unrelated=f.save('assistant','好，你慢慢说今天发生了什么。');
  assert.equal(f.repo.active({conversation:[neutral,acknowledgement,otherUser,unrelated]}),null);
});

test('confirmed engagement bridges an unannotated reply so the next explicit category limit is still observed',t=>{
  const f=fixture(t),e=f.expose('memory'),engaged=f.save('user','这个角度挺有意思');
  f.repo.observeResponse({messageId:engaged.id,exposureId:e.id,signal:{state:'engaged',scope:'topic',evidence:engaged.text}});
  const reply=f.save('assistant','我也觉得这里最有意思的是，回忆并不像抽屉里固定的一张照片。');
  assert.equal(f.repo.recordDelivery({topicId:'memory',messageId:reply.id,trigger:'followup',quote:'这段引用并不在保存回复里',exposureId:e.id}),null);
  const bridged=f.repo.active({conversation:[engaged,reply]});
  assert.equal(bridged.id,e.id);assert.equal(f.store.db.prepare('SELECT count(*) n FROM discussion_topic_deliveries').get().n,1);
  const limit=f.save('user','心理学以后少聊一点吧');
  assert.ok(f.repo.observeResponse({messageId:limit.id,exposureId:bridged.id,signal:{state:'less',scope:'category',evidence:limit.text}}));
  assert.equal(f.repo.active({conversation:[engaged,reply,limit]}),null);
  assert.ok(f.repo.profile().categories.find(item=>item.category==='psychology').score<1);
});

test('multiple confirmed interested turns may bridge, but unknown never does',t=>{
  const f=fixture(t),e=f.expose('ship'),conversation=[];
  for(const [state,userText,assistantText] of [['engaged','我觉得这个有意思','那我们沿着身份连续性往下想。'],['wants_more','这个话题还想多聊一点','好，我再换一个日常角度。']]){
    const user=f.save('user',userText);f.repo.observeResponse({messageId:user.id,exposureId:e.id,signal:{state,scope:'topic',evidence:user.text}});
    const assistant=f.save('assistant',assistantText);conversation.push(user,assistant);assert.equal(f.repo.active({conversation}).id,e.id);
  }
  const unknown=f.save('user','也许吧');f.repo.observeResponse({messageId:unknown.id,exposureId:e.id,signal:{state:'unknown',scope:'topic'}});
  const reply=f.save('assistant','嗯。');conversation.push(unknown,reply);assert.equal(f.repo.active({conversation}),null);
});

test('a proactive opening after neutral feedback still closes the old discussion',t=>{
  const f=fixture(t),e=f.expose('ship'),neutral=f.save('user','嗯嗯');
  f.repo.observeResponse({messageId:neutral.id,exposureId:e.id,signal:{state:'neutral',scope:'topic',evidence:'嗯嗯'}});
  const proactive=f.save('assistant','我刚看到窗外天色变了。',{kind:'proactive'});
  assert.equal(f.repo.active({conversation:[neutral,proactive]}),null);
});

test('response states close or retain the active thread deliberately',t=>{
  for(const state of ['changed_topic','blocked','less','deferred']){
    const f=fixture(t);const e=f.expose('map');f.respond(e,state,state==='blocked'?'这个地图话题别聊了':state==='less'?'这个地图话题少聊':state==='deferred'?'地图以后再聊':'我们换个话题吧');
    assert.equal(f.repo.active(),null,state);f.store.close=()=>{};
  }
});

test('delivery and response evidence must match saved non-story messages in the same role',t=>{
  const f=fixture(t),wrongRole=f.save('assistant','这是一段足够长的真实消息',{role:'wenxi'}),story=f.save('assistant','这是一段足够长的故事消息',{kind:'story'});
  const unquoted=f.save('assistant','这是一条没有匹配引用的初始开场消息。');
  assert.equal(f.repo.recordDelivery({topicId:'ship',messageId:unquoted.id,trigger:'auto',quote:'模型给出的文字并不存在于开场中'}),null);
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM discussion_topic_exposures').get().n,0);
  assert.equal(f.repo.recordDelivery({topicId:'ship',messageId:wrongRole.id,trigger:'auto',quote:wrongRole.text}),null);
  assert.equal(f.repo.recordDelivery({topicId:'ship',messageId:story.id,trigger:'auto',quote:story.text}),null);
  const row=f.save('assistant','前半句是真实投递，后半句也存在。'),e=f.repo.recordDelivery({topicId:'ship',messageId:row.id,trigger:'auto',quote:'前半句是真实投递'});
  assert.ok(e);const user=f.save('user','我觉得这个很好');
  assert.equal(f.repo.observeResponse({messageId:user.id,exposureId:e.id,signal:{state:'engaged',scope:'topic',evidence:'并不存在'}}),null);
});

test('delivery quotes tolerate whitespace layout only and retain the saved multiline substring',t=>{
  const f=fixture(t),text='🙂 我刚想到：丝绸之路其实不是“一条路”。\n更像一张网，一段一段接力。要不要从这里聊？',row=f.save('assistant',text);
  const exposure=f.repo.recordDelivery({topicId:'silk',messageId:row.id,trigger:'autonomous',quote:'丝绸之路其实不是“一条路”。更像一张网，一段一段接力。'});
  assert.ok(exposure);assert.equal(exposure.quote,'丝绸之路其实不是“一条路”。\n更像一张网，一段一段接力。');
  assert.equal(f.store.db.prepare('SELECT quote FROM discussion_topic_deliveries WHERE message_id=?').get(row.id).quote,exposure.quote);
  const changed=f.save('assistant',text);
  assert.equal(f.repo.recordDelivery({topicId:'silk',messageId:changed.id,trigger:'autonomous',quote:'丝绸之路其实不是“一条街”。更像一张网，一段一段接力。'}),null);
  const reordered=f.save('assistant',text);
  assert.equal(f.repo.recordDelivery({topicId:'silk',messageId:reordered.id,trigger:'autonomous',quote:'丝绸之路更像一张网，其实不是“一条路”。一段一段接力。'}),null);
});

test('retry deduplication, continuation and role isolation preserve one exposure',t=>{
  const f=fixture(t),e=f.expose('silk'),same=f.repo.recordDelivery({topicId:'silk',messageId:e.messageId,trigger:'autonomous',quote:e.quote});
  assert.equal(same.id,e.id);const follow=f.expose('silk',{exposureId:e.id,text:'沿着这个问题，我又想到商队吃饭的细节。'});
  assert.equal(follow.id,e.id);assert.equal(follow.lastMessageId,follow.messageId);
  const other=f.expose('map',{role:'wenxi'});f.respond(other,'blocked','这个地图话题别聊了',{role:'wenxi'});
  assert.ok(f.repo.choose({roleId:'miyue',category:'geography'}));assert.equal(f.repo.choose({roleId:'wenxi',category:'geography'}),null);
});

test('caller transaction rollback removes exposure and observation writes',t=>{
  const f=fixture(t),row=f.save('assistant','这是一段会被整体回滚的主动讨论消息。');
  assert.throws(()=>f.store.transaction(()=>{f.repo.recordDelivery({topicId:'ship',messageId:row.id,trigger:'auto',quote:row.text});throw new Error('rollback');}));
  assert.equal(f.store.db.prepare('SELECT count(*) n FROM discussion_topic_exposures').get().n,0);
  const e=f.repo.recordDelivery({topicId:'ship',messageId:row.id,trigger:'auto',quote:row.text}),user=f.save('user','这个问题很有趣');
  assert.throws(()=>f.store.transaction(()=>{f.repo.observeResponse({messageId:user.id,exposureId:e.id,signal:{state:'engaged',scope:'topic',evidence:user.text}});throw new Error('rollback');}));
  assert.equal(f.repo.profile().responses.length,0);
});

test('hidden or deleted source messages remove their contribution at read time',t=>{
  const hidden=new Set(),f=fixture(t,{visible:row=>!hidden.has(row.id)}),e=f.expose('ship');
  const response=f.save('user','哲学以后不要主动聊了');f.repo.observeResponse({messageId:response.id,exposureId:e.id,signal:{state:'blocked',scope:'category',evidence:response.text}});
  assert.equal(f.repo.choose({category:'philosophy'}),null);
  hidden.add(response.id);assert.ok(f.repo.choose({category:'philosophy'}),'a hidden response cannot keep suppressing a category');
  hidden.add(e.messageId);assert.equal(f.repo.active(),null);assert.equal(f.repo.profile().exposures.length,0);
});

test('a visible follow-up cannot revive an exposure whose original assistant anchor is hidden',t=>{
  const hidden=new Set(),f=fixture(t,{visible:row=>!hidden.has(row.id)}),e=f.expose('ship');
  const follow=f.expose('ship',{exposureId:e.id,text:'这是同一话题里仍然可见的一段后续讨论。'});
  f.respond(follow,'wants_more','这个话题还想继续聊');
  hidden.add(e.messageId);
  assert.equal(f.repo.active(),null);assert.equal(f.repo.profile().responses.length,0);assert.equal(f.repo.profile().exposures.length,0);
});

test('state persists across repository restarts and explicit wants-more releases a matching block',t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'discussion-topics-')),file=path.join(dir,'test.sqlite');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  let f=fixture(t,{file}),e=f.expose('ship');f.respond(e,'blocked','哲学以后不要主动聊了',{scope:'category'});f.store.close();
  const store=new Store(file),repo=new DiscussionTopics(store,{catalog,clock:()=>new Date('2026-09-17T10:00:00Z'),random:()=>0});t.after(()=>store.close());
  assert.equal(repo.choose({category:'philosophy'}),null);
  store.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run('release','miyue','user','哲学还是可以多聊一点','chat','2026-09-17T10:00:00Z');
  assert.ok(repo.observeResponse({messageId:'release',exposureId:e.id,signal:{state:'wants_more',scope:'category',evidence:'哲学还是可以多聊一点'}}));
  assert.ok(repo.choose({category:'philosophy'}));
});
