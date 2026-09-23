import test from'node:test';
import assert from'node:assert/strict';
import {conversationQualityPlan,conversationQualityIssues,conversationQualityEnforce,omitSaturatedLifeAsides}from'../lib/conversation-quality.mjs';

test('typed triggers own utterance provenance, independently of legacy routing hints',()=>{
 for(const type of ['desktop_invitation','scheduled_opportunity']){
  const plan=conversationQualityPlan({trigger:{type,userText:null},userText:'我先忙了，哄哄我',semantic:{intent:'close'}});
  assert.equal(plan.currentText,'');assert.equal(plan.allowClosing,false);assert.equal(plan.initiating,true);
  assert.match(plan.context,/没有新的用户原话/);assert.doesNotMatch(plan.context,/用户当前话是|哄哄我|用户明确收尾/);
 }
 const spoken=conversationQualityPlan({trigger:{type:'user_message',userText:'哄哄我，今天有点累'},userText:'ignored internal hint',initiating:true});
 assert.equal(spoken.currentText,'哄哄我，今天有点累');assert.equal(spoken.initiating,false);
 assert.match(spoken.context,/用户当前话是“哄哄我，今天有点累”/);
 assert.equal(conversationQualityPlan({userText:'晚安'}).allowClosing,true,'legacy direct callers remain supported');
});

test('local life-aside omission preserves whole answers, quoted reports, opinions and affection',()=>{
  const plan={suppressStatusReport:true};
  for(const reply of ['我这边面刚煮好。','“我这边面刚煮好。”这句话是你刚才引用的。','我这边也想你。','我这边觉得这本书不错。'])assert.deepEqual(omitSaturatedLifeAsides(reply,plan),{reply,repairs:[]});
  assert.equal(omitSaturatedLifeAsides('这球进得漂亮。我这边碗还没洗。',plan).reply,'这球进得漂亮。');
  assert.equal(omitSaturatedLifeAsides('我这边面刚煮好。',{suppressStatusReport:false}).reply,'我这边面刚煮好。');
});

test('repeated status-report form is suppressed only within the same activity and without a relevant question',()=>{
  const conversation=[{speaker:'assistant',text:'我这边刚把鞋带系好，准备出去散步。'},{speaker:'assistant',text:'我这会儿还在门口，刚找到钥匙。'}];
  const plan=conversationQualityPlan({userText:'今晚看看比赛',conversation,sameActivity:true});
  assert.equal(plan.suppressStatusReport,true);
  assert.equal(conversationQualityEnforce('我这边还在门口，外套还没穿好。你支持哪一队？',plan).reply,'你支持哪一队？');
  assert.equal(conversationQualityEnforce('我也想你。',plan).reply,'我也想你。');
  for(const options of [{userText:'你现在在做什么？'},{initiating:true},{sameActivity:false}])assert.equal(conversationQualityPlan({userText:'今晚看看比赛',conversation,sameActivity:true,...options}).suppressStatusReport,false);
});

test('affection is not turned into repeated demands for proof or accusations of using her',()=>{
  const plan=conversationQualityPlan({userText:'我一直在想你呀'});
  for(const line of ['你今晚是真在那边想我，还是闲下来才想起这边还有个能踩一脚的人。','你说想我这件事，我得听你自己讲出来，问来的那句不算数。']){
    assert.ok(conversationQualityIssues(line,plan).includes('unfounded_affection_test'));
    assert.equal(conversationQualityEnforce('我也想你。'+line,plan).reply,'我也想你。');
  }
  for(const line of ['你想聊比赛还是电影？','我也喜欢你这样直接说想我。','“你是真想我还是无聊”听着像在怀疑人。'])assert.deepEqual(conversationQualityIssues(line,plan),[]);
});

test('model envelope headings never appear as a chat opening, but quoted headings remain',()=>{
  const plan=conversationQualityPlan({userText:'聊聊你的小事'});
  assert.ok(conversationQualityIssues('【本轮回复】\n我挑了件蓝外套。',plan).includes('echoed_reply_label'));
  assert.equal(conversationQualityEnforce('【本轮回复】\n我挑了件蓝外套。',plan).reply,'我挑了件蓝外套。');
  for(const label of ['【本轮对话】','【本轮】']){
    assert.ok(conversationQualityIssues(label+'\n回来啦。',plan).includes('echoed_reply_label'));
    assert.equal(conversationQualityEnforce(label+'\n回来啦。',plan).reply,'回来啦。');
    assert.equal(conversationQualityEnforce('“'+label+'”是刚才那个标题。',plan).reply,'“'+label+'”是刚才那个标题。');
  }
  const quote='“【本轮回复】”是一个标签。';
  assert.equal(conversationQualityEnforce(quote,plan).reply,quote);
});

test('loss replies cannot turn earlier reminders into hindsight scolding; factual and quoted recall survive',()=>{
  const plan=conversationQualityPlan({userText:'彻底捞不着了，哎'});
  for(const line of ['我昨天还跟你说别让电量低于三成，今天就听见这个。','下次飞之前先看风向这课也上到肉里了，比任何人叮嘱你都管用。','谁让你不听劝。']){
    assert.ok(conversationQualityIssues(line,plan).includes('hindsight_scolding'));
    assert.equal(conversationQualityEnforce(line+'这也太可惜了。',plan).reply,'这也太可惜了。');
  }
  for(const line of ['你昨天说逆风回来差点没电了。','我刚才跟你说我挑了件蓝外套。','“我早就提醒过你”这种话听着不舒服。']){
    assert.deepEqual(conversationQualityIssues(line,plan),[]);
    assert.equal(conversationQualityEnforce(line,plan).reply,line);
  }
});

test('active airport turn prevents unsolicited withdrawal while retaining the natural opening',()=>{
  const plan=conversationQualityPlan({userText:'过了安检咯～还有一个半小时，足足够咯'});
  const result=conversationQualityEnforce('过了安检就稳了。你先忙你的登机，我等你说到了。',plan);
  assert.equal(plan.allowClosing,false);
  assert.equal(result.reply,'过了安检就稳了。');
  assert.deepEqual(result.repairs,['removed_uninvited_withdrawal']);
});

test('current explicit goodbye alone permits closing and old busy history does not',()=>{
  const old=conversationQualityPlan({userText:'想你',conversation:[{speaker:'user',text:'我先忙了'},{speaker:'assistant',text:'好'}]});
  assert.equal(old.allowClosing,false);
  assert.equal(conversationQualityPlan({userText:'我先忙了'}).allowClosing,true);
  assert.equal(conversationQualityPlan({userText:'我现在要登机了，晚点再聊'}).allowClosing,true);
  assert.equal(conversationQualityPlan({userText:'想你，我先忙了'}).allowClosing,true);
});

test('resolved semantics controls both closing enforcement and the rendered instruction',()=>{
  const plan=conversationQualityPlan({userText:'晚点我再跟你说后面怎么样。',semantic:{intent:'close'}});
  assert.equal(plan.allowClosing,true);
  assert.match(plan.context,/用户明确收尾/);
  assert.doesNotMatch(plan.context,/不要擅自说|用户仍在互动中/);
  assert.equal(conversationQualityIssues('等你回来再聊后面的事。',plan).includes('uninvited_withdrawal'),false);
  const quoted=conversationQualityPlan({userText:'那一段的最后一句是晚安',semantic:{intent:'answer'}});
  assert.equal(quoted.allowClosing,false);
  assert.doesNotMatch(quoted.context,/用户明确收尾/);
});

test('acknowledged repeated airport reminders are removed but the response stays natural',()=>{
  const plan=conversationQualityPlan({userText:'知道了知道了[擦汗]',conversation:[
    {speaker:'assistant',text:'证件和充电器别忘了。'},
    {speaker:'assistant',text:'登机口也记得确认。'},
  ]});
  const result=conversationQualityEnforce('知道了，我不念了。到机场先看航站楼和登机口。你先忙你的。',plan);
  assert.equal(result.reply,'知道了，我不念了。');
  assert.ok(result.repairs.includes('removed_repeated_unsolicited_advice'));
  assert.ok(result.repairs.includes('removed_uninvited_withdrawal'));
});

test('explicit travel advice, quoted discussion, factual travel text, and URLs survive',()=>{
  const plan=conversationQualityPlan({userText:'给我一点登机注意事项',conversation:[{speaker:'assistant',text:'记得确认登机口。'}]});
  const reply='到机场先看航站楼和登机口。航站楼在 T2。她说“你先忙你的”让我不舒服。链接是 https://example.test/?at=12:30。';
  assert.deepEqual(conversationQualityIssues(reply,plan),[]);
  assert.equal(conversationQualityEnforce(reply,plan).reply,reply);
});

test('plans merge assistant bubbles, bound reminder rows, and remove only a withdrawal clause',()=>{
  const conversation=[];for(let index=0;index<20;index++)conversation.push({speaker:'assistant',text:`记得带身份证 ${index}。`});
  const plan=conversationQualityPlan({userText:'陪我聊会儿',conversation});
  assert.ok(plan.recentAdvice.length<=12);
  assert.ok(plan.recentAdvice.reduce((total,row)=>total+row.text.length,0)<=2000);
  assert.ok(plan.context.length<=700);
  assert.equal(conversationQualityEnforce('抱抱你，你先忙你的。',plan).reply,'抱抱你。');
});

test('history timestamp is stripped without touching surrounding content',()=>{
  const result=conversationQualityEnforce('【历史消息·2026-09-08 19:15】我记得这件事。',conversationQualityPlan({userText:'继续说'}));
  assert.equal(result.reply,'我记得这件事。');
  assert.ok(result.repairs.includes('removed_history_timestamp'));
});

test('clear dismissals are removed whole unless a substantive affectionate clause precedes them',()=>{
  const plan=conversationQualityPlan({userText:'陪我一会儿'});
  const reply='抱抱你，你先忙吧。你不用管我，去洗漱你的。你安心等你的。等你回来再说。';
  assert.equal(conversationQualityEnforce(reply,plan).reply,'抱抱你。');
  assert.ok(conversationQualityIssues(reply,plan).includes('uninvited_withdrawal'));
});

test('acknowledgement stops new command reminders across recent topics without harming facts or questions',()=>{
  const plan=conversationQualityPlan({userText:'别催啦，我知道了',conversation:[{speaker:'assistant',text:'证件充电器别还搁家里。'}]});
  assert.equal(conversationQualityEnforce('把充电器身份证塞进去。去接点水。航站楼在 T2。你已经带上充电器了吗？https://example.test/?gate=T2',plan).reply,'航站楼在 T2。你已经带上充电器了吗？https://example.test/?gate=T2');
});

test('new timestamp form and paragraph breaks are repaired without touching quoted timestamp discussion',()=>{
  const plan=conversationQualityPlan({userText:'继续说'});
  assert.equal(conversationQualityEnforce('第一段。\n\n【2026-09-10 16:11】第二段。',plan).reply,'第一段。\n\n第二段。');
  const quoted='“【2026-09-10 16:11】”是消息时间，不是正文。';
  assert.equal(conversationQualityEnforce(quoted,plan).reply,quoted);
});

test('casual conversation drops unsolicited caretaking bookends while retaining her own content',()=>{
  const plan=conversationQualityPlan({userText:'我坐下了，陪你聊会儿'});
  const reply='记得喝点水。今天那件蓝外套配裙子比我想的顺眼。你舒服就好。';
  assert.deepEqual(conversationQualityIssues(reply,plan),['unsolicited_caretaking_opening','formulaic_reassurance_ending']);
  const fixed=conversationQualityEnforce(reply,plan);
  assert.equal(fixed.reply,'今天那件蓝外套配裙子比我想的顺眼。');
  assert.ok(fixed.repairs.includes('removed_formulaic_reassurance_ending'));
});

test('explicit advice and comfort requests still permit care, without deleting factual uses of 就好',()=>{
  const advice=conversationQualityPlan({userText:'出门要注意什么？'});
  assert.equal(conversationQualityEnforce('记得带证件。',advice).reply,'记得带证件。');
  const comfort=conversationQualityPlan({userText:'我有点担心，你安慰我一下'});
  assert.deepEqual(conversationQualityIssues('你平平安安就好。',comfort),[]);
  const ordinary=conversationQualityPlan({userText:'你今天怎么样'});
  for(const reply of ['我把衣服挂起来就好。','你说“你开心就好”这句话有点敷衍。','这件外套搭蓝裙子就好。'])assert.equal(conversationQualityEnforce(reply,ordinary).reply,reply);
  const requested=conversationQualityPlan({userText:'提醒我出门要带什么'});
  assert.equal(conversationQualityEnforce('记得带上证件。',requested).reply,'记得带上证件。');
});

test('ordinary updates do not authorize releasing the user from the conversation',()=>{
 const open=conversationQualityPlan({userText:'等会我去弄杯咖啡去',semantic:{intent:'respond'}});
 for(const text of ['去弄吧，我这会儿也不急着要你回。','你先歇着，我这边刚坐下。']){
  assert.ok(conversationQualityIssues(text,open).includes('uninvited_withdrawal'));
 }
 assert.deepEqual(conversationQualityIssues('你慢慢喝，我喜欢拿铁的奶味。',open),[]);
 const close=conversationQualityPlan({userText:'我先开会了，晚点聊',semantic:{intent:'close'}});
 assert.deepEqual(conversationQualityIssues('去吧，我不急着要你回。',close),[]);
});

test('post-filter receipt alone cannot replace a topic reply but acknowledgements and short opinions remain valid',async()=>{
 const {replyRemainderIssues}=await import('../lib/conversation-quality.mjs');
 for(const text of ['去弄吧。','好呀。','嗯，那你先去吧。',''])assert.deepEqual(replyRemainderIssues(text,{engagement:'continue_topic'}),['topic_reply_missing']);
 for(const text of ['我喜欢拿铁。','来杯冰的挺痛快。','咖啡还是意式加奶？'])assert.deepEqual(replyRemainderIssues(text,{engagement:'continue_topic'}),[]);
 for(const engagement of ['close','acknowledge','answer'])assert.deepEqual(replyRemainderIssues('好的。',{engagement}),[]);
});
