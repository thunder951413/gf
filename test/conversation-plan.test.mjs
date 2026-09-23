import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseInitiative, conversationTrigger, createConversationPlan, conversationPlanContext, dynamicTurnPlanContext, selectedOpportunitySpec } from '../lib/conversation-plan.mjs';

test('a model-selected recall with no matching evidence still verifies history instead of creating it', () => {
  const plan = createConversationPlan({ trigger:conversationTrigger({type:'user_message',userText:'阿澜昨天约的展去了吗？',at:'2026-09-21T06:00:00Z'}),semantic:{status:'model',decision:{intent:'recall',source:'none',imagined:false,needsCurrentState:false}},memory:{selected:[],represented:[]},policy:{} });
  assert.equal(plan.historicalCheck,true);
});

test('only a user-message trigger can carry actual user text', () => {
  const user = conversationTrigger({ type: 'user_message', userText: '这是真正发来的话', at: '2026-09-12T01:02:03Z' });
  assert.deepEqual(user, { type: 'user_message', userText: '这是真正发来的话', at: '2026-09-12T01:02:03.000Z' });
  for (const type of ['desktop_invitation', 'scheduled_opportunity']) {
    assert.throws(() => conversationTrigger({ type, userText: '不能伪造用户输入' }), TypeError);
    assert.deepEqual(conversationTrigger({ type, at: '2026-09-12T01:02:03Z' }).userText, null);
  }
  assert.throws(() => conversationTrigger({ type: 'user_message', userText: null }), TypeError);
});

test('initiative selection has fixed priority and one mutually exclusive result', () => {
  const all = {
    thread: { key: 'thread' }, pursuit: { key: 'pursuit' }, runtime: { key: 'runtime' },
    material: { key: 'material' }, need: { key: 'need', needChannel: true }, agenda: { key: 'agenda' }, followup: { key: 'followup' }, preferContent: true,
  };
  assert.deepEqual(chooseInitiative(all), { kind: 'followup', value: all.followup });
  const reordered = { preferContent: true, pursuit: all.pursuit, thread: all.thread, material: all.material, agenda: all.agenda, followup: null, runtime: all.runtime, need: all.need };
  assert.deepEqual(chooseInitiative(reordered), { kind: 'agenda', value: all.agenda });
  assert.deepEqual(chooseInitiative({ need: { key: 'not-ready', needChannel: false }, material: all.material }), { kind: 'material', value: all.material });
  assert.deepEqual(chooseInitiative({}), { kind: 'conversation', value: null });
});

test('the selected initiative becomes one speakable turn cue',()=>{
  const selected=chooseInitiative({
    runtime:{key:'runtime:work:1',title:'修改包装图',context:{activity:'修改包装图',location:'工作室',seed:'有一处配色终于顺眼了'}},
    life:{topicKey:'life:ignored',context:'不应进入本轮'},
  });
  assert.deepEqual(selectedOpportunitySpec(selected),{kind:'runtime',key:'runtime:work:1',title:'修改包装图',cue:'修改包装图；工作室；有一处配色终于顺眼了'});
  const plan=createConversationPlan({trigger:conversationTrigger({type:'scheduled_opportunity'}),opportunity:selected,policy:{maxChars:200}});
  assert.equal(plan.selectedOpportunity.key,'runtime:work:1');
  assert.match(conversationPlanContext(plan),/有一处配色终于顺眼了/);
  assert.doesNotMatch(conversationPlanContext(plan),/不应进入本轮/);
  assert.ok(Object.isFrozen(plan.selectedOpportunity));
});

test('canonical initiative cues follow each provider public shape',()=>{
  const cases=[
    [{kind:'followup',value:{id:'f1',topic:'明天的面试',source:{text:'很长的旧原话不应替代事项标题'}}},{kind:'followup',key:'f1',title:'明天的面试',cue:'明天的面试'}],
    [{kind:'agenda',value:{key:'agenda:p1:opening:1',title:'一起看电影',anchor:'我们约的电影到时间了。',detail:'先确认现在是否方便'}},{kind:'agenda',key:'agenda:p1:opening:1',title:'一起看电影',cue:'我们约的电影到时间了。；先确认现在是否方便'}],
    [{kind:'need',value:{key:'need:rest',needChannel:'physical',context:'眼睛有点累，想歇一会儿'}},{kind:'need',key:'need:rest',title:'',cue:'眼睛有点累，想歇一会儿'}],
    [{kind:'material',value:{id:'daily-1',title:'和妈妈通电话',detail:'正在通话',phase:{detail:'刚聊到家里的花'},source:{url:'https://example.test/full'}}},{kind:'material',key:'daily-1',title:'和妈妈通电话',cue:'正在通话'}],
    [{kind:'life',value:{topicKey:'life-topic:trip:food',angle:{title:'当地早餐'},context:'可以围绕早餐摊的具体差异聊开'}},{kind:'life',key:'life-topic:trip:food',title:'当地早餐',cue:'可以围绕早餐摊的具体差异聊开'}],
    [{kind:'pursuit',value:{pendingKey:'companion-pursuit:miyue:book:1',title:'长日将尽',stage:{label:'读到第三章',action:'继续读',detail:'注意到管家的自我辩护'},history:[{actualReply:'此前已分享'}],source:{url:'https://example.test/book'}}},{kind:'pursuit',key:'companion-pursuit:miyue:book:1',title:'长日将尽',cue:'读到第三章；继续读；注意到管家的自我辩护'}],
    [{kind:'thread',value:{pendingKey:'life-thread:1',title:'做一本拼贴册',beat:{title:'试配色',text:'把两张旧票根放在一起',emotion:'有点舍不得裁',need:'先看看整体'}}},{kind:'thread',key:'life-thread:1',title:'做一本拼贴册',cue:'把两张旧票根放在一起；有点舍不得裁；先看看整体'}],
  ];
  for(const [input,expected] of cases)assert.deepEqual(selectedOpportunitySpec(input),expected);
});

test('conversation plan is a frozen snapshot with real recent IDs, bounded budget, and explicit-only extra', () => {
  const trigger = conversationTrigger({ type: 'user_message', userText: '继续说刚才那个', at: '2026-09-12T01:02:03Z' });
  const input = {
    trigger,
    policy: { intent: 'respond', maxChars: 9_000, questionBudget: 7, behavior: { explicit: true, extra: 'tender', style: { warmth: '柔软体贴' }, expressivePreferences: { coyness: 88 } } },
    conversation: [{ speaker: 'assistant', id: 'old' }, { speaker: 'user', id: 'user-row' }, { speaker: 'assistant', id: 'reply-1' }, { speaker: 'assistant', id: 'reply-2' }, { speaker: 'assistant' }],
    thread: { holdsTopic: true }, runtimeRevision: 4,
  };
  const plan = createConversationPlan(input);
  assert.equal(plan.mode, 'continue');
  assert.deepEqual(plan.focus, { kind: 'conversation', messageIds: ['reply-1', 'reply-2'] });
  assert.deepEqual(plan.budget, { replyChars: 6000, questionBudget: 2 });
  assert.equal(plan.explicitExpression, 'tender');
  assert.deepEqual(plan.expressivePreferences, { coyness: 88 });
  assert.ok(Object.isFrozen(plan) && Object.isFrozen(plan.budget) && Object.isFrozen(plan.focus) && Object.isFrozen(plan.trigger) && Object.isFrozen(plan.style));
  assert.throws(() => { plan.budget.replyChars = 1; }, TypeError);
  assert.equal(input.policy.maxChars, 9_000);

  const ordinary = createConversationPlan({ trigger, policy: { behavior: { explicit: false, extra: 'tender' } } });
  assert.equal(ordinary.explicitExpression, null);
});

test('a genuine acknowledgement remains brief without declaring the conversation over', () => {
  const input={trigger:conversationTrigger({userText:'好的',at:'2026-09-12T13:00:00Z'}),policy:{maxChars:60,behavior:{acknowledgement:true}},conversation:[{speaker:'assistant',id:'last'}],thread:{holdsTopic:true}};
  const plan=createConversationPlan(input);
  assert.equal(plan.mode,'acknowledge');
  assert.match(conversationPlanContext(plan),/保持谈话可以继续/);
  assert.doesNotMatch(conversationPlanContext(plan),/在这里停顿/);
});

test('a validated semantic accepted offer fulfills the focused message without a conversation thread', () => {
  const input={trigger:conversationTrigger({userText:'好，你说吧',at:'2026-09-12T13:00:00Z'}),policy:{maxChars:300,behavior:{acknowledgement:true}},conversation:[{speaker:'assistant',id:'last'}],semantic:{decision:{acceptsOffer:true,focusMessageId:'last',offerQuote:'要不要听我说说这本书？'}}};
  const accepted=createConversationPlan(input);
  assert.equal(accepted.mode,'continue');
  assert.equal(accepted.continuationAction,'fulfill_offer');
  assert.deepEqual(accepted.focus.messageIds,['last']);
  assert.equal(accepted.budget.replyChars,300);
  assert.match(conversationPlanContext(accepted),/安静相伴/);
  assert.match(conversationPlanContext(accepted),/不把提议改成必须讲新故事/);
  assert.match(dynamicTurnPlanContext(accepted),/实际兑现该提议/);assert.match(dynamicTurnPlanContext(accepted),/要不要听我说说这本书/);
});

test('close, boundary, and proactive opening keep their semantics over an accepted-offer signal', () => {
  const semantic={decision:{acceptsOffer:true,focusMessageId:'last'}};
  const user=conversationTrigger({userText:'先这样吧',at:'2026-09-12T13:00:00Z'});
  const closed=createConversationPlan({trigger:user,policy:{intent:'close',behavior:{acknowledgement:true}},semantic});
  assert.equal(closed.mode,'close');
  assert.equal(closed.continuationAction,null);
  const bounded=createConversationPlan({trigger:user,policy:{behavior:{intent:'boundary',acknowledgement:true}},semantic});
  assert.equal(bounded.mode,'boundary');
  assert.equal(bounded.continuationAction,null);
  const proactive=createConversationPlan({trigger:conversationTrigger({type:'desktop_invitation'}),policy:{behavior:{acknowledgement:true}},semantic});
  assert.equal(proactive.mode,'initiate');
  assert.equal(proactive.continuationAction,null);
});


test('a style preference can refer to prior speech without asking for more of that topic', () => {
  const plan=createConversationPlan({trigger:conversationTrigger({userText:'说一两句就行，你讲太多我插不上嘴',at:'2026-09-15T12:30:00Z'}),policy:{maxChars:300,behavior:{intent:'respond',understanding:{kind:'conversation_preference'}}},thread:{holdsTopic:true},semantic:{decision:{intent:'preference',continuity:'continue',focusMessageId:'last'}}});
  assert.equal(plan.mode,'respond');
  assert.deepEqual(plan.focus.messageIds,['last']);
  assert.equal(plan.continuationAction,null);
  assert.doesNotMatch(conversationPlanContext(plan),/提供相对于上条的新信息|回答其中的指代与细节/);
  assert.match(conversationPlanContext(plan),/交流方式|表达方式|聊天方式/);
});

test('a source-backed history question uses factual recall even when the adjacent thread continues',()=>{
  const trigger=conversationTrigger({userText:'那后来给谁了？'});
  const semantic={decision:{intent:'answer',source:'none',memoryIds:['raw:old'],continuity:'continue',focusMessageId:'last'}};
  const plan=createConversationPlan({trigger,semantic,thread:{holdsTopic:true},policy:{behavior:{intent:'respond'}}});
  assert.equal(plan.mode,'recall');assert.equal(plan.historicalCheck,true);
  assert.match(conversationPlanContext(plan),/本轮只核对过去/);
  const external=createConversationPlan({trigger,semantic:{decision:{...semantic.decision,source:'new'}}});
  assert.notEqual(external.mode,'recall');
  const lexical=createConversationPlan({trigger,semantic:{decision:{intent:'answer',source:'none'}},memory:{selected:[{sourceIds:['old'],lowConfidence:false}]}});
  assert.equal(lexical.historicalCheck,false);assert.equal(lexical.preserveEvidenceWindow,true);
  const liveState=createConversationPlan({trigger,semantic:{decision:{intent:'answer',source:'none',ownLife:true,needsCurrentState:true,memoryIds:['old']}},memory:{selected:[{sourceIds:['old']}]}});
  assert.equal(liveState.historicalCheck,false);
  const fallback=createConversationPlan({trigger:conversationTrigger({userText:'你之前跟谁学过什么？'}),semantic:{status:'fallback',decision:null},memory:{selected:[{sourceIds:['old'],lowConfidence:false}]}});
  assert.equal(fallback.historicalCheck,true);assert.equal(fallback.continuationAction,null);
});


test('current-state questions retain live state even when semantic ownLife is false',()=>{
 const plan=createConversationPlan({trigger:conversationTrigger({userText:'你还在看同一个内容吗，还是已经换了？'}),semantic:{decision:{intent:'answer',source:'none',ownLife:false,needsCurrentState:true,memoryIds:['prior']}},memory:{selected:[{text:'上次聊过一本书'}]}});
 assert.equal(plan.historicalCheck,false);assert.notEqual(plan.mode,'recall');
});


test('imagined closeness retains the present conversation despite relevant old memories',()=>{
 const input={trigger:conversationTrigger({userText:'假如现在从后面抱住你，你会怎样？'}),semantic:{decision:{intent:'answer',source:'none',imagined:true,needsCurrentState:false,memoryIds:['old-hug']}},memory:{selected:[{text:'以前想象过拥抱'}]},policy:{behavior:{intent:'receive_closeness'}}};
 const plan=createConversationPlan(input);
 assert.equal(plan.historicalCheck,false);assert.equal(plan.mode,'receive_closeness');
 assert.doesNotMatch(conversationPlanContext(plan),/本轮只核对过去/);
 const recall=createConversationPlan({...input,semantic:{decision:{...input.semantic.decision,imagined:false}}});
 assert.equal(recall.historicalCheck,true);
});

test('ordinary plans remain open for topic exchange without forcing questions or a new topic',()=>{
 for(const text of ['等会我去弄杯咖啡去','出门挺早 骑的倒是不算快','我准备下楼买点水果']){
  const plan=createConversationPlan({trigger:conversationTrigger({userText:text}),policy:{behavior:{intent:'respond'},questionBudget:0}});
  assert.equal(plan.engagement,'continue_topic');
  assert.equal(plan.budget.questionBudget,0);
  assert.match(conversationPlanContext(plan),/不等于告别或申请离开/);
  assert.match(conversationPlanContext(plan),/不要求每次问问题/);
 }
 const close=createConversationPlan({trigger:conversationTrigger({userText:'我先忙了，晚点聊'}),policy:{intent:'close'}});
 assert.equal(close.engagement,'close');
 const ack=createConversationPlan({trigger:conversationTrigger({userText:'嗯呢'}),policy:{behavior:{acknowledgement:true}}});
 assert.equal(ack.engagement,'acknowledge');
});

test('requested quiet companionship is exempt from conversational expansion',()=>{
 const plan=createConversationPlan({trigger:conversationTrigger({userText:'不用找话题，陪我安静待会儿'}),policy:{quietPresence:true,behavior:{intent:'respond'},questionBudget:0}});
 assert.equal(plan.engagement,'quiet');
  assert.doesNotMatch(conversationPlanContext(plan),/保持话题有来有回/);
  assert.match(dynamicTurnPlanContext(plan),/安静陪伴/);assert.match(dynamicTurnPlanContext(plan),/不展开新话题或追问/);
});


test('incidental retrieved memories do not turn a new interests question into a past-fact audit',()=>{
  const plan=createConversationPlan({trigger:conversationTrigger({userText:'你最近有没有什么感兴趣的东西？工作以外的。'}),semantic:{status:'model',decision:{intent:'answer',source:'none',ownLife:true,needsCurrentState:false,memoryIds:[]}},memory:{selected:[{id:'raw:old-book',text:'上周看过的一本书。',lowConfidence:false}]}});
  assert.equal(plan.historicalCheck,false);assert.notEqual(plan.mode,'recall');
});
