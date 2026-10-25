const $ = id => document.getElementById(id);
let library = {items:[],scenes:[]}, selectedID = null, variant = 'original', busy = false, dirty = false;
const desktopPicker = new URLSearchParams(window.location.search).get('pick') === 'desktop';
let runtime = null;
const activityNames = {sleep:'睡觉',reading:'读书',work:'工作',cafe:'咖啡与小聚',walk:'散步逛街',travel:'旅行',rest:'居家休息',idle:'日常待机'};
const outfitStyleNames = {ladylike:'淑女',homewear:'居家服',lingerie:'内衣',swimwear:'泳装',sailor:'水手服',bodycon:'包臀裙',shorts:'热裤',sportswear:'运动套装',resort:'罩衫度假穿搭'};
const streetStyleNames = {chinese:'中式街拍',japanese:'日式街拍',korean:'韩式街拍'};
const poseGroupNames = {basic:'基础站姿',hands:'手部动作',walking:'行走瞬间',setting:'环境互动',props:'道具与情绪'};
const current = () => library.items.find(item => item.id === selectedID);
function note(id, message, error = false) { $(id).textContent = message; $(id).classList.toggle('error', error); }
async function api(route, body) {
  const response = await fetch('/api/image-library' + route, body === undefined ? {} : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '操作失败，请重试');
  return value;
}
async function rootApi(route) {
  const response = await fetch(route);
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || '无法读取当前桌面情景');
  return value;
}
function option(value, title) { const el = document.createElement('option'); el.value = value; el.textContent = title; return el; }
function desktopVariant(item) { return item.cutoutUrl ? 'cutout' : 'original'; }
function desktopCandidate(item) { return item.kind === 'portrait' && Boolean(item.cutoutUrl || item.background === 'transparent'); }
function currentScene() { return runtime?.current?.sceneId || null; }
function currentSceneName() { return library.scenes.find(scene => scene.id === currentScene())?.name || runtime?.current?.title || '当前情景'; }
function renderPickerContext() {
  if (!desktopPicker) return;
  const sceneId = currentScene();
  note('status', sceneId ? `当前情景：${currentSceneName()}。点击透明人物图即可固定到桌面。` : '暂时无法确定当前桌面情景，请稍后刷新重试。', !sceneId);
}
function setBusy(value) {
  busy = value;
  document.querySelectorAll('button,input,select').forEach(el => { el.disabled = value; });
  if (!value) { $('show-cutout').disabled = !current()?.cutoutUrl; }
}
function render() {
  const search = $('search').value.trim().toLowerCase(), scene = $('scene-filter').value, season=$('season-filter').value, environment=$('environment-filter').value, background = $('background-filter').value, activity = $('activity-filter').value, outfitStyle=$('outfit-style-filter').value, streetStyle=$('street-style-filter').value, poseGroup=$('pose-group-filter').value;
  const items = library.items.filter(item => (!desktopPicker || desktopCandidate(item)) && (!activity || (item.activities||[]).includes(activity)) && (!outfitStyle || item.outfitStyle===outfitStyle) && (!streetStyle || item.streetStyle===streetStyle) && (!poseGroup || item.poseGroup===poseGroup) && (!scene || (scene === 'unclassified' ? !item.sceneIds.length : item.sceneIds.includes(scene))) && (!season || !item.seasons.length || item.seasons.includes(season)) && (!environment || item.environment==='any' || item.environment===environment) && (!background || (background === 'cutout' ? item.cutoutUrl || item.background==='transparent' : item.background === background && !item.cutoutUrl)) && (!search || [item.name,item.activity,...item.tags].join(' ').toLowerCase().includes(search)));
  if (!desktopPicker) renderCoverage(season, environment);
  $('count').textContent = desktopPicker ? `${items.length} 张可选角色图` : `${items.length} / ${library.items.length} 张`;
  $('gallery').replaceChildren();
  if (!items.length) { const el = document.createElement('p'); el.className='empty'; el.textContent=desktopPicker ? '没有符合筛选条件的透明人物图。请先在素材库添加或检查图片分类。' : library.items.length ? '没有符合筛选条件的图片。' : '还没有图片，先把喜欢的照片传进来。'; $('gallery').append(el); }
  for (const item of items) {
    const card = document.createElement('button'); card.className='card'; card.type='button'; card.disabled=busy;
    const img=document.createElement('img'); img.src=desktopPicker ? (item.cutoutUrl || item.originalUrl) : item.originalUrl; img.alt=item.name; img.loading='lazy';
    const info=document.createElement('div'), title=document.createElement('strong'), details=document.createElement('p'), status=document.createElement('p');
    title.textContent=item.name; details.textContent=item.sceneIds.map(id=>library.scenes.find(s=>s.id===id)?.name || id).join(' · ') || '未指定场景';
    const seasonNames={spring:'春',summer:'夏',autumn:'秋',winter:'冬'},environmentNames={indoor:'室内',outdoor:'室外',any:'室内外均可'};
    status.textContent=[streetStyleNames[item.streetStyle],poseGroupNames[item.poseGroup],item.seasons.length?item.seasons.map(value=>seasonNames[value]).join('/'):'全年',environmentNames[item.environment],outfitStyleNames[item.outfitStyle],item.locationScope==='home'?'仅家中':item.locationScope==='waterfront'?'仅水边':'',item.desktopEligible ? '透明版可自动用于桌面' : '', (item.activities||[]).map(value=>activityNames[value]).join('/'), item.cutoutUrl || item.background==='transparent' ? '透明背景' : item.background==='needs-removal' ? '待去背景' : ''].filter(Boolean).join(' · ');
    info.append(title,details,status);
    if (desktopPicker) {
      const action=document.createElement('span'); action.className='picker-action'; action.textContent='选为桌面角色图'; info.append(action);
      card.addEventListener('click',()=>applyDesktopFigure(item));
    } else card.addEventListener('click',()=>openEditor(item.id));
    card.append(img,info); $('gallery').append(card);
  }
}
async function applyDesktopFigure(item) {
  if (busy) return;
  setBusy(true);
  try {
    const latest=await rootApi('/api/companion-runtime');
    runtime=latest.runtime || latest;
    const sceneId=currentScene();
    if (!sceneId) throw new Error('暂时无法确定当前桌面情景，请稍后重试。');
    await api('/apply',{id:item.id,sceneId,variant:desktopVariant(item),fit:'contain'});
    note('status',`已固定「${item.name}」为桌面角色图。`);
  } catch(error) { note('status',error.message,true); }
  finally { setBusy(false); }
}
function renderCoverage(season, environment) {
  $('coverage').replaceChildren();
  for (const [group,name] of Object.entries(activityNames)) {
    if(group==='idle')continue;
    const cells=library.coverage?.groups?.[group];
    const ids=new Set();
    // Report actual activity matches, never fill the count with generic fallback photos.
    for(const s of season?[season]:['spring','summer','autumn','winter'])
      for(const e of environment?[environment]:['indoor','outdoor']) {
        const cell=cells?.[s]?.[e];
        if(cell&&!cell.fallbackUsed)for(const id of cell.ids)ids.add(id);
      }
    const card=document.createElement('button');card.type='button';card.className='coverage-card';
    card.classList.toggle('shortage',ids.size<5);card.setAttribute('aria-pressed',String($('activity-filter').value===group));
    const label=document.createElement('span'),count=document.createElement('strong'),hint=document.createElement('small');
    label.textContent=name;count.textContent=`${ids.size} 张`;hint.textContent=ids.size>=5?'可轮换':`还差 ${5-ids.size} 张`;
    card.append(label,count,hint);card.addEventListener('click',()=>{$('activity-filter').value=$('activity-filter').value===group?'':group;render();});$('coverage').append(card);
  }
}
function showVariant(value) {
  const item = current(); if (!item) return;
  variant = value === 'cutout' && item.cutoutUrl ? 'cutout' : 'original';
  const url = variant==='cutout' ? item.cutoutUrl : item.originalUrl;
  $('preview').src=url; $('download').href=url;
  $('show-original').setAttribute('aria-pressed',String(variant==='original'));
  $('show-cutout').setAttribute('aria-pressed',String(variant==='cutout'));
  $('show-cutout').disabled=busy || !item.cutoutUrl;
}
function fillEditor() {
  const item=current(); if(!item) return;
  for(const field of ['name','activity','kind','background']) $(field).value=item[field];
  $('outfit-style').value=item.outfitStyle||'';
  $('street-style').value=item.streetStyle||'';
  $('pose-group').value=item.poseGroup||'';
  $('location-scope').value=item.locationScope||'any';
  $('tags').value=item.tags.join('，');
  for(const input of $('activity-checks').querySelectorAll('input'))input.checked=(item.activities||[]).includes(input.value);
  for(const input of $('season-checks').querySelectorAll('input'))input.checked=item.seasons.includes(input.value);
  $('environment').value=item.environment;
  $('season-inference').textContent=item.classificationInferred?.seasons?'这是根据名称、标签、活动或场景推断的结果；保存后可按你的选择覆盖。':'已由你明确设置。';
  $('environment-inference').textContent=item.classificationInferred?.environment?'这是根据现有描述推断的结果；保存后可覆盖。':'已由你明确设置。';
  $('desktop-eligible').checked=Boolean(item.desktopEligible);
  $('scene-checks').replaceChildren();
  for(const scene of library.scenes) {
    const label=document.createElement('label'),input=document.createElement('input'); input.type='checkbox';input.value=scene.id;input.checked=item.sceneIds.includes(scene.id);label.append(input,document.createTextNode(scene.name));$('scene-checks').append(label);
  }
  $('apply-scene').value=item.sceneIds[0] || library.scenes[0]?.id || '';
  dirty=false; showVariant(variant);
}
function openEditor(id) { if(busy)return; selectedID=id;variant='original';fillEditor();note('editor-status','分类只描述图片，不会自动改变她的生活状态。');$('editor').showModal(); }
function closeEditor() {
  if(busy) return;
  if(dirty && !window.confirm('分类尚未保存，放弃这些修改？')) return;
  $('editor').close();dirty=false;
}
$('close').addEventListener('click',closeEditor);
$('editor').addEventListener('cancel',e=>{e.preventDefault();closeEditor();});
$('metadata-form').addEventListener('input',e=>{if(!['fit','apply-scene','cutout-upload'].includes(e.target.id))dirty=true;});
$('show-original').addEventListener('click',()=>showVariant('original'));
$('show-cutout').addEventListener('click',()=>showVariant('cutout'));
for(const id of ['activity-filter','street-style-filter','pose-group-filter','outfit-style-filter','scene-filter','season-filter','environment-filter','background-filter','search']) $(id).addEventListener('input',render);
async function fileData(file, onlyPNG=false) {
  if(!file.size || file.size > 12*1024*1024) throw new Error('每张图片需要在 12 MB 以内');
  const mime=file.type || ({png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',webp:'image/webp'}[file.name.split('.').at(-1).toLowerCase()]);
  if(!(onlyPNG ? ['image/png'] : ['image/png','image/jpeg','image/webp']).includes(mime)) throw new Error(onlyPNG ? '透明版本请选择 PNG' : '请选择 PNG、JPEG 或 WebP 图片');
  const data=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(new Error('无法读取图片'));reader.readAsDataURL(file);});
  return data.replace(/^data:[^;]*;/,`data:${mime};`);
}
$('uploads').addEventListener('change',async e=>{
  const files=[...e.target.files]; if(!files.length || busy)return;
  setBusy(true);let done=0,failed=[];
  try {
    for(let i=0;i<files.length;i++) {
      const file=files[i];note('upload-status',`正在保存 ${i+1} / ${files.length}：${file.name}`);
      try {library=await api('/upload',{image:await fileData(file),name:file.name.replace(/\.[^.]+$/,'').slice(0,120)});done++;render();}
      catch(error){failed.push(`${file.name}：${error.message}`);}
    }
    note('upload-status',`已保存 ${done} 张（相同图片合并）。${failed.length ? `\n${failed.length} 张失败，可重新选择重试：\n${failed.join('\n')}` : '可以点开图片整理场景和标签。'}`,!!failed.length);
  } finally {e.target.value='';setBusy(false);}
});
$('metadata-form').addEventListener('submit',async e=>{
  e.preventDefault();if(busy || !current())return;
  setBusy(true);
  try {
    library=await api('/metadata',{id:selectedID,name:$('name').value,activities:[...$('activity-checks').querySelectorAll('input:checked')].map(el=>el.value),activity:$('activity').value,kind:$('kind').value,background:$('background').value,desktopEligible:$('desktop-eligible').checked,tags:$('tags').value.split(/[,，\n]/).map(s=>s.trim()).filter(Boolean),sceneIds:[...$('scene-checks').querySelectorAll('input:checked')].map(el=>el.value),seasons:[...$('season-checks').querySelectorAll('input:checked')].map(el=>el.value),environment:$('environment').value,outfitStyle:$('outfit-style').value||null,streetStyle:$('street-style').value||null,poseGroup:$('pose-group').value||null,locationScope:$('location-scope').value});
    dirty=false;$('desktop-eligible').checked=Boolean(current()?.desktopEligible);$('season-inference').textContent='已由你明确设置。';$('environment-inference').textContent='已由你明确设置。';render();note('editor-status','分类与桌面选图设置已保存。');
  }catch(error){note('editor-status',error.message,true);}finally{setBusy(false);}
});
$('cutout-upload').addEventListener('change',async e=>{
  const file=e.target.files[0];if(!file || busy || !current())return;
  setBusy(true);
  try {library=await api('/derivative',{id:selectedID,image:await fileData(file,true)});showVariant('cutout');$('desktop-eligible').checked=Boolean(current()?.desktopEligible);render();note('editor-status','透明版本已保存。检查人物、支撑物和边缘完整后，可开启自动用于桌面角色；原图仍保留。');}
  catch(error){note('editor-status',error.message,true);}finally{e.target.value='';setBusy(false);}
});
$('apply').addEventListener('click',async()=>{
  if(busy || !current())return;
  if(dirty){note('editor-status','请先保存分类，再应用图片。',true);return;}
  setBusy(true);
  try{await api('/apply',{id:selectedID,sceneId:$('apply-scene').value,variant,fit:$('fit').value});note('editor-status','已应用到桌面，桌面应用同步后显示。');}
  catch(error){note('editor-status',error.message,true);}finally{setBusy(false);}
});
try {
  if (desktopPicker) {
    document.body.classList.add('desktop-picker');
    $('page-title').textContent='选择桌面角色图';
    $('page-intro').textContent='选择透明人物图后会固定到当前桌面情景；自动轮换可在素材库单独开启。';
    for (const id of ['scene-filter','background-filter']) $(id).closest('label').hidden=true;
  }
  library=await api('');
  if (desktopPicker) {
    try {
      const value=await rootApi('/api/companion-runtime');
      runtime=value.runtime || value;
    } catch(error) { note('status',error.message,true); }
  }
  for(const [id,name] of Object.entries(activityNames)){
    $('activity-filter').append(option(id,name));
    const label=document.createElement('label'),input=document.createElement('input');input.type='checkbox';input.value=id;label.append(input,document.createTextNode(name));$('activity-checks').append(label);
  }
  for(const scene of library.scenes){$('scene-filter').append(option(scene.id,scene.name));$('apply-scene').append(option(scene.id,scene.name));}
  render();renderPickerContext();
}catch(error){note('status',`素材库加载失败：${error.message}。请刷新页面重试。`,true);$('uploads').disabled=true;}
