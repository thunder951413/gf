import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

const catalog={items:[{
  id:'order-book',kind:'reading',title:'顺序验收书',aliases:['验收书'],
  source:{title:'顺序验收来源',url:'https://example.test/order-book',scope:'仅用于集成测试'},
  stages:Array.from({length:4},(_,index)=>({label:`第${index+1}章`,action:index===0?'读到窗边争论的一段':`读到后续测试段落${index+1}`,detail:`当前测试细节${index+1}`})),
}]};

const integrations={
  fetchFeed:async()=>({title:'订阅',items:[]}),probeTts:async()=>({available:false,state:'unavailable',stt:{available:false,state:'unavailable'}}),
  startSpeech:async()=>{throw new Error('unused');},readSpeechStatus:async()=>({state:'failed'}),getSpeechAudio:async()=>{throw new Error('unused');},
  closeSpeech:async()=>({ok:true}),transcribeAudio:async()=>{throw new Error('unused');},
};

async function fixture(t,{duringRequest}={}){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'proactive-pursuit-order-'));
  let app;
  const fetchImpl=async(_url,init)=>{
    const request=JSON.parse(init.body);
    await duringRequest?.(app,request);
    return Response.json({choices:[{message:{content:JSON.stringify({
      skip:false,contentId:null,reason:'分享当前阅读',message:'我在《顺序验收书》里看到两个人争论同一件事，想起理解有时会从不同方向长出来。',
      extra:'',experience:null,companionship:null,discussion:null,signals:null,dynamics:null,groundedLife:null,social:null,
    })}}]});
  };
  app=await createApp({
    appDataDir:path.resolve('app-data'),dataDir,initialFeeds:[],integrations,fetchImpl,
    env:{LIFE_MODEL_BASE_URL:'https://model.test/v1',LIFE_MODEL_NAME:'fixture'},clock:()=>new Date('2026-09-21T10:00:00Z'),random:()=>0,
    dynamicCompanion:true,materialPresentation:'generated',startPursuits:true,startProactive:false,startRecall:false,startLifeThreads:false,replySleep:async()=>{},
    pursuitCatalog:catalog,
  });
  t.after(async()=>{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  app.proactiveRepo.saveSettings({enabled:true,activeStart:'00:00',activeEnd:'23:59',dailyLimit:10,desktopNotifications:false});
  return app;
}

test('scheduled dynamic pursuit records material exposure before title mention updates continuity',async t=>{
  const app=await fixture(t);
  const before=app.pursuits.get('miyue');
  const result=await app.proactive.runNow({roleId:'miyue'});
  assert.equal(result.delivered,true,JSON.stringify(result));
  assert.match(result.message.text,/顺序验收书/);
  assert.doesNotMatch(result.message.text,new RegExp(before.stage.action));
  const after=app.pursuits.get('miyue');
  assert.equal(after.history.length,1);
  assert.equal(after.history[0].delivery,'material_exposure');
  assert.equal(after.history[0].selectedAction,before.stage.action);
  assert.equal(after.history[0].actualReply,result.message.text);
  const raw=JSON.parse(app.store.db.prepare('SELECT state_json FROM companion_pursuit_state WHERE role_id=?').get('miyue').state_json);
  assert.equal(raw.lastMentionMessageId,result.message.id);
  assert.equal(raw.lastMentionedAt,'2026-09-21T10:00:00.000Z');
});

test('scheduled dynamic pursuit rejects a real external version change during generation',async t=>{
  let changed=false;
  const app=await fixture(t,{duringRequest:app=>{
    if(changed)return;changed=true;
    const current=app.pursuits.get('miyue');
    app.pursuits.retire('miyue',{expectedId:current.id,reason:'外部状态变更'});
  }});
  const result=await app.proactive.runNow({roleId:'miyue'});
  assert.equal(result.delivered,false);
  assert.match(result.reason,/变化.*未发送/);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM proactive_events WHERE message_id IS NOT NULL').get().n,0);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM companion_pursuit_deliveries').get().n,0);
});
