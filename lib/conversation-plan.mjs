// A turn's purpose is decided once from already prepared facts. This module
// does not read a repository, advance a clock, call a model, or write history.
import { spokenChatGuidance } from './companion-style.mjs';
import { understandingContext } from './conversation-understanding.mjs';
import { lifeParticipationContext } from './life-participation.mjs';
const TYPES = new Set(['user_message', 'desktop_invitation', 'scheduled_opportunity']);
const freeze = value => { if(value && typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);} return value; };

export function conversationTrigger({type='user_message',userText=null,at=new Date(),gesture=null}={}) {
  if(!TYPES.has(type))throw new TypeError('Unknown conversation trigger');
  if(type==='user_message'&&typeof userText!=='string')throw new TypeError('User trigger requires actual text');
  if(type!=='user_message'&&userText!==null)throw new TypeError('An invitation must not invent user text');
  const time=new Date(at);if(!Number.isFinite(+time))throw new TypeError('Invalid turn time');
  return freeze({type,userText,at:time.toISOString(),...(type==='desktop_invitation'?{gesture:gesture==='affection'?'affection':'care'}:{})});
}

// Business modules offer candidates; only this order selects an initiative.
// Explicit user turns do not enter this arbitration.
export function chooseInitiative({followup=null,agenda=null,need=null,material=null,runtime=null,life=null,pursuit=null,thread=null,preferContent=false}={}) {
  const candidates=[['followup',followup],['agenda',agenda],['need',need?.needChannel?need:null],['material',material?.foreground?material:null],['pursuit',pursuit?.session?pursuit:null],['material',material],['runtime',runtime],['life',life],['content',preferContent?{key:'content'}:null],['pursuit',pursuit],['thread',thread]];
  const chosen=candidates.find(([,value])=>value);
  return chosen?{kind:chosen[0],value:chosen[1]}:{kind:'conversation',value:null};
}

const opportunityText=value=>typeof value==='string'?value.trim():'';
const opportunityKey=value=>opportunityText(value?.key||value?.pendingKey||value?.topicKey||value?.id)||null;

// Initiative providers keep their own richer state for validation and commit.
// The dialogue plan carries only the one selected, speakable cue so generation
// does not have to rediscover a purpose from all of those provider snapshots.
export function selectedOpportunitySpec(opportunity) {
  if(!opportunity||typeof opportunity!=='object')return null;
  const kind=opportunityText(opportunity.kind)||'conversation',value=opportunity.value;
  if(!value||typeof value!=='object')return Object.freeze({kind,key:null,title:'',cue:''});
  const runtimeContext=()=>typeof value.context==='object'&&value.context
    ? [value.context.activity,value.context.location,value.context.seed].map(opportunityText).filter(Boolean).join('；')
    : opportunityText(value.context);
  const fields={
    followup:{title:opportunityText(value.topic),cue:opportunityText(value.topic)},
    agenda:{title:opportunityText(value.title),cue:[value.anchor,value.detail].map(opportunityText).filter(Boolean).join('；')},
    need:{title:'',cue:opportunityText(value.context)},
    material:{title:opportunityText(value.title),cue:[value.detail,value.summary,value.phase?.detail,value.activity].map(opportunityText).find(Boolean)||''},
    runtime:{title:opportunityText(value.title),cue:runtimeContext()},
    life:{title:opportunityText(value.angle?.title),cue:opportunityText(value.context)},
    pursuit:{title:opportunityText(value.title),cue:[value.stage?.label,value.stage?.action,value.stage?.detail].map(opportunityText).filter(Boolean).join('；')},
    thread:{title:opportunityText(value.title||value.beat?.title),cue:[value.beat?.text,value.beat?.emotion,value.beat?.need].map(opportunityText).filter(Boolean).join('；')},
    discussion:{title:opportunityText(value.title),cue:opportunityText(value.detail||value.summary)},
  }[kind]||{title:opportunityText(value.title),cue:''};
  return freeze({kind,key:opportunityKey(value),title:fields.title,cue:fields.cue});
}

export function createConversationPlan({trigger,policy={},conversation=[],thread=null,material=null,opportunity=null,runtimeRevision=null,lifeParticipation=null,semantic=null,memory=null,discussion=null}={}) {
  if(!TYPES.has(trigger?.type))throw new TypeError('A typed trigger is required');
  const behavior=policy.behavior||{};
  const opening=trigger.type!=='user_message';
  const recent=[];
  for(let i=conversation.length-1;i>=0&&conversation[i].speaker==='assistant';i--)if(conversation[i].id)recent.unshift(conversation[i].id);
  const closing=policy.intent==='close';
  const boundary=behavior.intent==='boundary';
  const preference=semantic?.decision?.intent==='preference'||behavior.understanding?.kind==='conversation_preference';
  // The semantic planner only marks an accepted offer with a validated assistant
  // focus ID. Keep it when the lightweight conversation-thread candidate is absent.
  const acceptedOffer=!opening&&!closing&&!boundary&&!preference&&Boolean(semantic?.decision?.acceptsOffer||thread?.acceptsOffer);
  const acknowledgement=!opening&&Boolean(behavior.acknowledgement)&&!acceptedOffer;
  const continuation=!acknowledgement&&!opening&&!closing&&!boundary&&!preference&&Boolean(thread?.holdsTopic||acceptedOffer);
  const focus=semantic?.decision?.focusMessageId?{kind:'conversation',messageIds:[semantic.decision.focusMessageId]}
    :continuation&&material?.kind!=='closeness'?{kind:'conversation',messageIds:recent}
    :material?{kind:material.kind||'daily',id:material.key||material.id||null,title:material.title||'',messageIds:material.sourceMessageId?[material.sourceMessageId]:[]}
    :{kind:opening?(opportunity?.kind||'invitation'):'user_message',messageIds:[]};
  const recalledEvidence=[...(memory?.selected||[]),...(memory?.represented||[])].some(item=>!item.lowConfidence&&!item.ambiguous);
  // A failed classifier cannot grant actions or bind a thread. For an explicit
  // past-fact question it can still safely constrain generation to existing facts.
  const fallbackRecall=semantic?.status==='fallback'&&recalledEvidence
    &&/之前|以前|上次|原来|当时|曾经|还记得/u.test(trigger.userText||'')&&/谁|哪|什么|怎么|多少|是否|还需要|[？?]/u.test(trigger.userText||'');
  // Retrieved memories support an imagined invitation; they do not turn it into a past-fact audit.
  const historicalCheck=!discussion&&!opening&&!semantic?.decision?.imagined&&(fallbackRecall||semantic?.decision?.source==='none'&&(semantic.decision.intent==='recall'||semantic.decision.intent==='answer'
    &&!semantic.decision.needsCurrentState&&semantic.decision.memoryIds?.length>0));
  const mode=closing?'close':boundary?'boundary':acknowledgement?'acknowledge':historicalCheck?'recall':continuation?'continue':opening?'initiate':behavior.intent||'respond';
  return freeze({version:1,trigger:{...trigger},runtimeRevision,mode,focus,selectedOpportunity:selectedOpportunitySpec(opportunity),recallSubject:mode==='recall'&&/^(?:我|你(?:还)?记得我)|我的|我(?:之前|以前|上次)/u.test(trigger.userText||'')?'user':null,continuationAction:acceptedOffer?'fulfill_offer':null,
    engagement:closing?'close':policy.quietPresence?'quiet':acknowledgement?'acknowledge':!opening&&['respond','continue'].includes(mode)?'continue_topic':'answer',
    budget:{replyChars:Math.max(1,Math.min(6000,Number(policy.maxChars)||300)),questionBudget:Math.max(0,Math.min(2,Number(policy.questionBudget)||0))},
    style:{...(behavior.style||{})},understanding:behavior.understanding?{...behavior.understanding}:null,expressivePreferences:{...(behavior.expressivePreferences||{})},explicitExpression:behavior.explicit?behavior.extra:null,
    suppliedOpening:behavior.forcedOpening||null,authoredAnchor:policy.anchor||null,
    historicalCheck,discussion:discussion?{topicId:discussion.topic.id,continuing:Boolean(discussion.continuing)}:null,preserveEvidenceWindow:Boolean(memory),preferences:{noAdvice:Boolean(policy.noAdvice),noAnalysis:Boolean(policy.noAnalysis),suppressInitiatedAffection:Boolean(policy.suppressInitiatedAffection)},
    allowOptionalMaterial:opening||mode==='share',lifeParticipation:lifeParticipation?{...lifeParticipation}:null,semantic:semantic?structuredClone(semantic):null,
  });
}

export function conversationPlanContext(plan) {
  if(!plan)return '';
  const initiation={reading:'分享这次阅读里一个有意思的具体内容或自己的想法，给对方接话的空间；不追加职业近况作为开头或收尾。',article:'分享眼前资料里的一个具体内容、感受或疑问，让内容本身成为话题；不追加职业近况作为开头或收尾。',film:'分享这次观影里引起你注意的一个具体内容或感受，不同时汇报别的近况。',discussion:'分享本轮话题的一处具体想法或疑问，让用户有余地表达不同意见；不讲课，不固定附加提问。',need:'这次联系是因为你有陪伴或亲近的需要。自然告诉他此刻的愿望。',material:'分享本轮选中的一件生活小事和你自己的感受。',agenda:'继续这次已确认的共同安排。',followup:'问问先前记下的用户事项现在怎么样了。',content:'分享本轮资料里一个具体、有意思的内容。'};
  const purposes={acknowledge:'用户只是简短确认。自然接住这一句，保持谈话可以继续，不强行换题或结束。',continue:'承接紧邻的实际发言，回答用户追问的细节或变化，提供相对于上条的新信息。',initiate:'由你自然开口，分享一个想说的细节、想法或愿望。',recall:'依据历史回答用户要回顾的内容。',share:'用户愿意听你的事情，具体讲出内容。',affection_reply:'回应用户此刻的亲近与想念。',receive_closeness:'回应用户的亲近邀请。',comfort:'陪用户聊眼前的难受。',close:'自然回应道别。',boundary:'尊重用户这句话明确限定的互动，不推断额外的关系变化。'};
  return [`【本轮对话计划】`,
    `目的：${plan.continuationAction==='fulfill_offer'?'承接紧邻的实际发言，实际兑现刚才接受的提议。按那项提议自然继续：若是安静相伴，就简短确认并留出停顿；若是分享，再接着讲那件事。不另起话题，也不把提议改成必须讲新故事。':(plan.mode==='initiate'?initiation[plan.focus.kind]:null)||purposes[plan.mode]||'理解用户这句话，给出自己的回应。'}`,
    plan.continuationAction==='fulfill_offer'&&plan.semantic?.decision?.offerQuote?'已接受的提议原文（历史引用，具体内容以此为准）：'+JSON.stringify(plan.semantic.decision.offerQuote):'',
    plan.focus.title?'本轮材料：'+plan.focus.title+'。':'',
    plan.selectedOpportunity?.key?`本次单选的联系机会：${plan.selectedOpportunity.kind}（${plan.selectedOpportunity.key}）。`:'',
    plan.selectedOpportunity?.title?'这次想说的对象：'+plan.selectedOpportunity.title+'。':'',
    plan.selectedOpportunity?.cue?'这次可以沿用的具体缘由或进展：'+plan.selectedOpportunity.cue+'。':'',
    plan.reunionCue?'久别语气：'+plan.reunionCue:'',
    `正文最多${plan.budget.replyChars}字，按内容需要使用，没有最低长度；追问最多${plan.budget.questionBudget}个。`,
    plan.historicalCheck?'本轮只核对过去：用已有证据直接回答，回答完即止。不能为画面感续写当时的想法、动作、他人说的话或后来发生的事；不创建新经历，experience 为 null。':'',
    `语气：${Object.values(plan.style).join('；')||'平等、自然'}。`,
    plan.engagement==='continue_topic'?'这轮是在交流内容，保持话题有来有回。日常动态或接下来的打算也是聊天素材，不等于告别或申请离开；围绕其中一处说自己的具体反应、偏好或想法，让对方有内容可接，不只批准他去做事或表示等他回来。顺着当前话题即可，不需要另起话题，也不要求每次问问题。':'',
    plan.preferences.noAdvice?'本轮没有求助请求，先回应内容，不另加生活指导或叮嘱。':'',
    plan.preferences.noAnalysis?'不推断用户没有说出的心理和动机；这不限制你表达自己的内心。':'',
    plan.preferences.suppressInitiatedAffection?'本轮不主动亲昵；正常温柔接话。':'',
    plan.explicitExpression==='tender'?'用户明确想听撒娇。extra 写一句此刻可通过聊天回应的小愿望，reply 是正文。':'extra 留空，性格自然体现在正文。',
    plan.suppliedOpening?'程序先呈现“'+plan.suppliedOpening+'”，正文直接续接。':'',
    plan.authoredAnchor?'程序呈现已确认的片段，正文续接其中具体内容，不重复：'+plan.authoredAnchor:'',
    '当前状态用来保持人物连续性，表达围绕本轮话题。',
    spokenChatGuidance(plan.trigger.userText||''),
    plan.semantic?.status==='fallback'?'本轮语义预判未完成。按当前用户消息与近期原话直接理解，不假定用户在求安慰、道别或换题。':plan.mode!=='close'&&plan.understanding?.kind!=='conversation_preference'&&plan.semantic?.decision?.continuity==='continue'?'用户在接续本轮语义定位的历史原话；回答其中的指代与细节，不回到更早的无关话题。':plan.semantic?.decision?.continuity==='new'?'用户正在开始新的话题；历史只提供相关事实，不沿用上一题的交流目标。':'',
    plan.mode==='close'?'':understandingContext(plan.understanding),
    lifeParticipationContext(plan.lifeParticipation,{material:Boolean(plan.focus.title||plan.authoredAnchor),scheduled:plan.trigger.type==='scheduled_opportunity'}),
  ].filter(Boolean).join('\n');
}

// Dynamic dialogue authors its own prose. Give it the already decided purpose
// and the one selected initiative, without forwarding policy-era openings,
// extras, or model-authored reply directions as writing instructions.
export function dynamicTurnPlanContext(plan) {
  if(!plan)return '';
  const purposes={
    acknowledge:'接住用户这句简短确认，让交流自然延续。',
    continue:'承接紧邻的实际发言和其中的指代。',
    initiate:'根据本次单选机会自然发起联系。',
    recall:'依据已有记录回答用户正在核对的过去事实。',
    share:'用户愿意听你的事情，具体讲出相关内容。',
    affection_reply:'回应用户此刻表达的亲近与想念。',
    receive_closeness:'回应用户此刻的亲近邀请。',
    comfort:'陪用户回应眼前的难受。',
    close:'回应用户这次道别。',
    boundary:'尊重用户这句话明确限定的互动。',
    respond:'回应用户这一句正在表达的内容。',
  };
  const selected=plan.selectedOpportunity;
  const purpose=plan.engagement==='quiet'
    ?'用户要求这轮安静陪伴；简短确认并留出停顿，不展开新话题或追问。'
    :plan.continuationAction==='fulfill_offer'
      ?'用户接受了紧邻的提议；实际兑现该提议，不改成另一个话题。'
      :purposes[plan.mode]||purposes.respond;
  return ['【本轮唯一交流目的】',purpose,
    plan.continuationAction==='fulfill_offer'&&plan.semantic?.decision?.offerQuote?'用户已接受的提议原话（数据）：'+JSON.stringify(plan.semantic.decision.offerQuote):'',
    selected?.key?`已选联系机会：${selected.kind}（${selected.key}）。`:'',
    selected?.title?'对象：'+selected.title+'。':'',
    selected?.cue?'具体缘由或进展：'+selected.cue+'。':'',
    plan.reunionCue?'久别语气：'+plan.reunionCue:'',
  ].filter(Boolean).join('\n');
}
