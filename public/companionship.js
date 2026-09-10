import {createCompanionStateEditor} from './companion-state.js';
const labels = {proposed:'等另一方答应',suggested:'她收到的推荐',planned:'已经约好',active:'正在进行',paused:'暂时暂停',awaiting_confirmation:'等你确认',completed:'已完成',cancelled:'已取消'};
const kinds = {reading:'一起读书',film:'看电影',cooking:'做点好吃的',quiet:'安静陪伴',chat:'慢慢聊',ritual:'固定的小约定'};
const factKinds = {nickname:'称呼',preference:'相处偏好',boundary:'边界',shared_reference:'共同话题'};
const keys = {nickname:[['user','她如何称呼你'],['companion','你如何称呼她']],preference:[['communication','聊天方式'],['comfort','安慰方式'],['advice','给建议'],['affection','亲近方式'],['activity','喜欢的活动']],boundary:[['intimacy','亲密互动'],['nickname','称呼'],['advice','给建议'],['contact','主动联系'],['topic','话题']],shared_reference:[['book','书'],['film','电影'],['joke','小默契'],['place','地方'],['activity','共同活动']]};
export function createCompanionshipPage({api,node,button,action,toast,onTuning}) {
  let snapshot, busy=false;
  const root=()=>document.querySelector('#companionship-body');
  const stateEditor=createCompanionStateEditor({api,node,button,action,toast,onTuning,onSaved:value=>{snapshot=value;}});
  const field=(label,el)=>{const wrap=node('label','companionship-field',label);wrap.append(el);return wrap;};
  const input=(type,value='',placeholder='')=>{const el=node('input');el.type=type;el.value=value;el.placeholder=placeholder;return el;};
  const select=(entries,value)=>{const el=node('select');for(const [id,label] of entries){const opt=node('option','',label);opt.value=id;el.append(opt);}if(value!==undefined)el.value=value;return el;};
  const row=(...els)=>{const el=node('div','form-row wrap');el.append(...els);return el;};
  const card=(title,description)=>{const el=node('section','settings-card companionship-card');el.append(node('h3','',title));if(description)el.append(node('p','fine-print',description));return el;};
  const time=value=>value?new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'还没定时间';
  const localDate=value=>{if(!value)return '';const date=new Date(value);return new Date(date-date.getTimezoneOffset()*60000).toISOString().slice(0,16);};
  async function mutate(type,command){if(busy)return;busy=true;root().setAttribute('aria-busy','true');root().querySelectorAll('button').forEach(el=>el.disabled=true);try{snapshot=await api(`/api/companionship/${type}`,{method:'POST',body:{...command,revision:snapshot[type].revision}});render();toast('已经记下，从接下来的相处中生效。');}catch(error){if(error.status===409){snapshot=await api('/api/companionship');render();}throw error;}finally{busy=false;root().removeAttribute('aria-busy');render();}}
  const run=(type,command)=>action(()=>mutate(type,typeof command==='function'?command():command));
  function relation(){
    const relation=snapshot.relationship,box=card('林雨薇和你的相处','明确的称呼和偏好会留下来；今天想安静一点，不会变成永久疏远。');
    const status=select([['friends','朋友'],['dating','恋人'],['partners','伴侣']],relation.status.value);
    box.append(node('p','fine-print',relation.status.explicit?`已确认：${relation.status.label} · 已有 ${relation.familiarity.activeDays} 天的互动记录`:`关系身份还未明确确认 · 已有 ${relation.familiarity.activeDays} 天的互动记录`),row(field('关系身份',status),button('保存关系','small-button',run('relationship',()=>({kind:'status',value:status.value})))));
    if(relation.status.id)box.append(button('清除这项关系记录','text-button',run('relationship',{action:'remove',id:relation.status.id})));
    const list=node('div','companionship-facts');
    for(const fact of [...(relation.nicknames||[relation.nickname]),...relation.preferences,...relation.boundaries,...relation.sharedReferences].filter(Boolean)){
      const item=node('article','companionship-fact'),value=input('text',fact.value);value.maxLength=160;value.setAttribute('aria-label',`修改${factKinds[fact.kind]}`);
      item.append(node('small','',`${factKinds[fact.kind]} · ${fact.scope==='today'?'今天有效':fact.scope==='turn'?'暂时有效':'长期保留'}${fact.validUntil?' · 至 '+time(fact.validUntil):''}`),row(value,button('保存','small-button',run('relationship',()=>({id:fact.id,kind:fact.kind,key:fact.key,value:value.value,scope:fact.scope}))),button('删除','text-button',run('relationship',{action:'remove',id:fact.id}))));
      if(fact.source.evidence)item.append(node('p','fine-print',`${fact.source.type==='setting'?'你的设置':'聊天原话'}：${fact.source.evidence}`));list.append(item);
    }
    if(!list.children.length)list.append(node('p','fine-print','还没有额外记录。你可以在聊天中说，也可以在这里添加。'));box.append(list);
    const form=node('form','companionship-form'),kind=select(Object.entries(factKinds)),key=select(keys.nickname),value=input('text','','例如：阿舟，或“烦心时先听我说完”'),scope=select([['persistent','长期'],['today','今天'],['turn','暂时（2 小时）']]);value.required=true;value.maxLength=160;
    kind.addEventListener('change',()=>{key.replaceChildren();for(const [id,label] of keys[kind.value]){const opt=node('option','',label);opt.value=id;key.append(opt);}});
    const submit=node('button','small-button','添加记录');submit.type='submit';form.append(row(field('记录类型',kind),field('用途',key),field('有效期',scope)),field('具体内容',value),submit);form.addEventListener('submit',action(async e=>{e.preventDefault();await mutate('relationship',{kind:kind.value,key:key.value,value:value.value,scope:scope.value});}));box.append(form);return box;
  }
  function plans(){
    const box=card('相处与约定','读到哪儿、有没有开始、什么时候再继续，都可以留下来。共同活动到时间会先问你，不会替你记成已经参加。');
    const list=node('div','companionship-plans');
    const entries=[...snapshot.agenda.plans].sort((a,b)=>Number(['completed','cancelled'].includes(a.status))-Number(['completed','cancelled'].includes(b.status))||b.updatedAt.localeCompare(a.updatedAt));
    for(const plan of entries){
      const item=node('article','companionship-plan');item.append(row(node('strong','',plan.title),node('span','badge',labels[plan.status]||plan.status)),node('p','fine-print',`${plan.owner==='joint'?'你们一起':plan.owner==='user'?'你的安排':'她自己的生活'} · ${time(plan.dueAt)}${plan.durationMinutes?` · ${plan.durationMinutes} 分钟`:''}${plan.recurrence?' · '+(plan.recurrence.frequency==='weekly'?'每周':'每天')+' '+plan.recurrence.time:''}`));
      if(plan.progress)item.append(node('p','',`上次进度：${plan.progress}`));if(plan.provenance)item.append(node('p','fine-print',plan.provenance));
      if(!['completed','cancelled'].includes(plan.status)){
        const controls=row();
        if(['proposed','suggested'].includes(plan.status))controls.append(button(plan.status==='proposed'?'接受约定':'加入安排','small-button',run('agenda',{action:'state',id:plan.id,state:'planned'})));
        if(['planned','awaiting_confirmation'].includes(plan.status))controls.append(button('开始','small-button',run('agenda',{action:'start',id:plan.id})));
        if(plan.status==='active')controls.append(button('暂停','small-button',run('agenda',{action:'pause',id:plan.id})));
        if(plan.status==='paused')controls.append(button('继续','small-button',run('agenda',{action:'resume',id:plan.id})));
        if(['active','paused','awaiting_confirmation'].includes(plan.status))controls.append(button('确认已完成','small-button',run('agenda',{action:'complete',id:plan.id,confirmed:true})));
        controls.append(button('取消','text-button',run('agenda',{action:'cancel',id:plan.id})));item.append(controls);
        const details=node('details'),summary=node('summary','','调整时间、标题和进度');details.append(summary);
        const title=input('text',plan.title),due=input('datetime-local',localDate(plan.dueAt)),progress=input('text',plan.progress||'','例如：读到第三章，周末继续');title.maxLength=120;progress.maxLength=240;
        details.append(field('标题',title),field('时间',due),button('保存安排','small-button',run('agenda',()=>({action:'edit',id:plan.id,title:title.value,...(due.value!==localDate(plan.dueAt)?{dueAt:due.value?new Date(due.value).toISOString():null}:{})}))));
        if(!['proposed','suggested'].includes(plan.status))details.append(field('留下进度',progress),button('保存进度','small-button',run('agenda',()=>({action:'progress',id:plan.id,progress:progress.value}))));item.append(details);
      }
      list.append(item);
    }
    if(!entries.length)list.append(node('p','fine-print','还没有约定。试着说“一起读这本书吧”，或在下面安排一件事。'));box.append(list);
    const form=node('form','companionship-form'),title=input('text','','例如：周五一起看一部电影'),kind=select(Object.entries(kinds)),owner=select([['joint','我们一起'],['character','她自己']]),due=input('datetime-local'),duration=input('number','20'),frequency=select([['weekly','每周'],['daily','每天']]),repeatTime=input('time','20:00'),weekday=select(['周日','周一','周二','周三','周四','周五','周六'].map((label,i)=>[String(i),label]),'5');title.required=true;title.maxLength=120;duration.min='1';duration.max='240';
    const quiet=field('安静陪伴时长（分钟）',duration),recurring=row(field('重复',frequency),field('星期',weekday),field('时间',repeatTime));quiet.hidden=true;recurring.hidden=true;kind.addEventListener('change',()=>{quiet.hidden=kind.value!=='quiet';recurring.hidden=kind.value!=='ritual';});
    const submit=node('button','primary-button','约好这件事');submit.type='submit';form.append(node('h4','','新的小安排'),field('想做的事',title),row(field('类型',kind),field('谁参与',owner),field('时间（可稍后再定）',due)),quiet,recurring,submit);form.addEventListener('submit',action(async e=>{e.preventDefault();await mutate('agenda',{action:'create',kind:kind.value,owner:owner.value,title:title.value,dueAt:due.value?new Date(due.value).toISOString():null,...(kind.value==='quiet'?{durationMinutes:Number(duration.value)}:{}),...(kind.value==='ritual'?{recurrence:{frequency:frequency.value,time:repeatTime.value,weekday:Number(weekday.value)}}:{})});}));box.append(form);return box;
  }
  function interests(){const box=card('她慢慢形成的兴趣','推荐和她表达过的喜好会影响后续选书、观影和生活安排；仍然保留变化和尝试的余地。');for(const interest of snapshot.agenda.interests.filter(item=>item.audience==='character')){const value=select([['-2','很少选择'],['-1','稍少一点'],['0','顺其自然'],['1','更常选择'],['2','很感兴趣']],String(Math.round(interest.value)));box.append(row(node('span','',interest.title),field('倾向',value),button('保存','small-button',run('agenda',()=>({action:'interest',title:interest.title,value:Number(value.value)})))));if(interest.quotes?.length)box.append(node('p','fine-print',interest.quotes.at(-1).text));}const form=node('form','companionship-form'),title=input('text','','例如：悬疑电影、江南美食');title.maxLength=60;title.required=true;const submit=node('button','small-button','添加兴趣');submit.type='submit';form.append(field('新的兴趣',title),submit);form.addEventListener('submit',action(async e=>{e.preventDefault();await mutate('agenda',{action:'interest',title:title.value,value:1});}));box.append(form);return box;}
  function render(){root().replaceChildren(stateEditor.render(snapshot.inner),relation(),plans(),interests());}
  async function load(){snapshot=await api('/api/companionship');render();}
  document.querySelector('#refresh-companionship').addEventListener('click',action(load));
  return {load};
}
