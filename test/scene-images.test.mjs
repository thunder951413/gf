import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {SceneImagesRepository} from '../lib/scene-images.mjs';

const story={start:'start',nodes:{start:{}}};
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const png2='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAQAAAD8fJRsAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
function fixture(t,existing){const dataDir=existing||fs.mkdtempSync(path.join(os.tmpdir(),'scene-images-'));const store=new Store({dataDir,story,initialFeeds:[]});const repo=new SceneImagesRepository(store,{dataDir});t.after(()=>{try{store.close();}catch{}});if(!existing)t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));return{dataDir,store,repo};}

test('six fixed scenes save independently, replace by content hash, and survive restart',t=>{
  const f=fixture(t);const initial=f.repo.snapshot();
  assert.deepEqual(initial,{enabled:false,activeSceneId:null,revision:0,scenes:[
    {id:'study',name:'书房',imageUrl:null,fit:'contain'},{id:'summer-coast',name:'夏日海岸',imageUrl:null,fit:'contain'},
    {id:'autumn-cafe',name:'秋日咖啡馆',imageUrl:null,fit:'contain'},{id:'winter-home',name:'冬日居所',imageUrl:null,fit:'contain'},
    {id:'private-bedroom',name:'私密卧室',imageUrl:null,fit:'contain'},{id:'spring-study',name:'春日窗边',imageUrl:null,fit:'contain'}]});
  let saved=f.repo.update({sceneId:'study',image:png,fit:'cover'});const first=saved.scenes[0].imageUrl;
  assert.equal(saved.enabled,false);assert.equal(saved.activeSceneId,null);
  saved=f.repo.update({sceneId:'summer-coast',image:png2});assert.ok(saved.scenes[1].imageUrl);assert.equal(saved.scenes[0].imageUrl,first);
  saved=f.repo.update({sceneId:'study',image:png2});assert.notEqual(saved.scenes[0].imageUrl,first);
  f.store.close();const reopened=new Store({dataDir:f.dataDir,story,initialFeeds:[]});const repo=new SceneImagesRepository(reopened,{dataDir:f.dataDir});
  assert.equal(repo.snapshot().scenes[0].imageUrl,saved.scenes[0].imageUrl);assert.equal(repo.snapshot().scenes[0].fit,'cover');reopened.close();
});

test('activation requires an image and removing the active image disables without selecting another',t=>{
  const {repo}=fixture(t);
  assert.throws(()=>repo.update({activeSceneId:'study'}),{code:'SCENE_IMAGE_REQUIRED'});
  let state=repo.update({sceneId:'study',image:png,activeSceneId:'study',enabled:true});assert.equal(state.enabled,true);
  state=repo.update({sceneId:'summer-coast',image:png2});assert.equal(state.activeSceneId,'study');
  state=repo.update({sceneId:'study',image:null});assert.equal(state.enabled,false);assert.equal(state.activeSceneId,null);assert.ok(state.scenes.find(x=>x.id==='summer-coast').imageUrl);
  assert.throws(()=>repo.update({enabled:true}),{code:'SCENE_IMAGE_REQUIRED'});
});

test('strict image and patch validation rejects wrong MIME, oversized and unsafe file names',t=>{
  const {repo}=fixture(t);
  assert.throws(()=>repo.update({image:png}),{code:'SCENE_ID_REQUIRED'});
  assert.throws(()=>repo.update({sceneId:'study',image:png,extra:true}),{code:'INVALID_SCENE_IMAGE'});
  assert.throws(()=>repo.update({sceneId:'study',image:png.replace('image/png','image/jpeg')}),{code:'INVALID_IMAGE'});
  const truncatedVp8x=Buffer.alloc(25);truncatedVp8x.write('RIFF',0);truncatedVp8x.writeUInt32LE(17,4);truncatedVp8x.write('WEBPVP8X',8);
  assert.throws(()=>repo.update({sceneId:'study',image:`data:image/webp;base64,${truncatedVp8x.toString('base64')}`}),{code:'INVALID_IMAGE'});
  assert.throws(()=>repo.update({sceneId:'study',image:`data:image/png;base64,${Buffer.alloc(12*1024*1024+1).toString('base64')}`}),{code:'IMAGE_TOO_LARGE'});
  repo.update({sceneId:'study',image:png});assert.equal(repo.file('../life.sqlite'),null);assert.equal(repo.file('0'.repeat(64)+'.png'),null);
});
