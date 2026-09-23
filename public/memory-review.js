import { createHistoryCorrections } from './history-corrections.js';

const API_URL = '/api/recall/miyue/review';
const state = { controller: null, sequence: 0 };

const elements = {
  refresh: document.querySelector('#refresh'),
  notice: document.querySelector('#notice'),
  overview: document.querySelector('#overview'),
  items: document.querySelector('#items'),
  itemsNote: document.querySelector('#items-note'),
  runs: document.querySelector('#runs'),
};
const historyCorrections = createHistoryCorrections({
  root: document.querySelector('#history-corrections'),
  status: document.querySelector('#history-corrections-status'),
});

function text(value, fallback = '未提供') {
  if (value === null || value === undefined || value === '') return fallback;
  return String(value);
}

function number(value) {
  return new Intl.NumberFormat('zh-CN').format(Number(value) || 0);
}

function formatTime(value) {
  if (!value) return '未提供时间';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? text(value) : new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium', timeStyle: 'short', hour12: false,
  }).format(date);
}

function append(parent, tagName, content, className) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  parent.append(node);
  return node;
}

function empty(parent, title, detail) {
  parent.replaceChildren();
  const box = append(parent, 'div', undefined, 'memory-review-empty');
  append(box, 'h3', title);
  append(box, 'p', detail);
}

function badge(parent, label) {
  append(parent, 'span', label);
}

function subjectLabel(subject) {
  return ({ user: '用户', character: '林晓薇', miyue: '林晓薇', shared: '双方' })[subject] || text(subject, '未标注主体');
}

function kindLabel(kind) {
  return ({ preference: '偏好', fact: '事实', relationship: '关系', plan: '计划', boundary: '边界', episode: '经历' })[kind] || text(kind, '未标注类型');
}

function statusLabel(status) {
  return ({ current: '当前有效', active: '当前有效', completed: '已完成', archived: '已归档', superseded: '已更新', removed: '已移除' })[status] || text(status, '未标注状态');
}

function stat(parent, label, value, detail) {
  const card = append(parent, 'article', undefined, 'memory-review-stat');
  append(card, 'small', label);
  append(card, 'strong', value);
  append(card, 'small', detail);
}

function summaryChars(items) {
  return items.reduce((total, item) => total + text(item?.summary, '').length, 0);
}

function renderOverview(data) {
  const { policy = {}, shortTerm = {}, longTerm = {}, status = {} } = data;
  const items = Array.isArray(longTerm.items) ? longTerm.items : [];
  elements.overview.replaceChildren();
  stat(elements.overview, '短期原始对话', `${number(shortTerm.messages)} 条`,
    `最近 ${text(policy.shortTermDays, '7')} 天 · ${number(shortTerm.chars)} 字符 · 历史 token 保守预算 ${number(shortTerm.tokens)} / ${number(policy.maxTokens)}${shortTerm.truncated ? '（已按预算保留最近完整对话）' : ''}`);
  stat(elements.overview, '长期结构化记忆', `${number(items.length)} 条`,
    `摘要共 ${number(summaryChars(items))} 字符 · 修订 ${text(longTerm.revision, '未标注')}`);
  stat(elements.overview, '等待整理的较早对话', `${number(status.eligibleMessages)} 条`,
    status.lastError ? `最近状态：${text(status.lastError)}` : '最近状态：正常');
}

function renderItems(data) {
  const { shortTerm = {}, longTerm = {} } = data;
  const items = Array.isArray(longTerm.items) ? longTerm.items : [];
  elements.itemsNote.textContent = `短期范围：${formatTime(shortTerm.oldestAt)} 至 ${formatTime(shortTerm.newestAt)}`;
  if (!items.length) {
    empty(elements.items, '暂时没有长期记忆', '这通常表示还没有足够早的对话需要整理；短期原始对话仍按当前范围保留。');
    return;
  }
  elements.items.replaceChildren();
  for (const item of items) {
    const card = append(elements.items, 'article', undefined, 'memory-review-card');
    append(card, 'h3', text(item.topic, '未命名记忆'));
    const meta = append(card, 'div', undefined, 'memory-review-meta');
    badge(meta, subjectLabel(item.subject));
    badge(meta, `类型：${kindLabel(item.kind)}`);
    badge(meta, statusLabel(item.status));
    if (item.mentions !== undefined) badge(meta, `提及 ${number(item.mentions)} 次`);
    append(card, 'p', text(item.summary, '尚未提供摘要'));
    append(card, 'div', `首次：${formatTime(item.firstAt)}　最近：${formatTime(item.lastAt)}`, 'memory-review-time');
    const evidence = Array.isArray(item.evidence) ? item.evidence : [];
    if (evidence.length) {
      const details = append(card, 'details');
      append(details, 'summary', `查看 ${number(evidence.length)} 条原话依据`);
      const list = append(details, 'div', undefined, 'memory-review-evidence');
      for (const source of evidence) {
        const evidenceItem = append(list, 'blockquote', undefined, 'memory-review-evidence-item');
        append(evidenceItem, 'small', `消息 ${text(source?.messageId, '未提供')}${source?.createdAt || source?.at ? ` · ${formatTime(source.createdAt || source.at)}` : ''}`);
        append(evidenceItem, 'p', text(source?.quote, '未提供原话'));
      }
    }
  }
}

function statsSummary(stats) {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return '未提供统计信息';
  if(stats.failed)return `这批 ${number(stats.rows)} 条原话尚未整理成功，等待重试；旧记忆保持不变。`;
  const labels = { created: '新建', updated: '更新', repeated: '重复', ignored: '忽略', archived: '归档' };
  const priority = ['created', 'updated', 'repeated', 'ignored', 'archived'];
  const facts = priority.filter((key) => stats[key] !== undefined)
    .map((key) => `${labels[key]} ${typeof stats[key] === 'number' ? number(stats[key]) : text(stats[key])}`);
  return facts.length ? facts.join(' · ') : '已保存本次整理统计';
}

function renderRuns(data) {
  const runs = Array.isArray(data.longTerm?.runs) ? data.longTerm.runs : [];
  if (!runs.length) {
    empty(elements.runs, '还没有整理记录', '当较早对话被整理时，这里会保留每次整理的时间、范围和依据。');
    return;
  }
  elements.runs.replaceChildren();
  for (const run of runs) {
    const card = append(elements.runs, 'article', undefined, 'memory-review-card');
    append(card, 'h3', `整理于 ${formatTime(run.createdAt)}`);
    const meta = append(card, 'div', undefined, 'memory-review-meta');
    badge(meta, `记录 ${text(run.id, '未提供')}`);
    if (run.model) badge(meta, `模型：${text(run.model)}`);
    append(card, 'p', statsSummary(run.stats));
    const sources = Array.isArray(run.sources) ? run.sources : [];
    if (sources.length) {
      const sourcesDetails = append(card, 'details');
      append(sourcesDetails, 'summary', `对照本批原始对话（${number(sources.length)} 条）`);
      const sourceList = append(sourcesDetails, 'div', undefined, 'memory-review-evidence');
      for (const source of sources) {
        const sourceItem = append(sourceList, 'blockquote', undefined, 'memory-review-evidence-item');
        const decision=({retained:'已提炼',greeting:'问候',repeat:'重复',filler:'无新增内容',unsupported:'缺少依据',superseded:'被后文更正',transient:'短暂状态',pending_retry:'待重试'})[source?.decision]||'待核对';
        append(sourceItem, 'small', `${subjectLabel(source?.speaker==='assistant'?'character':source?.speaker)} · ${decision} · ${formatTime(source?.createdAt)} · 消息 ${text(source?.id, '未提供')}`);
        append(sourceItem, 'p', text(source?.text, '未提供原话'));
      }
    }
    const details = append(card, 'details');
    append(details, 'summary', '整理详情');
    const dump = { stats: run.stats ?? null, changes: run.changes ?? null, coverage: run.coverage ?? null };
    append(details, 'pre', JSON.stringify(dump, null, 2), 'memory-review-json');
  }
}

function render(data) {
  renderOverview(data);
  renderItems(data);
  renderRuns(data);
}

async function load() {
  historyCorrections.load();
  state.controller?.abort();
  const controller = new AbortController();
  state.controller = controller;
  const sequence = ++state.sequence;
  elements.refresh.disabled = true;
  elements.notice.classList.remove('error');
  elements.notice.textContent = '正在读取记忆资料…';
  try {
    const response = await fetch(API_URL, { headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) throw new Error(`请求失败（${response.status}）`);
    const data = await response.json();
    if (sequence !== state.sequence) return;
    render(data || {});
    elements.notice.textContent = `已读取：${new Intl.DateTimeFormat('zh-CN', { timeStyle: 'short', hour12: false }).format(new Date())}`;
  } catch (error) {
    if (error.name === 'AbortError' || sequence !== state.sequence) return;
    elements.notice.classList.add('error');
    elements.notice.textContent = `无法读取记忆资料：${error.message}`;
    empty(elements.overview, '暂时无法显示资料', '请稍后手动刷新。此页不会改动任何聊天或记忆。');
    empty(elements.items, '暂时无法显示长期记忆', '请检查本地服务是否正在运行。');
    empty(elements.runs, '暂时无法显示整理记录', '请稍后再试。');
    elements.itemsNote.textContent = '';
  } finally {
    if (sequence === state.sequence) elements.refresh.disabled = false;
  }
}

elements.refresh.addEventListener('click', load);
load();
