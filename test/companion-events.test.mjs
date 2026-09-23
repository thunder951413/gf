import test from 'node:test';
import assert from 'node:assert/strict';
import {CompanionEvent,PhasedEvent,MeterEvent,eventPhaseAt,innerEventViews} from '../lib/companion-events.mjs';
import {buildChatMessages} from '../lib/model.mjs';
import {buildProactiveMessages} from '../lib/proactive.mjs';
import {requestEmotionEnvelope} from '../lib/emotion-dialogue.mjs';

test('timed and meter definitions share an event contract and time boundaries are exact',()=>{
  const event={id:'nails',title:'美甲',startedAt:'2026-09-10T00:00:00Z',expiresAt:'2026-09-17T00:00:00Z',phases:[{id:'doing',label:'正在做',durationMs:3600000},{id:'recent',label:'近期',durationMs:167*3600000}]};
  assert.ok(new PhasedEvent(event) instanceof CompanionEvent);
  assert.ok(new MeterEvent({id:'fatigue'}) instanceof CompanionEvent);
  assert.equal(eventPhaseAt(event,'2026-09-10T00:59:59Z').phase.id,'doing');
  assert.equal(eventPhaseAt(event,'2026-09-10T01:00:00Z').phase.id,'recent');
  assert.equal(eventPhaseAt(event,'2026-09-17T00:00:00Z').expired,true);
  assert.equal(eventPhaseAt(event,'2026-09-09T23:59:59Z').phase,null);
});

test('meter effects preserve bounds, fractional clock progress, and deterministic recovery',()=>{
  const meter=new MeterEvent({id:'fatigue'});
  const first=meter.accumulate({value:0,remainder:0},{elapsedMs:60000,ratePerMs:100/3600000});
  const second=meter.accumulate(first,{elapsedMs:60000,ratePerMs:100/3600000});
  assert.equal(second.value,3);
  assert.ok(second.remainder>0.33);
  assert.equal(meter.change(90,35),100);
  assert.equal(meter.change(20,-35),0);
  assert.equal(meter.relax(90,{target:20,gain:.12,limit:4}),86);
  assert.deepEqual(meter.accumulate(first,{elapsedMs:3600000,ratePerMs:1,enabled:false}),first);
  const views=innerEventViews({fatigue:80,affectionNeed:90,desire:40,needCycleStatus:{emotional:{due:true,status:'待合适时段表达'},physical:{status:'累积中'}}},new Date());
  assert.equal(views.find(e=>e.id==='emotional').phase,'ready');
  assert.equal(views.find(e=>e.id==='fatigue').phase,'tired');
});

test('unchanged event context is identical before changing history/time across all opening modes',()=>{
  const role={id:'miyue',name:'林晓薇',interaction:{mode:'companion'}};
  const base={role,memories:[],conversation:[],eventContext:'【近期事件】美甲：梅子色；保留至 9 月 17 日。',characterContext:'此刻 9 月 10 日 21:00'};
  const typed=requestEmotionEnvelope(buildChatMessages({...base,currentUserText:'今天怎么样？'}));
  const gesture=requestEmotionEnvelope(buildChatMessages({...base,currentUserText:null,conversation:[{speaker:'assistant',text:'我在呢。'}],characterContext:'此刻 9 月 10 日 21:10，准备开场'}));
  const proactive=buildProactiveMessages({...base,kind:'life',topics:'日常',candidates:[],characterContext:'此刻 9 月 10 日 21:20'});
  assert.deepEqual(typed.slice(0,2),gesture.slice(0,2));
  assert.deepEqual(typed.slice(0,2),proactive.slice(0,2));
  assert.equal(typed[1].content,base.eventContext);
  const changed=buildChatMessages({...base,eventContext:'【近期事件】新事件'});
  assert.notEqual(changed[1].content,typed[1].content);
});

test('volatile event material follows the stable archive without changing its prefix',()=>{
  const role={id:'miyue',name:'林晓薇',interaction:{mode:'companion'}};
  const conversation=[
    {speaker:'user',text:'旧问题一',createdAt:'2026-09-01T00:00:00Z'},
    {speaker:'assistant',text:'旧回答一',createdAt:'2026-09-01T00:01:00Z'},
    {speaker:'user',text:'旧问题二',createdAt:'2026-09-01T00:02:00Z'},
    {speaker:'assistant',text:'旧回答二',createdAt:'2026-09-01T00:03:00Z'},
    {speaker:'user',text:'最近的历史消息',createdAt:'2026-09-01T00:04:00Z'},
  ];
  const common={role,memories:[{text:'明确保存的偏好'}],conversation,characterContext:'本轮状态',currentUserText:'真正的本轮输入'};
  const first=buildChatMessages({...common,eventContext:'【近期事件】旧阶段'});
  const second=buildChatMessages({...common,eventContext:'【近期事件】新阶段'});
  const eventIndex=first.findIndex(message=>message.content==='【近期事件】旧阶段');
  assert.ok(eventIndex>1);
  assert.deepEqual(first.slice(0,eventIndex),second.slice(0,eventIndex));
  assert.equal(first.at(-1).content,'真正的本轮输入');
});

test('proactive compilation shares the chat archive and uses one supplied reply budget',()=>{
  const role={id:'miyue',name:'林晓薇',interaction:{mode:'companion'}};
  const common={role,memories:[{text:'明确保存的偏好'}],conversation:[
    {speaker:'user',text:'旧问题一'}, {speaker:'assistant',text:'旧回答一'},
    {speaker:'user',text:'旧问题二'}, {speaker:'assistant',text:'旧回答二'},
    {speaker:'user',text:'最近的历史消息'},
  ],characterContext:'本轮状态',eventContext:'【近期事件】进行中'};
  const chat=requestEmotionEnvelope(buildChatMessages({...common,currentUserText:'真正的本轮输入'}));
  const proactive=buildProactiveMessages({...common,kind:'life',topics:'日常',candidates:[],policyPlan:{maxChars:320}});
  const archive=chat.find(message=>message.content.includes('【历史资料｜不是当前用户发言或回复范例】'));
  assert.deepEqual(proactive.find(message=>message.content===archive.content),archive);
  const budget=proactive.find(message=>message.content.includes('message 最多'))?.content;
  assert.match(budget,/最多320字/);
  assert.doesNotMatch(budget,/6000/);
  const planned=buildProactiveMessages({...common,kind:'life',topics:'日常',candidates:[],turnPlan:{budget:{replyChars:240}}});
  assert.match(planned.find(message=>message.content.includes('message 最多'))?.content,/最多240字/);
  assert.match(proactive.at(-1).content,/本轮触发方式：主动联系/);
});
