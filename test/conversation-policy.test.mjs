import test from'node:test';import assert from'node:assert/strict';import {DatabaseSync}from'node:sqlite';import{ConversationPolicyRepository}from'../lib/conversation-policy.mjs';
function setup(t){const store={db:new DatabaseSync(':memory:')};t.after(()=>store.db.close());return new ConversationPolicyRepository(store);}
test('explicit requests are enforced even when a draft ignores the prompt',t=>{const repo=setup(t),plan=repo.plan('miyue','先别给建议，别分析我，只想说说',{sources:[]});const result=repo.enforce('你内心其实很害怕。建议你先整理一下。听你说这件事，确实挺折腾。你准备怎么办？要我帮忙吗？',plan);assert.equal(result.reply,'听你说这件事，确实挺折腾。\n你准备怎么办？\n要我帮忙吗？');assert.equal(result.questionCount,2);assert.ok(result.warnings.includes('question_punctuation_over_budget'));assert.ok(result.repairs.includes('removed_advice'));assert.ok(result.repairs.includes('removed_analysis'));});
test('preference changes commit with a response and old plans cannot overwrite new preferences',t=>{const repo=setup(t),plan=repo.plan('miyue','别老问我问题');assert.equal(repo.get('miyue').preferences.noQuestions,undefined);const result=repo.enforce('嗯，那就慢慢说。你今天怎么样？',plan);repo.commit(plan,result,'message-1');assert.equal(repo.get('miyue').preferences.noQuestions,true);assert.equal(repo.get('wenxi').preferences.noQuestions,undefined);const stale=repo.plan('miyue','聊聊');repo.set('miyue',{noQuestions:false});assert.throws(()=>repo.commit(stale,repo.enforce('好的。',stale),'message-2'),e=>e.code==='STALE_DIALOGUE_POLICY');});
test('unsupported invented recollection is withheld and empty drafts fail rather than pretending success',t=>{const repo=setup(t),plan=repo.plan('miyue','聊聊',{sources:['我喜欢认真听别人讲事情']});assert.equal(repo.enforce('你上次说你在上海住过。今天我想说个小发现。',plan).reply,'今天我想说个小发现。');assert.throws(()=>repo.enforce('你上次说你在上海住过。',plan),e=>e.code==='DIALOGUE_POLICY_REJECTED');});
test('uncertain mention verification survives without being mistaken for asserted history',t=>{
 const repo=setup(t),plan=repo.plan('miyue','明天和阿盛去旧书店',{sources:[]});
 for(const question of ['阿盛是你以前提过的那个朋友吗？','你以前提过阿盛吗？','阿盛是不是你上次说的那位同事？','你说过这本书吗？']){
  const result=repo.enforce(question+'我不太记得了。',plan);
  assert.equal(result.reply,question+'\n我不太记得了。');assert.equal(result.questionCount,1);assert.ok(!result.repairs.includes('removed_unsupported_recall'));
 }
});
test('a question mark cannot grant unsupported memories, but a genuine clarification stays intact',t=>{
 const repo=setup(t),plan=repo.plan('miyue','聊聊',{sources:[]});
 for(const question of ['你上次说你离婚了，后来怎么样了？','还记得我们一起去丽江吗？','你上次不是说你在上海住过吗？','阿盛是你以前提过的朋友，难道不是吗？']){
  const result=repo.enforce(question+'我听你说。',plan);assert.equal(result.reply,'我听你说。');assert.ok(result.repairs.includes('removed_unsupported_recall'));
 }
 const result=repo.enforce('阿盛是你以前提过的那个朋友吗？我听你说。',{...plan,questionBudget:0});
 assert.equal(result.reply,'阿盛是你以前提过的那个朋友吗？\n我听你说。');assert.ok(!result.repairs.includes('limited_questions'));assert.ok(result.warnings.includes('question_punctuation_over_budget'));
});
test('Lin audits questions without deleting authored facts; other role budgets remain unchanged',t=>{const repo=setup(t),plan=repo.plan('miyue','说说你的近况',{anchor:'那张纸的边缘我决定先不裁齐。'});const result=repo.enforce('我今天在休息。你呢？还有什么？',plan);assert.equal(result.reply.startsWith(plan.anchor),true);assert.equal(result.questionCount,2);assert.ok(result.warnings.includes('question_punctuation_over_budget'));const normal=repo.enforce('我有个想法。你觉得呢？要试试吗？',repo.plan('wenxi','聊聊'));assert.equal(normal.questionCount,1);});
test('URL query punctuation stays verbatim and is not counted as a question',t=>{const repo=setup(t),plan=repo.plan('wenxi','把链接发给我');const raw='资料在 https://example.test/search?q=雨伞&lang=zh，已经核过来源。';const result=repo.enforce(raw,plan);assert.equal(result.reply,raw);assert.equal(result.questionCount,0);});
test('scheme-less URL queries survive a zero question budget while real trailing questions remain questions',t=>{const repo=setup(t),quiet={...repo.plan('miyue','别老问我问题'),questionBudget:0};const bare='资料在 solidot.org/story?sid=85370。你还想继续看吗？';const kept=repo.enforce(bare,quiet);assert.equal(kept.reply,'资料在 solidot.org/story?sid=85370。\n你还想继续看吗？');assert.equal(kept.questionCount,1);assert.ok(!kept.repairs.includes('limited_questions'));
 const full='链接是 https://example.test/guide？';const fullResult=repo.enforce(full,repo.plan('wenxi','聊聊'));assert.equal(fullResult.reply,full);assert.equal(fullResult.questionCount,1);
 const ambiguous='请看 example.org/guide?';const ambiguousResult=repo.enforce(ambiguous,repo.plan('zhixia','聊聊'));assert.equal(ambiguousResult.reply,ambiguous);assert.equal(ambiguousResult.questionCount,1);});
test('authored anchors count toward diagnostics and the character budget without being truncated',t=>{const repo=setup(t);const anchor='要看看窗外是不是下雨了吗？';const plan=repo.plan('miyue','聊聊',{anchor});const result=repo.enforce('我刚把杯子放下。你那边呢？',plan);assert.equal(result.reply,`${anchor}\n我刚把杯子放下。\n你那边呢？`);assert.equal(result.questionCount,2);assert.ok(result.warnings.includes('question_punctuation_over_budget'));const longAnchor='甲'.repeat(950);const longPlan=repo.plan('miyue','聊聊',{anchor:longAnchor});assert.equal(longPlan.anchor,longAnchor);assert.equal(longPlan.maxChars,950);assert.equal(repo.enforce('',longPlan).reply,longAnchor);assert.equal(repo.enforce('模型额外正文。',longPlan).reply,longAnchor);});
test('quoted examples of praise and advice survive conservative style filtering',t=>{const repo=setup(t);const plan=repo.plan('miyue','先别给建议');const result=repo.enforce('她说“这个安排很棒”，我当时没接话。比如别人建议你早点睡，也未必适合。这里确实挺折腾。',plan);assert.match(result.reply,/这个安排很棒/);assert.match(result.reply,/别人建议你早点睡/);assert.doesNotMatch(result.repairs.join(','),/removed_generic_praise|removed_advice/);});
test('a committed no-question preference remains in generation context while the receipt audits actual output',t=>{const repo=setup(t),setting=repo.plan('miyue','别老问我问题');const first=repo.enforce('知道了，我会自然停下。',setting);const receipt=repo.commit(setting,first,'policy-message-1');assert.equal(repo.receipt('policy-message-1').questionCount,0);assert.deepEqual(repo.receipt('policy-message-1'),receipt);const later=repo.plan('miyue','今天发生了一件事');assert.equal(later.questionBudget,0);const result=repo.enforce('我听着。你想从哪里说起？',later);assert.equal(result.reply,'我听着。\n你想从哪里说起？');assert.match(repo.context(later),/追问最多0个/);assert.ok(result.warnings.includes('question_punctuation_over_budget'));const stale=repo.plan('miyue','继续');repo.set('miyue',{noQuestions:false});assert.throws(()=>repo.commit(stale,result,'policy-message-2'),error=>error.code==='STALE_DIALOGUE_POLICY');assert.equal(repo.receipt('policy-message-2'),null);});

test('quoted dialogue closes its quotation on the same line as the question',t=>{const repo=setup(t),plan=repo.plan('zhixia','聊聊',{mode:'scenario'});const result=repo.enforce('她问：“你喜欢吗？”她把纸摊开：“我喜欢这一张。”',plan);assert.doesNotMatch(result.reply,/吗？\n”/);assert.match(result.reply,/吗？”/);});
test('repeated authored life exposition is omitted from the generated continuation',t=>{const repo=setup(t),anchor='我给这盒不存在的花草茶写了个小简报：不装养生专家，也不做甜得发腻的礼盒，只想让人看见它时愿意把泡茶的十分钟留给自己。桌上已经有两组颜色了。',plan=repo.plan('miyue','说说你的近况',{anchor});const result=repo.enforce('我刚在给一盒不存在的花草茶写包装简报，桌上摊着两组颜色，怎么看都觉得各有各的好。窗外忽然安静下来了。',plan);assert.ok(result.repairs.includes('removed_anchor_repetition'));assert.equal(result.reply,anchor+'\n窗外忽然安静下来了。');});

test('unverified source comparison cannot turn missing implementation dates into a confident conclusion',t=>{const repo=setup(t),plan={...repo.plan('wenxi','现在实施了吗'),unverifiedSourceChange:true};const result=repo.enforce('两份材料的数字不同。也就是说，**没有实施**。目前没有独立核实。',plan);assert.equal(result.reply,'两份材料的数字不同。\n目前没有独立核实。');assert.ok(result.repairs.includes('removed_unverified_conclusion'));});


test('requested recall preserves an evidence-backed paraphrase instead of deleting it by substring length',t=>{
 const repo=setup(t),plan={...repo.plan('miyue','我昨天说先拼哪部分？',{sources:['我买了一副海边的拼图，打算先找边框。','今晚拼完边框就算了，中间那片天空留到明天。']}),behavior:{intent:'recall'}};
 const result=repo.enforce('你昨天说的是先拼边框，中间那片天空留到今天。',plan);
 assert.equal(result.reply,'你昨天说的是先拼边框，中间那片天空留到今天。');
 assert.deepEqual(result.warnings,['recall_paraphrase_not_literal']);
 const empty={...plan,sources:[]};
 assert.throws(()=>repo.enforce('你上次说你在上海住过。',empty),e=>e.code==='DIALOGUE_POLICY_REJECTED');
});


test('question budgets cannot delete substantive explanations, negations, quotations, or mixed statements',t=>{
 const repo=setup(t),plan={...repo.plan('miyue','别老问我问题'),behavior:{intent:'recall'}};
 const cases=[
  ['他认错人，你跟不跟？跟了可能整条线走偏。','他认错人，你跟不跟？\n跟了可能整条线走偏。'],
  ['这只是测试版，怎么能说已经正式发布了？','这只是测试版，怎么能说已经正式发布了？'],
  ['他最后只问了一句：“你还好吗？”','他最后只问了一句：“你还好吗？”'],
  ['我选了蓝色，你觉得呢？','我选了蓝色，你觉得呢？'],
  ['没什么要紧事，就是想跟你说一句：我今天挺好的，你呢。','没什么要紧事，就是想跟你说一句：我今天挺好的，你呢。'],
  ['少的那块到底是不能看，还是那里发生了别的、他根本意识不到？玩的时候大概会一直想“我是不是也漏了什么”。','少的那块到底是不能看，还是那里发生了别的、他根本意识不到？\n玩的时候大概会一直想“我是不是也漏了什么”。'],
 ];
 for(const [raw,expected] of cases){const result=repo.enforce(raw,plan);assert.equal(result.reply,expected);assert.ok(!result.repairs.includes('limited_questions'));}
 const sole=repo.enforce('你最想去哪个城市生活一阵？',plan);assert.equal(sole.reply,'你最想去哪个城市生活一阵？');
});
