import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { buildChatMessages } from '../lib/model.mjs';
import { buildProactiveMessages } from '../lib/proactive.mjs';
import { prepareDialogueHistory, historyTokenCost } from '../lib/dialogue-history.mjs';

const now = () => new Date('2026-09-20T12:00:00.000Z');
const role = { id: 'miyue', name: '林晓薇' };
const text = messages => messages.map(row => row.content).join('\n');
const historyMessages = projection => [...projection.archive, ...(projection.notice ? [projection.notice] : []), ...projection.recent];
const exchange = (id, at, body = '原话') => [
  { id: `${id}-u`, speaker: 'user', text: `${id}用户${body}`, createdAt: at },
  { id: `${id}-a`, speaker: 'assistant', text: `${id}回答${body}`, createdAt: at },
];

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-history-window-')), calls = [];
  const app = await createApp({
    dataDir, clock: now, initialFeeds: [], startWeixin: false, startChatQueue: false,
    startProactive: false, startRecall: false, startResearch: false, startLife: false,
    startRuntime: false, startLifeThreads: false, startPursuits: false,
    semanticUnderstanding: true, dialogueMemory: true, discussionTopics: false,
    styleChecks: false, replySleep: async () => {},
    env: { LIFE_MODEL_BASE_URL: 'https://fixture.test/v1', LIFE_MODEL_NAME: 'fixture' },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const semantic = body.messages[0].content.startsWith('Classify the current Chinese companion-dialogue turn.');
      if (!semantic) calls.push(body.messages);
      const memory = body.messages[0].content.startsWith('你整理林晓薇');
      const content = memory ? { items: [], ignored: JSON.parse(body.messages[1].content).conversation.map(row => ({ messageId: row.id, reason: 'filler' })) }
        : semantic ? { intent: 'respond', continuity: 'new', focusMessageId: null,
        ownLife: false, advice: false, emotionalDetail: false, imagined: false, correction: false,
        acceptsOffer: false, source: 'none', retrievalQuery: '', evidence: '' }
        : { reply: '今天的话题慢慢聊。', extra: '' };
      return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }] });
    },
  });
  app.preferences.setReplyPace('instant');
  const { port } = await app.listen(0);
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const request = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, body === undefined ? {} : {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  const seed = rows => app.store.transaction(() => {
    const insert = app.store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)');
    for (const row of rows) insert.run(row.id, row.role || 'miyue', row.speaker, row.text, row.kind || 'chat', row.createdAt);
  });
  return { app, calls, request, seed };
}

test('a changed HTTP setting reaches the actual writer beyond seven days, 800 rows and 60000 characters', async t => {
  const f = await fixture(t);
  const rows = [
    ...exchange('outside', '2026-09-01T10:00:00.000Z'),
    ...exchange('tendays', '2026-09-10T10:00:00.000Z'),
    ...Array.from({ length: 420 }, (_, i) => exchange(`dense${i}`, '2026-09-18T10:00:00.000Z', 'x'.repeat(75))).flat(),
    ...exchange('future', '2026-09-21T10:00:00.000Z'),
  ];
  f.seed(rows);
  await f.request('/api/preferences', { historyWindowDays: 14, historyMaxTokens: 200000 });
  await f.request('/api/chat', { role: 'miyue', text: '今天想聊一点别的' });
  const sent = text(f.calls.at(-1));
  assert.match(sent, /tendays用户/);
  assert.match(sent, /dense0用户/);
  assert.match(sent, /dense419回答/);
  assert.doesNotMatch(sent, /outside用户|future用户/);
  assert.match(sent, /最近 14 天/);
  assert.equal(f.calls.at(-1).at(-1).content, '今天想聊一点别的');
  const review = await f.request('/api/recall/miyue/review');
  assert.equal(review.policy.shortTermDays, 14);
  assert.equal(review.policy.maxTokens, 200000);
  assert.ok(review.shortTerm.messages > 800);
  assert.ok(review.shortTerm.chars > 60000);
  assert.ok(review.shortTerm.tokens <= 200000);

  await f.request('/api/preferences', { historyWindowDays: 1 });
  await f.request('/api/chat', { role: 'miyue', text: '只聊今天' });
  const reduced = f.calls.at(-1).filter(row => row.content.startsWith('【历史资料') || row.content.startsWith('【历史消息'));
  assert.doesNotMatch(text(reduced), /tendays|dense0用户/);
  assert.match(text(f.calls.at(-1)), /最近 1 天/);
  assert.equal(f.app.store.getMessage('tendays-u').text, 'tendays用户原话', 'changing the window does not delete originals');
});

test('projection budgets the serialized evidence and reply wrapper, preserves complete turns and the live input', () => {
  const rows = Array.from({ length: 30 }, (_, i) => exchange(`turn${i}`, now().toISOString(), '中文😀\\"\n'.repeat(8))).flat();
  const before = structuredClone(rows);
  const projection = prepareDialogueHistory(rows, { now: now(), maxTokens: 2200 });
  assert.ok(projection.rows.length > 0 && projection.rows.length < rows.length);
  assert.equal(projection.rows[0].speaker, 'user');
  assert.equal(projection.rows.length % 2, 0);
  assert.equal(projection.tokens, historyTokenCost(historyMessages(projection)));
  assert.ok(projection.tokens <= 2200);
  assert.match(projection.notice.content, /一部分/);
  assert.deepEqual(rows, before);
  const current = '最新问题'.repeat(1000);
  const messages = buildChatMessages({ role, memories: [], conversation: rows,
    currentUserText: current, historyMaxTokens: 2200, turnPlan: { trigger: { at: now().toISOString() } } });
  assert.equal(messages.at(-1).content, current);
});

test('recall and stored history share chronological order when a delayed input commits after another record',async t=>{
  const f=await fixture(t);
  const rows=[...exchange('first','2026-09-19T09:00:00Z'),...exchange('second','2026-09-19T10:00:00Z')];
  f.seed([rows[2],rows[0],rows[3],rows[1]]);
  const projection=f.app.recallRepo.dialogueWindow('miyue',{now:now()});
  assert.deepEqual(projection.rows.map(m=>m.id),rows.map(m=>m.id));
  assert.deepEqual(f.app.store.getMessages('miyue').map(m=>m.id),rows.map(m=>m.id));
});

test('oversized latest exchanges never bypass the budget and empty or stale windows are described truthfully', () => {
  const rows = [...exchange('earlier', now().toISOString()), ...exchange('large', now().toISOString(), '字'.repeat(5000))];
  const projection = prepareDialogueHistory(rows, { now: now(), maxTokens: 1000 });
  assert.deepEqual(projection.rows, []);
  assert.ok(projection.tokens <= 1000);
  assert.match(projection.notice.content, /0 条|没有/);
  assert.match(projection.notice.content, /预算/);
  for (const history of [[], exchange('old', '2026-08-01T00:00:00.000Z')]) {
    const empty = prepareDialogueHistory(history, { now: now() });
    assert.deepEqual(empty.rows, []);
    assert.match(empty.notice.content, /窗口内没有/);
    assert.doesNotMatch(text(historyMessages(empty)), /old用户/);
  }
  assert.equal(prepareDialogueHistory(rows, { now: now(), maxTokens: 1 }).tokens, 0);
});

test('active recall, reactive and proactive prompts use the same bounded, visible rows', async t => {
  const f = await fixture(t);
  f.seed(Array.from({ length: 15 }, (_, i) => exchange(`safe${i}`, now().toISOString(), '原话'.repeat(20))).flat());
  f.seed(exchange('other', now().toISOString()).map(row => ({ ...row, role: 'wenxi' })));
  f.seed(exchange('story', now().toISOString()).map(row => ({ ...row, kind: 'story' })));
  await f.request('/api/preferences', { historyWindowDays: 3, historyMaxTokens: 1800 });
  const context = f.app.roleContext('miyue', { initiating: false, text: '说说今天' });
  const projection = context.dialogueHistory;
  assert.ok(projection.tokens <= 1800 && projection.truncated);
  assert.deepEqual(context.conversation.map(row => row.id), projection.rows.map(row => row.id));
  assert.doesNotMatch(JSON.stringify(projection.rows), /other用户|story用户/);
  const proactive = buildProactiveMessages({ role, kind: 'life', ...f.app.roleContext('miyue') });
  const reactive = buildChatMessages({ role, memories: [], ...context, currentUserText: '说说今天' });
  for (const row of projection.rows) {
    assert.ok(text(reactive).includes(row.text));
    assert.ok(text(proactive).includes(row.text));
  }
  assert.match(text(proactive), /最近 3 天/);
  assert.ok(context.turnMemory.represented.every(item => item.sourceIds.every(id => projection.rows.some(row => row.id === id))));
  assert.ok(f.app.recallRepo.get('miyue').eligibleCount > 0, 'capacity-excluded messages can age into long-term memory');
});

test('the configured window also protects long-term consolidation, including an oversized recent message', async t => {
  const f = await fixture(t);
  f.seed(exchange('ten', '2026-09-10T10:00:00.000Z'));
  await f.request('/api/preferences', { historyWindowDays: 14 });
  assert.equal(f.app.recallRepo.get('miyue').eligibleCount, 0);
  await f.request('/api/preferences', { historyWindowDays: 3 });
  assert.equal(f.app.recallRepo.get('miyue').eligibleCount, 2, 'all old rows can consolidate when the recent window is empty');
  f.seed(exchange('huge', now().toISOString(), '长'.repeat(30000)));
  const result = await f.app.recall.run('miyue', { force: true });
  assert.ok(!text(f.calls.flat()).includes('huge用户'), 'oversized fresh text is not compacted as a side effect of an empty projection');
  assert.equal(result.status, 'updated');
  assert.equal(result.summarizedCount, 2);
});

test('a time cutoff cannot send an orphaned answer or treat an exact-boundary message as stale', async t => {
  const f = await fixture(t);
  f.seed([
    { id: 'cross-u', speaker: 'user', text: '窗口以前的问题', createdAt: '2026-09-13T11:59:59.000Z' },
    { id: 'cross-a', speaker: 'assistant', text: '跨过边界的回答', createdAt: '2026-09-13T12:00:00.000Z' },
    ...exchange('boundary', '2026-09-13T12:00:00.000Z'),
    ...exchange('latest', now().toISOString()),
  ]);
  const window = f.app.recallRepo.dialogueWindow('miyue');
  assert.deepEqual(window.rows.map(row => row.id), ['boundary-u', 'boundary-a', 'latest-u', 'latest-a']);
});

test('legacy user-fact recall still inherits a prepared custom time and token policy', () => {
  const rows = Array.from({ length: 8 }, (_, i) => exchange(`recall${i}`, now().toISOString(), '明天的约定'.repeat(25))).flat();
  const dialogueHistory = prepareDialogueHistory(rows, { now: now(), days: 3, maxTokens: 1800 });
  const messages = buildChatMessages({ role, memories: [], conversation: dialogueHistory.rows,
    dialogueHistory, currentUserText: '我之前说什么？', turnPlan: { mode: 'recall', recallSubject: 'user' } });
  assert.match(text(messages), /最近 3 天/);
  const sentHistory = messages.slice(1, -1);
  assert.ok(historyTokenCost(sentHistory) <= 1800);
});
