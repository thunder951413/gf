export function createHistoryCorrections({ root, status }) {
  const pageSize = 100;
  let request = 0;
  let restoring = false;
  let edits = [];
  let stats = null;
  let hasMore = false;

  const append = (parent, tag, value, className) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    parent.append(node);
    return node;
  };
  const text = (value, fallback = '未提供') => value === null || value === undefined || value === '' ? fallback : String(value);
  const time = value => {
    const date = new Date(value);
    return value && !Number.isNaN(date.valueOf()) ? date.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '未提供时间';
  };
  const empty = () => {
    root.replaceChildren();
    const box = append(root, 'div', undefined, 'memory-review-empty');
    append(box, 'h3', '没有待恢复的历史修订');
    append(box, 'p', '这里会列出对历史存档的修订；恢复只会撤回选中的修订，不会删除聊天记录。');
  };
  function render() {
    if (!edits.length) { empty(); status.textContent = '没有待恢复的历史修订。'; return; }
    root.replaceChildren();
    const summary = Number(stats?.active ?? stats?.count ?? edits.length);
    status.textContent = `显示 ${edits.length} 条修订（当前共 ${summary} 条）。修订文本仅供核对，并不是当前聊天消息。`;
    for (const edit of edits) {
      const card = append(root, 'article', undefined, 'memory-review-card');
      append(card, 'h3', '历史修订记录');
      const meta = append(card, 'div', undefined, 'memory-review-meta');
      append(meta, 'span', edit.stale ? '原始文本已变化' : '可恢复');
      append(meta, 'span', `创建：${time(edit.createdAt)}`);
      if (edit.updatedAt) append(meta, 'span', `更新：${time(edit.updatedAt)}`);
      if (edit.sourceHash) append(meta, 'span', `来源 ${text(edit.sourceHash)}`);

      append(card, 'h4', '原始历史文本');
      append(card, 'p', text(edit.original), 'memory-review-correction-text');
      append(card, 'h4', '修订后的历史存档（非当前聊天）');
      append(card, 'p', text(edit.corrected), 'memory-review-correction-text');
      append(card, 'h4', '修订原因');
      append(card, 'p', text(edit.reason), 'memory-review-correction-reason');

      const controls = append(card, 'div', undefined, 'form-row wrap');
      const restore = append(controls, 'button', '恢复原文', 'small-button');
      restore.type = 'button';
      restore.disabled = restoring || !edit.id;
      restore.addEventListener('click', () => restoreEdit(edit.id, restore));
    }
    if (hasMore) {
      const controls = append(root, 'div', undefined, 'form-row wrap');
      const more = append(controls, 'button', '查看更多', 'small-button');
      more.type = 'button'; more.disabled = restoring;
      more.addEventListener('click', () => load({ reset: false }));
    }
  }
  async function load({ reset = true } = {}) {
    const current = ++request;
    const offset = reset ? 0 : edits.length;
    if (!restoring) status.textContent = reset ? '正在读取历史修订…' : '正在读取更多历史修订…';
    try {
      const response = await fetch(`/api/history-corrections?limit=${pageSize}&offset=${offset}`, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`请求失败（${response.status}）`);
      const data = await response.json();
      if (current !== request) return;
      const next = Array.isArray(data?.edits) ? data.edits : [];
      stats = data?.stats || stats;
      edits = reset ? next : [...edits, ...next.filter(item => !edits.some(existing => existing?.id === item?.id))];
      hasMore = next.length === pageSize;
      render();
    } catch (error) {
      if (current !== request) return;
      status.textContent = `无法读取历史修订：${error.message || '请稍后重试。'}`;
      if (!edits.length) {
        root.replaceChildren();
        const box = append(root, 'div', undefined, 'memory-review-empty');
        append(box, 'h3', '暂时无法显示历史修订');
        append(box, 'p', '请稍后使用页面顶部的刷新按钮重试。');
      }
    }
  }
  async function restoreEdit(id, button) {
    if (restoring || !id) return;
    restoring = true;
    root.querySelectorAll('button').forEach(control => { control.disabled = true; });
    status.textContent = '正在恢复原文…';
    try {
      const response = await fetch('/api/history-corrections/restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ ids: [id] }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data?.error || `请求失败（${response.status}）`);
      const count = Number(data?.count) || 0;
      restoring = false;
      await load({ reset: true });
      status.textContent = `已恢复 ${count} 条原始历史文本。`;
    } catch (error) {
      status.textContent = `恢复未完成：${error.message || '请稍后重试。'}`;
      button.disabled = false;
    } finally { restoring = false; }
  }

  return { load };
}
