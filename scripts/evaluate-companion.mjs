import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createApp } from '../server.mjs';
import { scenarios,suiteVersion } from '../experiments/companionship-v0100/fixtures.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(!process.argv.includes('--live')){
 console.log('真实模型连续对话验收：node scripts/evaluate-companion.mjs --live [--model 模型名称] [--out 输出目录]\n只使用隔离数据库；会调用当前配置的接口并产生费用。结果含逐轮原话、机制检查、耗时和 token。未运行模型。');process.exit(0);
}
const arg=name=>process.argv.includes(name)?process.argv[process.argv.indexOf(name)+1]:undefined;
const runId=new Date().toISOString().replaceAll(':','-');
const folder=path.resolve(arg('--out')||path.join(root,'.runtime','companion-evaluations',runId));
fs.mkdirSync(folder,{recursive:true,mode:0o700});
const output=path.join(folder,'report.json');if(fs.existsSync(output))throw Error('已有报告，拒绝覆盖。请换一个输出目录。');
const dataDir=path.join(folder,'isolated-data');fs.mkdirSync(dataDir,{mode:0o700});
const provider=JSON.parse(fs.readFileSync(path.join(root,'data/provider.json'),'utf8'));if(arg('--model'))provider.model=arg('--model');
fs.writeFileSync(path.join(dataDir,'provider.json'),JSON.stringify(provider),{mode:0o600});
let now=new Date();const report={suiteVersion,runId,model:provider.model,providerFingerprint:createHash('sha256').update(String(provider.baseUrl||'')+':'+provider.model).digest('hex').slice(0,16),reviewStatus:'pending-human-review',turns:[],requests:[],checks:[]};
const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2),{mode:0o600});
let app;
try{
 app=await createApp({dataDir,initialFeeds:[],env:{},startProactive:false,startRecall:false,startResearch:false,startDossiers:false,startLifeThreads:false,replySleep:async()=>{},clock:()=>new Date(now),random:()=>.4,fetchImpl:async(url,init)=>{
  const request=JSON.parse(init.body);report.requests.push({model:request.model,maxTokens:request.max_tokens||request.max_completion_tokens,messages:request.messages});save();return fetch(url,init);
 }});
 // This test-only timestamp adapter makes simulated days real to both the
 // saved-message evidence ledger and the application clock.
 const saveChat=app.store.saveChatTurn.bind(app.store);
 app.store.saveChatTurn=options=>saveChat({...options,afterSave:rows=>{for(const row of rows){row.createdAt=now.toISOString();app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(row.createdAt,row.id);}options.afterSave?.(rows);}});
 const {port}=await app.listen(0);
 for(const scenario of scenarios){
  now=new Date(+now+(scenario.advanceHours||0)*3600000);app.companionAgenda.tick('miyue');
  const started=Date.now(),before=report.requests.length;
  const response=await fetch(`http://127.0.0.1:${port}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:'miyue',text:scenario.text})});
  const result=await response.json(),reply=result.messages?.at(-1)?.text||'',relationship=app.companionRelationship.view('miyue'),agenda=app.companionAgenda.view('miyue');
  const context=report.requests.slice(before).flatMap(r=>r.messages).map(m=>m.content).join('\n');
  const checks={'nickname':relationship.nickname?.value==='阿舟','preference':relationship.preferences.some(p=>p.value.includes('建议')),'relationship':relationship.status.value==='dating','temporary-boundary':relationship.intimacyBoundary==='friendly'&&relationship.status.value==='dating','recommendation':agenda.plans.some(p=>p.recommendation&&p.title==='城南旧事'),'recommendation-context':context.includes('城南旧事')&&agenda.plans.some(p=>p.recommendation&&p.status==='active'),'boundary-expired':relationship.intimacyBoundary==='open','quiet-plan':agenda.plans.some(p=>p.kind==='quiet')};
  const row={id:scenario.id,user:scenario.text,reply,status:response.status,error:result.error,at:now.toISOString(),durationMs:Date.now()-started,calls:report.requests.length-before,reviewPrompt:scenario.review,checks:(scenario.expect||[]).map(name=>({name,pass:checks[name]===true})),relationship,agenda};
  report.turns.push(row);save();console.log(JSON.stringify({id:row.id,status:row.status,reply:row.reply,calls:row.calls,checks:row.checks}));
 }
 report.usage=app.usage.snapshot();
 report.checks=report.turns.flatMap(turn=>[{name:turn.id+':delivery',pass:turn.status===200},...turn.checks.map(check=>({...check,name:turn.id+':'+check.name}))]);
 report.metrics={turns:report.turns.length,calls:report.requests.length,questionTurns:report.turns.filter(t=>/[？?]/u.test(t.reply)).length,meanReplyChars:Math.round(report.turns.reduce((sum,t)=>sum+t.reply.length,0)/report.turns.length),failedChecks:report.checks.filter(c=>!c.pass).length};
}catch(error){report.error=error.message;process.exitCode=1;}finally{
 save();if(app)await app.close();fs.rmSync(path.join(dataDir,'provider.json'),{force:true});
 const text=['# 陪伴连续对话验收',`模型：${report.model} · 套件：${suiteVersion}`,`人工自然度审阅：${report.reviewStatus}。程序检查仅验证状态、记录和投递，不替代原话审阅。`,...report.turns.flatMap(t=>[`## ${t.id}`,`用户：${t.user}`,`林雨薇：${t.reply||t.error}`,`耗时 ${(t.durationMs/1000).toFixed(1)} 秒 · ${t.calls} 次调用 · HTTP ${t.status}`,`检查：${t.checks.map(c=>c.name+' '+(c.pass?'通过':'失败')).join('；')||'审阅对话内容'}`,`审阅重点：${t.reviewPrompt}`]),`\n指标：${JSON.stringify(report.metrics||{})}`].join('\n\n');
 fs.writeFileSync(path.join(folder,'transcript.md'),text,{mode:0o600});console.log('报告：'+output);
}
