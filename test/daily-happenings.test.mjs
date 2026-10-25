import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DailyHappenings, happeningInputs, validateHappenings, newsCandidates, DAILY_HAPPENINGS_INSTRUCTION } from '../lib/daily-happenings.mjs';
import { UserThreads, keywordMatch } from '../lib/user-threads.mjs';
import { alternateMaterials } from '../lib/session-context.mjs';
import { buildSessionMessages } from '../lib/session-dialogue.mjs';
import { createApp } from '../server.mjs';

class TestStore {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec('CREATE TABLE content(id TEXT,feed_id TEXT,title TEXT,url TEXT,summary TEXT,published_at TEXT,created_at TEXT)'); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const out = fn(); this.db.exec('COMMIT'); return out; } catch (err) { this.db.exec('ROLLBACK'); throw err; } }
}
// 2026-10-21 06:30 Shanghai, a Wednesday.
const MORNING = new Date('2026-10-20T22:30:00Z');
const at = (clock, day = '2026-10-21') => new Date(`${day}T${clock}:00+08:00`);
const chunk = (id, day, items) => ({ id, day, items });
const CHUNKS = [
  chunk('c1', '2026-10-19', [
    { subject: 'user', kind: 'topic', status: 'ongoing', text: '用户在用AI写一部重生炼丹小说，刚写完第二章。' },
    { subject: 'user', kind: 'event', status: 'completed', text: '用户已经交完了季度报告。' },
    { subject: 'character', kind: 'event', status: 'completed', text: '角色去平江路给阿澜送了一盒点心。' },
  ]),
  chunk('c2', '2026-10-20', [
    { subject: 'user', kind: 'view', status: 'current', text: '用户想去山塘街坐船听评弹。' },
    { subject: 'shared', kind: 'topic', status: 'past', text: '双方聊了秋天吃什么。' },
  ]),
];
const GOOD = input => ({
  mood: '早上被楼下的猫逗乐，下午小郁的封面让人犯愁',
  onMind: ['小郁那张封面', '阿澜的干花'],
  items: [
    { slot: 'morning', kind: 'street', text: '下楼看见三花蹲在电动车座上，赶都赶不走', detail: '楼下三花这几天总占同一辆车。', mood: '好笑', canShare: true, keywords: ['三花', '电动车', '不存在的词'] },
    { slot: 'afternoon', kind: 'friend', text: '小郁发来新书封面问我丑不丑', detail: '烫金大字，她嫌土，我觉得字距太挤。', mood: '想吐槽', canShare: true, keywords: ['小郁', '封面'] },
    { slot: 'evening', kind: 'home', text: '晚上把阿澜给的花倒挂起来晾干', detail: '绣球掉了几片。', mood: '安静', canShare: false, keywords: ['阿澜'] },
  ],
  followUps: input?.userCandidates?.length ? [{ sourceId: input.userCandidates[0].id, text: '你那本炼丹小说写到哪了', askAfterDays: 2, keywords: ['炼丹', '小说'] }, { sourceId: 'u99', text: '编的', askAfterDays: 1, keywords: [] }] : [],
});

function harness(t, { answer = GOOD, clock = () => MORNING, chunks = CHUNKS, fail = null } = {}) {
  const store = new TestStore();
  const userThreads = new UserThreads(store, { clock: () => clock(), isSourceValid: (role, ref) => chunks.some(c => c.id === ref.split(':')[0]) });
  const calls = [];
  const model = { publicConfig: () => ({ configured: true }), complete: async (messages, options) => {
    calls.push({ messages, options });
    if (fail) throw fail(calls.length);
    return JSON.stringify(answer(JSON.parse(messages.at(-1).content)));
  } };
  const happenings = new DailyHappenings(store, { model, clock: () => clock(), userThreads, enabled: true,
    gather: ({ now, recent, knownRefs, openThreads }) => happeningInputs({ now, chunks, db: store.db, recent, knownRefs, openThreads,
      profile: { socialCircle: [{ id: 'xiaoyu', name: '小郁', relationship: '林的朋友' }] }, thread: { title: '橡皮章', beat: { text: '刻坏了一块', emotion: '懊恼' } },
      dayPlan: [{ kind: 'sleep', title: '睡觉', location: '家', startedAt: '2026-10-20T16:00:00Z', endsAt: '2026-10-20T23:20:00Z' }, { kind: 'work', title: '处理上午的工作', location: '苏州的工作室', startedAt: '2026-10-21T01:00:00Z', endsAt: '2026-10-21T04:00:00Z' }] }) });
  return { store, userThreads, happenings, calls };
}

test('one bounded JSON call a day builds happenings, mood and follow-ups from his own records', async t => {
  const h = harness(t);
  const result = await h.happenings.generate('miyue');
  assert.equal(result.status, 'ready', JSON.stringify(result));
  assert.equal(h.calls.length, 1);
  assert.deepEqual([h.calls[0].options.purpose, h.calls[0].options.maxTokens, h.calls[0].options.jsonObject], ['daily-happenings', 1200, true]);
  assert.equal(h.calls[0].messages[0].content, DAILY_HAPPENINGS_INSTRUCTION);
  const input = JSON.parse(h.calls[0].messages[1].content);
  // Only his unfinished records are candidates; finished ones and hers are not.
  assert.deepEqual(input.userCandidates.map(item => item.text), ['用户在用AI写一部重生炼丹小说，刚写完第二章。', '用户想去山塘街坐船听评弹。']);
  assert.deepEqual(input.schedule, ['09:00-12:00 处理上午的工作（苏州的工作室）']);
  assert.equal(input.today.weekday, '周三');
  assert.match(input.yesterday.her.join(), /阿澜送了一盒点心/u);
  assert.equal(input.friends[0].background, '大学同学，在苏州一家出版社做编辑，爱换歌单、能吃辣');
  const record = h.happenings.record('miyue');
  assert.deepEqual(record.items.map(item => item.id), ['h1', 'h2', 'h3']);
  assert.deepEqual(record.items[0].keywords, ['三花', '电动车'], 'keywords must come from the item itself');
  const threads = h.userThreads.list('miyue');
  assert.equal(threads.length, 1, 'an invented source id is dropped');
  assert.equal(threads[0].sourceRef, 'c1:0');
  assert.equal(threads[0].askAfter, '2026-10-21', 'ask after the source day plus the days given, never before today');
  assert.match(h.happenings.stableContext('miyue'), /心情：早上被楼下的猫逗乐.*心里惦记：小郁那张封面；阿澜的干花.*不用说出来/u);
  assert.equal((await h.happenings.ensure('miyue')).reason, 'ready');
  assert.equal(h.calls.length, 1, 'no second call the same day');
});

test('validation drops lines about him, nagging, progress, temperatures and invented news', () => {
  const base = { slot: 'noon', kind: 'home', detail: '', mood: '', canShare: true, keywords: [] };
  const value = validateHappenings({ mood: '平静', onMind: [], items: [
    { ...base, text: '阿闫今天在三星园区开会' }, { ...base, text: '记得吃饭啊早点睡' }, { ...base, text: '稿子改到第三版了' },
    { ...base, text: '今天只有12度好冷' }, { ...base, kind: 'news-reaction', text: '看到一条新闻挺离谱的' }, { ...base, kind: 'city', text: '去看了个展' },
    { ...base, slot: 'dinner', text: '时段不对' }, { ...base, text: '阳台的薄荷又冒新芽了' },
  ] }, { input: { news: [], cityEvents: [] } });
  assert.deepEqual(value.items.map(item => item.text), ['阳台的薄荷又冒新芽了']);
  assert.throws(() => validateHappenings({ mood: '平静', items: [{ ...base, text: '我想你了'.repeat(20) }] }), /没有可用的小事/u);
  assert.throws(() => validateHappenings({ items: [] }), /mood/u);
});

test('news candidates are recent social and cultural items, not official notices or repeats', () => {
  const store = new TestStore();
  const add = (id, feed, title, hours) => store.db.prepare('INSERT INTO content VALUES(?,?,?,?,?,?,?)').run(id, feed, title, 'https://x.test/' + id, `${title}的导语`, new Date(+MORNING - hours * 3600000).toISOString(), new Date(+MORNING).toISOString());
  add('a', 'chinanews-china', '江西某市原副市长接受审查调查', 1);
  add('b', 'chinanews-society', '苏州一小区居民自发种出一面墙的牵牛花', 2);
  add('c', 'chinanews-china', '良渚考古新发现', 3);
  add('d', 'bbc-chinese', '旧的新闻', 60);
  add('e', 'gcores', '游戏新作', 1);
  add('f', 'chinanews-world', '已经聊过的国际新闻', 1);
  const news = newsCandidates(store.db, MORNING, { usedTitles: new Set(['已经聊过的国际新闻']) });
  assert.deepEqual(news.map(item => item.title), ['苏州一小区居民自发种出一面墙的牵牛花', '良渚考古新发现']);
});

test('offers only due, untold happenings and one question a day; receipts by id or by her own words', async t => {
  let now = MORNING;
  const h = harness(t, { clock: () => now });
  await h.happenings.generate('miyue');
  now = at('09:00');
  let offer = h.happenings.offer('miyue');
  assert.deepEqual(offer.items.map(item => item.id), ['h1'], 'afternoon and evening have not happened yet');
  assert.equal(offer.followUp.text, '你那本炼丹小说写到哪了');
  assert.match(h.happenings.turnContext(offer), /可顺口提，不必提[\s\S]*问一次就够[\s\S]*usedIds/u);
  // The model named the id.
  assert.deepEqual(h.happenings.observe('miyue', { rows: [{ id: 'u1', speaker: 'user', text: '早' }, { id: 'a1', speaker: 'assistant', text: '早呀，跟你说个好笑的' }], proposal: { usedIds: ['h1'] }, offer }).shared, ['h1']);
  now = at('15:00');
  offer = h.happenings.offer('miyue');
  assert.deepEqual(offer.items.map(item => item.id), ['h2'], 'the evening item cannot be shared and the told one is not offered again');
  assert.deepEqual(offer.told, ['下楼看见三花蹲在电动车座上，赶都赶不走']);
  assert.match(h.happenings.turnContext(offer, { toldOnly: true }), /今天已经跟他讲过的/u);
  assert.doesNotMatch(h.happenings.turnContext(offer, { toldOnly: true }), /小郁发来/u);
  // Keywords he said himself do not count as her telling it.
  assert.deepEqual(h.happenings.observe('miyue', { rows: [{ id: 'u2', speaker: 'user', text: '小郁的封面怎么样' }, { id: 'a2', speaker: 'assistant', text: '小郁那个封面啊 还行吧' }], proposal: {}, offer }).shared, []);
  // Rewritten drafts may lose usedIds; her words still carry the receipt.
  const result = h.happenings.observe('miyue', { rows: [{ id: 'u3', speaker: 'user', text: '你在干嘛' }, { id: 'a3', speaker: 'assistant', text: '小郁刚发我一张封面，丑到我了，还问炼丹小说写到哪了' }], proposal: {}, offer });
  assert.deepEqual(result.shared, ['h2']);
  assert.deepEqual(result.asked, [h.userThreads.list('miyue')[0].id]);
  assert.equal(h.happenings.offer('miyue').followUp, null, 'nothing more to ask today');
  const snapshot = h.happenings.snapshot('miyue');
  assert.deepEqual(snapshot.items.map(item => [item.id, item.shared, item.receipt]), [['h1', true, 'id'], ['h2', true, 'keywords'], ['h3', false, null]]);
});

test('proactive slate counts happenings as her own life and holds news after news', async t => {
  let now = MORNING;
  const h = harness(t, { clock: () => now });
  await h.happenings.generate('miyue');
  now = at('16:00');
  const materials = h.happenings.materials(h.happenings.offer('miyue'));
  assert.deepEqual(materials.map(item => [item.kind, item.id]), [['daily_happening', 'happening:2026-10-21:h2'], ['daily_happening', 'happening:2026-10-21:h1'], ['user_thread', `user-thread:${h.userThreads.list('miyue')[0].id}`]]);
  const slate = [{ id: 'daily-info:x', kind: 'daily_info' }, ...materials];
  assert.deepEqual(alternateMaterials(slate, [{ kind: 'article' }]).materials.map(item => item.kind), ['daily_happening', 'daily_happening', 'user_thread']);
  // The proactive initiative id is a receipt too.
  const offer = h.happenings.offer('miyue');
  assert.deepEqual(h.happenings.observe('miyue', { rows: [{ id: 'p1', speaker: 'assistant', text: '诶 刚才有件事' }], proposal: { initiative: { materialId: 'happening:2026-10-21:h2' } }, offer }).shared, ['h2']);
});

test('he brings it up himself, it lapses, or its source is edited away: no question', async t => {
  let now = MORNING, chunks = CHUNKS;
  const h = harness(t, { clock: () => now, chunks });
  await h.happenings.generate('miyue');
  now = at('10:00');
  const [thread] = h.userThreads.list('miyue');
  assert.deepEqual(h.userThreads.observeUser('miyue', '我的炼丹小说今天写到第三章了', 'u9'), [thread.id]);
  assert.equal(h.userThreads.list('miyue')[0].status, 'mentioned');
  assert.equal(h.userThreads.offer('miyue'), null);
  // A fresh thread whose source chunk disappeared is removed instead of offered.
  h.userThreads.add('miyue', [{ sourceRef: 'gone:0', sourceDay: '2026-10-20', sourceText: '用户想学游泳', text: '游泳学了没', keywords: ['游泳'] }], { now });
  assert.equal(h.userThreads.offer('miyue', { now: at('12:00', '2026-10-22') }), null);
  assert.equal(h.userThreads.list('miyue').some(item => item.sourceRef === 'gone:0'), false);
  // Unasked threads lapse a few days after they became due.
  h.userThreads.add('miyue', [{ sourceRef: 'c2:0', sourceDay: '2026-10-20', sourceText: '用户想去山塘街坐船听评弹。', text: '山塘街去了没', keywords: ['山塘街'] }], { now });
  assert.equal(h.userThreads.offer('miyue', { now: at('12:00', '2026-10-30') }), null);
  assert.equal(h.userThreads.list('miyue').find(item => item.sourceRef === 'c2:0').status, 'expired');
  assert.equal(keywordMatch('山塘街', ['山塘街', '评弹']), false, 'two keywords need two hits');
  assert.equal(keywordMatch('山塘街听评弹', ['山塘街', '评弹']), true);
});

test('failures back off like the morning organisation and never retry more than three times a day', async t => {
  let now = MORNING;
  const outage = () => Object.assign(new Error('offline'), { code: 'MODEL_NETWORK_ERROR' });
  const h = harness(t, { clock: () => now, fail: outage });
  assert.equal((await h.happenings.ensure('miyue')).status, 'failed');
  assert.equal(h.happenings.snapshot('miyue').failedAttempts, 0, 'an unreachable model spends nothing');
  assert.equal(h.happenings.due('miyue'), 'backoff');
  now = new Date(+now + 16 * 60000);
  await h.happenings.ensure('miyue');
  assert.equal(h.happenings.snapshot('miyue').retryAt, new Date(+now + 30 * 60000).toISOString(), 'second outage waits 30 minutes');
  const bad = harness(t, { clock: () => now, answer: () => ({ mood: '', items: [] }) });
  for (let i = 0; i < 3; i++) { assert.equal((await bad.happenings.ensure('miyue')).status, 'failed'); now = new Date(+now + 16 * 60000); }
  assert.equal(bad.happenings.due('miyue'), 'retry-limit');
  assert.equal(bad.happenings.stableContext('miyue'), '');
  assert.deepEqual(bad.happenings.offer('miyue').items, []);
  // Before 02:00 nothing runs; before 06:00 it waits for the organisation.
  const early = new DailyHappenings(new TestStore(), { model: { complete: async () => '{}' }, enabled: true, clock: () => at('01:30'), isReady: () => false });
  assert.equal(early.due('miyue'), 'before-morning');
  assert.equal(early.due('miyue', { now: at('03:00') }), 'waiting-memory');
  assert.equal(early.due('miyue', { now: at('06:10') }), 'due');
});

test('the reply envelope asks for usedIds only when something was offered', () => {
  const base = { role: { id: 'miyue', name: '林晓薇' }, history: { rows: [] }, userText: '你今天干嘛了', trigger: { type: 'user_message', at: '2026-10-21T04:40:00Z' } };
  const without = buildSessionMessages(base).find(m => m.content.startsWith('【当前轮次】')).content;
  assert.match(without, /只输出 JSON \{"reply":string\}；/u);
  const messages = buildSessionMessages({ ...base, ownContext: '她今天自己的小事（可顺口提，不必提）：[{"id":"h2"}]', ownIds: ['h2'] });
  assert.match(messages.find(m => m.content.startsWith('【当前轮次】')).content, /\{"reply":string,"usedIds":string\[\]\}/u);
  assert.match(messages.find(m => m.content.startsWith('【本轮背景证据】')).content, /可顺口提，不必提/u);
});

test('chat turn carries the day into the prompt and records what she told', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-happenings-app-'));
  let now = MORNING; const bodies = [];
  const replies = [JSON.stringify(GOOD({})), JSON.stringify({ reply: '早呀 跟你说楼下三花又霸占电动车了', usedIds: [] })];
  const app = await createApp({ dataDir, sessionDialogue: true, sessionGuidance: false, sessionReview: false, dynamicCompanion: true, dailyHappenings: true,
    startDiscovery: false, initialFeeds: [], startWeixin: false, startChatQueue: false, startProactive: false, startRecall: false, startResearch: false, startLife: false,
    startRuntime: false, startDailyLife: false, startLifeThreads: false, startPursuits: false, startDossiers: false, replySleep: async () => {}, clock: () => new Date(now), random: () => 0.5,
    env: { LIFE_MODEL_BASE_URL: 'https://fixture.test/v1', LIFE_MODEL_NAME: 'fixture' },
    fetchImpl: async (_url, init) => { const body = JSON.parse(init.body); bodies.push(body); return Response.json({ choices: [{ message: { content: replies.shift() } }], usage: { prompt_tokens: 30, completion_tokens: 12 } }); } });
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  assert.equal((await app.dailyHappenings.generate('miyue')).status, 'ready');
  now = at('08:30');
  const address = await app.listen(0);
  const response = await fetch(`http://127.0.0.1:${address.port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'miyue', text: '早上好呀' }) });
  assert.equal(response.status, 200, await response.clone().text());
  const prompt = bodies[1].messages.map(m => m.content).join('\n');
  assert.match(prompt, /【她今天的状态】心情：早上被楼下的猫逗乐/u);
  assert.match(prompt, /下楼看见三花蹲在电动车座上/u);
  assert.doesNotMatch(prompt, /小郁发来新书封面/u, 'the afternoon has not come yet');
  const day = await (await fetch(`http://127.0.0.1:${address.port}/api/daily-happenings`)).json();
  assert.deepEqual(day.items.map(item => [item.id, item.shared, item.receipt]), [['h1', true, 'keywords'], ['h2', false, null], ['h3', false, null]]);
  const diagnostics = await (await fetch(`http://127.0.0.1:${address.port}/api/dialogue-diagnostics`)).json();
  assert.equal(diagnostics.dailyHappenings.mood, GOOD({}).mood);
});
