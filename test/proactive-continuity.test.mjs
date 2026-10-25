import test from 'node:test';
import assert from 'node:assert/strict';
import {ProactiveContinuity} from '../lib/proactive-continuity.mjs';

test('continuity uses exact visible evidence, caches unchanged dialogue and reports unavailable assessment as unknown',async()=>{
  let now=new Date('2026-09-28T02:00:00Z'),calls=0,bad=false;
  const rows=[{id:'a',speaker:'user',text:'还有后面那件事没讲。'},{id:'b',speaker:'assistant',text:'嗯，我听着。'}];
  const gate=new ProactiveContinuity({complete:async messages=>{
    calls++;assert.doesNotMatch(JSON.stringify(messages),/可供主动分享的材料/);
    return JSON.stringify({state:'unfinished',reason:'等待讲述',evidence:[{messageId:'b',quote:bad?'不存在的依据':rows[1].text}]});
  }},{clock:()=>now});
  assert.equal((await gate.assess('miyue',rows)).state,'unfinished');
  await gate.assess('miyue',rows);assert.equal(calls,1);
  rows[1].text='我继续听。';await gate.assess('miyue',rows);assert.equal(calls,2);
  bad=true;rows[1].text='之后再聊。';
  const unavailable=await gate.assess('miyue',rows);
  assert.equal(unavailable.unavailable,true);assert.equal(unavailable.state,'unknown');
  await gate.assess('miyue',rows);assert.equal(calls,3);
  now=new Date(+now+31*60000);await gate.assess('miyue',rows);assert.equal(calls,4);
});

test('the model judges the meaning of a last user turn instead of its speaker deciding continuity',async()=>{
  let calls=0;
  const gate=new ProactiveContinuity({complete:async messages=>{
    calls++;const [row]=JSON.parse(messages[1].content);
    return JSON.stringify({state:row.id==='goodbye'?'open':'unfinished',reason:'依据用户原话',evidence:[{messageId:row.id,quote:row.text}]});
  }});
  assert.equal((await gate.assess('miyue',[])).state,'open');
  assert.equal(calls,0);
  assert.equal((await gate.assess('miyue',[{id:'goodbye',speaker:'user',text:'不用回啦，我先睡了，晚安。'}])).state,'open');
  assert.equal((await gate.assess('miyue',[{id:'continue',speaker:'user',text:'好你接着讲。'}])).state,'unfinished');
  assert.equal(calls,2);
});
