import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { localDayStart } from '../lib/proactive-store.mjs';

const at = new Date('2026-09-06T12:00:00');
// This suite exercises repository behavior across the retired multi-role
// topology, so keep its roles explicit instead of depending on the current
// single-companion app-data catalog.
const testRoles = [
  { id: 'zhixia', name: '知夏', systemPrompt: '你是知夏。' },
  { id: 'wenxi', name: '闻溪', systemPrompt: '你是闻溪。' },
  { id: 'miyue', name: '林晓薇', systemPrompt: '你是林晓薇。' },
];
const feed = { id: 'fixture', url: 'https://example.org/rss', title: '测试知识源', category: '知识' };
const article = { title: '测试文章：城市里的时间', url: 'https://example.org/articles/time', summary: '这是一段明确用于自动联系验收的来源摘要，讲述城市生活如何影响一个人对时间的感受。它具体比较了通勤等待与周末散步的体验，并说明这些观察只是作者的个人感受。', publishedAt: at.toISOString() };
const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function setup(t, options = {}) {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'youjian-proactive-'));
  const app = await createApp({ replySleep: async () => {},  dataDir, roles:testRoles, env: {}, startProactive: false, clock: () => at, random: () => 0, lifeRandom: () => .99, initialFeeds: [feed],
    integrations: { fetchFeed: async () => ({ title: feed.title, items: [article] }) }, desktopNotify: async () => ({ requested: true }), ...options });
  app.proactiveRepo.saveSettings({ activeStart: '00:00', activeEnd: '23:59' });
  const address = await app.listen(0), base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); if (!options.keepData) fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { app, base, dataDir, request: async (route, body) => { const response = await fetch(base + route, body === undefined ? undefined : json(body)); return { status: response.status, body: await response.json() }; } };
}
function modelTransport(calls, hold) {
  return async (_url, request) => {
    const payload = JSON.parse(request.body); calls.push(payload);
    const prompt = payload.messages.map(m => m.content).join('\n');
    if (hold) await hold(payload);
    const id = prompt.match(/ID:([^\n]+)/)?.[1] || null;
    const proactive = /本轮触发方式：主动联系|决定是否主动发起一次/.test(prompt);
    const text = proactive ? JSON.stringify({ skip: false, contentId: id, reason: '这是我们可以讨论的一个具体知识问题', message: '【验收桩】我读到一段关于城市时间感的摘要，想听听你的看法。' }) : '【验收桩】我们可以继续聊这篇文章。';
    return new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
  };
}
const due = app => app.proactiveRepo.updateRuntime({ nextFetchAt: at.toISOString(), nextContactAt: at.toISOString() });
function insert(app, { role = 'zhixia', kind = 'continuation', topic = Math.random().toString(), contentId = null } = {}) {
  return app.proactiveRepo.commitDelivery({ role, kind, contentId, text: '测试主动消息', reason: '测试理由', topicKey: topic, createdAt: at.toISOString(), nextContactAt: new Date(+at + 90 * 60000).toISOString(), expectedLastMessageId: app.proactiveRepo.getLastMessageId(role) });
}

test('real timer collects and delivers without any chat or run request, inbox then ordinary reply retains source and privacy', async t => {
  const calls = []; const { app, request } = await setup(t, { fetchImpl: modelTransport(calls), proactiveIntervalMs: 20 });
  app.proactive.roles = [testRoles.find(role=>role.id==='wenxi')];
  app.model.save({ baseUrl: 'http://model.test/v1', model: 'explicit-test-stub' });
  app.store.addMemory('shared', '共有的时间兴趣'); app.store.addMemory('wenxi', '闻溪自己的约定'); app.store.addMemory('zhixia', '阮绵不能泄露的私事');
  due(app); app.proactive.start();
  await new Promise((resolve, reject) => {
    const limit = setTimeout(() => { clearInterval(check); reject(new Error('automatic delivery timed out')); }, 2000);
    const check = setInterval(() => { if (app.proactiveRepo.recent().length) { clearInterval(check); clearTimeout(limit); resolve(); } }, 10);
  });
  assert.equal(app.store.listContent().length, 1); assert.equal(calls.length, 1);
  const inbox = (await request('/api/inbox')).body;
  assert.equal(inbox.unreadByRole.wenxi, 1); assert.equal(inbox.items[0].sourceUrl, article.url);
  assert.match(JSON.stringify(calls[0]), /共有的时间兴趣|闻溪自己的约定/); assert.doesNotMatch(JSON.stringify(calls[0]), /阮绵不能泄露的私事/);
  assert.equal((await request('/api/conversations/wenxi')).body.messages[0].kind, 'proactive');
  assert.equal((await request('/api/inbox')).body.unreadByRole.wenxi, 1, 'GET does not mark read');
  assert.equal((await request('/api/chat', { role: 'wenxi', text: '这个时间感还挺有意思' })).status, 200);
  assert.match(JSON.stringify(calls[1]), /城市里的时间/); assert.equal(app.proactiveRepo.unansweredCount('wenxi'), 1, 'the ordinary answer starts the next unanswered sequence');
});

test('missing model still collects, persists the plan across restart, and stores no fake opener', async t => {
  const first = await setup(t, { keepData: true }); due(first.app); await first.app.proactive.tick();
  assert.equal(first.app.store.listContent().length, 1); assert.equal(first.app.proactiveRepo.recent().length, 0);
  const runtime = first.app.proactiveRepo.getRuntime(); assert.equal(runtime.lastReason, '等待配置模型接口');
  await first.app.close();
  const second = await setup(t, { dataDir: first.dataDir }); await second.app.proactive.tick();
  assert.equal(second.app.proactiveRepo.getRuntime().nextContactAt, runtime.nextContactAt);
  assert.equal(second.app.proactiveRepo.getRuntime().nextFetchAt, runtime.nextFetchAt);
  assert.equal(second.app.store.getMessages('zhixia').length, 0);
});

test('read cursors are role-scoped and monotonic and never clear a later unseen message', async t => {
  const { app, request } = await setup(t); const a = insert(app), b = insert(app, { role: 'wenxi' });
  app.proactiveRepo.feedback(a.id, 'later'); const c = insert(app);
  assert.equal((await request('/api/conversations/zhixia/read', { messageId: b.id })).status, 404);
  await request('/api/conversations/zhixia/read', { messageId: a.id });
  assert.deepEqual((await request('/api/inbox')).body.unreadByRole, { zhixia: 1, wenxi: 1, miyue: 0 });
  await request('/api/conversations/zhixia/read', { messageId: c.id }); await request('/api/conversations/zhixia/read', { messageId: a.id });
  assert.equal((await request('/api/inbox')).body.unreadByRole.zhixia, 0);
});

test('reminders share durable daily budget and gap, deletion does not restore budget', async t => {
  const calls = []; const { app } = await setup(t, { fetchImpl: modelTransport(calls) });
  app.model.save({ baseUrl: 'http://model.test/v1', model: 'stub' }); app.proactiveRepo.saveSettings({ dailyLimit: 1 });
  const reminder = app.store.addReminder('wenxi', '约好的话题', at.toISOString());
  assert.equal(app.store.deliverDueReminders(at).length, 1); app.store.deleteReminder(reminder.id);
  due(app); const result = await app.proactive.tick();
  assert.match(result.contact.reason, /上限/); assert.equal(calls.length, 0); assert.equal(app.proactiveRepo.countContactsSince(localDayStart(at)), 1);
});

test('SQLite commit enforces unanswered limit, canonical article dedup and feedback source preference', async t => {
  const { app, request } = await setup(t); app.proactiveRepo.saveSettings({dailyLimit:8}); await app.refreshContent(); const content = app.store.listContent()[0];
  const a = insert(app, { kind: 'content', contentId: content.id }); assert.ok(a);
  await request('/api/proactive/feedback', { messageId: a.id, value: 'less' });
  assert.equal(app.proactiveRepo.getCandidates()[0].dislikedSource, true); assert.equal(app.proactiveRepo.getCandidates()[0].used, true);
  const otherFeed = app.store.addFeed('https://example.net/rss');
  app.store.addContent(otherFeed, [{ ...article, title: '另一个标题', url: article.url + '?utm_source=test' }], '另一来源');
  const duplicate = app.store.listContent().find(c => c.feedId === otherFeed.id);
  assert.equal(insert(app, { role: 'wenxi', kind: 'content', contentId: duplicate.id }), null);
  assert.ok(insert(app)); assert.ok(insert(app, { role: 'wenxi' })); assert.ok(insert(app, { role: 'wenxi' }));
  assert.ok(insert(app, { role: 'miyue', kind: 'story' }), 'other roles are not blocked by unread news');
  assert.equal(insert(app, { role: 'wenxi' }), null, 'two unread news messages pause only Wenxi');
  assert.equal((await request('/api/proactive/feedback', { messageId: a.id, value: 'bad-value' })).status, 400);
});

test('SQLite delivery blocks a second unanswered message during the first thirty minutes', async t => {
  const { app } = await setup(t);
  const firstAt = new Date(at.valueOf() - 15 * 60_000).toISOString();
  const first = app.proactiveRepo.commitDelivery({ role: 'miyue', kind: 'story', text: '刚想到你。', reason: '联系', topicKey: 'cooldown:first', createdAt: firstAt, nextContactAt: at.toISOString(), expectedLastMessageId: null });
  assert.ok(first);
  assert.equal(app.proactiveRepo.getLastUnansweredAssistantAt('miyue'), firstAt);
  const second = app.proactiveRepo.commitDelivery({ role: 'miyue', kind: 'story', text: '又想到你。', reason: '联系', topicKey: 'cooldown:second', createdAt: at.toISOString(), nextContactAt: at.toISOString(), expectedLastMessageId: first.id, unansweredCooldownMinutes: 30 });
  assert.equal(second, null);
  assert.equal(app.store.getMessages('miyue').length, 1);
});

test('single companion mode hides retired roles and does not deliver their pending reminders', async t => {
  const { app, request } = await setup(t, {activeRoleIds:['miyue']});
  const oldMessage=insert(app,{role:'wenxi'});
  assert.ok(oldMessage);
  app.store.addReminder('zhixia','旧角色提醒',at.toISOString());
  assert.deepEqual((await request('/api/bootstrap')).body.roles.map(role=>role.id),['miyue']);
  assert.deepEqual((await request('/api/inbox')).body.items,[]);
  assert.deepEqual((await request('/api/reminders')).body.reminders,[]);
  assert.deepEqual(app.store.deliverDueReminders(at,new Set(['miyue'])),[]);
  assert.equal((await request('/api/chat',{role:'wenxi',text:'你好'})).status,400);
});

test('quiet change during real model await discards generated message before SQLite commit', async t => {
  const calls = []; let release, began;
  const started = new Promise(resolve => { began = resolve; }); const held = new Promise(resolve => { release = resolve; });
  const { app, request } = await setup(t, { fetchImpl: modelTransport(calls, async () => { began(); await held; }) });
  app.model.save({ baseUrl: 'http://model.test/v1', model: 'stub' }); due(app);
  const pending = app.proactive.tick(); await started;
  await request('/api/settings', { quiet: true }); release(); await pending;
  assert.equal(app.proactiveRepo.recent().length, 0); assert.equal(app.proactiveRepo.countAttemptsSince(localDayStart(at)), 1);
});

test('settings reject invalid ranges, enabling model schedules contact, activity blocks automatic contact', async t => {
  const calls = []; const { app, request } = await setup(t, { fetchImpl: modelTransport(calls) });
  assert.equal((await request('/api/proactive/settings', { minGapMinutes: 200, maxGapMinutes: 100 })).status, 400);
  assert.equal((await request('/api/proactive/settings', { activeStart: '24:00' })).status, 400);
  assert.equal((await request('/api/proactive/settings', { desktopNotifications: false, topics: 'AI, 心理学' })).status, 200);
  await request('/api/provider', { baseUrl: 'http://model.test/v1', model: 'stub' });
  assert.equal(app.proactiveRepo.getRuntime().nextContactAt, new Date(+at + 60000).toISOString());
  await request('/api/activity', { typing: true }); due(app); const result = await app.proactive.tick();
  assert.match(result.contact.reason, /正在对话/); assert.equal(calls.length, 0);
  assert.equal((await request('/api/proactive/run', {})).body.delivered, true, 'user-requested run bypasses typing');
});

test('durable lease tokens are exclusive across SQLite connections and stale owner cannot release new lease', async t => {
  const first = await setup(t, { keepData: true }); const second = await setup(t, { dataDir: first.dataDir, keepData: true });
  t.after(() => fs.rmSync(first.dataDir, { recursive: true, force: true }));
  const until = new Date(+at + 10000).toISOString(); const token = first.app.proactiveRepo.acquireLease('contact', at.toISOString(), until);
  assert.ok(token); assert.equal(second.app.proactiveRepo.acquireLease('contact', at.toISOString(), until), null);
  const later = new Date(+at + 20000).toISOString(), newer = second.app.proactiveRepo.acquireLease('contact', later, new Date(+at + 30000).toISOString());
  first.app.proactiveRepo.releaseLease('contact', token); assert.equal(first.app.proactiveRepo.acquireLease('contact', later, until), null);
  second.app.proactiveRepo.releaseLease('contact', newer);
});
