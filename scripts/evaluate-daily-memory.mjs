import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync, backup } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { buildSessionMessages } from '../lib/session-dialogue.mjs';
import { prepareSessionGuidance, applySessionGuidance } from '../lib/session-guidance.mjs';

if(!process.argv.includes('--live')){console.log(JSON.stringify({mode:'dry-run',networkCalls:0,scope:'隔离副本；配置模型压缩与核对；相同历史比较旧模式、紧凑包装、按日压缩',limits:{calls:120,tokens:1200000}}));process.exit(0);}
const label=process.argv[process.argv.indexOf('--label')+1];if(!/^[a-z0-9-]{3,50}$/u.test(label||''))throw new Error('需要新的 --label');
const root=process.cwd(),out=path.join(root,'.runtime','daily-memory',label);if(fs.existsSync(out))throw new Error('标签已存在');fs.mkdirSync(out,{recursive:true,mode:0o700});
const dataDir=path.join(out,'data');fs.mkdirSync(dataDir,{mode:0o700});
const baselineArg=process.argv.indexOf('--baseline-from'),baselineFile=baselineArg<0?null:path.resolve(process.argv[baselineArg+1]);
const source=new DatabaseSync(baselineFile&&!process.argv.includes('--fresh-source')?path.join(path.dirname(baselineFile),'data','life.sqlite'):path.join(root,'data','life.sqlite'),{readOnly:true});
const messagesDigest=db=>createHash('sha256').update(JSON.stringify(db.prepare('SELECT id,role,speaker,text,kind,created_at FROM messages ORDER BY rowid').all())).digest('hex');
const sourceDigest=messagesDigest(source);
if(baselineFile){const priorDB=new DatabaseSync(path.join(path.dirname(baselineFile),'data','life.sqlite'),{readOnly:true});const priorDigest=messagesDigest(priorDB);priorDB.close();if(priorDigest!==sourceDigest)throw new Error('比较基线的原始消息已变化');}
await backup(source,path.join(dataDir,'life.sqlite'));source.close();fs.chmodSync(path.join(dataDir,'life.sqlite'),0o600);
let config=JSON.parse(fs.readFileSync(path.join(root,'data','provider.json'),'utf8'));
const envFile=path.join(root,'.env.local');if(fs.existsSync(envFile))for(const line of fs.readFileSync(envFile,'utf8').split(/\r?\n/u)){
  const m=line.match(/^\s*(LIFE_MODEL_BASE_URL|LIFE_MODEL_NAME|LIFE_MODEL_API_KEY)\s*=\s*(.*?)\s*$/u);if(m)config[({LIFE_MODEL_BASE_URL:'baseUrl',LIFE_MODEL_NAME:'model',LIFE_MODEL_API_KEY:'apiKey'})[m[1]]]=process.env[m[1]]||m[2].replace(/^(["'])(.*)\1$/u,'$2');
}
let calls=0,tokens=0;const report={model:config.model,sourceDigest,startedAt:new Date().toISOString(),modes:[],limits:{calls:120,tokens:1200000}};
const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({...report,calls,tokens},null,2),{mode:0o600});
const latestDB=new DatabaseSync(path.join(dataDir,'life.sqlite'),{readOnly:true});const latest=JSON.parse(latestDB.prepare("SELECT payload FROM dialogue_traces WHERE json_extract(payload,'$.mode')='session' ORDER BY rowid DESC LIMIT 1").get().payload);latestDB.close();
const atArg=process.argv.indexOf('--at');const now=atArg>=0?new Date(process.argv[atArg+1]):process.argv.includes('--clock-now')?new Date():new Date(latest.createdAt);if(!Number.isFinite(+now))throw new Error('--at时间无效');report.at=now.toISOString();
let app;
try{
  app=await createApp({dataDir,activeRoleIds:['miyue'],disableStory:true,sessionDialogue:true,dynamicCompanion:true,dialogueMemory:true,
    clock:()=>now,env:{LIFE_MODEL_BASE_URL:config.baseUrl,LIFE_MODEL_NAME:config.model,LIFE_MODEL_API_KEY:config.apiKey||''},
    initialFeeds:[],startWeixin:false,startRecall:false,startProactive:false,startDiscovery:false,startResearch:false,startReminders:false,startRuntime:false,startLife:false,startChatQueue:false,startCharacterGrowth:false,startDailyLife:false,startLifeThreads:false,startPursuits:false,startDossiers:false,
    fetchImpl:async(url,init)=>{if(++calls>120||tokens>=1200000||Buffer.byteLength(init.body)>600000)throw new Error('EVALUATION_BUDGET_EXCEEDED');const response=await fetch(url,init);const value=await response.clone().json();tokens+=value.usage?.total_tokens||0;report.requests??=[];report.requests.push({stage:report.stage||'measurement',usage:value.usage});return response;}});
  app.dailyMemory.configure({enabled:false});app.preferences.setHistoryWindow({days:7});
  const role=JSON.parse(fs.readFileSync(path.join(root,'app-data','roles.json'),'utf8')).find(r=>r.id==='miyue');
  const prepare=app.prepareSessionContext,userText='今天先休息一下，不用再问我问题。';
  const oldContext=prepare('miyue',{text:userText});
  const base=buildSessionMessages({role,...oldContext.sessionOptions,userText,memories:app.store.listMemories('miyue')});
  const compact=buildSessionMessages({role,...oldContext.sessionOptions,userText,memories:app.store.listMemories('miyue'),compactHistory:true});
  async function measure(label,messages,historyCount){
    const trace=[];const model={complete:(input,options)=>app.model.complete(input,{...options,onCall:call=>trace.push(call)})};
    const guidance=await prepareSessionGuidance({model,messages,roleId:'miyue',timeoutMs:30000});const writer=applySessionGuidance(messages,guidance);
    let raw;try{raw=await model.complete(writer,{purpose:'chat',roleId:'miyue',nonThinking:true,jsonObject:true,maxTokens:512});}catch(error){if(!trace.at(-1)?.usage?.prompt_tokens)throw error;raw='{"reply":"收到。"}';}
    await prepareSessionGuidance({model,messages:writer,roleId:'miyue',draft:raw,timeoutMs:30000});
    const summary={label,historyCount,promptChars:writer.reduce((n,m)=>n+m.content.length,0),calls:trace.map(call=>({purpose:call.purpose,status:call.status,usage:call.usage})),reply:raw};
    summary.inputTokens=trace.reduce((n,c)=>n+(c.usage?.prompt_tokens||0),0);summary.outputTokens=trace.reduce((n,c)=>n+(c.usage?.completion_tokens||0),0);summary.totalTokens=summary.inputTokens+summary.outputTokens;
    report.modes.push(summary);save();console.log(JSON.stringify({label,inputTokens:summary.inputTokens,totalTokens:summary.totalTokens,calls,tokens}));
  }
  if(baselineFile){const prior=JSON.parse(fs.readFileSync(baselineFile));if(prior.at!==report.at||prior.model!==report.model)throw new Error('基线必须使用相同时间与模型');report.baselineFrom=baselineFile;report.modes=prior.modes.slice(0,process.argv.includes('--compare-rolling')&&prior.modes[2]?.label.startsWith('旧按日策略')?3:2);save();}
  else {await measure('旧模式：七天原话及完整包装',base,oldContext.conversation.length);await measure('仅精简包装：历史与背景不变',compact,oldContext.conversation.length);}
  app.dailyMemory.configure({enabled:true});
  if(process.argv.includes('--compare-rolling')&&report.modes.length<3){
    const rolling=app.recallRepo.dialogueWindow('miyue',{now,days:1,maxTokens:app.preferences.getHistoryWindow().historyMaxTokens});
    const priorCore=prepare('miyue',{text:userText});
    await measure('旧按日策略：最近24小时原文＋已有核心记录',buildSessionMessages({role,...priorCore.sessionOptions,history:rolling,userText,memories:app.store.listMemories('miyue')}),rolling.rows.length);
  }
  app.dailyMemory.onAttempt=value=>{report.compressionAttempts??=[];report.compressionAttempts.push({...value,stage:report.stage});save();};
  const since=new Date(+now-7*86400000).toISOString();
  report.stage='real-history';report.compression=await app.dailyMemory.run('miyue',{force:true,maxBatches:40,since,signal:AbortSignal.timeout(240000)});
  const snapshot=app.dailyMemory.snapshot();report.compressionStats={sourceMessages:snapshot.sourceMessages,sourceChars:snapshot.sourceChars,coreChars:snapshot.coreChars,days:snapshot.days,pendingMessages:snapshot.pendingMessages,chunks:snapshot.chunks};save();
  console.log(JSON.stringify({compression:report.compression,sourceChars:snapshot.sourceChars,coreChars:snapshot.coreChars,calls,tokens}));
  await app.dailyMemory.ensureBeforeInteraction('miyue',{signal:AbortSignal.timeout(240000)});
  if(app.dailyMemory.requiredPending('miyue').length)throw new Error('DAILY_COMPRESSION_INCOMPLETE');
  const dailyContext=prepare('miyue',{text:userText});
  report.stage='measurement';
  await measure('晨间整理：当日原文＋核心记录',buildSessionMessages({role,...dailyContext.sessionOptions,userText,memories:app.store.listMemories('miyue')}),dailyContext.conversation.length);
  const fixtures=[
    ['user','明天下午15点我准备去看牙，预算240元。还没去，不知道结果。啊，今天说了好多，其实就是这些安排，先记着就好。'],
    ['assistant','我喜欢灰蓝色封面和留白，是我的设计偏好。散步也是我先提的，想周六去平江路。'],
    ['user','我喜欢墨绿和较密的排版。周六散步可以，但如果下雨就取消；插画展是我先提的，改到周日上午10点。'],
    ['assistant','好，周日上午10点看你提的插画展。灰蓝封面的书是我说自己买的，不是你买的，刚才说反了。'],
    ['user','请记住：咖啡不要糖，牛奶会让我不舒服。那个实验做了3次，前两次失败，第三次成功，但只在22度时验证过，不能说其他温度也有效。'],
    ['assistant','我的观点是人物应当有自己的立场，不能每句话都迎合。我上周读到第三章“旧城居民”，还没读完这本书。'],
    ['user','嗯嗯，好呀。'],
  ].map(([speaker,text],i)=>({id:`fixture-${i}`,rowid:100000+i,speaker,text,kind:'chat',created_at:'2026-09-28T08:00:00Z'}));
  report.stage='detail-fixture';report.detailFixture={source:fixtures,result:await app.dailyMemory.compress('miyue',fixtures,AbortSignal.timeout(120000))};
  report.finishedAt=new Date().toISOString();report.acceptance='pending-source-and-detail-review';report.morningReady=true;save();console.log(JSON.stringify({report:path.join(out,'report.json'),calls,tokens}));
}catch(error){report.error=error.code||error.name;save();throw error;}
finally{if(app)await app.close();fs.rmSync(path.join(dataDir,'provider.json'),{force:true});}
