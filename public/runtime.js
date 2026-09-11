const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const $ = id => document.getElementById(id);
const planLabels = {proposed:'等另一方答应',suggested:'她收到的推荐',planned:'已经约好',active:'正在进行',paused:'暂时暂停',awaiting_confirmation:'等待你的确认',completed:'已完成',cancelled:'已取消'};
const ownerLabels = {joint:'你们一起',character:'她自己的生活',user:'你的安排'};
const imageSettingDefaults = {imageRotationMinutes:30,imageSeason:'auto',imageEnvironment:'auto',imageVariant:'cutout'};
const imageSettingValues = {imageSeason:new Set(['auto','spring','summer','autumn','winter']),imageEnvironment:new Set(['auto','indoor','outdoor']),imageVariant:new Set(['cutout','original'])};

export function beijingLocalToIso(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return null;
  const [, ys, mos, ds, hs, mis] = match;
  const [y, mo, d, h, mi] = [ys, mos, ds, hs, mis].map(Number);
  const localCalendar = new Date(Date.UTC(y, mo - 1, d));
  if (localCalendar.getUTCFullYear() !== y || localCalendar.getUTCMonth() !== mo - 1 || localCalendar.getUTCDate() !== d || h > 23 || mi > 59) return null;
  const timestamp = Date.UTC(y, mo - 1, d, h, mi) - BEIJING_OFFSET_MS;
  return new Date(timestamp).toISOString();
}

export function isoToBeijingLocal(value) {
  if (!value || Number.isNaN(Date.parse(value))) return '';
  const date = new Date(Date.parse(value) + BEIJING_OFFSET_MS);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2,'0')}-${String(date.getUTCDate()).padStart(2,'0')}T${String(date.getUTCHours()).padStart(2,'0')}:${String(date.getUTCMinutes()).padStart(2,'0')}`;
}

function beijingTime(value, date = true) {
  if (!value || Number.isNaN(Date.parse(value))) return '尚未安排';
  return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:date?'numeric':undefined,day:date?'numeric':undefined,hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));
}
function element(tag, className, text) { const el=document.createElement(tag); if(className)el.className=className; if(text !== undefined)el.textContent=text; return el; }
function value(value, fallback='—') { return value === undefined || value === null || value === '' ? fallback : String(value); }
async function api(route, options) {
  const response = await fetch(route, options && {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(options)});
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { const error=new Error(body.error || '请求没有完成，请稍后重试。'); error.status=response.status; error.body=body; throw error; }
  return body;
}
let runtime = null, companionship = null, settingsDirty = false, settingsRevision = null, agendaDirty = false, busy = false;
function fact(label, content) { const box=element('div','fact'); box.append(element('small','',label),element('strong','',value(content))); return box; }
function imageSettings(settings={}) { return {...imageSettingDefaults,...(settings || {})}; }
function setSelectValue(id, candidate, allowed, fallback) { $(id).value=allowed.has(candidate) ? candidate : fallback; }
function readImageSettings() {
  const rawMinutes=$('image-rotation-minutes').value.trim(),imageRotationMinutes=Number(rawMinutes);
  if (!rawMinutes || !Number.isInteger(imageRotationMinutes) || imageRotationMinutes < 0 || imageRotationMinutes > 1440) return {error:'图片更换间隔请填写 0 到 1440 之间的整数分钟。'};
  return {imageRotationMinutes,imageSeason:$('image-season').value,imageEnvironment:$('image-environment').value,imageVariant:$('image-variant').value};
}
function planNode(plan) { const item=element('article','plan'); item.append(element('strong','',value(plan.title,'未命名安排')),element('p','meta',`${ownerLabels[plan.owner] || '安排'} · ${beijingTime(plan.dueAt || plan.startedAt)}${plan.durationMinutes ? ` · ${plan.durationMinutes} 分钟` : ''}`)); if(plan.status) item.append(element('span','badge',planLabels[plan.status] || plan.status)); return item; }
function renderRuntime() {
  if (!runtime) return;
  const world=runtime.world || {}, current=runtime.current || {}, availability=runtime.availability || {}, service=runtime.service || availability.service || {};
  $('runtime-badge').textContent = runtime.settings?.enabled ? '生活联动已开启' : '生活联动已关闭'; $('runtime-badge').className = `badge ${runtime.settings?.enabled ? 'good' : 'warn'}`;
  $('now').replaceChildren(fact('地点',world.location),fact('正在做什么',current.title || world.activity),fact('身体状态',world.body ? `疲劳 ${world.body.fatigue} · 活力 ${world.body.vitality} · 饥饿 ${world.body.hunger}` : '平稳'),fact('感受',world.feelings?.feeling || world.needs?.emotional),fact('心理需要',world.needs?.emotional),fact('亲近愿望',world.needs?.physical || '暂时没有特别的身体亲近愿望'),fact('从何时开始',current.startedAt ? beijingTime(current.startedAt) : world.at ? beijingTime(world.at) : null),fact('预计结束',current.endsAt ? beijingTime(current.endsAt) : null));
  $('current-note').textContent = current.location || world.location ? `她现在在${current.location || world.location}。` : '地点和活动会随着生活状态更新。';
  const next=(Array.isArray(runtime.next)?runtime.next:runtime.next?[runtime.next]:[]).slice(0,5); $('next').replaceChildren(...(next.length ? next.map(planNode) : [element('p','empty','还没有排定的下一件事。')]));
  const day=(runtime.dayPlan || []).filter(item=>!item.endsAt || Date.parse(item.endsAt)>Date.parse(runtime.at)).slice(0,12); $('day-plan').replaceChildren(...(day.length ? day.map(planNode) : [element('p','empty','今天暂时没有额外安排。')]));
  const pending=runtime.pending; $('pending').hidden=!pending; if(pending) $('pending').textContent=typeof pending === 'string' ? pending : (pending.title || '等待确认');
  const dailyEvents=runtime.events||runtime.dailyLife?.events||[];
  $('event-clock').textContent=`服务持续检查 · ${runtime.dailyLife?.nextAt?`下一处生活变化预计 ${beijingTime(runtime.dailyLife.nextAt)}`:'等待下一段空闲时间'}`;
  $('daily-life').replaceChildren(...(dailyEvents.length?dailyEvents.map(event=>{
    const row=element('article','plan');row.append(element('strong','',event.title),element('span','badge',event.phaseLabel),element('p','',event.detail));
    if(event.type==='meter'){const meter=element('progress');meter.max=100;meter.value=event.value;meter.setAttribute('aria-label',`${event.title} ${event.value}/100`);row.append(meter,element('span','meta',` ${event.value}/100`));if(event.endsAt)row.append(element('p','meta',`下一阶段预计 ${beijingTime(event.endsAt)}`));}
    else row.append(element('p','meta',`${beijingTime(event.instanceStartedAt||event.startedAt)} 开始 · ${event.location} · 当前阶段至 ${beijingTime(event.endsAt)} · 保留到 ${beijingTime(event.expiresAt)}`));
    if(event.source){const source=element('a','meta',`来源：${event.source.title}`);source.href=event.source.url;source.target='_blank';source.rel='noopener noreferrer';row.append(source);}
    if(event.choice){
      const choice=event.choice;
      row.append(element('p','meta',`${choice.label}：${choice.selected} · ${choice.adopted?'采纳了你的建议':'她自己的选择'}${choice.editable?'':' · 已定下'}`));
      if(choice.evidence)row.append(element('p','meta',`当时你说：“${choice.evidence}”`));
      if(choice.editable){
        const label=element('label','meta','更改选择 '),select=element('select');select.setAttribute('aria-label',`${event.title}：更改${choice.label}`);
        for(const option of choice.options){const node=element('option','',option);node.value=option;select.append(node);}select.value=choice.selected;
        const revision=runtime.dailyLife.revision;
        select.addEventListener('change',async()=>{select.disabled=true;try{runtime=await api('/api/companion-runtime/choice',{revision,eventId:event.id,value:select.value});$('choice-status').textContent='选择已修改，后续进展会沿用这个选择。';renderRuntime();}catch(error){$('choice-status').textContent=error.status===409?'事件已经变化，请刷新后查看当前选择。':error.message;select.disabled=false;}});
        label.append(select);row.append(label);
      }
    }
    return row;
  }):[element('p','empty','眼下没有特别的小事。空闲时她会有新的生活安排。')]));
  renderEventChanges();
  const transitions=runtime.transitions || []; const list=$('transitions'); list.replaceChildren(...(transitions.length ? transitions.slice(-10).reverse().map(item=>{const row=element('article','transition');row.append(element('time','',beijingTime(item.at || item.createdAt)),element('div','',item.summary || item.text || item.title || `${value(item.from,'')} → ${value(item.to,'')}`));return row;}) : [element('p','empty','还没有记录到状态变化。')]));
  const running = service.running ?? availability.running; $('service-badge').textContent=running === false ? '未运行' : running === true ? '正在运行' : '状态未知'; $('service-badge').className=`badge ${running === true ? 'good' : 'warn'}`;
  const desktop=runtime.desktop || {};
  $('service').replaceChildren(fact('最近检查',service.lastTickAt ? beijingTime(service.lastTickAt) : availability.lastTickAt ? beijingTime(availability.lastTickAt) : null),fact('服务状态',running === true ? '正常运行' : running === false ? '暂未运行' : '等待状态'),fact('最近错误',service.lastError || availability.lastError || '没有'),fact('桌面图片',desktop.reason || (runtime.settings?.automaticScenes?'等待匹配当前场景':'已手动固定')));
  $('desktop-selection').replaceChildren(fact('已选图片',desktop.itemName),fact('匹配条件',`${({spring:'春季',summer:'夏季',autumn:'秋季',winter:'冬季'}[desktop.season]||'自动')} · ${({indoor:'室内',outdoor:'室外'}[desktop.environment]||'自动')}`),fact('候选图片',desktop.candidateCount === 0 ? '没有符合条件的图片' : desktop.candidateCount),fact('上次选择',desktop.selectedAt ? beijingTime(desktop.selectedAt) : null),fact('下次更换',desktop.nextRotationAt ? beijingTime(desktop.nextRotationAt) : runtime.settings?.automaticScenes ? '等待活动或情境变化' : '自动匹配已关闭'),fact('选择原因',desktop.reason),fact('图片版本',desktop.variant === 'original' ? '完整原图' : desktop.variant === 'cutout' ? '透明桌面人物' : null));
  if (!settingsDirty) { const settings=imageSettings(runtime.settings); $('enabled').checked=Boolean(settings.enabled); $('automatic-scenes').checked=Boolean(settings.automaticScenes); $('image-rotation-minutes').value=settings.imageRotationMinutes; setSelectValue('image-season',settings.imageSeason,imageSettingValues.imageSeason,imageSettingDefaults.imageSeason); setSelectValue('image-environment',settings.imageEnvironment,imageSettingValues.imageEnvironment,imageSettingDefaults.imageEnvironment); setSelectValue('image-variant',settings.imageVariant,imageSettingValues.imageVariant,imageSettingDefaults.imageVariant); $('reload-settings').hidden=true; }
}
function renderEventChanges(){
  const reasons={chosen:'采纳了聊天中的建议',unchanged:'已经是这个选择',manual:'你在面板中修改了选择',unknown_field:'修改包含不支持的内容',invalid_choice:'不在这件事的可选范围内',not_editable:'这件事已过了选择阶段',unverified_evidence:'原话没有明确确认这个选择',duplicate:'这次选择已处理过',stale_revision:'事件已经变化'};
  const changes=(runtime?.dailyLife?.recentChanges||[]).map(change=>({at:change.at,text:`${change.title||'生活事件'} · ${change.status==='accepted'?'已采用':change.status==='rejected'?'未采用':change.status}：${reasons[change.reason]||change.reason||''}${change.to?`（${change.from||'未定'} → ${change.to}）`:''}`}));
  const fields=Object.fromEntries((companionship?.inner?.fields||[]).map(field=>[field.key,field.label]));
  for(const item of companionship?.inner?.journal||[])changes.push({at:item.at,text:`${item.cause} · ${Object.entries(item.changes||{}).map(([key,amount])=>`${fields[key]||key} ${amount>0?'+':''}${amount}`).join('，')||'状态记录'}`});
  changes.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
  $('event-changes').replaceChildren(...(changes.length?changes.slice(0,12).map(item=>{const row=element('article','transition');row.append(element('time','',beijingTime(item.at)),element('div','',item.text));return row;}):[element('p','empty','还没有选择或身心变化记录。')]));
}
function renderAgenda() {
  if (!companionship?.agenda || agendaDirty) return;
  const plans=[...(companionship.agenda.plans || [])].sort((a,b)=>Date.parse(a.dueAt || 0)-Date.parse(b.dueAt || 0)); const target=$('agenda'); target.replaceChildren();
  for(const plan of plans) {
    const item=element('article','agenda-item'), head=element('div','agenda-head'), left=element('div'); left.append(element('strong','',plan.title),element('p','meta',`${ownerLabels[plan.owner] || plan.owner} · ${beijingTime(plan.dueAt || plan.startedAt)}${plan.durationMinutes ? ` · ${plan.durationMinutes} 分钟` : ''}`)); head.append(left,element('span','badge',planLabels[plan.status] || plan.status)); item.append(head);
    if (!['completed','cancelled'].includes(plan.status)) { const controls=element('div','agenda-controls'); const cancel=element('button','quiet-button','取消');cancel.type='button';cancel.addEventListener('click',()=>mutateAgenda({action:'cancel',id:plan.id}));for(const [action,label] of (plan.status==='active'?[['pause','暂停'],['complete','确认完成']]:plan.status==='paused'?[['resume','继续'],['complete','确认完成']]:['planned','awaiting_confirmation'].includes(plan.status)?[['start','现在开始']]:[])){const button=element('button','quiet-button',label);button.type='button';button.addEventListener('click',()=>mutateAgenda({action,id:plan.id,...(action==='complete'?{confirmed:true}:{})}));controls.append(button);}controls.append(cancel); item.append(controls); const details=element('details');details.append(element('summary','', '修改标题、时间或地点')); const grid=element('div','edit-grid'),title=element('input'),due=element('input'),duration=element('input'),location=element('input'); title.type='text';title.value=plan.title;title.maxLength=120;due.type='datetime-local';due.value=isoToBeijingLocal(plan.dueAt);duration.type='number';duration.min='1';duration.max='1440';duration.value=plan.durationMinutes || 60;location.type='text';location.maxLength=120;location.value=plan.location || ''; location.placeholder='仅她自己的活动可填写'; location.disabled=plan.owner !== 'character'; for(const input of [title,due,duration,location]) input.addEventListener('input',()=>{agendaDirty=true;$('reload-plans').hidden=false;}); const a=element('label','', '标题');a.append(title);const b=element('label','', '日期和时间（北京时间）');b.append(due);const c=element('label','', '时长（分钟）');c.append(duration);const d=element('label','', '地点');d.append(location);grid.append(a,b,c,d);const save=element('button','primary','保存修改');save.type='button';save.addEventListener('click',()=>{const dueAt=beijingLocalToIso(due.value);if(!dueAt){setPlanStatus('请填写有效的北京时间。',true);return;}mutateAgenda({action:'edit',id:plan.id,title:title.value.trim(),dueAt,durationMinutes:Number(duration.value),...(plan.owner === 'character' ? {location:location.value.trim()} : {})});});details.append(grid,save);item.append(details); }
    target.append(item);
  }
  if(!plans.length)target.append(element('p','empty','还没有安排。'));
}
function setPlanStatus(message, error=false) { const target=$('plan-status');target.textContent=message;target.classList.toggle('error',error); }
function setSettingsStatus(message, error=false) { const target=$('settings-status');target.textContent=message;target.classList.toggle('error',error); }
async function load({full=false}={}) { if(busy)return; full=full||!agendaDirty; busy=true; try { const jobs=[api('/api/companion-runtime')]; if(full)jobs.push(api('/api/companionship')); const values=await Promise.all(jobs);runtime=values[0].runtime || values[0];if(full)companionship=values[1];renderRuntime();if(full)renderAgenda();$('page-status').textContent=`已更新 · ${beijingTime(runtime.at || new Date().toISOString())}（北京时间）`;$('page-status').classList.remove('error'); } catch(error) { $('page-status').textContent=error.message;$('page-status').classList.add('error'); } finally { busy=false; } }
async function saveSettings(event) { event.preventDefault(); if(!runtime)return; const imageSettingsResult=readImageSettings(); if(imageSettingsResult.error){setSettingsStatus(imageSettingsResult.error,true);return;} try { const result=await api('/api/companion-runtime/settings',{revision:settingsRevision ?? runtime.revision,settings:{enabled:$('enabled').checked,automaticScenes:$('automatic-scenes').checked,...imageSettingsResult}});runtime=result.runtime || result;settingsDirty=false;settingsRevision=null;setSettingsStatus('已保存。');renderRuntime(); } catch(error) { if(error.status===409){setSettingsStatus('设置已在别处更新。你填写的选择还在；重新读取后再决定是否保存。',true);$('reload-settings').hidden=false;} else setSettingsStatus(error.message,true); } }
async function mutateAgenda(command) { if(!companionship?.agenda)return; try { const result=await api('/api/companionship/agenda',{revision:companionship.agenda.revision,...command});companionship=result;agendaDirty=false;$('reload-plans').hidden=true;renderAgenda();setPlanStatus(command.action==='cancel'?'已取消安排。':'已保存安排。');await load(); } catch(error) { if(error.status===409){agendaDirty=true;$('reload-plans').hidden=false;setPlanStatus('安排已在别处更新。你填写的内容还在；重新读取后再决定是否保存。',true);} else setPlanStatus(error.message,true); } }
function createPlan(event) { event.preventDefault(); const title=$('plan-title').value.trim(),dueAt=beijingLocalToIso($('plan-due').value),durationMinutes=Number($('plan-duration').value),kind=$('plan-kind').value,owner=$('plan-owner').value,location=$('plan-location').value.trim(); if(!title){setPlanStatus('请写下想做的事。',true);return;}if(!dueAt){setPlanStatus('请填写有效的北京时间。',true);return;}mutateAgenda({action:'create',kind,owner,title,dueAt,durationMinutes,...(kind === 'outing' && owner === 'character' && location ? {location} : {})}); }
if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded',()=>{ const syncOutingLocation=()=>{const visible=$('plan-kind').value === 'outing' && $('plan-owner').value === 'character';$('plan-location-wrap').hidden=!visible;if(!visible)$('plan-location').value='';}; const markSettingsDirty=()=>{if(!settingsDirty)settingsRevision=runtime?.revision ?? null;settingsDirty=true;$('reload-settings').hidden=false;}; $('refresh').addEventListener('click',()=>load({full:true}));$('settings-form').addEventListener('submit',saveSettings);$('create-plan').addEventListener('submit',createPlan);$('plan-kind').addEventListener('change',syncOutingLocation);$('plan-owner').addEventListener('change',syncOutingLocation);[$('enabled'),$('automatic-scenes'),$('image-rotation-minutes'),$('image-season'),$('image-environment'),$('image-variant')].forEach(input=>input.addEventListener(input.type === 'number' ? 'input' : 'change',markSettingsDirty));$('reload-settings').addEventListener('click',()=>{settingsDirty=false;settingsRevision=null;load();});$('reload-plans').addEventListener('click',()=>{agendaDirty=false;load({full:true});});syncOutingLocation();load({full:true});setInterval(()=>{if(!document.hidden)load();},15000);});
