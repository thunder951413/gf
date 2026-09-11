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
  const role={id:'miyue',name:'林雨薇',interaction:{mode:'companion'}};
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
