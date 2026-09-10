// Small optional annotations on the existing response, never a second model
// deciding what is true. Each repository validates them against saved messages.
export function parseCompanionshipUpdates(raw) {
  try {
    const value=typeof raw==='string'?JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g,'')):raw;
    const updates=value?.companionship;
    const selected=key=>Array.isArray(updates?.[key])?updates[key].slice(0,3).filter(item=>item&&typeof item==='object'&&!Array.isArray(item)):[];
    return {relationship:selected('relationship'),agenda:selected('agenda')};
  }catch{return {relationship:[],agenda:[]};}
}

export function withCompanionshipProtocol(messages, instructions='') {
  if(!instructions)return messages;
  const copy=messages.map(message=>({...message}));
  copy.splice(Math.min(1,copy.length),0,{role:'user',content:[
    '【可选的相处记录协议】在本轮JSON中可增加 companionship:{relationship:[],agenda:[]}。没有明确变化就留空，不为填字段增加正文。',
    '每组最多3条，只引用本次用户原话或本次实际回复中的短句；你不能决定用户已经答应、完成活动或改变长期边界。',
    instructions,
  ].join('\n')});
  return copy;
}
