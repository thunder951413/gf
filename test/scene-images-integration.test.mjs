import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';

const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
async function fixture(t){const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'scene-api-')),calls=[];const app=await createApp({dataDir,initialFeeds:[],startProactive:false,startRecall:false,startPursuits:false,startLifeThreads:false,startDossiers:false,startResearch:false,startChatQueue:false,replySleep:async()=>{},env:{LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture'},fetchImpl:async(_url,init)=>{calls.push(JSON.parse(init.body));return Response.json({choices:[{message:{content:JSON.stringify({reply:'我在。',extra:''})}}]});}});const {port}=await app.listen(0),base=`http://127.0.0.1:${port}`;t.after(async()=>{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});});return{app,calls,base,request:async(route,body)=>{const response=await fetch(base+route,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});let result;try{result=await response.json();}catch{result=null;}return{response,body:result};}};}

test('API keeps upload out of chat and model, serves immutable allowlisted bytes, and suppresses stale appearance context',async t=>{
  const f=await fixture(t),messages=f.app.store.getMessages('miyue');
  const uploaded=await f.request('/api/scene-images',{sceneId:'study',image:png,activeSceneId:'study',enabled:true});
  assert.equal(uploaded.response.status,200);assert.deepEqual(f.app.store.getMessages('miyue'),messages);assert.equal(f.calls.length,0);
  const url=uploaded.body.scenes[0].imageUrl,response=await fetch(f.base+url);assert.equal(response.status,200);assert.equal(response.headers.get('x-content-type-options'),'nosniff');assert.match(response.headers.get('cache-control'),/immutable/);assert.equal(Buffer.from(await response.arrayBuffer()).toString('base64'),png.split(',')[1]);
  assert.equal((await fetch(f.base+'/api/scene-images/files/'+('0'.repeat(64))+'.png')).status,404);
  assert.equal((await fetch(f.base+'/api/scene-images/files/..%2Flife.sqlite')).status,404);
  const badMime=await fetch(f.base+'/api/scene-images',{method:'POST',headers:{'content-type':'text/plain'},body:JSON.stringify({sceneId:'study',image:png})});assert.equal(badMime.status,415);
  const truncatedVp8x=Buffer.alloc(25);truncatedVp8x.write('RIFF',0);truncatedVp8x.writeUInt32LE(17,4);truncatedVp8x.write('WEBPVP8X',8);
  const malformed=await f.request('/api/scene-images',{sceneId:'study',image:`data:image/webp;base64,${truncatedVp8x.toString('base64')}`});assert.equal(malformed.response.status,400);assert.equal(malformed.body.code,'INVALID_IMAGE');
  const chat=await f.request('/api/chat',{role:'miyue',text:'你现在穿什么？'});assert.equal(chat.response.status,200);const prompt=f.calls.at(-1).messages.map(x=>x.content).join('\n');assert.match(prompt,/用户亲自选择的完整场景照片/);assert.match(prompt,/无法从这张图片推断/);assert.doesNotMatch(prompt,/林晓薇当前衣着：/);
  assert.ok((await f.request('/api/appearance')).body.current,'legacy appearance remains available');
});
