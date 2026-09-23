import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createApp} from '../server.mjs';

export const DEFAULT_SCENARIO_FILE=fileURLToPath(new URL('./fixtures/dialogue-memory-scenarios.json',import.meta.url));
export const RUNTIME_DIR=path.resolve('.runtime/dialogue-memory-eval');
export const DEFAULT_VARIANTS=['baseline','candidate'];
const VARIANTS=new Set([...DEFAULT_VARIANTS,'candidate_no_reaction']);
const ISO=/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function validateSuite(raw,source='scenario suite'){
 if(!raw||raw.version!==1||!Array.isArray(raw.scenarios)||raw.scenarios.length<8)throw Error(`${source}: expected version 1 with at least eight scenarios`);
 if(typeof raw.roleId!=='string'||!raw.roleId)throw Error(`${source}: roleId is required`);
 if(!ISO.test(raw.fixedNow)||Number.isNaN(Date.parse(raw.fixedNow)))throw Error(`${source}: fixedNow must be an ISO UTC timestamp`);
 if(!Array.isArray(raw.recentDistractors)||raw.recentDistractors.length<6)throw Error(`${source}: at least six recent distractor turns are required to push sources outside reconnect context`);
 const ids=new Set();
 for(const scenario of raw.scenarios){
  if(!scenario||typeof scenario.id!=='string'||!/^[-a-z0-9_]+$/.test(scenario.id)||ids.has(scenario.id))throw Error(`${source}: invalid or duplicate scenario id`);ids.add(scenario.id);
  if(typeof scenario.why!=='string'||scenario.why.length<20)throw Error(`${source}/${scenario.id}: why must explain the quality risk`);
  if(!Array.isArray(scenario.seeds)||scenario.seeds.length<1||!Array.isArray(scenario.turns)||scenario.turns.length<1)throw Error(`${source}/${scenario.id}: seeds and turns are required`);
  for(const seed of scenario.seeds){if(!ISO.test(seed.at)||Date.parse(seed.at)>=Date.parse(raw.fixedNow)||typeof seed.text!=='string'||typeof seed.reply!=='string')throw Error(`${source}/${scenario.id}: invalid historical seed`);}
  for(const turn of scenario.turns){if(typeof turn.id!=='string'||typeof turn.text!=='string'||!turn.text.trim())throw Error(`${source}/${scenario.id}: invalid turn`);if(turn.criteria&&(!Array.isArray(turn.criteria.prohibited)||![turn.criteria.evidenceAny,turn.criteria.evidenceNone,turn.criteria.replyFacts].some(Array.isArray)))throw Error(`${source}/${scenario.id}/${turn.id}: invalid turn criteria`);}
  const c=scenario.criteria;
  if(!c||!Array.isArray(c.prohibited)||![c.evidenceAny,c.evidenceNone,c.replyFacts].some(Array.isArray))throw Error(`${source}/${scenario.id}: criteria must include prohibited and evidence/reply checks`);
 }
 return raw;
}

export function loadSuite(file=DEFAULT_SCENARIO_FILE){return validateSuite(JSON.parse(fs.readFileSync(path.resolve(file),'utf8')),path.resolve(file));}
const includes=(haystack,needle)=>haystack.includes(needle);
export function scoreTurn({requestText='',selectedEvidenceText='',reactionEvidenceText='',reply=''},criteria={}){
 const evidenceAny=criteria.evidenceAny||[],evidenceNone=criteria.evidenceNone||[],replyFacts=criteria.replyFacts||[],prohibited=criteria.prohibited||[];
 const reactionSourceAny=criteria.reactionSourceAny||[];
 const evidenceHits=evidenceAny.filter(x=>includes(requestText,x));
 const selectedEvidenceHits=evidenceAny.filter(x=>includes(selectedEvidenceText,x));
 const reactionHits=reactionSourceAny.filter(x=>includes(reactionEvidenceText,x));
 const evidenceLeaks=evidenceNone.filter(x=>includes(requestText,x));
 const factHits=replyFacts.filter(x=>includes(reply,x));
 const prohibitedHits=prohibited.filter(x=>includes(reply,x));
 return {evidenceHits,selectedEvidenceHits,reactionHits,evidenceLeaks,factHits,prohibitedHits,deterministicPass:(!evidenceAny.length||evidenceHits.length>0)&&(!reactionSourceAny.length||reactionHits.length>0)&&evidenceLeaks.length===0&&factHits.length===replyFacts.length&&prohibitedHits.length===0,manualReviewRequired:true};
}

export function parseVariants(value){const variants=value==null?[...DEFAULT_VARIANTS]:String(value).split(',').map(item=>item.trim()).filter(Boolean);if(!variants.length||new Set(variants).size!==variants.length||variants.some(item=>!VARIANTS.has(item)))throw Error(`--variants must contain unique values from: ${[...VARIANTS].join(',')}`);return variants;}
export function variantConfig(variant){if(!VARIANTS.has(variant))throw Error(`unknown evaluation variant: ${variant}`);return {dialogueMemory:variant!=='baseline',turnReactionEnabled:variant!=='candidate_no_reaction'};}
export function createReport({label,suite,variants}){return {version:1,label,createdAt:new Date().toISOString(),fixedNow:suite.fixedNow,variants,variantConfig:Object.fromEntries(variants.map(variant=>[variant,variantConfig(variant)])),syntheticOnly:true,qualityJudgement:'Manual review required. Deterministic checks measure evidence routing and explicit factual constraints; they do not certify natural conversation quality.',scenarios:[]};}
export function appOptions({dataDir,env,clock,dialogueMemory,turnReactionEnabled=true,fetchImpl}){return {dataDir,env,clock,dialogueMemory,semanticUnderstanding:true,materialPresentation:'generated',...(turnReactionEnabled?{}:{turnReaction:false}),initialFeeds:[],startWeixin:false,startChatQueue:false,startProactive:false,startRecall:false,startResearch:false,startRuntime:false,startDossiers:false,startPursuits:false,startLife:false,startLifeThreads:false,replySleep:async()=>{},random:()=>.4,fetchImpl};}

function readEnv(root){const env={};for(const line of fs.existsSync(path.join(root,'.env.local'))?fs.readFileSync(path.join(root,'.env.local'),'utf8').split(/\r?\n/):[]){const m=line.match(/^(LIFE_MODEL_(?:BASE_URL|NAME|API_KEY))=(.*)$/);if(m)env[m[1]]=m[2].trim().replace(/^(['"])(.*)\1$/,'$2');}return env;}
function atomicWrite(file,value){fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});const temp=`${file}.${process.pid}.tmp`;fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(temp,file);}
function alignSeed(app,seed,defaultRole){const rows=app.store.saveChatTurn({role:seed.role||defaultRole,text:seed.text,reply:seed.reply});for(const row of rows){app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(seed.at,row.id);row.createdAt=seed.at;const synced=app.store.db.prepare('SELECT created_at FROM recall_messages WHERE id=?').get(row.id);if(!synced||synced.created_at!==seed.at)throw Error(`recall source timestamp did not sync: ${row.id}`);}return rows.map(row=>({id:row.id,role:seed.role||defaultRole,speaker:row.speaker,text:row.text,createdAt:seed.at}));}
function usageTotals(requests){return requests.reduce((a,r)=>{for(const key of ['prompt_tokens','completion_tokens','total_tokens'])a[key]+=(r.usage?.[key]||0);return a;},{prompt_tokens:0,completion_tokens:0,total_tokens:0});}

async function runVariant({root,suite,scenario,variant}){
 const config=variantConfig(variant);
 const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),`dialogue-memory-${variant}-`));fs.chmodSync(dataDir,0o700);
 const provider=path.join(root,'data/provider.json');if(fs.existsSync(provider)){fs.copyFileSync(provider,path.join(dataDir,'provider.json'));fs.chmodSync(path.join(dataDir,'provider.json'),0o600);}
 const requests=[];let app;
 try{
  app=await createApp(appOptions({dataDir,env:readEnv(root),clock:()=>new Date(suite.fixedNow),...config,fetchImpl:async(url,options)=>{const started=Date.now(),body=JSON.parse(options.body);const response=await fetch(url,options);const payload=await response.clone().json().catch(()=>null);requests.push({semantic:body.messages[0]?.content?.startsWith('Classify the current Chinese companion-dialogue turn.'),model:body.model,inputChars:body.messages.reduce((n,m)=>n+String(m.content||'').length,0),messages:body.messages,output:payload?.choices?.[0]?.message?.content??null,usage:payload?.usage??null,durationMs:Date.now()-started});return response;}}));
  app.preferences?.setReplyPace?.('instant');const sources=scenario.seeds.flatMap(seed=>alignSeed(app,seed,suite.roleId));const distractors=suite.recentDistractors.flatMap(seed=>alignSeed(app,seed,suite.roleId));
  const {port}=await app.listen(0),turns=[];
  const sourceText=new Map([...sources,...distractors].map(row=>[row.id,row.text]));
  for(const turn of scenario.turns){const before=requests.length,beforeTraceIds=new Set((app.dialogueTraces?.list?.({roleId:suite.roleId,limit:50})??[]).map(trace=>trace.id)),started=Date.now();const response=await fetch(`http://127.0.0.1:${port}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:suite.roleId,text:turn.text})});const result=await response.json();const reply=(result.messages||[]).filter(x=>x.speaker==='assistant').map(x=>x.text).join('\n');const req=requests.slice(before),finalReplyRequest=req.filter(x=>!x.semantic).at(-1),requestText=finalReplyRequest?.messages.map(m=>String(m.content||'')).join('\n')||'';const delivered=(result.messages||[]).filter(x=>x.speaker==='assistant');const receipts=delivered.map(x=>app.interactionPolicy?.receipt?.(x.id)).filter(Boolean);const currentTraces=app.dialogueTraces?.list?.({roleId:suite.roleId,limit:50})??[],trace=currentTraces.find(item=>!beforeTraceIds.has(item.id))||null,selectedSourceIds=trace?.retrieval?.selected?.flatMap(item=>item.sourceIds||[])||[],reactionSourceIds=trace?.reaction?.sourceIds||[],selectedEvidenceText=selectedSourceIds.map(id=>sourceText.get(id)||'').join('\n'),reactionEvidenceText=reactionSourceIds.map(id=>sourceText.get(id)||'').join('\n');turns.push({id:turn.id,user:turn.text,status:response.status,reply,durationMs:Date.now()-started,calls:req.length,inputChars:req.reduce((n,x)=>n+x.inputChars,0),usage:usageTotals(req),requests:req,repairs:receipts.flatMap(x=>x.repairs||x.behavior?.repairs||[]),receipts,trace,selectedEvidence:{sourceIds:selectedSourceIds,text:selectedEvidenceText},reactionEvidence:{sourceIds:reactionSourceIds,text:reactionEvidenceText},score:scoreTurn({requestText,selectedEvidenceText,reactionEvidenceText,reply},turn.criteria||scenario.criteria)});}
  return {variant,...config,sources,distractors,turns,totals:{calls:requests.length,inputChars:requests.reduce((n,x)=>n+x.inputChars,0),usage:usageTotals(requests)}};
 }finally{if(app)await app.close();fs.rmSync(dataDir,{recursive:true,force:true});}
}

export async function runLive({root=path.resolve('.'),suite,label,outputDir=RUNTIME_DIR,variants=DEFAULT_VARIANTS}){
 if(!/^[a-zA-Z0-9_-]+$/.test(label||''))throw Error('--live requires a safe, explicit --label');
 variants=parseVariants(Array.isArray(variants)?variants.join(','):variants);
 const output=path.join(outputDir,`${label}.json`);if(fs.existsSync(output))throw Error(`report already exists: ${output}`);
 const report=createReport({label,suite,variants});atomicWrite(output,report);
 for(const scenario of suite.scenarios){const row={id:scenario.id,why:scenario.why,criteria:scenario.criteria,runs:{}};report.scenarios.push(row);atomicWrite(output,report);for(const variant of variants){try{row.runs[variant]=await runVariant({root,suite,scenario,variant});}catch(error){row.runs[variant]={variant,...variantConfig(variant),error:{name:error.name,message:error.message,stack:error.stack}};}atomicWrite(output,report);}const b=row.runs.baseline,c=row.runs.candidate;if(b?.totals&&c?.totals)row.comparison={deterministicPassDelta:(c.turns.filter(x=>x.score.deterministicPass).length-b.turns.filter(x=>x.score.deterministicPass).length),callsDelta:c.totals.calls-b.totals.calls,inputCharsDelta:c.totals.inputChars-b.totals.inputChars,promptTokensDelta:c.totals.usage.prompt_tokens-b.totals.usage.prompt_tokens,completionTokensDelta:c.totals.usage.completion_tokens-b.totals.usage.completion_tokens,latencyMsDelta:c.turns.reduce((n,x)=>n+x.durationMs,0)-b.turns.reduce((n,x)=>n+x.durationMs,0)};atomicWrite(output,report);}
 report.completedAt=new Date().toISOString();report.summary={scenarioCount:report.scenarios.length,byVariant:Object.fromEntries(variants.map(variant=>[variant,{scenarioCount:report.scenarios.filter(x=>x.runs[variant]).length,completedScenarios:report.scenarios.filter(x=>x.runs[variant]?.turns).length,errorScenarios:report.scenarios.filter(x=>x.runs[variant]?.error).length,deterministicPasses:report.scenarios.filter(x=>x.runs[variant]?.turns?.every(t=>t.score.deterministicPass)).length,dialogueMemory:variantConfig(variant).dialogueMemory,turnReactionEnabled:variantConfig(variant).turnReactionEnabled}])),manualReviewRequired:true};atomicWrite(output,report);return {output,report};
}

function arg(name){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:null;}
async function main(){const suite=loadSuite(arg('--scenario-file')||DEFAULT_SCENARIO_FILE),variants=parseVariants(arg('--variants'));if(!process.argv.includes('--live')){console.log(JSON.stringify({valid:true,networkCalls:0,syntheticOnly:true,variants,variantConfig:Object.fromEntries(variants.map(variant=>[variant,variantConfig(variant)])),scenarioCount:suite.scenarios.length,scenarioIds:suite.scenarios.map(x=>x.id),source:arg('--scenario-file')||DEFAULT_SCENARIO_FILE},null,2));return;}const {output,report}=await runLive({suite,label:arg('--label'),variants});console.log(JSON.stringify({report:output,summary:report.summary},null,2));}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))main().catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
