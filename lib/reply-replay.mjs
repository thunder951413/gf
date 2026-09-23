// Exact copying is a different signal from topical similarity. A continuation
// may reuse facts, but does not automatically authorize replaying whole replies
// or speaking the user's utterance as the character. No prose is deleted here.
const norm=value=>String(value||'').replace(/[\s\p{P}\p{S}]/gu,'');
const sentences=value=>(String(value||'').match(/[^。！？!?；;\n]+[。！？!?；;]*/gu)||[]).map(s=>s.trim()).filter(Boolean);
const literalRequest=text=>!/(?:不要|别|不用|不必|停止).{0,5}(?:复述|重复|照抄|引用|回顾|总结|概括)/u.test(text)
 && /(?:原样|逐字|照抄|一字不改|复述|原话|原文|再说一遍|重复一遍|重复一下|翻译|朗读|润色|改写|引用|总结|回顾|概括)/u.test(text);
const quoted=text=>/[“”「」『』"`]|^\s*>/u.test(text);
const prose=value=>String(value||'').replace(/```[\s\S]*?```|~~~[\s\S]*?~~~|“[^”]*”|「[^」]*」|『[^』]*』|"[^"\n]*"|`[^`\n]*`/gu,'\n');

export function replyReplayPlan({userText='',conversation=[],now=new Date()}={}){
 const at=+new Date(now),min=at-7*24*3600000;
 const history=[];
 for(const row of conversation.slice(-800)){
  if(row.speaker!=='assistant')continue;
  const time=Date.parse(row.createdAt||row.created_at||'');
  if(Number.isFinite(time)&&(time<min||time>at))continue;
  history.push(...sentences(prose(row.text)).filter(s=>!quoted(s)).map(norm).filter(s=>s.length>=12));
 }
 return {userText,allowLiteral:literalRequest(userText),sentences:[...new Set(history)]};
}

export function replyReplayIssues(reply,plan={}){
 if(plan.allowLiteral)return [];
 const issues=[],parts=sentences(reply),first=parts[0];
 const user=norm(plan.userText);
 // Only a complete, substantial current utterance at the opening qualifies.
 // Short acknowledgements, a quotation, and partial thematic overlap do not.
 if(first&&!quoted(first)&&user.length>=16&&norm(first)===user)issues.push('copied_user_utterance');
 const previous=new Set(plan.sentences||[]),matches=new Set();
 for(const part of sentences(prose(reply))){const value=norm(part);if(!quoted(part)&&value.length>=12&&previous.has(value))matches.add(value);}
 // One factual sentence can be necessary to answer a follow-up. Require a
 // substantial multi-sentence replay, rather than penalizing that continuity.
 const copied=[...matches].reduce((n,s)=>n+s.length,0),total=norm(reply).length;
 if(matches.size>=2&&copied>=60&&copied>=total*.5)issues.push('verbatim_reply_replay');
 return issues;
}
