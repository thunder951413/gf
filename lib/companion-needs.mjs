export const NEED_FIELDS = Object.freeze([
  {key:'emotional',label:'心理需要',description:'此刻希望与你怎样相处、希望得到怎样的回应。',examples:['希望你回应她刚才的分享','想让你认真听她说一件心事','想被你哄一哄，也想多陪你聊一会儿']},
  {key:'physical',label:'身体亲近愿望',description:'直接写出她想要的身体亲近与感受，例如拥抱、抚摸、刺激或某处发痒。',examples:['渴望被你抱紧，后背和腰侧被慢慢摸热','胸口和腿间有点痒，想被你轻轻刺激','想被你接吻，手顺着敏感的地方摸到发软']},
].map(field=>Object.freeze({...field,examples:Object.freeze(field.examples)})));

export const SENSUAL_DESIRE_THRESHOLD = 55;

// Old saves may have no words yet. Preserve their existing state as a short
// default; once edited, the user's words (including an empty wish) take priority.
export function resolveNeeds(state = {}) {
  const own=state.needs&&typeof state.needs==='object'?state.needs:{};
  const emotional=state.mode==='attentive'?'想先听你说清楚难受的事，好好回应你。'
    :['vulnerable','stressed'].includes(state.mode)?'希望你听她说说眼前的小困扰，给她一点理解和回应。'
    :'想分享自己的近况，也希望得到你的回应。';
  const desire=Number(state.desire)||0;
  const defaultPhysical=desire>=85?'身体有点燥热，想被你抱紧、抚摸和刺激；胸口、腰腹和腿间都有点痒。'
    :desire>=30||Number(state.affectionNeed)>=30&&['supportive','playful'].includes(state.lastTurn?.tone)?'想与你亲近，渴望被抱紧，也被轻轻抚摸。':'';
  return {
    emotional:typeof own.emotional==='string'?own.emotional:emotional,
    physical:typeof own.physical==='string'?own.physical:defaultPhysical,
  };
}

export function sensualDesireLevel(state = {}) {
  if(state.intimacyBoundary==='friendly'||state.mode==='attentive')return 'suppressed';
  const desire=Number(state.desire)||0;
  const physical=typeof state.needs?.physical==='string'?state.needs.physical.trim():(typeof state.physical==='string'?state.physical.trim():'');
  if(desire>=85||/刺激|发痒|痒痒|胸口|胸前|腿间|大腿内侧|情欲|湿|硬|揉|舔/.test(physical))return 'high';
  if(desire>=SENSUAL_DESIRE_THRESHOLD||physical)return 'elevated';
  return 'low';
}

export function sensualDesireContext(state = {}) {
  const level=sensualDesireLevel(state);
  if(level==='suppressed')return '当前按已记录边界或用户难受状态，不主动展开身体情欲描写；用户明确邀请时仍可简短、尊重地回应。';
  if(level==='low')return '';
  return '【亲近愿望背景】当前更想与你亲近。它影响她的心意和态度，不要求每轮汇报感受或添加身体反应。先回应眼前的话题；聊到彼此时可以坦率说想念、想拥抱或想多待一会儿，沿用已确认的关系、意愿与互动节奏。';
}

export function needsContext(needs, state = {}) {
  const merged={...state,needs};
  const sensual=sensualDesireContext(merged);
  return [`【此刻的具体愿望】`,`心理需要：${JSON.stringify(needs?.emotional||'暂时没有特别的心理需要')}`,`身体亲近愿望：${JSON.stringify(needs?.physical||'暂时没有特别的身体亲近愿望')}`,'这是她的愿望，不是用户已经做过的动作或共同经历。用户当前话题优先；这些愿望不要求在每次回复中出现。亲近方式沿用已确认的关系与节奏，文字只作为状态，不改变边界与冷却规则。',sensual].filter(Boolean).join('\n');
}
