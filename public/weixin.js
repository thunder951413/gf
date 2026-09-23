const $ = id => document.getElementById(id);
let snapshot = null;
let busy = false;
let disconnectConfirming = false;
let settingsDirty = false;

function text(value, fallback = '—') { return value === undefined || value === null || value === '' ? fallback : String(value); }
function time(value) {
  if (!value || Number.isNaN(Date.parse(value))) return '尚无记录';
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' }).format(new Date(value));
}
function makeFact(label, content) {
  const item = document.createElement('div'); item.className = 'fact';
  const small = document.createElement('small'); small.textContent = label;
  const strong = document.createElement('strong'); strong.textContent = text(content);
  item.append(small, strong); return item;
}
async function request(route, body) {
  const options = body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  const response = await fetch(route, { ...options, signal: controller.signal }).catch(error => {
    if (controller.signal.aborted) throw new Error('请求超时，请稍后重试。');
    throw error;
  }).finally(() => clearTimeout(timeout));
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || '请求没有完成，请稍后重试。');
  return result;
}
function loginCopy(login = {}) {
  const labels = { waiting: '等待手机扫描二维码。', scanned: '已扫描，请在手机上确认。', confirmed: '手机已确认，正在建立连接。', expired: '二维码已过期，请重新开始配对。', error: login.error || '配对没有完成，请重新开始。' };
  return labels[login.status] || '尚未开始手机配对。';
}
function connectionPresentation(data) {
  if (data.state === 'auth_expired') return ['登录已过期', 'error'];
  if (data.state === 'paused') return ['已暂停', 'warn'];
  if (data.state === 'connecting') return ['连接中', 'warn'];
  if (data.connected) return ['已连接', 'good'];
  if (data.login?.status === 'expired') return ['二维码已过期', 'warn'];
  if (data.login?.status === 'error' || data.state === 'error') return ['需要处理', 'error'];
  if (data.login?.status === 'waiting' || data.login?.status === 'scanned' || data.login?.status === 'confirmed') return ['等待手机确认', 'warn'];
  if (!data.configured) return ['尚未配置', 'warn'];
  return ['未连接', 'warn'];
}
function stateLabel(value, connected) {
  return ({ auth_expired: '登录已过期', paused: '已暂停', connecting: '连接中', connected: '已连接', unbound: '未绑定', error: '连接出错' })[value] || (connected ? '已连接' : '状态未知');
}
function sameOriginImageUrl(value) {
  try {
    const url = new URL(value, window.location.href);
    return url.origin === window.location.origin && /\.(?:png|jpe?g|webp|gif|svg)$/i.test(url.pathname) ? url.href : null;
  }
  catch { return null; }
}
function render(data) {
  snapshot = data;
  const [badge, tone] = connectionPresentation(data);
  $('connection-badge').textContent = badge; $('connection-badge').className = `badge ${tone}`;
  $('page-status').textContent = `已更新 · ${data.accountLabel ? `账号：${data.accountLabel}` : '等待微信连接'}`;
  $('page-status').classList.remove('error');
  if (!settingsDirty) {
    $('enabled').checked = Boolean(data.enabled);
    $('proactive-enabled').checked = Boolean(data.proactiveEnabled);
  }
  syncProactiveAvailability();
  const login = data.login || {};
  const hasQr = Boolean(login.qrcodeUrl);
  $('qr-code').hidden = !hasQr; $('qr-placeholder').hidden = hasQr;
  if (hasQr) $('qr-code').src = login.qrcodeUrl;
  const downloadableQr = hasQr && sameOriginImageUrl(login.qrcodeUrl);
  $('save-qr').hidden = !downloadableQr;
  if (downloadableQr) $('save-qr').href = downloadableQr;
  $('qr-link').hidden = !login.qrcodeLink;
  if (login.qrcodeLink) $('qr-link').href = login.qrcodeLink;
  $('login-status').textContent = loginCopy(login);
  $('start-login').hidden = Boolean(data.connected);
  $('disconnect').hidden = !data.configured || disconnectConfirming;
  $('confirm-disconnect').hidden = !disconnectConfirming;
  $('cancel-disconnect').hidden = !disconnectConfirming;
  $('facts').replaceChildren(
    makeFact('服务状态', stateLabel(data.state, data.connected)),
    makeFact('待投递', `${Number(data.pendingCount || 0)} 条`),
    makeFact('投递失败', `${Number(data.failedCount || 0)} 条`),
    makeFact('最近收到', time(data.lastInboundAt)),
    makeFact('最近微信已受理', time(data.lastOutboundAt)),
    makeFact('角色', data.roleName || '林晓薇')
  );
  $('last-error').hidden = !data.lastError;
  $('last-error').textContent = data.lastError ? `服务返回：${data.lastError}` : '';
}
function setBusy(next) {
  busy = next;
  for (const id of ['refresh', 'start-login', 'disconnect', 'confirm-disconnect', 'cancel-disconnect', 'save-settings']) $(id).disabled = next;
}
async function load() {
  if (busy) return;
  setBusy(true);
  try { render(await request('/api/weixin')); }
  catch (error) { $('page-status').textContent = error.message; $('page-status').classList.add('error'); }
  finally { setBusy(false); }
}
async function mutate(route, body, success) {
  if (busy) return;
  setBusy(true);
  try { render(await request(route, body)); if (success) $('settings-status').textContent = success; }
  catch (error) { $('settings-status').textContent = error.message; }
  finally { setBusy(false); }
}
function syncProactiveAvailability() {
  const enabled = $('enabled').checked;
  $('proactive-enabled').disabled = !enabled;
}
async function saveSettings() {
  if (busy) return;
  setBusy(true);
  try {
    const result = await request('/api/weixin/settings', { enabled: $('enabled').checked, proactiveEnabled: $('proactive-enabled').checked });
    settingsDirty = false;
    render(result);
    $('settings-status').textContent = '设置已保存。';
  } catch (error) {
    $('settings-status').textContent = error.message;
  } finally { setBusy(false); }
}
document.addEventListener('DOMContentLoaded', () => {
  $('refresh').addEventListener('click', load);
  $('start-login').addEventListener('click', () => mutate('/api/weixin/login', {}, '已请求新的配对二维码。'));
  $('disconnect').addEventListener('click', () => { disconnectConfirming = true; render(snapshot || {}); });
  $('cancel-disconnect').addEventListener('click', () => { disconnectConfirming = false; render(snapshot || {}); });
  $('confirm-disconnect').addEventListener('click', async () => { disconnectConfirming = false; await mutate('/api/weixin/disconnect', {}, '已断开微信连接。'); });
  $('settings-form').addEventListener('submit', event => { event.preventDefault(); saveSettings(); });
  $('enabled').addEventListener('change', () => { settingsDirty = true; syncProactiveAvailability(); });
  $('proactive-enabled').addEventListener('change', () => { settingsDirty = true; });
  load();
  setInterval(() => { if (!document.hidden) load(); }, 3000);
});
