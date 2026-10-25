import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';

function fixture(t) {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'life-message-times-'));
  const store=new Store({dataDir,story:{start:'start'},clock:()=>new Date('2026-10-03T16:00:10Z')});
  t.after(()=>{store.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  return store;
}

test('user timestamps describe submission while the assistant timestamp describes delivery',t=>{
  const store=fixture(t),responded=[];
  store.proactiveRepo={respondToRole:(role,at)=>responded.push({role,at}),decorateMessage:()=>({})};
  const sent=['2026-10-03T15:59:40Z','2026-10-03T15:59:50Z'];
  const saved=store.saveChatTurn({role:'miyue',userTexts:['明天去看牙','下午三点'],userCreatedAts:sent,reply:'记住这次安排。'});
  assert.deepEqual(saved.map(m=>m.createdAt),[...sent.map(at=>new Date(at).toISOString()),store.now()]);
  assert.deepEqual(store.getMessages('miyue').map(m=>m.id),saved.map(m=>m.id));
  assert.deepEqual(responded,[{role:'miyue',at:'2026-10-03T15:59:50.000Z'}]);
});

test('an assistant-only invitation cannot mark proactive contact as answered by the user',t=>{
  const store=fixture(t);let responded=0;
  store.proactiveRepo={respondToRole:()=>responded++};
  const saved=store.saveChatTurn({role:'miyue',text:'',userTexts:[],reply:'今天想和你聊一件小事。'});
  assert.equal(responded,0);assert.equal(saved.length,1);assert.equal(saved[0].speaker,'assistant');
});

test('a stale delivery rolls back the timestamped user originals as part of the same transaction',t=>{
  const store=fixture(t);
  assert.throws(()=>store.saveChatTurn({role:'miyue',text:'明天去看牙',userCreatedAts:['2026-10-03T15:59:40Z'],reply:'记住了。',afterSave:()=>{throw Error('stale');}}));
  assert.deepEqual(store.getMessages('miyue'),[]);
});
