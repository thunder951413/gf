import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { createApp } from '../server.mjs';

// Explicit real-provider replay. All writes and generated turns stay in private
// copies; each clock is immediately before the corresponding original message.
if(!process.argv.includes('--run')){console.log('Use --run for a bounded, isolated replay.');process.exit(0);}
const labelIndex=process.argv.indexOf('--label'),label=labelIndex>=0?process.argv[labelIndex+1]:'';
if(label&&!/^[a-z0-9-]{1,40}$/.test(label))throw new Error('Invalid replay label');
const folder=path.resolve('.runtime/adjacent-dialogue-20260920'+(label?'-'+label:''));
fs.mkdirSync(folder,{recursive:true,mode:0o700});
const report=path.join(folder,'results.json');
if(fs.existsSync(report))throw new Error('Replay results already exist; inspect before spending again.');
const source=new DatabaseSync('data/life.sqlite',{readOnly:true});
const cases=[
  {name:'respond-to-her-opinion',at:'2026-09-20T06:26:00Z',id:'3b983df1-c095-4336-bef4-0cc4ba631b8b'},
  {name:'correct-the-misunderstanding',at:'2026-09-20T06:27:00Z',id:'978b2afb-88f1-4616-8764-ccee2922c663'},
];
for(const c of cases){c.text=source.prepare("SELECT text FROM messages WHERE id=? AND speaker='user'").get(c.id)?.text;if(!c.text)throw new Error('Missing replay input');}
const snapshot=path.join(folder,'source.sqlite');await backup(source,snapshot);source.close();fs.chmodSync(snapshot,0o600);
const results=[];let requests=0,requestBytes=0;const usage=[];
for(const c of cases){
  const dir=path.join(folder,c.name);fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.copyFileSync(snapshot,path.join(dir,'life.sqlite'));
  fs.copyFileSync('data/provider.json',path.join(dir,'provider.json'));fs.chmodSync(path.join(dir,'provider.json'),0o600);
  const wire=[];let app;
  try{
    app=await createApp({dataDir:dir,clock:()=>new Date(c.at),env:{},dynamicCompanion:true,semanticUnderstanding:true,dialogueMemory:true,discussionTopics:true,materialPresentation:'generated',turnReaction:false,
      startDiscovery:false,startWeixin:false,startChatQueue:false,startProactive:false,startRecall:false,startResearch:false,startLife:false,startRuntime:false,startLifeThreads:false,startPursuits:false,startDossiers:false,replySleep:async()=>{},
      fetchImpl:async(url,init)=>{const bytes=Buffer.byteLength(init.body);if(requests>=6||requestBytes+bytes>380000)throw new Error('Replay request budget reached');requests++;requestBytes+=bytes;
        const response=await fetch(url,init),body=await response.clone().json();usage.push(body.usage||{});wire.push({request:JSON.parse(init.body),response:body});return response;}});
    app.preferences.setReplyPace('instant');const {port}=await app.listen(0);
    const response=await fetch(`http://127.0.0.1:${port}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:'miyue',text:c.text})});const value=await response.json();
    const trace=app.store.db.prepare('SELECT payload FROM dialogue_traces ORDER BY rowid DESC LIMIT 1').get();
    const row={name:c.name,at:c.at,input:c.text,status:response.status,reply:value.messages?.filter(x=>x.speaker==='assistant').map(x=>x.text).join('\n')||value,trace:trace?JSON.parse(trace.payload):null,wire};results.push(row);
    fs.writeFileSync(path.join(folder,'partial-results.json'),JSON.stringify(results,null,2),{mode:0o600});
    console.log(JSON.stringify({name:row.name,status:row.status,reply:row.reply,selectedMemories:row.trace?.retrieval.selected.length,dynamicsStatus:row.trace?.dynamicsStatus}));
  }finally{if(app)await app.close();fs.rmSync(path.join(dir,'provider.json'),{force:true});}
}
const totals={requests,requestBytes,inputTokens:usage.reduce((n,u)=>n+(u.prompt_tokens||0),0),outputTokens:usage.reduce((n,u)=>n+(u.completion_tokens||0),0)};
fs.writeFileSync(report,JSON.stringify({results,totals},null,2),{mode:0o600});console.log(JSON.stringify(totals));
