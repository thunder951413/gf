import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { createApp } from '../server.mjs';

if (!process.argv.includes('--live')) {
  console.log('用法：node scripts/evaluate-memory-consolidation.mjs --live [--batches 3]。复制当前原文，在隔离数据库中把时间推进9天测试整理；不发送聊天或微信消息。');
  process.exit(0);
}
const countArg=process.argv.indexOf('--batches');
const batches=countArg<0?3:Number(process.argv[countArg+1]);
if(!Number.isInteger(batches)||batches<1||batches>15)throw Error('batches 必须为1至15');
const folder=path.resolve('.runtime/memory-consolidation');
fs.mkdirSync(folder,{recursive:true,mode:0o700});
const work=fs.mkdtempSync(path.join(folder,'isolated-'));
fs.chmodSync(work,0o700);
const output=path.join(folder,`${Date.now()}.json`);
const report={mode:'isolated-future-clock',requests:[],batches:[],review:null};
let app;
try {
  const source=new DatabaseSync('data/life.sqlite',{readOnly:true});
  const last=source.prepare('SELECT MAX(created_at) at FROM messages').get().at;
  await backup(source,path.join(work,'life.sqlite'));source.close();
  const simulatedNow=new Date(new Date(last).valueOf()+9*86400_000);
  report.simulatedAt=simulatedNow.toISOString();
  const clean=new DatabaseSync(path.join(work,'life.sqlite'));
  clean.exec("DELETE FROM metadata WHERE key LIKE '%weixin%'; DELETE FROM weixin_inbox; DELETE FROM weixin_outbox; DELETE FROM chat_queue; DELETE FROM reply_delivery;");clean.close();
  fs.chmodSync(path.join(work,'life.sqlite'),0o600);
  fs.copyFileSync('data/provider.json',path.join(work,'provider.json'));fs.chmodSync(path.join(work,'provider.json'),0o600);
  const env={};
  for(const line of fs.readFileSync('.env.local','utf8').split(/\r?\n/)){
    const m=line.match(/^(LIFE_MODEL_(?:BASE_URL|NAME|API_KEY))=(.*)$/);
    if(m)env[m[1]]=m[2].trim().replace(/^(['"])(.*)\1$/,'$2');
  }
  app=await createApp({dataDir:work,env,clock:()=>simulatedNow,initialFeeds:[],startWeixin:false,startChatQueue:false,startProactive:false,startRecall:false,startResearch:false,startRuntime:false,startDossiers:false,startLifeThreads:false,reminderIntervalMs:86400_000,
    fetchImpl:async(url,options)=>{
      const body=JSON.parse(options.body),entry={model:body.model,messages:body.messages};report.requests.push(entry);
      const response=await fetch(url,options),payload=await response.clone().json().catch(()=>null);
      entry.output=payload?.choices?.[0]?.message?.content;entry.usage=payload?.usage;return response;
    }});
  const apply=app.recallRepo.consolidated.apply.bind(app.recallRepo.consolidated);
  app.recallRepo.consolidated.apply=(...args)=>{try{return apply(...args);}catch(error){(report.validationErrors??=[]).push({code:error.code,message:error.message});throw error;}};
  const start=app.recallRepo.consolidated.snapshot('miyue');report.before=start;
  for(let i=0;i<batches;i++){
    const result=await app.recall.run('miyue',{force:true});report.batches.push(result);
    console.log(JSON.stringify({batch:i+1,status:result.status,count:result.summarizedCount,stats:result.stats,reason:result.reason}));
    if(result.status!=='updated')break;
  }
  report.review=app.recallRepo.consolidated.review('miyue');
  report.shortTerm=app.recallRepo.shortTermConversation('miyue').map(row=>({id:row.id,chars:row.text.length}));
  const before=app.recallRepo.consolidated.snapshot('miyue');
  report.context=app.recallRepo.longTermContext('miyue');
  report.contextStable=report.context===app.recallRepo.longTermContext('miyue');
  report.readDidNotMutate=JSON.stringify(before)===JSON.stringify(app.recallRepo.consolidated.snapshot('miyue'));
} finally {
  if(app)await app.close();
  fs.rmSync(work,{recursive:true,force:true});
  fs.writeFileSync(output,JSON.stringify(report,null,2),{mode:0o600});
  console.log('Report: '+output);
}
