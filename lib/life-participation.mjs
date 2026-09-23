// Decide how much personal-life material belongs in this turn. Runtime state
// continues to exist independently; availability is not a reason to narrate it.
const ownQuestion = /你.{0,16}(?:在哪|在家|回家|在做|在干|忙什么|忙完|下班|吃什么|吃了什么|打算吃|晚饭|午饭|早饭|睡了|醒了|准备做|打算做|有什么安排|几点|做美甲|指甲|看的书|看的电影|买了什么)|(?:说说|聊聊|讲讲)你(?:自己|的|最近|今天)/u;
const unquote = value => String(value || '').replace(/[“「『"][^”」』"]*[”」』"]/gu, '');
export function lifeParticipationPlan({ text = '', ownShare = false, recall = false, activityRequest = false, focused = false, opening = false, initiating = false, semantic = null } = {}) {
  if(semantic)return Object.freeze({mode:semantic.ownLife?'answer':'respond',detailedState:Boolean(semantic.needsCurrentState||semantic.intent==='open'),unsolicitedReport:false});
  const explicit = ownShare || recall || activityRequest || ownQuestion.test(unquote(text));
  const mode = explicit || focused ? 'answer' : opening || initiating ? 'contact' : 'respond';
  return Object.freeze({ mode, detailedState: Boolean(explicit || focused), unsolicitedReport: false });
}

export function routineLabel(current) {
  return ({ work:'工作时段', sleep:'休息中', rest:'休息中', meal:'用餐时段', breakfast:'用餐时段', lunch:'用餐时段', dinner:'用餐时段', travel:'旅行中', walk:'外出走动', commute:'路上', hobby:'自由活动', reading:'自由活动', free:'自由活动', waking:'刚醒来' })[current?.kind] || '日常活动中';
}

export function lifeParticipationContext(plan, { material = false, scheduled = false } = {}) {
  if (!plan) return '';
  const line = material
    ? '只围绕本轮选中的内容交流；若是之前那件事，接着新的进展说，不重新开场介绍。当前作息只供核对，不需要再搭配一段日常汇报。'
    : plan.mode === 'answer'
      ? '回答用户问到的这件近况，可以说自己的偏好、感受和相关细节；具体问题不需要扩成一份生活清单。'
      : plan.mode === 'contact'
        ? '这次是想与用户说句话。可以有一个自己的念头、分享或亲近回应；不必编一件刚发生的事来证明有生活。' + (scheduled ? '没有自然想说的内容可以跳过本次机会。' : '')
        : '围绕用户正在说的内容，表达你的意见、感受或自然回应；状态仅供保持连续性，不需要拿自己的工作或近况作类比、附加汇报。';
  return '【生活参与方式】\n' + line;
}
