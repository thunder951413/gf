export function createDesktopControl({ api, toast }) {
  const toggle = document.querySelector('#desktop-character-enabled');
  const badge = document.querySelector('#desktop-character-badge');
  const note = document.querySelector('#desktop-character-note');
  const show = document.querySelector('#show-desktop-character');
  const refresh = document.querySelector('#refresh-desktop-character');
  let current = null, busy = false, request = 0, error = '';

  function render() {
    toggle.checked = Boolean(current?.running);
    toggle.disabled = busy || Boolean(error) || !current?.available;
    show.hidden = !current?.running;
    show.disabled = busy || Boolean(error);
    refresh.disabled = busy;
    badge.textContent = busy ? '正在切换' : error ? '状态未确认' : !current ? '正在读取' : !current.available ? '暂不可用' : current.running ? '已开启' : '已关闭';
    note.textContent = error || current?.reason || (current?.running ? '桌面角色已运行。如果暂时隐藏了，点击“显示角色”即可找回。' : '开启后，林雨薇会出现在桌面上。退出桌面程序后，也可以随时从这里重新打开。');
  }

  async function load() {
    if (busy) return;
    const version = ++request;
    try {
      const status = await api('/api/desktop', { timeout: 15000 });
      if (version !== request) return;
      current = status; error = '';
    } catch (failure) {
      if (version !== request) return;
      error = `${failure.message} 点击“刷新状态”重试。`;
    }
    render();
  }

  async function setEnabled(enabled) {
    if (busy) return;
    busy = true; ++request; error = ''; render();
    try {
      current = await api('/api/desktop', { method: 'POST', body: { enabled }, timeout: 20000 });
      toast(enabled ? '桌面角色已打开。' : '桌面角色已关闭。');
    } catch (failure) {
      // A failed request may still have reached macOS; re-read the actual state.
      try { current = await api('/api/desktop', { timeout: 15000 }); }
      catch { current = null; }
      error = `${failure.message} 点击“刷新状态”确认当前状态。`;
    } finally { busy = false; render(); }
  }

  toggle.addEventListener('change', () => setEnabled(toggle.checked));
  show.addEventListener('click', () => setEnabled(true));
  refresh.addEventListener('click', load);
  render();
  return { load };
}
