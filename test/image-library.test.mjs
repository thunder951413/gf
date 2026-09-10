import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {Store} from '../lib/store.mjs';
import {SceneImagesRepository} from '../lib/scene-images.mjs';
import {ImageLibraryRepository} from '../lib/image-library.mjs';

const story={start:'start',nodes:{start:{}}};
const transparent='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const opaque='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAQAAAD8fJRsAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
function rgba(alpha){const signature=Buffer.from([137,80,78,71,13,10,26,10]);const chunk=(type,data)=>{const out=Buffer.alloc(data.length+12);out.writeUInt32BE(data.length);out.write(type,4);data.copy(out,8);return out;};const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(1,0);ihdr.writeUInt32BE(1,4);ihdr[8]=8;ihdr[9]=6;return `data:image/png;base64,${Buffer.concat([signature,chunk('IHDR',ihdr),chunk('IDAT',zlib.deflateSync(Buffer.from([0,20,30,40,alpha]))),chunk('IEND',Buffer.alloc(0))]).toString('base64')}`;}
function fixture(t,existing){const dataDir=existing||fs.mkdtempSync(path.join(os.tmpdir(),'image-library-'));const store=new Store({dataDir,story,initialFeeds:[]});const scenes=new SceneImagesRepository(store,{dataDir});const repo=new ImageLibraryRepository(store,{dataDir,sceneImages:scenes});t.after(()=>{try{store.close();}catch{}});if(!existing)t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));return{dataDir,store,scenes,repo};}

test('uploads persist, deduplicate bytes, and preserve original metadata on repeat',t=>{
  const f=fixture(t);let state=f.repo.upload({image:transparent,name:'小像',tags:['室内'],kind:'portrait',background:'needs-removal'});
  assert.equal(state.items.length,1);const first=state.items[0];assert.equal(first.name,'小像');assert.match(first.originalUrl,/^[/]api[/]image-library[/]files[/][a-f0-9]{64}[.]png$/);assert.equal(first.cutoutUrl,null);
  state=f.repo.upload({image:transparent,name:'不应覆盖',tags:['别的'],kind:'scene'});assert.equal(state.items.length,1);assert.equal(state.items[0].name,'小像');assert.deepEqual(state.items[0].tags,['室内']);
  f.store.close();const reopened=new Store({dataDir:f.dataDir,story,initialFeeds:[]}),scenes=new SceneImagesRepository(reopened,{dataDir:f.dataDir}),repo=new ImageLibraryRepository(reopened,{dataDir:f.dataDir,sceneImages:scenes});
  assert.equal(repo.snapshot().items[0].id,first.id);reopened.close();
});

test('metadata is editable and validation is strict',t=>{
  const {repo}=fixture(t);const id=repo.upload({image:transparent}).items[0].id;
  const item=repo.metadata({id,name:'海边',sceneIds:['summer-coast'],tags:['夏天','人物'],activity:'散步',background:'keep',kind:'scene'}).items[0];
  assert.deepEqual({name:item.name,sceneIds:item.sceneIds,tags:item.tags,activity:item.activity,kind:item.kind},{name:'海边',sceneIds:['summer-coast'],tags:['夏天','人物'],activity:'散步',kind:'scene'});
  assert.throws(()=>repo.upload({image:transparent,unknown:true}),{code:'INVALID_IMAGE_LIBRARY'});assert.throws(()=>repo.metadata({id,sceneIds:['missing']}),{code:'INVALID_IMAGE_LIBRARY'});assert.equal(repo.file('../life.sqlite'),null);assert.equal(repo.file('0'.repeat(64)+'.png'),null);
});

test('season and environment metadata validate strictly and override legacy inference',t=>{
  const {repo}=fixture(t);const inferred=repo.upload({image:transparent,name:'冬日街角',tags:['街边']}).items[0];
  assert.deepEqual(inferred.seasons,['winter']);assert.equal(inferred.environment,'outdoor');
  assert.deepEqual(inferred.classificationInferred,{seasons:true,environment:true});
  const explicit=repo.metadata({id:inferred.id,seasons:[],environment:'indoor'}).items[0];
  assert.deepEqual(explicit.seasons,[]);assert.equal(explicit.environment,'indoor');
  assert.deepEqual(explicit.classificationInferred,{seasons:false,environment:false});
  assert.throws(()=>repo.metadata({id:inferred.id,seasons:'winter'}),/适用季节无效/);
  assert.throws(()=>repo.metadata({id:inferred.id,seasons:['monsoon']}),/适用季节无效/);
  assert.throws(()=>repo.metadata({id:inferred.id,environment:'outside'}),/室内外分类无效/);
  assert.throws(()=>repo.upload({image:opaque,seasons:['winter','spring','summer','autumn','winter'],environment:'any'}),/适用季节无效/);
});

test('legacy stored metadata remains unchanged while snapshots expose inferred classification',t=>{
  const {repo,store}=fixture(t);const id=repo.upload({image:transparent,name:'夏日海边'}).items[0].id;
  const before=JSON.parse(store.db.prepare('SELECT value FROM metadata WHERE key=?').get('image-library:v1').value);
  assert.equal(Object.hasOwn(before.items[0],'seasons'),false);assert.equal(Object.hasOwn(before.items[0],'environment'),false);
  const item=repo.snapshot().items.find(entry=>entry.id===id);assert.deepEqual(item.seasons,['summer']);assert.equal(item.environment,'outdoor');
  const after=JSON.parse(store.db.prepare('SELECT value FROM metadata WHERE key=?').get('image-library:v1').value);
  assert.equal(Object.hasOwn(after.items[0],'seasons'),false);assert.equal(Object.hasOwn(after.items[0],'environment'),false);
});

test('desktop eligibility defaults to false and only accepts a verified transparent version',t=>{
  const {repo}=fixture(t);const opaqueId=repo.upload({image:rgba(255),name:'不透明原图',background:'transparent'}).items[0].id;
  assert.equal(repo.snapshot().items[0].desktopEligible,false);
  assert.throws(()=>repo.metadata({id:opaqueId,desktopEligible:true}),{code:'DESKTOP_ELIGIBILITY_REQUIRES_TRANSPARENCY'});
  assert.throws(()=>repo.metadata({id:opaqueId,desktopEligible:'true'}),/桌面资格必须是布尔值/);
  const id=repo.upload({image:transparent,name:'待审核'}).items.find(item=>item.name==='待审核').id;
  repo.derivative({id,image:rgba(0)});
  assert.equal(repo.metadata({id,desktopEligible:true}).items.find(item=>item.id===id).desktopEligible,true);
  assert.equal(repo.derivative({id,image:rgba(128)}).items.find(item=>item.id===id).desktopEligible,false);
});

test('legacy unreviewed items stay ineligible and losing original transparency revokes approval',t=>{
  const {repo,store}=fixture(t);const id=repo.upload({image:rgba(0),background:'transparent'}).items[0].id;
  const saved=JSON.parse(store.db.prepare('SELECT value FROM metadata WHERE key=?').get('image-library:v1').value);delete saved.items[0].desktopEligible;
  store.db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(saved),'image-library:v1');
  assert.equal(repo.snapshot().items[0].desktopEligible,false);
  assert.equal(repo.metadata({id,desktopEligible:true}).items[0].desktopEligible,true);
  assert.equal(repo.metadata({id,background:'keep'}).items[0].desktopEligible,false);
});

test('cutout requires an actual transparent pixel and preserves the original',t=>{
  const {repo}=fixture(t);const id=repo.upload({image:opaque,name:'原图'}).items[0].id,original=repo.snapshot().items[0].originalUrl;
  assert.throws(()=>repo.derivative({id,image:rgba(255)}),{code:'CUTOUT_TRANSPARENCY_REQUIRED'});
  const item=repo.derivative({id,image:rgba(0)}).items[0];assert.equal(item.originalUrl,original);assert.ok(item.cutoutUrl);assert.notEqual(item.cutoutUrl,item.originalUrl);assert.equal(item.background,'keep');
});

test('upload is inert and apply activates exactly the requested scene',t=>{
  const {repo,scenes}=fixture(t);scenes.update({sceneId:'study',image:opaque,activeSceneId:'study',enabled:true});const id=repo.upload({image:transparent,name:'候选'}).items.find(item=>item.name==='候选').id;
  assert.equal(scenes.snapshot().activeSceneId,'study');repo.apply({id,sceneId:'summer-coast',variant:'original',fit:'cover'});const state=scenes.snapshot();assert.equal(state.activeSceneId,'summer-coast');assert.equal(state.enabled,true);assert.ok(state.scenes.find(scene=>scene.id==='summer-coast').imageUrl);assert.equal(state.scenes.find(scene=>scene.id==='summer-coast').fit,'cover');
  assert.throws(()=>repo.apply({id,sceneId:'winter-home',variant:'cutout'}),{code:'CUTOUT_REQUIRED'});
});

test('existing assigned scene files import lazily and idempotently without changing active state',t=>{
  const {repo,scenes}=fixture(t);scenes.update({sceneId:'study',image:opaque,activeSceneId:'study',enabled:true});scenes.update({sceneId:'summer-coast',image:opaque});
  const before=scenes.snapshot(),first=repo.snapshot(),second=repo.snapshot();assert.equal(first.items.length,1);assert.deepEqual(first.items[0].sceneIds,['study','summer-coast']);assert.equal(second.items.length,1);assert.deepEqual(scenes.snapshot(),before);
});

test('cleared imported classification stays cleared on later snapshots',t=>{
  const {repo,scenes}=fixture(t);scenes.update({sceneId:'study',image:opaque});const id=repo.snapshot().items[0].id;
  assert.deepEqual(repo.metadata({id,sceneIds:[]}).items[0].sceneIds,[]);assert.deepEqual(repo.snapshot().items[0].sceneIds,[]);
});

test('applying a cutout never imports it as a duplicate library item',t=>{
  const {repo,scenes}=fixture(t);const id=repo.upload({image:opaque,name:'人物',background:'needs-removal'}).items[0].id;
  repo.derivative({id,image:rgba(0)});const before=repo.snapshot().items[0];const after=repo.apply({id,sceneId:'winter-home',variant:'cutout'}).items;
  assert.equal(after.length,1);assert.equal(after[0].id,id);assert.equal(after[0].originalUrl,before.originalUrl);assert.equal(after[0].cutoutUrl,before.cutoutUrl);assert.equal(after[0].background,'needs-removal');assert.equal(scenes.snapshot().activeSceneId,'winter-home');
});
