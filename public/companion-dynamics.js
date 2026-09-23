export function createCompanionDynamicsSettings({ api, toast }) {
  const $ = selector => document.querySelector(selector);
  const form = $('#companion-dynamics-form');
  const status = $('#companion-dynamics-status');
  const badge = $('#companion-dynamics-badge');
  const stateBox = $('#companion-dynamics-state');
  const socialBox = $('#companion-dynamics-social');
  const lifeBox = $('#companion-dynamics-life');
  const save = $('#save-companion-dynamics');
  const refresh = $('#refresh-companion-dynamics');
  const discover = $('#discover-companion-dynamics');
  const controls = {
    expressionPreferences: $('#companion-expression-preferences'),
    enabled: $('#companion-dynamics-enabled'),
    discoveryEnabled: $('#companion-discovery-enabled'),
    city: $('#companion-dynamics-city'),
    interests: $('#companion-dynamics-interests'),
    dailyDiscoveryCalls: $('#companion-discovery-calls'),
    dailyDiscoveryTokens: $('#companion-discovery-tokens'),
  };
  const model = { snapshot: null, saved: null, draft: null, dirty: false, saving: false, discovering: false, loading: null, request: 0, conflict: false };

  const text = value => value === null || value === undefined || value === '' ? '暂未提供' : String(value);
  const date = value => {
    const parsed = new Date(value);
    return value && !Number.isNaN(parsed.valueOf()) ? parsed.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '尚未更新';
  };
  const same = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {});
  const threadStatus = value => ({ open: '未完待续', resolved: '已告一段落' })[value] || text(value, '状态未提供');
  const discoveryReason = value => ({
    disabled: '自动查找已关闭', unconfigured: '等待模型或公开搜索连接配置完成', too_soon: '距上次自动查找不足 12 小时', budget: '已达到今日查找次数或 token 预算', no_city: '尚未填写城市', cancelled: '本次查找已取消', search_failed: '公开信息查找未完成', model_failed: '活动信息核对未完成', stale: '设置或地点已变化，本次结果未保存', no_results: '本次没有可核对的公开活动', no_verified_events: '没有可验证的公开活动', updated: '已更新公开活动线索',
  })[value] || (value ? text(value) : '尚未运行');
  const currentSettings = settings => ({
    revision: settings?.revision,
    enabled: Boolean(settings?.enabled),
    expressionPreferences: String(settings?.expressionPreferences || ''),
    discoveryEnabled: Boolean(settings?.discoveryEnabled),
    city: String(settings?.city || ''),
    interests: String(settings?.interests || ''),
    dailyDiscoveryCalls: Number(settings?.dailyDiscoveryCalls ?? 0),
    dailyDiscoveryTokens: Number(settings?.dailyDiscoveryTokens ?? 2000),
  });
  const field = (label, value) => {
    const item = document.createElement('div'); item.className = 'runtime-item';
    const title = document.createElement('small'); title.textContent = label;
    const body = document.createElement('strong'); body.textContent = text(value);
    item.append(title, body); return item;
  };
  const renderList = (root, title, rows, describe) => {
    const section = document.createElement('section');
    const heading = document.createElement('h4'); heading.textContent = title; section.append(heading);
    if (!rows?.length) { const empty = document.createElement('p'); empty.className = 'fine-print'; empty.textContent = '此刻没有需要显示的内容。'; section.append(empty); return section; }
    const list = document.createElement('div'); list.className = 'runtime-grid';
    for (const row of rows) list.append(field(row.label || row.subject || '当前状态', describe(row)));
    section.append(list); return section;
  };
  function setControlsDisabled() {
    const busy = model.saving;
    const unavailable = !model.draft;
    for (const control of Object.values(controls)) control.disabled = busy || unavailable;
    save.disabled = busy || !model.dirty || !model.draft;
    refresh.disabled = busy || model.discovering;
    discover.disabled = busy || model.discovering || !model.snapshot;
    badge.textContent = model.saving ? '正在保存' : model.discovering ? '正在查找' : model.conflict ? '有更新待处理' : model.dirty ? '尚未保存' : model.snapshot ? '已读取' : '正在读取';
  }
  function renderForm() {
    if (!model.draft) return;
    controls.expressionPreferences.value = model.draft.expressionPreferences;
    controls.enabled.checked = model.draft.enabled;
    controls.discoveryEnabled.checked = model.draft.discoveryEnabled;
    controls.city.value = model.draft.city;
    controls.interests.value = model.draft.interests;
    controls.dailyDiscoveryCalls.value = String(model.draft.dailyDiscoveryCalls);
    controls.dailyDiscoveryTokens.value = String(model.draft.dailyDiscoveryTokens);
  }
  function renderState() {
    const state = model.snapshot?.state;
    stateBox.replaceChildren();
    const heading = document.createElement('h4'); heading.textContent = '此刻的动态'; stateBox.append(heading);
    const updated = document.createElement('p'); updated.className = 'fine-print'; updated.textContent = `状态版本：${state?.revision ?? 0} · 最近更新：${date(state?.updatedAt)}${model.snapshot?.settings?.enabled ? '' : ' · 自然情绪表达已关闭，仍可查看已保存状态。'}`; stateBox.append(updated);
    stateBox.append(
      renderList(stateBox, '需要', state?.needs, row => [row.intensity === undefined ? '' : `强度 ${row.intensity}`, row.description, row.cause].filter(Boolean).join(' · ') || '暂无说明'),
      renderList(stateBox, '感受', state?.feelings, row => [row.intensity === undefined ? '' : `强度 ${row.intensity}`, row.description, row.cause].filter(Boolean).join(' · ') || '暂无说明'),
      renderList(stateBox, '正在延续的话题', state?.threads, row => [threadStatus(row.status), row.progress, row.openQuestion ? `还想弄清：${row.openQuestion}` : ''].filter(Boolean).join(' · ') || '暂无进展'),
    );
  }
  function publicSource(url) {
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
      const link = document.createElement('a'); link.href = parsed.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = '查看公开来源';
      return link;
    } catch { return null; }
  }
  function renderSocial() {
    if (!socialBox) return;
    socialBox.replaceChildren();
    const social = model.snapshot?.social;
    const heading = document.createElement('h4'); heading.textContent = '朋友与家人'; socialBox.append(heading);
    const note = document.createElement('p'); note.className = 'fine-print';
    note.textContent = '延续林已有的关系和近况。计划不等于已经发生；未分享的生活也不会当成已告诉你的事。'; socialBox.append(note);
    const people = social?.people || [];
    const names = new Map(people.map(person => [person.id, person.name]));
    socialBox.append(renderList(socialBox, '生活中的人', people.map(person => ({ ...person, label: person.name })), person => [person.relationship, person.background].filter(Boolean).join(' · ')));
    socialBox.append(renderList(socialBox, '关系与近况', (social?.notes || []).map(item => ({ ...item, label: names.get(item.personId) || '近况' })), item => `${item.status === 'resolved' ? '已告一段落 · ' : ''}${item.text}`));
    const statuses = { planned: '计划中', ongoing: '正在发生', occurred: '已经发生', cancelled: '已取消' };
    socialBox.append(renderList(socialBox, '交往记录', (social?.events || []).map(item => ({ ...item, label: (item.personIds || []).map(id => names.get(id) || id).join('、') || '交往' })), item => [statuses[item.status] || item.status, item.text, item.at ? date(item.at) : '', item.shared === false ? '尚未分享' : '聊天中提及'].filter(Boolean).join(' · ')));
  }
  function activityCard(candidate, { experienced = false } = {}) {
    const card = document.createElement('article'); card.className = 'runtime-item';
    const title = document.createElement('strong'); title.textContent = candidate?.title || '未命名活动'; card.append(title);
    const detail = document.createElement('small');
    detail.textContent = [candidate?.city, candidate?.venue, candidate?.startsOn && candidate?.endsOn ? `${candidate.startsOn} 至 ${candidate.endsOn}` : candidate?.startsOn].filter(Boolean).join(' · ') || '地点或日期未提供';
    card.append(detail);
    const participation = document.createElement('p'); participation.className = 'fine-print';
    participation.textContent = experienced ? `林晓薇的虚构参与：${text(candidate?.participation?.note, '未提供说明')}。这不表示你参加过。` : '公开活动线索 · 尚未参加。';
    card.append(participation);
    if (experienced && candidate?.participation?.updatedAt) {
      const when = document.createElement('small'); when.textContent = `记录于 ${date(candidate.participation.updatedAt)}`; card.append(when);
    }
    const source = publicSource(candidate?.sourceURL);
    if (source) card.append(source);
    return card;
  }
  function renderLife() {
    const life = model.snapshot?.life;
    const settings = model.snapshot?.settings || {};
    lifeBox.replaceChildren();
    const heading = document.createElement('h4'); heading.textContent = '生活发现'; lifeBox.append(heading);
    const note = document.createElement('p'); note.className = 'fine-print';
    if (!settings.discoveryEnabled) note.textContent = '自动公开信息查找已关闭；已保存的公开活动线索和虚构经历仍可在下方核对。';
    else if (!life?.configured) note.textContent = '自动公开信息查找已开启，每 12 小时最多运行一次；正在等待模型与公开搜索连接配置完成。';
    else if (life?.running) note.textContent = '正在进行一次公开信息查找；完成后会更新候选活动。';
    else if (life?.started) note.textContent = '自动公开信息查找已开启，每 12 小时最多运行一次；“现在查找一次”会立即触发一次受限运行。';
    else note.textContent = '自动公开信息查找已开启，等待后台调度；每 12 小时最多运行一次。';
    lifeBox.append(note);
    const facts = [
      ['当前城市', settings.city],
      ['当日查找次数', `${life?.daily?.calls ?? 0} / ${settings.dailyDiscoveryCalls ?? 0}`],
      ['当日 token', `${Number(life?.daily?.tokens ?? 0).toLocaleString('zh-CN')} / ${Number(settings.dailyDiscoveryTokens ?? 0).toLocaleString('zh-CN')}`],
      ['上次运行', date(life?.lastRunAt)],
      ['上次结果', discoveryReason(life?.lastReason)],
    ];
    if (facts.length) { const grid = document.createElement('div'); grid.className = 'runtime-grid'; for (const [label, value] of facts) grid.append(field(label, value)); lifeBox.append(grid); }
    const candidates = Array.isArray(life?.candidates) ? life.candidates : [];
    const candidateHeading = document.createElement('h5'); candidateHeading.textContent = '公开活动线索（尚未参加）'; lifeBox.append(candidateHeading);
    if (candidates.length) { const list = document.createElement('div'); list.className = 'runtime-grid'; for (const candidate of candidates) list.append(activityCard(candidate)); lifeBox.append(list); }
    else { const empty = document.createElement('p'); empty.className = 'fine-print'; empty.textContent = '目前没有可核对的公开活动线索。'; lifeBox.append(empty); }
    const experiences = Array.isArray(life?.experiences) ? life.experiences : [];
    const experienceHeading = document.createElement('h5'); experienceHeading.textContent = '林晓薇的虚构参与经历'; lifeBox.append(experienceHeading);
    if (experiences.length) { const list = document.createElement('div'); list.className = 'runtime-grid'; for (const experience of experiences) list.append(activityCard(experience, { experienced: true })); lifeBox.append(list); }
    else { const empty = document.createElement('p'); empty.className = 'fine-print'; empty.textContent = '还没有记录任何虚构参与经历。'; lifeBox.append(empty); }
  }
  function render({ form: renderSettings = false } = {}) {
    if (renderSettings) renderForm();
    renderState(); renderSocial(); renderLife(); setControlsDisabled();
  }
  function readDraft() {
    return {
      revision: model.saved?.revision,
      enabled: controls.enabled.checked,
      expressionPreferences: controls.expressionPreferences.value,
      discoveryEnabled: controls.discoveryEnabled.checked,
      city: controls.city.value.trim(),
      interests: controls.interests.value,
      dailyDiscoveryCalls: Number(controls.dailyDiscoveryCalls.value),
      dailyDiscoveryTokens: Number(controls.dailyDiscoveryTokens.value),
    };
  }
  function validate(draft) {
    if (draft.expressionPreferences.length > 2400) return '表达偏好最多 2,400 个字符。';
    if (draft.city.length < 1 || draft.city.length > 80) return '城市须为 1–80 个字符。';
    if (draft.interests.length > 400) return '兴趣方向最多 400 个字符。';
    if (!Number.isSafeInteger(draft.dailyDiscoveryCalls) || draft.dailyDiscoveryCalls < 0 || draft.dailyDiscoveryCalls > 6) return '每日查找次数须为 0–6 的整数。';
    if (!Number.isSafeInteger(draft.dailyDiscoveryTokens) || draft.dailyDiscoveryTokens < 2000 || draft.dailyDiscoveryTokens > 100000) return '每日 token 预算须为 2,000–100,000 的整数。';
    return null;
  }
  function applySnapshot(result, { replaceForm = false } = {}) {
    const snapshot = result?.snapshot || result;
    if (!snapshot?.settings) return;
    if (replaceForm || !model.dirty) {
      model.snapshot = snapshot;
      model.saved = currentSettings(snapshot.settings);
      model.draft = { ...model.saved };
      model.dirty = false; model.conflict = false;
      render({ form: true });
    } else {
      model.snapshot = { ...snapshot, settings: model.snapshot?.settings || snapshot.settings };
      render();
    }
  }
  async function load() {
    if (model.saving) return;
    if (model.loading) return model.loading;
    const request = ++model.request;
    model.loading = (async () => {
      try {
        const result = await api('/api/companion-dynamics', { timeout: 15000 });
        if (request !== model.request) return;
        applySnapshot(result, { replaceForm: !model.dirty });
      } catch (error) {
        if (request === model.request) { status.textContent = `读取失败：${error.message || '请稍后重试。'}`; setControlsDisabled(); }
      } finally { if (request === model.request) model.loading = null; }
    })();
    return model.loading;
  }
  async function saveSettings() {
    if (model.saving || !model.dirty) return;
    const draft = readDraft(), issue = validate(draft);
    if (issue) { status.textContent = issue; return; }
    model.saving = true; setControlsDisabled();
    try {
      const result = await api('/api/companion-dynamics', { method: 'POST', body: draft, timeout: 15000 });
      applySnapshot(result, { replaceForm: true });
      status.textContent = '已保存。从下一次互动起按这份设置表达；不会为每一轮对话额外调用模型。';
      toast?.('林晓薇的动态设置已保存。');
    } catch (error) {
      if (error.status === 409) { model.conflict = true; status.textContent = '保存时发现已有更新。你的输入仍保留；刷新状态不会覆盖它。'; return; }
      status.textContent = `保存失败：${error.message || '请稍后重试。'}`;
    } finally { model.saving = false; setControlsDisabled(); }
  }
  async function discoverNow() {
    if (model.discovering || model.saving) return;
    model.discovering = true; status.textContent = '正在进行一次有限的公开信息查找…'; setControlsDisabled();
    try {
      const result = await api('/api/companion-dynamics/discover', { method: 'POST', body: {}, timeout: 95000 });
      applySnapshot(result, { replaceForm: !model.dirty });
      const summary = typeof result.result === 'string' ? result.result : result.result?.message;
      status.textContent = summary ? `已完成：${summary}` : '已完成一次有限的公开信息查找。';
    } catch (error) { status.textContent = `查找未完成：${error.message || '请稍后重试。'}`; }
    finally { model.discovering = false; setControlsDisabled(); }
  }

  form.addEventListener('submit', event => { event.preventDefault(); saveSettings(); });
  for (const control of Object.values(controls)) control.addEventListener(control.type === 'checkbox' ? 'change' : 'input', () => {
    if (!model.saved || model.saving) return;
    model.draft = readDraft(); model.dirty = !same(model.draft, model.saved); model.conflict = false;
    if (model.dirty) status.textContent = '有尚未保存的修改。';
    setControlsDisabled();
  });
  refresh.addEventListener('click', load);
  discover.addEventListener('click', discoverNow);
  render();
  return { load };
}
