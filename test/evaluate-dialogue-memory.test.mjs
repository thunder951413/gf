import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {DEFAULT_SCENARIO_FILE,appOptions,createReport,loadSuite,parseVariants,scoreTurn,validateSuite,variantConfig} from '../scripts/evaluate-dialogue-memory.mjs';

test('dialogue memory evaluation suite is synthetic, historical, and covers independent risks',()=>{
 const suite=loadSuite();
 assert.equal(suite.scenarios.length,10);
 assert.deepEqual(suite.scenarios.map(x=>x.id),['old_paraphrased_recall','multi_topic_competition','corrected_preference','speaker_attribution','current_state_over_old_fact','completed_event_recall','unrelated_recall_suppression','boundary_preserved','same_conversation_followup','reaction_old_failure_today_success']);
 assert.ok(suite.scenarios.every(x=>x.seeds.every(seed=>Date.parse(seed.at)<Date.parse(suite.fixedNow))));
 assert.ok(suite.recentDistractors.length>=6);
 assert.ok(suite.scenarios.flatMap(x=>x.seeds).some(x=>x.role==='wenxi'),'attribution scenario includes a cross-role distractor');
 assert.doesNotMatch(fs.readFileSync(DEFAULT_SCENARIO_FILE,'utf8'),/微信|weixin_inbox|life\.sqlite/iu);
});

test('validation rejects fixtures that could silently stop testing historical isolation',()=>{
 const suite=loadSuite(),copy=structuredClone(suite);copy.scenarios[0].seeds[0].at=suite.fixedNow;
 assert.throws(()=>validateSuite(copy),/historical seed/);
 const duplicate=structuredClone(suite);duplicate.scenarios[1].id=duplicate.scenarios[0].id;
 assert.throws(()=>validateSuite(duplicate),/duplicate scenario id/);
});

test('baseline and candidate options differ only in dialogue memory and disable background systems',()=>{
 const common={dataDir:'/tmp/synthetic',env:{},clock:()=>new Date(),fetchImpl:async()=>{throw Error('must not run');}};
 const baseline=appOptions({...common,dialogueMemory:false}),candidate=appOptions({...common,dialogueMemory:true});
 assert.equal(baseline.dialogueMemory,false);assert.equal(candidate.dialogueMemory,true);
 for(const key of ['startWeixin','startChatQueue','startProactive','startRecall','startResearch','startRuntime','startDossiers','startPursuits','startLife','startLifeThreads']){assert.equal(baseline[key],false,key);assert.equal(candidate[key],false,key);}
 assert.equal(baseline.semanticUnderstanding,true);assert.equal(baseline.materialPresentation,'generated');
 assert.equal(Object.hasOwn(baseline,'turnReaction'),false);
});

test('candidate no-reaction variant only disables reaction preview and is reportable',()=>{
 assert.deepEqual(parseVariants(),['baseline','candidate']);
 assert.deepEqual(parseVariants('candidate,candidate_no_reaction'),['candidate','candidate_no_reaction']);
 assert.throws(()=>parseVariants('candidate,candidate'),/unique/);assert.throws(()=>parseVariants('unknown'),/unique values/);
 const config=variantConfig('candidate_no_reaction');assert.deepEqual(config,{dialogueMemory:true,turnReactionEnabled:false});
 const common={dataDir:'/tmp/synthetic',env:{},clock:()=>new Date(),fetchImpl:async()=>{throw Error('must not run');}};
 const candidate=appOptions({...common,...variantConfig('candidate')}),ablation=appOptions({...common,...config});
 const {turnReaction:_disabled,...ablationWithoutReaction}=ablation;assert.deepEqual(Object.keys(candidate).sort(),Object.keys(ablationWithoutReaction).sort());for(const key of Object.keys(candidate)){if(typeof candidate[key]==='function')assert.equal(typeof ablationWithoutReaction[key],'function',key);else assert.deepEqual(candidate[key],ablationWithoutReaction[key],key);}
 assert.equal(Object.hasOwn(candidate,'turnReaction'),false);assert.equal(ablation.turnReaction,false);
 const report=createReport({label:'unit',suite:loadSuite(),variants:['candidate_no_reaction']});assert.deepEqual(report.variantConfig.candidate_no_reaction,{dialogueMemory:true,turnReactionEnabled:false});
});

test('deterministic scoring distinguishes evidence routing, assertions, and suppression',()=>{
 const good=scoreTurn({requestText:'历史资料：普通牛奶，不要燕麦奶了',reply:'给你选普通牛奶。'},{evidenceAny:['普通牛奶'],replyFacts:['普通牛奶'],prohibited:['继续燕麦奶']});assert.equal(good.deterministicPass,true);assert.equal(good.manualReviewRequired,true);
 const leak=scoreTurn({requestText:'历史资料：银色链条',reply:'散步回来歇歇。'},{evidenceNone:['银色链条'],prohibited:[]});assert.equal(leak.deterministicPass,false);assert.deepEqual(leak.evidenceLeaks,['银色链条']);
 const reaction=scoreTurn({requestText:'历史资料：旧练习',selectedEvidenceText:'连续失败了三次',reactionEvidenceText:'练得有点挫败',reply:'今天这片叶子终于站住了。'},{evidenceAny:['旧练习'],reactionSourceAny:['有点挫败'],replyFacts:[],prohibited:['又失败了']});assert.equal(reaction.deterministicPass,true);assert.deepEqual(reaction.reactionHits,['有点挫败']);
 const semanticOnly=scoreTurn({requestText:'最终回复提示里没有目标事实',selectedEvidenceText:'杯沿歪得像海浪',reply:'我不确定。'},{evidenceAny:['杯沿歪得像海浪'],replyFacts:[],prohibited:[]});assert.equal(semanticOnly.deterministicPass,false,'trace selection alone and semantic expansion must not count as evidence delivered to the reply model');assert.deepEqual(semanticOnly.selectedEvidenceHits,['杯沿歪得像海浪']);
});
