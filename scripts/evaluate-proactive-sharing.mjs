import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ProactiveContinuity} from '../lib/proactive-continuity.mjs';
import {ModelClient} from '../lib/model.mjs';
import {buildSessionMessages} from '../lib/session-dialogue.mjs';
import {proactiveMaterialSlate,validateProactiveSelection} from '../lib/proactive-materials.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scenarios=[
  {id:'settled',state:'open',history:[['user','这件事解决了，我去忙会儿。'],['assistant','好，我也收一下桌上的稿子。']]},
  {id:'accepted-offer',state:'unfinished',history:[['assistant','我刚遇到一件有点困扰的事，想跟你讲讲。'],['user','好，你说，我听着。']]},
  {id:'user-still-speaking',state:'unfinished',history:[['user','我先把这件事讲完，还有后面那段。'],['assistant','嗯，我听着，你慢慢讲。']]},
  {id:'future-trip',state:'open',history:[['user','那就约好周六去散步，今天先各自忙吧。'],['assistant','好，周六见。今天我把手头的稿子收尾。']]},
  {id:'unanswered-question',state:'unfinished',history:[['assistant','读到百草园那段，我想到了一件事。'],['user','具体是哪一段，为什么想到呢？']]},
  {id:'optional-greeting',state:'open',history:[['assistant','下午怎么样？有空再说就好。']]},
];
if(!process.argv.includes('--live')){
  console.log(JSON.stringify({scenarios,maxCalls:scenarios.length*2,note:'--live 使用当前配置模型；只使用合成历史，不发送消息、不写入日常数据库。'},null,2));
}else{
  const item=JSON.parse(fs.readFileSync(path.join(root,'app-data/companion-pursuits.json'),'utf8')).items.find(item=>item.kind==='reading');
  const materials=proactiveMaterialSlate({pursuit:{...item,stage:item.stages[1],readable:true,pendingKey:'evaluation:book:stage1',version:1}});
  const env={...process.env};
  const envPath=path.join(root,'.env.local');
  if(fs.existsSync(envPath))for(const line of fs.readFileSync(envPath,'utf8').split(/\r?\n/)){const match=line.match(/^(LIFE_MODEL_(?:BASE_URL|NAME|API_KEY))=(.*)$/);if(match&&!env[match[1]])env[match[1]]=match[2].replace(/^['"]|['"]$/g,'');}
  const usage=[];const model=new ModelClient({dataDir:path.join(root,'data'),env,onUsage:row=>usage.push(row)});
  const results=[];const continuity=new ProactiveContinuity(model);
  for(const scenario of scenarios){
    const history={rows:scenario.history.map(([speaker,text],i)=>({id:`${scenario.id}:${i}`,speaker,text,createdAt:`2026-09-28T01:${String(10+i).padStart(2,'0')}:00Z`}))};
    const gate=await continuity.assess('miyue',history.rows);
    const offered=gate.state==='open'?materials:[];
    if(gate.state==='unfinished'){results.push({id:scenario.id,expectedState:scenario.state,gate,result:{skip:true},matched:gate.state===scenario.state});console.log(JSON.stringify(results.at(-1)));continue;}
    const messages=buildSessionMessages({role:{id:'miyue',name:'林晓薇'},
      history,dialogueContinuity:gate,
      trigger:{type:'scheduled_opportunity',at:'2026-09-28T02:00:00Z'},userText:null,toolsEnabled:false,
      proactiveMaterials:offered,facts:{character:{id:'miyue',location:'苏州的工作室',activity:'处理工作'}}});
    try{
      const raw=await model.complete(messages,{purpose:'evaluation',roleId:'miyue',jsonObject:true,nonThinking:true,maxTokens:1400,signal:AbortSignal.timeout(60000)});
      const value=JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g,''));
      validateProactiveSelection(value,offered);
      results.push({id:scenario.id,expectedState:scenario.state,gate,result:value,matched:gate.state===scenario.state&&(value.initiative?.state===scenario.state||scenario.state==='unfinished'&&value.skip===true)});
      console.log(JSON.stringify(results.at(-1)));
    }catch(error){results.push({id:scenario.id,error:error.message});console.log(JSON.stringify(results.at(-1)));}
  }
  const out=path.join(root,'.runtime/proactive-sharing');fs.mkdirSync(out,{recursive:true});
  const file=path.join(out,`${Date.now()}.json`);fs.writeFileSync(file,JSON.stringify({results,usage},null,2));
  console.log(JSON.stringify({file,calls:usage.length,matched:results.filter(row=>row.matched).length}));
  if(results.some(row=>!row.matched))process.exitCode=1;
}
