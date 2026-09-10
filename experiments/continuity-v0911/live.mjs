// Run against an isolated SQLite copy; never submit a test turn to port 8765.
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../../server.mjs';

const folder=path.resolve('.runtime/continuity-v0911');
const run=process.argv[2]||'v1';
if(!/^v[1-9][0-9]*$/.test(run))throw Error('Invalid experiment revision');
const dataDir=path.join(folder,'model-clone-'+run);
const output=path.join(folder,'model-result-'+run+'.json');
if(fs.existsSync(output))throw Error('Existing paid simulation is preserved; do not repeat implicitly.');
fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
fs.copyFileSync(path.join(folder,'before.sqlite'),path.join(dataDir,'life.sqlite'));
fs.copyFileSync('data/provider.json',path.join(dataDir,'provider.json'));
fs.chmodSync(path.join(dataDir,'provider.json'),0o600);
let now=new Date();
const result={model:null,turns:[],requests:[]};
const save=()=>fs.writeFileSync(output,JSON.stringify(result,null,2),{mode:0o600});
const app=await createApp({dataDir,startProactive:false,startRecall:false,startResearch:false,startDossiers:false,replySleep:async()=>{},clock:()=>new Date(now),
  fetchImpl:async(url,init)=>{result.requests.push(JSON.parse(init.body));save();return fetch(url,init);},
});
result.model=app.model.publicConfig().model;
const {port}=await app.listen(0);
const scenarios=[
  {text:'你最近在读什么？挑一个你自己在意的细节跟我说说。'},
  {text:'怎么说？'},
  {text:'这点我也有共鸣，有时太追求结果就反而忘了当时自己的感觉。'},
  {text:'后来呢',advanceHours:80},
  {text:'这本书现在读到哪里了？'},
  {text:'先不聊书了，今天有点累，想听你软软地撒个娇。'},
];
try{
  for(const scenario of scenarios){
    if(scenario.advanceHours)now=new Date(+now+scenario.advanceHours*3600000);
    const started=Date.now(),beforeCalls=result.requests.length;
    const response=await fetch(`http://127.0.0.1:${port}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:'miyue',text:scenario.text})});
    const body=await response.json(),message=body.messages?.at(-1);
    const row={user:scenario.text,at:now.toISOString(),status:response.status,reply:message?.text,error:body.error,receipt:message?app.interactionPolicy.receipt(message.id):null,callCount:result.requests.length-beforeCalls,durationMs:Date.now()-started,pursuit:app.pursuits.get('miyue')?.stage};
    result.turns.push(row);save();
    console.log(JSON.stringify({user:row.user,status:row.status,reply:row.reply,calls:row.callCount,durationMs:row.durationMs}));
  }
  result.usage=app.usage.snapshot().recent.filter(row=>Date.parse(row.createdAt)>=Date.parse(result.turns[0].at));
}finally{save();await app.close();fs.rmSync(path.join(dataDir,'provider.json'),{force:true});}
