import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../server.mjs';
const root=path.resolve(import.meta.dirname,'..');
const scenarios=[
 ['breakfast','2026-10-06T00:25:00Z','早上想和你聊聊，你今天早餐想吃点什么？'],
 ['lunch','2026-10-06T04:20:00Z','到饭点了，随便讲讲你想吃的东西和你自己的口味。'],
 ['free-time','2026-10-06T06:45:00Z','放假闲下来，你最近有什么想看的、想玩的或者觉得有意思的？随便聊一个。'],
 ['news','2026-10-06T09:00:00Z','今天有没有什么值得聊的新闻？挑一件说说你的看法，细节拿不准先查。'],
 ['products','2026-10-06T10:00:00Z','最近有什么新出的产品让你感兴趣？说说具体哪里有意思，别编价格和参数。'],
 ['series','2026-10-06T12:00:00Z','晚上放松一下，你最近有什么想看的剧？聊具体一点，不知道剧情就先查。'],
 ['film','2026-10-06T12:40:00Z','那电影呢，找一部聊聊，你自己会对哪一点感兴趣？'],
 ['open-sharing','2026-10-06T13:15:00Z','你还有什么新鲜的东西也可以分享给我，生活、音乐、吃的或者旅行都行，不用问我先选什么。'],
];
const onlyIndex=process.argv.indexOf('--only'),only=onlyIndex>=0?new Set((process.argv[onlyIndex+1]||'').split(',')):null;
if(only&&[...only].some(id=>!scenarios.some(s=>s[0]===id)))throw Error('Unknown --only scenario');
const selectedScenarios=only?scenarios.filter(s=>only.has(s[0])):scenarios;
if(!process.argv.includes('--live')){console.log(JSON.stringify({mode:'dry-run',networkCalls:0,scenarios:scenarios.map(([id,at,user])=>({id,at,user})),sourceCatalog:'app-data/daily-information-sources.json',collection:'RSS and public title indexes; no model summaries',limits:{modelCalls:100,reportedTokens:600000}},null,2));process.exit(0);}
const index=process.argv.indexOf('--label'),label=process.argv[index+1];if(!/^[a-z0-9][a-z0-9-]{0,39}$/u.test(label||''))throw Error('Unique --label required');
const out=path.join(root,'.runtime/daily-information',label);if(fs.existsSync(out))throw Error('Label already exists');fs.mkdirSync(out,{recursive:true,mode:0o700});
const config=JSON.parse(fs.readFileSync(path.join(root,'data/provider.json'),'utf8'));
for(const line of fs.readFileSync(path.join(root,'.env.local'),'utf8').split(/\r?\n/u)){
 const m=line.match(/^\s*(LIFE_MODEL_BASE_URL|LIFE_MODEL_NAME|LIFE_MODEL_API_KEY|LIFE_FEED_PROXY)\s*=\s*(.*?)\s*$/u);if(!m)continue;
 const value=process.env[m[1]]||m[2].replace(/^(["'])(.*)\1$/u,'$2');
 if(m[1]==='LIFE_FEED_PROXY')process.env[m[1]]=value;else config[({LIFE_MODEL_BASE_URL:'baseUrl',LIFE_MODEL_NAME:'model',LIFE_MODEL_API_KEY:'apiKey'})[m[1]]]=value;
}
let now=new Date('2026-10-06T00:25:00Z');
const report={model:config.model,isolation:'independent SQLite; external deliveries and background jobs disabled',calls:0,tokens:0,turns:[],outputFields:[]};
const app=await createApp({dataDir:path.join(out,'data'),initialFeeds:[],activeRoleIds:['miyue'],disableStory:true,dynamicCompanion:true,sessionDialogue:true,dialogueMemory:true,
 startProactive:false,startLife:false,startRuntime:false,startDiscovery:false,startDailyInformation:false,startWeixin:false,startResearch:false,startRecall:false,startCharacterGrowth:false,startDailyLife:false,startLifeThreads:false,startPursuits:false,startDossiers:false,startChatQueue:false,
 clock:()=>now,env:{LIFE_MODEL_BASE_URL:config.baseUrl,LIFE_MODEL_NAME:config.model,LIFE_MODEL_API_KEY:config.apiKey||''},
 fetchImpl:async(url,init)=>{if(++report.calls>100||report.tokens>=600000)throw Error('EVALUATION_BUDGET_EXCEEDED');const response=await fetch(url,init);const result=await response.clone().json();report.tokens+=result.usage?.total_tokens||0;try{const value=JSON.parse(result.choices?.[0]?.message?.content);report.outputFields.push({call:report.calls,keys:Object.keys(value),informationId:value.informationId??null,materialId:value.initiative?.materialId??null});}catch{}return response;}});
const write=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2),{mode:0o600});
try{
 app.preferences.setReplyPace('instant');const {port}=await app.listen(0);
 const callsBefore=report.calls;report.collection=await app.dailyInformation.refresh({force:true});report.collectionModelCalls=report.calls-callsBefore;report.library=app.dailyInformation.status();write();
 console.log(JSON.stringify({collection:report.collection,categories:report.library.categories,total:report.library.total,modelCalls:report.collectionModelCalls}));
 for(const [id,at,user] of selectedScenarios){
  now=new Date(at);const started=Date.now();
  const response=await fetch(`http://127.0.0.1:${port}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:'miyue',text:user}),signal:AbortSignal.timeout(150000)}),body=await response.json();
  report.turns.push({id,user,status:response.status,latencyMs:Date.now()-started,reply:body.messages?.filter(m=>m.speaker==='assistant').map(m=>m.text).join('\n'),error:body.error||null,trace:app.dialogueTraces.list({roleId:'miyue',limit:1})[0]});write();console.log(JSON.stringify({scenario:id,status:response.status,calls:report.calls,tokens:report.tokens}));
 }
 app.proactiveRepo.saveSettings({enabled:true,activeStart:'00:00',activeEnd:'23:59',dailyLimit:12,desktopNotifications:false});
 report.proactive=await app.proactive.runNow({roleId:'miyue'});report.proactiveTrace=app.dialogueTraces.list({roleId:'miyue',limit:1})[0];
 report.deliveries=app.dailyInformation.recent('miyue',20);report.finalLibrary=app.dailyInformation.status();report.finishedAt=new Date().toISOString();write();
 console.log(JSON.stringify({report:path.join(out,'report.json'),calls:report.calls,tokens:report.tokens,deliveredTopics:report.deliveries.length,proactiveDelivered:report.proactive.delivered}));
}finally{await app.close();fs.rmSync(path.join(out,'data/provider.json'),{force:true});write();}
