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
    history: { count: 32, chars: 18_000 },
    memories: { count: 12, chars: 5_000 },
    maxOutputTokens: 4_096,
    replyChars: 6_000,
  });
  assert.equal(dialogueLimits('miyue', 100).maxOutputTokens, 6_000);
  assert.equal(dialogueLimits('miyue', { verbosity: 79 }).maxOutputTokens, 4_096);
});

test('explicit current user text is retained verbatim outside the history budget', () => {
  const history = Array.from({ length: 40 }, (_, index) => ({
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
  assert.ok(transcript.length <= 32);
  assert.ok(transcript.reduce((sum, message) => sum + message.content.length, 0) <= 18_000);
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
  assert.ok(historyIndex > 0 && historyIndex < backgroundIndex);
  assert.equal(messages.at(-1).content.includes('【本轮背景开始】'), true);
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
