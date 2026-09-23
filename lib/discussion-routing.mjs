// Select a single discussion opportunity without consuming it. Interest changes
// are committed later, against the user's actually saved reply.
export function prepareDiscussion({repository,roleId='miyue',trigger,semantic=null,conversation=[],protectedTurn=false,spontaneous=false,random=Math.random}={}) {
  if(!repository||roleId!=='miyue'||protectedTurn)return null;
  const opening=trigger.type!=='user_message';
  if(opening){
    if(trigger.gesture==='affection'||Number(random())>=0.45)return null;
    const topic=repository.choose({roleId});
    return topic?{topic,continuing:false,exposureId:null}:null;
  }
  if(['comfort','affection','boundary','close'].includes(semantic?.intent)||semantic?.acceptsOffer)return null;
  const active=repository.active({roleId,conversation});
  const response=semantic?.discussionResponse;
  const request=semantic?.discussionRequest;
  if(active&&request&&semantic?.continuity==='continue'&&['engaged','wants_more'].includes(response?.state)&&[active.topic.category,'any'].includes(request.category)){
    return {topic:active.topic,continuing:true,exposureId:active.id,openerText:active.text||'',responseState:response.state};
  }
  if(request){
    const topic=repository.choose({roleId,category:request.category==='any'?null:request.category,force:request.category!=='any'});
    return topic?{topic,continuing:false,exposureId:null}:null;
  }
  if(active&&response&&['engaged','wants_more','neutral'].includes(response.state)){
    return {topic:active.topic,continuing:true,exposureId:active.id,openerText:active.text||active.openerText||'',responseState:response.state};
  }
  // An open invitation permits a new subject. A short acknowledgement, ordinary
  // user update, failed classifier, or a request for her current life does not.
  if(semantic?.intent==='share'&&semantic?.source==='none'&&!semantic?.needsCurrentState&&Number(random())<0.6){
    const topic=repository.choose({roleId});
    return topic?{topic,continuing:false,exposureId:null}:null;
  }
  if(spontaneous&&semantic?.source==='none'&&['open','acknowledge'].includes(semantic?.intent)&&Number(random())<0.25){
    const topic=repository.choose({roleId});
    return topic?{topic,continuing:false,exposureId:null}:null;
  }
  return null;
}

export function discussionPacket(discussion){
  return discussion?{key:'discussion:'+discussion.topic.id,kind:'discussion',title:discussion.topic.title}:null;
}

export function parseDiscussionAnnotation(raw){
  try{
    const value=typeof raw==='string'?JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g,'')):raw;
    const item=value?.discussion;
    return item&&typeof item.topicId==='string'&&typeof item.quote==='string'?{topicId:item.topicId,quote:item.quote}:null;
  }catch{return null;}
}

// Receipt-only contract shared by legacy and dynamic writers. It deliberately
// says nothing about prose length, tone, or how the discussion should unfold.
export function discussionReceiptProtocol(discussion){
  if(!discussion?.topicId)return '';
  return '本轮输出 JSON 必须包含 discussion 字段。正文确实围绕本轮讨论材料时填写 discussion:{"topicId":'+JSON.stringify(discussion.topicId)+',"quote":"从本次 reply 或 message 中逐字取一段至少8字的主题正文"}；实际没谈此材料则填写 discussion:null。quote 必须来自最终正文，不能引用材料、草稿或用户原话。不能省略此字段，也不在正文透露记录或兴趣评分。已有其他字段不变。';
}

export function withDiscussionProtocol(messages,discussion){
  if(!discussion?.topicId)return messages;
  const copy=messages.map(message=>({...message}));
  copy[0].content+='\n\n本轮讨论输出格式补充：'+discussionReceiptProtocol(discussion);
  copy[0].content+='\n本轮讨论的表达优先级：只推进一个具体想法；主动开场通常80到160字，普通追问通常不超过240字，没有最低字数，只有用户明确要求系统详解时才展开更长。不要用未提供的旧同事、合租、照片或最近读过某篇文字等亲历来包装材料；可以明确用假设的小例子。用户仅说不同意时，先给对方说出理由的空间，不能代写他的反对理由，更不能在下一轮把自己的猜测称作用户说过的话。中性应声无需再补哲理总结。不为了自然强行切回地点、天气、工作或亲密表达。';
  return copy;
}
