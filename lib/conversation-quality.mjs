import { normalizeReplyPresentation } from './reply-presentation.mjs';
import { replyNoveltyMatches } from './reply-novelty.mjs';
const clean=value=>String(value??'').replace(/\s+/gu,' ').trim();
const normalize=value=>clean(value).replace(/[\s\p{P}\p{S}]/gu,'');
const sentenceParts=value=>String(value??'').match(/[^。！？!?\n]+[。！？!?]*|\n+/gu)||[];
const assistantRow=row=>/^(?:assistant|ai|bot|miyue)$/iu.test(String(row?.speaker??row?.role??row?.author??''));
const rowText=row=>clean(typeof row==='string'?row:row?.text??row?.content??row?.message);
const isQuoted=value=>/[“”「」『』"']/.test(value)||/(?:这句话|这句|原话|引用|比如|例如|为什么总说|别再说|不要说)/u.test(value);
const WITHDRAWAL=/(?:(?:我(?:这会儿|现在|这边)?(?:也)?(?:不急着|不着急|不催)(?:要|等|让)?你(?:回|回复))|(?:看|玩|吃).{0,8}完(?:了)?再(?:来)?找我|等你.{0,10}(?:落地|回来|忙完|有空|到家).{0,8}再(?:说|聊|讲)(?:别的|这些|其他|这个)?|(?:我)?不用你每条都回|不用每条都回|不(?:用|必)回我|不急着回(?:我)?|不催你回|你先忙你的(?:登机)?|你忙你的|你(?:先)?去忙吧|你先忙吧|不打扰你了|有空再聊|回头聊|不着急回(?:我|消息)?|不用急着回(?:我|消息)?|别急着回我|你安心等你的|你(?:先)?歇着(?:吧)?|你(?:就|先)?(?:自己|一个人)(?:待着|待会|待一会)(?:吧|就行|就好)|等你回来再说|你不用管我[，,、；;]?\s*去洗漱你的)/u;
const AFFECTION_TEST=/(?:你.{0,12}(?:是真|真的是).{0,14}(?:想我|喜欢我|爱我).{0,14}还是|(?:想我|喜欢我|爱我).{0,28}(?:不算数|证明给我)|(?:你|我得听你).{0,24}(?:自己讲|自己说).{0,18}(?:不算数|才算)|闲下来.{0,20}(?:踩一脚|才想起我))/u;
// This describes an unsolicited status-report sentence, independent of the
// particular activity (cooking, reading, shopping, etc.). Affection is not one.
const STATUS_REPORT=/^(?:我(?:这边|这会儿|现在|此刻|在家(?:里)?)\s*(?:刚|正|还|已经|又|准备|人|把)|我人(?:还|正|就|一直)?(?:在|窝|坐|靠|躺)|人(?:还|正|就|一直)?(?:窝|靠|躺|坐)在)/u;
// A status aside often puts an object before its verb ("我这边碗还没洗").
// Count the reporting construction, independently of the particular meal/job.
// First-person emotion/opinion is not a report about a parallel activity.
const CURRENT_ASIDE=/^我这(?:边|儿)(?![，,。\s]*(?:也|倒|其实|还|挺|很|有点|就是|只|真|确实)*(?:想|觉得|感觉|喜欢|心里|舍不得|希望|愿意|担心|在乎|抱|亲))/u;
const statusReport = value => STATUS_REPORT.test(value) || CURRENT_ASIDE.test(value);
// Explicit hindsight scolding is not a useful recall of an earlier exchange.
// Quoted discussion remains untouched, as with other narrow style repairs.
const HINDSIGHT_BLAME=/(?:我(?:昨天|之前|早就|刚才).{0,8}(?:跟你说|提醒(?:过)?你|告诉过你).{0,16}(?:别|不要|注意)|(?:早就|早)跟你说(?:过)?了|谁让你不听|让你不听(?:话|劝)|这(?:一)?课.{0,8}上到肉里|不听(?:我的|劝).{0,8}(?:吃亏|后悔|知道))/u;
const TOPICS=[
  ['documents',/(?:身份证|证件|护照|登机牌)/u],
  ['charger',/(?:充电器|充电宝|电量)/u],
  ['water',/(?:喝水|水杯|水)/u],
  ['boarding',/(?:航站楼|登机口|登机|安检|广播)/u],
];

function topicNames(value){return TOPICS.filter(([,pattern])=>pattern.test(value)).map(([name])=>name);}
function imperativeReminder(value){
  if(isQuoted(value)||!topicNames(value).length)return false;
  return /(?:别忘了|别(?:再)?磨蹭|记得|务必|一定要|要记得|注意|先(?:去)?看|先确认|先找|(?:你)?留意一下|别听岔|到了.{0,8}(?:先|就)|出发前.{0,8}(?:检查|带上)|把.{0,12}(?:塞进去|装进去)|(?:身份证|证件|充电器).{0,10}别(?:还)?搁家里|先把(?:登机口|航站楼).{0,8}看一眼|^去接点水[。！!]?$)/u.test(clean(value));
}
function userRequestedAdvice(text){if(/(?:别|不要|不用).{0,8}(?:提醒|建议|叮嘱)|知道了知道了/u.test(text))return false;return /(?:建议|提醒|注意事项|攻略|要注意什么|要带什么|该带什么|帮我看看|帮我想想|怎么(?:办|准备)|需要准备)/u.test(text);}
// Detect only explicit bookend formulas, not all affection or care.
function needsComfort(text){return /(?:担心|害怕|焦虑|难过|委屈|难受|心慌|紧张|不安|安慰我|哄哄我|哄我)/u.test(text)&&!/(?:不(?:用|要)|别).{0,5}(?:安慰|哄)/u.test(text);}
function unsolicitedOpening(text,plan){
  if(userRequestedAdvice(plan.currentText)||isQuoted(text))return false;
  if(!needsComfort(plan.currentText)&&/^(?:坐下|到了|到家|过了安检|吃过|吃了|睡过|睡了)就好[，,、]?\s*(?:慢慢等|先歇着|慢慢来)?[。！!～~ ]*$/u.test(clean(text)))return true;
  return imperativeReminder(text)||/^(?:嗯[，,]?|好[，,]?|那[，,]?)?\s*(?:你)?(?:记得|别忘了|一定要|要记得|注意|先去|赶紧).{0,22}(?:吃饭|喝水|休息|睡觉|别累|身体|保暖|安全|带伞|外套)/u.test(clean(text));
}
function reassuranceTail(text,plan){
  if(plan.allowClosing||needsComfort(plan.currentText)||isQuoted(text))return false;
  return /^(?:(?:嗯|好|那|反正|总之)[，,、 ]*)?(?:只要)?你(?:自己)?(?:开开心心|开心|舒服|舒舒服服|顺利|顺顺利利|平安|平平安安|好好的|好好|不累|轻松|自在|按自己的节奏|照自己的节奏|想怎么来就怎么来).{0,8}(?:就好|就行|就够了)[。！!～~ ]*$/u.test(clean(text))||/^你(?:自己)?怎么(?:舒服|开心|自在)怎么来[。！!～~ ]*$/u.test(clean(text));
}
function recentAdviceRows(conversation){
  const turns=[];let lastWasAssistant=false;
  for(const row of Array.isArray(conversation)?conversation:[]){
    const text=rowText(row);if(!text)continue;
    if(assistantRow(row)){
      if(lastWasAssistant&&turns.length)turns.at(-1).text=clean(`${turns.at(-1).text}\n${text}`);
      else turns.push({text});
      lastWasAssistant=true;
    }else lastWasAssistant=false;
  }
  const selected=turns.slice(-4).flatMap(turn=>sentenceParts(turn.text).map(clean).filter(Boolean).filter(imperativeReminder));
  const rows=[];let chars=0;
  for(const text of selected.slice(-12)){
    if(chars+text.length>2000)break;
    rows.push({text,topics:topicNames(text)});chars+=text.length;
  }
  return rows;
}
function activeText(text){return /(?:想你|陪我|还有(?:一个半小时|[一二两三四五六七八九十\d]+(?:个)?小时)|在等(?:你|着|人)?)/u.test(text);}
function explicitClosing(text){return /(?:我先忙了|先不聊(?:了)?|我(?:现在)?要登机了|晚安)(?:[，,、；;]\s*(?:晚点再聊|回头聊|先这样|拜拜|回见))?[。！!～~ ]*$/u.test(text);}
function adviceRepeated(text,plan){
  if(userRequestedAdvice(plan.currentText)||isQuoted(text)||!imperativeReminder(text))return false;
  if(plan.reminderAcknowledged&&(plan.recentAdvice||[]).length)return true;
  const past=new Set((plan.recentAdvice||[]).flatMap(row=>row.topics||[]));
  return topicNames(text).some(topic=>past.has(topic));
}

export function conversationQualityPlan({userText='',conversation=[],initiating=false,sameActivity=false,lifeParticipation=null,semantic=null,trigger=null}={}){
  // Policy-routing text can describe a gesture. Only the typed user trigger
  // authorizes treating words as an actual utterance in the generated context.
  const currentText=clean(trigger?(trigger.type==='user_message'?trigger.userText:''):userText);
  if(trigger){initiating=trigger.type!=='user_message';if(initiating)semantic=null;}
  const recentAdvice=recentAdviceRows(conversation);
  const reminderAcknowledged=/(?:知道了(?:知道了)?|别念(?:了)?|别催(?:了)?|不用再提醒|我记得)/u.test(currentText);
  const allowClosing=semantic?semantic.intent==='close':explicitClosing(currentText);
  const active=activeText(currentText);
  const topics=[...new Set(recentAdvice.flatMap(row=>row.topics))];
  const asksOwnLife=/(?:你|你的).{0,12}(?:在干|在做|干嘛|忙什么|做什么|怎么样|近况|小事|生活|状态|进展|洗|收拾|休息)|说说你|聊聊你|你说个|刚才|继续|后来|详细|展开/u.test(currentText);
  const statusReports=conversation.filter(assistantRow).slice(-8).flatMap(row=>sentenceParts(rowText(row))).filter(part=>statusReport(clean(part)));
  const reportRequested=lifeParticipation?lifeParticipation.detailedState:asksOwnLife;
  const suppressStatusReport=Boolean((lifeParticipation||sameActivity)&&!initiating&&!reportRequested&&statusReports.length>=2);
  const context=clean(`【本轮自然连续性】${currentText?'用户当前话是“'+currentText.slice(0,180)+'”。':'本轮由角色主动开口，没有新的用户原话。'}${allowClosing?'用户明确收尾，可自然道别。':active?'用户仍在互动中，继续接住当前话题。':'不要擅自说“你先忙你的”、催用户离开或替用户收尾。'} 像熟悉的恋人平等聊天，直接给自己的反应、观点或小事，不照管、批准或总结用户的行程和选择。遇到损失或失落先接住，不用“早提醒过你”追责，不猜最心疼的是钱还是照片。普通聊天先接内容，不用叮嘱开场；没有明确担忧或求安慰时，不追加‘你舒服/顺利/开心就好’式结尾，自己的内容说完即可。不要自动追加下一个问题。${reminderAcknowledged?'用户已表示知道，停止提醒。':''}${topics.length?` 近期已提醒：${topics.join('、')}；除非用户这轮明确要建议，不重复用命令式提醒。`:''}`);
  return {currentText,initiating:Boolean(initiating),allowClosing,active,reminderAcknowledged,recentAdvice,suppressStatusReport,context:(suppressStatusReport?'【本轮背景使用】近期已多次插入生活汇报，这轮不追加“我这边刚/还在……”式生活汇报，直接回应用户当前内容；背景仍保留用于回答追问。\n':'')+context.slice(0,suppressStatusReport?600:700)};
}

export function conversationQualityIssues(reply,plan={}){
  const value=String(reply??'');const issues=new Set();
  const presentation=normalizeReplyPresentation(value,plan);
  if(presentation.repairs.includes('removed_reply_label'))issues.add('echoed_reply_label');
  if(presentation.repairs.includes('removed_history_timestamp'))issues.add('echoed_history_timestamp');
  const parts=sentenceParts(value).filter(part=>clean(part));
  for(const [index,part] of parts.entries()){
    const sentence=clean(part);if(!sentence||isQuoted(sentence))continue;
    if(HINDSIGHT_BLAME.test(sentence))issues.add('hindsight_scolding');
    if(AFFECTION_TEST.test(sentence))issues.add('unfounded_affection_test');
    if(plan.suppressStatusReport&&statusReport(sentence))issues.add('repeated_status_report');
    if(!plan.allowClosing&&WITHDRAWAL.test(sentence))issues.add('uninvited_withdrawal');
    if(adviceRepeated(sentence,plan))issues.add('repeated_unsolicited_advice');
    if(index===0&&unsolicitedOpening(sentence,plan))issues.add('unsolicited_caretaking_opening');
    if(index===parts.length-1&&reassuranceTail(sentence,plan))issues.add('formulaic_reassurance_ending');
  }
  return [...issues];
}

// A clearly marked optional status aside can be omitted without regenerating
// an otherwise complete reply. If it is the entire answer, keep it for the
// existing one-repair path rather than sending an empty acknowledgement.
export function omitSaturatedLifeAsides(reply, plan = {}) {
  const source=String(reply||'');
  if(!plan.suppressStatusReport)return {reply:source,repairs:[]};
  let removed=false;
  const kept=sentenceParts(source).filter(part=>{
    if(!isQuoted(part)&&statusReport(clean(part))){removed=true;return false;}
    return true;
  }).join('').trim();
  return removed&&kept.length>=4?{reply:kept,repairs:['omitted_optional_life_aside']}:{reply:source,repairs:[]};
}

function removeWithdrawalClause(sentence){
  const match=WITHDRAWAL.exec(sentence);if(!match)return sentence;
  const before=sentence.slice(0,match.index).replace(/[，,、；;\s]+$/gu,'').trim();
  // Only retain a substantive clause before the dismissal. Dropping the entire
  // sentence otherwise avoids stranded tails such as “晚点再说” or “活去”.
  if(!before||/^(?:嗯|好|那|我不打扰你了|不着急|没事)$/u.test(before))return '';
  const punctuation=sentence.match(/[。！？!?]\s*$/u)?.[0].trim()||'';
  return `${before}${punctuation}`;
}

export function conversationQualityEnforce(reply,plan={}){
  const presentation=normalizeReplyPresentation(reply,plan);
  let original=presentation.reply;const repairs=[...presentation.repairs];let output='',pendingNewlines='';
  // Only exact, substantial repeats can be removed without interpreting the
  // meaning. Near-duplicates get one rewrite and an audit warning if unresolved.
  const duplicates=replyNoveltyMatches(original,plan.novelty).filter(match=>match.exact);
  const beforeDedup=original;
  for(const match of duplicates.reverse()){
    if(isQuoted(match.text))continue;
    original=original.slice(0,match.start)+original.slice(match.end);
    repairs.push('removed_repeated_reply_sentence');
  }
  // A weak model repeating its entire answer must not make a user's turn fail.
  // Keep it auditable after the sole rewrite; proactive duplicates are held.
  if(!original.trim()&&beforeDedup.trim()){
    original=beforeDedup;
    repairs.splice(repairs.indexOf('removed_repeated_reply_sentence'));
    repairs.push('retained_only_available_reply');
  }
  const parts=sentenceParts(original);const meaningful=parts.map((part,index)=>clean(part)?index:-1).filter(index=>index>=0);
  for(const [index,raw] of parts.entries()){
    if(/^\n+$/u.test(raw)){pendingNewlines+=raw;continue;}
    let sentence=raw;
    const trimmed=clean(sentence);if(!trimmed)continue;
    if(!isQuoted(trimmed)&&!plan.allowClosing&&WITHDRAWAL.test(trimmed)){
      sentence=removeWithdrawalClause(sentence);repairs.push('removed_uninvited_withdrawal');
    }
    const after=clean(sentence);if(!after)continue;
    if(!isQuoted(after)&&HINDSIGHT_BLAME.test(after)){repairs.push('removed_hindsight_scolding');continue;}
    if(!isQuoted(after)&&AFFECTION_TEST.test(after)){repairs.push('removed_affection_test');continue;}
    if(!isQuoted(after)&&plan.suppressStatusReport&&statusReport(after)){repairs.push('removed_repeated_status_report');continue;}
    if(adviceRepeated(after,plan)){repairs.push('removed_repeated_unsolicited_advice');continue;}
    if(index===meaningful[0]&&unsolicitedOpening(after,plan)){repairs.push('removed_unsolicited_caretaking_opening');continue;}
    if(index===meaningful.at(-1)&&reassuranceTail(after,plan)){repairs.push('removed_formulaic_reassurance_ending');continue;}
    if(output)output+=pendingNewlines;
    pendingNewlines='';output+=sentence.trim();
  }
  if(output)output+=pendingNewlines;
  return {reply:output,repairs:[...new Set(repairs)]};
}

// Content filters may legitimately remove unsupported recollections. Validate
// the delivered remainder too: a social receipt alone does not answer a new
// topic. This is a narrow structural check, not a semantic relevance scorer.
export function replyRemainderIssues(reply,turnPlan) {
 if(turnPlan?.engagement!=='continue_topic')return [];
 const text=clean(reply).replace(/[，,。！!～~\s]/gu,'');
 const receipt=/^(?:(?:嗯|那|好呀|好的|好|行|可以|知道了|收到|没问题)|(?:(?:你)?(?:先)?(?:去(?:弄|买|吃|喝|忙|休息)?吧|忙吧|歇着吧?)))+$/u;
 return !text||receipt.test(text)?['topic_reply_missing']:[];
}
