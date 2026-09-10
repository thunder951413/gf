// Post-hoc v2 experiment. V1 and its saved evidence remain frozen.
import { salience } from '../attention-simulation/attention.mjs';

const HAN = /\p{Script=Han}/u;
const NEG = /(?:别(?:再)?|不要|不用|不想|不愿|不聊|不说|不提|算了|取消|改期|没去|没有去|并非|不是|never|don't|do not|stop|cancel(?:led)?)/iu;
const DURABLE = /(?:取消|改期|不去了|没去成|已经不是|不再|cancel(?:led)?|postpon(?:e|ed))/iu;
const SWITCH = /(?:换个话题|说点别的|聊点别的|先不聊|不说.+了|改聊|聊聊|说说|change (?:the )?subject|let'?s talk)/iu;
const CONTINUE = /(?:接着|继续|刚才|那(?:个|件事)|这(?:个|件事)|你自己的|前面说的)/u;
const QUESTION = /[?？]|^(?:谁|什么|哪|怎么|为何|为什么|是否|能否|how|what|why|when|where|who|is|are|do|can)\b/iu;
const STOP = new Set(['的','了','呢','吗','吧','啊','我','你','他','她','它','这','那','有','在','还','去','来','说','想','听','看','个','件','什么','怎么','怎么样','没有','是不是','能不能','最近','现在','今天','之前','后来','我们','那个','这种','就是','还是','一下','一点','用户','虚构','生活','记录','事情','东西','话题','聊聊','说说','接着','继续','the','a','an','to','of','and','or','is','are','i','you','it','this','that','about','please']);
const clone = x => x == null ? x : structuredClone(x);
const norm = x => String(x ?? '').normalize('NFKC').toLocaleLowerCase().replace(/[\p{P}\p{S}]+/gu,' ').replace(/\s+/g,' ').trim();
const uniq = xs => [...new Set(xs)];
const bare = token => token.slice(2);

function tokens(text) {
  const clean = norm(text); if (!clean) return [];
  const out = [];
  const seg = new Intl.Segmenter(undefined,{granularity:'word'});
  for (const x of seg.segment(clean)) if (x.isWordLike && x.segment.length > 1 && !STOP.has(x.segment)) out.push(`w:${x.segment}`);
  // Segmenter often emits proper names as one-character words. Build grams
  // from the original uninterrupted Han run so 成都/合肥 survive that split.
  for (const run of clean.match(/\p{Script=Han}+/gu) || []) {
    const chars = [...run];
    for (const ch of chars) if (!STOP.has(ch)) out.push(`h:${ch}`);
    for (let i=0;i+1<chars.length;i++) { const gram=chars[i]+chars[i+1]; if (!STOP.has(gram)) out.push(`c:${gram}`); }
  }
  for (const word of clean.match(/[a-z0-9][a-z0-9_-]+/g) || []) if (!STOP.has(word)) out.push(`w:${word}`);
  return out;
}

const memoryText = m => [m.topic,...(m.keywords||[]),m.text].join(' ');
const freq = xs => { const r=new Map(); for(const x of xs) r.set(x,(r.get(x)||0)+1); return r; };

function rank(memories, query) {
  const q=uniq(tokens(query)), docs=memories.map(m=>tokens(memoryText(m))), n=Math.max(1,memories.length);
  const avg=docs.reduce((s,d)=>s+d.length,0)/n||1, df=new Map();
  for(const d of docs) for(const t of new Set(d)) df.set(t,(df.get(t)||0)+1);
  const rows=new Map();
  for(let i=0;i<memories.length;i++) {
    const f=freq(docs[i]); let score=0; const hits=[];
    for(const t of q) { const count=f.get(t)||0; if(!count) continue; hits.push(t); const idf=Math.log(1+(n-(df.get(t)||0)+.5)/((df.get(t)||0)+.5)); score+=idf*(count*2.2)/(count+1.2*(.25+.75*docs[i].length/avg)); }
    const qNorm=norm(query);
    const keywordHits=(memories[i].keywords||[]).map(norm).filter(k=>k && !STOP.has(k) && (k.length>1||HAN.test(k)) && qNorm.includes(k));
    const rareHits=hits.filter(t=>!t.startsWith('h:') && !STOP.has(bare(t)) && (df.get(t)||n)<=Math.max(2,Math.floor(n*.25)));
    const contentQ=q.filter(t=>!t.startsWith('h:')&&!STOP.has(bare(t)));
    const coverage=hits.filter(t=>!t.startsWith('h:')).length/Math.max(1,contentQ.length);
    const supported=keywordHits.length>0||rareHits.length>0||coverage>=.45;
    rows.set(memories[i].id,{score:supported?score:0,supported,hits,keywordHits,rareHits,coverage});
  }
  return {rows,queryTokens:q};
}

function clauses(memories,text) {
  const parts=String(text??'').split(/[，,。；;？！?!]|\b(?:but|however|instead)\b|(?:但是|不过|然后|转而)/iu).map(x=>x.trim()).filter(Boolean);
  const negative=parts.filter(x=>NEG.test(x)), positive=parts.filter(x=>!NEG.test(x));
  const positiveRank=rank(memories,positive.join(' ')), negativeTopics=new Set();
  for(const part of negative){const r=rank(memories,part);for(const m of memories)if(r.rows.get(m.id)?.supported)negativeTopics.add(m.topic);}
  return {positiveRank,negativeTopics,negative,positive};
}

function duplicate(a,b){const A=new Set(tokens(a.text)),B=new Set(tokens(b.text));if(norm(a.text)===norm(b.text))return true;let hit=0;for(const x of A)if(B.has(x))hit++;return hit/Math.max(1,Math.min(A.size,B.size))>=.84;}
function substantive(x){return norm(x).length>=4&&tokens(x).length>0;}
function rng(seed){let s=(seed>>>0)||0x9e3779b9;return()=>{s^=s<<13;s^=s>>>17;s^=s<<5;return(s>>>0)/2**32;};}
function pub(m,score,strength,lexicalScore){return{...clone(m),score,strength,lexicalScore};}

export class AttentionMemory {
  constructor({memories=[],halfLife=3,maxChars=1200,seed=42}={}){
    this.halfLife=halfLife;this.maxChars=maxChars;this.seed=seed>>>0;this._rand=rng(this.seed);
    this._memories=clone(memories).map((m,i)=>({mentions:[],exposures:[],type:'user',base:8,...m,id:String(m.id??`memory-${i+1}`),keywords:clone(m.keywords||[]),mentions:clone(m.mentions||[]),exposures:clone(m.exposures||[])}));
    this._turns=[];this._focus=[];this._blocks=[];this._next=1;this._last={assessments:[],uncertainExposure:false,episodicStored:false};
  }
  observeUser({text,day,turnId}={}){
    const raw=String(text??''),id=String(turnId??`user-${this._turns.length+1}`),eligible=this._memories.filter(m=>m.born<=day&&!m.superseded),a=clauses(eligible,raw);
    const matched=eligible.filter(m=>a.positiveRank.rows.get(m.id)?.supported).sort((x,y)=>a.positiveRank.rows.get(y.id).score-a.positiveRank.rows.get(x.id).score);
    const blocked=[...a.negativeTopics].slice(0,3),negative=a.negative.length>0;
    if(negative){const until=day+(DURABLE.test(raw)?30:3);for(const topic of blocked)this._blocks.push({topic,at:day,until,turnId:id,reason:DURABLE.test(raw)?'correction-or-cancellation':'scoped-refusal'});}
    const seen=new Set();for(const m of matched.slice(0,4)){if(seen.has(m.topic))continue;m.mentions.push({at:day,who:'user',turn:id});seen.add(m.topic);}
    if(matched.length){this._focus.unshift({day,turnId:id,topics:uniq(matched.slice(0,2).map(m=>m.topic))});this._focus=this._focus.slice(0,6);}
    if(SWITCH.test(raw))this._focus=matched.length?[{day,turnId:id,topics:uniq(matched.slice(0,2).map(m=>m.topic))}]:[];
    this._turns.push({role:'user',text:raw,day,turnId:id});
    if(substantive(raw))this._memories.push({id:`observed-user-${this._next++}`,topic:matched[0]?.topic||blocked[0]||`utterance:${id}`,text:raw,born:day,base:QUESTION.test(raw)?2:4,mentions:[],exposures:[],type:'user',recordKind:'user_utterance',asserted:!QUESTION.test(raw),sourceTurnId:id});
    return{matchedIds:matched.map(m=>m.id),blockedTopics:blocked,negative,switched:SWITCH.test(raw),storedRaw:substantive(raw)};
  }
  select({text='',day,mode='reply',maxItems=5}={}){
    const supplied=String(text??''),raw=mode==='proactive'?supplied:supplied||[...this._turns].reverse().find(t=>t.role==='user')?.text||'',current=[...this._turns].reverse().find(t=>t.role==='user'&&t.text===raw)?.turnId;
    const candidates=this._memories.filter(m=>m.born<=day&&!m.superseded&&!(current&&m.sourceTurnId===current)),a=clauses(candidates,raw),blocked=new Set(this._blocks.filter(b=>b.at<=day&&day<=b.until).map(b=>b.topic));
    const recent=uniq(this._focus.filter(f=>f.day<=day&&day-f.day<=7).slice(0,3).flatMap(f=>f.topics)).slice(0,2),followup=raw.length<=48&&CONTINUE.test(raw),rows=[];
    for(const m of candidates){if(mode==='proactive'&&blocked.has(m.topic))continue;const e=a.positiveRank.rows.get(m.id),lex=e?.score||0,focus=followup&&recent.includes(m.topic);if(mode==='reply'&&(!lex&&!focus||a.negativeTopics.has(m.topic)))continue;const strength=salience(m,day,{halfLife:this.halfLife,mentionHalfLife:this.halfLife});let score=strength+lex*12+(focus?9:0);const exp=m.exposures.filter(x=>x<=day),last=exp.length?Math.max(...exp):-Infinity;if(mode==='proactive'){if(strength<1.5)continue;score*=Math.max(.08,(1-(Number.isFinite(last)?.8*2**(-(day-last)/4):0))/Math.sqrt(1+exp.length));}if(m.recordKind==='user_utterance'&&m.asserted===false)score*=.12;rows.push({m,score,strength,lex,e});}
    // A prior question is context, not answer evidence, when a supported stored
    // fact from the same topic is available.
    const facts=new Set(rows.filter(r=>!(r.m.recordKind==='user_utterance'&&r.m.asserted===false)).map(r=>r.m.topic));
    let ranked=rows.filter(r=>!(r.m.recordKind==='user_utterance'&&r.m.asserted===false&&facts.has(r.m.topic)));
    ranked.sort((x,y)=>y.score-x.score||x.m.id.localeCompare(y.m.id));if(mode==='proactive'&&ranked.length>1){const top=ranked[0].score;for(const r of ranked.filter(x=>x.score>=top*.88))r.score*=.97+this._rand()*.06;ranked.sort((x,y)=>y.score-x.score||x.m.id.localeCompare(y.m.id));}
    const selected=[],counts=new Map();let chars=0;for(const r of ranked){if(selected.length>=Math.max(0,maxItems))break;if(chars+r.m.text.length>this.maxChars||(counts.get(r.m.topic)||0)>=2||selected.some(x=>duplicate(x,r.m)))continue;selected.push(pub(r.m,r.score,r.strength,r.lex));counts.set(r.m.topic,(counts.get(r.m.topic)||0)+1);chars+=r.m.text.length;}
    return{selected,diagnostics:{lexicalOnly:true,semanticGuarantee:false,postHocVersion:2,queryPreserved:raw,queryTokens:a.positiveRank.queryTokens,followupFallback:followup,recentFocus:recent,activeBlocks:[...blocked],negativeClauseTopics:[...a.negativeTopics],eligibleCount:candidates.length,rankedCount:ranked.length,selectedChars:chars,charBudget:this.maxChars,uncertainExposure:this._last.uncertainExposure}};
  }
  observeAssistant({text,day,turnId,selectedIds=[]}={}){
    const raw=String(text??''),ids=new Set(selectedIds.map(String)),assessments=[];for(const m of this._memories){if(!ids.has(m.id))continue;const e=rank([m],raw).rows.get(m.id),used=Boolean(e?.supported&&(e.keywordHits.length||e.rareHits.length||e.coverage>=.45));if(used)m.exposures.push(day);assessments.push({id:m.id,used,basis:used?'distinctive-lexical-overlap':'uncertain-no-exposure-recorded'});}
    const tid=String(turnId??`assistant-${this._turns.length+1}`),topics=uniq(assessments.filter(x=>x.used).map(x=>this._memories.find(m=>m.id===x.id)?.topic).filter(Boolean));if(topics.length){this._focus.unshift({day,turnId:tid,topics:topics.slice(0,2),source:'assistant-supported-use'});this._focus=this._focus.slice(0,6);}this._turns.push({role:'assistant',text:raw,day,turnId:tid,selectedIds:[...ids]});this._last={assessments,uncertainExposure:assessments.some(x=>!x.used),episodicStored:false,extractionSkipped:'assistant self-experience/source verification is unsafe without provenance'};return clone(this._last);
  }
  snapshot(day){const focus=clone(this._focus.filter(f=>f.day<=day&&day-f.day<=7));return{day,memories:this._memories.map(m=>{const s=salience(m,day,{halfLife:this.halfLife,mentionHalfLife:this.halfLife});return pub(m,s,s,0);}),futureCount:this._memories.filter(m=>m.born>day).length,recentFocus:focus,focus,activeBlocks:clone(this._blocks.filter(b=>b.at<=day&&day<=b.until)),lastAssistantDiagnostics:clone(this._last),limitations:['lexical matching is not semantic understanding','synonym and entailment gaps remain','assistant experience extraction is disabled without provenance']};}
}
