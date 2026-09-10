import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';

const choice=(id,name,status='ready',extra={})=>({id,name,status,...extra});
const asset=(id,outfitId,extra={})=>({id,identityId:'lin-yuwei-v1',hairstyleId:'original-long',outfitId,
  poseId:'idle',expressionId:'soft-smile',paletteId:'original',file:`looks/${id}.png`,status:'approved',width:1024,height:1536,...extra});
function catalogFixture(){return {
  version:1,identity:{id:'lin-yuwei-v1',name:'林雨薇',age:27},
  hairstyles:[choice('original-long','原始长发')],
  outfits:[choice('everyday','日常格纹','ready',{description:'格纹外套和蓝色牛仔裤。'}),choice('soft-knit','温柔针织','ready',{description:'燕麦针织开衫和灰蓝长裙。'}),choice('homewear','舒适居家','ready',{description:'暗玫瑰居家上衣。'})],
  scenes:[choice('study','书房','ready',{season:'all',compatibleOutfitIds:['everyday','soft-knit','homewear']}),choice('autumn-cafe','秋日咖啡馆','ready',{season:'autumn',compatibleOutfitIds:['everyday','soft-knit']})],
  poses:[choice('idle','站立','ready',{defaultExpressionId:'soft-smile'})],expressions:[choice('soft-smile','浅笑')],palettes:[choice('original','原色')],
  assets:[asset('everyday-idle','everyday'),asset('knit-idle','soft-knit'),asset('home-idle','homewear')],
};}

async function fixture(t,{catalog=catalogFixture(),startChatQueue=false}={}){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'appearance-api-')),calls=[];
  const app=await createApp({dataDir,appearanceCatalog:structuredClone(catalog),initialFeeds:[],startProactive:false,startRecall:false,
    startResearch:false,startPursuits:false,startLifeThreads:false,startDossiers:false,startChatQueue,
    clock:()=>new Date('2026-09-08T10:00:00.000Z'),random:()=>0,wardrobeRandom:()=>0,replySleep:async()=>{},
    env:{LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture'},
    fetchImpl:async(_url,init)=>{calls.push(JSON.parse(init.body));return Response.json({choices:[{message:{content:JSON.stringify({reply:'今天是燕麦针织和灰蓝长裙。',extra:''})}}]});}});
  const {port}=await app.listen(0);
  t.after(async()=>{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  const request=async(route,body)=>{const response=await fetch(`http://127.0.0.1:${port}${route}`,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
  return {app,calls,request};
}

test('appearance API applies one exact approved look, preserves invalid state, and never writes chat',async t=>{
  const f=await fixture(t),initial=(await f.request('/api/appearance')).body;
  assert.deepEqual(Object.keys(initial).sort(),['current','manifest','revision','settings']);
  const messages=f.app.store.getMessages('miyue',100);
  const invalid=await f.request('/api/appearance',{assetId:'knit-idle',hairstyleId:'original-long',outfitId:'everyday',poseId:'idle',expressionId:'soft-smile',paletteId:'original',sceneId:'study',season:'auto'});
  assert.equal(invalid.status,400);
  assert.deepEqual((await f.request('/api/appearance')).body.current,initial.current);
  const selected=await f.request('/api/appearance',{assetId:'knit-idle',hairstyleId:'original-long',outfitId:'soft-knit',poseId:'idle',expressionId:'soft-smile',paletteId:'original',sceneId:'autumn-cafe',season:'autumn',automatic:false,locked:true,sceneCardEnabled:true,reduceMotion:true});
  assert.equal(selected.status,200,JSON.stringify(selected.body));
  assert.equal(selected.body.current.assetId,'knit-idle');
  assert.equal(selected.body.current.season,'autumn');
  assert.deepEqual(selected.body.settings,{automatic:false,locked:true,sceneCardEnabled:true,reduceMotion:true});
  assert.deepEqual(f.app.store.getMessages('miyue',100),messages);
});

test('actual model request receives only current clothing context and appearance changes do not call the model',async t=>{
  const f=await fixture(t,{startChatQueue:true});
  await f.request('/api/appearance',{assetId:'knit-idle',hairstyleId:'original-long',outfitId:'soft-knit',poseId:'idle',expressionId:'soft-smile',paletteId:'original',sceneId:'study',season:'auto'});
  assert.equal(f.calls.length,0);
  const chat=await f.request('/api/chat',{role:'miyue',text:'你今天穿什么？'});
  assert.equal(chat.status,200,JSON.stringify(chat.body));
  const prompt=f.calls.at(-1).messages.map(message=>message.content).join('\n');
  assert.match(prompt,/林雨薇当前衣着：温柔针织/);
  assert.match(prompt,/燕麦针织开衫和灰蓝长裙/);
  assert.doesNotMatch(prompt,/日常格纹|舒适居家|looks\/|"assets"|"manifest"/);
});

test('busy reply queue returns 409 and leaves the current appearance frozen',async t=>{
  const f=await fixture(t),before=(await f.request('/api/appearance')).body;
  f.app.chatQueue.submit('miyue','稍后回复','appearance-busy-1');
  const result=await f.request('/api/appearance',{assetId:'knit-idle'});
  assert.equal(result.status,409);
  assert.deepEqual((await f.request('/api/appearance')).body.current,before.current);
});

test('legacy wardrobe and appearance commit atomically and synchronize settings',async t=>{
  const f=await fixture(t);
  const changed=await f.request('/api/wardrobe',{outfitId:'soft-knit',automatic:false,locked:true});
  assert.equal(changed.status,200,JSON.stringify(changed.body));
  const appearance=(await f.request('/api/appearance')).body;
  assert.equal(appearance.current.assetId,'knit-idle');
  assert.equal(appearance.current.outfitId,'soft-knit');
  assert.equal(appearance.settings.automatic,false);
  assert.equal(appearance.settings.locked,true);
  assert.deepEqual(f.app.store.getMessages('miyue',100),[]);
});

test('legacy wardrobe rolls back when its synchronized appearance asset is unavailable',async t=>{
  const catalog=catalogFixture();catalog.assets=catalog.assets.filter(item=>item.outfitId!=='soft-knit');
  const f=await fixture(t,{catalog});
  const wardrobeBefore=(await f.request('/api/wardrobe')).body;
  const appearanceBefore=(await f.request('/api/appearance')).body;
  const failed=await f.request('/api/wardrobe',{outfitId:'soft-knit'});
  assert.equal(failed.status,400);
  assert.deepEqual((await f.request('/api/wardrobe')).body,wardrobeBefore);
  assert.deepEqual((await f.request('/api/appearance')).body.current,appearanceBefore.current);
});
