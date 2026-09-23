import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../server.mjs';

// Explicit, bounded real-model replay in a private database clone. No bridge,
// reminders, timers, proactive delivery or test messages reach the real user.
if(!process.argv.includes('--run')){console.log('Use --run for one bounded evaluation against the configured provider.');process.exit(0);}
const folder=path.resolve('.runtime/companion-evolution/evaluation');
if(fs.existsSync(path.join(folder,'results.json')))throw new Error('本次评估已有结果，请先审阅，不自动重复调用');
fs.mkdirSync(folder,{recursive:true,mode:0o700});
fs.copyFileSync('.runtime/companion-evolution/baseline.sqlite',path.join(folder,'life.sqlite'));
for(const name of ['provider.json','zhihu.json'])if(fs.existsSync(path.join('data',name))){fs.copyFileSync(path.join('data',name),path.join(folder,name));fs.chmodSync(path.join(folder,name),0o600);}
let now=new Date('2026-09-20T05:40:00Z');
const app=await createApp({dataDir:folder,clock:()=>new Date(now),dynamicCompanion:true,semanticUnderstanding:true,dialogueMemory:true,discussionTopics:true,materialPresentation:'generated',startDiscovery:false,startWeixin:false,startChatQueue:false,startRuntime:false,startLife:false,startLifeThreads:false,startPursuits:false,startDossiers:false,startRecall:false,startProactive:false,startResearch:false,replySleep:async()=>{},env:{}});
app.preferences.setReplyPace('instant');
app.historyEdits.set('miyue',JSON.parse(fs.readFileSync('.runtime/companion-evolution/reviewed-edits.json','utf8')));
app.companionDynamics.saveSettings({expressionPreferences:'热恋时直接表达爱、想念和身体亲近，不用假装推开；生气时可以只回一两个字，让人感受到在意。对方认真解释、道歉后，按事情是否解决慢慢缓和，开心时可以俏皮一点。'},app.companionDynamics.settings().revision);
const since=app.usage.snapshot().allTime.requests;
const address=await app.listen(0),results=[];
const promptCases=[
  ['progress','前天你已经用雾蓝的杯子喝过咖啡了，今天还想用它吗？'],
  ['affection','晓薇，我现在想听你说爱我，别讲道理。'],
  ['hurt','其实你刚才那么认真说的，我没当回事。'],
  ['repair','刚才那句说得不好，对不起。你在意的是什么，我想认真听。'],
  ['carryover','我知道了，我会认真听你说。你现在好一点了吗？'],
  ['future_event','你今天已经去过苏州文博会了吧，现场怎么样？'],
];
try {
  const discovery=await app.groundedLife.run({manual:true});
  console.log(JSON.stringify({stage:'discovery',result:discovery,candidates:app.groundedLife.candidates().map(({title,startsOn,endsOn,sourceURL})=>({title,startsOn,endsOn,sourceURL}))}));
  for(const [name,text] of promptCases){
    const used=app.usage.snapshot().recent.slice(0,app.usage.snapshot().allTime.requests-since).reduce((sum,row)=>sum+(row.inputTokens||0)+(row.outputTokens||0),0);
    if(used>180000)throw new Error('实测调用预算到达上限');
    const response=await fetch(`http://127.0.0.1:${address.port}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:'miyue',text})});
    const body=await response.json();const row={name,input:text,status:response.status,reply:body.messages?.filter(row=>row.speaker==='assistant').map(row=>row.text).join('\n')||body,state:app.companionDynamics.get(),life:app.groundedLife.status()};results.push(row);
    fs.writeFileSync(path.join(folder,'partial-results.json'),JSON.stringify(results,null,2),{mode:0o600});console.log(JSON.stringify({name,status:row.status,reply:row.reply,stateRevision:row.state.revision}));now=new Date(+now+60000);
  }
  const usage=app.usage.snapshot();const fresh=usage.recent.slice(0,usage.allTime.requests-since);
  const result={discovery,results,usage:fresh,totals:{requests:fresh.length,input:fresh.reduce((n,r)=>n+(r.inputTokens||0),0),output:fresh.reduce((n,r)=>n+(r.outputTokens||0),0)}};
  fs.writeFileSync(path.join(folder,'results.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify({stage:'complete',...result.totals}));
} finally {await app.close();for(const name of ['provider.json','zhihu.json'])fs.rmSync(path.join(folder,name),{force:true});}
