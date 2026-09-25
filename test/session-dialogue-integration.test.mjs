import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

const NOW = new Date('2026-09-25T02:00:00Z');
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function until(check, message = 'condition timed out') {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(message);
}

async function fixture(t, initial = [], extraOptions = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-dialogue-integration-'));
  const calls = [];
  const responses = [...initial];
  let app;
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    const call = { body, signal: init.signal, index: calls.length };
    calls.push(call);
    if (!responses.length) throw new Error(`missing fixture response for model call ${calls.length}`);
    const next = responses.shift();
    const value = typeof next === 'function' ? await next({ app, body, signal: init.signal, index: call.index }) : next;
    const content = typeof value === 'string' ? value : JSON.stringify(value);
    return Response.json({ choices: [{ message: { content } }], usage: { prompt_tokens: 30, completion_tokens: 12 } });
  };
  app = await createApp({
    dataDir,
    sessionDialogue: true,
    dynamicCompanion: true,
    semanticUnderstanding: true,
    dialogueMemory: true,
    startDiscovery: false,
    initialFeeds: [],
    startWeixin: false,
    startChatQueue: false,
    startProactive: false,
    startRecall: false,
    startResearch: false,
    startLife: false,
    startRuntime: false,
    startDailyLife: false,
    startLifeThreads: false,
    startPursuits: false,
    startDossiers: false,
    replySleep: async () => {},
    clock: () => new Date(NOW),
    random: () => 0.5,
    env: { LIFE_MODEL_BASE_URL: 'https://fixture.test/v1', LIFE_MODEL_NAME: 'fixture' },
    fetchImpl,
    ...extraOptions,
  });
  app.preferences.setReplyPace('instant');
  const { port } = await app.listen(0);
  const request = async (route, body, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, body === undefined ? { method } : { ...post(body), method });
    let value = null;
    try { value = await response.json(); } catch {}
    return { status: response.status, body: value };
  };
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { app, calls, request, enqueue: (...items) => responses.push(...items) };
}

const contents = call => call.body.messages.map(message => message.content).join('\n');

test('session mode bypasses semantic classification and carries corrections in native chat roles', async t => {
  const f = await fixture(t, [
    { reply: '对，是我的书，我刚才把归属说反了。' },
    { reply: '是我的，这次没有再说反。' },
  ]);
  const seeded = f.app.store.saveChatTurn({ role: 'miyue', text: '那本书是谁的？', reply: '那是放在你桌上的书。' });
  for (const [index, row] of seeded.entries()) {
    f.app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(`2026-09-2${3 + index}T01:00:00Z`, row.id);
  }

  const correction = '那是你的书，不是我的。';
  const first = await f.request('/api/chat', { role: 'miyue', text: correction });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(f.calls.length, 1, 'semanticUnderstanding does not add an intent-model call in session mode');
  const firstMessages = f.calls[0].body.messages;
  const oldUser = firstMessages.find(message => message.role === 'user' && message.content.includes('那本书是谁的'));
  const oldAssistant = firstMessages.find(message => message.role === 'assistant' && message.content.includes('放在你桌上'));
  assert.ok(oldUser); assert.ok(oldAssistant);
  assert.match(oldUser.content, /^【历史消息·/); assert.match(oldAssistant.content, /^【历史消息·/);
  assert.deepEqual(firstMessages.at(-1), { role: 'user', content: correction });
  assert.equal(firstMessages.filter(message => message.content.includes(correction)).length, 1);
  assert.doesNotMatch(contents(f.calls[0]), /【眼前交流的定位|【避免重复】|【本轮唯一交流目的】|【近期交流原文|故事时间/);

  const secondText = '所以这本书到底是谁的？';
  const second = await f.request('/api/chat', { role: 'miyue', text: secondText });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(f.calls.length, 2);
  const secondMessages = f.calls[1].body.messages;
  assert.ok(secondMessages.some(message => message.role === 'user' && message.content.includes(correction)));
  assert.ok(secondMessages.some(message => message.role === 'assistant' && message.content.includes('我刚才把归属说反了')));
  assert.deepEqual(secondMessages.at(-1), { role: 'user', content: secondText });
  assert.deepEqual(f.app.store.getMessages('miyue').map(row => row.speaker), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);

  const health = await f.request('/api/health');
  assert.equal(health.body.sessionDialogue, true);
  assert.equal(health.body.semanticUnderstanding, false, 'the legacy semantic planner is absent');
});

test('state tool evidence returns to the same model session and malformed optional metadata cannot kill reply prose', async t => {
  const f = await fixture(t, [
    { request: { name: 'state', query: '现在的关系边界是什么？' } },
    { reply: '现在还是按我们已经说清的边界来相处。' },
    { reply: '这句我正常接住了。', companionship: 'broken', dynamics: ['also-broken'], social: 7 },
  ]);
  const first = await f.request('/api/chat', { role: 'miyue', text: '我们现在的关系边界是什么？' });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].body.messages.at(-1).content, '我们现在的关系边界是什么？');
  const toolTranscript = f.calls[1].body.messages;
  const toolRequest = toolTranscript.find(message => message.role === 'assistant' && message.content.includes('"name":"state"'));
  const toolEvidence = toolTranscript.find(message => message.role === 'user' && message.content.includes('【外部工具回执｜state】'));
  assert.ok(toolRequest); assert.ok(toolEvidence);
  assert.match(toolEvidence.content, /"section":"relationship"/);
  assert.equal(first.body.messages.at(-1).text, '现在还是按我们已经说清的边界来相处。');

  const second = await f.request('/api/chat', { role: 'miyue', text: '好，我知道了。' });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.messages.at(-1).text, '这句我正常接住了。');
  assert.equal(f.app.companionDynamics.get().revision, 0);
});

test('a new queued message cancels obsolete session generation and only the combined latest turn commits', async t => {
  let abortSeen = false;
  const f = await fixture(t, [
    ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => {
      abortSeen = true;
      reject(new DOMException('aborted', 'AbortError'));
    }, { once: true })),
    { reply: '好，按你最新说的，今天不去了。' },
  ], { startChatQueue: true, chatDebounceMs: 5 });
  assert.equal((await f.request('/api/chat/send', { role: 'miyue', text: '我今天准备去。', clientId: 'session-abort-001' })).status, 202);
  await until(() => f.calls.length === 1, 'first queued model call did not start');
  assert.equal((await f.request('/api/chat/send', { role: 'miyue', text: '等等，我改主意不去了。', clientId: 'session-abort-002' })).status, 202);
  await until(() => f.app.store.getMessages('miyue').length === 3, 'replacement session turn did not commit');
  assert.equal(abortSeen, true);
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.app.store.getMessages('miyue').map(row => row.text), [
    '我今天准备去。', '等等，我改主意不去了。', '好，按你最新说的，今天不去了。',
  ]);
  assert.equal(f.app.usage.snapshot().recent.some(row => row.status === 'cancelled'), true);
});

test('a memory revision changed during generation rejects the stale session reply', async t => {
  let changed = false;
  const f = await fixture(t, [({ app }) => {
    if (!changed) {
      changed = true;
      app.recallRepo.replace('miyue', '生成期间由用户修改的长期记忆。');
    }
    return { reply: '这句基于旧记忆，不应保存。' };
  }]);
  const result = await f.request('/api/chat', { role: 'miyue', text: '继续说刚才的事。' });
  assert.equal(result.status, 409, JSON.stringify(result.body));
  assert.equal(result.body.code, 'STALE_SESSION_CONTEXT');
  assert.equal(f.app.store.getMessages('miyue').length, 0);
});

test('a same-activity runtime revision invalidates the draft and retries from current state', async t => {
  let changed = false;
  const f = await fixture(t, [
    ({ app }) => {
      if (!changed) {
        changed = true;
        const runtime = app.companionRuntime.configuration();
        app.companionRuntime.updateSettings({ revision: runtime.revision, settings: { automaticScenes: !runtime.settings.automaticScenes } });
      }
      return { reply: '这句基于变化前的生活状态，不应保存。' };
    },
    { reply: '我按刚更新的生活状态接着说。' },
  ]);
  const result = await f.request('/api/chat', { role: 'miyue', text: '你现在在做什么？' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(f.calls.length, 2);
  assert.deepEqual(f.app.store.getMessages('miyue').map(row => row.text), ['你现在在做什么？', '我按刚更新的生活状态接着说。']);
});

test('tuning and interaction preference changes reject stale session replies', async t => {
  const tuning = await fixture(t, [({ app }) => {
    const current = app.companionTuning.get();
    app.companionTuning.set({ ...current.values, warmth: current.values.warmth === 100 ? 99 : current.values.warmth + 1 }, current.revision);
    return { reply: '这句沿用了旧的相处参数。' };
  }]);
  const staleTuning = await tuning.request('/api/chat', { role: 'miyue', text: '陪我说会儿话。' });
  assert.equal(staleTuning.status, 409, JSON.stringify(staleTuning.body));
  assert.equal(staleTuning.body.code, 'STALE_COMPANION_TUNING');
  assert.equal(tuning.app.store.getMessages('miyue').length, 0);

  const policy = await fixture(t, [({ app }) => {
    app.interactionPolicy.set('miyue', { noQuestions: true });
    return { reply: '这句沿用了旧的相处偏好。' };
  }]);
  const stalePolicy = await policy.request('/api/chat', { role: 'miyue', text: '接着聊。' });
  assert.equal(stalePolicy.status, 409, JSON.stringify(stalePolicy.body));
  assert.equal(stalePolicy.body.code, 'STALE_DIALOGUE_POLICY');
  assert.equal(policy.app.store.getMessages('miyue').length, 0);
});

test('create, update, and cancel reminder requests commit atomically with their replies', async t => {
  const userCreate = '明天上午九点提醒我吃药。';
  const f = await fixture(t, [
    { request: { name: 'reminder', action: 'create', text: '吃药', dueAt: '2026-09-26T09:00:00+08:00', evidence: userCreate } },
    { reply: '好，明天上午九点提醒你吃药。' },
  ]);
  const created = await f.request('/api/chat', { role: 'miyue', text: userCreate });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  let [reminder] = f.app.store.listReminders();
  assert.ok(reminder); assert.equal(reminder.text, '吃药'); assert.equal(reminder.dueAt, '2026-09-26T01:00:00.000Z');
  assert.match(contents(f.calls[1]), /validated_for_reply_commit/);

  const userUpdate = '把刚才吃药的提醒改到后天上午十点。';
  f.enqueue(
    { request: { name: 'reminder', action: 'update', id: reminder.id, text: '吃药', dueAt: '2026-09-27T10:00:00+08:00', evidence: userUpdate } },
    { reply: '好，已改到后天上午十点。' },
  );
  const updated = await f.request('/api/chat', { role: 'miyue', text: userUpdate });
  assert.equal(updated.status, 200, JSON.stringify(updated.body));
  [reminder] = f.app.store.listReminders();
  assert.equal(reminder.dueAt, '2026-09-27T02:00:00.000Z');

  const userCancel = '取消这个吃药提醒。';
  f.enqueue(
    { request: { name: 'reminder', action: 'cancel', id: reminder.id, evidence: userCancel } },
    { reply: '好，这个提醒已取消。' },
  );
  const cancelled = await f.request('/api/chat', { role: 'miyue', text: userCancel });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.deepEqual(f.app.store.listReminders(), []);
  assert.equal(f.calls.length, 6);
});

test('invalid reminder evidence stays uncommitted and a stale staged update rolls back its confirming reply', async t => {
  const invalidUser = '明天提醒我去散步。';
  const f = await fixture(t, [
    { request: { name: 'reminder', action: 'create', text: '散步', dueAt: '2026-09-26T18:00:00+08:00', evidence: '这不是当前原话' } },
    { reply: '这次没能建立提醒，因为操作依据没有通过校验。' },
  ]);
  const invalid = await f.request('/api/chat', { role: 'miyue', text: invalidUser });
  assert.equal(invalid.status, 200, JSON.stringify(invalid.body));
  assert.equal(f.app.store.listReminders().length, 0);
  assert.match(contents(f.calls[1]), /需要当前用户原话作为操作依据/);
  assert.doesNotMatch(invalid.body.messages.at(-1).text, /已设置|已建立/);

  const reminder = f.app.store.addReminder('miyue', '给花浇水', '2026-09-26T01:00:00.000Z');
  const staleUser = '把给花浇水改到后天上午十点。';
  f.enqueue(
    { request: { name: 'reminder', action: 'update', id: reminder.id, text: '给花浇水', dueAt: '2026-09-27T10:00:00+08:00', evidence: staleUser } },
    ({ app }) => {
      app.store.db.prepare('UPDATE reminders SET text=? WHERE id=?').run('外部已修改的提醒', reminder.id);
      return { reply: '好，已改到后天上午十点。' };
    },
  );
  const beforeMessages = f.app.store.getMessages('miyue').length;
  const stale = await f.request('/api/chat', { role: 'miyue', text: staleUser });
  assert.equal(stale.status, 409, JSON.stringify(stale.body));
  assert.equal(stale.body.code, 'STALE_SESSION_ACTION');
  assert.equal(f.app.store.getMessages('miyue').length, beforeMessages, 'the user line and false confirmation roll back together');
  assert.equal(f.app.store.listReminders()[0].text, '外部已修改的提醒');
});

test('session proactive skip, later continuation, and desktop invitation share native continuity without fake user speech', async t => {
  const f = await fixture(t, [
    { skip: true, message: '', reason: '这会儿没有自然想说的', contentId: null },
    { skip: false, message: '忽然有点想你，就来打个招呼。', reason: '想打个招呼', contentId: null },
    { reply: '嗯，我刚才那句就是在想你。' },
    { reply: '我在呢，想过来陪你一会儿。' },
  ]);
  f.app.proactiveRepo.saveSettings({ enabled: true, activeStart: '00:00', activeEnd: '23:59', dailyLimit: 10, desktopNotifications: false });

  const skipped = await f.app.proactive.runNow({ roleId: 'miyue' });
  assert.equal(skipped.delivered, false); assert.equal(f.app.store.getMessages('miyue').length, 0);
  assert.match(contents(f.calls[0]), /"type":"scheduled_opportunity"/);
  assert.match(contents(f.calls[0]), /"skip":boolean/);

  const delivered = await f.app.proactive.runNow({ roleId: 'miyue' });
  assert.equal(delivered.delivered, true, JSON.stringify(delivered));
  assert.equal(delivered.message.text, '忽然有点想你，就来打个招呼。');
  const reply = await f.request('/api/chat', { role: 'miyue', text: '我也想你了。' });
  assert.equal(reply.status, 200, JSON.stringify(reply.body));
  const continuation = f.calls[2].body.messages;
  assert.ok(continuation.some(message => message.role === 'assistant' && message.content.includes('忽然有点想你')));
  assert.deepEqual(continuation.at(-1), { role: 'user', content: '我也想你了。' });

  const usersBefore = f.app.store.getMessages('miyue').filter(row => row.speaker === 'user').length;
  const attention = await f.request('/api/desktop/attention', { requestId: 'session-attention-001', level: 'affection' });
  assert.equal(attention.status, 200, JSON.stringify(attention.body));
  assert.deepEqual(attention.body.messages.map(row => row.speaker), ['assistant']);
  const invitation = f.calls[3].body.messages;
  const triggerIndex = invitation.findIndex(message => message.role === 'system' && message.content.includes('desktop_invitation'));
  assert.ok(triggerIndex >= 0);
  assert.match(invitation[triggerIndex].content, /"gesture":"affection"/);
  const transportUsers = invitation.slice(triggerIndex + 1).filter(message => message.role === 'user');
  assert.equal(transportUsers.every(message => message.content.startsWith('【本轮当前时间】')), true);
  assert.match(invitation[triggerIndex].content, /本轮没有新的用户消息/);
  assert.equal(f.app.store.getMessages('miyue').filter(row => row.speaker === 'user').length, usersBefore);
});

test('native history carries source receipts for visible messages without importing out-of-window material', async t => {
  const f = await fixture(t, [{ reply: '我读到的是订阅摘要，没读到全文。' }]);
  const feed=f.app.store.addFeed('https://example.org/feed','来源测试');
  f.app.store.addContent(feed,[{title:'白矮星冲击波',url:'https://example.org/star',summary:'研究者尚未解释冲击波的能量来源。',publishedAt:NOW.toISOString()},
    {title:'不应注入的旧来源',url:'https://example.org/old',summary:'OUTSIDE_WINDOW_SOURCE',publishedAt:NOW.toISOString()}],'来源测试');
  const sources=f.app.store.listContent();
  for(const [title,createdAt] of [['白矮星冲击波','2026-09-25T01:00:00Z'],['不应注入的旧来源','2026-08-01T01:00:00Z']]){
    const source=sources.find(item=>item.title===title);
    const rows=f.app.store.saveChatTurn({role:'miyue',text:'说说这个',reply:'这条消息还有未解释之处。',contentId:source.id});
    for(const row of rows)f.app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(createdAt,row.id);
  }
  const result=await f.request('/api/chat',{role:'miyue',text:'你读到的是摘要还是原文？'});
  assert.equal(result.status,200,JSON.stringify(result.body));
  assert.match(contents(f.calls[0]),/sourceReceipts/);
  assert.match(contents(f.calls[0]),/https:\/\/example.org\/star/);
  assert.match(contents(f.calls[0]),/订阅缓存摘录/);
  assert.doesNotMatch(contents(f.calls[0]),/OUTSIDE_WINDOW_SOURCE|https:\/\/example.org\/old/);
});
