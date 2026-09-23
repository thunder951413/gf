import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../server.mjs';

// Synthetic dialogues only. Provider settings may be copied, never real chats;
// all background workers and external deliveries remain disabled.
export const SCENARIOS=[
 {id:'philosophy',opening:'user',turns:['聊点哲学吧，挑一个你自己觉得有意思的问题。','我倒觉得这和人怎么定义自己有关，未必有唯一答案。','那你更倾向于哪一种理解？','嗯，有点意思。','今天先不聊这个了，我还得回一封邮件。']},
 {id:'psychology-geography',opening:'user',turns:['聊聊心理学，日常生活里有什么值得琢磨的？','这是不是也有适用边界？','我不太想聊这个具体话题，但不是不喜欢心理学。','换成地理吧，讲个有趣的角度。','这种地理话题我挺喜欢，以后可以多聊一点。']},
 {id:'history-boundary',opening:'user',turns:['想听点历史，别像上课一样。','换一个角度怎么看呢？','这个解释也可能忽略了普通人的选择吧。','历史我最近不想聊了，以后少主动聊历史。','今天有点累，只想靠着你待一会儿。']},
 {id:'proactive',opening:'proactive',turns:['你刚才这个想法我倒不完全同意。','可以再讲具体一点吗？','我先忙一会儿，晚点再看。']},
];

const arg=name=>{const i=process.argv.indexOf(name);return i<0?null:process.argv[i+1];};
function providerEnv(root){
 const env={};const file=path.join(root,'.env.local');
 if(fs.existsSync(file))for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){
  const match=/^(LIFE_MODEL_[A-Z_]+)=(.*)$/.exec(line.trim());
  if(match)env[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2');
 }
 for(const [key,value] of Object.entries(process.env))if(key.startsWith('LIFE_MODEL_'))env[key]=value;
 return env;
}
function writeReport(file,data){fs.writeFileSync(file,JSON.stringify(data,null,2),{mode:0o600});}
export async function evaluate({label,variants=['baseline','candidate'],scenarios=SCENARIOS,root=process.cwd()}={}){
 if(!/^[a-zA-Z0-9_-]+$/.test(label||''))throw Error('A unique --label is required');
 const dir=path.join(root,'.runtime/discussion-topics');fs.mkdirSync(dir,{recursive:true});
 const output=path.join(dir,label+'.json');if(fs.existsSync(output))throw Error('Report already exists');
 const report={label,syntheticOnly:true,manualReviewRequired:true,scenarios:[]};writeReport(output,report);
 for(const scenario of scenarios)for(const variant of variants){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'discussion-eval-'));fs.chmodSync(dataDir,0o700);let app;
  const row={id:scenario.id,variant,turns:[],requests:[]};report.scenarios.push(row);
  try{
   const provider=path.join(root,'data/provider.json');if(fs.existsSync(provider)){fs.copyFileSync(provider,path.join(dataDir,'provider.json'));fs.chmodSync(path.join(dataDir,'provider.json'),0o600);}
   let now=new Date('2026-09-16T12:00:00.000Z');
   app=await createApp({dataDir,env:providerEnv(root),clock:()=>new Date(now),discussionTopics:variant==='candidate',semanticUnderstanding:true,dialogueMemory:true,turnReaction:false,sourceRelevance:true,materialPresentation:'generated',discussionRandom:()=>.1,random:()=>.4,initialFeeds:[],startWeixin:false,startChatQueue:false,startProactive:false,startRecall:false,startResearch:false,startRuntime:false,startDossiers:false,startPursuits:false,startLife:false,startLifeThreads:false,replySleep:async()=>{},
    fetchImpl:async(url,init)=>{const body=JSON.parse(init.body),started=Date.now();const response=await fetch(url,init),data=await response.clone().json().catch(()=>null);row.requests.push({semantic:body.messages[0]?.content?.startsWith('Classify the current Chinese companion-dialogue turn.'),model:body.model,messages:body.messages,output:data?.choices?.[0]?.message?.content,usage:data?.usage,durationMs:Date.now()-started,status:response.status});return response;}});
   app.preferences.setReplyPace('instant');const {port}=await app.listen(0);
   if(scenario.opening==='proactive'){
    const before=row.requests.length;const result=await app.proactive.contact({manual:true,roleId:'miyue'});
    row.turns.push({trigger:'proactive',result,calls:row.requests.length-before,profile:app.discussionTopics?.profile()||null});
   }
   for(const text of scenario.turns){
    now=new Date(+now+60_000);const before=row.requests.length;
    const response=await fetch(`http://127.0.0.1:${port}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:'miyue',text})});
    const data=await response.json();row.turns.push({text,status:response.status,reply:(data.messages||[]).filter(m=>m.speaker==='assistant').map(m=>m.text).join('\n'),error:data.error||null,calls:row.requests.length-before,profile:app.discussionTopics?.profile()||null});
    writeReport(output,report);
   }
   row.totals={calls:row.requests.length,promptTokens:row.requests.reduce((sum,r)=>sum+(r.usage?.prompt_tokens||0),0),completionTokens:row.requests.reduce((sum,r)=>sum+(r.usage?.completion_tokens||0),0)};
  }catch(error){row.error={message:error.message};}
  finally{if(app)await app.close();fs.rmSync(dataDir,{recursive:true,force:true});writeReport(output,report);}
 }
 report.completedAt=new Date().toISOString();writeReport(output,report);return{output,totals:report.scenarios.map(r=>({id:r.id,variant:r.variant,...r.totals,error:r.error}))};
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
 if(!process.argv.includes('--live'))console.log(JSON.stringify({valid:true,networkCalls:0,scenarios:SCENARIOS.map(s=>({id:s.id,turns:s.turns.length,opening:s.opening})),manualReviewRequired:true}));
 else evaluate({label:arg('--label'),variants:arg('--variants')?.split(',')||['baseline','candidate'],scenarios:arg('--scenario')?SCENARIOS.filter(s=>s.id===arg('--scenario')):SCENARIOS}).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
}
