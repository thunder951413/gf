// The clock and user actions own this loop. No extra model call or model score.
export const NEED_CYCLE_DEFAULTS = Object.freeze({enabled:true,emotionalHours:24,physicalHours:48,threshold:85,relief:35,cooldownHours:6});
export const NEED_CYCLE_FIELDS = Object.freeze([
  {key:'enabled',label:'让需要随时间累积',type:'boolean'},
  {key:'emotionalHours',label:'情感需要从 0 到满（小时）',min:1,max:720,step:1},
  {key:'physicalHours',label:'身体亲近从 0 到满（小时）',min:1,max:720,step:1},
  {key:'threshold',label:'主动表达阈值',min:60,max:100,step:1},
  {key:'relief',label:'回应一次后的回落值',min:5,max:100,step:1},
  {key:'cooldownHours',label:'两次需求主动至少间隔（小时）',min:1,max:168,step:1},
]);
const HOUR=3600000;
const channels={emotional:'affectionNeed',physical:'desire'};
export const cycleConfig=state=>({...NEED_CYCLE_DEFAULTS,...state.needCycle});
export const romanticRelationship=state=>/恋爱中|稳定的恋人|女朋友|伴侣/.test(state.relationshipStage||'');

export function advanceNeedCycle(state,now){
  for(const key of Object.values(channels))state[key]=Math.max(0,Math.min(100,Math.round(Number(state[key])||0)));
  const config=cycleConfig(state),at=+now,last=Date.parse(state.needClockAt);
  if(!Number.isFinite(last)){state.needClockAt=now.toISOString();return true;}
  if(at-last<60000)return false;
  state.needClockAt=now.toISOString();
  state.needRemainders??={};
  if(!config.enabled)return true;
  for(const [channel,key] of Object.entries(channels)){
    const amount=Math.min(100,(at-last)/HOUR*100/config[channel+'Hours'])+(state.needRemainders[channel]||0);
    const whole=Math.floor(amount+1e-9);
    state[key]=Math.min(100,state[key]+whole);
    state.needRemainders[channel]=state[key]===100?0:Math.max(0,amount-whole);
  }
  return true;
}

export function needCycleStatus(state,now,tuning=null){
  const config=cycleConfig(state),last=Date.parse(state.lastNeedContact?.deliveredAt);
  const cooling=Number.isFinite(last)&&+now<last+config.cooldownHours*HOUR;
  const distressed=state.lastTurn?.tone==='distressed'&&+now-Date.parse(state.lastTurn.at)<6*HOUR;
  const statuses={awaitingReply:Boolean(state.awaitingNeed)};
  for(const [channel,key] of Object.entries(channels)){
    let status='累积中';
    if(!config.enabled)status='周期已关闭';
    else if(tuning?.initiative===0)status='主动交流已关闭';
    else if(channel==='physical'&&(state.intimacyBoundary==='friendly'||tuning?.flirtation===0||state.affection<50))status='按当前亲近边界暂缓';
    else if(distressed)status='先回应你的感受';
    else if(state.awaitingNeed)status='已表达，等你有空回应';
    else if(cooling)status='主动间隔中';
    else if(state[key]>=config.threshold)status='待合适时段表达';
    statuses[channel]={label:channel==='emotional'?'情感需要':'身体亲近愿望',value:state[key],due:status==='待合适时段表达',status};
    if(status==='累积中'||status==='主动间隔中'){
      const refill=Math.max(0,config.threshold-state[key])*config[channel+'Hours']/100*HOUR;
      statuses[channel].nextEligibleAt=new Date(Math.max(+now+refill,cooling?last+config.cooldownHours*HOUR:0)).toISOString();
    }
  }
  return statuses;
}

export function needCycleCandidate(state,now,tuning=null){
  const status=needCycleStatus(state,now,tuning);
  // Fatigue/stress change what she asks for, not a random chance of delivery.
  const soft=state.fatigue>=65||state.stress>=60;
  const channel=status.emotional.due&&(soft||!status.physical.due||state.affectionNeed>=state.desire)?'emotional':status.physical.due?'physical':null;
  if(!channel)return null;
  const romantic=romanticRelationship(state);
  const wish=channel==='emotional'
    ? soft?'今天有点累，想听你说说话，也想被温柔安慰一下。':romantic?'有点想你，想和你多待一会儿，聊聊彼此今天的事。':'想找你聊会儿近况，也想听听你的想法。'
    : soft?'想被温柔地抱一会儿，安静靠近。':romantic?'想和你拥抱、接吻，问问你愿不愿意一起想象一小段亲近。':'想征求你的意愿，给彼此一个温柔的拥抱。';
  return {trigger:'cycle_'+channel,needChannel:channel,kind:'need',intimacy:channel==='physical',context:`本轮由${channel==='emotional'?'情感需要':'身体亲近愿望'}达到阈值触发。关系：${state.relationshipStage}。想表达：${wish} 接着当前生活和最近聊天自然发起一条消息，具体、口语，不报数，不照抄示例。身体亲近只写成年人之间${romantic?'含蓄的拥抱、接吻与感受':'友好的拥抱心意，不主动升级为恋人互动'}；表达邀请，不代写用户同意或已经做过的动作，不假定现实见面。用户拒绝、忙碌或没回复就停下，不催促，不归咎用户。`};
}

export function needCycleContext(state){
  const status=state.needCycleStatus;
  if(!status||!cycleConfig(state).enabled)return '';
  const level=value=>value>=cycleConfig(state).threshold?'较强':value>=40?'适中':'平缓';
  const recentRelief=state.lastNeedRelief&&Date.parse(state.updatedAt)-Date.parse(state.lastNeedRelief.at)<12*HOUR;
  return `需求节奏：情感${level(state.affectionNeed)}，身体亲近${level(state.desire)}。${status.awaitingReply?'她已表达过一次愿望，等用户接话，不重复索取。':'普通回复跟随用户；达到阈值由程序另选主动机会，不每轮提出愿望。'}${recentRelief?'最近一次相应互动已让她感到满足一些，承接这次亲近，不立刻重新索取。':''}`;
}

export function needFulfillment(state,text,now){
  const value=String(text||'').trim();
  if(!cycleConfig(state).enabled||!value||/[“”「」"?？]|(?:别|不要|不想|不愿|不许|不能|拒绝|不可以|不喜欢|没空|正忙|忙着|不聊|以后再|下次再|改天|晚点|明天|不抱|不亲|不需要)|(?:小说|文章|电影|她说|他说|解释|什么意思)/u.test(value))return [];
  const recent=state.awaitingNeed&&+now-Date.parse(state.awaitingNeed.deliveredAt)<12*HOUR;
  const acceptance=recent&&/^(?:好[的呀啊吧]?|嗯[嗯]?|可以[呀啊]?|当然[可以]*|愿意|来吧)[。！!～~]*$/u.test(value);
  const physical=state.intimacyBoundary!=='friendly'&&(/(?:抱抱[你我]?|抱住你|拥抱你|亲亲[你我]?|亲吻你|吻你|亲你|接吻|摸摸(?:头|你的头)|搂着你)/u.test(value)||acceptance&&state.awaitingNeed.channel==='physical');
  const emotional=physical||/(?:我也想你|我在(?:呢|啊)?(?=[，。！!～~\s]|$)|陪着你|陪你聊|听你说|说给我听|辛苦了|抱抱|哄哄你)/u.test(value)||acceptance&&state.awaitingNeed.channel==='emotional';
  return [...(emotional?['emotional']:[]),...(physical?['physical']:[])];
}
