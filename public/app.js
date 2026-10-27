import { createCompanionshipPage } from './companionship.js';
import { createDesktopControl } from './desktop-control.js';
import { createCompanionDynamicsSettings } from './companion-dynamics.js';
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const state = { roles: [], role: 'miyue', view: 'chat', settings: {}, provider: {}, memories: [], episodes: { roleId: null, items: [], preferences: null }, feeds: [], items: [], contentInbox: { status: 'unread', query: '', page: 1, pageSize: 20, total: 0, pages: 1, counts: { unread: 0, read: 0, archived: 0, expired: 0, all: 0 }, selectedId: null, selectedItem: null, request: 0 }, reminders: [], conversations: {}, pending: new Map(), lifeChoice: null, content: null, memoryEdit: null, voice: null, audioJob: null, audioEpoch: 0, recorder: null, recordStream: null, character: {}, characterRenderKey: '', recall: {}, recallRequest: 0, usage: null, usageError: '', life: null, lifeError: '', proactive: { settings: {}, runtime: {}, recent: [], inbox: { items: [], unreadByRole: {} }, formDirty: false, inboxReady: false, notified: new Set(), readIds: new Set(), typingTimer: null }, zhihu: { config: {}, runtime: {}, recent: [], formDirty: false }, companionTuning: { revision: null, saved: null, draft: null, fields: [], presets: [], preview: null, dirty: false, loading: null, saving: false, previewTimer: null, previewRequest: 0, conflict: false }, chatScroll: { following: true, unseen: false, epoch: 0, tail: '' } };
let toastTimer;
const chatHistory = { role: 'miyue', items: [], selected: new Set(), nextBefore: null, loading: false, deleting: false, request: 0, mutation: 0, deletedIds: new Set() };
function node(tag, className, text) { const n = document.createElement(tag); if (className) n.className = className; if (text !== undefined) n.textContent = text; return n; }
function button(text, className, onClick) { const n = node('button', className, text); n.type = 'button'; n.addEventListener('click', onClick); return n; }
function toast(text, duration = 5500, onClick) { const n = $('#toast'); n.textContent = text; n.hidden = false; n.onclick = onClick || null; n.onkeydown = onClick ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onClick(); } } : null; n.tabIndex = onClick ? 0 : -1; n.classList.toggle('clickable', Boolean(onClick)); clearTimeout(toastTimer); toastTimer = setTimeout(() => { n.hidden = true; n.onclick = null; n.onkeydown = null; }, duration); }
async function api(path, options = {}) {
  const { method = 'GET', body, raw = false, headers = {}, timeout = 95000 } = options;
  const response = await fetch(path, { method, headers: { ...(method !== 'GET' && !raw ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? (method === 'GET' ? undefined : '{}') : raw ? body : JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  let result; try { result = await response.json(); } catch { throw Object.assign(new Error('本地服务返回了无法读取的响应，请稍后重试。'),{code:'LOCAL_RESPONSE_INVALID',status:response.status}); }
  if (response.status === 401 && result?.code === 'AUTH_REQUIRED') { location.replace(`/login?next=${encodeURIComponent(location.pathname + location.search)}`); throw Object.assign(new Error('需要先登录'), { code: 'AUTH_REQUIRED', status: 401 }); }
  if (!response.ok) { const error = new Error(result.error || '操作未完成，请稍后重试。'); error.code = result.code; error.status = response.status; throw error; }
  return result;
}
function action(fn) { return async (...args) => { try { await fn(...args); } catch (error) { toast(error.name === 'TimeoutError' ? '等待超时，后台可能仍在处理，请稍后刷新查看。' : error.message || '操作未完成。'); } }; }
const desktopControl = createDesktopControl({ api, toast });
const companionDynamicsSettings = createCompanionDynamicsSettings({ api, toast });
function roleById(id = state.role) { return state.roles.find(r => r.id === id); }
function roleName(roleOrId = state.role) { const role = typeof roleOrId === 'string' ? roleById(roleOrId) : roleOrId; if (role?.id === 'miyue' || roleOrId === 'miyue') return '林晓薇'; if (['wenxi', 'zhixia'].includes(typeof roleOrId === 'string' ? roleOrId : role?.id)) return '已移除角色'; return role?.name || (typeof roleOrId === 'string' ? roleOrId : '角色'); }
function dateText(value, withTime = false) { const date = new Date(value); return !value||Number.isNaN(date.valueOf()) ? '时间未提供' : date.toLocaleString('zh-CN', withTime ? { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' } : { month: 'long', day: 'numeric' }); }
function scopeText(scope) { return scope === 'shared' ? '共享记忆' : `只告诉${roleName(scope)}`; }
function empty(title, text) { const n = node('div', 'empty-state'); n.append(node('h3', '', title), node('p', '', text)); return n; }
function safeLink(url, text) { const a = node('a', '', text); try { const u = new URL(url); if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password) throw new Error(); a.href = u.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; } catch { a.removeAttribute('href'); } return a; }

const appearance = { replyPace: 'natural', avatars: {} };
let preferencesBusy = false;
let historyWindowDirty = false;
let historyWindowSaving = false;
let historyWindowRevision = 0;
function avatarNode(role, extraClass = '', override) {
  const avatar = node('span', `avatar ${extraClass}`, roleName(role).slice(-1));
  avatar.style.setProperty('--role-color', role.color);
  const source = override === undefined ? appearance.avatars[role.id] : override;
  if (source) { const img = node('img'); img.alt = `${roleName(role)}的头像`; img.src = source; img.addEventListener('error',()=>{avatar.replaceChildren(document.createTextNode(roleName(role).slice(-1)));},{once:true}); avatar.replaceChildren(img); }
  return avatar;
}
function refreshAvatars() { renderRoles(); renderNavigation(); if (state.view === 'chat') renderChat(true); }
async function loadPreferences() {
  const requestedHistoryRevision = historyWindowRevision;
  const preferences = await api('/api/preferences', {timeout:15000});
  const { historyWindowDays, historyMaxTokens, ...otherPreferences } = preferences;
  Object.assign(appearance, otherPreferences);
  $('#reply-pace').value = appearance.replyPace;
  $('#preferences-status').textContent = appearance.replyPace === 'instant' ? '当前为即时回复。' : '当前为自然节奏。生成较慢时会直接显示，不再叠加等待。';
  if (!historyWindowDirty && !historyWindowSaving && requestedHistoryRevision === historyWindowRevision) {
    if (historyWindowDays !== undefined) appearance.historyWindowDays = historyWindowDays;
    if (historyMaxTokens !== undefined) appearance.historyMaxTokens = historyMaxTokens;
    if (historyWindowDays !== undefined) $('#history-window-days').value = historyWindowDays;
    if (historyMaxTokens !== undefined) $('#history-max-tokens').value = historyMaxTokens;
  }
  renderAvatarEditors(); refreshAvatars();
  await loadDailyMemory();
}
let dailyMemoryDirty=false;
let dailyMemoryEnabled=false;
async function loadDailyMemory() {
  const value=await api('/api/daily-memory?brief=1',{timeout:15000});
  dailyMemoryEnabled=value.settings.enabled;
  if(!dailyMemoryDirty){$('#daily-memory-enabled').checked=value.settings.enabled;$('#daily-memory-time').value=value.settings.time;}
  $('#history-window-days').readOnly=value.settings.enabled;
  $('#daily-memory-status').textContent=`${value.settings.enabled?'已开启，每天 '+value.settings.time+'（北京时间）由配置的 AI 模型整理，02:00后交互前自动补齐':'按日整理已关闭'}。已整理 ${value.sourceMessages} 条原话，${value.days.length} 天；待整理 ${value.pendingMessages} 条。${value.lastError||''}`;
}
async function saveDailyMemory() {
  await api('/api/daily-memory/settings',{method:'POST',body:{enabled:$('#daily-memory-enabled').checked,time:$('#daily-memory-time').value}});
  dailyMemoryDirty=false;await loadPreferences();
}
async function runDailyMemory() {
  $('#daily-memory-status').textContent='配置的 AI 模型正在整理较早对话并检查核心内容…';
  const value=await api('/api/daily-memory/compress',{method:'POST',body:{role:'miyue'},timeout:130000});await loadDailyMemory();
  if(value.status==='failed')throw new Error('压缩未通过检查或模型暂不可用，原文保留，稍后重试。');
  toast(value.status==='partial'?`已整理 ${value.sourceCount} 条，后台会继续处理余下内容。`:value.status==='updated'?`已整理 ${value.sourceCount} 条原话，保留 ${value.items} 项核心记录。`:'当前正在对话、未开启整理或模型尚未配置，请稍后重试。');
}
async function saveHistoryWindow() {
  if (historyWindowSaving) return;
  const daysInput = $('#history-window-days');
  const tokensInput = $('#history-max-tokens');
  const status = $('#history-window-status');
  const daysText = daysInput.value.trim();
  const tokensText = tokensInput.value.trim();
  if (!daysText) { status.textContent = '请填写窗口天数（1–30）。'; return; }
  if (!tokensText) { status.textContent = '请填写最大 token 数（1,000–200,000）。'; return; }
  const days = Number(daysText), maxTokens = Number(tokensText);
  if (!Number.isSafeInteger(days) || days < 1 || days > 30) { status.textContent = '窗口天数须为 1–30 的整数。'; return; }
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1000 || maxTokens > 200000) { status.textContent = '最大 token 数须为 1,000–200,000 的整数。'; return; }
  const button = $('#save-history-window');
  historyWindowRevision += 1;
  historyWindowSaving = true; button.disabled = true; daysInput.disabled = true; tokensInput.disabled = true;
  try {
    Object.assign(appearance, await api('/api/preferences', { method: 'POST', body: { historyWindowDays: days, historyMaxTokens: maxTokens } }));
    daysInput.value = appearance.historyWindowDays;
    tokensInput.value = appearance.historyMaxTokens;
    historyWindowDirty = false;
    status.textContent = `已保存：林晓薇从下一条日常聊天起使用${dailyMemoryEnabled?'当日00:00起的原文＋历史核心记录':`最近 ${appearance.historyWindowDays} 天的原文`}，原文历史预算最多 ${appearance.historyMaxTokens.toLocaleString()} token。`;
  } catch (error) { status.textContent = error.message || '保存失败，请稍后重试。'; }
  finally { historyWindowSaving = false; button.disabled = false; daysInput.disabled = false; tokensInput.disabled = false; }
}
async function saveReplyPace() {
  if (preferencesBusy) return;
  preferencesBusy = true; $('#reply-pace').disabled = true;
  try { Object.assign(appearance, await api('/api/preferences',{method:'POST',body:{replyPace:$('#reply-pace').value}})); $('#preferences-status').textContent = '已保存，从下一条消息开始生效。'; }
  catch(error) { $('#reply-pace').value = appearance.replyPace; throw error; }
  finally { preferencesBusy=false; $('#reply-pace').disabled=false; }
}
async function prepareAvatar(file) {
  if (!['image/jpeg','image/png','image/webp'].includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 图片。');
  if (file.size > 8*1024*1024) throw new Error('图片超过 8 MB，请选择小一些的图片。');
  const url=URL.createObjectURL(file);
  try {
    const img=new Image(); img.src=url; await img.decode();
    if (!img.naturalWidth || !img.naturalHeight || img.naturalWidth*img.naturalHeight > 64000000) throw new Error('图片尺寸过大，请先缩小图片。');
    const canvas=document.createElement('canvas');canvas.width=512;canvas.height=512;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#fff8f2';ctx.fillRect(0,0,512,512);
    const side=Math.min(img.naturalWidth,img.naturalHeight);ctx.drawImage(img,(img.naturalWidth-side)/2,(img.naturalHeight-side)/2,side,side,0,0,512,512);
    return canvas.toDataURL('image/jpeg',.88);
  } catch(error) { if(error.name==='EncodingError')throw new Error('无法读取这张图片，请换一张试试。'); throw error; }
  finally { URL.revokeObjectURL(url); }
}
function renderAvatarEditors() {
  const list=$('#avatar-editors');list.replaceChildren();
  for(const role of state.roles) {
    const card=node('div','avatar-editor');card.dataset.avatarRole=role.id;
    const preview=node('div','avatar-preview');preview.append(avatarNode(role,'avatar-large'));
    const copy=node('div','avatar-editor-copy');copy.append(node('strong','',roleName(role)),node('small','',role.title));
    const input=node('input');input.type='file';input.accept='image/jpeg,image/png,image/webp';input.id=`avatar-file-${role.id}`;input.setAttribute('aria-label',`选择${roleName(role)}的头像`);
    const note=node('p','fine-print',''),controls=node('div','form-row wrap');
    let draft=null,busy=false;
    const save=button('保存头像','small-button',action(async()=>{if(busy||!draft)return;busy=true;disable(true);try{Object.assign(appearance,await api('/api/preferences',{method:'POST',body:{roleId:role.id,avatar:draft}}));draft=null;input.value='';note.textContent='头像已保存。';refreshAvatars();}finally{busy=false;disable(false)}}));save.disabled=true;
    const reset=button('恢复默认','text-button',action(async()=>{if(busy)return;busy=true;disable(true);try{Object.assign(appearance,await api('/api/preferences',{method:'POST',body:{roleId:role.id,avatar:null}}));draft=null;input.value='';preview.replaceChildren(avatarNode(role,'avatar-large'));note.textContent='已恢复默认头像。';refreshAvatars();}finally{busy=false;disable(false)}}));
    function disable(value){input.disabled=value;save.disabled=value||!draft;reset.disabled=value||(!appearance.avatars[role.id]&&!draft);}
    input.addEventListener('change',action(async()=>{const file=input.files[0];if(!file||busy)return;busy=true;disable(true);try{draft=await prepareAvatar(file);preview.replaceChildren(avatarNode(role,'avatar-large',draft));note.textContent='这是裁切预览，点击“保存头像”应用。';}finally{busy=false;disable(false)}}));
    disable(false);controls.append(save,reset);copy.append(input,controls,note);card.append(preview,copy);list.append(card);
  }
}

const defaultBackground = () => ({image:null,mode:'cover',position:'center',veil:.35,blur:0});
const pageBackground = {saved:defaultBackground(),draft:defaultBackground(),loaded:false,busy:false,dirty:false,loading:null};
function paintBackground(imageLayer,veilLayer,config) {
  imageLayer.style.backgroundImage=config.image ? `url("${config.image}")` : 'none';
  imageLayer.style.backgroundSize=({cover:'cover',contain:'contain',stretch:'100% 100%',tile:'320px auto'})[config.mode];
  imageLayer.style.backgroundRepeat=config.mode==='tile'?'repeat':'no-repeat';
  imageLayer.style.backgroundPosition=({center:'center',top:'center top',bottom:'center bottom'})[config.position];
  imageLayer.style.filter=`blur(${config.blur}px)`;
  veilLayer.style.backgroundColor=`rgba(255, 251, 245, ${config.veil})`;
}
function applyBackground(config) {
  document.body.classList.toggle('has-page-background',Boolean(config.image));$('#page-background').hidden=!config.image;
  paintBackground($('#page-background-image'),$('#page-background-veil'),config);
  paintBackground($('.background-preview-image'),$('.background-preview-veil'),config);
  $('#background-preview span').textContent=config.image?'聊天文字仍有清晰的底色':'当前为默认背景';
}
function renderBackgroundSettings() {
  const {draft,loaded,busy,dirty}=pageBackground;
  $('#background-mode').value=draft.mode;$('#background-position').value=draft.position;
  $('#background-veil').value=Math.round(draft.veil*100);$('#background-veil-value').value=`${Math.round(draft.veil*100)}%`;
  $('#background-blur').value=draft.blur;$('#background-blur-value').value=`${draft.blur} px`;
  for(const id of ['background-file','background-mode','background-position','background-veil','background-blur'])$('#'+id).disabled=!loaded||busy;
  $('#save-background').disabled=!loaded||busy||!dirty;$('#cancel-background').disabled=!loaded||busy||!dirty;
  $('#reset-background').disabled=!loaded||busy||(!draft.image&&!pageBackground.saved.image);
}
async function loadBackground() {
  if(pageBackground.loaded){renderBackgroundSettings();return;}
  if(pageBackground.loading)return pageBackground.loading;
  pageBackground.loading=(async()=>{
    try{const value=await api('/api/background',{timeout:15000});pageBackground.saved=value;pageBackground.draft={...value};pageBackground.loaded=true;applyBackground(value);$('#background-status').textContent='背景只保存在本机，不发送给对话模型。';}
    catch(error){$('#background-status').textContent='背景设置读取失败，请重新进入设置重试。';throw error;}
    finally{pageBackground.loading=null;renderBackgroundSettings();}
  })();return pageBackground.loading;
}
async function prepareBackground(file) {
  if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw new Error('请选择 JPG、PNG 或 WebP 图片。');
  if(file.size>12*1024*1024)throw new Error('图片超过 12 MB，请选择小一些的图片。');
  const url=URL.createObjectURL(file);
  try{
    const img=new Image();img.src=url;await img.decode();
    if(!img.naturalWidth||!img.naturalHeight||img.naturalWidth*img.naturalHeight>64000000)throw new Error('图片尺寸过大，请先缩小图片。');
    const scale=Math.min(1,1920/Math.max(img.naturalWidth,img.naturalHeight));const canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(img.naturalWidth*scale));canvas.height=Math.max(1,Math.round(img.naturalHeight*scale));
    const ctx=canvas.getContext('2d');ctx.fillStyle='#fff8f2';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);
    for(const quality of [.88,.76,.64]){const data=canvas.toDataURL('image/jpeg',quality);if(data.length<2700000)return data;}
    throw new Error('处理后图片仍过大，请换一张尺寸较小的图片。');
  }catch(error){if(error.name==='EncodingError')throw new Error('无法读取这张图片，请换一张试试。');throw error;}finally{URL.revokeObjectURL(url);}
}
function editBackground() {
  if(!pageBackground.loaded||pageBackground.busy)return;
  Object.assign(pageBackground.draft,{mode:$('#background-mode').value,position:$('#background-position').value,veil:Number($('#background-veil').value)/100,blur:Number($('#background-blur').value)});
  pageBackground.dirty=true;applyBackground(pageBackground.draft);renderBackgroundSettings();$('#background-status').textContent='正在预览，保存后才会在下次打开时使用。';
}
async function chooseBackground() {
  const file=$('#background-file').files[0];if(!file||pageBackground.busy||!pageBackground.loaded)return;
  pageBackground.busy=true;renderBackgroundSettings();
  try{pageBackground.draft.image=await prepareBackground(file);pageBackground.dirty=true;applyBackground(pageBackground.draft);$('#background-status').textContent='图片已准备好，调整显示方式后点击保存。';}finally{pageBackground.busy=false;$('#background-file').value='';renderBackgroundSettings();}
}
async function saveBackground(reset=false) {
  if(pageBackground.busy||!pageBackground.loaded)return;
  pageBackground.busy=true;renderBackgroundSettings();
  try{const value=await api('/api/background',{method:'POST',body:reset?defaultBackground():pageBackground.draft});pageBackground.saved=value;pageBackground.draft={...value};pageBackground.dirty=false;applyBackground(value);$('#background-status').textContent=reset?'已恢复默认背景。':'背景已保存。';}finally{pageBackground.busy=false;renderBackgroundSettings();}
}
function cancelBackground(){if(pageBackground.busy)return;pageBackground.draft={...pageBackground.saved};pageBackground.dirty=false;applyBackground(pageBackground.saved);renderBackgroundSettings();$('#background-status').textContent='已取消预览，恢复上次保存的背景。';}

function sameTuningValues(a, b) { return JSON.stringify(a || {}) === JSON.stringify(b || {}); }
function tuningValues() { return { ...(state.companionTuning.draft || {}) }; }
function cancelTuningPreview() { const tuning = state.companionTuning; clearTimeout(tuning.previewTimer); tuning.previewTimer = null; tuning.previewRequest++; }
function renderTuningPreview() {
  const tuning = state.companionTuning, ready = Boolean(tuning.draft && tuning.fields.length), preview = tuning.preview;
  $('#companion-tuning-preview').textContent = preview?.text || (ready ? '调整滑杆后，这里会显示本地生成的示例。' : '正在准备本地示例…');
  const notes = $('#companion-tuning-notes'); notes.replaceChildren(); for (const note of preview?.notes || []) notes.append(node('li', '', note));
}
function renderCompanionTuning() {
  const tuning = state.companionTuning, fields = $('#companion-tuning-fields');
  if (!fields) return;
  const ready = Boolean(tuning.draft && tuning.fields.length);
  $('#companion-tuning-badge').textContent = tuning.saving ? '正在保存' : tuning.conflict ? '有更新待处理' : tuning.dirty ? '尚未保存' : ready ? '已保存' : '正在读取';
  const presets = $('#companion-tuning-presets'); presets.replaceChildren();
  for (const preset of tuning.presets) {
    const item = button(preset.label, 'tuning-preset', () => applyTuningPreset(preset));
    item.disabled = !ready || tuning.saving;
    item.classList.toggle('active', sameTuningValues(preset.values, tuning.draft));
    presets.append(item);
  }
  fields.replaceChildren();
  for (const field of tuning.fields) {
    const value = Number(tuning.draft?.[field.key] ?? 50);
    const row = node('div', 'tuning-field');
    const heading = node('div', 'tuning-field-heading');
    const label = node('label', '', field.label); label.htmlFor = `companion-tuning-${field.key}`;
    const output = node('output', '', `${value}`); output.htmlFor = `companion-tuning-${field.key}`;
    heading.append(label, output); row.append(heading);
    if (field.description) row.append(node('p', 'fine-print', field.description));
    const control = node('div', 'tuning-range-row');
    const low = node('small', '', field.low || '低'); const input = node('input');
    input.type = 'range'; input.id = `companion-tuning-${field.key}`; input.min = '0'; input.max = '100'; input.step = '1'; input.value = String(value); input.disabled = !ready || tuning.saving;
    input.setAttribute('aria-label', `${field.label}，当前 ${value}，范围 0 到 100`);
    input.addEventListener('input', () => { tuning.draft[field.key] = Number(input.value); tuning.dirty = !sameTuningValues(tuning.draft, tuning.saved); output.value = input.value; output.textContent = input.value; input.setAttribute('aria-label', `${field.label}，当前 ${input.value}，范围 0 到 100`); renderCompanionTuningControls(); queueTuningPreview(); });
    control.append(low, input, node('small', '', field.high || '高')); row.append(control); fields.append(row);
  }
  renderTuningPreview();
  renderCompanionTuningControls();
}
function renderCompanionTuningControls() {
  const tuning = state.companionTuning, ready = Boolean(tuning.draft && tuning.fields.length);
  $('#companion-tuning-badge').textContent = tuning.saving ? '正在保存' : tuning.conflict ? '有更新待处理' : tuning.dirty ? '尚未保存' : ready ? '已保存' : '正在读取';
  $$('.tuning-preset, .tuning-range-row input', $('#companion-tuning')).forEach(control => { control.disabled = !ready || tuning.saving; });
  $('#save-companion-tuning').disabled = !ready || tuning.saving || !tuning.dirty;
  $('#restore-companion-defaults').disabled = !ready || tuning.saving || !tuning.presets.some(preset => preset.id === 'default');
  $('#reload-companion-tuning').hidden = !tuning.conflict;
  $('#reload-companion-tuning').disabled = tuning.saving;
}
// "她是谁": fields come from the server, list fields are one item per line.
const persona = {
  fields: {},
  async load() {
    const data = await api('/api/persona'); this.fields = data.fields;
    const box = $('#persona-fields'); box.replaceChildren();
    for (const [key, field] of Object.entries(data.fields)) {
      const label = node('label', 'full', field.label);
      const input = document.createElement('textarea'); input.id = `persona-${key}`; input.rows = field.list ? 4 : 2; input.placeholder = field.hint;
      const value = data.values[key]; input.value = Array.isArray(value) ? value.join('\n') : value || '';
      label.append(input); box.append(label);
    }
    $('#persona-badge').textContent = data.savedAt ? '已自定义' : '默认设定';
  },
  async save() {
    const values = Object.fromEntries(Object.keys(this.fields).map(key => [key, $(`#persona-${key}`).value]));
    await api('/api/persona', { method: 'POST', body: { values } }); await this.load(); toast('她的设定已保存，下一条回复开始生效。');
  },
};

// Identity switch and read-only views of her week, the ledger and the weekly report.
const aliveness = {
  identity: null,
  async load() {
    this.identity = await api('/api/companion-identity');
    for (const input of document.querySelectorAll('input[name="companion-identity"]')) input.checked = input.value === this.identity.mode;
    $('#identity-badge').textContent = this.identity.mode === 'ai' ? 'AI' : '真人';
  },
  async set(mode) {
    if (!this.identity || mode === this.identity.mode) return;
    if (!confirm(mode === 'ai' ? '切换成 AI 身份？她会以住在你 Mac 里的 AI 的身份和你聊天。' : '切换回真人身份？')) { await this.load(); return; }
    this.identity = await api('/api/companion-identity', { method: 'POST', body: { mode, revision: this.identity.revision } });
    await this.load(); toast(mode === 'ai' ? '已切换为 AI 身份，这周的故事会重写。' : '已切换回真人身份。');
  },
  show(text) { const out = $('#aliveness-output'); out.hidden = false; out.textContent = text; },
  async story() {
    const snap = await api('/api/story-arcs'), progress = snap.progress;
    if (!progress) return this.show(snap.status === 'failed' ? `这周的故事生成失败：${snap.lastError || ''}` : '这周的故事还没写好，凌晨两点后会自动生成。');
    this.show([`${progress.week} 这一周（${snap.identity === 'ai' ? 'AI' : '真人'}）`, ...progress.arcs.map(arc => [`· ${arc.title}：${arc.setup}`, ...arc.happened.map(b => `  ${b.day.slice(5)} ${b.text}`), ...arc.today.map(b => `  今天 ${b.text}（${b.feeling}）`), arc.choice ? `  拿不定：${arc.choice.question}` : '', arc.ending ? `  结果：${arc.ending}` : ''].filter(Boolean).join('\n')), progress.questions.length ? `在琢磨：${progress.questions.join('；')}` : ''].filter(Boolean).join('\n\n'));
  },
  async ledger() {
    const snap = await api('/api/relationship-ledger'), open = snap.open || {};
    const lines = [['moment', '值得回味的时刻'], ['ritual', '你们的小习惯'], ['state', '他这几天'], ['skill', '他擅长的'], ['advice', '他出过的主意'], ['promise', '说好的事'], ['joke', '梗'], ['debate', '没聊完的分歧'], ['view', '他的看法'], ['curiosity', '她想知道的'], ['invite', '想邀他做的小事']].map(([kind, label]) => `${label}：${(open[kind] || []).map(item => item.kind === 'debate' ? `${item.topic}（她：${item.her}；他：${item.his}）` : item.area ? `${item.area}：${item.text}` : item.about ? `${item.about}：${item.text}${item.appliedArc && item.appliedArc !== 'none' ? '（已用进她的故事）' : ''}` : item.topic ? `${item.topic}：${item.text}` : item.text).join('；') || '暂无'}`);
    const interests = (snap.interests || []).map(item => `${item.topic}${item.score >= 0 ? '+' : ''}${Math.round(item.score * 10) / 10}`).join('、');
    this.show([`上次整理：${snap.lastThrough ? new Date(snap.lastThrough).toLocaleString() : '还没有'}${snap.lastError ? `（${snap.lastError}）` : ''}`, ...lines, `他来劲的话题（越大越来劲）：${interests || '还在学'}`].join('\n'));
  },
  async report() { this.show((await api('/api/weekly-report?format=md')).markdown); },
  async affect() {
    const [{ state, recent }, look] = await Promise.all([api('/api/affect'), api('/api/appearance').catch(() => null)]), n = value => Math.round(value);
    const names = { warm: '温暖', tender: '温柔', teasing: '逗她', flirty: '撩她', neutral: '平常', distant: '冷淡', dismissive: '敷衍', apologetic: '道歉', hurtful: '伤到她' };
    this.show([`被他暖到 ${n(state.warmth)} · 委屈 ${n(state.hurt)} · 想亲近 ${n(state.desire)} · 安全感 ${n(state.security)}（0–100，会随时间回到平常）`,
      ...(state.causes || []).map(cause => `因为：${cause.why}`),
      ...(look?.mood ? [`桌面上的她：${look.mood.label}${look.mood.why ? `（${look.mood.why}）` : ''}，${look.current.poseId} / ${look.current.expressionId}`] : []), '最近他的消息带给她的：', ...recent.map(item => `${new Date(item.at).toLocaleString()} ${names[item.appraisal.towardHer] || item.appraisal.towardHer}${item.appraisal.intimacy !== 'none' ? ` · 亲密：${item.appraisal.intimacy}` : ''}${item.appraisal.why ? ` · ${item.appraisal.why}` : ''}`)].join('\n'));
  },
  async loadDisplay() {
    const display = await api('/api/chat-display');
    $('#chat-display-note').textContent = display.since ? `聊天页从 ${new Date(display.since).toLocaleString()} 开始显示，之前的 ${display.archivedCount} 条已归档（没有删除，聊天页顶部可以打开）。她也不再翻读归档里的原话，整理过的记录不受影响。` : '聊天页显示全部历史。';
  },
  async setDisplay(since) {
    if (since === 'now' && !confirm('把现在之前的聊天都收进归档？聊天页从现在开始显示，旧记录不会删除。')) return;
    await api('/api/chat-display', { method: 'POST', body: { since } });
    state.chatArchived = {}; await this.loadDisplay(); toast(since ? '已归档，聊天页从现在开始。' : '已恢复显示全部历史。');
  },
};

async function loadCompanionTuning({ force = false } = {}) {
  const tuning = state.companionTuning;
  if (tuning.saving) return;
  if (tuning.loading) { await tuning.loading; if (!force) return; }
  tuning.loading = (async () => {
    const result = await api('/api/companion-tuning', { timeout: 15000 });
    if (tuning.saving) return;
    tuning.fields = result.fields || tuning.fields;
    tuning.presets = result.presets || tuning.presets;
    if (force || !tuning.dirty) { cancelTuningPreview(); tuning.revision = result.revision; tuning.saved = { ...(result.values || {}) }; tuning.draft = { ...(result.values || {}) }; tuning.preview = result.preview || tuning.preview; tuning.dirty = false; tuning.conflict = false; $('#companion-tuning-status').textContent = '已读取本地保存的相处偏好。'; renderCompanionTuning(); }
    else { renderCompanionTuningControls(); }
  })();
  try { return await tuning.loading; } finally { tuning.loading = null; }
}
function queueTuningPreview() {
  const tuning = state.companionTuning; clearTimeout(tuning.previewTimer); const request = ++tuning.previewRequest;
  tuning.previewTimer = setTimeout(async () => {
    try { const result = await api('/api/companion-tuning/preview', { method: 'POST', body: { values: tuningValues() }, timeout: 15000 }); if (request !== tuning.previewRequest) return; tuning.preview = result; renderTuningPreview(); }
    catch (error) { if (request === tuning.previewRequest) $('#companion-tuning-status').textContent = `示例未更新：${error.message}`; }
  }, 250);
}
function applyTuningPreset(preset) {
  const tuning = state.companionTuning; if (tuning.saving) return;
  tuning.draft = { ...preset.values }; tuning.dirty = !sameTuningValues(tuning.draft, tuning.saved);
  $('#companion-tuning-status').textContent = `已套用“${preset.label}”，点击保存后才会生效。`;
  renderCompanionTuning(); queueTuningPreview();
}
async function saveCompanionTuning() {
  const tuning = state.companionTuning; if (!tuning.dirty || tuning.saving) return;
  cancelTuningPreview(); tuning.saving = true; renderCompanionTuningControls();
  try {
    const result = await api('/api/companion-tuning', { method: 'POST', body: { revision: tuning.revision, values: tuningValues() }, timeout: 15000 });
    tuning.revision = result.revision; tuning.saved = { ...(result.values || tuning.draft) }; tuning.draft = { ...tuning.saved }; tuning.preview = result.preview || tuning.preview; tuning.dirty = false; tuning.conflict = false; renderTuningPreview();
    $('#companion-tuning-status').textContent = '已保存，从林晓薇下一次回复开始生效。'; toast('林晓薇的相处偏好已保存。');
  } catch (error) {
    if (error.status === 409) { tuning.conflict = true; $('#companion-tuning-status').textContent = '保存时发现已有更新。你的调整仍保留；请重新读取已保存的设置后再决定。'; renderCompanionTuningControls(); return; }
    throw error;
  } finally { tuning.saving = false; renderCompanionTuningControls(); }
}

function renderRoles() {
  const list = $('#roles'); list.replaceChildren();
  for (const role of state.roles) {
    const b = button('', 'role-button', action(() => selectRole(role.id))); b.dataset.role = role.id;
    const name = roleName(role), av = avatarNode(role);
    const copy = node('span'); copy.append(node('strong', '', name)); const unread = Number(state.proactive.inbox.unreadByRole?.[role.id] || 0); if (unread) copy.append(node('i', 'unread-badge', unread > 9 ? '9+' : String(unread))); b.append(av, copy); list.append(b);
  }
}
const companionshipPage = createCompanionshipPage({api,node,button,action,toast,onTuning:async()=>{await showView('settings');$('#companion-tuning').scrollIntoView({block:'start'});}});
const views = { companionship: ['慢慢积累的相处', '相处与约定'], chat: ['', ''], content: ['读到的东西', '一起看看'], memory: ['属于你的记忆', '记得的事'], life: ['林晓薇的近况', '生活足迹'], usage: ['本地服务记录', '用量'], reminders: ['有约定的主动联系', '留到以后聊'], proactive: ['给你留一盏灯', '主动陪伴'], settings: ['让服务适合你', '设置'] };
function renderNavigation() {
  const role = roleById();
  $$('.role-button').forEach(b => { const on = state.view === 'chat' && b.dataset.role === state.role; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
  $$('[data-view]').forEach(b => b.classList.toggle('active', b.dataset.view === state.view));
  $$('.view').forEach(el => { el.hidden = el.id !== `view-${state.view}`; });
  $('#view-title').textContent = state.view === 'chat' ? roleName(role) : views[state.view][1];
  $('#view-kicker').textContent = state.view === 'chat' ? role?.title || '' : views[state.view][0];
  $('#top-hint').textContent = state.view === 'chat' ? '隔着屏幕，也能慢慢熟悉' : '本地保存 · 随时继续';
  $('#setup-shortcut').hidden = Boolean(state.provider.configured) || state.view === 'settings';
  document.documentElement.style.setProperty('--accent', role?.color || '#a56675');
  $('#open-character').hidden = state.view !== 'chat';
  $('#open-chat-history').hidden = state.view !== 'chat' || state.role !== 'miyue';
  renderAside();
}
async function selectRole(id) { if (!roleById(id)) return; state.role = id; state.chatScroll.following = true; state.chatScroll.unseen = false; state.chatScroll.tail = ''; state.chatScroll.epoch++; updateChatScrollButton(); state.lifeChoice = null; state.content = null; renderContext(); await showView('chat'); }
async function showView(view) {
  state.view = view; renderNavigation();
  if (view === 'chat') { renderChat(); await Promise.all([loadChat(), loadCharacter()]); }
  else if (view === 'content') { await Promise.all([loadContent(),loadTopics()]); loadZhihu(false).catch(() => {}); }
  else if (view === 'memory') { await loadMemories(); renderMemories(); await Promise.all([loadRecall(state.role), loadEpisodes(state.role)]); }
  else if (view === 'companionship') await companionshipPage.load();
  else if (view === 'life') await Promise.all([loadLife(),loadMoments()]);
  else if (view === 'usage') await loadUsage();
  else if (view === 'reminders') await Promise.all([loadReminders(),loadFollowups()]);
  else if (view === 'proactive') { await loadProactiveStatus(true); renderProactive(true); }
  else if (view === 'settings') { await Promise.all([loadPreferences(),loadBackground(),loadCompanionTuning(),companionDynamicsSettings.load(),desktopControl.load(),aliveness.load().catch(() => {}),aliveness.loadDisplay().catch(() => {}),persona.load().catch(() => {})]); renderProvider(); renderZhihu(true); loadZhihu(true).catch(() => {}); loadLife(true).catch(() => {}); await loadVoice(); }
}
function renderQuiet() {
  $('#quiet').checked = Boolean(state.settings.quiet);
  $('#quiet-note').textContent = state.settings.quiet ? '主动联系暂时延后，内容继续收集。' : '有新话题时，也会主动找你。';
  const mobile = $('#mobile-quiet'); if (mobile) mobile.checked = Boolean(state.settings.quiet);
}
async function setQuiet(quiet) { const { settings } = await api('/api/settings', { method: 'POST', body: { quiet } }); state.settings = settings; renderQuiet(); toast(quiet ? '已暂时安静，主动联系与提醒会延后。' : '已恢复主动联系与提醒。'); }
function runtimeTime(value) { return value ? dateText(value, true) : '尚未安排'; }
function proactiveReason(reason, runtime = {}) {
  if (runtime.lastError) return '上一次尝试没有完成，详见下方提示。';
  if (runtime.modelConfigured === false) return '内容仍会按计划收集；连接模型后才会由角色主动开场。';
  if (runtime.quiet) return '已开启“暂时安静”，内容仍可收集，联系会等你恢复。';
  const map = { disabled: '主动陪伴已关闭。', outside_active_hours: '正在等待你设定的联系时段。', daily_limit: '今天已经达到你设定的联系次数。', unanswered: '先把空间留给你，等你想回复时再继续。', busy: '你正在聊天或输入，稍后再联系。', no_model: '模型尚未配置，所以不会生成假消息。', no_content: '暂时没有适合分享的内容，之后会再看看。', delivered: '刚刚已留下一条消息。' };
  return map[reason] || reason || '后台会在合适的时间检查内容与联系节奏。';
}
function updateRoleBadges() {
  const unread = state.proactive.inbox.unreadByRole || {}; $('#proactive-count').textContent = state.roles.reduce((sum, role) => sum + Number(unread[role.id] || 0), 0) || '';
  $$('.role-button').forEach(b => { const existing = $('.unread-badge', b); const count = Number(unread[b.dataset.role] || 0); if (existing) existing.remove(); if (count) b.lastElementChild.append(node('i', 'unread-badge', count > 9 ? '9+' : String(count))); });
}
function renderProactive(fillForm = false) {
  const p = state.proactive, s = p.settings, r = p.runtime; updateRoleBadges();
  if (fillForm && !p.formDirty) { $('#proactive-enabled').checked = Boolean(s.enabled); $('#proactive-fetch-interval').value = s.fetchIntervalMinutes ?? 120; $('#proactive-min-gap').value = s.minGapMinutes ?? 60; $('#proactive-max-gap').value = s.maxGapMinutes ?? 120; $('#proactive-daily-limit').value = s.dailyLimit ?? 24; $('#proactive-start').value = s.activeStart || '09:00'; $('#proactive-end').value = s.activeEnd || '23:00'; $('#proactive-topics').value = s.topics || ''; $('#desktop-notifications').checked = Boolean(s.desktopNotifications); }
  $('#proactive-status-badge').textContent = !s.enabled ? '已暂停' : r.thinking ? '正在准备话题' : r.fetching ? '正在收集内容' : !r.modelConfigured ? '需要连接模型' : r.quiet ? '暂时安静' : '按计划进行';
  const grid = $('#proactive-runtime'); grid.replaceChildren(); for (const [label, value] of [['下次收集', runtimeTime(r.nextFetchAt)], ['下次联系', runtimeTime(r.nextContactAt)], ['上次收集', runtimeTime(r.lastFetchAt)], ['上次联系', runtimeTime(r.lastContactAt)]]) { const item = node('div', 'runtime-item'); item.append(node('small', '', label), node('strong', '', value)); grid.append(item); }
  $('#proactive-reason').textContent = proactiveReason(r.lastReason, r) + (r.managedService === false ? ' 当前通过终端运行；关闭进程后会暂停，登录自启尚未启用。' : ' 登录后自动运行；电脑休眠时暂停。'); $('#proactive-error').hidden = !(r.lastError || r.notificationError); $('#proactive-error').textContent = [r.lastError, r.notificationError].filter(Boolean).join('；');
  const notification = s.notifications && window.Notification?.permission === 'granted'; $('#enable-notifications').textContent = notification ? '浏览器提醒已开启' : '开启浏览器提醒'; $('#desktop-notification-note').textContent = r.desktopNotificationsAvailable ? '由本机后台服务发送通用桌面提示；系统权限允许时，页面关闭后仍可提示。' : '当前后台服务未提供桌面提醒；页面关闭后无法承诺收到提示。'; $('#notification-note').textContent = notification ? '浏览器提醒已开启；提示不会显示私密内容。页面关闭后无法承诺仍能收到提醒，也不会自动播放语音。' : '浏览器提醒默认关闭，只有你点击后才会请求授权；页面关闭后无法承诺仍能收到提醒，也不会自动播放语音。';
  const recent = $('#proactive-recent'); recent.replaceChildren(); if (!p.recent.length) recent.append(empty('还没有主动联系记录。', '启用后，后台会在合适的时间留下消息。')); for (const item of p.recent) { const card = node('article', 'recent-item'); card.append(node('span', 'badge', `${roleName(item.role)} · ${item.kind === 'story' ? '故事邀请' : item.kind === 'content' ? '主动分享' : '接着聊'}`), node('p', '', proactiveReason(item.reason))); if (item.sourceTitle) card.append(item.sourceUrl ? safeLink(item.sourceUrl, item.sourceTitle) : node('span', 'source-note', item.sourceTitle)); card.append(node('time', '', dateText(item.createdAt, true))); recent.append(card); }
}
async function loadProactiveStatus(render = false) { const result = await api('/api/proactive', { timeout: 20000 }), visibleRoles = new Set(state.roles.map(role => role.id)); state.proactive.settings = result.settings || {}; state.proactive.runtime = result.runtime || {}; state.proactive.recent = (result.recent || []).filter(item => visibleRoles.has(item.role)); state.proactive.inbox.unreadByRole = Object.fromEntries(Object.entries(result.unreadByRole || {}).filter(([role]) => visibleRoles.has(role))); if (render || state.view === 'proactive') renderProactive(render); else updateRoleBadges(); }
async function saveProactiveSettings(event) { event.preventDefault(); const body = { enabled: $('#proactive-enabled').checked, fetchIntervalMinutes: Number($('#proactive-fetch-interval').value), minGapMinutes: Number($('#proactive-min-gap').value), maxGapMinutes: Number($('#proactive-max-gap').value), dailyLimit: Number($('#proactive-daily-limit').value), activeStart: $('#proactive-start').value, activeEnd: $('#proactive-end').value, topics: $('#proactive-topics').value.trim(), desktopNotifications: $('#desktop-notifications').checked }; const result = await api('/api/proactive/settings', { method: 'POST', body }); state.proactive.settings = result.settings || state.proactive.settings; state.proactive.runtime = result.runtime || state.proactive.runtime; state.proactive.recent = result.recent || state.proactive.recent; state.proactive.formDirty = false; renderProactive(true); toast('主动陪伴设置已保存。'); }
async function runProactiveNow() { const b = $('#proactive-run'); b.disabled = true; b.textContent = '正在看看…'; try { const result = await api('/api/proactive/run', { method: 'POST', timeout: 95000 }); await pollProactive(); if (result.delivered) toast('她已经把话留在会话里了。', 6000, () => selectRole(result.message?.role || state.role)); else toast(proactiveReason(result.reason, state.proactive.runtime)); } finally { b.disabled = false; b.textContent = '现在找我聊一次'; } }
async function enableNotifications() { if (!('Notification' in window)) throw new Error('这个浏览器不支持系统提醒。'); const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission(); if (permission !== 'granted') { toast('没有开启浏览器提醒；你仍会在应用内看到新消息。'); return; } const result = await api('/api/proactive/settings', { method: 'POST', body: { notifications: true } }); state.proactive.settings = result.settings || state.proactive.settings; state.proactive.runtime = result.runtime || state.proactive.runtime; renderProactive(false); toast('浏览器提醒已开启。'); }
async function pollInbox() { const result = await api('/api/inbox', { timeout: 15000 }), visibleRoles = new Set(state.roles.map(role => role.id)); const items = (result.items || []).filter(item => visibleRoles.has(item.role)), previous = new Set(state.proactive.inbox.items.map(item => item.messageId)); state.proactive.inbox = { items, unreadByRole: Object.fromEntries(Object.entries(result.unreadByRole || {}).filter(([role]) => visibleRoles.has(role))) }; updateRoleBadges(); if (state.proactive.inboxReady) for (const item of items) if (!previous.has(item.messageId) && !state.proactive.notified.has(item.messageId)) { state.proactive.notified.add(item.messageId); const open = () => selectRole(item.role); toast(`${roleName(item.role)}给你留了一个话题`, 7000, open); if (state.proactive.settings.notifications && !(state.proactive.settings.desktopNotifications && state.proactive.runtime.desktopNotificationsAvailable) && 'Notification' in window && Notification.permission === 'granted') { const notice = new Notification('有间有新消息', { body: '打开有间查看。' }); notice.onclick = () => { window.focus(); open(); notice.close(); }; } } state.proactive.inboxReady = true; }
async function pollProactive() { try { await Promise.all([loadProactiveStatus(false), pollInbox()]); await markVisibleInboxRead(); } catch { /* Existing chat stays usable during a transient local-service outage. */ } }
async function markVisibleInboxRead() { if (document.visibilityState !== 'visible' || state.view !== 'chat' || !state.proactive.inbox.items.length) return; const role = state.role, scroll = $('#chat-scroll'); if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight > 24) return; const escape = window.CSS?.escape || (value => String(value).replace(/[^a-zA-Z0-9_-]/g, '\\$&')); const candidates = new Map(state.proactive.inbox.items.filter(item => item.role === role && !state.proactive.readIds.has(item.messageId)).map(item => [item.messageId, item])); const rendered = $$('.message[data-message-id]', $('#chat-messages')).map(element => candidates.get(element.dataset.messageId)).filter(Boolean); const last = rendered.at(-1); if (!last) return; state.proactive.readIds.add(last.messageId); try { await api(`/api/conversations/${role}/read`, { method: 'POST', body: { messageId: last.messageId }, timeout: 15000 }); await pollInbox(); } catch (error) { state.proactive.readIds.delete(last.messageId); throw error; } }
function zhihuStatusText() { const { config, runtime } = state.zhihu; const count = runtime.discoveredCount !== undefined ? ` 已发现 ${runtime.discoveredCount} 个公开话题。` : ''; if (!config.enabled) return '知乎资料研究已关闭。' + count; if (runtime.paused) return '主动陪伴已关闭，资料研究暂停。' + count; if (!config.configured) return '等待填写 Access Secret 后检索知乎回答。' + count; if (runtime.running) return '正在从公开热点和知乎观点整理资料…' + count; if (runtime.lastError) return `上次研究未完成：${runtime.lastError}` + count; return runtime.nextRunAt ? `下次自动研究：${dateText(runtime.nextRunAt, true)}。${count}` : '等待下一次研究安排。' + count; }
function renderZhihu(fillForm = false) { const { config: c, runtime } = state.zhihu; const status = zhihuStatusText(); const contentStatus = $('#zhihu-content-status'); if (contentStatus) contentStatus.textContent = status; const headlines = $('#zhihu-headlines'); if (headlines) { headlines.replaceChildren(); for (const item of (runtime.headlines || []).slice(0, 6)) { const row = node('span', 'research-headline'); row.append(item.url ? safeLink(item.url, item.title || '公开话题') : node('span', '', item.title || '公开话题'), node('small', '', ` · ${item.source || '公开来源'}`)); headlines.append(row); } if (runtime.headlines?.length) headlines.prepend(node('small', 'headlines-label', c.configured ? '发现的公开话题：' : '已发现的话题，等待研究：')); } const badge = $('#zhihu-badge'); if (!badge) return; if (fillForm && !state.zhihu.formDirty) { $('#zhihu-enabled').checked = Boolean(c.enabled); $('#zhihu-model').value = c.model || 'zhida-agent'; $('#zhihu-request-limit').value = c.dailyRequestLimit ?? 20; $('#zhihu-agent-limit').value = c.dailyAgentLimit ?? 4; $('#zhihu-topics-per-run').value = c.topicsPerRun ?? 2; $('#zhihu-hot-list').checked = Boolean(c.useHotList); $('#zhihu-news-search').checked = Boolean(c.useNewsSearch); $('#zhihu-secret').value = ''; } badge.textContent = !c.enabled ? '已关闭' : !c.configured ? '待配置' : runtime.running ? '研究中' : '已开启'; $('#zhihu-key-hint').textContent = c.isEnvManaged ? '由环境变量提供' : c.hasKey ? '已保存；留空会保留现有密钥' : '不会回显'; const usage = $('#zhihu-usage'); usage.replaceChildren(); for (const [label, used, limit] of [['今日请求', runtime.requestsToday, c.dailyRequestLimit], ['今日智能体', runtime.agentCallsToday, c.dailyAgentLimit]]) { const cell = node('div', 'runtime-item'); cell.append(node('small', '', label), node('strong', '', `${used ?? 0} / ${limit ?? '—'}`)); usage.append(cell); } const quota = $('#zhihu-quota'); quota.replaceChildren(); for (const item of runtime.quota || []) quota.append(node('div', 'quota-row', `${item.name || item.id}：剩余 ${item.remaining ?? '未提供'} / 共 ${item.total ?? '未提供'}`)); $('#zhihu-result').textContent = runtime.lastError ? `上次研究：${runtime.lastError}` : runtime.lastRunAt ? `上次研究：${dateText(runtime.lastRunAt, true)} · ${runtime.lastReason || '已完成'}` : runtime.quotaCheckedAt ? `额度上次查询：${dateText(runtime.quotaCheckedAt, true)}` : ''; }
async function loadZhihu(fillForm = false) { const result = await api('/api/zhihu', { timeout: 25000 }); state.zhihu.config = result.config || state.zhihu.config; state.zhihu.runtime = { ...state.zhihu.runtime, ...(result.runtime || {}) }; state.zhihu.recent = result.recent || []; renderZhihu(fillForm); }
async function saveZhihu(event) { event.preventDefault(); const body = { enabled: $('#zhihu-enabled').checked, model: $('#zhihu-model').value, dailyRequestLimit: Number($('#zhihu-request-limit').value), dailyAgentLimit: Number($('#zhihu-agent-limit').value), topicsPerRun: Number($('#zhihu-topics-per-run').value), useHotList: $('#zhihu-hot-list').checked, useNewsSearch: $('#zhihu-news-search').checked }; const secret = $('#zhihu-secret').value.trim(); if (secret) body.accessSecret = secret; const result = await api('/api/zhihu/config', { method: 'POST', body }); state.zhihu.config = result.config || state.zhihu.config; state.zhihu.runtime = { ...state.zhihu.runtime, ...(result.runtime || {}) }; state.zhihu.recent = result.recent || state.zhihu.recent; state.zhihu.formDirty = false; renderZhihu(true); toast('知乎资料研究设置已保存。'); }
async function testZhihuQuota() { const button = $('#zhihu-test'); button.disabled = true; $('#zhihu-result').textContent = '正在查询官方额度…'; try { const result = await api('/api/zhihu/test', { method: 'POST', timeout: 30000 }); state.zhihu.runtime = { ...state.zhihu.runtime, quota: result.quota || state.zhihu.runtime.quota, quotaCheckedAt: new Date().toISOString() }; renderZhihu(false); } finally { button.disabled = false; } }
async function refreshZhihu() { const button = $('#zhihu-refresh'); button.disabled = true; button.textContent = '正在研究…'; try { const result = await api('/api/zhihu/refresh', { method: 'POST', body: {}, timeout: 450000 }); state.zhihu.config = result.config || state.zhihu.config; state.zhihu.runtime = { ...state.zhihu.runtime, ...(result.runtime || {}) }; state.zhihu.recent = result.recent || state.zhihu.recent; renderZhihu(false); await loadContent(); toast(result.added ? `已加入 ${result.added} 份知乎资料。` : result.reason || zhihuStatusText()); } finally { button.disabled = false; button.textContent = '立即研究'; } }

// Only the newest part of a long conversation is fetched and rendered; the
// window grows when the reader asks for earlier messages.
const CHAT_PAGE = 120, CHAT_PAGE_STEP = 200;
state.chatWindow = {}; state.chatHasMore = {}; state.chatArchived = {}; state.chatArchive = {};
async function loadChat(silent = false) {
  const role = state.role;
  const mutation = chatHistory.mutation;
  const limit = state.chatWindow[role] || CHAT_PAGE;
  const { messages,pending,hasMore,archivedCount } = await api(`/api/conversations/${role}?limit=${limit}${state.chatArchived[role] ? '&archived=1' : ''}`);
  if (mutation !== chatHistory.mutation || state.role !== role) return;
  const hadMore = state.chatHasMore[role]; state.chatHasMore[role] = Boolean(hasMore);
  const hadArchive = state.chatArchive[role]; state.chatArchive[role] = Number(archivedCount) || 0;
  const oldPending=JSON.stringify(state.pending.get(role));
  if(pending){if(pending.phase!=='idle'||pending.remainingChunks)state.pending.set(role,pending);else state.pending.delete(role);}
  const visibleMessages = messages.filter(message => !chatHistory.deletedIds.has(String(message.id))), previous = state.conversations[role] || [];
  const changed = hadMore !== state.chatHasMore[role] || hadArchive !== state.chatArchive[role] || oldPending!==JSON.stringify(state.pending.get(role)) || previous.length !== visibleMessages.length || previous.at(-1)?.id !== visibleMessages.at(-1)?.id || previous.at(-1)?.text !== visibleMessages.at(-1)?.text;
  state.conversations[role] = visibleMessages;
  if (state.role === role && state.view === 'chat' && (!silent || changed)) renderChat(silent);
}
async function loadEarlierChat() {
  const role = state.role, scroll = $('#chat-scroll'), fromBottom = scroll.scrollHeight - scroll.scrollTop;
  state.chatWindow[role] = (state.chatWindow[role] || CHAT_PAGE) + CHAT_PAGE_STEP;
  state.chatScroll.following = false;
  await loadChat(true);
  if (state.role !== role) return;
  renderChat(true);
  // Keep the message the reader was looking at in place.
  requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight - fromBottom; });
}
function renderChatHistory() {
  const box = $('#chat-history-items'), selectedCount = chatHistory.selected.size;
  box.replaceChildren();
  if (!chatHistory.items.length && !chatHistory.loading) box.append(empty('还没有历史对话。', '发送的消息会按时间保存在这里。'));
  for (const message of chatHistory.items) {
    const id = String(message.id), label = node('label', `chat-history-item ${chatHistory.selected.has(id) ? 'selected' : ''}`), checkbox = node('input');
    checkbox.type = 'checkbox'; checkbox.checked = chatHistory.selected.has(id); checkbox.disabled = chatHistory.loading || chatHistory.deleting || (!checkbox.checked && selectedCount >= 100); checkbox.setAttribute('aria-label', `选择${message.speaker === 'user' ? '你的' : '林晓薇的'}这条消息`);
    checkbox.addEventListener('change', () => { if (checkbox.checked) chatHistory.selected.add(id); else chatHistory.selected.delete(id); renderChatHistory(); });
    const content = node('span', 'chat-history-content'), meta = node('span', 'chat-history-meta');
    meta.append(node('strong', '', message.speaker === 'user' ? '你' : '林晓薇'));
    if (message.kind) meta.append(node('span', 'badge', message.kind));
    const time = node('time', '', message.createdAt || '时间未提供'); if (message.createdAt) time.dateTime = message.createdAt; meta.append(time);
    content.append(meta, node('span', 'chat-history-text', message.text || ''));
    label.append(checkbox, content); box.append(label);
  }
  if (chatHistory.loading) box.append(node('p', 'chat-history-loading', '正在读取历史…'));
  $('#chat-history-selection').textContent = selectedCount ? `已选择 ${selectedCount} 条（每次最多 100 条）` : '尚未选择';
  $('#delete-chat-history').textContent = `删除所选（${selectedCount}）`;
  $('#delete-chat-history').disabled = !selectedCount || chatHistory.loading || chatHistory.deleting;
  const selectAll = $('#select-chat-history-page'), allSelected = Boolean(chatHistory.items.length) && chatHistory.items.every(item => chatHistory.selected.has(String(item.id)));
  selectAll.checked = allSelected; selectAll.indeterminate = !allSelected && chatHistory.items.some(item => chatHistory.selected.has(String(item.id))); selectAll.disabled = !chatHistory.items.length || chatHistory.loading || chatHistory.deleting;
  const older = $('#load-older-chat-history'); older.hidden = chatHistory.nextBefore === null && Boolean(chatHistory.items.length); older.disabled = chatHistory.loading || chatHistory.deleting; older.textContent = chatHistory.loading ? '正在读取…' : '加载更早记录';
}
async function loadChatHistory({ reset = false } = {}) {
  if (chatHistory.loading) return;
  if (reset) { chatHistory.items = []; chatHistory.selected.clear(); chatHistory.nextBefore = null; }
  chatHistory.loading = true; const request = ++chatHistory.request, before = reset ? null : chatHistory.nextBefore; renderChatHistory();
  try {
    const query = new URLSearchParams({ role: chatHistory.role, limit: '50' }); if (before !== null) query.set('before', String(before));
    const result = await api(`/api/chat/history?${query}`, { timeout: 20000 });
    if (request !== chatHistory.request) return;
    const known = new Set(chatHistory.items.map(item => String(item.id)));
    for (const item of result.messages || []) if (!chatHistory.deletedIds.has(String(item.id)) && !known.has(String(item.id))) { chatHistory.items.push(item); known.add(String(item.id)); }
    chatHistory.nextBefore = result.nextBefore ?? null; $('#chat-history-status').textContent = chatHistory.nextBefore === null ? '已显示全部历史记录。' : `已加载 ${chatHistory.items.length} 条，可继续查看更早记录。`;
  } finally { if (request === chatHistory.request) { chatHistory.loading = false; renderChatHistory(); } }
}
async function openChatHistory() {
  const dialog = $('#chat-history-dialog'); if (!dialog.open) dialog.showModal();
  if (chatHistory.deleting) { renderChatHistory(); return; }
  $('#chat-history-status').textContent = ''; await loadChatHistory({ reset: true });
}
async function deleteSelectedChatHistory() {
  if (chatHistory.deleting || !chatHistory.selected.size) return;
  const ids = [...chatHistory.selected], count = ids.length;
  if (count > 100) { $('#chat-history-status').textContent = '每次最多删除 100 条记录，请减少选择后再试。'; return; }
  if (!window.confirm(`将彻底删除所选 ${count} 条历史对话。此操作不可恢复，并会清理这些记录直接衍生的回忆与引用；手动独立记忆会保留。\n\n确定继续吗？`)) return;
  chatHistory.deleting = true; renderChatHistory(); $('#chat-history-status').textContent = `正在删除 ${count} 条记录…`;
  try {
    const result = await api('/api/chat/history/delete', { method: 'POST', body: { role: chatHistory.role, ids }, timeout: 30000 });
    const deleted = new Set((result.deletedIds || []).map(String));
    for (const id of deleted) { chatHistory.deletedIds.add(id); chatHistory.selected.delete(id); }
    chatHistory.items = chatHistory.items.filter(item => !deleted.has(String(item.id)));
    chatHistory.mutation += 1; chatHistory.request += 1;
    const current = state.conversations[chatHistory.role] || []; state.conversations[chatHistory.role] = current.filter(item => !deleted.has(String(item.id)));
    if (state.role === chatHistory.role && state.view === 'chat') renderChat(true);
    $('#chat-history-status').textContent = `已彻底删除 ${result.count ?? deleted.size} 条记录。`;
    await Promise.allSettled([loadChat(true), loadCharacter(chatHistory.role), loadLife(), loadMemories(), loadEpisodes(chatHistory.role)]);
    if (state.view === 'memory') renderMemories();
    if (state.view === 'companionship') await companionshipPage.load();
    await loadChatHistory({ reset: true });
    toast(`已彻底删除 ${result.count ?? deleted.size} 条历史对话。`);
  } catch (error) {
    $('#chat-history-status').textContent = error.code === 'HISTORY_BUSY' ? '当前回复还在处理，请等这轮完成后再删除；已选记录仍然保留。' : `删除没有完成：${error.message || '请稍后重试。'}`;
    throw error;
  } finally { chatHistory.deleting = false; renderChatHistory(); }
}
async function loadCharacter(id = state.role) {
  const mutation = chatHistory.mutation;
  const result = await api(`/api/characters/${id}`, { timeout: 20000 });
  if (mutation !== chatHistory.mutation) return result;
  state.character[id] = result;
  if (result.recall) state.recall[id] = result.recall;
  if (id === state.role) { renderCharacterProfile(); renderAside(); if (state.view === 'memory' && $('#recall-role').value === id) renderRecall(); }
  return result;
}
function profileList(label, values) { const section = node('div', 'profile-field'); section.append(node('dt', '', label)); const dd = node('dd'); for (const value of values || []) dd.append(node('span', 'profile-tag', value)); section.append(dd); return section; }
function renderCharacterProfile() {
  const box = $('#character-profile'), role = roleById(), data = state.character[state.role];
  const renderKey = `${state.role}:${JSON.stringify(data || null)}`;
  if (renderKey === state.characterRenderKey) return;
  state.characterRenderKey = renderKey;
  const wasOpen = $('.profile-details', box)?.open;
  box.replaceChildren(); box.hidden = !data?.profile;
  if (box.hidden) { handleChatLayoutChange(); return; }
  const profile = data.profile, current = data.state || {}, name = roleName(role), hasCurrentState = [current.activity, current.feeling, current.wish, current.updatedAt].some(Boolean);
  const brief = node('div', 'current-state'); if (hasCurrentState) { brief.append(node('span', 'state-dot', '●')); if (current.activity) brief.append(node('strong', '', current.activity)); const words = [current.feeling, current.wish].filter(Boolean); if (words.length) brief.append(node('span', '', words.join(' · '))); if (current.updatedAt) brief.append(node('time', '', `更新于 ${dateText(current.updatedAt, true)}`)); }
  const details = document.createElement('details'); details.className = 'profile-details';
  const summary = node('summary', ''); summary.append(node('span', '', `${name}的资料与此刻`), node('small', '', '展开查看')); details.append(summary,button('设置头像','text-button',action(async()=>{await showView('settings');$('#avatar-settings').scrollIntoView({block:'start'});})));
  const intro = node('p', 'profile-background', profile.background || ''); if (profile.background) details.append(intro);
  const physique = [profile.heightCm ? `身高 ${profile.heightCm} 厘米` : '', profile.weightKg ? `体重 ${profile.weightKg} 公斤` : '', profile.braCup ? `罩杯 ${profile.braCup}` : ''].filter(Boolean).join(' · ');
  if (physique) details.append(node('p', 'profile-background', physique));
  const fields = node('dl', 'profile-grid');
  for (const [label, value] of [['年龄', profile.age], ['职业', profile.occupation], ['住处', profile.home], ['性情', profile.temperament], ['关系', data.life?.companionship?.relationship?.status?.explicit ? data.life.companionship.relationship.status.label : profile.relationship], ['关系进展', current.relationshipStage], ['人物走向', profile.arc]]) if (value) { const item = node('div', 'profile-field'); item.append(node('dt', '', label), node('dd', '', value)); fields.append(item); }
  for (const [label, values] of [['共同经历', profile.sharedPast], ['喜欢', profile.likes], ['不喜欢', profile.dislikes], ['相处中的需要', profile.needs], ['边界', profile.boundaries]]) if (values?.length) fields.append(profileList(label, values));
  if (current.inner) {
    const inner = current.inner, section = node('details', 'inner-details'); section.append(node('summary', '', '内在状态'));
    section.append(node('p', 'fine-print', '状态缓慢影响她的语气和主动话题，不会要求你照顾数值。亲近表达低频出现，用户当前话题优先。'));
    for (const [key, label] of [['affection', '喜欢程度'], ['mood', '心情愉悦度'], ['fatigue', '疲劳'], ['vitality', '活力'], ['hunger', '饥饿'], ['stress', '压力'], ['security', '安心'], ['playfulness', '轻松玩心']]) {
      if (!Number.isFinite(inner[key])) continue;
      const row = node('div', 'inner-meter'), meter = node('meter', ''); meter.min = 0; meter.max = 100; meter.value = inner[key]; meter.setAttribute('aria-label', label); row.append(node('span', '', label), meter, node('small', '', String(inner[key]))); section.append(row);
    }
    for(const [key,label] of [['emotional','心理需要'],['physical','身体亲近愿望']])section.append(node('p','fine-print',`${label}：${inner.needs?.[key]||'暂时没有特别的需要'}`));
    section.append(node('p', 'fine-print', inner.intimacyBoundary === 'friendly' ? '相处距离：保持普通朋友式交流。' : '相处距离：可以偶尔自然亲近，仍以普通交流为主。'));
    section.append(button('查看和调整状态 ↗','text-button',action(()=>showView('companionship'))));
    details.append(section);
  }
  if (state.role === 'miyue') details.append(button('查看历史对话','text-button',action(openChatHistory)),button('相处与约定','text-button',action(()=>showView('companionship'))),button('调整相处偏好', 'text-button', action(async () => { await showView('settings'); $('#companion-tuning').scrollIntoView({ block: 'start', behavior: 'smooth' }); })));
  details.append(fields, node('p', 'profile-simulation-note', '这里展示的是虚构角色的叙事状态，用于互动体验，并非真实人的情绪或健康信息。')); details.open = Boolean(wasOpen); if (hasCurrentState) box.append(brief); box.append(details);
  const life = state.role === 'miyue' ? data.life : null;
  const joint=life?.companionship?.agenda?.plans?.findLast(plan=>plan.owner==='joint'&&['active','paused','awaiting_confirmation'].includes(plan.status));
  if(joint){const activity=node('section','profile-life companionship-current');activity.append(node('small','',joint.status==='paused'?'暂时暂停':joint.status==='awaiting_confirmation'?'等你确认':'正在一起做'),node('strong','',joint.title));if(joint.kind==='quiet'&&joint.status==='active'&&joint.endAt)activity.append(node('p','fine-print',`还剩约 ${Math.max(0,Math.ceil((Date.parse(joint.endAt)-Date.now())/60000))} 分钟 · 不需要一直回复`));if(joint.progress)activity.append(node('p','fine-print',joint.progress));activity.append(button('调整或继续这件事 ↗','text-button',action(()=>showView('companionship'))));box.append(activity);}

  if (life?.active) { const event = life.active, phase = event.phase || {}, travel = life.travel; const card = node('section', 'profile-life'); card.append(node('small', '', '生活足迹'), node('strong', '', event.title || '')); const travelCopy = travel ? [travel.location, travel.status === 'staying' ? `这几天住在${travel.currentCity}` : travel.status === 'returning' ? `正在返回${travel.homeCity || '苏州'}` : travel.status === 'returned' ? `已经回到${travel.homeCity || '苏州'}` : travel.status === 'planned' ? `准备前往${travel.stops?.[0]?.city || '下一站'}` : `正在前往${travel.nextCity || '下一站'}`] : null; const copy = (travelCopy || [event.location, phase.activity, phase.feeling, phase.wish]).filter(Boolean).join(' · '); if (copy) card.append(node('p', '', copy)); card.append(button('查看生活足迹 ↗', 'text-button', action(() => showView('life')))); box.append(card); }
  handleChatLayoutChange();
}
function chatIsNearBottom(scroll = $('#chat-scroll')) { return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 36; }
function chatTailFingerprint() { const messages = state.conversations[state.role] || [], last = messages.at(-1), pending = state.pending.get(state.role); return `${last?.id || last?.createdAt || ''}:${last?.text || ''}:${pending?.phase || ''}:${pending?.remainingChunks || ''}`; }
function updateChatScrollButton() {
  const button = $('#chat-scroll-latest'); if (!button) return;
  button.hidden = !state.chatScroll.unseen || state.chatScroll.following || state.view !== 'chat';
}
function followChatToBottom({ force = false } = {}) {
  const scroll = $('#chat-scroll'), role = state.role, chat = state.chatScroll;
  if (!force && !chat.following) return;
  chat.following = true; chat.unseen = false; updateChatScrollButton();
  const epoch = ++chat.epoch;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (epoch !== chat.epoch || state.view !== 'chat' || state.role !== role || (!force && !chat.following)) return;
    scroll.scrollTop = scroll.scrollHeight;
    markVisibleInboxRead().catch(() => {});
  }));
}
function preserveChatPosition(oldTop) {
  const scroll = $('#chat-scroll'), role = state.role, epoch = ++state.chatScroll.epoch;
  requestAnimationFrame(() => {
    if (epoch !== state.chatScroll.epoch || state.view !== 'chat' || state.role !== role || state.chatScroll.following) return;
    scroll.scrollTop = oldTop;
  });
}
function handleChatLayoutChange() { if (state.view === 'chat' && state.chatScroll.following) followChatToBottom(); }
function pauseChatFollowForUser() { requestAnimationFrame(() => { if (!chatIsNearBottom()) state.chatScroll.following = false; updateChatScrollButton(); }); }
function renderChat(preserveScroll = false, forceFollow = false) {
  const role = roleById(); if (!role) return;
  const box = $('#chat-messages'), scroll = $('#chat-scroll');
  const wasNearBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 120;
  const oldTop = scroll.scrollTop; box.replaceChildren();
  const messages = state.conversations[state.role] || [];
  if (!messages.length && !state.pending.has(state.role)) {
    const welcome = node('div', 'welcome');
    const avatar = avatarNode(role);
    welcome.append(avatar, node('p', 'eyebrow', `${role.title} · 角色介绍`), node('h2', '', role.welcomeTitle || '从这里开始。'), node('p', '', role.initialMessage));
    const starters = node('div', 'starters'); for (const text of role.starters || []) starters.append(button(text, 'starter', () => { $('#message-input').value = text; $('#message-input').focus(); }));
    welcome.append(starters); box.append(welcome);
  }
  if (state.chatHasMore[state.role]) {
    const more = button('查看更早的消息', 'text-button chat-load-earlier', action(loadEarlierChat));
    const row = node('div', 'chat-load-earlier-row'); row.append(more); box.append(row);
  } else if (state.chatArchive[state.role] && !state.chatArchived[state.role]) {
    // Older chat is archived (设置 → 身份与活人感); it opens on request only.
    const more = button(`查看归档的旧对话（${state.chatArchive[state.role]} 条）`, 'text-button chat-load-earlier', action(async () => { state.chatArchived[state.role] = true; await loadChat(); }));
    const row = node('div', 'chat-load-earlier-row'); row.append(more); box.append(row);
  }
  const fragment = document.createDocumentFragment();
  for (const message of messages) fragment.append(renderMessage(message));
  box.append(fragment);
  const pending = state.pending.get(state.role);
  if (pending) {
    for (const item of pending.items || []) box.append(renderMessage({ role:state.role, speaker:'user',text:item.text,createdAt:item.createdAt,transient:true,local:Boolean(item.local) }));
    const line = node('div', 'pending-line');
    line.append(node('i','pending-dot'),node('span','',pending.phase==='failed' ? pending.error : pending.phase==='retrying' ? `${pending.error?.split(' 正在自动重试')[0] || '暂时没有连上模型。'} 将在约${Math.max(1,Math.ceil((Date.parse(pending.nextRetryAt)-Date.now())/1000)||1)}秒后自动重试（${pending.retryCount}/${pending.maxRetries}），不用重新发送。` : pending.remainingChunks ? `${roleName(role)}还在说……` : pending.phase==='compressing' ? '正在整理今天以前的对话，完成后继续回复…' : pending.phase==='queued' ? '收到了，可以继续补充…' : `${roleName(role)}正在回复……`));
    if(pending.phase==='failed')line.append(button('重试','text-button',action(()=>queueAction('retry'))),button('取消','text-button',action(()=>queueAction('cancel'))));
    else line.append(button(pending.items?.length?'撤回待回复消息':'停在这里','text-button',action(()=>queueAction('cancel'))));
    box.append(line);
  }
  $('#send-button').disabled = Boolean(state.submitting); $('#send-button').textContent = state.submitting ? '发送中…' : '发送 ↗';
  $('#compose-note').textContent = state.provider.configured ? '角色为成年虚构人物。手动记忆优先，自动摘要会按对话范围整理。' : '先在设置里连接模型，就可以开始真实对话。';
  const tail = chatTailFingerprint(), hasNewTail = Boolean(state.chatScroll.tail && state.chatScroll.tail !== tail); state.chatScroll.tail = tail;
  const shouldFollow = forceFollow || !preserveScroll || state.chatScroll.following || wasNearBottom;
  if (shouldFollow) followChatToBottom({ force: forceFollow || !preserveScroll });
  else { if (hasNewTail) state.chatScroll.unseen = true; preserveChatPosition(oldTop); updateChatScrollButton(); }
}
function renderMessage(message) {
  const role = roleById(message.role || state.role);
  const article = node('article', `message ${message.speaker === 'user' ? 'user' : ''} ${message.kind || ''}`); if (message.id) article.dataset.messageId = message.id;
  const label = message.speaker === 'user' ? '你' : roleName(role);
  const meta = node('div', 'message-meta'); if(message.speaker === 'assistant') meta.append(avatarNode(role,'message-avatar')); meta.append(node('span', '', label));
  if (message.kind === 'story') meta.append(node('span', 'badge', '故事场景'));
  if (['reminder','session_reminder'].includes(message.kind)) meta.append(node('span', 'badge', '约好的提醒'));
  if (message.kind === 'proactive') meta.append(node('span', 'badge', message.proactiveKind === 'story' ? '故事邀请' : message.proactiveKind === 'content' ? '主动分享' : '接着聊'));
  meta.append(node('time', '', message.transient ? (message.local ? '正在发送' : '已送达') : dateText(message.createdAt, true)));
  article.append(meta, node('div', 'message-bubble', message.text));
  if (!message.transient) {
    const tools = node('div', 'message-tools');
    if (message.speaker === 'assistant') tools.append(button('◖ 朗读', '', action(() => speak(message.id))));
    if (message.speaker === 'assistant' && message.role === 'miyue') for (const [verdict, label] of [['alive', '有活人感'], ['repeat', '又重复了']]) tools.append(button(label, '', action(async () => { await api('/api/message-feedback', { method: 'POST', body: { messageId: message.id, verdict } }); toast(verdict === 'alive' ? '记下了：这条有活人感。' : '记下了：这条在重复，会进每周报告。'); })));
    tools.append(button('收藏片段','',action(async()=>{await api('/api/moments',{method:'POST',body:{action:'save',messageId:message.id}});toast('已收进生活足迹，可以在那里配图、写备注。');})));
    if (message.kind !== 'story') tools.append(button('记住这段', '', action(() => rememberEpisode(message))));
    tools.append(button('复制', '', action(async () => { await navigator.clipboard.writeText(message.text); toast('已复制。'); })));
    if (message.speaker === 'user') tools.append(button('留作记忆', '', action(async () => { await showView('memory'); $('#memory-text').value = message.text; $('#memory-scope').value = message.role; $('#memory-text').focus(); toast('检查内容和分享范围，再点击“记下来”。'); })));
    article.append(tools);
  }
  if(message.receipt){const receipt=message.receipt,detail=node('details','message-why dialogue-receipt');detail.append(node('summary','','这次接话的依据'));const intents={close:'自然收尾',share:'分享她的近况',listen:'听你说说',discuss:'一起探讨',respond:'接住当前话题'};detail.append(node('p','',[(intents[receipt.intent]||'接住当前话题'),receipt.hasAuthoredAnchor?'包含生活或剧情中已经确定的片段':null,(receipt.memoryCount??receipt.memoryIds?.length)?`参考了 ${receipt.memoryCount??receipt.memoryIds.length} 段有原话出处的回忆`:null,(receipt.repairCount??receipt.repairs?.length)?'已按相处偏好整理表达':null].filter(Boolean).join(' · ')));article.append(detail);}
  if (message.kind === 'proactive') {
    const extras = node('div', 'proactive-message-details');
    if (message.sourceTitle) extras.append(message.sourceUrl ? safeLink(message.sourceUrl, `来源：${message.sourceTitle}`) : node('span', 'source-note', `来源：${message.sourceTitle}`));
    if (message.sourceResearch) { const research = message.sourceResearch, links = node('details', 'message-why'); links.append(node('summary', '', '知乎资料与原始回答')); if (research.discovery?.url) links.append(safeLink(research.discovery.url, `话题来源：${research.discovery.title || '打开来源'}`)); for (const ref of research.references || []) { const reference = node('p', 'research-chat-reference'); reference.append(ref.url ? safeLink(ref.url, ref.title || '知乎回答') : node('span', '', ref.title || '知乎回答'), node('span', '', ref.author ? ` · ${ref.author}` : ''), node('span', '', ref.summary ? `：${ref.summary}` : '')); links.append(reference); } extras.append(links); }
    if (message.proactiveReason) { const why = node('details', 'message-why'); why.append(node('summary', '', '为什么想到这件事')); why.append(node('p', '', message.proactiveReason)); extras.append(why); }
    const feedback = node('div', 'message-feedback'); feedback.append(button('这个话题不错', '', action(() => sendProactiveFeedback(message.id, 'good'))), button('少聊这类', '', action(() => sendProactiveFeedback(message.id, 'less'))), button('稍后再聊', '', action(() => sendProactiveFeedback(message.id, 'later')))); extras.append(feedback); article.append(extras);
  }
  return article;
}
async function sendProactiveFeedback(messageId, value) { await api('/api/proactive/feedback', { method: 'POST', body: { messageId, value } }); toast(value === 'good' ? '知道了，会多留意这类话题。' : value === 'less' ? '知道了，之后会少一些这类内容。' : '好，等你方便时再接着聊。'); await pollProactive(); }
function renderContext() {
  const n = $('#chat-context'); n.hidden = !state.content; n.replaceChildren();
  if (state.content) n.append(node('span', '', `一起聊：${state.content.title}`), button('移除', 'text-button', () => { state.content = null; renderContext(); }));
}
let pendingPollBusy=false;
async function pollPending(force=false) {
  if(pendingPollBusy||state.submitting)return;pendingPollBusy=true;
  try {
    const result=await api('/api/chat/pending',{timeout:12000});
    const old=JSON.stringify([...state.pending]);
    for(const [role,pending] of Object.entries(result.roles||{})) {
      if(pending.phase!=='idle'||pending.remainingChunks)state.pending.set(role,pending);else state.pending.delete(role);
    }
    if(state.view==='chat') {
      // A queued or generating turn needs no reload until its state changes;
      // delivered chunks and the final reply change remainingChunks or phase.
      if(force||old!==JSON.stringify([...state.pending]))await loadChat(true);
      if(force||old!==JSON.stringify([...state.pending]))renderChat(true);
      if(old!==JSON.stringify([...state.pending])) {
        loadCharacter().catch(()=>{});
      }
    }
  } finally {pendingPollBusy=false;}
}
async function queueAction(actionName) {
  await api(`/api/chat/${actionName}`,{method:'POST',body:{role:state.role}});
  await pollPending(true);
}
const uncertainSubmissions=new Map();
async function submitChatWithRetry(body) {
  const delays=[2000,5000];
  for(let attempt=0;;attempt++){
    try{return await api('/api/chat/send',{method:'POST',body,timeout:15000});}
    catch(error){
      const transient=[408,429].includes(error.status)||error.status>=500||['TypeError','TimeoutError','AbortError'].includes(error.name)||(error.code==='LOCAL_RESPONSE_INVALID'&&error.status<400);
      if(!transient||attempt>=delays.length)throw error;
      toast(`连接短暂中断，正在自动重试发送（${attempt+1}/${delays.length}）…`,delays[attempt]+16000);
      await new Promise(resolve=>setTimeout(resolve,delays[attempt]));
      // Reuse the exact body and clientId even when the prior acknowledgement
      // was lost after server commit. Never retry arbitrary mutation endpoints.
    }
  }
}
async function sendChat(event) {
  event?.preventDefault();const text=$('#message-input').value.trim(),role=state.role;
  if(!text||state.submitting)return;
  if(!state.provider.configured){await showView('settings');toast('先保存模型接口，写好的消息会保留。');return;}
  const content=state.content,lifeChoice=role==='miyue'?state.lifeChoice:null;
  const key=[role,text,content?.id||'',lifeChoice?.id||'',lifeChoice?.version??''].join(':');
  const clientId=uncertainSubmissions.get(key)||crypto.randomUUID();uncertainSubmissions.set(key,clientId);
  const body={role,text,clientId,...(content?{contentId:content.id}:{}),...(lifeChoice?{lifeChoiceId:lifeChoice.id,lifeVersion:lifeChoice.version}:{})};
  // Show the message at once; the server acknowledgement replaces this local copy.
  const previousPending=state.pending.get(role);
  state.pending.set(role,{...(previousPending||{}),phase:previousPending&&previousPending.phase!=='idle'?previousPending.phase:'queued',items:[...(previousPending?.items||[]),{text,createdAt:new Date().toISOString(),local:true}]});
  state.submitting=true;$('#message-input').value='';state.chatScroll.following=true;state.chatScroll.unseen=false;renderChat(false,true);
  try {
    const result=await submitChatWithRetry(body);
    if($('#toast').textContent.startsWith('连接短暂中断，正在自动重试发送'))toast('连接已恢复，消息已收到。',1800);
    uncertainSubmissions.delete(key);state.pending.set(role,result.pending);state.lifeChoice=null;
    if(state.role===role){state.content=null;renderContext();}
  } catch(error) {
    if(previousPending)state.pending.set(role,previousPending);else state.pending.delete(role);
    if(state.role===role&&!$('#message-input').value)$('#message-input').value=text;
    toast(`${error.message}。可以重试发送；同一条消息不会重复保存。`,8500);
  } finally {state.submitting=false;if(state.role===role&&state.view==='chat')renderChat();await pollPending(true).catch(()=>{});}
}
function reportTyping() { clearTimeout(state.proactive.typingTimer); const text = $('#message-input').value.trim(); if (state.lifeChoice && text !== state.lifeChoice.label) state.lifeChoice = null; if (!text) return; state.proactive.typingTimer = setTimeout(() => { api('/api/activity', { method: 'POST', body: { typing: true }, timeout: 12000 }).catch(() => {}); }, 500); }

async function loadMemories() { const result = await api('/api/memories'); state.memories = result.memories; renderAside(); }
function renderAside() {
  const role = roleById();
  $('#aside-title').textContent = role?.welcomeTitle || '从这里开始。';
  $('#aside-copy').textContent = role?.description || '';
  const items = state.memories.filter(m => m.scope === 'shared' || m.scope === state.role).slice(0, 4), box = $('#aside-memories'); box.replaceChildren();
  const recalled = state.recall[state.role]?.summary;
  if (recalled) { const n = node('div', 'aside-memory'); n.append(node('small', '', '自动整理的回忆'), node('span', '', recalled.slice(0, 140) + (recalled.length > 140 ? '…' : ''))); box.append(n); }
  if (!items.length && !recalled) box.append(node('p', 'empty-memory', '还没有整理出的长期回忆。聊天会逐渐留下摘要，也可以手动记下重要的事。'));
  for (const item of items) { const n = node('div', 'aside-memory'); n.append(node('small', '', scopeText(item.scope)), node('span', '', item.text.length > 110 ? item.text.slice(0, 110) + '…' : item.text)); box.append(n); }
}
function renderMemories() {
  const box = $('#memory-items'); box.replaceChildren();
  if (!state.memories.length) box.append(empty('从一件小事开始记得。', '记忆不会自动猜测你的性格；写下你希望她们了解的事情就好。'));
  for (const item of state.memories) {
    const card = node('article', 'memory-card'); card.append(node('span', 'badge', scopeText(item.scope)), node('p', '', item.text));
    const footer = node('div', 'memory-footer'), actions = node('div'); footer.append(node('time', '', dateText(item.createdAt, true)));
    actions.append(button('编辑', 'text-button', () => { state.memoryEdit = item.id; $('#memory-text').value = item.text; $('#memory-scope').value = item.scope; $('#save-memory').textContent = '保存修改'; $('#cancel-memory-edit').hidden = false; $('#memory-text').focus(); $('#view-memory').scrollTop = 0; }), button('删除', 'text-button', action(async () => { await api(`/api/memories/${item.id}`, { method: 'DELETE' }); if (state.memoryEdit === item.id) resetMemoryForm(); await loadMemories(); renderMemories(); toast('已从长期记忆库删除。'); })));
    footer.append(actions); card.append(footer); box.append(card);
  }
}
function resetMemoryForm() { state.memoryEdit = null; $('#memory-form').reset(); $('#save-memory').textContent = '记下来'; $('#cancel-memory-edit').hidden = true; }
async function saveMemory(event) {
  event.preventDefault(); const body = { text: $('#memory-text').value.trim(), scope: $('#memory-scope').value };
  if (!body.text) return;
  await api(state.memoryEdit ? `/api/memories/${state.memoryEdit}` : '/api/memories', { method: state.memoryEdit ? 'PATCH' : 'POST', body });
  resetMemoryForm(); await loadMemories(); renderMemories(); toast('已保存，下一次回复会按这个范围读取。');
}
async function rememberEpisode(message) {
  if (!message?.id) throw new Error('这条消息还不能加入共同经历。');
  await api('/api/episodes', { method: 'POST', body: { roleId: message.role || state.role, action: 'remember', messageIds: [message.id] } });
  toast('已按原话记下这段共同经历。');
  if (state.view === 'memory' && state.episodes.roleId === (message.role || state.role)) await loadEpisodes(state.episodes.roleId);
}
function selectEpisodeRole(id) {
  const select = $('#episode-role');
  if (!select.options.length) for (const role of state.roles) select.append(new Option(roleName(role), role.id));
  select.value = id;
}
async function loadEpisodes(id = state.role) {
  selectEpisodeRole(id);
  const result = await api(`/api/episodes?roleId=${encodeURIComponent(id)}`, { timeout: 20000 });
  state.episodes = { roleId: id, items: result.items || [], preferences: result.preferences || null };
  if ($('#episode-role').value === id) renderEpisodes();
  return result;
}
function episodeKind(item) {
  const categories = { preference: '偏好', comparison: '比较', disagreement: '分歧', advice: '建议', 'shared-joke': '共同玩笑' };
  if (item.origin === 'manual') return item.label || '你明确记下';
  return categories[item.category] || '从对话整理';
}
function renderEpisodes() {
  const data = state.episodes, box = $('#episode-items'); box.replaceChildren();
  const active = (data.items || []).filter((item) => item.status !== 'tombstone');
  if (!active.length) box.append(empty('还没有按原话留下的共同经历。', '在历史消息下面点击“记住这段”，这里会保留可核对的原话。'));
  for (const item of active) {
    const card = node('article', 'episode-card');
    const heading = node('div', 'episode-heading');
    heading.append(node('span', 'badge', `${roleName(String(item.scope || data.roleId).split('::')[0])} · ${episodeKind(item)}`), node('time', '', dateText(item.createdAt, true)));
    card.append(heading);
    if(item.suppressed)card.append(node('p','fine-print','这段与已更正或忘记的引用重叠，已停止用于后续聊天。'));
    if (item.corrected && item.correction) {
      const correction = node('div', 'episode-correction'); correction.append(node('small', '', '你的更正'), node('p', '', item.correction)); card.append(correction);
    }
    const quotes = node('div', 'episode-quotes');
    for (const quote of item.quotes || []) {
      const block = node('blockquote', 'episode-quote');
      const speaker = quote.speaker === 'user' ? '你' : roleName(String(item.scope || data.roleId).split('::')[0]);
      block.append(node('div', 'episode-quote-meta', `${speaker} · ${dateText(quote.createdAt, true)}`), node('p', '', quote.text));
      quotes.append(block);
    }
    card.append(quotes);
    const editor = node('details', 'episode-editor'); editor.append(node('summary', '', item.corrected ? '修改更正' : '这段需要更正'));
    const note = node('textarea', ''); note.rows = 3; note.maxLength = 1000; note.value = item.correction || ''; note.placeholder = '写下应当怎样理解这段经历'; note.setAttribute('aria-label', '共同经历更正');
    const editorActions = node('div', 'form-row wrap');
    editorActions.append(button('保存更正', 'small-button', action(async () => { const value = note.value.trim(); if (!value) throw new Error('请先写下更正内容。'); await api('/api/episodes', { method: 'POST', body: { roleId: data.roleId, action: 'correct', id: item.id, note: value } }); await loadEpisodes(data.roleId); toast('更正已保存；旧摘要不会再覆盖这份说明。'); })));
    editor.append(note, editorActions); card.append(editor);
    const footer = node('div', 'episode-footer');
    footer.append(node('span', 'fine-print', '引用来自原聊天；更正或忘记都不会删除聊天记录。'), button('忘记这段', 'text-button', action(async () => { await api('/api/episodes', { method: 'POST', body: { roleId: data.roleId, action: 'remove', id: item.id } }); await loadEpisodes(data.roleId); toast('已停用这段共同经历和相关旧摘要；原聊天仍然保留。'); })));
    card.append(footer); box.append(card);
  }
  $('#episode-status').textContent = active.length ? `当前显示 ${roleName(data.roleId)}可核对的共同经历。` : '';
  const preferences = data.preferences, options = preferences?.options || [
    { key: 'lessPraise', label: '少一些习惯性夸奖' }, { key: 'noAnalysis', label: '少分析我的心理' }, { key: 'noQuestions', label: '少用问题结尾' },
  ];
  const preferenceBox = $('#interaction-preferences'); preferenceBox.replaceChildren();
  for (const option of options) {
    const label = node('label', 'preference-option'), input = node('input'); input.type = 'checkbox'; input.dataset.preference = option.key; input.checked = option.key === 'lessPraise' ? preferences?.preferences?.lessPraise !== false : Boolean(preferences?.preferences?.[option.key]); label.append(input, node('span', '', option.label)); preferenceBox.append(label);
  }
  $('#interaction-preferences-status').textContent = preferences ? `这些偏好只用于和${roleName(data.roleId)}的对话。` : '相处偏好暂时无法读取。';
}
async function saveInteractionPreferences() {
  const roleId = state.episodes.roleId || $('#episode-role').value;
  const preferences = Object.fromEntries($$('#interaction-preferences input[data-preference]').map((input) => [input.dataset.preference, input.checked]));
  await api('/api/interaction-preferences', { method: 'POST', body: { roleId, preferences } });
  await loadEpisodes(roleId);
  $('#interaction-preferences-status').textContent = `已保存，从下一次和${roleName(roleId)}说话开始使用。`;
}
function renderRecall() {
  const select = $('#recall-role');
  if (!select.options.length) for (const role of state.roles) select.append(new Option(roleName(role), role.id));
  if (!select.value) select.value = state.role;
  const recall = state.recall[select.value];
  $('#recall-summary').value = recall?.summary || '';
  const status = $('#recall-status');
  const bits = [];
  if (recall?.updatedAt) bits.push(`上次整理：${dateText(recall.updatedAt, true)}`);
  if (select.value==='miyue'&&recall?.eligibleCount!==undefined) bits.push(`短期原文 ${recall.shortTermCount} 条 · 较早待整理 ${recall.eligibleCount} 条`);
  else if (recall?.pendingCount !== undefined) bits.push(recall.pendingCount ? `还有 ${recall.pendingCount} 段对话待整理` : '已整理到当前可用内容');
  if (recall?.error) bits.push(`上次整理未完成：${recall.error}`);
  status.textContent = bits.join(' · ') || '尚未生成自动摘要。点击“重新整理”可根据已有对话生成。';
}
function selectRecallRole(id) { const select = $('#recall-role'); if (!select.options.length) for (const role of state.roles) select.append(new Option(roleName(role), role.id)); select.value = id; }
async function loadRecall(id = state.role) { selectRecallRole(id); const request = ++state.recallRequest, mutation = chatHistory.mutation, result = await api(`/api/characters/${id}`, { timeout: 20000 }); if (mutation !== chatHistory.mutation) return result.recall; state.character[id] = result; state.recall[id] = result.recall || {}; if (request === state.recallRequest && $('#recall-role').value === id) renderRecall(); return result.recall; }
async function saveRecall(summary) {
  const id = $('#recall-role').value, result = await api(`/api/recall/${id}`, { method: 'PATCH', body: { summary } });
  state.recall[id] = result.recall || { ...state.recall[id], summary, updatedAt: new Date().toISOString() }; renderRecall(); toast(summary ? '已保存你修订后的回忆摘要。' : '已清空自动摘要；历史聊天不会删除，也不会再被这份摘要引用。');
}
async function refreshRecall() {
  const id = $('#recall-role').value, control = $('#refresh-recall'); control.disabled = true; control.textContent = '正在整理…';
  try { const result = await api(`/api/recall/${id}/refresh`, { method: 'POST', body: {}, timeout: 95000 }); if (result.recall) state.recall[id] = result.recall; if ($('#recall-role').value === id) renderRecall(); const reason = { 'short-term-window': '近期原文继续保留；较早的小批内容会稍后合并，无需提前压缩。', 'oversized-source': '有一条旧原文超过单次整理容量，已保留原文，未推进进度。', cooldown: '刚整理过，稍后会继续处理较早内容。', 'invalid-consolidation': '整理未通过原文或归属检查，原文和上次记忆保持不变。', threshold: '自动整理会在累计 20 条对话后进行；当前仍保留最近 10 条短期上下文。', backoff: '刚整理过，系统会稍后再试。', 'model-unconfigured': '尚未配置模型，无法整理自动回忆。', stale: '这份回忆已被更新，已保留较新的版本。' }[result.reason] || result.reason; if (result.status === 'updated') toast('已更新自动回忆。'); else if (result.status === 'skipped') toast(reason || '这次无需重新整理。'); else if (result.status === 'stale') toast(reason || '回忆已由较新的内容更新。'); else if (result.status === 'failed') throw new Error(reason || '自动整理未完成。'); else toast('整理请求已完成。'); } finally { control.disabled = false; control.textContent = '重新整理'; }
}
function tokenText(value) { return value === null || value === undefined ? '未返回' : Number(value).toLocaleString('zh-CN'); }
function cacheRateText(value) { return Number.isFinite(value) && value >= 0 && value <= 1 ? `${(value * 100).toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%` : '未知'; }
function cacheCoverageText(stats) { return `${tokenText(stats?.cacheObservedRequests)} / ${tokenText(stats?.requests)}`; }
function usageCells(stats) { const wrap = node('div', 'usage-cells'); for (const [label, value] of [['请求', tokenText(stats?.requests)], ['输入', tokenText(stats?.inputTokens)], ['输出', tokenText(stats?.outputTokens)], ['缓存', tokenText(stats?.cachedTokens)], ['缓存输入占比', cacheRateText(stats?.cacheHitRate)], ['可观测请求', cacheCoverageText(stats)], ['推理', tokenText(stats?.reasoningTokens)], ['已知总计', tokenText(stats?.totalTokens)], ['未返回请求', tokenText(stats?.unknownRequests)], ['失败', tokenText(stats?.failedRequests)], ['已停止', tokenText(stats?.cancelledRequests)]]) { const cell = node('div', 'usage-cell'); cell.append(node('small', '', label), node('strong', '', value)); wrap.append(cell); } return wrap; }
function recentTokenCells(stats) { const wrap = node('div', 'usage-cells'); for (const [label, value] of [['输入', tokenText(stats?.inputTokens)], ['输出', tokenText(stats?.outputTokens)], ['缓存', tokenText(stats?.cachedTokens)], ['缓存输入占比', cacheRateText(stats?.cacheHitRate)], ['推理', tokenText(stats?.reasoningTokens)], ['已知总计', tokenText(stats?.totalTokens)]]) { const cell = node('div', 'usage-cell'); cell.append(node('small', '', label), node('strong', '', value)); wrap.append(cell); } return wrap; }
function purposeName(value) { const map = { understanding: '对话语义判断', 'session-guidance': '本轮提示', 'session-review': '回复检查', 'session-revision': '回复调整', 'character-reflection':'角色反思', 'recall-query':'历史查询展开', 'recall-embedding':'历史语义索引', 'proactive-continuity': '对话接续评估', chat: '对话回复', memory: '回忆整理', 'connection-test': '连接测试', recall: '自动回忆', recall_refresh: '重新整理回忆', proactive: '主动陪伴', life: '生活分享', emotion: '心情分享', research: '资料研究', zhihu: '知乎资料研究', content: '内容整理', story: '双人剧本', system: '系统调用' }; return map[value] || value || '未标注用途'; }
function usageStatusName(value) { return ({ success: '成功', completed: '完成', failed: '失败', error: '失败', pending: '处理中', cancelled: '补充消息后已停止', skipped: '已跳过', unknown: '状态未提供' })[value] || value || '状态未提供'; }
function usageRoleName(row) { if (row.roleId) return roleName(row.roleId); return /research|zhihu|content/i.test(row.purpose || '') ? '公共研究' : '系统调用'; }
function renderUsage() {
  const data = state.usage; $('#usage-summary').replaceChildren(); $('#usage-roles').replaceChildren(); $('#usage-purposes').replaceChildren(); $('#usage-recent').replaceChildren();
  if (!data) { $('#usage-status').textContent = state.usageError || '暂无可展示的用量记录。'; return; }
  $('#usage-status').textContent = `${data.since ? `记录开始于 ${dateText(data.since, true)}。` : '记录从升级后开始。'} 缓存输入占比只统计同时返回有效输入和缓存用量的请求；可观测请求显示统计覆盖范围。当前生成的输出不享受输入缓存折扣；未知不等于 0。`;
  for (const [title, stats] of [['今天', data.today], ['累计', data.allTime]]) { const card = node('section', 'usage-card'); card.append(node('h3', '', title), usageCells(stats || {})); $('#usage-summary').append(card); }
  const roleBox = $('#usage-roles'); for (const row of data.byRole || []) { const item = node('article', 'usage-row'); item.append(node('h4', '', usageRoleName(row)), usageCells(row)); roleBox.append(item); } if (!roleBox.childElementCount) roleBox.append(node('p', 'fine-print', '暂无按角色记录。'));
  const purposeBox = $('#usage-purposes'); for (const row of data.byPurpose || []) { const item = node('article', 'usage-row'); item.append(node('h4', '', purposeName(row.purpose)), usageCells(row)); purposeBox.append(item); } if (!purposeBox.childElementCount) purposeBox.append(node('p', 'fine-print', '暂无按用途记录。'));
  const recent = $('#usage-recent'); if (!(data.recent || []).length) recent.append(node('p', 'fine-print', '暂无最近请求记录。'));
  for (const row of data.recent || []) { const item = node('article', 'usage-request'); const title = node('div', 'usage-request-title'); title.append(node('strong', '', `${usageRoleName(row)} · ${purposeName(row.purpose)}`), node('small', '', `${dateText(row.createdAt, true)} · ${usageStatusName(row.status)}`)); item.append(title, node('p', '', `${row.provider || '服务商未提供'}${row.model ? ` · ${row.model}` : ''}`), recentTokenCells(row)); recent.append(item); }
}
async function loadUsage() { state.usageError = ''; try { state.usage = await api('/api/usage', { timeout: 25000 }); } catch (error) { state.usage = null; state.usageError = error.message || '读取用量失败。'; } renderUsage(); }
function phaseTime(event, phase) { const started = new Date(event?.startedAt); if (Number.isNaN(started.valueOf()) || !Number.isFinite(Number(phase?.offsetHours))) return '时间未提供'; started.setTime(started.getTime() + Number(phase.offsetHours) * 3600000); return dateText(started.toISOString(), true); }
let travelStopSequence = 0;
function updateTravelStopRows() {
  const rows = $$('.travel-stop', $('#travel-stops'));
  rows.forEach((row, index) => {
    $('.travel-stop-title', row).textContent = `第 ${index + 1} 站`;
    $('.remove-travel-stop', row).disabled = rows.length === 1;
  });
}
function addTravelStop(values = {}) {
  const id = ++travelStopSequence, row = node('section', 'travel-stop');
  row.dataset.stopId = String(id);
  const heading = node('div', 'travel-stop-heading');
  heading.append(node('strong', 'travel-stop-title', ''), button('删除', 'text-button remove-travel-stop', () => { row.remove(); updateTravelStopRows(); }));
  const fields = node('div', 'travel-stop-fields');
  const definitions = [
    ['city', '城市', 'text', '例如：扬州', true],
    ['arriveAt', '到达时间', 'datetime-local', '', true],
    ['leaveAt', '离开时间', 'datetime-local', '', true],
    ['lodging', '住处（选填）', 'text', '例如：扬州的住处', false],
  ];
  for (const [name, labelText, type, placeholder, required] of definitions) {
    const label = node('label'), input = node('input');
    input.type = type; input.className = `travel-stop-${name}`; input.id = `travel-stop-${name}-${id}`;
    input.placeholder = placeholder; input.required = required; input.value = values[name] || '';
    label.htmlFor = input.id; label.append(document.createTextNode(labelText), input); fields.append(label);
  }
  row.append(heading, fields); $('#travel-stops').append(row); updateTravelStopRows();
}
function resetTravelForm() {
  $('#life-travel-form').reset(); $('#travel-stops').replaceChildren(); addTravelStop();
}
function localInstant(input, label) {
  const value = input.value.trim(), time = Date.parse(value);
  if (!value || !Number.isFinite(time)) throw new Error(`请填写有效的${label}。`);
  return { time, iso: new Date(time).toISOString() };
}
async function saveTravel(event) {
  event.preventDefault();
  const status = $('#travel-form-status'), save = $('#save-travel');
  try {
    const depart = localInstant($('#travel-depart-at'), '出发时间');
    const returning = localInstant($('#travel-return-at'), '回家时间');
    if (depart.time >= returning.time) throw new Error('回家时间需要晚于出发时间。');
    const rows = $$('.travel-stop', $('#travel-stops'));
    if (!rows.length) throw new Error('请至少添加一个停靠城市。');
    let previousLeave = depart.time;
    const stops = rows.map((row, index) => {
      const city = $('.travel-stop-city', row).value.trim();
      if (!city) throw new Error(`请填写第 ${index + 1} 站的城市。`);
      const arrive = localInstant($('.travel-stop-arriveAt', row), `第 ${index + 1} 站到达时间`);
      const leave = localInstant($('.travel-stop-leaveAt', row), `第 ${index + 1} 站离开时间`);
      if (arrive.time < previousLeave) throw new Error(`第 ${index + 1} 站的到达时间不能早于上一段行程结束时间。`);
      if (leave.time <= arrive.time) throw new Error(`第 ${index + 1} 站的离开时间需要晚于到达时间。`);
      if (leave.time > returning.time) throw new Error(`第 ${index + 1} 站的离开时间不能晚于回家时间。`);
      previousLeave = leave.time;
      const lodging = $('.travel-stop-lodging', row).value.trim();
      return { city, arriveAt: arrive.iso, leaveAt: leave.iso, ...(lodging ? { lodging } : {}) };
    });
    save.disabled = true; status.textContent = '正在安排行程…';
    const result = await api('/api/life/travel', { method: 'POST', body: { departAt: depart.iso, returnAt: returning.iso, stops } });
    if (result.life) state.life = result.life; else await loadLife();
    renderLife(); resetTravelForm(); status.textContent = '行程已经安排好。'; toast('行程已经安排好，生活足迹会按所在地更新。');
  } catch (error) {
    const message = error.code === 'ACTIVE_LIFE_EVENT' ? '现在已有一项生活安排，结束后再安排新的行程。'
      : error.code === 'INVALID_TRAVEL_PLAN' ? '行程没有保存，请检查城市和各段时间。'
        : error.message || '行程没有保存，请检查时间后重试。';
    status.textContent = message; throw new Error(message);
  }
  finally { save.disabled = false; }
}
function renderTravelState(travel) {
  const box = $('#life-travel-current'); box.replaceChildren();
  if (!travel) return;
  const labels = {
    planned: `准备前往${travel.stops?.[0]?.city || '下一站'}`,
    outbound: '正在前往第一站', between_stops: `正在前往${travel.nextCity || '下一站'}`,
    staying: `正在${travel.currentCity || '目的地'}生活`, returning: `正在返回${travel.homeCity || '苏州'}`,
    returned: `已经回到${travel.homeCity || '苏州'}`,
  };
  const card = node('article', `life-travel-card ${travel.status || ''}`);
  card.append(node('small', 'eyebrow', '当前行程'), node('h3', '', labels[travel.status] || '旅途中'));
  if (travel.location) card.append(node('p', 'life-travel-location', travel.location));
  const cities = [travel.homeCity, ...(travel.stops || []).map(stop => stop.city), travel.homeCity].filter(Boolean);
  if (cities.length) card.append(node('p', 'life-travel-route', cities.join(' → ')));
  if (travel.returnAt) card.append(node('p', 'fine-print', `${travel.status === 'returned' ? '回家时间' : '预计回家'}：${dateText(travel.returnAt, true)}`));
  box.append(card);
}
function lifeEventCard(event, { current = false } = {}) {
  const categories = { travel: '旅行', meal: '吃点东西', cooking: '下厨', clothing: '衣着', commute: '路上见闻', hobby: '兴趣', family: '家人', work: '工作', local_walk: '城市散步', reading: '阅读', emotional_need: '心情' };
  const card = node('article', current ? 'life-event active' : 'life-event'); card.append(node('h3', '', event.title || '未命名事件')); const info = [categories[event.category] || event.category, event.location].filter(Boolean).join(' · '); if (info) card.append(node('p', 'life-event-info', info)); if (event.startedAt || event.endsAt) card.append(node('p', 'fine-print', `安排：${event.startedAt ? dateText(event.startedAt, true) : '时间未提供'} 至 ${event.endsAt ? dateText(event.endsAt, true) : '时间未提供'}`));
  if (current && event.phase && !event.travelPlan) { const detail = node('details', 'life-schedule'); detail.append(node('summary', '', '查看大致行程')); const timeline = node('ol', 'life-timeline'); for (const phase of event.phases || []) { const row = node('li', phase.id === event.phase.id ? 'current' : ''); row.append(node('strong', '', phase.title || '片段'), node('time', '', phaseTime(event, phase))); timeline.append(row); } detail.append(timeline); card.append(detail); }
  if (!current && event.facts?.length) { const facts = node('ul', 'life-facts'); for (const fact of event.facts) facts.append(node('li', '', fact)); card.append(facts); } return card;
}
async function lifeThreadChat(thread, choice) {
  await selectRole('miyue');
  state.lifeChoice = { id: choice.id, version: thread.version, label: choice.label };
  $('#message-input').value = choice.label;
  await sendChat();
}
function renderLifeThread(thread) {
  const box = $('#life-thread'); box.replaceChildren();
  if (!thread?.beat) return;
  const labels = { active: '正在继续', paused: '暂时停在这里', completed: '这一段已经完成' };
  const card = node('article', `life-thread-card ${thread.status || ''}`);
  const heading = node('div', 'card-heading'), copy = node('div');
  copy.append(node('small', 'eyebrow', '当前生活线'), node('h3', '', thread.title));
  heading.append(copy, node('span', 'badge', labels[thread.status] || '慢慢发生中')); card.append(heading);
  const beat = node('section', 'life-thread-beat'); beat.append(node('h4', '', thread.beat.title), node('p', '', thread.beat.text));
  const texture = node('dl', 'life-thread-texture');
  for (const [label, value] of [['她的感受', thread.beat.emotion], ['此刻的小需要', thread.beat.need]]) if (value) { texture.append(node('dt', '', label), node('dd', '', value)); }
  beat.append(texture); card.append(beat);
  if (thread.choices?.length && thread.status === 'active') {
    const choices = node('div', 'life-thread-choices'); choices.append(node('p', 'fine-print', '如果你刚好有偏好，可以直接选；不选也会按她自己的节奏继续。'));
    for (const choice of thread.choices) choices.append(button(choice.label, 'small-button', action(() => lifeThreadChat(thread, choice))));
    card.append(choices);
  }
  if (thread.history?.length) {
    const history = node('details', 'life-thread-history'); history.append(node('summary', '', `已经分享过的片段 · ${thread.history.length}`));
    const list = node('ol'); for (const item of thread.history) list.append(node('li', '', `${item.title} · ${dateText(item.deliveredAt, true)}`)); history.append(list); card.append(history);
  }
  box.append(card);
}
function renderLife(fillSettings = false) {
  const data = state.life, status = $('#life-status'), current = $('#life-current'), recent = $('#life-recent'); current.replaceChildren(); recent.replaceChildren(); $('#life-thread').replaceChildren(); $('#life-pursuit').replaceChildren();
  if (!data) { renderTravelState(null); status.textContent = state.lifeError || '未能读取生活足迹。'; $('#life-settings-status').textContent = '读取失败'; $('#life-settings-note').textContent = state.lifeError || '未能读取生活足迹。'; return; }
  renderTravelState(data.travel);
  status.textContent = data.enabled ? `本周检查：${data.checkedWeek || '尚未提供'}。下次检查：${data.nextWeeklyCheckAt ? dateText(data.nextWeeklyCheckAt, true) : '尚未安排'}。` : '生活足迹目前未开启。';
  const shares=$('#life-shares');shares.replaceChildren();for(const message of data.shares||[]){const card=node('article','life-event');card.append(node('small','fine-print',dateText(message.createdAt,true)),node('p','',message.text),button('接着聊','text-button',action(async()=>{await selectRole('miyue');$('#message-input').value='你之前说“'+message.text.slice(0,160)+'”，我想接着聊这个。';$('#message-input').focus();})));shares.append(card);}if(!shares.childElementCount)shares.append(node('p','fine-print','她主动聊过的生活片段会出现在这里。'));
  const discussion = data.discussion;
  if (discussion?.angles?.length) { const card = node('article', 'life-event'); card.append(node('h3', '', '这件事能聊什么'), node('p', '', '她会从一个具体细节说起，顺着你感兴趣的地方继续聊。')); const list = node('ul', 'life-facts'); for (const angle of discussion.angles) { const row = node('li', ''); row.append(node('span', '', angle.title), node('span', 'badge', angle.shared ? '已聊起' : '待聊')); list.append(row); } card.append(list); if (discussion.sources?.length) { card.append(node('h4', '', '可以一起读的资料')); for (const source of discussion.sources) card.append(safeLink(source.url, source.title)); } current.append(card); }
  const pursuit=data.pursuit, pursuitBox=$('#life-pursuit');
  if(pursuit){pursuitBox.hidden=false;pursuitBox.append(node('h3','','最近在读、在看'),node('h4','',pursuit.title));if(pursuit.origin)pursuitBox.append(node('p','fine-print',pursuit.origin));const session=pursuit.session;const progress=pursuit.readable===false?'已选好，等有空再读':session?.status==='active'?`正在读 · 这次安排 ${session.minutes} 分钟`:session?.status==='interrupted'?'暂时放下，之后接着读':pursuit.status==='resting'?'这轮告一段落，先消化几天':'这次先读到这里，过几天再继续';pursuitBox.append(node('p','fine-print',progress));if(pursuit.readable!==false)pursuitBox.append(node('p','',pursuit.stage.label),node('p','',pursuit.stage.action));pursuitBox.append(safeLink(pursuit.source.url,pursuit.source.title));if(pursuit.completed?.length){const past=node('details','');past.append(node('summary','','这些事留下了什么'));for(const item of pursuit.completed.slice(-4))past.append(node('h4','',item.title),node('p','',item.residue));pursuitBox.append(past);}}
  else pursuitBox.hidden=true;
  if(data.personalExperiences?.length){pursuitBox.hidden=false;const memories=node('details','');memories.append(node('summary','','聊天里留下的经历'));for(const item of data.personalExperiences.slice(0,5))memories.append(node('h4','',item.title),node('p','',item.summary));pursuitBox.append(memories);}
  renderLifeThread(data.thread);
  if (data.active) current.append(lifeEventCard(data.active, { current: true })); else current.append(empty('此刻没有额外的生活安排。', '有新的出行、见闻或日常小事时，会接着记在这里。'));
  const completed = (data.recent || []).filter(event => event.id !== data.active?.id); if (!completed.length) recent.append(node('p', 'fine-print', '还没有结束的事件，当前片段在上方。')); else for (const event of completed) recent.append(lifeEventCard(event));
  if (fillSettings) { $('#life-weekly-chance').value = Number.isFinite(Number(data.weeklyTravelChance)) ? String(Math.round(Number(data.weeklyTravelChance) * 100)) : ''; $('#life-settings-status').textContent = data.enabled ? '已开启' : '未开启'; $('#life-settings-note').textContent = `本周检查：${data.checkedWeek || '尚未提供'} · 下次检查：${data.nextWeeklyCheckAt ? dateText(data.nextWeeklyCheckAt, true) : '尚未安排'}`; }
}
async function loadLife(fillSettings = false) { state.lifeError = ''; try { state.life = await api('/api/life', { timeout: 20000 }); } catch (error) { state.life = null; state.lifeError = error.message || '读取生活足迹失败。'; } renderLife(fillSettings); }
async function saveLifeSettings(event) { event.preventDefault(); const percent = Number($('#life-weekly-chance').value); if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw new Error('请填写 0 到 100 之间的百分比。'); const result = await api('/api/life/settings', { method: 'POST', body: { weeklyTravelChance: percent / 100 } }); state.life = result.life || { ...state.life, weeklyTravelChance: percent / 100 }; await loadLife(true); toast('生活足迹设置已保存；不会重新抽取本周安排。'); }

async function loadContent(preserve = false) {
  const inbox = state.contentInbox, params = new URLSearchParams({ status: inbox.status, page: String(inbox.page), pageSize: String(inbox.pageSize) });
  if (inbox.query) params.set('query', inbox.query);
  const request = ++inbox.request, result = await api(`/api/content?${params}`); if (request !== inbox.request) return;
  const previous = JSON.stringify([state.items, state.feeds, inbox.total, inbox.pages, inbox.counts]);
  state.items = result.items || []; state.feeds = result.feeds || [];
  inbox.total = Number(result.total || 0); inbox.page = Number(result.page || inbox.page); inbox.pageSize = Number(result.pageSize || inbox.pageSize); inbox.pages = Math.max(1, Number(result.pages || 1)); inbox.counts = { ...inbox.counts, ...(result.counts || {}) };
  if (inbox.page > inbox.pages) { inbox.page = inbox.pages; return loadContent(preserve); }
  const visibleSelected = state.items.find(item => item.id === inbox.selectedId); if (visibleSelected) inbox.selectedItem = visibleSelected;
  if (!preserve || previous !== JSON.stringify([state.items, state.feeds, inbox.total, inbox.pages, inbox.counts])) renderContent();
}
function contentResearch(item) { return item.research || item.sourceResearch || (item.kind === 'zhihu_research' ? item : null); }
function contentTitle(item) { return contentResearch(item)?.topic || item.title || '未命名内容'; }
function contentStatus(item) { return item.inbox?.status || 'unread'; }
async function setContentState(ids, actionName) {
  const unique = [...new Set(ids.filter(Boolean))]; if (!unique.length) return;
  await api('/api/content/state', { method: 'POST', body: { ids: unique, action: actionName } });
  const selected = state.contentInbox.selectedItem;
  if (selected && unique.includes(selected.id)) selected.inbox = { ...(selected.inbox || {}), status: actionName === 'read' ? 'read' : actionName === 'unread' ? 'unread' : actionName === 'archive' ? 'archived' : 'unread' };
  await loadContent();
}
async function openContent(item) {
  state.contentInbox.selectedId = item.id; state.contentInbox.selectedItem = item; renderContent();
  if (contentStatus(item) === 'unread') await setContentState([item.id], 'read');
  if (window.matchMedia('(max-width: 780px)').matches) $('#content-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function contentExternalLink(item, label) {
  const link = safeLink(item.url, label);
  if (link.hasAttribute('href')) link.addEventListener('click', () => { if (contentStatus(item) === 'unread') setContentState([item.id], 'read').catch(error => toast(error.message || '未能标记已读。')); });
  return link;
}
function appendContentEvidence(container, item) {
  const research = contentResearch(item);
  if (research) { const evidence = node('details', 'research-evidence'); evidence.append(node('summary', '', `查看 ${research.references?.length || 0} 条知乎回答与来源`)); const discovery = node('div', 'research-discovery'); discovery.append(node('small', '', `话题发现：${research.discovery?.source || '公开来源'}`), research.discovery?.url ? safeLink(research.discovery.url, research.discovery.title || '打开话题来源') : node('span', '', research.discovery?.title || '未提供话题来源')); evidence.append(discovery); for (const ref of research.references || []) { const row = node('div', 'research-reference'); row.append(ref.url ? safeLink(ref.url, ref.title || '知乎回答') : node('strong', '', ref.title || '知乎回答'), node('small', '', ref.author ? `作者：${ref.author}` : '作者信息未提供'), node('p', '', ref.summary || '该回答未提供可展示摘录。')); evidence.append(row); } container.append(evidence); }
  if (item.dossier) { container.append(node('small','fine-print',item.dossier.extraction?.extracted ? '已备读 · 公开正文片段' : research ? '备读材料 · 知乎原回答摘录' : '备读材料 · 订阅摘要')); const detail = node('details','research-evidence'); detail.open = true; detail.append(node('summary','',`筛选说明与相关内容（${1 + (item.dossier.relatedIds?.length || 0)}条）`),node('p','fine-print',`${item.dossier.qualityReason || ''}${item.dossier.qualityReason && item.dossier.uncertainty ? '。' : ''}${item.dossier.uncertainty || ''}`)); for (const fact of item.dossier.excerptFacts || []) detail.append(node('p','',fact)); for (const id of item.dossier.relatedIds || []) { const related = item.relatedItems?.find(x=>x.id===id) || state.items.find(x=>x.id===id); if(related) detail.append(safeLink(related.url,`${related.source} · ${related.title}`),node('p','',related.summary?.slice(0,400)||'')); } container.append(detail); }
}
function renderContentDetail() {
  const box = $('#content-detail'), item = state.contentInbox.selectedItem; box.replaceChildren();
  if (!item) { box.append(empty('选一条来读。', '打开标题后，摘要、资料来源和后续操作会留在这里。')); return; }
  const research = contentResearch(item), source = node('div', 'content-source'); source.append(node('span', '', research ? (research.generatedBy ? '知乎资料 · AI整理' : '知乎回答摘录') : item.source || '来源未提供'), node('time', '', dateText(research?.generatedAt || item.publishedAt)));
  box.append(source, node('h3', '', contentTitle(item)), node('p', 'content-detail-summary', item.summary || '这个来源未提供摘要，可以打开原文。')); appendContentEvidence(box, item);
  const actions = node('div', 'content-actions');
  actions.append(button('关注后续','text-button',action(async()=>{await api('/api/topics',{method:'POST',body:{action:'follow',contentId:item.id}});await loadTopics();toast('已关注，后续收集到的相关内容会优先展示。');})), contentExternalLink(item, research ? '打开话题来源 ↗' : '打开原文 ↗'));
  if (contentStatus(item) === 'archived' || contentStatus(item) === 'expired') actions.append(button('恢复', 'text-button', action(() => setContentState([item.id], 'restore')))); else actions.append(button('标记未读', 'text-button', action(() => setContentState([item.id], 'unread'))), button('归档', 'text-button', action(() => setContentState([item.id], 'archive'))));
  actions.append(button('和林晓薇聊聊', '', action(async () => { await selectRole('miyue'); state.content = item; renderContext(); $('#message-input').value = `先简单说说这篇《${contentTitle(item)}》讲了什么`; $('#message-input').focus(); }))); box.append(actions);
}
function renderContent() {
  const inbox = state.contentInbox; $('#content-count').textContent = inbox.counts.unread || ''; $('#feed-count').textContent = `${state.feeds.length} 个来源`;
  const feeds = $('#feeds'); feeds.replaceChildren();
  for (const item of state.feeds) { const row = node('div', 'feed-row'), copy = node('div'); copy.append(node('strong', '', item.title), safeLink(item.url, item.url)); row.append(copy, button('移除', 'text-button', action(async () => { await api(`/api/feeds/${item.id}`, { method: 'DELETE' }); await loadContent(); }))); feeds.append(row); }
  const labels = { unread: '未读', read: '已读', archived: '归档', expired: '过期', all: '全部' }, tabs = $('#content-tabs'); tabs.replaceChildren();
  for (const status of Object.keys(labels)) { const tab = button(`${labels[status]} ${inbox.counts[status] || 0}`, '', action(async () => { if (status === inbox.status) return; inbox.status = status; inbox.page = 1; await loadContent(); })); tab.setAttribute('role', 'tab'); tab.setAttribute('aria-selected', String(status === inbox.status)); tab.classList.toggle('active', status === inbox.status); tabs.append(tab); }
  if (document.activeElement !== $('#content-query')) $('#content-query').value = inbox.query; $('#content-result-note').textContent = inbox.query ? `找到 ${inbox.total} 条与“${inbox.query}”有关的内容` : `共 ${inbox.total} 条 · 每页 ${inbox.pageSize} 条`;
  const box = $('#content-items'); box.replaceChildren();
  if (!state.items.length) box.append(empty(inbox.query ? '没有找到相关内容。' : inbox.status === 'unread' ? '未读已经清空。' : '这里还没有内容。', inbox.query ? '可以换一个标题或来源关键词。' : '收集到的新内容会先进入未读。'));
  for (const item of state.items) {
    const row = button('', `content-row${item.id === inbox.selectedId ? ' active' : ''}`, action(() => openContent(item))), research = contentResearch(item), meta = node('span', 'content-row-meta'); row.removeAttribute('aria-label'); row.append(node('strong', '', contentTitle(item))); meta.append(node('span', '', research ? '知乎资料' : item.source || '来源未提供'), node('time', '', dateText(research?.generatedAt || item.publishedAt))); row.append(meta); row.setAttribute('aria-current', item.id === inbox.selectedId ? 'true' : 'false'); box.append(row);
  }
  $('#content-page-read').hidden = inbox.status !== 'unread' || !state.items.length;
  const pager = $('#content-pagination'); pager.replaceChildren(); const previous = button('上一页', 'text-button', action(async () => { inbox.page--; await loadContent(); })), next = button('下一页', 'text-button', action(async () => { inbox.page++; await loadContent(); })); previous.disabled = inbox.page <= 1; next.disabled = inbox.page >= inbox.pages; pager.append(previous, node('span', '', `第 ${inbox.page} / ${inbox.pages} 页`), next);
  renderContentDetail();
}
async function refreshContent() {
  const b = $('#refresh-content'); b.disabled = true; b.textContent = '正在收集…'; $('#feed-errors').hidden = true;
  try { const result = await api('/api/content/refresh', { method: 'POST' }); state.contentInbox.status = 'unread'; state.contentInbox.page = 1; await loadContent(); if (result.errors?.length) { $('#feed-errors').hidden = false; $('#feed-errors').textContent = result.errors.map(x => `${x.source}：${x.error}`).join('\n'); } toast(result.added ? `收集到 ${result.added} 条新内容。` : result.errors?.length ? '部分来源暂时未能读取，原有内容仍然保留。' : '已检查，目前没有新内容。'); }
  finally { b.disabled = false; b.textContent = '收集新内容'; }
}
async function runNewsBrief() {
  const b = $('#news-brief-trigger'); b.disabled = true; b.textContent = '林晓薇正在挑…';
  try {
    const result = await api('/api/news/brief', { method: 'POST', body: {}, timeout: 95000 });
    if (!result.delivered) { await loadProactiveStatus(false).catch(() => {}); toast(proactiveReason(result.reason, { ...state.proactive.runtime, lastError: null })); return; }
    await selectRole('miyue'); await Promise.all([loadChat(), pollInbox()]); toast('林晓薇已经挑好一条，放在聊天里了。');
  } finally { b.disabled = false; b.textContent = '让林晓薇讲一条'; }
}
async function addFeed(event) { event.preventDefault(); const form = new FormData(event.currentTarget); await api('/api/feeds', { method: 'POST', body: { url: String(form.get('url')).trim(), title: String(form.get('title')).trim() } }); event.target.reset(); await loadContent(); toast('已添加来源，点击收集来读取。'); }

async function loadMoments() {
  const {items}=await api('/api/moments'),box=$('#moment-items');box.replaceChildren();
  if(!items.length)box.append(node('p','fine-print','在聊天消息下点击“收藏片段”，留下想再回味的那一句。'));
  for(const item of items){
    const card=node('article','moment-card');card.append(node('span','badge',roleName(item.roleId)),node('p','moment-quote',item.text));
    const image=node('img','moment-image');image.alt='用户为收藏片段添加的配图';image.loading='lazy';image.hidden=!item.image;if(item.image)image.src=item.image;card.append(image);
    const details=node('details','');details.append(node('summary','','配图与备注'));
    const note=node('textarea','');note.rows=2;note.maxLength=500;note.placeholder='给这个片段留一句备注';note.value=item.caption||'';note.setAttribute('aria-label','片段备注');
    const file=node('input','');file.type='file';file.accept='image/jpeg,image/png,image/webp';file.setAttribute('aria-label','为片段添加配图');let draftImage=item.image;
    file.addEventListener('change',action(async()=>{if(!file.files[0])return;draftImage=await prepareAvatar(file.files[0]);image.src=draftImage;image.hidden=false;file.value='';toast('配图已预览，点击保存。');}));
    const actions=node('div','form-row wrap');actions.append(button('保存','small-button',action(async()=>{await api('/api/moments',{method:'POST',body:{action:'update',messageId:item.messageId,image:draftImage,caption:note.value}});toast('配图与备注已保存。');})),button('移除配图','text-button',()=>{draftImage=null;image.hidden=true;}));details.append(node('p','fine-print','本地配图，居中裁成正方形；来源由你说明。'),file,note,actions);card.append(details);
    if(item.caption)card.append(node('p','fine-print',item.caption));
    const footer=node('div','form-row wrap'); if (roleById(item.roleId)) footer.append(button('去聊聊','text-button',action(async()=>{await selectRole(item.roleId);$('#message-input').value='想接着聊你我之前说的：“'+item.text.slice(0,160)+'”';$('#message-input').focus();}))); footer.append(button('取消收藏','text-button',action(async()=>{await api('/api/moments',{method:'POST',body:{action:'remove',messageId:item.messageId}});await loadMoments();})));card.append(footer);box.append(card);
  }
}
async function loadTopics() {
  const {items}=await api('/api/topics'),box=$('#topic-tracks');box.replaceChildren();
  if(!items.length)box.append(node('p','fine-print','还没有关注具体话题，可以从下面的文章开始。'));
  for(const item of items){
    const row=node('article','followup-row topic-followup'),copy=node('div');copy.append(safeLink(item.sourceUrl,item.title));
    if(item.change){
      const change=item.change,details=node('details','source-change'),summary=node('summary','');summary.append(node('span','',change.label||'来源材料有差异'),node('span','badge','尚未核实'));details.append(summary);
      const note=node('p','fine-print','这里只并排展示来源原文，差异不代表事情已经发生变化，也不判断哪一份正确。');details.append(note);
      const grid=node('div','source-change-grid');
      for(const [label,source] of [['此前材料',change.previous],['当前材料',change.current]]){
        const panel=node('section','source-change-panel');panel.append(node('h4','',label));
        if(source){panel.append(source.url?safeLink(source.url,source.title||'打开来源'):node('strong','',source.title||'未命名来源'));const meta=[({article_excerpt:'原文摘录',research_excerpt:'研究资料摘录',feed_summary:'订阅摘要'})[source.kind]||'来源资料',source.publishedAt?dateText(source.publishedAt,true):null].filter(Boolean).join(' · ');if(meta)panel.append(node('small','fine-print',meta));panel.append(node('p','source-change-text',source.text||'来源没有提供可展示的原文。'));}
        else panel.append(node('p','fine-print','没有可比的旧材料。'));
        grid.append(panel);
      }
      details.append(grid);copy.append(details);
    }
    row.append(copy,button('取消关注','text-button',action(async()=>{await api('/api/topics',{method:'POST',body:{action:'unfollow',id:item.id}});await loadTopics();})));box.append(row);
  }
}
async function loadFollowups() {
  const {items}=await api('/api/followups'),box=$('#followup-items');box.replaceChildren();
  const labels={pending:'之后问问',delivered:'已经问过',done:'已结束',cancelled:'已取消',expired:'已过时'};
  if(!items.length)box.append(node('p','fine-print','还没有需要回访的近期安排。不确定的、假设的事情不会自动记成约定。'));
  for(const item of items.slice(-30).reverse()) {
    const row=node('article','followup-row'),copy=node('div','');copy.append(node('span','badge',`${roleName(item.roleId)} · ${labels[item.status]||item.status}`),node('p','',item.topic),node('small','fine-print',`适合再问的时间：${dateText(item.dueAt,true)}`));
    const controls=node('div','form-row wrap');
    if(['pending','delivered'].includes(item.status))for(const [status,label] of [['done','已经结束'],['cancelled','不用再问']])controls.append(button(label,'text-button',action(async()=>{await api('/api/followups',{method:'POST',body:{id:item.id,status}});await loadFollowups();})));
    if(item.status==='pending'){
      const when=node('input','');when.type='datetime-local';when.setAttribute('aria-label','修改回访时间');const date=new Date(item.dueAt);when.value=new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);
      controls.append(when,button('改时间','small-button',action(async()=>{if(!when.value)throw new Error('请选择时间');await api('/api/followups',{method:'POST',body:{id:item.id,dueAt:new Date(when.value).toISOString()}});await loadFollowups();})));
    }
    copy.append(controls);row.append(copy);box.append(row);
  }
}
async function loadReminders() { const result = await api('/api/reminders'), visibleRoles = new Set(state.roles.map(role => role.id)); state.reminders = (result.reminders || []).filter(item => visibleRoles.has(item.role)); renderReminders(); }
function renderReminders() {
  const box = $('#reminder-items'); box.replaceChildren();
  if (!state.reminders.length) box.append(empty('留一个以后再聊的理由。', '可以是一次近况、一部电影，或者一个还没聊完的问题。'));
  for (const item of state.reminders) {
    const card = node('article', 'reminder-card'), copy = node('div');
    copy.append(node('span', 'badge', `${roleName(item.role)} · ${item.status === 'delivered' ? '已留在会话里' : state.settings.quiet ? '等待恢复联系' : '待到约定时间'}`), node('p', '', item.text), node('time', '', dateText(item.dueAt, true)));
    card.append(copy, button(item.status === 'delivered' ? '移除记录' : '取消', 'text-button', action(async () => { await api(`/api/reminders/${item.id}`, { method: 'DELETE' }); await loadReminders(); })));
    box.append(card);
  }
}
async function addReminder(event) {
  event.preventDefault(); const time = new Date($('#reminder-time').value);
  if (Number.isNaN(time.valueOf()) || time < new Date()) throw new Error('请选择未来的提醒时间。');
  await api('/api/reminders', { method: 'POST', body: { role: $('#reminder-role').value, text: $('#reminder-text').value.trim(), dueAt: time.toISOString() } }); $('#reminder-form').reset(); await loadReminders(); toast('约好了。后台在线时，她会在会话里提醒你。');
}

function renderProvider() {
  const p = state.provider; $('#model-url').value = p.baseUrl || ''; $('#model-name').value = p.model || ''; $('#model-key').value = '';
  $('#provider-badge').textContent = p.configured ? '已配置 · 可测试连通性' : '待配置';
  $('#key-hint').textContent = p.hasKey ? '已保存；留空会保留现有密钥' : '本地无密钥服务可以留空';
  $('#provider-status').classList.toggle('ready', Boolean(p.configured)); $('#provider-status span').textContent = p.configured ? `模型已配置 · ${p.model}` : '模型待连接 · 前往设置';
  $('#setup-shortcut').hidden = Boolean(p.configured) || state.view === 'settings';
  if (p.isEnvManaged) $('#provider-result').textContent = '当前部分配置由环境变量提供，环境变量会优先于页面保存的值。';
}
async function saveProvider(event) {
  event.preventDefault(); const body = { baseUrl: $('#model-url').value.trim(), model: $('#model-name').value.trim() }; const key = $('#model-key').value; if (key.trim()) body.apiKey = key.trim();
  const result = await api('/api/provider', { method: 'POST', body }); state.provider = result.provider; renderProvider(); $('#provider-result').textContent = '已保存。点击测试，可以发送一句不含聊天记录的问候来检查接口。'; toast('模型配置已保存。');
}
async function testProvider() {
  const b = $('#test-provider'); b.disabled = true; $('#provider-result').textContent = '正在发送简短的连通性问候…';
  try { const result = await api('/api/provider/test', { method: 'POST' }); $('#provider-result').textContent = `连接成功。模型回复：${result.reply}`; }
  catch (error) { $('#provider-result').textContent = `连接未成功：${error.message}`; }
  finally { b.disabled = false; }
}
async function loadVoice(force=false) {
  loadVoiceCatalog(force===true).catch(error=>{ $('#voice-catalog-note').textContent=error.message; });
  state.voice = await api('/api/voice/health', { timeout: 25000 }); const voice = state.voice, box = $('#voice-health'); box.replaceChildren();
  for (const [label, status] of [['语音合成', voice.available && voice.state === 'ready' ? '可以朗读' : voice.state === 'loading' ? '正在加载' : '暂不可用'], ['录音转写', voice.stt?.state === 'ready' ? '可以录音转文字' : voice.stt?.available ? '已安装，尚未运行' : '暂不可用']]) { const c = node('div', 'health-item', label); c.append(node('strong', '', status)); box.append(c); }
  $('#record-button').title = voice.stt?.state === 'ready' ? '开始录音，点击后授权麦克风' : '本地语音识别尚未运行，可以先输入文字';
}
async function loadVoiceCatalog(force=false) {
  const result=await api('/api/voice/catalog'+(force?'?refresh=1':'' ),{timeout:25000}),box=$('#role-voices');box.replaceChildren();
  $('#voice-catalog-note').textContent=result.available?`可用音色 ${result.voices.length} 个。分别保存后，每次朗读都会指定该角色的声音，不改动 TTS 的全局选择。`:result.error;
  for(const role of state.roles) {
    const row=node('div','voice-editor'),select=node('select','');select.setAttribute('aria-label',`${role.name}的声音`);
    const option=node('option','','跟随 TTS 全局选择');option.value='';select.append(option);
    for(const voice of result.voices){const o=node('option','',`${voice.name}${voice.description?' · '+voice.description:''}`);o.value=voice.id;select.append(o);}
    const saved=result.assignments[role.id];
    if(saved?.voiceId&&!result.voices.some(v=>v.id===saved.voiceId)){const o=node('option','',`${saved.name}（暂不可用）`);o.value=saved.voiceId;select.append(o);}
    select.value=saved?.voiceId||'';select.disabled=!result.available;
    const save=button('保存','small-button',action(async()=>{await api('/api/voice/roles',{method:'POST',body:{roleId:role.id,voiceId:select.value||null}});toast(`${role.name}的音色已保存。`);}));save.disabled=!result.available;
    const preview=button('试听','text-button',action(async()=>{await playVoiceJob('/api/voice/preview',{roleId:role.id,voiceId:select.value||null});}));preview.disabled=!result.available;
    row.append(avatarNode(role,'message-avatar'),node('strong','',role.name),select,save,preview);box.append(row);
  }
}
async function stopAudio() {
  state.audioEpoch++; const session = state.audioSession; state.audioSession = null; const job = state.audioJob; state.audioJob = null;
  const player = $('#audio-player'); player.pause(); player.removeAttribute('src'); player.load(); player.hidden = true; $('#audio-panel').hidden = true;
  if(session){try{await api(`/api/voice-session/${session}/close`,{method:'POST',timeout:15000});}catch{}}
  if (job) { try { await api(`/api/voice/${job}/close`, { method: 'POST', timeout: 15000 }); } catch { /* A finished or unreachable local job does not block text use. */ } }
}
async function speak(messageId) {
  await stopAudio();const epoch=state.audioEpoch;
  $('#audio-panel').hidden=false;$('#audio-status').hidden=false;$('#audio-status').textContent='正在准备第一段语音…';
  let id;
  try{
    const result=await api('/api/voice-session/start',{method:'POST',body:{messageId}});id=result.sessionId;
    if(epoch!==state.audioEpoch){await api(`/api/voice-session/${id}/close`,{method:'POST'});return;}
    state.audioSession=id;
    for(let index=0;index<result.segmentCount&&epoch===state.audioEpoch;index++){
      const deadline=Date.now()+240000;
      while(epoch===state.audioEpoch){
        const status=await api(`/api/voice-session/${id}/status`),segment=status.segments.find(s=>s.index===index);
        if(segment?.state==='finished')break;
        if(['error','cancelled','closed'].includes(segment?.state))throw new Error(segment.error||'语音生成已停止。');
        if(Date.now()>deadline)throw new Error('这一段语音等待较久，请稍后重试。');
        await new Promise(resolve=>setTimeout(resolve,600));
      }
      if(epoch!==state.audioEpoch)return;
      const player=$('#audio-player');player.src=`/api/voice-session/${id}/audio/${index}`;player.hidden=false;
      $('#audio-panel').hidden=false;$('#audio-status').hidden=false;$('#audio-status').textContent=`第 ${index+1} / ${result.segmentCount} 段`;
      const ended=new Promise((resolve,reject)=>{
        const done=()=>{cleanup();resolve();},error=()=>{cleanup();reject(new Error('语音播放失败。'));},stop=()=>{if(epoch!==state.audioEpoch){cleanup();resolve();}};
        const timer=setInterval(stop,200);
        function cleanup(){clearInterval(timer);player.removeEventListener('ended',done);player.removeEventListener('error',error);}
        player.addEventListener('ended',done,{once:true});player.addEventListener('error',error,{once:true});
      });
      try{await player.play();}catch{$('#audio-status').textContent='点击播放即可收听';}
      await ended;if(epoch!==state.audioEpoch)return;
      await api(`/api/voice-session/${id}/advance`,{method:'POST',body:{index}});
    }
    if(epoch===state.audioEpoch){state.audioSession=null;await stopAudio();}
  }catch(error){if(epoch===state.audioEpoch){await stopAudio();throw error;}}
}
async function playVoiceJob(endpoint,body) {
  await stopAudio(); const epoch = state.audioEpoch; $('#audio-panel').hidden = false; $('#audio-status').hidden = false; $('#audio-status').textContent = '本地语音正在生成，可以继续聊天…';
  let job;
  try {
    const started = await api(endpoint, { method: 'POST', body }); job = started.jobId;
    if (epoch !== state.audioEpoch) { await api(`/api/voice/${job}/close`, { method: 'POST' }); return; }
    state.audioJob = job; const deadline = Date.now() + 240000;
    while (epoch === state.audioEpoch) {
      if (Date.now() > deadline) throw new Error('语音生成等待较久，已停止本次等待。');
      const status = await api(`/api/voice/${job}/status`, { timeout: 20000 });
      if (status.state === 'error') throw new Error(status.error || '语音生成失败。');
      if (['cancelled', 'closed'].includes(status.state)) throw new Error('语音任务已停止。');
      if (status.state === 'finished') break;
      await new Promise(resolve => setTimeout(resolve, 1200));
    }
    if (epoch !== state.audioEpoch) return;
    const player = $('#audio-player'); player.src = `/api/voice/${job}/audio`; player.hidden = false; $('#audio-status').textContent = '语音已准备好';
    try { await player.play(); $('#audio-status').hidden = true; } catch { $('#audio-status').textContent = '点击播放即可收听'; }
  } catch (error) { if (epoch === state.audioEpoch) { await stopAudio(); throw error; } }
}
async function toggleRecording() {
  if (state.recorder?.state === 'recording') { state.recorder.stop(); return; }
  await loadVoice();
  if (state.voice?.stt?.state !== 'ready') { toast('本地语音识别尚未运行。请在现有语音服务中启动识别，再回这里录音。', 7500); return; }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('这个浏览器暂不支持录音，请先输入文字。');
  await stopAudio();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true }); state.recordStream = stream;
  const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(t => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : {}); state.recorder = recorder; const chunks = []; let size = 0;
  const maxTimer = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, 120000);
  recorder.ondataavailable = e => { chunks.push(e.data); size += e.data.size; if (size > 18 * 1024 * 1024 && recorder.state === 'recording') recorder.stop(); };
  recorder.onstop = action(async () => {
    clearTimeout(maxTimer); stream.getTracks().forEach(t => t.stop()); state.recorder = null; state.recordStream = null; $('#record-button').classList.remove('recording'); $('#record-button').disabled = true; $('#record-button span').textContent = '转写中';
    try { const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }); const result = await api('/api/transcribe', { method: 'POST', raw: true, body: blob, headers: { 'Content-Type': blob.type }, timeout: 95000 }); $('#message-input').value += ($('#message-input').value ? '\n' : '') + result.text; toast(result.text ? '已转成文字，检查后再发送。' : '没有识别到文字，请再试一次。'); }
    finally { $('#record-button').disabled = false; $('#record-button span').textContent = '说话'; }
  });
  recorder.start(1000); $('#record-button').classList.add('recording'); $('#record-button span').textContent = '结束录音';
}

function wireEvents() {
  $$('[data-view]').forEach(b => b.addEventListener('click', action(() => showView(b.dataset.view))));
  for (const id of ['#setup-shortcut', '#provider-status']) $(id).addEventListener('click', action(() => showView('settings')));
  $('#open-memory').addEventListener('click', action(() => showView('memory'))); $('#open-reminder').addEventListener('click', action(() => showView('reminders')));
  $('#quiet').addEventListener('change', action(async e => { try { await setQuiet(e.target.checked); } catch (error) { renderQuiet(); throw error; } }));
  const mobileLabel = node('label', 'quiet-control mobile-quiet'); mobileLabel.style.display = 'none'; mobileLabel.style.margin = '18px 0'; mobileLabel.append(node('span', '', '暂时安静（延后主动提醒）')); const mobileInput = node('input'); mobileInput.id = 'mobile-quiet'; mobileInput.type = 'checkbox'; mobileInput.setAttribute('role', 'switch'); mobileLabel.append(mobileInput, node('span', 'toggle')); $('#view-reminders').insertBefore(mobileLabel, $('.editor-card', $('#view-reminders'))); mobileInput.addEventListener('change', action(async e => { try { await setQuiet(e.target.checked); } catch (error) { renderQuiet(); throw error; } }));
  const latest = button('回到最新消息 ↓', 'chat-scroll-latest', () => followChatToBottom({ force: true })); latest.id = 'chat-scroll-latest'; latest.hidden = true; $('#view-chat').append(latest);
  $('#chat-form').addEventListener('submit', action(sendChat)); $('#message-input').addEventListener('input', reportTyping); $('#message-input').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('#chat-form').requestSubmit(); } }); const chatScroll = $('#chat-scroll'); chatScroll.addEventListener('wheel', pauseChatFollowForUser, { passive: true }); chatScroll.addEventListener('touchmove', pauseChatFollowForUser, { passive: true }); chatScroll.addEventListener('pointerdown', pauseChatFollowForUser, { passive: true }); chatScroll.addEventListener('keydown', event => { if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) pauseChatFollowForUser(); }); chatScroll.addEventListener('scroll', () => { if (chatIsNearBottom()) { state.chatScroll.following = true; state.chatScroll.unseen = false; updateChatScrollButton(); } markVisibleInboxRead().catch(() => {}); });
  if ('ResizeObserver' in window) { const observer = new ResizeObserver(() => handleChatLayoutChange()); observer.observe($('#chat-messages')); observer.observe($('#character-profile')); }
  window.addEventListener('resize', handleChatLayoutChange);
  $('#memory-form').addEventListener('submit', action(saveMemory)); $('#cancel-memory-edit').addEventListener('click', resetMemoryForm);
  $('#episode-role').addEventListener('change', action(async e => { await loadEpisodes(e.target.value); }));
  $('#save-interaction-preferences').addEventListener('click', action(saveInteractionPreferences));
  $('#recall-role').addEventListener('change', action(async e => { $('#confirm-clear-recall').hidden = true; await loadRecall(e.target.value); }));
  $('#save-recall').addEventListener('click', action(() => saveRecall($('#recall-summary').value.trim())));
  $('#refresh-recall').addEventListener('click', action(refreshRecall));
  $('#clear-recall').addEventListener('click', () => { $('#confirm-clear-recall').hidden = false; $('#recall-status').textContent = '确认后会清空自动摘要；历史聊天仍保留，但不会再由这份摘要提供给后续对话。'; });
  $('#confirm-clear-recall').addEventListener('click', action(async () => { await saveRecall(''); $('#confirm-clear-recall').hidden = true; }));
  $('#refresh-usage').addEventListener('click', action(loadUsage));
  $('#refresh-life').addEventListener('click', action(loadLife)); $('#open-chat-history-life').addEventListener('click', action(openChatHistory)); $('#life-settings-form').addEventListener('submit', action(saveLifeSettings));
  $('#add-travel-stop').addEventListener('click', () => addTravelStop()); $('#life-travel-form').addEventListener('submit', action(saveTravel)); addTravelStop();
  $('#refresh-content').addEventListener('click', action(refreshContent)); $('#news-brief-trigger').addEventListener('click', action(runNewsBrief)); $('#feed-form').addEventListener('submit', action(addFeed));
  $('#content-search').addEventListener('submit', action(async event => { event.preventDefault(); state.contentInbox.query = $('#content-query').value.trim(); state.contentInbox.page = 1; await loadContent(); }));
  $('#content-query').addEventListener('search', action(async () => { state.contentInbox.query = $('#content-query').value.trim(); state.contentInbox.page = 1; await loadContent(); }));
  $('#content-page-read').addEventListener('click', action(() => setContentState(state.items.map(item => item.id), 'read')));
  $('#zhihu-refresh').addEventListener('click', action(refreshZhihu)); $('#zhihu-settings').addEventListener('click', action(() => showView('settings'))); $('#zhihu-form').addEventListener('submit', action(saveZhihu)); $('#zhihu-test').addEventListener('click', action(testZhihuQuota)); $('#zhihu-clear-key').addEventListener('click', action(async () => { const result = await api('/api/zhihu/config', { method: 'POST', body: { clearKey: true } }); state.zhihu.config = result.config || state.zhihu.config; state.zhihu.runtime = { ...state.zhihu.runtime, ...(result.runtime || {}) }; $('#zhihu-secret').value = ''; renderZhihu(false); toast('已清除本地保存的知乎 Access Secret。'); })); $$('#zhihu-form input,#zhihu-form select').forEach(input => input.addEventListener('input', () => { state.zhihu.formDirty = true; }));
  $('#open-chat-history').addEventListener('click', action(openChatHistory));
  $('#open-character').addEventListener('click', () => { const details = $('#character-profile details'); if (details) { state.chatScroll.following=false;state.chatScroll.epoch++;updateChatScrollButton();details.open = true; $('#chat-scroll').scrollTop = 0; details.querySelector('summary')?.focus(); } });
  $('#close-chat-history').addEventListener('click', () => $('#chat-history-dialog').close());
  $('#load-older-chat-history').addEventListener('click', action(() => loadChatHistory()));
  $('#delete-chat-history').addEventListener('click', action(deleteSelectedChatHistory));
  $('#select-chat-history-page').addEventListener('change', event => { if (event.target.checked) { for (const item of chatHistory.items) { if (chatHistory.selected.size >= 100) break; chatHistory.selected.add(String(item.id)); } } else chatHistory.selected.clear(); renderChatHistory(); });
  $('#reminder-form').addEventListener('submit', action(addReminder)); $('#provider-form').addEventListener('submit', action(saveProvider)); $('#test-provider').addEventListener('click', testProvider);
  $('#proactive-form').addEventListener('submit', action(saveProactiveSettings)); $('#proactive-run').addEventListener('click', action(runProactiveNow)); $('#enable-notifications').addEventListener('click', action(enableNotifications)); $('#refresh-proactive').addEventListener('click', action(async () => { await loadProactiveStatus(true); await pollInbox(); toast('主动陪伴状态已刷新。'); })); $$('#proactive-form input').forEach(input => input.addEventListener('input', () => { state.proactive.formDirty = true; }));
  $('#clear-provider-key').addEventListener('click', action(async () => { const result = await api('/api/provider', { method: 'POST', body: { clearKey: true } }); state.provider = result.provider; renderProvider(); toast(result.provider.hasKey ? '环境变量中的密钥仍然生效，请在启动配置中调整。' : '已清除本地保存的密钥。'); }));
  $('#refresh-voice').addEventListener('click', action(()=>loadVoice(true))); $('#record-button').addEventListener('click', action(toggleRecording)); $('#stop-audio').addEventListener('click', action(stopAudio));
  $('#audio-player').addEventListener('ended', () => { if(state.audioSession)return; const job = state.audioJob; state.audioJob = null; if (job) api(`/api/voice/${job}/close`, { method: 'POST' }).catch(() => {}); $('#audio-status').hidden = false; $('#audio-status').textContent = '已播放完'; });
  $('#audio-player').addEventListener('error', () => { if (state.audioJob) { toast('音频未能加载，请稍后重新朗读。'); stopAudio(); } });
  $('#background-file').addEventListener('change',action(chooseBackground));
  for(const id of ['background-mode','background-position','background-veil','background-blur'])$('#'+id).addEventListener('input',editBackground);
  $('#save-background').addEventListener('click',action(()=>saveBackground()));$('#reset-background').addEventListener('click',action(()=>saveBackground(true)));$('#cancel-background').addEventListener('click',cancelBackground);renderBackgroundSettings();
  $('#reply-pace').addEventListener('change',action(saveReplyPace));
  $('#save-history-window').addEventListener('click',action(saveHistoryWindow));
  $('#save-daily-memory').addEventListener('click',action(saveDailyMemory));
  $('#run-daily-memory').addEventListener('click',action(runDailyMemory));
  $$('#daily-memory-enabled,#daily-memory-time').forEach(input=>input.addEventListener('input',()=>{dailyMemoryDirty=true;}));
  $$('#history-window-days,#history-max-tokens').forEach(input => input.addEventListener('input', () => {
    historyWindowDirty = true;
    historyWindowRevision += 1;
    $('#history-window-status').textContent = '';
  }));
  $('#save-companion-tuning').addEventListener('click', action(saveCompanionTuning));
  $('#restore-companion-defaults').addEventListener('click', () => { const preset = state.companionTuning.presets.find(item => item.id === 'default'); if (preset) applyTuningPreset(preset); });
  for (const input of document.querySelectorAll('input[name="companion-identity"]')) input.addEventListener('change', action(() => aliveness.set(input.value)));
  $('#show-story-arcs').addEventListener('click', action(() => aliveness.story()));
  $('#show-ledger').addEventListener('click', action(() => aliveness.ledger()));
  $('#show-affect').addEventListener('click', action(() => aliveness.affect()));
  $('#show-weekly-report').addEventListener('click', action(() => aliveness.report()));
  $('#save-persona').addEventListener('click', action(() => persona.save()));
  $('#archive-chat-now').addEventListener('click', action(() => aliveness.setDisplay('now')));
  $('#show-all-chat').addEventListener('click', action(() => aliveness.setDisplay(null)));
  $('#reload-companion-tuning').addEventListener('click', action(async () => { await loadCompanionTuning({ force: true }); toast('已重新读取保存的相处偏好。'); }));
  $('#retry-startup').addEventListener('click', bootstrap);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { if (state.view === 'settings') desktopControl.load(); markVisibleInboxRead().catch(() => {}); pollProactive(); } });
  window.addEventListener('pagehide', () => { if(state.audioSession)fetch(`/api/voice-session/${state.audioSession}/close`,{method:'POST',headers:{'content-type':'application/json'},body:'{}',keepalive:true}).catch(()=>{}); state.recordStream?.getTracks().forEach(t => t.stop()); if (state.audioJob) fetch(`/api/voice/${state.audioJob}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', keepalive: true }).catch(() => {}); });
}
async function bootstrap() {
  try {
    const data = await api('/api/bootstrap', { timeout: 15000 }); const roles = (data.roles || []).filter(role => role.id === 'miyue'); Object.assign(state, { roles, role: roles[0]?.id || 'miyue', settings: data.settings, provider: data.provider, memories: data.memories, feeds: data.feeds });
    $('#startup-error').hidden = true; renderRoles(); renderProvider(); renderQuiet(); renderNavigation(); await Promise.all([loadChat(), loadCharacter()]);await pollPending(true);
    loadBackground().catch(() => {}); loadPreferences().catch(() => {}); companionDynamicsSettings.load().catch(() => {}); loadVoice().catch(() => {}); loadContent().catch(() => {}); loadZhihu(false).catch(() => {}); pollProactive();
  } catch (error) { $('#startup-error').hidden = false; $('#startup-error-text').textContent = `${error.message} 请确认本地服务正在运行。`; }
}
wireEvents(); await bootstrap();
setInterval(async () => { if (!state.roles.length) return; try { if (!document.hidden && state.view === 'chat') await Promise.all([loadChat(true), loadCharacter()]); if (!document.hidden && state.view === 'reminders') await Promise.all([loadReminders(),loadFollowups()]); if (!document.hidden && ['settings', 'content'].includes(state.view)) { await loadZhihu(false); if (state.view === 'settings') await Promise.all([loadCompanionTuning(),companionDynamicsSettings.load(),desktopControl.load()]); if (state.view === 'content') await loadContent(true); } await pollProactive(); } catch { /* Keep the visible conversation during a transient outage. */ } }, 8000);

setInterval(()=>{if(state.roles.length&&!document.hidden&&state.view==='chat')pollPending().catch(()=>{});},900);
