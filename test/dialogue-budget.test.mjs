import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dialogueLimits } from '../lib/dialogue-budget.mjs';
import { buildChatMessages, ModelClient } from '../lib/model.mjs';
import { withDialogueTime } from '../lib/dialogue-time.mjs';

const roles = JSON.parse(fs.readFileSync(new URL('../app-data/roles.json', import.meta.url), 'utf8'));
const role = roles.find(item => item.id === 'miyue');

test('Miyue dialogue ceilings support longer context while staying bounded', () => {
  assert.deepEqual(dialogueLimits('miyue'), {
    history: { count: 800, chars: 90_000 },
    memories: { count: 12, chars: 5_000 },
    maxOutputTokens: 4_096,
    replyChars: 6_000,
  });
  assert.equal(dialogueLimits('miyue', 100).maxOutputTokens, 6_000);
  assert.equal(dialogueLimits('miyue', { verbosity: 79 }).maxOutputTokens, 4_096);
});

test('explicit current user text is retained verbatim outside the history budget', () => {
  const history = Array.from({ length: 850 }, (_, index) => ({
    speaker: index % 2 ? 'assistant' : 'user',
    text: `history-${index}-${'x'.repeat(700)}`,
    createdAt: new Date(Date.parse('2026-09-01T00:00:00Z') + index * 60_000).toISOString(),
  }));
  const current = `请详细回答：${'长问题'.repeat(2500)}`;
  const messages = buildChatMessages({
    role, memories: [], conversation: history, currentUserText: current,
    characterContext: '当前状态', story: null,
  });
  const transcript = messages.filter(message => message.content.includes('history-'));
  assert.ok(transcript.length <= 800);
  assert.ok(transcript.reduce((sum, message) => sum + message.content.length, 0) <= 90_000);
  assert.equal(messages.at(-1).content, current);
});

test('null current turn keeps the latest historical user row in proactive context', () => {
  const latest = '这是已发生的最后一条用户消息';
  const messages = buildChatMessages({
    role, memories: [], conversation: [
      { speaker: 'user', text: '较早消息' },
      { speaker: 'assistant', text: '较早回复' },
      { speaker: 'user', text: latest },
    ],
    currentUserText: null, characterContext: '变化中的本轮状态', story: null,
  });
  const historyIndex = messages.findIndex(message => message.content === latest);
  const backgroundIndex = messages.findIndex(message => message.content.includes('【本轮背景开始】'));
  assert.ok(historyIndex > backgroundIndex && backgroundIndex > 0);
  assert.equal(messages.at(-1).content, latest);
});

test('exact time stays in the volatile tail and never changes the reusable prefix', () => {
  const common = {
    role, memories: [{ text: '明确记忆' }],
    conversation: [{ speaker: 'user', text: '历史问题' }, { speaker: 'assistant', text: '历史回答' }],
    currentUserText: '当前问题', characterContext: '当前背景', story: null,
  };
  const early = withDialogueTime(buildChatMessages(common), { purpose: 'chat', now: new Date('2026-09-09T01:00:00Z') });
  const late = withDialogueTime(buildChatMessages(common), { purpose: 'chat', now: new Date('2026-09-09T09:00:00Z') });
  const boundary = early.findIndex(message => message.content.includes('【本轮背景开始】'));
  assert.deepEqual(early.slice(0, boundary), late.slice(0, boundary));
  assert.doesNotMatch(early.slice(0, boundary).map(message => message.content).join('\n'), /【本轮当前时间】/);
  assert.notEqual(early.at(-2).content, late.at(-2).content);
  assert.equal(late.at(-1).content, '当前问题');
});

test('transport permits a full visible reply plus its bounded JSON envelope', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dialogue-budget-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const visibleReply = '长'.repeat(dialogueLimits('miyue').replyChars);
  const envelope = JSON.stringify({
    reply: visibleReply,
    signals: { tone: 'neutral', closeness: 'unspecified', evidence: '' },
    experience: null,
  });
  const client = new ModelClient({
    dataDir,
    env: { LIFE_MODEL_BASE_URL: 'https://fixture.test/v1', LIFE_MODEL_NAME: 'fixture' },
    fetchImpl: async () => Response.json({ choices: [{ message: { content: envelope } }] }),
  });
  assert.equal(await client.complete([{ role: 'user', content: '详细回答' }], { roleId: 'miyue', maxTokens: 6_000 }), envelope);
});

test('cross-day history carries Beijing send time while the current turn remains verbatim', () => {
  const messages = buildChatMessages({
    role, memories: [], story: null, characterContext: '新一天的当前状态',
    conversation: [
      { speaker: 'user', text: '今天我们聊聊晚饭', createdAt: '2026-09-08T11:15:00.000Z' },
      { speaker: 'assistant', text: '好，今天聊晚饭。', createdAt: '2026-09-08T11:16:00.000Z' },
    ],
    currentUserText: '现在是第二天了，昨天聊了什么？',
  });
  assert.equal(messages.find(message => message.content.includes('今天我们聊')).content, '【历史消息·2026-09-08 19:15】\n今天我们聊聊晚饭');
  assert.equal(messages.find(message => message.content.includes('好，今天聊')).content, '【历史消息·2026-09-08 19:16】\n好，今天聊晚饭。');
  assert.equal(messages.at(-1).content, '现在是第二天了，昨天聊了什么？');
  assert.doesNotMatch(messages.at(-1).content, /历史消息/);
});

test('ordinary turn intents share the same working history and leave raw rows intact', () => {
  const conversation = Array.from({ length: 9 }, (_, index) => ([
    { speaker: 'user', text: `用户回合-${index + 1}` },
    { speaker: 'assistant', text: `助手回复-${index + 1}` },
  ])).flat();
  conversation.push({ speaker: 'assistant', text: '最近末尾助手补充' });
  const before = structuredClone(conversation);
  const common = { role, memories: [], story: null, characterContext: '当前状态', currentUserText: '当前输入', conversation };
  const contents = input => buildChatMessages(input).map(message => message.content).join('\n');

  const legacy = contents(common);
  assert.match(legacy, /用户回合-1/);

  const daily = contents({ ...common, turnPlan: { mode: 'respond' } });
  assert.match(daily, /用户回合-1/);
  assert.match(daily, /用户回合-4/);
  assert.match(daily, /用户回合-9/);
  assert.match(daily, /最近末尾助手补充/);

  const continued = contents({ ...common, turnPlan: { mode: 'continue' } });
  assert.match(continued, /用户回合-1/);
  assert.match(continued, /用户回合-8/);
  assert.match(continued, /用户回合-9/);
  assert.match(continued, /最近末尾助手补充/);

  const recalled = contents({ ...common, turnPlan: { mode: 'recall' }, recallContext: '【已检索原话】明天对应星期日。' });
  assert.match(recalled, /用户回合-1/);
  assert.match(recalled, /已检索原话/);
  assert.deepEqual(conversation, before);
});

test('user-fact recall separates original evidence from old assistant guesses and resolves relative dates',()=>{
 const conversation=[{speaker:'user',text:'明天中午去汕头',createdAt:'2026-09-12T05:00:00Z'},{speaker:'assistant',text:'你订了九点的车。'},{speaker:'user',text:'聊聊别的'},{speaker:'assistant',text:'好。'}];
 const before=structuredClone(conversation);
 const messages=buildChatMessages({role:{id:'miyue',name:'林晓薇'},conversation,memories:[],currentUserText:'我周六坐哪班车来着',turnPlan:{mode:'recall',recallSubject:'user'}});
 const text=JSON.stringify(messages);
 assert.match(text,/明天中午去汕头/);assert.match(text,/2026-09-13（星期日）/);assert.doesNotMatch(text,/你订了九点的车/);
 assert.deepEqual(conversation,before);
});
