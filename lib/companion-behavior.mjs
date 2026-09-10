import {createHash} from 'node:crypto';

const instructions={
 playful:'用一句与当前话题有关的轻巧打趣，不评价或挖苦用户。',
 tender:'用一句软软的小愿望撒娇，让对方现在通过聊天就能回应（叫名字、陪聊、分享心事）。不转成下次见面或替你做身体动作，不催回复。',
 hopeful:'承认眼前感受后，提一个眼前话题里值得期待的小细节，不强行正能量。',
 perspective:'坦率说一个与当前话题相关的自己的偏好或不同看法，不纠正用户感受。',
 affection:'用一句含蓄的想念或亲近表达接当前内容，不露骨、不索取承诺。',
};
const stripQuotes=text=>String(text).replace(/[“「『][^”」』]*[”」』]/g,'');
export function companionIntent(text,conversation=[]){
 const clean=stripQuotes(text).trim(),recent=conversation.filter(m=>m.speaker==='user').slice(-2).map(m=>m.text).join(' ');
 const declined=/(?:不要|不想|别|停止).{0,8}(?:暧昧|撒娇|亲密|亲近|抱|亲我)|普通朋友|普通聊|不用每句|保持距离/.test(clean);
 const invitation=!declined&&(/你(?:也|会|愿意|想).{0,8}(?:需要我|做我的(?:月球|月亮|星星)|陪着我|陪伴我)/.test(clean)||/^(?:所以)?你愿意吗[？?。\s]*$/.test(clean)&&/做我的(?:月球|月亮|星星)|陪着我|陪伴我/.test(recent));
 const affection=!declined&&/抱抱[我你]|亲亲[我你]|想(?:要)?(?:抱|亲)(?:一?下)?你|哄哄我|撒(?:个|一点)?娇|想听你撒|想和你.{0,3}(?:亲近|暧昧)/.test(clean);
 const weary=/累|疲惫|烦|难过|委屈|孤独|焦虑|崩溃|不开心/.test(clean)&&!/不累|不烦|不难过|不焦虑/.test(clean);
 const handoff=/愿意听你说|听你说(?:话|点|说)|你来(?:说|聊|起头)|你说点|你挑个话题|说说你的近况|你今天有什么|聊(?:聊|一下)你(?:自己|今天|最近|现在)/.test(clean);
 const clarify=/^(?:去|到)(?:那|这)(?:边|里|儿)(?:干嘛|干吗|做什么|为什么)[？?。\s]*$/.test(clean);
 const recall=/记得|我(?:之前|以前|上次).{0,6}(?:说|提)|我在哪|我喜欢怎么/.test(clean);
 const question=/[？?]|(?:吗|么|为何|为什么|是什么|干嘛|怎么|多少|哪[个里儿])/.test(clean);
 return{declined,invitation,affection,weary,handoff,clarify,question,recall,kind:declined?'boundary':recall?'recall':invitation?'receive_closeness':clarify?'clarify':affection?'affection_reply':weary?'comfort':handoff?'share':question?'answer':'respond'};
}
function pick(seed){return createHash('sha256').update(seed).digest().readUInt32BE(0)/0x100000000;}
export class CompanionBehavior {
 constructor(store,tuning){this.store=store;this.tuning=tuning;}
 recent(){return this.store.db.prepare("SELECT payload FROM conversation_receipts WHERE scope='miyue' ORDER BY rowid DESC LIMIT 12").all().map(r=>JSON.parse(r.payload).behavior).filter(Boolean);}
 plan(policy,text,{conversation=[],inner=null,initiating=false}={}){
  const {values:v}=this.tuning.get(),intent=companionIntent(text,conversation),past=this.recent();
  const turn=this.store.db.prepare("SELECT COUNT(*) n FROM messages WHERE role='miyue' AND speaker='user'").get().n;
  const negative= intent.weary||intent.declined||policy.noAnalysis&&/难受/.test(text),explicit= intent.affection||intent.invitation;
  const style={stance:v.pleasing>=70?'偏爱迁就小偏好':v.independence>=65?'保留自己的偏好':'平等自然',warmth:v.warmth>=70?'柔软体贴':v.warmth<35?'清爽直接':'温和自然',sensitivity:v.sensitivity>=70?'认真接住明确情绪细节':v.sensitivity<35?'松弛，不过度解读':'只回应明确情绪'};
  let extra=null;
  const variants=[['playful',v.playfulness],['tender',v.coyness],['hopeful',v.optimism],['perspective',v.independence],['affection',v.flirtation]];
  // One expressive beat at most; actual delivered receipts control repeat spacing.
  if(turn>=3&&!negative&&!intent.question&&!intent.handoff&&policy.intent!=='close'&&!explicit){
   const eligible=variants.filter(([name,value])=>value>=55&&(!['tender','affection'].includes(name)||(inner?.affection??55)>=50)&&(name!=='playful'||(inner?.mood??65)>=40)&&!past.slice(0,name==='tender'||name==='affection'?3:1).some(p=>p.extra===name)&&(name!=='affection'||inner?.affectionAllowed===true)&&!(name==='tender'&&inner?.intimacyBoundary==='friendly'));
   const phase=pick(`${turn}:${text}:expression`),sum=eligible.reduce((s,[,w])=>s+(w-40),0),chance=Math.min(.7,sum/400);
   if(phase<chance&&sum){let cursor=pick(`${turn}:${text}:kind`)*sum;extra=eligible.find(([,w])=>(cursor-=w-40)<0)?.[0]||null;}
  }
  if(intent.affection&&/撒/.test(text)&&!intent.declined)extra='tender';
  const needsReply=intent.invitation&&/需要我/.test(text);
  const forcedOpening=intent.invitation?(needsReply?(v.warmth>=70?'会呀。':'会。'):(v.warmth>=70?'愿意呀。':'愿意。')):null;
  const behavior={version:1,intent:intent.kind,style,extra,turn,forcedOpening,explicit,needsReply,initiating,comfort:intent.weary&&v.pleasing>=65,clarify:intent.clarify};
  const next={...policy,behavior};
  if(intent.kind==='share'){next.intent='share';next.questionBudget=0;}
  if(intent.invitation||intent.affection)next.suppressInitiatedAffection=false;
  if(intent.invitation||intent.clarify||intent.recall)next.questionBudget=0;
  if(intent.recall)next.noAnalysis=true;
  if(extra)next.questionBudget=Math.min(1,policy.questionBudget??1);
  behavior.targetChars=Math.round(100+v.verbosity*5);
  if(intent.affection)behavior.targetChars=Math.min(70,behavior.targetChars);
  if(intent.invitation)behavior.targetChars=Math.min(90,behavior.targetChars);
  if(intent.handoff)next.comfortFirst=true;
  if(behavior.comfort&&!/建议|怎么办|怎么做|分析|解决/.test(text)){next.noAdvice=true;next.questionBudget=0;next.comfortFirst=true;}
  if(intent.declined){next.suppressInitiatedAffection=true;behavior.extra=null;}
  next.softDelivery=v.warmth>=70;next.avoidWithdrawal=v.pleasing>=70&&explicit;
  return next;
 }
  context(plan){const b=plan.behavior;if(!b)return'';
  const purpose={recall:'按所给历史原话直接回答每一项，没找到的明确说没找到，不猜测用户动机或追加问题。',receive_closeness:'直接接住亲近邀请，承接用户的比喻或需要，不退回“刚认识/只能倾听/先做普通朋友”。',clarify:'用户是在问刚才你提议的理由，不是在答应出行；先解释理由，不宣称用户要出门。',share:'用户明确愿意听你说话，不是在要求安静。直接继续讲一个具体内容，不结束、不说我不说了、不让用户选话题或选东西。',comfort:'先回应用户的疲惫或难受；少任务、少建议，自己的项目不能抢话题。',boundary:'自然尊重用户明确距离，直接继续普通话题。',affection_reply:'回应当前明确的亲近邀请，不用主动表达冷却来拒绝。可以温柔想象拥抱，但你们正在远程聊天，不安排用户来店里、挨着座位坐下或喝你的饮料。',answer:'先准确回答当前问题；自己的生活仅在相关时补一句。',respond:'顺着用户这句话接下去，有自己的反应，不每次都问问题。'};
  return `【本轮行为】${b.needsReply?'用户问的是你会不会需要他。直接说你想让他参与的一个具体小愿望，不误读成他在说需要你。':b.initiating?'主动分享一个与当前生活或历史话题相关的具体见闻、感受或想法，不催回复。':purpose[b.intent]}\n语气：${b.style.warmth}；态度：${b.style.stance}；${b.style.sensitivity}。${b.forcedOpening?'程序先呈现“'+b.forcedOpening+'”，reply直接续接，不重复开头或撤回。':''}\n普通话题可参考约${b.targetChars}字，内容充分或用户追问时可以展开至本轮上限；没有固定句数，也可以更短，不为凑长度加景物、比喻或泛泛感动。温柔度影响态度，不增加修辞浓度。日常本轮直接说事、想法或感受，不写景、不另造比喻和拟人，不以人生感悟收尾；用户明确要求文学表达时才放开。不逐项复述所有背景。${b.extra?'reply不提问；extra需填写：'+instructions[b.extra]:'extra留空，这轮不额外撒娇、调情或切换话题。'}${b.focus?'本轮围绕《'+b.focus.title+'》'+(b.focus.continuation?'接着聊当时分享的具体内容，不能把旧经历说成刚刚发生；':'补充一个具体细节或自己的反应；')+'当前生活状态只影响语气，不引入第二个生活话题。没有固定开头或结尾要求，温柔可体现在措辞里。':''}${b.comfort?'不把自己的小需要交给累着的用户，不让他选配色/帮你决定。':''}`;
 }
 fallback(plan,issues){
  const b=plan.behavior,allowed=new Set(['missing_or_long_extra','missing_tender_act','missing_affection_act','main_must_not_ask','required_extra_removed','offline_instead_of_chat','undoes_tenderness','novel_stage_direction','invented_media_contact']);
  if(b?.intent!=='affection_reply'||b.extra!=='tender'||!issues.every(i=>allowed.has(i)))return null;
  const lines=['多叫我一声雨薇嘛，我喜欢你这样叫我。','今天想被你偏爱一点点，分我一句软软的话就好。','我想再赖着和你聊两句，就两句呀。','今天想听你夸我一点点，不用很厉害，小小一句就好。'];
  return{reply:'那我就软一点说。',extra:lines[b.turn%lines.length]};
 }
 assess(reply,extra,plan){const b=plan.behavior,issues=[];if(!b)return issues;
  const value=String(reply||'');
  if(/(?:我|昨天|前天|上次).{0,6}(?:去过|到过|在|从)你家.{0,12}(?:回|坐|吃|待|住)|我们(?:昨天|刚才|上次).{0,5}(?:见面|碰面|牵手逛)/u.test(value))issues.push('invented_offline_presence');
  if(b.forcedOpening&&/刚认识|才认识|先.{0,8}(?:朋友|日常|熟悉)|只能.{0,5}(?:听|倾听)|保持.{0,5}距离|不急着.{0,5}关系/.test(value))issues.push('withdraws_invitation');
  if(b.explicit&&/(?:(?:椅子|座位).{0,12}(?:挪|空).{0,24}给你|隔着桌子跟你|你把头靠过来|过来靠一会儿|你(?:过来|来|就)?(?:挨着|坐到|坐在).{0,8}(?:我|旁边)|给你(?:留|空).{0,5}(?:座|位置)|你过来.{0,8}(?:坐|喝)|递(?:给你|到你).{0,8}(?:杯|茶|酒))/.test(value))issues.push('invented_offline_presence');
  if(b.explicit&&/你(?:的)?声音|听(?:见|到)你声音|看(?:见|到)你(?:的)?照片/.test(value))issues.push('invented_media_contact');
  if(b.intent==='recall'&&/考(?:起|验|考)|怕我.{0,5}忘|害怕.{0,5}忘/.test(value))issues.push('analyzes_recall_request');
  // Reject before question filtering can throw away an answer bundled with a
  // trailing question. A missing factual answer is not a successful delivery.
  if(b.intent==='recall'&&/[？?]/.test(value))issues.push('recall_answer_must_be_declarative');
  if(b.needsReply&&/谢谢你.{0,5}(?:需要|愿意)|谢谢你.{0,5}说给我/.test(value))issues.push('reversed_need');
  if(b.clarify&&/听你说.{0,5}(?:出门|出发|要去)|你(?:要|准备|决定)(?:出门|出发|去)|去去去/.test(value))issues.push('invented_user_decision');
  if(b.explicit&&/不在也没关系|我自己.{0,8}(?:也挺好|也可以|就行)|不会提醒你夸|还是算了/.test(value))issues.push('undoes_tenderness');
  if(b.intent==='share'&&/我不说了|给你留.{0,5}安静|先不聊|等你想聊/.test(value))issues.push('stops_instead_of_sharing');
  if(b.intent==='share'&&/你.{0,10}(?:想聊什么|说点什么|选一个|挑一个|说一个)|你.{0,8}(?:天气|凉下来|什么想聊)|想听.{0,8}(?:偏好|选择)/.test(value))issues.push('returns_topic_to_user');
  if(b.extra&&/[？?]|(?:吗|呢)[。！!]?$/u.test(value.trim()))issues.push('main_must_not_ask');
  if(b.extra&&(!String(extra||'').trim()||String(extra).length>180))issues.push('missing_or_long_extra');
  if(b.extra==='tender'&&extra&&/下次见面|帮我.{0,4}(?:系|剥|吹)|陪我去|拉着你/.test(extra))issues.push('offline_instead_of_chat');
  if(b.extra==='tender'&&extra&&!/我|陪|一点|好不好|嘛|呀/.test(extra))issues.push('missing_tender_act');
  // The slot has a structural contract, not a mandatory vocabulary. An implicit
  // affectionate line (e.g. wanting to taste the user's drink) need not say 想你.
  // Keyword absence cannot establish a semantic failure or block the whole turn.
  if(/[（(][^）)]{0,24}(?:笑|看你|低头|指尖|轻轻|歪头)[^）)]{0,24}[）)]/.test(value))issues.push('novel_stage_direction');
  return issues;
 }
 compose(reply,extra,plan){const b=plan.behavior;let text=String(reply).trim();if(!b)return text;
  if(b.forcedOpening){text=text.replace(b.needsReply?/^(?:我)?(?:也)?会(?:呀|啊)?[，,。！!\s]*/:/^(?:我)?愿意(?:呀|啊)?[，,。！!\s]*/,'');text=b.forcedOpening+text;}
  if(b.extra&&extra)text+='\n'+String(extra).trim();return text;
 }
}
