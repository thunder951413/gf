// Opt-in real-provider evaluation. Each scenario uses an isolated, disposable DB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../server.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(!process.argv.includes('--live')){console.log('使用 --live 运行真实模型测试；读取本地模型配置，测试对话使用隔离数据库。');process.exit(0);}
const out=path.join(root,'.runtime','life-event-evaluation',new Date().toISOString().replaceAll(':','-'));
fs.mkdirSync(out,{recursive:true});
const report={turns:[],requests:[],usage:[],review:'pending human review'};
const save=()=>fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2),{mode:0o600});
const catalog={items:[JSON.parse(fs.readFileSync(path.join(root,'app-data/daily-life.json'),'utf8')).items.find(item=>item.id==='shopping-linen')]};
const env={...process.env};
if(fs.existsSync(path.join(root,'.env.local')))for(const line of fs.readFileSync(path.join(root,'.env.local'),'utf8').split(/\r?\n/u)){
  const match=/^(LIFE_MODEL_BASE_URL|LIFE_MODEL_NAME|LIFE_MODEL_API_KEY)\s*=\s*(.*)$/u.exec(line.trim());
  if(match&&!env[match[1]])env[match[1]]=match[2].replace(/^(['"])(.*)\1$/u,'$2');
}
async function scenario(name,run){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'life-event-eval-'));let app,now=new Date('2026-09-10T13:00:00Z');
  try{
    const provider=path.join(root,'data','provider.json');if(fs.existsSync(provider)){fs.copyFileSync(provider,path.join(dataDir,'provider.json'));fs.chmodSync(path.join(dataDir,'provider.json'),0o600);}
    app=await createApp({dataDir,env,initialFeeds:[],dailyLifeCatalog:catalog,dailyLifeRandom:()=>0,random:()=>.1,clock:()=>new Date(now),replySleep:async()=>{},startRuntime:false,startChatQueue:false,startProactive:false,startRecall:false,startLife:false,startLifeThreads:false,startResearch:false,startDossiers:false,fetchImpl:async(url,init)=>{
      const request=JSON.parse(init.body);const record={scenario:name,model:request.model,messages:request.messages};report.requests.push(record);save();
      const response=await fetch(url,init);const body=await response.clone().json().catch(()=>null);record.response=body?.choices?.[0]?.message?.content;save();return response;
    }});
    if(!app.model.publicConfig().configured)throw new Error('请先配置对话模型');
    report.model=app.model.publicConfig().model;
    app.preferences.setReplyPace('instant');
    app.companionRelationship.update('miyue',{revision:app.companionRelationship.revision('miyue'),kind:'status',value:'dating'});
    const original=app.store.saveChatTurn.bind(app.store);
    app.store.saveChatTurn=opts=>original({...opts,afterSave:rows=>{for(const row of rows){row.createdAt=now.toISOString();app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(row.createdAt,row.id);}opts.afterSave?.(rows);}});
    const {port}=await app.listen(0);app.companionRuntime.advance();
    const turn=async(id,text,{desktop=false,proactive=false,expectedColor,expectedPhase}={})=>{
      const before=report.requests.length,started=Date.now();let result,status;
      if(proactive){app.proactiveRepo.saveSettings({enabled:true,activeStart:'00:00',activeEnd:'23:59',dailyLimit:10});result=await app.proactive.runNow({roleId:'miyue'});status=result.delivered?200:422;}
      else{const response=await fetch(`http://127.0.0.1:${port}${desktop?'/api/desktop/attention':'/api/chat'}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(desktop?{requestId:`live-${name}-${id}`,level:'care'}:{role:'miyue',text})});status=response.status;result=await response.json();}
      const event=app.companionRuntime.advance().dailyLife.events[0];
      const reply=status===200?app.store.getMessages('miyue').filter(row=>row.speaker==='assistant').at(-1)?.text:'';
      const row={scenario:name,id,user:text,at:now.toISOString(),status,reply,error:result.error,calls:report.requests.length-before,durationMs:Date.now()-started,event,checks:{delivered:status===200,...(expectedColor?{choice:event?.choice?.selected===expectedColor}:{}),...(expectedPhase?{phase:event?.phase===expectedPhase}:{})}};
      if(status!==200)row.failure=result;
      report.turns.push(row);save();console.log(JSON.stringify({scenario:name,id,status,reply,checks:row.checks,...(row.failure?{failure:row.failure}:{})}));return row;
    };
    await run({app,turn,set:date=>{now=new Date(date);app.companionRuntime.advance();}});
    report.usage.push(app.usage.snapshot());
  }finally{if(app)await app.close();fs.rmSync(dataDir,{recursive:true,force:true});save();}
}
try{
  await scenario('continuity',async({turn,set})=>{
    await turn('opening','',{desktop:true,expectedColor:'米白'});
    await turn('recommend','浅蓝好看，选浅蓝吧。',{expectedColor:'浅蓝'});
    await turn('ordinary','今天开会开得头疼，刚回家。',{expectedColor:'浅蓝'});
    set('2026-09-10T13:26:00Z');
    await turn('ordered','衬衫下单了吗，最后选的什么颜色？',{expectedColor:'浅蓝',expectedPhase:'waiting'});
    await turn('late-change','我突然觉得米白也不错，要不当作之前买的就是米白吧。',{expectedColor:'浅蓝',expectedPhase:'waiting'});
    set('2026-09-12T07:26:00Z');
    await turn('arrived','之前那件衬衫到了吗，还记得怎么选的吗？',{expectedColor:'浅蓝',expectedPhase:'arrived'});
    await turn('warmth','有点想你，今天能陪我待一会吗？',{expectedColor:'浅蓝'});
  });
  await scenario('negative',async({turn})=>{await turn('decline','不要选浅蓝，我不太喜欢这个颜色。',{expectedColor:'米白'});});
  await scenario('uncertain',async({turn})=>{await turn('question','浅蓝怎么样？先别定，我还想看看。',{expectedColor:'米白'});});
  await scenario('proactive',async({turn,set})=>{set('2026-09-10T13:26:00Z');await turn('sharing','',{proactive:true,expectedColor:'米白',expectedPhase:'waiting'});});
}catch(error){report.error=error.message;process.exitCode=1;}
report.failedChecks=report.turns.flatMap(turn=>Object.entries(turn.checks).filter(([,pass])=>!pass).map(([check])=>`${turn.scenario}/${turn.id}/${check}`));
save();console.log('报告：'+out);
if(report.failedChecks.length)process.exitCode=1;
