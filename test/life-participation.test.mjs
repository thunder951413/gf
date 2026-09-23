import test from 'node:test';
import assert from 'node:assert/strict';
import {lifeParticipationPlan, lifeParticipationContext} from '../lib/life-participation.mjs';
import {conversationQualityPlan,conversationQualityIssues} from '../lib/conversation-quality.mjs';

test('user updates and affection do not create a personal-life reporting assignment',()=>{
  for(const text of ['我到北京啦。','今晚早点睡了只能。','我觉得游戏让人换一种生活。','想抱着你。']){
    const plan=lifeParticipationPlan({text});assert.equal(plan.mode,'respond');assert.equal(plan.detailedState,false);
  }
});
test('specific questions restore the state details without requiring another life topic',()=>{
  for(const text of ['你现在在哪里，在做什么？','你晚上打算吃什么？','你也回家啦，晚上打算吃什么'])assert.equal(lifeParticipationPlan({text}).detailedState,true);
  assert.equal(lifeParticipationPlan({text:'文章里写“你晚上打算吃什么”，是在关心吗？'}).detailedState,false);
  assert.equal(lifeParticipationPlan({text:'后来呢？',focused:true}).detailedState,true);
});
test('opening is an opportunity for contact, and a selected material supplies its own reason to share',()=>{
  const plan=lifeParticipationPlan({opening:true});assert.equal(plan.mode,'contact');assert.equal(plan.detailedState,false);
  assert.match(lifeParticipationContext(plan,{scheduled:true}),/可以跳过/);
  const selected=lifeParticipationContext(plan,{material:true});assert.match(selected,/新的进展/);assert.doesNotMatch(selected,/编一件刚发生/);
});

test('report saturation preserves her own feelings and opinions',()=>{
  const plan=conversationQualityPlan({userText:'想你了。',lifeParticipation:lifeParticipationPlan({text:'想你了。'}),conversation:[{speaker:'assistant',text:'我这边杯子刚洗完。'},{speaker:'assistant',text:'我这边窗帘还没拉。'}]});
  assert.equal(plan.suppressStatusReport,true);
  for(const reply of ['我这边也想你。','我这边觉得这个想法挺有意思。','我现在想起你刚才那句话还是会笑。'])assert.ok(!conversationQualityIssues(reply,plan).includes('repeated_status_report'),reply);
});
