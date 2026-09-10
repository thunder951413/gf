// Explicit recall is a read-only lookup of actual user messages, independent of
// the conversational callback cooldown and without an extra model request.
export function lookupUserEvidence(store,episodes,scope,text,{limit=3,charBudget=700}={}){
 if(!/记得|我(?:之前|以前|上次).{0,6}(?:说|提)|我在哪|我喜欢怎么/.test(text))return{rows:[],context:''};
 const stop=new Set(['记得','还记','你还','得我','喜欢','怎么','之前','在哪','哪个','城市','我在','可以','什么']);const query=new Set();
 for(const run of String(text).match(/[\p{Script=Han}]+/gu)||[])for(let i=0;i<run.length-1;i++)if(!stop.has(run.slice(i,i+2)))query.add(run.slice(i,i+2));
 const suppressed=new Set(episodes.suppressedSourceIds(scope));
 const rows=store.db.prepare("SELECT id,text,created_at FROM recall_messages WHERE role=? AND speaker='user' ORDER BY rowid DESC LIMIT 1000").all(scope).filter(r=>!suppressed.has(r.id));
 const frequency=new Map([...query].map(token=>[token,rows.filter(r=>r.text.includes(token)).length]));
 const ranked=rows.map((r,index)=>{let score=0;for(const token of query)if(r.text.includes(token))score+=1/Math.sqrt(frequency.get(token));if(/城市|我在哪|住哪/.test(text)&&/我(?:现在)?(?:在|住在|住)|我这边是/.test(r.text))score+=1;return{...r,index,score};}).filter(r=>r.score>0).sort((a,b)=>b.score-a.score||a.index-b.index);
 const selected=[];let used=0;for(const r of ranked){if(selected.length>=limit)break;const line=`用户原话（${r.created_at}，消息${r.id}）：${r.text}`;if(used+line.length>charBudget)continue;selected.push({...r,line});used+=line.length;}
 return{rows:selected.map(({id,text,created_at})=>({id,text,createdAt:created_at})),context:selected.length?'【本轮按用户请求核对的历史原话】\n'+selected.map(r=>r.line).join('\n')+'\n只回答原话实际包含的内容；缺项说没找到，不把核对记忆解释成考验或害怕被忘记。':''};
}
