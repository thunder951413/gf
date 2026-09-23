import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';
import {SYSTEM_PROMPT} from '../lib/semantic-planner.mjs';

const input='我想和你聊会天哎，你有什么有意思的事情吗';
async function fixture(t,drafts){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-recovery-')),calls=[],sent=[];
 const app=await createApp({dataDir,initialFeeds:[],semanticUnderstanding:true,naturalMaterialDelivery:true,
  startProactive:false,startRecall:false,startResearch:false,startPursuits:false,startLifeThreads:false,startDossiers:false,startRuntime:false,startWeixin:false,
  chatDebounceMs:1,chatRetryDelaysMs:[5,10],replySleep:async()=>{},
  weixinClient:{sendText:async payload=>{sent.push(payload);return {messageId:'fixture-sent'};}},
  env:{LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture'},
  fetchImpl:async(_url,init)=>{
   const body=JSON.parse(init.body),semantic=body.messages[0].content===SYSTEM_PROMPT;
   const content=semantic?{intent:'invite_character_share',continuity:'new',focusMessageId:null,ownLife:true,advice:false,emotionalDetail:false,imagined:false,correction:false,acceptsOffer:false,source:'none',retrievalQuery:'',evidence:input}:
    drafts[Math.min(calls.length,drafts.length-1)];
   if(!semantic)calls.push(body);
   return Response.json({choices:[{message:{content:typeof content==='string'?content:JSON.stringify(content)}}]});
  }});
 app.preferences.setReplyPace('instant');const {port}=await app.listen(0);
 t.after(async()=>{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});});
 const request=async(route,body)=>{const response=await fetch(`http://127.0.0.1:${port}${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,...await response.json()};};
 return {app,calls,sent,request,send:()=>request('/api/chat/send',{role:'miyue',text:input,clientId:'wx-recovery-fixture-001'})};
}
async function settled(app){
 const deadline=Date.now()+5000;
 while(Date.now()<deadline){const state=app.chatQueue.get('miyue');if(['idle','failed'].includes(state.phase))return state;await new Promise(resolve=>setTimeout(resolve,10));}
 assert.fail('queue did not settle');
}

test('the reported message delivers once when a sharing heuristic persists after one revision',async t=>{
 const reply='你想聊什么都可以。说起猫，我喜欢它们把纸箱当宝贝的样子，再贵的窝也比不过快递盒。';
 const f=await fixture(t,[{reply,extra:''}]);
 assert.equal((await f.send()).status,202);assert.equal((await settled(f.app)).phase,'idle');
 assert.equal(f.calls.length,2,'one optional revision, no whole-turn retry for a prose warning');
 const rows=f.app.store.getMessages('miyue');assert.deepEqual(rows.map(r=>r.speaker),['user','assistant']);
 assert.equal(rows[0].text,input);assert.equal(rows[1].text.replace(/\s/g,''),reply.replace(/\s/g,''));
 const receipt=f.app.interactionPolicy.receipt(rows[1].id);
 assert.equal(receipt.behavior.intent,'share');assert.deepEqual(receipt.behavior.behaviorWarnings,['returns_topic_to_user']);
 assert.equal(f.app.store.db.prepare('SELECT COUNT(*) n FROM chat_failures').get().n,0);
 await f.send();assert.equal(f.app.store.getMessages('miyue').length,2,'client replay cannot duplicate the turn');
});

test('real behavior conflicts remain blocked and a fresh queued generation can recover without duplicate history',async t=>{
 const bad={reply:'我们昨天见面的时候，看到了路边那只猫。',extra:''};
 const good={reply:'我喜欢猫认真钻纸箱的样子，好像每个快递盒都值得重新研究。',extra:''};
 const f=await fixture(t,[bad,bad,good]);await f.send();assert.equal((await settled(f.app)).phase,'idle');
 assert.equal(f.calls.length,3);
 const rows=f.app.store.getMessages('miyue');assert.equal(rows.length,2);assert.equal(rows[1].text,good.reply);
 const failures=f.app.store.db.prepare('SELECT error_code,issue_codes,retry_count,scheduled FROM chat_failures').all();
 assert.equal(failures.length,1);assert.equal(failures[0].error_code,'COMPANION_BEHAVIOR_REJECTED');
 assert.match(failures[0].issue_codes,/invented_offline_presence/);assert.equal(failures[0].scheduled,1);
});

test('persistent factual conflicts exhaust the bounded budget, retain input, and permit explicit recovery',async t=>{
 const drafts=[{reply:'我们昨天见面的时候，看到了路边那只猫。',extra:''}];
 const f=await fixture(t,drafts);await f.send();const failed=await settled(f.app);
 assert.equal(failed.phase,'failed');assert.equal(failed.retryCount,2);assert.equal(f.calls.length,6);
 assert.deepEqual(failed.items.map(i=>i.text),[input]);assert.equal(f.app.store.getMessages('miyue').length,0);
 assert.match(failed.error,/已自动重试 2 次/);
 drafts[0]={reply:'我喜欢猫钻纸箱的样子，盒子小一点反而更有吸引力。',extra:''};
 assert.equal((await f.request('/api/chat/retry',{role:'miyue'})).status,200);
 assert.equal((await settled(f.app)).phase,'idle');assert.equal(f.calls.length,7);
 assert.deepEqual(f.app.store.getMessages('miyue').map(r=>r.speaker),['user','assistant']);
});

test('an invalid reply envelope gets a bounded fresh attempt rather than silently wedging the queue',async t=>{
 const f=await fixture(t,['{"extra":"缺少正文"}','{"extra":"仍缺少正文"}',{reply:'我喜欢雨后石板路的颜色，看起来比晴天深一点。',extra:''}]);
 await f.send();assert.equal((await settled(f.app)).phase,'idle');assert.equal(f.calls.length,3);
 assert.equal(f.app.store.db.prepare('SELECT error_code FROM chat_failures').get().error_code,'MODEL_REPLY_INVALID');
 assert.equal(f.app.store.getMessages('miyue').length,2);
});

test('a WeChat inbound turn recovers through the same queue and is captured and delivered only once',async t=>{
 const bad={reply:'我们昨天见面的时候，看到了路边那只猫。',extra:''};
 const good={reply:'我喜欢猫钻纸箱的样子，每次都要先伸一只爪子试探。',extra:''};
 const f=await fixture(t,[bad,bad,good]);
 f.app.weixin.bind({botToken:'fixture-token',botId:'fixture-bot',userId:'fixture-owner',baseUrl:'https://fixture.test'});
 const inbound={cursor:'fixture-cursor',messages:[{message_id:'fixture-inbound',message_type:1,from_user_id:'fixture-owner',context_token:'fixture-context',item_list:[{type:1,text_item:{text:input}}]}]};
 f.app.weixin.ingest(inbound);f.app.weixin.drainInbox();
 assert.equal((await settled(f.app)).phase,'idle');
 f.app.weixin.capture();await f.app.weixin.deliver();
 f.app.weixin.ingest(inbound);f.app.weixin.drainInbox();f.app.weixin.capture();await f.app.weixin.deliver();
 assert.equal(f.calls.length,3);assert.equal(f.sent.length,1);assert.equal(f.sent[0].text,good.reply);
 assert.equal(f.app.store.getMessages('miyue').length,2);
 assert.equal(f.app.store.db.prepare('SELECT state FROM weixin_outbox').get().state,'sent');
});
