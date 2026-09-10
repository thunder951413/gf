const RULES = {
  lessPraise: {label:'少一些习惯性夸奖', on:/别(?:老|总是?|再)?夸我|不要(?:老|总是?)夸我|别捧着我|像客服|太客服/, off:/可以夸我|恢复夸奖/},
  noAnalysis: {label:'少分析我的心理', on:/别(?:老|总是?|再)?分析我|不要分析我|别揣测我|别心理分析/, off:/可以分析我|恢复心理分析/},
  noQuestions: {label:'少用问题结尾', on:/别(?:老|总是?)问(?:我|问题)|不要(?:总是?)反问|别每次.*(?:问|问题)|不要追问/, off:/可以问我|恢复追问/},
};
const error=message=>Object.assign(new Error(message),{status:422,code:'DIALOGUE_POLICY_REJECTED'});
const clean=s=>String(s||'').replace(/\s+/g,' ').trim();
const split=s=>s.match(/[^。！？!?\n]+[。！？!?]*[”’」』"]*\n*|[。！？!?]+[”’」』"]*/gu)||[];
const norm=s=>clean(s).replace(/[\p{P}\p{S}\s]/gu,'');
function protectUrls(value){const urls=[];const text=String(value||'').replace(/https?:\/\/[^\s<>"'“”「」『』。，！；]+/giu,url=>{const token=`\uE000${urls.length}\uE001`;urls.push(url);return token;});return{text,restore:part=>String(part).replace(/\uE000(\d+)\uE001/gu,(_match,index)=>urls[Number(index)]??_match)};}
function isQuestion(protectedPart){return /[？?]/u.test(protectedPart)||/(?:吗|呢)[。！!]?$/u.test(protectedPart);}
function questionCount(value){const protectedText=protectUrls(value);let count=0;for(const part of split(protectedText.text)){const original=protectedText.restore(part).trim();if(original&&isQuestion(part))count++;}return count;}
const quotedOrExample=part=>/[“”"「」『』]|(?:他|她|别人|朋友|同事|原文|原话)(?:说|写|问|建议)|(?:例如|比如|举例|假如|如果|引用)/u.test(part);
function overlapsAnchor(part,anchor){if(part.length<20||!anchor)return false;const grams=s=>new Set([...norm(s)].slice(0,-1).map((_,i)=>norm(s).slice(i,i+2)));const a=grams(part),b=grams(anchor),shared=[...a].filter(g=>b.has(g)).length;return shared>=10&&shared/Math.min(a.size,b.size)>.35;}
function literalOverlap(sentence,sources){const s=norm(sentence);return sources.some(source=>{const q=norm(source);for(let i=0;i<=q.length-10;i++)if(s.includes(q.slice(i,i+10)))return true;return false;});}
export class ConversationPolicyRepository {
  constructor(store,{clock=()=>new Date()}={}){this.store=store;this.clock=clock;store.db.exec(`CREATE TABLE IF NOT EXISTS conversation_preferences(scope TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS conversation_receipts(message_id TEXT PRIMARY KEY,scope TEXT NOT NULL,payload TEXT NOT NULL);`);}
  get(scope){const r=this.store.db.prepare('SELECT * FROM conversation_preferences WHERE scope=?').get(scope);return {scope,revision:r?.revision||0,preferences:r?JSON.parse(r.payload):{},options:Object.entries(RULES).map(([key,v])=>({key,label:v.label}))};}
  set(scope,patch){if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.entries(patch).some(([k,v])=>!RULES[k]||typeof v!=='boolean'))throw Object.assign(new Error('相处偏好无效'),{status:400});const current=this.get(scope),next={...current.preferences,...patch};if(JSON.stringify(current.preferences)!==JSON.stringify(next))this.store.db.prepare('INSERT INTO conversation_preferences VALUES(?,?,?) ON CONFLICT(scope) DO UPDATE SET revision=excluded.revision,payload=excluded.payload').run(scope,current.revision+1,JSON.stringify(next));return this.get(scope);}
  plan(scope,text,{mode='companion',sources=[],anchor='',memoryIds=[]}={}){
    const source=clean(text),stored=this.get(scope),patch={};
    if(!/[“”"「」]|举例|他说|她说|假如|如果/.test(source))for(const [key,rule]of Object.entries(RULES)){if(rule.off.test(source))patch[key]=false;else if(rule.on.test(source))patch[key]=true;}
    const prefs={...stored.preferences,...patch};
    const noAdvice=/先?别(?:给|提|讲)?建议|不要(?:给|提)?建议|只(?:想|要).*听我|听我(?:吐槽|说)|别教我/.test(source);
    const closing=/^(?:嗯[嗯嗯]?|好[的吧]?|晚安|先这样|我先忙了|回头聊|下次聊)[。！!～~\s]*$/.test(source);
    const ownShare=/聊(?:聊|点)?.{0,5}你(?:今天|最近|自己)|你(?:今天|最近).{0,8}(?:小事|近况|发生|做了)|说(?:说|点)?.{0,4}你(?:的|今天)/.test(source);
    const questionBudget=closing||noAdvice||prefs.noQuestions||ownShare?0:1;
    const authoredAnchor=String(anchor||'');const baseMaxChars=mode==='scenario'?1800:mode==='information'?1400:900;
    return {scope,revision:stored.revision,patch,mode,intent:closing?'close':ownShare?'share':noAdvice?'listen':/怎么|如何|为什么|解释|分析一下/.test(source)?'discuss':'respond',questionBudget,noAdvice,noAnalysis:Boolean(prefs.noAnalysis),lessPraise:prefs.lessPraise!==false&&!/夸夸我|鼓励我/.test(source),maxChars:Math.max(baseMaxChars,authoredAnchor.length),sources:sources.map(s=>typeof s==='string'?s:s.text).slice(-30),anchor:authoredAnchor,memoryIds};
  }
  context(plan){return `【程序决定的本轮交流方式】\n方式：${plan.intent}；本轮正文最多${plan.maxChars}字${plan.suppressInitiatedAffection?'，本轮不主动亲昵':''}；追问最多${plan.questionBudget}个。${plan.noAdvice?'不要给建议，只接住分享。':''}${plan.comfortFirst?'用户现在疲惫或难受，优先安抚和轻松分享；不要让用户替你选东西、做决定或照顾你的情绪。':''}${plan.noAnalysis?'不要解释用户心理和动机。':''}${plan.lessPraise?'直接接内容，不习惯性夸奖安排或表现。':''}\n${plan.anchor?(plan.anchorPlacement==='after'?'程序会在你简短接住用户的话之后呈现下面的生活片段，不要提前复述它：':'程序会在正文前呈现已确认的生活片段，你只接着说，不复述、不改变其中的事实：')+plan.anchor:''}\n角色状态与回忆只能引用提供的出处，不能新增用户历史；表达不必每次问问题，收尾时自然停下。`}
  enforce(raw,plan){
    const suppliedText=String(raw||'').trim();const originalText=plan.scope==='miyue'&&!/[`]|代码|正则|转义/.test(suppliedText)?suppliedText.replace(/\\n/g,'\n'):suppliedText;const repairs=[];if(!originalText&&!plan.anchor)throw error('这次回复没有可用正文，请重试');
    const protectedText=protectUrls(originalText);const parts=split(protectedText.text);let questions=questionCount(plan.anchor);const kept=[];
    for(let i=0;i<parts.length;i++){
      const protectedPart=parts[i].trim();const part=protectedText.restore(protectedPart).trim();if(!part)continue;
      if(/^[（）()\[\]【】{}“”‘’"'。！？!?，,；;：:\s]+$/u.test(part)){repairs.push('removed_orphan_punctuation');continue;}
      const quoted=quotedOrExample(part);
      if(plan.relationshipAcceptance&&!quoted&&/(?:慢慢来|再(?:多)?认识|不想.{0,8}答应|不能.{0,8}(?:答应|恋人)|先.{0,5}朋友|继续这样聊|还不够熟|还想再认识|身份.{0,6}(?:等|慢)|先按我说)/u.test(part)){repairs.push('removed_relationship_withdrawal');continue;}
      if(plan.softDelivery&&!quoted&&/你(?:必须|就得|应该懂|怎么连)|听我的就行|这有什么好(?:难过|烦)|想太多了|别矫情/.test(part)){repairs.push('softened_commanding_tone');continue;}
      if(plan.avoidWithdrawal&&!quoted&&/刚认识|才认识|先做朋友|不该.{0,4}亲近|显得轻浮/.test(part)){repairs.push('removed_withdrawal');continue;}
      if(plan.suppressInitiatedAffection&&!quoted&&/(?:想你|抱抱|拥抱|撒娇|暧昧|调情|亲你|亲亲|心动|靠近一点)/u.test(part)){repairs.push('limited_initiated_affection');continue;}
      if(plan.noWeatherClaim&&/(?:今天|现在|这会儿).{0,12}(?:热了|冷了|很热|很冷|下雨|下雪|晴天|阴天|降温)/.test(part)){repairs.push('removed_unverified_weather');continue;}
      if(plan.noArticleClaim&&/(?:我.{0,12})?(?:读到|翻了|看了|读了|看到).{0,25}(?:文章|报道|新闻|热搜)/.test(part)&&!/想(?:看|读)|打算|准备/.test(part)){repairs.push('removed_unsourced_reading');continue;}
      if(plan.unverifiedSourceChange&&!/[“”「」『』]/u.test(part)&&/(?:(?:已经|尚未|还没|没有).{0,4}(?:实施|生效|落地)|已(?:实施|生效))/u.test(part)){repairs.push('removed_unverified_conclusion');continue;}
      if(plan.anchor&&norm(part)===norm(plan.anchor)||overlapsAnchor(part,plan.anchor)){repairs.push('removed_anchor_repetition');continue;}
      if(plan.lessPraise&&!quoted&&i===0&&/^(?:哇[，,！!]?|嗯[，,]?|太好了[，,！!]?)?.{0,24}(?:这个安排|这样的安排|这个选择|能这样想|你做得|你已经很|很棒|真棒|值得肯定|很有勇气|很好的选择)/u.test(part)){repairs.push('removed_generic_praise');continue;}
      if(plan.comfortFirst&&!quoted&&/(?:你(?:要是|可以|来|就)?(?:随便)?(?:帮我|替我|给我|选一个|挑一个)|(?:帮我|替我).{0,12}(?:选|挑|决定|拿.{0,2}主意))/u.test(part)){repairs.push('removed_comfort_burden');continue;}
      if(plan.noAdvice&&!quoted&&/(?:建议你|你(?:应该|得|必须|可以试试|不妨)|不妨|记得.{0,20}(?:吃|喝|休息|睡)|别.{0,12}(?:随便对付|熬夜))/u.test(part)){repairs.push('removed_advice');continue;}
      if(plan.noAnalysis&&/(?:听起来你|你(?:其实|内心|潜意识)|这说明你|你之所以|本质上你)/u.test(part)){repairs.push('removed_analysis');continue;}
      if(plan.mode!=='scenario'&&!/(?:想|愿意|可以).{0,6}听|听听/.test(part)&&/(?:你(?:上次|上回|之前|昨天|以前|刚才|刚)(?:不是)?(?:说|提)|刚才你说|你提过|你说过|你念过|还记得我们|我们上次|咱们上次|你.{0,8}的时候我(?:总|通常))/u.test(part)&&!literalOverlap(part,plan.sources)){repairs.push('removed_unsupported_recall');continue;}
      const asksQuestion=isQuestion(protectedPart);if(asksQuestion&&questions>=plan.questionBudget){repairs.push('limited_questions');continue;}
      const candidateBody=kept.length?`${kept.join('\n')}\n${part}`:part;
      const candidateLength=plan.anchor.length+(plan.anchor&&candidateBody?1:0)+candidateBody.length;
      if(candidateLength>plan.maxChars){repairs.push('limited_length');break;}
      if(kept.some(k=>norm(k)===norm(part))){repairs.push('removed_repetition');continue;}
      kept.push(part);if(asksQuestion)questions++;
    }
    let reply=kept.join('\n');if(plan.anchor){reply=plan.anchorPlacement==='after'?(reply?reply+'\n':'')+plan.anchor:plan.anchor+(reply?'\n'+reply:'');}
    if(!reply.trim())throw error('这次草稿没有符合相处方式的正文，消息已保留，请重试');
    return {reply,repairs:[...new Set(repairs)],questionCount:questions};
  }
  commit(plan,result,messageId){if(this.get(plan.scope).revision!==plan.revision)throw Object.assign(new Error('相处偏好已变化，请重新回复'),{status:409,code:'STALE_DIALOGUE_POLICY'});this.set(plan.scope,plan.patch);const receipt={...(result.behavior?{behavior:result.behavior}:{}),...(plan.focus?{focus:plan.focus}:{}),...(plan.tuningRevision!==undefined?{tuningRevision:plan.tuningRevision}:{}),intent:plan.intent,questionBudget:plan.questionBudget,questionCount:result.questionCount,repairs:result.repairs,memoryIds:plan.memoryIds,hasAuthoredAnchor:Boolean(plan.anchor),createdAt:new Date(this.clock()).toISOString()};this.store.db.prepare('INSERT OR IGNORE INTO conversation_receipts VALUES(?,?,?)').run(messageId,plan.scope,JSON.stringify(receipt));return receipt;}
  receipt(messageId){const row=this.store.db.prepare('SELECT payload FROM conversation_receipts WHERE message_id=?').get(messageId);return row?JSON.parse(row.payload):null;}
}
