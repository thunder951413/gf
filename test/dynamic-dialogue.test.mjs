import test from 'node:test';
import assert from 'node:assert/strict';
import { dynamicTurnContext, dynamicAnnotations, dynamicOutputProtocol, buildDynamicChatMessages } from '../lib/dynamic-dialogue.mjs';
import { conversationTrigger, createConversationPlan, dynamicTurnPlanContext } from '../lib/conversation-plan.mjs';

test('a failed semantic judgment cannot introduce an inferred correction or a missing history quote',()=>{
  const text=dynamicTurnContext({semantic:{status:'fallback',decision:{correction:true,turnMeaning:'untrusted interpretation',focusMessageId:'hidden'}},conversation:[{id:'visible',speaker:'user',text:'继续。'}],trigger:{at:'2026-09-20T06:26:00Z'}});
  assert.doesNotMatch(text,/untrusted interpretation|hidden/);assert.match(text,/"interpretation":null/);assert.match(text,/"focus":null/);
});

test('annotation reporting distinguishes omission, explicit no-change and malformed fields without inventing state',()=>{
  assert.equal(dynamicAnnotations('{"reply":"好"}').dynamicsStatus,'omitted');
  assert.equal(dynamicAnnotations('{"reply":"好","dynamics":null}').dynamicsStatus,'unchanged');
  assert.equal(dynamicAnnotations('{"reply":"好","dynamics":[]}').dynamicsStatus,'invalid');
  assert.equal(dynamicAnnotations('{"reply":"好","dynamics":{}}').dynamicsStatus,'proposed');
  assert.equal(dynamicAnnotations('not JSON').dynamicsStatus,'invalid');
});

test('dynamic output schema is selected by the actual trigger and content whitelist',()=>{
  const user=dynamicOutputProtocol({type:'user_message'}),desktop=dynamicOutputProtocol({type:'desktop_invitation'});
  for(const value of [user,desktop]){assert.match(value,/"reply":"正文"/);assert.doesNotMatch(value,/"skip":false|"message":"正文"/);}
  const scheduled=dynamicOutputProtocol({type:'scheduled_opportunity'},{allowedContentIds:['article-1','article-1','article-2']});
  assert.match(scheduled,/"skip":false/);assert.match(scheduled,/"message":"正文"/);assert.doesNotMatch(scheduled,/"reply":"正文"/);assert.match(scheduled,/\["article-1","article-2"\]/);
  const noCandidate=dynamicOutputProtocol({type:'scheduled_opportunity'},{allowedContentIds:[]});
  assert.match(noCandidate,/contentId 必须为 null/);assert.match(noCandidate,/阅读进度.*key 不是 contentId/);
});

test('a current conversational focus excludes unrelated discoveries while life inquiries and proactive turns keep them',()=>{
  const base={role:{id:'miyue'},conversation:[{id:'a1',speaker:'assistant',text:'上午在桥上想起这件事。',createdAt:'2026-09-20T03:29:00Z'}],trigger:{type:'user_message',at:'2026-09-20T06:27:00Z'},userText:'这话不是你跟我说的么',semantic:{status:'model',decision:{intent:'answer',continuity:'continue',source:'none',ownLife:false,needsCurrentState:false,focusMessageId:'a1',correction:true}},facts:{current:{location:'咖啡馆'},dailyLife:[{title:'无关背景'}],pursuit:{title:'另一件事'}},lifeContext:'公开活动机会数据'};
  const messages=buildDynamicChatMessages(base);assert.doesNotMatch(JSON.stringify(messages),/公开活动机会数据|无关背景|另一件事/);
  const currentIndex=messages.findIndex(row=>row.content.startsWith('【当前事实'));const spokenIndex=messages.findIndex(row=>row.content.startsWith('【近期交流原文'));assert.ok(spokenIndex>=0&&currentIndex>spokenIndex);
  const life=buildDynamicChatMessages({...base,semantic:{status:'model',decision:{...base.semantic.decision,ownLife:true}}});assert.match(JSON.stringify(life),/公开活动机会数据|无关背景/);
  const proactive=buildDynamicChatMessages({...base,userText:null,trigger:{...base.trigger,type:'scheduled_opportunity'}});assert.match(JSON.stringify(proactive),/公开活动机会数据/);
});

test('recent assistant wording remains exact evidence without becoming a style demonstration',()=>{
  const text='我又在改图，接了水，你先忙吧。';
  const messages=buildDynamicChatMessages({role:{id:'miyue'},conversation:[{id:'u',speaker:'user',text:'早上好'},{id:'a',speaker:'assistant',text}],userText:'想你了',trigger:{type:'user_message'}});
  assert.equal(messages.filter(row=>row.role==='assistant').length,0);
  const block=messages.find(row=>row.content.startsWith('【近期交流原文'));
  const quoted=JSON.parse(block.content.split('\n')[1]);
  assert.equal(quoted.at(-1).text,text);assert.equal(quoted.at(-1).speaker,'assistant');assert.equal(quoted.at(-1).id,'a');
  const turn=messages.find(row=>row.content.startsWith('【眼前交流'));assert.doesNotMatch(turn.content,/我又在改图/);
  assert.equal(messages.at(-1).content,'想你了');
});

test('reply invocation separates historical claims from the live turn and supplies local time',()=>{
  const messages=buildDynamicChatMessages({
    role:{id:'miyue',name:'林晓薇'},
    conversation:[{id:'a',speaker:'assistant',text:'那本书在你桌上。',createdAt:'2026-09-23T08:10:00Z'}],
    trigger:{type:'user_message',at:'2026-09-23T08:46:00Z'},
    userText:'那是你的书呀',
  });
  const prompt=messages.map(row=>row.content).join('\n');
  assert.match(messages[0].content,/旧助手回复也可能说错/);
  assert.match(prompt,/物品归属|谁拥有/);
  assert.match(prompt,/2026\/09\/23 16:46|2026-09-23 16:46/);
  assert.equal(messages.at(-1).content,'那是你的书呀');
  assert.equal(messages.filter(row=>row.role==='assistant').length,0);
});

test('historical verification survives dynamic prompt rebuilding without new life opportunities', () => {
  const messages = buildDynamicChatMessages({ role:{id:'miyue'}, historicalCheck:true, trigger:{type:'user_message',at:'2026-09-21T06:00:00Z'}, userText:'阿澜昨天约的看展已经完成了吗？', facts:{at:'2026-09-21T06:00:00Z',current:{title:'无关的桥边散步'},dailyLife:[{title:'无关的新美甲'}]}, socialContext:'阿澜的已知安排只有计划', lifeContext:'今天新增的展览机会' });
  const prompt = messages.map(row=>row.content).join('\n');
  assert.match(prompt,/阿澜的已知安排只有计划/);assert.match(prompt,/保留结果未知/);assert.match(prompt,/以原消息日期为基准/);
  assert.doesNotMatch(prompt,/今天新增的展览机会|无关的桥边散步|无关的新美甲/);
  assert.equal(messages.at(-1).content,'阿澜昨天约的看展已经完成了吗？');
});

test('ordinary chat keeps time and location constraints without repeating the detailed work narrative',()=>{
  const facts={current:{kind:'work',title:'反复修改同一张包装图',location:'苏州工作室',startedAt:'2026-09-21T01:00:00Z',endsAt:'2026-09-21T04:00:00Z'},world:{timezone:'Asia/Shanghai',location:'苏州工作室',activity:'反复修改同一张包装图'},pursuit:{title:'不相关的书'}};
  const base={role:{id:'miyue'},trigger:{type:'user_message'},facts,userText:'我是真的想你',lifeParticipation:{mode:'respond',detailedState:false}};
  const messages=buildDynamicChatMessages(base),data=JSON.parse(messages.find(row=>row.content.startsWith('【当前事实')).content.split('】')[1]);
  assert.equal(data.current.kind,'work');assert.equal(data.current.location,'苏州工作室');assert.equal(data.current.endsAt,facts.current.endsAt);
  assert.equal(data.world.location,'苏州工作室');assert.equal(data.world.timezone,'Asia/Shanghai');assert.equal(data.pursuit,null);
  assert.doesNotMatch(JSON.stringify(messages),/反复修改同一张包装图|不相关的书/);
  const detail=buildDynamicChatMessages({...base,userText:'你现在忙什么？',lifeParticipation:{mode:'answer',detailedState:true}});
  assert.match(JSON.stringify(detail),/反复修改同一张包装图/);assert.equal(facts.current.title,'反复修改同一张包装图');
});

test('selected material and expression guidance reach chat and contact but cannot leak into historical verification',()=>{
  const base={role:{id:'miyue'},trigger:{type:'scheduled_opportunity'},userText:null,materialContext:'朋友联系的已分享进度与出处 https://example.test/full-source',expressionContext:'已有重复表达证据',noveltyContext:'本轮重复提醒',lifeParticipation:{mode:'contact',detailedState:false},lifeContext:'新增公开活动'};
  const messages=buildDynamicChatMessages(base),text=JSON.stringify(messages);
  assert.match(text,/朋友联系的已分享进度与出处/);assert.match(text,/https:\/\/example\.test\/full-source/);assert.match(text,/已有重复表达证据/);assert.match(text,/本轮重复提醒/);
  assert.match(messages[0].content,/不设每轮字数或话题配额/);assert.match(messages[0].content,/没有就跳过/);
  const historical=JSON.stringify(buildDynamicChatMessages({...base,historicalCheck:true}));
  assert.doesNotMatch(historical,/朋友联系的已分享进度与出处|已有重复表达证据|本轮重复提醒|新增公开活动/);
});
test('an optional halfway life detail can be offered in ordinary chat without becoming required history',()=>{
  const base={role:{id:'miyue'},trigger:{type:'user_message'},userText:'我们聊会儿',conversationSpace:{mode:'open'},spontaneousContext:'正在读的一本书只读到第二章',facts:{current:{kind:'reading',location:'苏州家中'}}};
  const prompt=JSON.stringify(buildDynamicChatMessages(base));
  assert.match(prompt,/正在读的一本书只读到第二章/);
  assert.match(prompt,/不需要等用户明确要求新闻|刚看到/);
  assert.match(prompt,/候选只是机会，可以不用/);
  const historical=JSON.stringify(buildDynamicChatMessages({...base,historicalCheck:true}));
  assert.doesNotMatch(historical,/正在读的一本书只读到第二章|可选主动性/);
});

test('dynamic generation receives the canonical user purpose and only the selected proactive cue',()=>{
  const affectionPlan=createConversationPlan({trigger:conversationTrigger({userText:'我是真的想你'}),policy:{behavior:{intent:'affection_reply'},maxChars:240},lifeParticipation:{mode:'respond',detailedState:false}});
  const affection=JSON.stringify(buildDynamicChatMessages({role:{id:'miyue'},trigger:affectionPlan.trigger,turnPlan:affectionPlan,userText:'我是真的想你',lifeParticipation:affectionPlan.lifeParticipation,lifeContext:'工作机会：继续修改包装图',facts:{current:{kind:'work',title:'继续修改包装图',location:'工作室'}}}));
  assert.match(affection,/回应用户此刻表达的亲近与想念/);
  assert.doesNotMatch(affection,/工作机会：继续修改包装图|"title":"继续修改包装图"/);

  const proactivePlan=createConversationPlan({trigger:conversationTrigger({type:'scheduled_opportunity'}),policy:{maxChars:300},lifeParticipation:{mode:'contact',detailedState:false},opportunity:{kind:'runtime',value:{key:'runtime:coffee:1',title:'磨咖啡豆',context:{activity:'磨咖啡豆',seed:'第一次把刻度调细了一格'}}}});
  const proactive=JSON.stringify(buildDynamicChatMessages({role:{id:'miyue'},trigger:proactivePlan.trigger,turnPlan:proactivePlan,userText:null,lifeParticipation:proactivePlan.lifeParticipation,lifeContext:'通用生活背景',facts:{current:{kind:'hobby',title:'磨咖啡豆'} }}));
  assert.match(proactive,/runtime:coffee:1|第一次把刻度调细了一格/);
  assert.doesNotMatch(proactive,/未选中的散步机会/);
});

test('the dynamic turn renderer excludes policy-era prose controls and semantic writing suggestions',()=>{
  const plan=createConversationPlan({trigger:conversationTrigger({userText:'刚忙完坐下来，想你了'}),policy:{behavior:{intent:'affection_reply',explicit:true,extra:'tender',forcedOpening:'先照着这句开场'}},semantic:{status:'model',decision:{intent:'answer',turnMeaning:'用户在表达想念',replyDirection:'写心软、草稿和晚饭，再追问用户进度'}}});
  const text=dynamicTurnPlanContext(plan);
  assert.match(text,/回应用户此刻表达的亲近与想念/);
  assert.doesNotMatch(text,/写心软、草稿和晚饭|先照着这句开场|tender/);
});


test('semantic comprehension is retained without turning classifier-authored reply advice into a second director',()=>{
  const semantic={status:'model',decision:{intent:'affection',continuity:'new',source:'none',ownLife:false,needsCurrentState:false,evidence:'想你',turnMeaning:'用户表达想念。',replyDirection:'先介绍草稿，再问吃饭，最后让他去忙。'}};
  const messages=buildDynamicChatMessages({role:{name:'林晓薇'},conversation:[],userText:'想你',trigger:{type:'user_message',at:'2026-09-21T13:00:00Z'},semantic});
  const text=JSON.stringify(messages);
  assert.match(text,/用户表达想念/);
  assert.doesNotMatch(text,/先介绍草稿，再问吃饭，最后让他去忙/);
  assert.equal(semantic.decision.replyDirection,'先介绍草稿，再问吃饭，最后让他去忙。');
});
