// Transport labels are presentation metadata, not conversational errors. Keep
// this pass independent of semantic/style filters so it cannot delete an answer.
const TIME=/^(?:【(?:历史消息[·:]?)?\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2})?】|\[(?:历史消息[·:]?)?\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2})?\])/u;
const LABEL=/^【(?:本轮回复|回复正文|本轮回答|本轮对话|本轮)】/u;
const LITERAL_REQUEST=/(?:原样|逐字|照抄|一字不改|原文|代码|日志|转义|时间标签|时间戳|历史消息|本轮回复|本轮回答|本轮对话)/u;
const QUOTES=new Map([['“','”'],['‘','’'],['「','」'],['『','』']]);
export function normalizeReplyPresentation(value,{currentText='',preservePresentation=false}={}){
 const source=String(value??'');
 if(preservePresentation||LITERAL_REQUEST.test(String(currentText)))return{reply:source,repairs:[]};
 const timeOnly=source.trim().match(TIME);
 if(timeOnly?.[0]===source.trim()&&!source.includes('历史消息')&&/(?:几号|几点|日期|时间|星期|周几)/u.test(String(currentText)))return{reply:source,repairs:[]};
 const repairs=new Set(),quotes=[];let fence=null,inlineTicks=0,output='';
 for(const line of source.match(/[^\n]*\n|[^\n]+$/gu)||[]){
  const fenceMatch=line.match(/^ {0,3}(`{3,}|~{3,})(.*)/u);
  if(fence){
   output+=line;
   if(fenceMatch&&fenceMatch[1][0]===fence.char&&fenceMatch[1].length>=fence.length&&!fenceMatch[2].trim())fence=null;
   continue;
  }
  if(fenceMatch&&!quotes.length&&!inlineTicks){fence={char:fenceMatch[1][0],length:fenceMatch[1].length};output+=line;continue;}
  let rendered=line;
  if(!quotes.length&&!inlineTicks&&!/^(?: {4}|\t)/u.test(line)){
   const indent=line.match(/^[ \t]*/u)[0];let body=line.slice(indent.length),changed=false;
   for(;;){
    const time=body.match(TIME),label=body.match(LABEL),match=time||label;if(!match)break;
    repairs.add(time?'removed_history_timestamp':'removed_reply_label');
    body=body.slice(match[0].length).replace(/^[ \t]*/u,'');changed=true;
   }
   // A line containing only a transport label contributes no paragraph of prose.
   if(changed)rendered=body.trim()?indent+body:'';
  }
  output+=rendered;
  for(let i=0;i<line.length;i++){
   const c=line[i];if(c==='\\'){i++;continue;}
   if(c==='`'){let n=1;while(line[i+n]==='`')n++;if(!inlineTicks)inlineTicks=n;else if(inlineTicks===n)inlineTicks=0;i+=n-1;continue;}
   if(inlineTicks)continue;
   if(quotes.at(-1)===c){quotes.pop();continue;}
   if(QUOTES.has(c)){quotes.push(QUOTES.get(c));continue;}
   if(c==='"'||(c==="'"&&!/[\p{L}\p{N}]/u.test(line[i-1]||'')))quotes.push(c);
  }
 }
 // A decoration-only draft still needs the normal empty-body error path.
 return{reply:output,repairs:[...repairs]};
}
