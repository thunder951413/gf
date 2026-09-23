// Pure event rules; the host owns polling/persistence, definitions own behavior.
const at=v=>{const n=v instanceof Date?+v:typeof v==='number'?v:Date.parse(v);if(!Number.isFinite(n))throw new TypeError('Invalid event time');return n;};
const iso=v=>new Date(v).toISOString();
const bound=(v,min=0,max=100)=>Math.max(min,Math.min(max,v));

export class CompanionEvent {
  constructor({id,title,type}) { Object.assign(this,{id,title,type}); }
  view(state) { return {id:this.id,title:this.title,type:this.type,...state}; }
  describe(state) { return `${state.title||this.title}：${state.phaseLabel||state.phase}；${state.detail||''}`; }
}
export class PhasedEvent extends CompanionEvent {
  constructor(definition) { super({...definition,type:'phased'}); }
  advance(state,now) {
    const time=at(now),start=at(state.startedAt),expiry=at(state.expiresAt);
    if(time>=expiry)return {phase:null,index:-1,startedAt:iso(expiry),endsAt:iso(expiry),expired:true};
    if(time<start)return {phase:null,index:-1,startedAt:iso(start),endsAt:iso(start),expired:false};
    let cursor=start;
    for(const [index,phase] of state.phases.entries()){
      if(!Number.isFinite(phase.durationMs)||phase.durationMs<=0)throw new TypeError('Event phases require positive durations');
      const end=Math.min(expiry,cursor+phase.durationMs);
      if(time<end)return {phase,index,startedAt:iso(cursor),endsAt:iso(end),expired:false};
      cursor=end;
    }
    return {phase:null,index:-1,startedAt:iso(cursor),endsAt:iso(expiry),expired:true};
  }
}
export function eventPhaseAt(event,now) { return new PhasedEvent(event).advance(event,now); }
export class MeterEvent extends CompanionEvent {
  constructor(definition) { super({...definition,type:'meter'}); }
  accumulate(state,{elapsedMs,ratePerMs,enabled=true}={}) {
    if(!enabled||elapsedMs<=0)return {...state};
    const amount=Math.min(100,elapsedMs*ratePerMs)+(state.remainder||0);
    const whole=Math.floor(amount+1e-9),value=bound(state.value+whole);
    return {value,remainder:value===100?0:Math.max(0,amount-whole)};
  }
  change(value,delta) { return Math.round(bound(value+delta)); }
  relax(value,{target,gain,noise=0,limit=4}) { return this.change(value,bound((target-value)*gain+noise,-limit,limit)); }
}
export const INNER_EVENT_DEFINITIONS=Object.freeze({
  emotional:new MeterEvent({id:'emotional',title:'情感需要'}),
  physical:new MeterEvent({id:'physical',title:'身体亲近愿望'}),
  fatigue:new MeterEvent({id:'fatigue',title:'疲劳与休息'}),
});
export const bodyMeter=new MeterEvent({id:'body',title:'身心状态'});
// Domain adapters retain boundaries and fulfillment rules, exposing the same
// view contract without creating a second source of truth.
export function innerEventViews(inner,now) {
  if(!inner)return [];
  const status=inner.needCycleStatus||{};
  return [
    ...[['emotional','affectionNeed'],['physical','desire']].map(([id,key])=>{
      const item=status[id]||{};
      const phase=item.due?'ready':status.awaitingReply?'awaiting_reply':item.status==='累积中'?'accumulating':'deferred';
      return INNER_EVENT_DEFINITIONS[id].view({value:inner[key],phase,phaseLabel:item.status||'随时间变化',detail:id==='emotional'?'想被回应、关心与陪伴。':'想拥抱、抚摸或身体被刺激的感受，按彼此关系和意愿表达。',startedAt:inner.needClockAt||iso(at(now)),endsAt:item.nextEligibleAt||null,expiresAt:null});
    }),
    INNER_EVENT_DEFINITIONS.fatigue.view({value:inner.fatigue,phase:inner.fatigue>=65?'tired':inner.fatigue>=35?'ordinary':'rested',phaseLabel:inner.fatigue>=65?'有些疲惫':inner.fatigue>=35?'普通状态':'精力尚好',detail:'随作息积累和恢复，影响聊天的精神与节奏。',startedAt:inner.driftedAt||iso(at(now)),endsAt:null,expiresAt:null}),
  ];
}
