const modeLabels = {steady:'平稳',warm:'温和安心',playful:'轻快有玩心',vulnerable:'有些敏感',stressed:'有点压力',resting:'想慢下来',attentive:'更想听你说',low:'有点低落'};
const groups = [['relationship','关系与亲近'],['emotion','心情与需要'],['body','精力与身体']];

// Drafts survive other cards saving and stale-write refreshes. Only changed
// fields are sent, so an untouched slider cannot overwrite natural evolution.
export function createCompanionStateEditor({api,node,button,action,toast,onSaved,onTuning}) {
  let current, draft=null, saving=false, conflict=false, notice='';
  const normalizedNeed=value=>String(value??'').trim();
  const changedValues=()=>draft?Object.fromEntries(Object.entries(draft.values).filter(([key,value])=>value!==draft.base.values[key])):{};
  const changedNeeds=()=>draft?Object.fromEntries(Object.entries(draft.needs).filter(([key,value])=>value!==normalizedNeed(draft.base.needs[key]))):{};
  const changedNeedCycle=()=>draft?Object.fromEntries(Object.entries(draft.needCycle).filter(([key,value])=>value!==draft.base.needCycle[key])):{};
  const changeCount=()=>Object.keys(changedValues()).length+Object.keys(changedNeeds()).length+Object.keys(changedNeedCycle()).length;
  const valid=()=>Object.values(changedValues()).every(value=>Number.isInteger(value)&&value>=0&&value<=100)&&Object.values(changedNeeds()).every(value=>value.length<=160)&&Object.entries(changedNeedCycle()).every(([key,value])=>{
    const schema=current?.needCycleFields?.find(field=>field.key===key);if(schema?.type==='boolean'||key==='enabled')return typeof value==='boolean';
    return Number.isInteger(value)&&value>=(schema?.min??0)&&value<=(schema?.max??Number.MAX_SAFE_INTEGER);
  });
  const date=value=>new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
  function redraw(){const old=document.querySelector('#companion-state-editor');if(old)old.replaceWith(render(current));}
  function controls(){const root=document.querySelector('#companion-state-editor');if(!root)return;const count=changeCount();root.querySelector('[data-state-save]').disabled=saving||conflict||!count||!valid();root.querySelector('[data-state-status]').textContent=saving?'正在保存…':conflict?'状态已在别处修改。草稿仍保留，请重新读取最新状态后调整。':notice||(count?`已调整 ${count} 项，尚未保存`:'当前状态已保存');}
  async function save(){
    if(saving||conflict||!changeCount()||!valid())return;
    saving=true;notice='';redraw();
    try{const values=changedValues(),needs=changedNeeds(),needCycle=changedNeedCycle(),body={revision:draft.revision};if(Object.keys(values).length)body.values=values;if(Object.keys(needs).length)body.needs=needs;if(Object.keys(needCycle).length)body.needCycle=needCycle;const snapshot=await api('/api/companionship/inner',{method:'POST',body});current=snapshot.inner;draft=null;conflict=false;notice='已保存，将用于接下来的回复与主动交流。';onSaved(snapshot);toast('她的当前状态已保存。');}
    catch(error){if(error.status===409){conflict=true;notice='状态已在别处修改。你的草稿仍保留，请重新读取最新状态后调整。';}else notice=`保存失败，调整仍保留：${error.message}`;}
    finally{saving=false;redraw();}
  }
  async function reload(){if(saving)return;const snapshot=await api('/api/companionship');draft=null;conflict=false;notice='已重新读取最新状态。';current=snapshot.inner;onSaved(snapshot);redraw();}
  function render(snapshot){
    current=snapshot;
    const root=node('section','settings-card companionship-card companion-state-editor');root.id='companion-state-editor';root.setAttribute('aria-busy',String(saving));
    root.append(node('h3','','她的状态'),node('p','fine-print','调整此刻的感受与亲近倾向。保存后仍会随相处和时间自然变化；喜欢程度缓慢积累，不因你暂时没回复而下降。'));
    if(!snapshot){root.append(node('p','','状态暂时不可用，请刷新。'));return root;}
    const count=changeCount(),snapshotNeeds=Object.fromEntries(Object.entries(snapshot.needs||{}).map(([key,value])=>[key,normalizedNeed(value)])),snapshotNeedCycle={...(snapshot.needCycle||{})};
    if(!draft||!count)draft={revision:snapshot.revision,base:{values:{...snapshot.values},needs:{...snapshotNeeds},needCycle:{...snapshotNeedCycle}},values:{...snapshot.values},needs:{...snapshotNeeds},needCycle:{...snapshotNeedCycle}};
    else if(draft.revision!==snapshot.revision)conflict=true;
    const summary=node('div','state-summary');summary.append(node('span','badge',modeLabels[snapshot.mode]||'当前感受'),node('span','',snapshot.feeling),node('p','fine-print',snapshot.wish));root.append(summary);
    const needFields=snapshot.needFields||[];
    if(needFields.length){
      const section=node('div','state-group');section.append(node('h4','','此刻的需要与愿望'),node('p','fine-print','这些写的是她此刻的个人愿望，不是你已经做过的行动。你写下的愿望会保留，直到你修改或清空；保存不代表会自动实现。'));
      const grid=node('div','need-fields');
      for(const schema of needFields){
        const box=node('div','need-field'),name=node('label','',schema.label),area=node('textarea','state-need');area.id=`inner-need-${schema.key}`;area.maxLength=160;area.rows=3;area.value=draft.needs[schema.key]??'';area.disabled=saving;area.setAttribute('aria-describedby',`inner-need-help-${schema.key}`);name.htmlFor=area.id;
        const help=node('p','fine-print',schema.description||'');help.id=`inner-need-help-${schema.key}`;
        const update=()=>{draft.needs[schema.key]=normalizedNeed(area.value);notice='';area.setAttribute('aria-invalid',String(draft.needs[schema.key].length>160));controls();};
        area.addEventListener('input',update);box.append(name,help,area);
        if(schema.examples?.length){const examples=node('div','need-examples');examples.append(node('span','fine-print','示例：'));for(const example of schema.examples){const fill=button(example,'need-example',()=>{area.value=example;update();area.focus();});fill.disabled=saving;examples.append(fill);}box.append(examples);}
        grid.append(box);
      }
      section.append(grid);root.append(section);
    }
    const order=['affection','affectionNeed','desire','mood','security','stress','playfulness','vitality','fatigue','hunger'];
    const fields=[...snapshot.fields].sort((a,b)=>order.indexOf(a.key)-order.indexOf(b.key));
    for(const [group,label] of groups){
      const section=node('div','state-group');section.append(node('h4','',label));const grid=node('div','tuning-fields');
      for(const schema of fields.filter(item=>item.group===group)){
        const displayLabel=schema.key==='affectionNeed'?'情感需要':schema.key==='desire'?'身体亲近':schema.label;
        const box=node('div','tuning-field'),heading=node('div','tuning-field-heading'),name=node('label','',displayLabel);name.htmlFor=`inner-state-${schema.key}`;
        const number=node('input','state-number');number.type='number';number.min='0';number.max='100';number.step='1';number.value=String(draft.values[schema.key]);number.setAttribute('aria-label',`${displayLabel}数值`);number.disabled=saving;
        heading.append(name,number);const range=node('input','state-range');range.type='range';range.id=`inner-state-${schema.key}`;range.min='0';range.max='100';range.step='1';range.value=String(draft.values[schema.key]);range.disabled=saving;range.setAttribute('aria-label',displayLabel);
        const update=(source)=>{const value=source.value===''?NaN:Number(source.value);draft.values[schema.key]=value;notice='';if(source===range)number.value=range.value;else if(Number.isFinite(value))range.value=String(value);number.setAttribute('aria-invalid',String(!Number.isInteger(value)||value<0||value>100));controls();};
        range.addEventListener('input',()=>update(range));number.addEventListener('input',()=>update(number));
        box.append(heading,node('p','fine-print',schema.description),range);grid.append(box);
      }
      if(grid.children.length){section.append(grid);root.append(section);}
    }
    if(snapshot.needCycleFields?.length){
      const section=node('div','state-group need-cycle-settings');section.append(node('h4','','亲近需要的自然增长'),node('p','fine-print','分别设置从 0 到满的时间、主动阈值和回应后的固定回落。想每天最多表达一次，可把主动间隔设为 24 小时。达到阈值后仍遵守睡眠、免打扰和全局联系间隔。'));
      if(snapshot.needCycleStatus){
        const statusGrid=node('div','tuning-fields');
        for(const key of ['emotional','physical']){const item=snapshot.needCycleStatus[key];if(!item)continue;const box=node('div','tuning-field'),heading=node('div','tuning-field-heading');heading.append(node('span','',item.label||key),node('span','badge',item.status||''));const progress=node('progress','state-range');progress.max=100;progress.value=Number(item.value)||0;progress.setAttribute('aria-label',`${item.label||key} ${progress.value}`);box.append(heading,progress);if(typeof item.due==='string')box.append(node('p','fine-print',item.due));if(item.nextEligibleAt)box.append(node('p','fine-print',`预计最早满足条件：${date(item.nextEligibleAt)}`));statusGrid.append(box);}
        if(statusGrid.children.length)section.append(statusGrid);
        if(snapshot.needCycleStatus.awaitingReply)section.append(node('p','fine-print','正在等待你的回复，增长计时暂不重复触发。'));
      }
      const grid=node('div','tuning-fields');
      for(const schema of snapshot.needCycleFields){
        const box=node('div','tuning-field'),name=node('label','',schema.label);name.htmlFor=`need-cycle-${schema.key}`;
        if(schema.type==='boolean'||schema.key==='enabled'){
          const input=node('input','');input.type='checkbox';input.id=`need-cycle-${schema.key}`;input.checked=Boolean(draft.needCycle[schema.key]);input.disabled=saving;input.addEventListener('change',()=>{draft.needCycle[schema.key]=input.checked;notice='';controls();});
          const heading=node('div','tuning-field-heading');heading.append(name,input);box.append(heading,node('p','fine-print',schema.description||''));
        }else{
          const heading=node('div','tuning-field-heading'),input=node('input','state-number');input.type='number';input.id=`need-cycle-${schema.key}`;input.min=String(schema.min);input.max=String(schema.max);input.step=String(schema.step||1);input.value=String(draft.needCycle[schema.key]);input.disabled=saving;input.setAttribute('aria-label',`${schema.label}数值`);heading.append(name,input);input.addEventListener('input',()=>{const value=input.value===''?NaN:Number(input.value);draft.needCycle[schema.key]=value;notice='';input.setAttribute('aria-invalid',String(!Number.isInteger(value)||value<schema.min||value>schema.max));controls();});box.append(heading,node('p','fine-print',schema.description||''));
        }
        grid.append(box);
      }
      section.append(grid);root.append(section);
    }
    const footer=node('div','state-editor-actions'),saveButton=button('保存状态','primary-button',action(save));saveButton.dataset.stateSave='';saveButton.disabled=saving||conflict||!changeCount()||!valid();
    const reloadButton=button('重新读取（放弃未保存调整）','text-button',action(reload));reloadButton.disabled=saving;
    footer.append(saveButton,reloadButton);root.append(footer);
    const status=node('p','fine-print',saving?'正在保存…':conflict?'状态已在别处修改。草稿仍保留，请重新读取最新状态后调整。':notice||(changeCount()?'有调整尚未保存':'当前状态已保存'));status.dataset.stateStatus='';status.setAttribute('role','status');root.append(status);
    root.append(button('调整长期性格与相处偏好 ↗','text-button',action(onTuning)));
    if(snapshot.journal?.length){const details=node('details','state-history');details.append(node('summary','','最近的状态变化'));for(const entry of snapshot.journal.slice(-5).reverse()){const changes=Object.entries(entry.changes||{}).map(([key,value])=>`${key==='affectionNeed'?'情感需要':key==='desire'?'身体亲近':fields.find(field=>field.key===key)?.label||key} ${value>0?'+':''}${value}`).join('，');details.append(node('p','fine-print',`${date(entry.at)} · ${entry.cause}${changes?' · '+changes:''}`));}root.append(details);}
    return root;
  }
  return {render,reset(){draft=null;conflict=false;notice='';}};
}
