import test from 'node:test';
import assert from 'node:assert/strict';
import {discussionReceiptProtocol,prepareDiscussion,parseDiscussionAnnotation,withDiscussionProtocol} from '../lib/discussion-routing.mjs';

const topic={id:'identity',category:'philosophy',title:'身份与变化'};
const trigger={type:'user_message'};
function fixture(active=null){const calls=[];return{calls,repository:{active:()=>active,choose:options=>{calls.push(options);return topic;}}};}

test('generic invitations preserve automatic blocks; only explicitly named category may force a one-off',()=>{
 const f=fixture();prepareDiscussion({...f,trigger,semantic:{intent:'share',discussionRequest:{category:'any'}}});
 assert.equal(f.calls[0].force,false);
 prepareDiscussion({...f,trigger,semantic:{intent:'share',discussionRequest:{category:'philosophy'}}});
 assert.equal(f.calls[1].force,true);assert.equal(f.calls[1].category,'philosophy');
});
test('substantive disagreement and neutral acknowledgements retain source material without selecting a new topic',()=>{
 const f=fixture({id:'exposure',topic,text:'实际讲过的角度'});
 for(const state of ['engaged','neutral']){const r=prepareDiscussion({...f,trigger,semantic:{intent:'respond',discussionResponse:{state}}});assert.equal(r.exposureId,'exposure');assert.equal(r.openerText,'实际讲过的角度');}
 assert.equal(f.calls.length,0);
});
test('requests for more of the ongoing category continue the current discussion',()=>{
 const f=fixture({id:'exposure',topic,text:'已说内容'});
 const r=prepareDiscussion({...f,trigger,semantic:{intent:'share',continuity:'continue',discussionResponse:{state:'wants_more'},discussionRequest:{category:'philosophy'}}});
 assert.equal(r.exposureId,'exposure');assert.equal(f.calls.length,0);
});
test('comfort, affection, accepted offers and protected activities never get hijacked by a new discussion',()=>{
 const f=fixture();for(const intent of ['comfort','affection','boundary','close'])assert.equal(prepareDiscussion({...f,trigger,semantic:{intent,discussionRequest:{category:'any'}}}),null);
 assert.equal(prepareDiscussion({...f,trigger,semantic:{intent:'share',acceptsOffer:true}}),null);
 assert.equal(prepareDiscussion({...f,trigger:{type:'scheduled_opportunity'},protectedTurn:true,random:()=>0}),null);
 assert.equal(f.calls.length,0);
});
test('deferred, topic change, rejection and unknown interest do not force continuation or penalize in routing',()=>{
 const f=fixture({id:'old',topic,text:'旧话题'});
 for(const state of ['deferred','changed_topic','blocked','less','unknown'])assert.equal(prepareDiscussion({...f,trigger,semantic:{intent:'respond',discussionResponse:{state}},random:()=>0}),null);
 assert.equal(f.calls.length,0);
});
test('desktop affection gestures remain affection; normal openings sample without changing global schedule',()=>{
 const f=fixture();assert.equal(prepareDiscussion({...f,trigger:{type:'desktop_invitation',gesture:'affection'},random:()=>0}),null);
 assert.equal(prepareDiscussion({...f,trigger:{type:'scheduled_opportunity'},random:()=>.8}),null);
 assert.equal(prepareDiscussion({...f,trigger:{type:'desktop_invitation',gesture:'care'},random:()=>.1}).topic.id,topic.id);
 assert.equal(f.calls.length,1);
});
test('ordinary conversational space may introduce one sourced discussion without forcing a topic',()=>{
 const f=fixture();
 assert.equal(prepareDiscussion({...f,trigger,semantic:{intent:'open',source:'none'},spontaneous:true,random:()=>.8}),null);
 assert.equal(prepareDiscussion({...f,trigger,semantic:{intent:'open',source:'none'},spontaneous:true,random:()=>.1})?.topic.id,topic.id);
 assert.equal(prepareDiscussion({...f,trigger,semantic:{intent:'comfort',source:'none'},protectedTurn:true,spontaneous:true,random:()=>0}),null);
 assert.equal(f.calls.length,1);
});
test('annotation parser never mistakes message prose or incomplete optional JSON for a delivery receipt',()=>{
 assert.equal(parseDiscussionAnnotation('聊了一会儿哲学'),null);
 assert.equal(parseDiscussionAnnotation('{"reply":"你好","discussion":'),null);
 assert.deepEqual(parseDiscussionAnnotation({discussion:{topicId:'identity',quote:'实际最终正文原话'}}),{topicId:'identity',quote:'实际最终正文原话'});
});
test('the reusable receipt contract has no legacy prose limits and proactive wrapping keeps it',()=>{
 const discussion={topicId:'identity'};const protocol=discussionReceiptProtocol(discussion);
 assert.match(protocol,/discussion:null/);assert.match(protocol,/最终正文/);assert.doesNotMatch(protocol,/80到160|240字|表达优先级/);
 const wrapped=withDiscussionProtocol([{role:'system',content:'base'}],discussion);
 assert.match(wrapped[0].content,/"identity"/);assert.match(wrapped[0].content,/discussion:null/);
});
