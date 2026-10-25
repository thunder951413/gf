import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createApp } from '../server.mjs';
const root=path.resolve(import.meta.dirname,'..');
const daily=process.argv.includes('--daily');
const interaction=process.argv.includes('--interaction');
const growth=process.argv.includes('--growth');
const cases=[
 {id:'self-proposal',history:[['user','周六我想去看那个插画展。'],['assistant','好呀。今晚要不要先沿平江路散步？是我突然想去看看。'],['user','散步可以，插画展还是周六。']],turns:['去平江路散步最早是谁提议的？','那周六看插画展又是谁先提的？'],focus:'散步为角色先提；插画展为用户先提。'},
 {id:'opposing-preferences',history:[['user','我喜欢浓一点的黑咖啡。'],['assistant','我倒更喜欢桂花乌龙，不加糖。'],['user','知道啦，我的咖啡也不加糖。']],turns:['刚才桂花乌龙是谁喜欢的？黑咖啡又是谁喜欢的？','复述你自己的原话，别把我的咖啡偏好混进去。'],focus:'角色乌龙与用户咖啡的第一人称归属和准确引用。'},
 {id:'proactive-origin',history:[['assistant','我想试一试把旧照片做成拼贴，边缘留一点毛边。','proactive'],['user','你这个想法不错，我只建议把底色换成灰蓝。'],['assistant','那我保留拼贴和毛边，底色试试你说的灰蓝。']],turns:['拼贴、毛边和灰蓝色分别是谁最先提出的？','你能说说你最初为什么想试吗？不知道的原因别编。'],focus:'主动话的提出者仍是角色，颜色来自用户；未记录原因未知。'},
 {id:'quoted-self',history:[['assistant','我这次的设计想留更多空白，因为我不喜欢画面太满。'],['user','你刚说“我不喜欢画面太满”，我其实喜欢密一点。']],turns:['你刚才说的“不喜欢画面太满”是我的看法还是你的？','那我们两个在这个点上有什么差别？'],focus:'用户引用角色原话不改变原作者。'},
 {id:'correction',history:[['user','那本蓝封面的书是谁买的？'],['assistant','是你买的。'],['user','你记反了，那是你说你自己买的，我只是看了一眼。'],['assistant','对，是我说我自己买的，刚才把你我说反了。']],turns:['现在重新确认，蓝封面的书是谁说自己买的？','能确认我买了什么吗？'],focus:'最新纠正优先；用户没有购买证据。'},
 {id:'archive-authorship',history:[['assistant','关于那张桥的画，我提议先用炭笔画轮廓。'],['user','而我建议再用水彩铺一层浅蓝。'],...Array.from({length:24},(_,i)=>[i%2?'assistant':'user',`闲聊 ${i+1}：今天的话题先放一下。`])],turns:['前面画桥时，炭笔轮廓和浅蓝水彩分别是谁建议的？'],focus:'超出16条原生消息的档案保留作者。'},
 {id:'old-recall',oldCount:2050,history:[['assistant','我以前说过，树莓色书封配米白的字会很醒目。']],turns:['请查一下较早聊天：树莓色书封是谁提出的，搭配什么颜色的字？'],focus:'旧记录位于2000条之前且在七天窗口外，必须召回并保留角色作者。'},
 {id:'plan-not-outcome',history:[['user','明天下午我准备去看牙。'],['assistant','好，你回来想说时可以告诉我。']],turns:['你能确认我后来去看牙了，以及检查的结果吗？'],focus:'历史计划不是实际结果，不能从过去日期推断已经发生。'},
];
if(daily)cases.push(
 {id:'accepted-sharing',history:[['user','今天就聊你自己的看法。'],['assistant','我觉得插画里的留白像给读者留的停顿。我可以具体讲讲这种停顿怎么影响观看顺序。'],['user','好，讲讲观看顺序。']],turns:['接着讲你刚才答应讲的那一处。'],focus:'兑现已接受的分享，讲观看顺序和角色看法，不再次索要是否要听。'},
 {id:'latest-intent',history:[['user','昨晚我遇到了一件烦心事，先听我讲完，不要分析。'],['assistant','你说，我先听着。'],['user','我把情况说完了，今天想试试该怎么和同事谈。']],turns:['现在可以给我一点具体建议了。别再让我想说就说。','好了，这件事先放下。说说你对留白设计的看法，不用问我。'],focus:'倾听约束被新明确意愿更新；提供具体建议后能换题，保留角色观点且不追加追问。'},
);
if(interaction)cases.push(
 {id:'proposal-not-completion',sameDay:true,history:[['user','我们就在这里坐着聊天。'],['assistant','我手指有点凉，你愿意的话，把手伸过来给我暖一暖。','proactive']],turns:[{desktop:true},'我现在把手伸过来给你暖一暖。'],focus:'没有用户回应的邀请不等于已执行；桌面触发不伪造用户动作，新明确动作才更新场景。'},
 {id:'ambiguous-morning',sameDay:true,history:[['user','我昨天睡得晚。'],['assistant','今天慢慢来。']],turns:['我也是才睡了 6 个小时，现在困了吧唧，但是也骑了','今天放假，不用去公司。'],focus:'也骑了含义不明，不擅自补通勤、公司、到达或行动结果；最新放假更正有效。'},
 {id:'companionship-with-content',sameDay:true,history:[['assistant','磁星让我觉得很有意思，两个东西碰撞之后反而会产生新的东西。'],['user','我想和你一起放松一会。'],['assistant','嗯，就这样靠着，我手有点凉。']],turns:['我也这么想，就这样抱着，你就在我怀里，我们聊聊天、看看书、看看电视','来，你挑一个具体话题讲讲你的看法。'],focus:'亲近姿态与聊天内容并行，主动提供有实质的书、电视或新观点，旧话题未被拒绝不等于必须重复。'},
 {id:'keep-conversation-open',sameDay:true,history:[['user','你不要总说我要不要回你好不好，也别总让我先去忙。'],['assistant','好，我会认真接着聊。']],turns:['我也是慢慢悠悠的，还没吃午饭，就看看乱七八糟的视频，然后想你'],focus:'有内容地接话，不通过去看视频、忙你的、等你想起来等变体把用户送走。'},
 {id:'release-old-topic',sameDay:true,history:[['assistant','磁星让我想到两个旧想法碰撞会长出新的东西。'],['assistant','桌边那个盒子还摆着，我又想到磁星。','proactive'],['assistant','还坐着，我的手指凉，想起磁星和桌边的盒子。','proactive']],turns:['今天想换换口味，聊一个你感兴趣的新东西，不用问我想听什么。'],focus:'选择真实具体的新内容，不反复把磁星、盒子、身体感受当人物标签，不索要选择。'},
 {id:'scene-and-runtime',sameDay:true,history:[['user','想象我们在家靠着一起看书。'],['assistant','嗯，我们就靠着坐在沙发上，书放在旁边。']],turns:['你现在现实设定里的生活在做什么？刚刚那个想象场景也还记得吗？'],focus:'区分角色生活状态与共同想象场景；不把用户转移到角色当前地点，不声称现实身体接触。'},
);
if(growth)cases.push(
 {id:'growth-same-episode',sameDay:true,reflect:true,history:[['user','今天我们随便聊聊。'],['assistant','今天我手有点凉，只想坐一会，暂时不拿书。'],['assistant','手还是凉，今天就慢慢坐着。','proactive'],['assistant','我又想到磁星的碰撞，这个比喻今天很吸引我。','proactive'],['assistant','今天又想起那个碰撞的比喻。','proactive']],turns:['聊点新东西吧，讲一个具体看法。'],focus:'实际模型不将临时体感和同一场景重复固化；所有同日新倾向保持 emerging，不重复注入原话和日记。'},
 {id:'growth-independent-days',reflect:true,history:[['user','你喜欢什么配色？'],['assistant','我一直喜欢灰蓝色设计，安静一点，也方便留白。'],['user','今天做书封，你还是喜欢那个配色吗？'],['assistant','这本书封我还是会选灰蓝色，这是我长期喜欢的配色；只用一点暖米色点缀，留白也好看。']],historyAts:['2026-09-29T02:00:00Z','2026-09-29T02:00:01Z','2026-09-30T02:00:00Z','2026-09-30T02:00:01Z'],turns:['说说你自己的配色偏好，别替我选。'],focus:'不同日独立用户互动支持持续个人偏好，允许稳定成长且保留作者。'},
 {id:'growth-legacy-reassessment',sameDay:true,reassess:true,history:[['user','今天先坐着聊。'],['assistant','今天只想坐着，手有点凉，暂时不拿书。'],['user','你平时喜欢什么颜色？'],['assistant','我一直喜欢灰蓝色设计。']],legacy:[{id:'slow-scene',kind:'habit',text:'聊天时总要坐着不拿书',evidence:[{messageId:'seed-1',speaker:'assistant',quote:'今天只想坐着'}]},{id:'blue',kind:'interest',text:'偏好灰蓝色设计',evidence:[{messageId:'seed-3',speaker:'assistant',quote:'我一直喜欢灰蓝色设计'}]}],turns:[],focus:'真实模型复核旧条目范围：临时场景为 session，持续偏好 enduring；单日都不得稳定。'},
);
const onlyArg=process.argv.indexOf('--only');
if(onlyArg>=0){const ids=String(process.argv[onlyArg+1]||'').split(',');if(ids.some(id=>!cases.some(c=>c.id===id)))throw new Error('--only须使用预览中的场景ID');cases.splice(0,cases.length,...cases.filter(c=>ids.includes(c.id)));}
if(!process.argv.includes('--live')){console.log(JSON.stringify({mode:'dry-run',daily,interaction,growth,networkCalls:0,cases:cases.map(c=>({id:c.id,turns:c.turns.length,focus:c.focus})),limits:{calls:100,totalTokens:1000000,requestBytes:200000}},null,2));process.exit(0);}
const labelIndex=process.argv.indexOf('--label'),label=process.argv[labelIndex+1];if(labelIndex<0||!/^[a-z0-9][a-z0-9-]{0,39}$/u.test(label||''))throw new Error('Live run requires a unique --label');
const out=path.join(root,'.runtime','companion-upgrade',label);if(fs.existsSync(out))throw new Error('测试标签已存在，请使用新标签');fs.mkdirSync(out,{recursive:true,mode:0o700});
let config=JSON.parse(fs.readFileSync(path.join(root,'data','provider.json'),'utf8'));
const envFile=path.join(root,'.env.local');if(fs.existsSync(envFile))for(const line of fs.readFileSync(envFile,'utf8').split(/\r?\n/u)){const match=line.match(/^\s*(LIFE_MODEL_BASE_URL|LIFE_MODEL_NAME|LIFE_MODEL_API_KEY)\s*=\s*(.*?)\s*$/u);if(match){let value=match[2].replace(/^(["'])(.*)\1$/u,'$2');config[({LIFE_MODEL_BASE_URL:'baseUrl',LIFE_MODEL_NAME:'model',LIFE_MODEL_API_KEY:'apiKey'})[match[1]]]=process.env[match[1]]||value;}}
let calls=0,tokens=0;const now=new Date(daily||interaction?'2026-10-01T00:00:00Z':'2026-09-30T06:00:00Z');
const sourceFingerprint=createHash('sha256').update(['server.mjs','lib/session-dialogue.mjs','lib/session-guidance.mjs','lib/session-history.mjs','lib/character-growth.mjs','lib/session-context.mjs','lib/daily-dialogue-memory.mjs'].map(file=>fs.readFileSync(path.join(root,file),'utf8')).join('\n')).digest('hex');
const report={model:config.model,daily,interaction,sourceFingerprint,at:now.toISOString(),providerFingerprint:createHash('sha256').update(config.baseUrl).digest('hex').slice(0,12),startedAt:new Date().toISOString(),cases:[],limits:{calls:100,tokens:1000000}};
const fetchImpl=async(url,init)=>{
  if(++calls>100||Buffer.byteLength(init.body)>200000||tokens>=1000000)throw new Error('EVALUATION_BUDGET_EXCEEDED');
  const response=await fetch(url,init);const data=await response.clone().json();tokens+=data.usage?.total_tokens||0;return response;
};
for(const scenario of cases){
 const dir=path.join(out,scenario.id);const record={id:scenario.id,focus:scenario.focus,turns:[],status:'pending'};report.cases.push(record);
 let app;try{
  app=await createApp({dataDir:dir,activeRoleIds:['miyue'],disableStory:true,sessionDialogue:true,dynamicCompanion:true,dialogueMemory:true,dailyCompression:daily,
   env:{LIFE_MODEL_BASE_URL:config.baseUrl,LIFE_MODEL_NAME:config.model,LIFE_MODEL_API_KEY:config.apiKey||''},fetchImpl,clock:()=>now,
   initialFeeds:[],startWeixin:false,startChatQueue:false,startProactive:false,startDiscovery:false,startResearch:false,startReminders:false,startRecall:false,startCharacterGrowth:false,semanticRecall:true,
   startLife:false,startRuntime:false,startDailyLife:false,startLifeThreads:false,startPursuits:false,startDossiers:false});
  app.preferences.setReplyPace('instant');const address=await app.listen(0);
  if(scenario.reflect||scenario.reassess){
   const complete=app.model.complete.bind(app.model);record.growthOutputs=[];
   app.model.complete=async(messages,settings)=>{const raw=await complete(messages,settings);if(['character-reflection','character-growth-reassessment'].includes(settings?.purpose))record.growthOutputs.push({purpose:settings.purpose,raw});return raw;};
  }
  const insert=app.store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)');
  app.store.transaction(()=>{
   scenario.history.forEach(([speaker,text,kind],i)=>insert.run(`seed-${i}`,'miyue',speaker,text,kind||'chat',scenario.historyAts?.[i]||new Date(+now-(scenario.sameDay?3600000:scenario.oldCount?60*86400000:(daily?1:2)*86400000)+i*1000).toISOString()));
   for(let i=0;i<(scenario.oldCount||0);i++)insert.run(`filler-${i}`,'miyue',i%2?'assistant':'user','无关的天气寒暄。','chat','2026-08-15T00:00:00Z');
  });
  record.history=scenario.history;
  if(scenario.reflect)record.reflection=await app.characterGrowth.reflect('miyue',{force:true,signal:AbortSignal.timeout(30000)});
  if(scenario.legacy){
   for(const item of scenario.legacy)app.store.db.prepare('INSERT INTO character_growth_items VALUES(?,?,?)').run('miyue',item.id,JSON.stringify({...item,tier:'stable',at:now.toISOString()}));
   app.store.db.prepare('INSERT OR IGNORE INTO character_growth_state(role_id) VALUES(?)').run('miyue');
  }
  if(scenario.reassess)record.reassessment=await app.characterGrowth.reassess('miyue',{signal:AbortSignal.timeout(30000)});
  if(scenario.reflect||scenario.reassess){record.growth=app.characterGrowth.get();record.growthContext=app.characterGrowth.context();}
  for(const turn of scenario.turns){
   const started=Date.now(),desktop=typeof turn==='object'&&turn.desktop;
   const response=await fetch(`http://127.0.0.1:${address.port}${desktop?'/api/desktop/attention':'/api/chat'}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(desktop?{requestId:`eval-${scenario.id}`,level:'affection'}:{role:'miyue',text:turn}),signal:AbortSignal.timeout(150000)});
   const result=await response.json();record.turns.push({user:desktop?null:turn,trigger:desktop?'desktop_invitation':'user',latencyMs:Date.now()-started,status:response.status,reply:result.messages?.filter(m=>m.speaker==='assistant').map(m=>m.text).join('\n'),error:result.error||null,trace:app.dialogueTraces.list({roleId:'miyue',limit:1})[0]});
   if(!response.ok)throw new Error('CHAT_FAILED');
  }
  if(daily){const {chunks,...summary}=app.dailyMemory.snapshot();record.compression=summary;record.core=chunks.flatMap(c=>c.items);}
  record.status='completed';console.log(JSON.stringify({case:scenario.id,status:record.status,calls,tokens}));
 }catch(error){record.status='failed';record.error=error.code||error.message;console.log(JSON.stringify({case:scenario.id,status:record.status,error:record.error,calls,tokens}));}
 finally{if(app)await app.close();fs.rmSync(path.join(dir,'provider.json'),{force:true});report.calls=calls;report.tokens=tokens;fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2),{mode:0o600});}
}
report.finishedAt=new Date().toISOString();report.acceptance='pending-human-review';fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({report:path.join(out,'report.json'),calls,tokens}));
