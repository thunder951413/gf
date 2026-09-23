import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';
import {chooseInitiative} from '../lib/conversation-plan.mjs';

const catalog=JSON.parse(fs.readFileSync(new URL('../app-data/companion-pursuits.json',import.meta.url)));
async function fixture(t){
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'life-interest-'));
 let now=new Date('2026-09-17T13:00:00Z');
 const app=await createApp({dataDir,env:{},initialFeeds:[],startPursuits:true,startDailyLife:false,startLife:false,startLifeThreads:false,startRuntime:false,startProactive:false,startWeixin:false,startRecall:false,startResearch:false,startDossiers:false,startChatQueue:false,clock:()=>now,random:()=>.5,discussionRandom:()=>0,pursuitCatalog:{lifePlanning:true,items:[catalog.items.find(x=>x.category==='心理学')]}});
 t.after(async()=>{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});});
 return {app,setTime:value=>now=new Date(value)};
}
test('runtime supplies one persisted hour session, retains its reached material, and routes it into initiation',async t=>{
 const {app,setTime}=await fixture(t);
 const first=app.companionRuntime.snapshot();
 assert.equal(first.current.kind,'reading');assert.equal(first.pursuit.session.status,'active');
 assert.ok(Date.parse(first.current.endsAt)-Date.parse(first.current.startedAt)>=3600000);
 const session=first.pursuit.session;
 setTime('2026-09-17T13:30:00Z');
 const second=app.companionRuntime.snapshot();assert.deepEqual(second.pursuit.session,session);
 const invitation=app.roleContext('miyue',{initiating:false,opening:true,text:'哄哄我，想被你关心、被你惦记'});
 assert.equal(invitation.sharePacket.title,first.pursuit.title);
 const ctx=app.roleContext('miyue',{initiating:true});
 assert.equal(ctx.opportunity.kind,'pursuit');assert.equal(ctx.discussion,null);
 assert.equal(ctx.sharePacket.title,first.pursuit.title);
 assert.ok(JSON.stringify(ctx.sharePacket).includes(first.pursuit.stage.detail.slice(0,12)));
 setTime('2026-09-18T02:00:00Z');
 const later=app.companionRuntime.snapshot();assert.equal(later.current.kind,'work');assert.equal(later.pursuit.stage.index,0);assert.equal(later.pursuit.readable,true);
 const own=app.roleContext('miyue',{initiating:false,text:'你最近在读什么？',semantic:{intent:'share',ownLife:true,source:'none',needsCurrentState:true}});
 assert.equal(own.pursuitRoute.detailed,true);
 const unrelated=app.roleContext('miyue',{initiating:false,text:'今天代码终于跑通了',semantic:{intent:'answer',ownLife:false,source:'none'}});
 assert.equal(unrelated.pursuitRoute.detailed,false);assert.equal(unrelated.sharePacket,null);
 assert.match(unrelated.characterContext,/持续兴趣状态/);
 assert.ok(unrelated.characterContext.includes(first.pursuit.title));
 assert.match(unrelated.characterContext,/下次再继续/);
});
test('a fresh pursuit cannot be starved by residual events or mundane routine, while urgent care wins',()=>{
 const pursuit={session:{status:'ended'},pendingKey:'reading'},material={foreground:false,id:'old-manicure'},runtime={kind:'meal'};
 assert.equal(chooseInitiative({pursuit,material,runtime}).kind,'pursuit');
 assert.equal(chooseInitiative({pursuit,material:{...material,foreground:true},runtime}).kind,'material');
 assert.equal(chooseInitiative({pursuit,need:{needChannel:'emotional'}}).kind,'need');
});
test('bundled interests cover distinct subjects and use hour sessions with multiday progression',()=>{
 assert.ok(catalog.items.length>=12);assert.ok(new Set(catalog.items.map(x=>x.category)).size>=6);
 for(const item of catalog.items){assert.ok(item.sessionMinutes>=60&&item.sessionMinutes<=90);assert.ok(item.stageWaitHours>=48);assert.ok(item.restHours>=48);assert.equal(item.stages.length,4);}
});
