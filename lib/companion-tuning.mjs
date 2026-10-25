const definitions=[
 ['pleasing','讨好倾向','愿意迁就小偏好、主动哄你开心，更优先照顾你的感受。','自然随性','更偏爱、迁就你',65],
 ['warmth','温柔度','影响措辞、安慰方式，以及表达不同意见时的柔和程度。','清爽直接','柔软体贴',80],
 ['sensitivity','敏感度','影响对明确情绪线索的反应幅度；不把普通沉默理解成冷落。','松弛钝感','细腻敏感',50],
 ['optimism','乐观度','遇到不顺时，更侧重陪着消化还是寻找小小的期待。','平实沉静','明亮乐观',65],
 ['playfulness','活泼度','影响俏皮玩笑、轻松联想与分享时的兴致。','安静内敛','活泼俏皮',55],
 ['coyness','撒娇倾向','更愿意用软一点、可爱一点的方式表达小需要。','坦率自然','偶尔软软撒娇',35],
 ['flirtation','暧昧倾向','影响她会不会主动撩、说想你、开暧昧玩笑；低档只回应你明确的邀请。','不主动暧昧','更容易亲近',30],
 ['initiative','主动程度','影响她聊天里另起话题的频率，以及主动找你的间隔；仍遵守全局时段、免打扰和次数上限。','不主动找你','更常分享和关心',50],
 ['verbosity','话量','按数值连续影响每轮字数预算，明确要求详细讲解时会保留展开空间。','短句陪伴','多聊一些',50],
 ['independence','独立性','影响她表达自己偏好、提出不同看法和向你分享需要的方式。','更愿意听你的','更有自己的想法',55],
 // Emotional range toward him (COMPANION-ALIVENESS.md 5.9). The fixed floor —
 // no cold shoulder, no guilt, no threats, no demand to reply — holds at any value.
 ['missing','想念表达','她多常说想你，分开久了会不会来找你、回来时先黏你一阵。','回来时轻轻一句','分开半天就惦记',65],
 ['jealousy','醋意','你提到别的女生或别的 AI 时，她会不会酸、要不要你哄。','不吃醋','明显吃醋要你哄',40],
 ['temper','小脾气','被冷落、被敷衍时，她会不会说出来、小小闹一下。','不闹情绪','小小闹一下再软下来',40],
 ['recovery','消气速度','有小情绪时多久好。任何档位都不隔夜、不翻旧账。','当轮就好','要你认真哄一下',30],
 ['clingy','黏人','多常撒娇要你夸、要你陪、要你说爱她。','不求关注','常撒娇要关注',55],
 ['loveTalk','情话','多常主动说情话，用你们自己的事说。','你要才说','常主动说',60],
 ['stubborn','坚持己见','有分歧时坚持多久，会不会过几天带着新理由回来接着聊。','容易被说服','坚持并接着辩',55],
];
export const TUNING_FIELDS=Object.freeze(definitions.map(([key,label,description,low,high])=>Object.freeze({key,label,description,low,high})));
// Personality sliders are rendered as three behaviour bands (see companion-voice.mjs);
// values inside one band produce the same prompt. Verbosity alone is continuous.
export const TUNING_BANDS=Object.freeze({low:[0,33],mid:[34,66],high:[67,100]});
export const tuningBand=value=>Number(value)<=33?'low':Number(value)<=66?'mid':'high';
export const TUNING_DEFAULTS=Object.freeze(Object.fromEntries(definitions.map(([key,,,,,value])=>[key,value])));
export const TUNING_PRESETS=Object.freeze([
 {id:'default',label:'温柔自然',values:{...TUNING_DEFAULTS}},
 {id:'pampering',label:'偏爱哄你',values:{...TUNING_DEFAULTS,pleasing:90,warmth:95,sensitivity:60,coyness:60,flirtation:45,independence:30}},
 {id:'bright',label:'活泼甜软',values:{...TUNING_DEFAULTS,pleasing:75,warmth:80,optimism:90,playfulness:90,coyness:65,flirtation:45,initiative:70}},
 {id:'calm',label:'松弛知心',values:{...TUNING_DEFAULTS,pleasing:50,warmth:75,sensitivity:20,playfulness:30,coyness:15,flirtation:15,initiative:30,independence:75,missing:40,clingy:25,loveTalk:40}},
 {id:'in-love',label:'热恋',values:{...TUNING_DEFAULTS,warmth:90,coyness:65,flirtation:70,initiative:75,missing:90,jealousy:50,temper:45,recovery:30,clingy:80,loveTalk:85,stubborn:50}},
]);
const invalid=message=>Object.assign(new Error(message),{status:400,code:'INVALID_COMPANION_TUNING'});
export function validateTuning(patch,base=TUNING_DEFAULTS){
 if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.entries(patch).some(([k,v])=>!Object.hasOwn(TUNING_DEFAULTS,k)||!Number.isInteger(v)||v<0||v>100))throw invalid('参数必须是已知项目的 0–100 整数');
 return Object.fromEntries(Object.keys(TUNING_DEFAULTS).map(key=>[key,patch[key]??base[key]]));
}
export function tuningEffects(v){return{
 maxChars:Math.round(140+v.verbosity*1.6),sensitivityGain:.5+v.sensitivity/100,
 affectionHours:Math.max(4,Math.round(22-v.flirtation*.2)),affectionTurns:Math.max(2,Math.round(8-v.flirtation/15)),
 proactiveGapHours:v.initiative===0?null:Math.round(12*(1-v.initiative/100)**2*10)/10,
 comfortFirst:v.pleasing>=65&&v.warmth>=60,
};}
export function tuningPreview(values){const v=validateTuning(values),effects=tuningEffects(v),hi=key=>tuningBand(v[key])==='high',lo=key=>tuningBand(v[key])==='low';const parts=[];
 parts.push(hi('warmth')?'累了吧，先歇会儿。':lo('warmth')?'累了？':'今天挺累的吧。');
 if(hi('pleasing'))parts.push('今晚照你喜欢的来。');else if(hi('independence'))parts.push('我也有件小事想跟你说，正好换换脑子。');else parts.push('我在呢，你慢慢说。');
 if(hi('playfulness'))parts.push('刚才对着两块色卡纠结半天，差点让杯子替我投票。');
 if(hi('coyness'))parts.push('等你缓过来也分我一点注意力嘛。');
 if(hi('optimism'))parts.push('今天还有点时间，够找件小事开心一下。');
 const bands=TUNING_FIELDS.filter(f=>f.key!=='verbosity').map(f=>`${f.label}${tuningBand(v[f.key])==='high'?'高':tuningBand(v[f.key])==='low'?'低':'中'}`).join('、');
 return{text:parts.slice(0,v.verbosity<30?2:5).join(''),notes:[`除话量外每项分低（0–33）/中（34–66）/高（67–100）三档，同档内数值不改变说话方式。当前：${bands}。`,`话量 ${v.verbosity}：他发几个字时她约回 ${Math.round(8+.3*v.verbosity)} 字，认真聊一件事时约 ${Math.round(25+.9*v.verbosity+15)} 字；明确要求详细内容时可展开。`,lo('flirtation')?'不主动暧昧，你撩的时候再回应。':hi('flirtation')?'会主动撩你、说想你、开暧昧玩笑；是否出现仍看当时聊到哪。':'偶尔撩一下，看语境。',v.initiative===0?'林晓薇停止主动找你；你发消息和明确设置的提醒仍可使用。':effects.proactiveGapHours?`林晓薇两次主动消息至少相隔 ${effects.proactiveGapHours} 小时，同时遵守全局限制。`:'主动程度使用全局联系间隔，不突破全局次数上限。',hi('independence')&&(hi('coyness')||hi('flirtation'))?'独立性、撒娇、暧昧同时打到高档时，文案会互相拉扯，她可能轮流表现；想要“有自己的事但很黏”的感觉，独立性放中档更稳。':'','这是同一场景的本地语气示例，不是实际聊天，也不产生模型费用。'].filter(Boolean)};}
export class CompanionTuningRepository {
 constructor(store){this.store=store;store.db.exec('CREATE TABLE IF NOT EXISTS companion_tuning(role_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,payload TEXT NOT NULL)');}
 get(){const row=this.store.db.prepare("SELECT * FROM companion_tuning WHERE role_id='miyue'").get();const values=validateTuning(row?JSON.parse(row.payload):{});return{roleId:'miyue',revision:row?.revision||0,values,fields:TUNING_FIELDS,presets:TUNING_PRESETS,preview:tuningPreview(values)};}
 set(values,revision){return this.store.transaction(()=>{const current=this.get();if(!Number.isSafeInteger(revision)||revision!==current.revision)throw Object.assign(new Error('设置已在别处更新。请重新载入已保存设置后再修改。'),{status:409,code:'STALE_COMPANION_TUNING'});const next=validateTuning(values,current.values);if(JSON.stringify(next)!==JSON.stringify(current.values))this.store.db.prepare("INSERT INTO companion_tuning VALUES('miyue',?,?) ON CONFLICT(role_id) DO UPDATE SET revision=excluded.revision,payload=excluded.payload").run(revision+1,JSON.stringify(next));return this.get();});}
 context(){const {values:v}=this.get();return['【林晓薇当前可调相处方式】','这些设置替代档案中相应的默认性格强度，人物背景、实际记忆不变。',...TUNING_FIELDS.map(f=>`${f.label} ${v[f.key]}/100：${v[f.key]<35?f.low:v[f.key]>=70?f.high:'适中，自然参与交流'}。${f.description}`),v.pleasing>=70?'更主动偏爱用户，迁就无伤大雅的小偏好，认真夸具体的地方，让相处舒服；不机械说教，也不反复表示“没压力”“你可以不回答”。':'自然交流，支持与不同意见都可以表达。','讨好不等于杜撰事实、盲目认同或贬低自己。用户当前明确要求和相处边界优先；高撒娇或暧昧只是更容易出现，不是每句话都加。'].join('\n');}
 apply(plan,text,innerState=null,preferences={},semantic=null){if(plan.scope!=='miyue')return plan;const {values:v,revision}=this.get(),e=tuningEffects(v);const next={...plan,tuningRevision:revision};
 const lightSemantic=semantic&&typeof semantic==='object'&&semantic.emotionalDetail===false&&new Set(['respond','preference','affection','comfort','acknowledge','close']).has(semantic.intent);
 const detailed=semantic&&Object.hasOwn(semantic,'replyExpansion')?Boolean(semantic.replyExpansion):!lightSemantic&&/详细|展开|长一点|仔细讲|完整解释|多(?:讲|说|聊)一点|具体.{0,5}(?:区别|步骤|原因)/.test(text);
 const discuss=!lightSemantic&&/为什么|怎么(?:做|实现|理解)|解释|分析|区别|步骤|原理/.test(text);
 const share=plan.intent==='share'||/(?:说|聊)(?:说|聊|个|点)?.{0,8}(?:小事|近况|见闻)|你来(?:说|聊|起头)/.test(text)||!String(text).trim();
 next.responseMode=detailed?'detailed':discuss?'discuss':share?'share':'casual';
 next.maxChars=Math.max(plan.anchor?.length||0,detailed?6000:discuss?Math.round(500+v.verbosity*5):share?Math.round(220+v.verbosity*2):e.maxChars);
 if(e.comfortFirst&&/难过|委屈|烦|很累|崩溃|焦虑/.test(text)&&!/建议|怎么办|怎么做|分析|解决/.test(text)){next.noAdvice=true;next.questionBudget=0;next.intent='listen';next.comfortFirst=true;}
 // Explicit saved style preferences win over the continuous sliders.
 if(v.pleasing>=75&&!Object.hasOwn({...preferences,...plan.patch},'lessPraise')&&!/别.*夸|不要.*夸|像客服/.test(text))next.lessPraise=false;
 const invited=/(?:抱抱我|亲亲我|撒个娇|哄哄我|(?:想要|我想|可以|愿意).{0,6}(?:抱抱|亲亲|撒娇|暧昧|亲密))/.test(text)&&!/(?:不要|不想|别|停止).{0,6}(?:抱抱|亲亲|撒娇|暧昧|亲密)/.test(text);
 next.suppressInitiatedAffection=(v.flirtation===0||innerState?.intimacyBoundary==='friendly'||innerState?.affectionAllowed===false)&&!invited;
 return next;
 }
 canInitiate(lastContact,now=new Date()){const v=this.get().values,e=tuningEffects(v);return v.initiative>0&&(!lastContact||+new Date(now)-Date.parse(lastContact)>=e.proactiveGapHours*3600000);}
}
