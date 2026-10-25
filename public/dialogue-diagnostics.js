const $=selector=>document.querySelector(selector);let data;
const node=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const date=value=>value?new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'时间未提供';
async function api(url,body){const response=await fetch(url,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const value=await response.json();if(!response.ok)throw new Error(value.error?.message||value.error||'读取失败');return value;}
function details(label,value){const d=node('details');d.append(node('summary',label),node('pre',JSON.stringify(value,null,2)));return d;}
function card(title,text,subtitle,evidence=[]){const c=node('article',undefined,'evidence-card');c.append(node('strong',title),node('p',text),node('small',subtitle));if(evidence.length)c.append(details('查看原话出处',evidence));return c;}
function renderHistory(){const query=$('#history-filter').value.trim();const rows=data.history.rows.filter(r=>!query||r.text.includes(query)).slice(-150).reverse();$('#history').replaceChildren(...rows.map(r=>{const c=card(r.authorName,r.text,`${date(r.at)} · ${r.kind==='proactive'?'主动联系':'对话'} · ${r.id}`);c.classList.add(r.speaker);return c;}));if(!rows.length)$('#history').append(node('p','这个窗口没有匹配的原话。'));}
function renderTrace(){const trace=data.traces.find(t=>t.id===$('#trace-select').value);const box=$('#trace');box.replaceChildren();if(!trace){box.append(node('p','还没有可展示的对话诊断。'));return;}
  box.append(node('p',`${date(trace.createdAt)} · ${trace.outcome.status} · 总耗时 ${((trace.stageTimings.total||0)/1000).toFixed(1)} 秒 · ${(trace.calls||[]).length} 次模型调用`));
  const calls=(trace.calls||[]).map(call=>({...call,reportedTokens:call.usage?.total_tokens??'未知'}));
  box.append(details('原文作者与消息顺序',trace.history),details('本轮状态版本',trace.revisions),details('晨间整理检查',trace.morningMemory),details('历史召回的来源与取舍',trace.retrieval),details('工具执行回执',trace.toolResults),details('生成提示与回复检查',{guidance:trace.guidance,review:trace.review}),details('每次调用的耗时与用量',calls));
}
function render(){
  $('#status').textContent=`${data.role.name} · 更新于 ${date(new Date())} · 较早历史可由召回工具查询`;
  $('#history-notice').textContent=data.history.notice||'';$('#index').hidden=!data.retrieval.embeddingConfigured;
  const metrics=[['窗口内原话',data.history.rows.length],['成长倾向',data.growth.items.length],['主观日记',data.growth.reflections.length],['历史检索',data.retrieval.embeddingConfigured?'词义与向量':data.retrieval.semanticQuery?'原文与词义展开':'原文']];
  $('#summary').replaceChildren(...metrics.map(([label,value])=>{const e=node('div',undefined,'metric');e.append(node('small',label),node('strong',value));return e;}));renderHistory();
  const growth=[...data.growth.items.map(i=>card(`${({interest:'兴趣',view:'看法',habit:'表达习惯'})[i.kind]} · ${i.tier==='stable'?'稳定倾向':'探索中'}`,i.text,date(i.at),i.evidence)),...data.growth.reflections.slice(0,8).map(i=>card('日记 · 角色主观反思',i.text,date(i.at),i.evidence))];
  $('#growth').replaceChildren(...(growth.length?growth:[node('p','还没有达到反思条件，或没有可保存的有据变化。')]));
  const dynamics=['needs','feelings','threads'].flatMap(kind=>data.dynamics[kind].map(i=>card(i.label||i.subject,i.description||i.progress,`${i.status||'当前感受'} · ${date(i.updatedAt)}`)));
  $('#dynamics').replaceChildren(...(dynamics.length?dynamics:[node('p','没有保存中的感受或未完话题。')]));
  $('#memories').replaceChildren(...(data.memory.items.length?data.memory.items.map(i=>card(i.topic||i.kind,i.summary,`${i.subject} · ${i.status}`,i.evidence)):[node('p','还没有结构化记忆。')]));
  const daily=data.dailyMemory;
  $('#compression-status').textContent=daily?`${daily.settings.enabled?'当日原文 · 每天 '+daily.settings.time+'（北京时间）整理，02:00后交互前补齐':'按日整理已关闭'} · 已整理 ${daily.sourceMessages} 条 · 核心文字 ${daily.coreChars} / 原文 ${daily.sourceChars} 字符 · 待整理 ${daily.pendingMessages} 条，交互前需补齐 ${daily.requiredMessages??0} 条。${daily.lastError||''}`:'';
  const compressed=daily?.chunks.flatMap(chunk=>chunk.items.map(item=>card(`${chunk.day} · ${item.subject} · ${item.kind}`,item.text,item.status,item.evidence)))||[];
  $('#compression').replaceChildren(...(compressed.length?compressed:[node('p','还没有通过核对的按日核心记录，原文仍保留。')]));
  $('#trace-select').replaceChildren(...data.traces.map(t=>{const o=node('option',`${date(t.createdAt)} · ${t.trigger.type} · ${t.outcome.status}`);o.value=t.id;return o;}));renderTrace();
}
async function refresh(){data=await api('/api/dialogue-diagnostics');render();}
const action=fn=>async event=>{const control=event.currentTarget;control.disabled=true;try{await fn();}catch(error){$('#status').textContent=error.message;}finally{control.disabled=false;}};
$('#refresh').addEventListener('click',action(refresh));$('#history-filter').addEventListener('input',renderHistory);$('#trace-select').addEventListener('change',renderTrace);
$('#index').addEventListener('click',action(async()=>{const r=await api('/api/recall/index',{});$('#status').textContent=`语义索引：${r.indexed} / ${r.total} 条；原文检索始终覆盖全部可见历史。`;}));
$('#fork').addEventListener('click',action(async()=>{const b=await api('/api/session/branch',{});$('#branch').hidden=false;$('#branch-command').textContent=b.command;$('#status').textContent='隔离分支已保存。'}));
$('#reflect').addEventListener('click',action(async()=>{const result=await api('/api/character-growth/reflect',{});await refresh();$('#status').textContent=result.status==='recorded'?(result.accepted.length?'反思已整理；通过原话核验的记录已保存。':'本次没有可保存的有据变化；原记录保留。'):result.status==='busy'?'当前仍在对话，请稍后再整理。':'暂时没有足够的新原话。';}));
refresh().catch(error=>{$('#status').textContent=error.message;});
