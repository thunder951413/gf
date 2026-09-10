import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {AppearanceRepository} from '../lib/appearance.mjs';

const choice=(id,name,status='ready',extra={})=>({id,name,status,...extra});
const asset=(id,hairstyleId,outfitId,poseId,expressionId,paletteId='original')=>({
  id,identityId:'lin-yuwei-v1',hairstyleId,outfitId,poseId,expressionId,paletteId,
  file:`looks/${id}.png`,status:'approved',width:1024,height:1536,
});

function catalogFixture(){
  return structuredClone({
    version:1,identity:{id:'lin-yuwei-v1',name:'林雨薇',age:27},
    hairstyles:[choice('long','长发'),choice('bob','波波头')],
    outfits:[choice('everyday','日常格纹','ready',{description:'格纹外套与牛仔裤。'}),choice('soft-knit','温柔针织','ready',{description:'燕麦针织与灰蓝长裙。'}),choice('lingerie','私密内搭','ready',{access:'private',description:'完整不透明内搭。'})],
    scenes:[choice('study','书房','ready',{season:'all',compatibleOutfitIds:['everyday','soft-knit']}),choice('autumn-cafe','秋日咖啡馆','ready',{season:'autumn',compatibleOutfitIds:['everyday','soft-knit']}),choice('bedroom','卧室','ready',{season:'all',compatibleOutfitIds:['lingerie']})],
    poses:[choice('idle','站立','ready',{defaultExpressionId:'soft-smile'}),choice('reading','阅读','ready',{defaultExpressionId:'neutral'}),choice('walking','行走','ready',{defaultExpressionId:'soft-smile'}),choice('sleeping','睡眠','ready',{defaultExpressionId:'tired'})],
    expressions:[choice('soft-smile','浅笑'),choice('neutral','平静'),choice('tired','疲惫')],
    palettes:[choice('original','原色'),choice('blue','灰蓝')],
    assets:[
      asset('long-everyday-idle','long','everyday','idle','soft-smile'),
      asset('long-knit-idle','long','soft-knit','idle','soft-smile'),
      asset('long-private-idle','long','lingerie','idle','soft-smile'),
      asset('long-everyday-read','long','everyday','reading','neutral'),
      asset('long-everyday-walk','long','everyday','walking','soft-smile'),
      asset('long-everyday-sleep','long','everyday','sleeping','tired'),
      asset('bob-everyday-idle','bob','everyday','idle','soft-smile'),
      asset('long-everyday-blue','long','everyday','idle','soft-smile','blue'),
    ],
  });
}

function fixture(t,{initial='2026-09-05T22:59:00.000Z',catalog=catalogFixture(),legacySettings={automatic:true,locked:false}}={}){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'appearance-unit-'));
  const store=new Store({dataDir,story:{start:'start',nodes:{start:{}}},initialFeeds:[]});
  let now=new Date(initial),busy=false,state={world:{activity:'自由活动'},inner:{fatigue:20,stress:20,mood:60}};
  const options={catalog,clock:()=>new Date(now),random:()=>0,wardrobe:{snapshot:()=>({current:{outfitId:'everyday'},settings:legacySettings})},getState:()=>state,isBusy:()=>busy};
  const repo=()=>new AppearanceRepository(store,options);
  t.after(()=>{store.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  return {store,repo,setTime:value=>{now=new Date(value);},setBusy:value=>{busy=value;},setState:value=>{state=value;}};
}

test('first appearance migration preserves legacy automatic and lock settings',t=>{
  const f=fixture(t,{legacySettings:{automatic:false,locked:true}}),snapshot=f.repo().snapshot();
  assert.equal(snapshot.settings.automatic,false);
  assert.equal(snapshot.settings.locked,true);
  f.setTime('2026-09-20T23:00:00.000Z');
  assert.equal(f.repo().snapshot().current.assetId,snapshot.current.assetId);
});

test('strict invalid updates preserve state and manual scene/season choices are never silently replaced',t=>{
  const f=fixture(t),repo=f.repo(),before=repo.snapshot();
  for(const patch of [
    {assetId:'missing'},
    {assetId:'long-knit-idle',hairstyleId:'bob'},
    {assetId:'long-knit-idle',sceneId:'bedroom'},
    {assetId:'long-everyday-idle',sceneId:'autumn-cafe',season:'winter'},
    {sceneId:'planned-scene'},
    {reduceMotion:'yes'},
    {extra:true},
  ]) assert.throws(()=>repo.update(patch),error=>error.status===400);
  assert.deepEqual(repo.snapshot().current,before.current);
  assert.deepEqual(repo.snapshot().settings,before.settings);
  const noScene=repo.update({sceneId:null,season:null});
  assert.equal(noScene.current.sceneId,null);
  assert.equal(noScene.current.season,'auto');
});

test('busy time freezes automation; Shanghai 07:00 changes only outfit and excludes private or hair changes',t=>{
  const f=fixture(t),repo=f.repo(),initial=repo.snapshot();
  f.setBusy(true);f.setTime('2026-09-05T23:00:00.000Z');
  assert.equal(repo.snapshot().current.assetId,initial.current.assetId);
  f.setBusy(false);
  const changed=repo.snapshot();
  assert.equal(changed.current.outfitId,'soft-knit');
  assert.equal(changed.current.hairstyleId,'long');
  assert.notEqual(changed.current.outfitId,'lingerie');
  assert.equal(changed.revision,initial.revision+1);
});

test('life pose observes a three-minute dwell and reads world.activity plus inner values',t=>{
  const f=fixture(t,{initial:'2026-09-05T12:00:00.000Z'}),repo=f.repo();
  const initial=repo.snapshot();
  f.setState({world:{activity:'正在阅读'},inner:{fatigue:20,stress:20,mood:60}});
  f.setTime('2026-09-05T12:02:59.999Z');
  assert.equal(repo.snapshot().current.assetId,initial.current.assetId);
  f.setTime('2026-09-05T12:03:00.000Z');
  assert.equal(repo.snapshot().current.assetId,'long-everyday-read');
  f.setState({world:{activity:'夜间休息'},inner:{fatigue:80,stress:20,mood:60}});
  f.setTime('2026-09-05T12:05:59.999Z');
  assert.equal(repo.snapshot().current.assetId,'long-everyday-read');
  f.setTime('2026-09-05T12:06:00.000Z');
  assert.equal(repo.snapshot().current.assetId,'long-everyday-sleep');
});

test('state persists across repository restarts and a clock rollback cannot reverse or repeat a change',t=>{
  const f=fixture(t),first=f.repo();first.snapshot();
  f.setTime('2026-09-05T23:00:00.000Z');
  const changed=first.snapshot();
  const restarted=f.repo();
  assert.deepEqual(restarted.snapshot().current,changed.current);
  f.setTime('2026-09-05T20:00:00.000Z');
  const rolledBack=restarted.snapshot();
  assert.deepEqual(rolledBack.current,changed.current);
  assert.equal(rolledBack.revision,changed.revision);
});

test('context exposes only the rendered clothes and hair, and appearance operations do not author chat',t=>{
  const f=fixture(t),repo=f.repo();repo.snapshot();
  repo.update({assetId:'long-knit-idle',hairstyleId:'long',outfitId:'soft-knit',poseId:'idle',expressionId:'soft-smile',paletteId:'original',sceneId:'study'});
  const prompt=repo.context();
  assert.match(prompt,/当前衣着：温柔针织/);
  assert.match(prompt,/燕麦针织与灰蓝长裙/);
  assert.doesNotMatch(prompt,/私密内搭|完整不透明内搭|assets|manifest|looks\//);
  assert.deepEqual(f.store.getMessages('miyue',100),[]);
});
