import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createApp} from '../../server.mjs';
if(!process.argv.includes('--live'))throw Error('Use --live for actual configured model calls');
const folder=path.dirname(new URL(import.meta.url).pathname),dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'life-live-'));fs.chmodSync(dataDir,0o700);
fs.copyFileSync('data/provider.json',path.join(dataDir,'provider.json'));fs.chmodSync(path.join(dataDir,'provider.json'),0o600);
let now=new Date('2026-09-08T02:00:00Z'),app;const report={turns:[],requests:[],review:'pending'};
const save=()=>fs.writeFileSync(path.join(folder,process.argv.includes('--only-proactive')?'live-proactive-check.json':'live-results.json'),JSON.stringify(report,null,2));
try{
 app=await createApp({dataDir,env:{},initialFeeds:[],startProactive:false,startRuntime:false,startRecall:false,startResearch:false,startDossiers:false,startLifeThreads:false,startChatQueue:false,startPursuits:false,clock:()=>now,random:()=>.4,runtimeRandom:()=>.1,replySleep:async()=>{},fetchImpl:async(url,init)=>{const p=JSON.parse(init.body);report.requests.push({model:p.model,maxTokens:p.max_tokens,messages:p.messages});return fetch(url,init);}});
 const saveChat=app.store.saveChatTurn.bind(app.store);app.store.saveChatTurn=options=>saveChat({...options,afterSave:rows=>{for(const row of rows){row.createdAt=now.toISOString();app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(row.createdAt,row.id);}options.afterSave?.(rows);}});
 const{port}=await app.listen(0);report.model=app.model.effective().model;
 const scenarios=[
 ['work','2026-09-08T02:00:00Z','你现在在做什么呀？'],
 ['followup','2026-09-08T02:02:00Z','刚才那件事，你觉得哪一点最难？具体说说。'],
 ['cafe','2026-09-08T11:10:00Z','忙完了，我来找你聊会儿。你在哪呢？'],
 ['affection','2026-09-08T11:12:00Z','今天有点累，想抱抱你，靠一会儿。'],
 ['depth','2026-09-08T11:15:00Z','我想认真聊聊咖啡馆为什么让人更容易专注。结合你的观察多展开一点，不用急着结束。'],
 ['sleep','2026-09-08T17:00:00Z','还醒着吗？刚刚想起你了。']
 ];
 for(const[id,at,text]of (process.argv.includes('--only-proactive')?[]:scenarios)){now=new Date(at);const before=report.requests.length,start=Date.now(),state=app.companionRuntime.advance();const r=await fetch(`http://127.0.0.1:${port}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:'miyue',text})});const body=await r.json();const row={id,at,text,current:state.current,status:r.status,reply:body.messages?.at(-1)?.text||'',error:body.error,ms:Date.now()-start,calls:report.requests.length-before};report.turns.push(row);save();console.log(JSON.stringify(row));}
 app.proactiveRepo.saveSettings({enabled:true,activeStart:'00:00',activeEnd:'23:59',desktopNotifications:false,dailyLimit:12});
 now=new Date('2026-09-09T10:50:00Z');app.companionRuntime.advance();now=new Date('2026-09-09T11:00:00Z');const state=app.companionRuntime.advance(),before=report.requests.length,start=Date.now();const proactive=await app.proactive.runNow({roleId:'miyue'});report.turns.push({id:'proactive-cafe',at:now.toISOString(),current:state.current,opportunity:state.pending,delivered:proactive.delivered,reason:proactive.reason,reply:proactive.message?.text||'',calls:report.requests.length-before,ms:Date.now()-start});console.log(JSON.stringify(report.turns.at(-1)));
 report.usage=app.usage.snapshot();
}catch(e){report.error=e.message;process.exitCode=1;}finally{if(app)await app.close();fs.rmSync(dataDir,{recursive:true,force:true});save();}
