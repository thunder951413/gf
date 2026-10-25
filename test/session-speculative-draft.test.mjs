import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

const NOW = new Date('2026-10-13T12:00:00Z');
const post = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

// The speculative draft is issued before the preparer, so scripted responses
// are consumed in that order: draft first, then guidance.
async function fixture(t, initial = [], extraOptions = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-speculative-'));
  const calls = [];
  const responses = [...initial];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ body, signal: init.signal });
    if (!responses.length) throw new Error(`missing fixture response for model call ${calls.length}`);
    const next = responses.shift();
    const value = typeof next === 'function' ? await next({ body, index: calls.length - 1 }) : next;
    return Response.json({ choices: [{ message: { content: typeof value === 'string' ? value : JSON.stringify(value) } }], usage: { prompt_tokens: 30, completion_tokens: 12 } });
  };
  const app = await createApp({
    dataDir, sessionDialogue: true, sessionGuidance: true, sessionReview: false, sessionSpeculativeDraft: true,
    dynamicCompanion: true, semanticUnderstanding: true, dialogueMemory: true,
    startDiscovery: false, initialFeeds: [], startWeixin: false, startChatQueue: false, startProactive: false, startRecall: false,
    startResearch: false, startLife: false, startRuntime: false, startDailyLife: false, startLifeThreads: false, startPursuits: false, startDossiers: false,
    replySleep: async () => {}, clock: () => new Date(NOW), random: () => 0.5,
    env: { LIFE_MODEL_BASE_URL: 'https://fixture.test/v1', LIFE_MODEL_NAME: 'fixture' }, fetchImpl, ...extraOptions,
  });
  app.preferences.setReplyPace('instant');
  const { port } = await app.listen(0);
  const request = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, post(body));
    let value = null; try { value = await response.json(); } catch {}
    return { status: response.status, body: value };
  };
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { app, calls, request };
}

const hasGuidance = body => body.messages.some(row => row.content.includes('【本轮具体提示】'));
const trace = f => f.app.dialogueTraces.list({ roleId: 'miyue' })[0];

test('a fast turn keeps the draft written alongside the preparer and makes two calls', async t => {
  const f = await fixture(t, [
    ({ body }) => { assert.equal(hasGuidance(body), false); return { reply: '那我也不动，就搂着你。' }; },
    { reviewEffort: 'fast', turn: { focus: null, claims: [] }, guidance: [] },
  ]);
  const response = await f.request('/api/chat', { role: 'miyue', text: '我也不想动' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(f.calls.length, 2);
  assert.equal(f.app.store.getMessages('miyue').at(-1).text, '那我也不动，就搂着你。');
  assert.equal(trace(f).speculativeDraft, 'used');
});

test('a reasoning turn discards the speculative draft and writes again with guidance', async t => {
  const f = await fixture(t, [
    { reply: '分盆分好了吧？' },
    { reviewEffort: 'reasoning', turn: { focus: { text: '问薄荷', sourceId: 'current', quote: '薄荷' }, claims: [] }, guidance: [{ instruction: '分盆是否完成未知，先问有没有做。', quote: '薄荷' }] },
    ({ body }) => { assert.equal(hasGuidance(body), true); return { reply: '薄荷后来分了没？' }; },
  ]);
  const response = await f.request('/api/chat', { role: 'miyue', text: '下午我要给薄荷分盆' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(f.calls.length, 3);
  assert.equal(f.app.store.getMessages('miyue').at(-1).text, '薄荷后来分了没？');
  assert.equal(trace(f).speculativeDraft, 'discarded');
});

test('a speculative draft that asks for a reminder is stopped before staging and the turn is redrafted', async t => {
  const f = await fixture(t, [
    { request: { name: 'reminder', action: 'create', text: '提醒喝水', dueAt: '2026-10-13T13:00:00Z', evidence: '一点提醒我喝水' } },
    { reviewEffort: 'fast', turn: { focus: null, claims: [] }, guidance: [] },
    ({ body }) => { assert.equal(hasGuidance(body), true); return { reply: '好，一点提醒你。' }; },
  ]);
  const response = await f.request('/api/chat', { role: 'miyue', text: '一点提醒我喝水' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.equal(f.calls.length, 3);
  assert.equal(trace(f).speculativeDraft, 'action');
  assert.equal(f.app.store.listReminders().length, 0);
});
