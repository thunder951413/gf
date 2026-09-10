import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';
import {setTimeout as delay} from 'node:timers/promises';
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
async function fixture(t,extra={}){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'continuous-life-'));let now=new Date('2026-09-08T02:00:00Z');const calls=[];
 const app=await createApp({dataDir,initialFeeds:[],startProactive:false,startRecall:false,startPursuits:false,startLifeThreads:false,startDossiers:false,startResearch:false,startChatQueue:false,startRuntime:false,replySleep:async()=>{},random:()=>.1,clock:()=>new Date(now),env:{LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture'},fetchImpl:async(_url,init)=>{const payload=JSON.parse(init.body);calls.push(payload);if(extra.respond)await extra.respond(payload,calls.length,value=>{now=new Date(value)});return Response.json({choices:[{message:{content:JSON.stringify({reply:calls.length===1?'这是第一次准备的回答。':'这是按新安排准备的回答。',extra:''})}}]});},...extra.options});
 const {port}=await app.listen(0),base=`http://127.0.0.1:${port}`;
 t.after(async()=>{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});});
 return {app,calls,base,set:value=>{now=new Date(value)},request:async(route,body)=>{const r=await fetch(base+route,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};}};
}
test('server timer advances without requests, dialogue or proactive service and never calls model',async t=>{
 const f=await fixture(t,{options:{startRuntime:true,runtimeIntervalMs:10}});await delay(40);
 const read=()=>JSON.parse(f.app.store.db.prepare("SELECT value FROM metadata WHERE key='companion_runtime:miyue'").get().value);
 const before=read();f.set('2026-09-08T04:15:00Z');await delay(40);const after=read();
 assert.notEqual(after.currentRecord.id,before.currentRecord.id);assert.equal(f.calls.length,0);assert.equal(f.app.companionRuntime.status().running,true);
});
test('active and user preparation share authoritative state, stable daily plan and settings revision',async t=>{
 const f=await fixture(t);const user=f.app.roleContext('miyue',{initiating:false,text:'你在做什么'});const proactive=f.app.roleContext('miyue',{initiating:true});
 assert.doesNotMatch(user.characterContext,/切番茄|家中地板上/);assert.match(user.characterContext,/处理上午的工作/);assert.match(proactive.lifeTopic.context,/处理上午的工作/);assert.deepEqual(user.runtime.current,proactive.runtime.current);assert.deepEqual(user.runtime.world,proactive.runtime.world);assert.equal(user.runtimeRevision,proactive.runtimeRevision);
 const view=await f.request('/api/companion-runtime');assert.deepEqual(view.body.current,user.runtime.current);assert.equal(f.calls.length,0);
 const invalid=await f.request('/api/companion-runtime/settings',{revision:view.body.revision-1,settings:{automaticScenes:false}});assert.equal(invalid.status,409);
});
test('only an explicitly eligible transparent activity asset drives the compact desktop character; manual scenes remain pinned',async t=>{
 const f=await fixture(t);const upload=await f.request('/api/image-library/upload',{image:png,name:'工作时段人物',sceneIds:['study','autumn-cafe'],kind:'scene',activity:'work',background:'keep'});
 assert.equal(upload.status,200);const library=f.app.imageLibrary.snapshot(),item=library.items[0];
 let state=f.app.companionRuntime.advance();assert.equal(f.app.sceneImages.snapshot().enabled,false,JSON.stringify({state,status:f.app.companionRuntime.status(),library}));const selected=f.app.runtimeScenes.read();
 assert.equal(selected.avatarMode,'fallback');f.app.companionRuntime.advance();assert.deepEqual(f.app.runtimeScenes.read(),selected);
 const alpha=fs.readFileSync(path.join(process.cwd(),'desktop/assets/visual-v2/recolors/original-long-soft-knit-idle-soft-smile-dusty-rose.png')).toString('base64');
 const derivative=await f.request('/api/image-library/derivative',{id:item.id,image:`data:image/png;base64,${alpha}`});assert.equal(derivative.status,200);
 state=f.app.companionRuntime.advance();assert.equal(f.app.sceneImages.snapshot().enabled,false);
 const approved=await f.request('/api/image-library/metadata',{id:item.id,desktopEligible:true});assert.equal(approved.status,200);
 state=f.app.companionRuntime.advance();assert.equal(f.app.sceneImages.snapshot().enabled,true);assert.equal(f.app.sceneImages.snapshot().activeSceneId,'study');assert.equal(f.app.runtimeScenes.read().avatarMode,'cutout');
 const manual=await f.request('/api/image-library/apply',{id:item.id,sceneId:'autumn-cafe',variant:'original'});assert.equal(manual.status,200);
 f.set('2026-09-08T06:30:00Z');state=f.app.companionRuntime.advance();assert.equal(state.settings.automaticScenes,false);assert.equal(f.app.sceneImages.snapshot().activeSceneId,'autumn-cafe');assert.equal(f.app.runtimeScenes.read().mode,'manual');
 const auto=await f.request('/api/companion-runtime/settings',{revision:state.revision,settings:{automaticScenes:true}});assert.equal(auto.status,200);assert.equal(f.app.sceneImages.snapshot().enabled,true);assert.equal(f.app.sceneImages.snapshot().activeSceneId,'study');assert.equal(f.calls.length,0);
});
test('crossing an activity boundary during generation discards old draft and retries exactly once',async t=>{
 const f=await fixture(t,{respond:async(_payload,count,set)=>{if(count===1)set('2026-09-08T04:15:00Z');}});
 const result=await f.request('/api/chat',{role:'miyue',text:'说说你现在在做什么。'});assert.equal(result.status,200,JSON.stringify(result.body));
 assert.equal(f.calls.length,2);const messages=f.app.store.getMessages('miyue');assert.equal(messages.length,2);assert.equal(messages.filter(m=>m.speaker==='user').length,1);assert.match(messages.at(-1).text,/新安排/);assert.doesNotMatch(JSON.stringify(messages),/第一次准备/);
 assert.match(JSON.stringify(f.calls[1].messages),/午饭|午餐/);
});

test('rotation settings validate, drive original seasonal images through API, and timer changes images without model calls',async t=>{
 const f=await fixture(t,{options:{startRuntime:true,runtimeIntervalMs:10}});
 const upload=await f.request('/api/image-library/upload',{image:png,name:'冬天室外',activity:'walk',seasons:['winter'],environment:'outdoor'});assert.equal(upload.status,200);
 const png2='data:image/png;base64,'+fs.readFileSync(path.join(process.cwd(),'desktop/assets/visual-v2/recolors/original-long-soft-knit-idle-soft-smile-dusty-rose.png')).toString('base64');
 assert.equal((await f.request('/api/image-library/upload',{image:png2,name:'冬天外出第二张',activity:'walk',seasons:['winter'],environment:'outdoor'})).status,200);
 const initial=(await f.request('/api/companion-runtime')).body;
 for(const settings of [{imageRotationMinutes:-1},{imageRotationMinutes:1.2},{imageSeason:'rain'},{imageEnvironment:'room'},{imageVariant:'other'}])assert.equal((await f.request('/api/companion-runtime/settings',{revision:initial.revision,settings})).status,400);
 const updated=await f.request('/api/companion-runtime/settings',{revision:initial.revision,settings:{imageRotationMinutes:1,imageSeason:'winter',imageEnvironment:'outdoor',imageVariant:'original'}});
 assert.equal(updated.status,200);const first=updated.body.desktop;assert.equal(first.avatarMode,'photo');assert.equal(first.candidateCount,2);assert.equal(first.season,'winter');assert.equal(first.environment,'outdoor');
 assert.deepEqual(updated.body.current,initial.current,'image override cannot invent an outing');
 f.set('2026-09-08T02:01:01Z');await delay(50);
 const next=f.app.runtimeScenes.read();assert.notEqual(next.itemId,first.itemId,'server timer rotates without a page refresh');assert.equal(f.calls.length,0);
 const stale=await f.request('/api/companion-runtime/settings',{revision:initial.revision,settings:{imageRotationMinutes:15}});assert.equal(stale.status,409);
});
