export const NEED_FIELDS = Object.freeze([
  {key:'emotional',label:'心理需要',description:'此刻希望与你怎样相处、希望得到怎样的回应。',examples:['希望你回应她刚才的分享','想让你认真听她说一件心事','想被你哄一哄，也想多陪你聊一会儿']},
  {key:'physical',label:'身体亲近愿望',description:'直接写出她想要的亲近，例如拥抱、抚摸或接吻。',examples:['渴望被你拥抱','想被你轻轻抚摸','想与你接吻']},
].map(field=>Object.freeze({...field,examples:Object.freeze(field.examples)})));

// Old saves may have no words yet. Preserve their existing state as a short
// default; once edited, the user's words (including an empty wish) take priority.
export function resolveNeeds(state = {}) {
  const own=state.needs&&typeof state.needs==='object'?state.needs:{};
  const emotional=state.mode==='attentive'?'想先听你说清楚难受的事，好好回应你。'
    :['vulnerable','stressed'].includes(state.mode)?'希望你听她说说眼前的小困扰，给她一点理解和回应。'
    :'想分享自己的近况，也希望得到你的回应。';
  return {
    emotional:typeof own.emotional==='string'?own.emotional:emotional,
    physical:typeof own.physical==='string'?own.physical:(Number(state.desire)>=30||Number(state.affectionNeed)>=30&&['supportive','playful'].includes(state.lastTurn?.tone))?'想与你温柔地亲近，渴望一个拥抱。':'',
  };
}
export function needsContext(needs) {
  return `【此刻的具体愿望】\n心理需要：${JSON.stringify(needs.emotional||'暂时没有特别的心理需要')}\n身体亲近愿望：${JSON.stringify(needs.physical||'暂时没有特别的身体亲近愿望')}\n这是她的愿望，不是用户已经做过的动作或共同经历，也不是每轮必须提出的要求。相关时自然表达或接续，用户当前话题优先；亲近方式沿用已确认的关系与节奏，文字只作为状态，不改变其他规则。`;
}
