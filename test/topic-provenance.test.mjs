import test from 'node:test';
import assert from 'node:assert/strict';
import { topicProvenance, topicProvenanceContext, topicProvenanceIssues } from '../lib/topic-provenance.mjs';

const semantic=id=>({status:'model',decision:{continuity:'continue',focusMessageId:id}});
test('a reply to her proactive black-hole topic keeps assistant origin and user viewpoint separate',()=>{
  const focus={id:'black-hole',speaker:'assistant',kind:'proactive',text:'我刚看到一条讲黑洞的资料，后来又想到星星。'};
  const provenance=topicProvenance({semantic:semantic(focus.id),conversation:[focus]});
  assert.deepEqual(provenance,{focusMessageId:focus.id,adjacent:true,assistantInitiated:true,focusKind:'proactive'});
  assert.match(topicProvenanceContext(provenance),/由你主动发出/);
  assert.deepEqual(topicProvenanceIssues('你今天怎么忽然接这个的，是刚练完吗？',provenance),['adjacent_topic_attribution']);
  assert.deepEqual(topicProvenanceIssues('你刚才说起这个话题，我也觉得安静。',provenance),['assistant_topic_attributed_to_user']);
  assert.deepEqual(topicProvenanceIssues('你觉得人很渺小，我倒觉得安稳。',provenance),[]);
});
test('an ordinary focused reply does not invent who originally chose the subject',()=>{
  const focus={id:'reply',speaker:'assistant',kind:'chat',text:'我也觉得这件事有意思。'};
  const provenance=topicProvenance({semantic:semantic(focus.id),conversation:[{id:'user',speaker:'user',text:'聊聊星星'},focus]});
  assert.equal(provenance.assistantInitiated,false);
  assert.match(topicProvenanceContext(provenance),/最初由谁发起若无依据/);
  assert.deepEqual(topicProvenanceIssues('你怎么突然接这个话题？',provenance),['adjacent_topic_attribution']);
});
test('older focus, fallback judgment, and replies to a user are not reclassified as adjacent assistant topics',()=>{
  const conversation=[{id:'old',speaker:'assistant',kind:'proactive',text:'黑洞'},{id:'new',speaker:'user',text:'另一件事'}];
  const old=topicProvenance({semantic:semantic('old'),conversation});
  assert.equal(old.adjacent,false);assert.equal(topicProvenanceContext(old),'');assert.deepEqual(topicProvenanceIssues('你怎么忽然接这个的？',old),[]);
  assert.equal(topicProvenance({semantic:{status:'fallback',decision:{continuity:'continue',focusMessageId:'old'}},conversation}),null);
  assert.equal(topicProvenance({semantic:semantic('new'),conversation}),null);
});
test('a saved ordinary spontaneous introduction carries its origin to the next turn',()=>{
  const focus={id:'source',speaker:'assistant',kind:'chat',text:'我刚看到一篇文章。'};
  const provenance=topicProvenance({semantic:semantic(focus.id),conversation:[focus],receiptFor:()=>({behavior:{spontaneousIntroduced:'source'}})});
  assert.equal(provenance.assistantInitiated,true);
});
