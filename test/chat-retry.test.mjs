import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {ChatQueue} from '../lib/chat-queue.mjs';

const story=JSON.parse(fs.readFileSync(new URL('../app-data/story.json',import.meta.url),'utf8'));
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,timeoutMs=2000){const deadline=Date.now()+timeoutMs;while(Date.now()<deadline){if(await fn())return;await sleep(5);}throw new Error('timed out');}
function retryable(code='MODEL_NETWORK_ERROR',extra={}){return Object.assign(new Error('secret provider failure that must never be persisted'),{code,...extra});}
function fixture(t,{execute,retryDelaysMs=[15,20],debounceMs=1,dataDir}={}){
  const dir=dataDir||fs.mkdtempSync(path.join(os.tmpdir(),'chat-retry-'));
  const store=new Store({dataDir:dir,story,initialFeeds:[]});
  const queue=new ChatQueue(store,{execute,debounceMs,retryDelaysMs});
  queue.start();
  let closed=false;
  const close=async()=>{if(closed)return;closed=true;await queue.stop();store.close();};
  t.after(async()=>{await close();if(!dataDir)fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,store,queue,close};
}
function saveTurn(store,body,control,reply='收到。'){store.saveChatTurn({...body,reply,afterSave:control.afterSave});}

test('transient failures retry twice, then save one user and assistant turn',async t=>{
  let calls=0,store;
  const f=fixture(t,{execute:async(body,control)=>{calls++;if(calls<3)throw retryable();saveTurn(store,body,control);}});store=f.store;
  f.queue.submit('wenxi','请记住这一条','retry-success-001');
  await until(()=>f.queue.get('wenxi').phase==='retrying');
  const during=f.queue.get('wenxi');
  assert.equal(during.retryCount,1);assert.equal(during.maxRetries,2);assert.ok(Date.parse(during.nextRetryAt)>Date.now());assert.match(during.error,/自动重试/);assert.doesNotMatch(during.error,/secret|provider/i);assert.equal(f.queue.busy('wenxi'),true);
  await until(()=>f.queue.get('wenxi').phase==='idle');
  assert.equal(calls,3);assert.deepEqual(f.store.getMessages('wenxi').map(message=>message.speaker),['user','assistant']);
  const failures=f.store.db.prepare('SELECT error_code,retry_count,scheduled FROM chat_failures ORDER BY id').all().map(row=>({...row}));
  assert.deepEqual(failures,[{error_code:'MODEL_NETWORK_ERROR',retry_count:1,scheduled:1},{error_code:'MODEL_NETWORK_ERROR',retry_count:2,scheduled:1}]);
});

test('retry exhaustion fails durably and non-retryable errors fail immediately',async t=>{
  let transientCalls=0;
  const transient=fixture(t,{execute:async()=>{transientCalls++;throw retryable('MODEL_TIMEOUT');}});
  transient.queue.submit('wenxi','一直失败','retry-exhaust-001');
  await until(()=>transient.queue.get('wenxi').phase==='failed');
  assert.equal(transientCalls,3);assert.equal(transient.queue.get('wenxi').retryCount,2);assert.equal(transient.queue.get('wenxi').errorCode,'MODEL_TIMEOUT');assert.equal(transient.queue.get('wenxi').nextRetryAt,null);assert.match(transient.queue.get('wenxi').error,/已自动重试 2 次.*手动重试或取消/);

  let authCalls=0;
  const auth=fixture(t,{execute:async()=>{authCalls++;throw retryable('MODEL_AUTH_FAILED',{retryable:false});}});
  auth.queue.submit('miyue','认证失败','retry-auth-001');
  await until(()=>auth.queue.get('miyue').phase==='failed');
  assert.equal(authCalls,1);assert.equal(auth.queue.get('miyue').retryCount,0);assert.match(auth.queue.get('miyue').error,/认证失败/);
});

test('companion generation refusal retries within budget and stores only bounded issue metadata',async t=>{
  let calls=0;
  const f=fixture(t,{execute:async()=>{calls++;throw retryable('COMPANION_BEHAVIOR_REJECTED',{retryable:true,issues:['missing_affection_act',{code:'question_budget_exceeded'},'bad issue with secret body'],draft:'private response body'});}});
  f.queue.submit('miyue','自然聊聊','retry-behavior-001');await until(()=>f.queue.get('miyue').phase==='failed');
  assert.equal(calls,3);assert.equal(f.queue.get('miyue').retryCount,2);assert.match(f.queue.get('miyue').error,/已自动重试 2 次/);assert.doesNotMatch(f.queue.get('miyue').error,/private|secret|affection/i);
  const failure={...f.store.db.prepare('SELECT error_code,issue_codes,scheduled FROM chat_failures ORDER BY id DESC LIMIT 1').get()};
  assert.deepEqual(failure,{error_code:'COMPANION_BEHAVIOR_REJECTED',issue_codes:'["missing_affection_act","question_budget_exceeded"]',scheduled:0});
  assert.equal(f.store.db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='chat_failures'").get().sql.includes('draft'),false);
});

test('provider Retry-After extends configured backoff and manual retry resets the budget',async t=>{
  let calls=0;
  const f=fixture(t,{retryDelaysMs:[10],execute:async()=>{calls++;throw retryable('MODEL_RATE_LIMITED',{retryAfterMs:70});}});
  const started=Date.now();f.queue.submit('wenxi','稍后再试','retry-after-001');await until(()=>f.queue.get('wenxi').phase==='retrying');
  assert.ok(Date.parse(f.queue.get('wenxi').nextRetryAt)>=started+65);await until(()=>f.queue.get('wenxi').phase==='failed');assert.equal(calls,2);assert.equal(f.queue.get('wenxi').retryCount,1);
  const manual=f.queue.retry('wenxi');assert.equal(manual.phase,'queued');assert.equal(manual.retryCount,0);assert.equal(manual.errorCode,null);assert.equal(manual.nextRetryAt,null);
  await until(()=>calls===3);await f.queue.cancel('wenxi');
});

test('restart preserves retry budget and a future backoff deadline',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-retry-restart-'));let firstCalls=0;
  const first=fixture(t,{dataDir:dir,retryDelaysMs:[120,20],execute:async()=>{firstCalls++;throw retryable();}});
  first.queue.submit('wenxi','重启后继续','retry-restart-001');
  await until(()=>first.queue.get('wenxi').phase==='retrying');
  const due=first.queue.get('wenxi').nextRetryAt;assert.equal(first.queue.get('wenxi').retryCount,1);
  await first.close();
  let resumedCalls=0,resumedStore;
  const resumed=fixture(t,{dataDir:dir,retryDelaysMs:[120,20],execute:async(body,control)=>{resumedCalls++;saveTurn(resumedStore,body,control);}});resumedStore=resumed.store;
  assert.equal(resumed.queue.get('wenxi').retryCount,1);assert.equal(resumed.queue.get('wenxi').nextRetryAt,due);
  await sleep(Math.max(0,Date.parse(due)-Date.now()-25));assert.equal(resumedCalls,0);
  await until(()=>resumed.queue.get('wenxi').phase==='idle');assert.equal(resumedCalls,1);assert.equal(firstCalls,1);
  await resumed.close();fs.rmSync(dir,{recursive:true,force:true});
});

test('new input replaces a pending retry revision, resets its budget, and remains idempotent',async t=>{
  let calls=0,store;
  const f=fixture(t,{retryDelaysMs:[100,100],execute:async(body,control)=>{calls++;if(calls===1)throw retryable();saveTurn(store,body,control,'合并后回复。');}});store=f.store;
  const first=f.queue.submit('wenxi','原来的消息','retry-revision-001');
  await until(()=>f.queue.get('wenxi').phase==='retrying');
  const duplicate=f.queue.submit('wenxi','原来的消息','retry-revision-001');
  assert.equal(duplicate.revision,first.revision);assert.equal(duplicate.retryCount,1);
  const updated=f.queue.submit('wenxi','补充的新消息','retry-revision-002');
  assert.equal(updated.retryCount,0);assert.equal(updated.phase,'queued');assert.deepEqual(updated.items.map(item=>item.text),['原来的消息','补充的新消息']);
  await until(()=>f.queue.get('wenxi').phase==='idle');await sleep(120);
  assert.equal(calls,2);assert.deepEqual(f.store.getMessages('wenxi').filter(message=>message.speaker==='user').map(message=>message.text),['原来的消息','补充的新消息']);
});

test('cancelled retry does not resume',async t=>{
  let calls=0;const f=fixture(t,{retryDelaysMs:[50,50],execute:async()=>{calls++;throw retryable();}});
  f.queue.submit('wenxi','不要再试','retry-cancel-001');await until(()=>f.queue.get('wenxi').phase==='retrying');f.queue.cancel('wenxi');await sleep(80);
  assert.equal(calls,1);assert.equal(f.queue.get('wenxi').phase,'idle');assert.equal(f.queue.get('wenxi').items.length,0);
});

test('an exception after the save transaction commits cannot schedule duplicate delivery',async t=>{
  let calls=0,store;
  const f=fixture(t,{retryDelaysMs:[15,15],execute:async(body,control)=>{calls++;saveTurn(store,body,control);throw retryable();}});store=f.store;
  f.queue.submit('wenxi','只保存一次','retry-commit-001');await until(()=>f.queue.get('wenxi').phase==='idle');await sleep(60);
  assert.equal(calls,1);assert.deepEqual(f.store.getMessages('wenxi').map(message=>message.speaker),['user','assistant']);assert.equal(f.store.db.prepare('SELECT count(*) count FROM chat_failures').get().count,0);
});
