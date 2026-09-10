const $ = id => document.getElementById(id);
let library = {items:[],scenes:[]}, selectedID = null, variant = 'original', busy = false, dirty = false;
const current = () => library.items.find(item => item.id === selectedID);
function note(id, message, error = false) { $(id).textContent = message; $(id).classList.toggle('error', error); }
async function api(route, body) {
  const response = await fetch('/api/image-library' + route, body === undefined ? {} : {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '操作失败，请重试');
  return value;
}
function option(value, title) { const el = document.createElement('option'); el.value = value; el.textContent = title; return el; }
function setBusy(value) {
  busy = value;
  document.querySelectorAll('button,input,select').forEach(el => { el.disabled = value; });
  if (!value) { $('show-cutout').disabled = !current()?.cutoutUrl; }
}
function render() {
  const search = $('search').value.trim().toLowerCase(), scene = $('scene-filter').value, season=$('season-filter').value, environment=$('environment-filter').value, background = $('background-filter').value;
  const items = library.items.filter(item => (!scene || (scene === 'unclassified' ? !item.sceneIds.length : item.sceneIds.includes(scene))) && (!season || !item.seasons.length || item.seasons.includes(season)) && (!environment || item.environment==='any' || item.environment===environment) && (!background || (background === 'cutout' ? item.cutoutUrl : item.background === background && !item.cutoutUrl)) && (!search || [item.name,item.activity,...item.tags].join(' ').toLowerCase().includes(search)));
  $('count').textContent = `${items.length} / ${library.items.length} 张`;
  $('gallery').replaceChildren();
  if (!items.length) { const el = document.createElement('p'); el.className='empty'; el.textContent=library.items.length ? '没有符合筛选条件的图片。' : '还没有图片，先把喜欢的照片传进来。'; $('gallery').append(el); }
  for (const item of items) {
    const card = document.createElement('button'); card.className='card'; card.type='button'; card.disabled=busy;
    const img=document.createElement('img'); img.src=item.originalUrl; img.alt=item.name; img.loading='lazy';
    const info=document.createElement('div'), title=document.createElement('strong'), details=document.createElement('p'), status=document.createElement('p');
    title.textContent=item.name; details.textContent=item.sceneIds.map(id=>library.scenes.find(s=>s.id===id)?.name || id).join(' · ') || '待分类';
    const seasonNames={spring:'春',summer:'夏',autumn:'秋',winter:'冬'},environmentNames={indoor:'室内',outdoor:'室外',any:'室内外均可'};
    status.textContent=[item.seasons.length?item.seasons.map(value=>seasonNames[value]).join('/'):'全年',environmentNames[item.environment],item.desktopEligible ? '透明版可自动用于桌面' : '', item.activity, item.cutoutUrl ? '已有透明版本' : item.background==='needs-removal' ? '待去背景' : ''].filter(Boolean).join(' · ');
    info.append(title,details,status); card.append(img,info); card.addEventListener('click',()=>openEditor(item.id)); $('gallery').append(card);
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
  $('tags').value=item.tags.join('，');
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
for(const id of ['scene-filter','season-filter','environment-filter','background-filter','search']) $(id).addEventListener('input',render);
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
    library=await api('/metadata',{id:selectedID,name:$('name').value,activity:$('activity').value,kind:$('kind').value,background:$('background').value,desktopEligible:$('desktop-eligible').checked,tags:$('tags').value.split(/[,，\n]/).map(s=>s.trim()).filter(Boolean),sceneIds:[...$('scene-checks').querySelectorAll('input:checked')].map(el=>el.value),seasons:[...$('season-checks').querySelectorAll('input:checked')].map(el=>el.value),environment:$('environment').value});
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
  library=await api('');
  for(const scene of library.scenes){$('scene-filter').append(option(scene.id,scene.name));$('apply-scene').append(option(scene.id,scene.name));}
  render();
}catch(error){note('status',`素材库加载失败：${error.message}。请刷新页面重试。`,true);$('uploads').disabled=true;}
