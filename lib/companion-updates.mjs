// Small optional annotations on the existing response, never a second model
// deciding what is true. Each repository validates them against saved messages.
export function parseCompanionshipUpdates(raw) {
  try {
    const value=typeof raw==='string'?JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g,'')):raw;
    const updates=value?.companionship;
    const selected=key=>Array.isArray(updates?.[key])?updates[key].slice(0,3).filter(item=>item&&typeof item==='object'&&!Array.isArray(item)):[];
    return {relationship:selected('relationship'),agenda:selected('agenda'),life:selected('life')};
  }catch{return {relationship:[],agenda:[],life:[]};}
}

export function withCompanionshipProtocol(messages, instructions='') {
  if(!instructions)return messages;
  const copy=messages.map(message=>({...message}));
  copy.splice(Math.min(1,copy.length),0,{role:'user',content:[
    '【可选的相处记录协议】在本轮JSON中可增加 companionship:{relationship:[],agenda:[],life:[]}。没有明确变化就留空，不为填字段增加正文。',
    '每组最多3条，只引用本次用户原话或本次实际回复中的短句；你不能决定用户已经答应、完成活动或改变长期边界。',
    instructions,
  ].join('\n')});
  return copy;
}

export const LIFE_UPDATE_INSTRUCTION = 'life 只用于近期事件仍可修改的选择：{eventId,action:"choose",value,evidence,responseEvidence}。eventId和value必须来自事件给出的ID与可选项。用户本轮明确推荐、且你实际回复决定采纳同一个选项时才填写；evidence引用本轮用户原话，responseEvidence引用本轮回复，两者都须含完整选项文字。疑问、假设、否定、未答应的建议留空。已定下的选择作为后续事实；不能靠此字段新增事件、加减身心数值、改变时间地点或声称活动已经完成。';
