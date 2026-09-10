import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

async function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'wardrobe-api-'));
  const calls=[];
  const app=await createApp({dataDir:dir,clock:()=>new Date('2026-09-08T10:00:00Z'),wardrobeRandom:()=>0,
    env:{LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture'},initialFeeds:[],
    startProactive:false,startRecall:false,startResearch:false,startPursuits:false,startLifeThreads:false,startDossiers:false,
    replySleep:async()=>{},random:()=>.5,
    fetchImpl:async(_url,init)=>{calls.push(JSON.parse(init.body));return Response.json({choices:[{message:{content:JSON.stringify({reply:'今天选的是温柔针织这一套，裙子是灰蓝色的。'})}}]});}});
  const {port}=await app.listen(0);
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {app,calls,async request(route,body){const r=await fetch(`http://127.0.0.1:${port}${route}`,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:r.status,body:await r.json()};}};
}

test('wardrobe selection is shared by the API, life snapshot and actual model request without authoring chat',async t=>{
  const f=await fixture(t);
  const before=f.app.store.getMessages('miyue',100);
  const selected=await f.request('/api/wardrobe',{outfitId:'soft-knit',locked:true});
  assert.equal(selected.status,200);
  assert.equal(selected.body.current.outfitId,'soft-knit');
  assert.equal(selected.body.settings.locked,true);
  const life=await f.request('/api/life');
  assert.deepEqual(life.body.wardrobe,selected.body);
  assert.deepEqual(f.app.store.getMessages('miyue',100),before);
  assert.equal(f.calls.length,0);
  const result=await f.request('/api/chat',{role:'miyue',text:'你今天穿了什么衣服？'});
  assert.equal(result.status,200,JSON.stringify(result));
  const sent=f.calls.at(-1).messages.map(m=>m.content).join('\n');
  assert.match(sent,/林雨薇当前衣着：温柔针织/);
  assert.match(sent,/灰蓝色中长裙/);
  assert.doesNotMatch(sent,/当前衣着：日常格纹|当前衣着：舒适居家/);
});

test('invalid wardrobe updates return 400 and preserve selected outfit and settings',async t=>{
  const f=await fixture(t);
  const before=(await f.request('/api/wardrobe')).body;
  for(const body of [{outfitId:'missing'},{locked:'true'},{automatic:false,extra:1}]){
    const result=await f.request('/api/wardrobe',body);
    assert.equal(result.status,400);
    assert.deepEqual((await f.request('/api/wardrobe')).body,before);
  }
});
