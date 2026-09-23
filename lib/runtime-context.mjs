const local=value=>value?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(new Date(value)):'';
const clean=(value,max=240)=>String(value||'').replace(/[\r\n]+/g,' ').slice(0,max);
export function runtimeContext(snapshot,{initiating=false,includeTransitions=true,continuityOnly=false,includeNext=true}={}){
  const current=snapshot?.current;if(!current)return '';
  const next=Array.isArray(snapshot.next)?snapshot.next[0]:snapshot.next;
  if(continuityOnly)return [`【活动时间边界】${local(current.startedAt)}—${local(current.endsAt)}。`,snapshot.availability?.sleeping?'她正在休息，可以短暂醒来接话。':'',includeNext&&next?`下一项尚未开始：${clean(next.title)}（${local(next.startedAt)}）。`:''].filter(Boolean).join('\n');
  const opportunity=snapshot.pending;
  const cue=typeof opportunity?.context==='object'?[opportunity.context.activity,opportunity.context.location,opportunity.context.seed].filter(Boolean).join('；'):opportunity?.context||opportunity?.detail||opportunity?.title;
  const transitions=includeTransitions?(snapshot.transitions||[]).slice(-3):[];
  return [
    '【服务端持续维护的生活安排】',
    `当前：${clean(current.title)}；地点：${clean(snapshot.world.location)}；活动开始${local(current.startedAt)}，预计至${local(current.endsAt)}。`,
    next?`接下来：${clean(next.title)}，预计${local(next.startedAt)}；这是她自己的计划，可能随约定或临时事件调整。`:'接下来的具体活动尚未安排。',
    snapshot.availability?.sleeping?'此刻在休息。用户发消息时可以作为短暂醒来接话，不把整晚改成持续活动，也不要催促用户按你的作息睡觉。':'用户发消息可以随时接话，不需要先结束手头活动。',
    transitions.length?`最近状态变化：${transitions.map(t=>clean(t.title||t.toTitle||t.to?.title||t.activity||t.kind||'',90)).filter(Boolean).join('；')}`:'',
    initiating&&opportunity?`本次交流机会：${clean(cue,650)}。选择一个有内容的观察、想法或小愿望，不照读时间地点和计划表。`:'用户当前的话题优先；生活背景可以帮助接话，不要求另外切入自己的活动。',
    '场景和活动以此安排为准，旧对话里相冲突的活动只属于过去。未开始的计划不能说成已经做过；定时结束表示这段活动结束，不表示读完一本书、看完电影或用户完成了约定。',
  ].filter(Boolean).join('\n');
}
