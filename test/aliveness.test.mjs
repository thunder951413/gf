import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { RelationshipLedger } from '../lib/relationship-ledger.mjs';
import { missingPulse, missMaterial } from '../lib/relationship-pulse.mjs';
import { motifCounts, noveltyContext } from '../lib/novelty-guard.mjs';
import { StoryArcs, validateArcs, weekOf } from '../lib/story-arcs.mjs';
import { CompanionIdentity, identityProfile } from '../lib/companion-identity.mjs';
import { validateHappenings, happeningInputs } from '../lib/daily-happenings.mjs';
import { weeklyReport, recordFeedback, reportMarkdown } from '../lib/weekly-report.mjs';
import { buildSessionMessages } from '../lib/session-dialogue.mjs';
import { voiceProfile } from '../lib/companion-voice.mjs';
import { TUNING_DEFAULTS, TUNING_PRESETS, validateTuning } from '../lib/companion-tuning.mjs';

function memoryStore() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE messages(id TEXT PRIMARY KEY,role TEXT NOT NULL,speaker TEXT NOT NULL,text TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'chat',content_id TEXT,created_at TEXT NOT NULL)`);
  return { db, transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; } } };
}
const fakeModel = answer => { const calls = []; return { calls, publicConfig: () => ({ configured: true }), complete: async (messages, options) => { calls.push({ messages, options }); return JSON.stringify(typeof answer === 'function' ? answer(messages, options) : answer); } }; };
const NOW = new Date('2026-10-26T02:30:00Z'); // 10:30 Monday in Shanghai

test('the ledger keeps only changes backed by real messages and turns them into a stable block', async () => {
  const store = memoryStore();
  const rows = [
    { id: 'u1', speaker: 'user', text: '烘好豆子寄你一包', createdAt: '2026-10-25T02:00:00Z' },
    { id: 'a1', speaker: 'assistant', text: '那我等着，咖啡师小闫', createdAt: '2026-10-25T02:01:00Z' },
    { id: 'u2', speaker: 'user', text: '我觉得时势造英雄', createdAt: '2026-10-25T03:00:00Z' },
    { id: 'a2', speaker: 'assistant', text: '我不同意，有些人放哪个年代都会站出来', createdAt: '2026-10-25T03:01:00Z' },
  ];
  const model = fakeModel({
    promises: [{ op: 'add', text: '他烘好豆子寄她一包', by: 'user', evidence: ['m1'] }, { op: 'add', text: '没有依据的约定', by: 'both', evidence: ['m99'] }],
    jokes: [{ op: 'add', text: '咖啡师小闫', meaning: '他靠喝出非洲豆拼配得的外号', evidence: ['m2'] }],
    views: [{ op: 'add', topic: '英雄', text: '时势造英雄', evidence: ['m3'] }],
    debates: [{ op: 'add', topic: '时势与英雄', her: '有些人放哪个年代都会站出来', his: '时势造英雄', open: '普通年代看不出来算不算', evidence: ['m3', 'm4'] }],
  });
  const ledger = new RelationshipLedger(store, { model, clock: () => NOW, enabled: true, listMessages: () => rows });
  assert.equal(ledger.due('miyue'), 'due');
  const result = await ledger.ensure('miyue');
  assert.equal(result.status, 'ready'); assert.equal(result.added, 4, 'the unbacked promise is dropped');
  const input = JSON.parse(model.calls[0].messages[1].content);
  assert.deepEqual(input.conversation.map(row => row.who), ['他', '她', '他', '她']);
  const block = ledger.stableContext('miyue', { stubborn: 80 });
  assert.match(block, /说好的事.*他烘好豆子寄她一包/); assert.match(block, /咖啡师小闫/); assert.match(block, /时势与英雄——你：有些人放哪个年代都会站出来；他：时势造英雄/);
  assert.match(block, /不轻易让步/);
  assert.equal(ledger.due('miyue'), 'ready', 'once a day');
  // A day later: the promise is kept, the debate is settled by him being persuaded.
  const promise = ledger.list('miyue', { kind: 'promise' })[0], debate = ledger.list('miyue', { kind: 'debate' })[0];
  ledger.apply('miyue', { promises: [{ op: 'close', id: promise.id, status: 'done', evidence: ['m1'] }], debates: [{ op: 'update', id: debate.id, status: 'settled', settled: 'him', evidence: ['m1'] }] }, new Map([['m1', 'u9']]), { now: NOW });
  assert.equal(ledger.list('miyue', { kind: 'promise' }).length, 0);
  assert.equal(ledger.list('miyue', { kind: 'debate', status: 'settled' })[0].settled, 'him');
});

test('ledger materials offer an idle promise and an open debate, then wait after being used', () => {
  const store = memoryStore(); let now = new Date('2026-10-20T02:00:00Z');
  const ledger = new RelationshipLedger(store, { model: fakeModel({}), clock: () => now, enabled: true });
  ledger.apply('miyue', { promises: [{ op: 'add', text: '一起去泡温泉', by: 'both', evidence: ['m1'] }], debates: [{ op: 'add', topic: 'AI写小说', her: '看用的人', his: '没灵魂', evidence: ['m1'] }] }, new Map([['m1', 'x']]), { now });
  assert.deepEqual(ledger.materials('miyue', { now }), [], 'nothing on the day it was said');
  now = new Date('2026-10-23T02:00:00Z');
  const items = ledger.materials('miyue', { now });
  assert.deepEqual(items.map(item => item.kind), ['promise', 'debate']);
  assert.ok(ledger.markUsed(items[0].id, 'msg1', { now }));
  assert.deepEqual(ledger.materials('miyue', { now }).map(item => item.kind), ['debate']);
});

test('missing him grows with his silence at the slider rate and becomes a reason to reach out', () => {
  const now = new Date('2026-10-25T10:00:00Z');
  assert.equal(missingPulse({ hisLastAt: '2026-10-25T09:00:00Z', now, missing: 65 }).level, 6);
  const quiet = missingPulse({ hisLastAt: '2026-10-25T00:00:00Z', now, missing: 65 });
  assert.equal(quiet.level, 60); assert.equal(quiet.band, '有点想他');
  assert.equal(missingPulse({ hisLastAt: '2026-10-25T00:00:00Z', now, missing: 10 }).level, 30, 'a low slider misses him more slowly');
  assert.equal(missingPulse({ hisLastAt: null, now }), null);
  const miss = missMaterial(quiet, { now });
  assert.equal(miss.kind, 'miss'); assert.match(miss.detail, /约10小时没说话/);
  assert.equal(missMaterial(quiet, { now, lastMissAt: '2026-10-25T04:00:00Z' }), null, 'not twice within 12 hours');
  assert.equal(missMaterial(missingPulse({ hisLastAt: '2026-10-25T08:00:00Z', now, missing: 100 }), { now }), null, 'he spoke less than 4 hours ago');
});

test('the novelty guard names motifs she has used up this week', () => {
  const now = new Date('2026-10-25T10:00:00Z');
  const rows = Array.from({ length: 7 }, (_, i) => ({ speaker: 'assistant', text: `今天又煮了碗汤面 ${i}`, createdAt: `2026-10-2${i % 5}T04:00:00Z` }))
    .concat({ speaker: 'assistant', text: '配色定了', createdAt: '2026-10-24T04:00:00Z' }, { speaker: 'user', text: '汤面汤面汤面', createdAt: '2026-10-24T04:00:00Z' });
  const meal = motifCounts(rows, { now }).find(motif => motif.key === 'meal');
  assert.equal(meal.count, 7, 'only her own messages count');
  const note = noveltyContext(rows, { now });
  assert.match(note, /吃饭和吃了什么（7次）/); assert.doesNotMatch(note, /改稿/);
  assert.equal(noveltyContext([], { now }), '');
});

const arcAnswer = days => ({
  arcs: [
    { line: 'work', title: '茶叶客户第三次推翻', setup: '上周交的包装被打回', stakes: '这单做不好下个月房租紧', beats: [{ day: days[0], text: '客户说要“更高级一点”', feeling: '烦', shareable: true }, { day: days[2], text: '她决定直接打电话问清楚', feeling: '紧张', shareable: true }], choice: { day: days[1], question: '要不要干脆退掉这单', options: ['硬着头皮改', '退单'] }, ending: '电话里谈开了，客户只要换个字体' },
    { line: 'people', title: '小郁失恋', setup: '小郁和男朋友分手', stakes: '怕小郁一个人扛', beats: [{ day: days[0], text: '小郁半夜发来一长串语音', feeling: '心疼', shareable: true }, { day: days[3], text: '两人去东山走了一下午', feeling: '松了口气', shareable: true }], choice: { day: days[0], question: '第二个选择会被丢掉', options: ['a', 'b'] }, ending: '小郁说想一个人待一阵' },
    { line: 'work', title: '重复的线会被丢掉', setup: 'x', stakes: 'x', beats: [{ day: days[0], text: 'x' }, { day: days[1], text: 'y' }], ending: 'x' },
  ],
  questions: ['勇敢是天生的还是逼出来的？'],
});

test('weekly arcs validate dates, lines and the single choice, and reveal the ending only on its day', async () => {
  const store = memoryStore(); let now = NOW;
  const identity = new CompanionIdentity(store);
  const week = weekOf(NOW); assert.equal(week, '2026-10-26');
  const days = Array.from({ length: 7 }, (_, i) => new Date(Date.parse(`${week}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));
  const model = fakeModel(() => arcAnswer(days));
  const arcs = new StoryArcs(store, { model, clock: () => now, identity, enabled: true, gather: () => ({ avoid: ['吃饭和吃了什么'] }) });
  assert.equal((await arcs.ensure('miyue')).status, 'ready');
  const input = JSON.parse(model.calls[0].messages[1].content);
  assert.deepEqual(input.days, days); assert.match(input.world, /小郁/); assert.deepEqual(input.avoid, ['吃饭和吃了什么']);
  const record = arcs.record('miyue');
  assert.deepEqual(record.arcs.map(arc => arc.line), ['work', 'people']);
  assert.ok(record.arcs[0].choice); assert.equal(record.arcs[1].choice, null, 'only one line may ask for his opinion');
  let block = arcs.stableContext('miyue');
  assert.match(block, /今天：客户说要“更高级一点”（烦）/); assert.doesNotMatch(block, /换个字体/); assert.match(block, /勇敢是天生的/);
  assert.deepEqual(arcs.materials('miyue').map(item => item.kind), ['arc_beat', 'arc_beat']);
  assert.ok(arcs.markShared('miyue', arcs.materials('miyue')[0].id, 'm1'));
  assert.equal(arcs.materials('miyue').length, 1);
  now = new Date(`${days[1]}T03:00:00Z`);
  assert.deepEqual(arcs.materials('miyue', { now }).map(item => item.kind), ['arc_choice']);
  now = new Date(`${days[2]}T03:00:00Z`);
  block = arcs.stableContext('miyue', { now });
  assert.match(block, /之前：10-26 客户说要/); assert.match(block, /结果：电话里谈开了/);
  identity.set('ai', 0);
  assert.equal(arcs.active('miyue', { now }), null, 'a human week does not carry into the AI identity');
  assert.equal(arcs.due('miyue', { now }), 'due');
});

test('arc validation rejects a week with fewer than two usable lines', () => {
  assert.throws(() => validateArcs({ arcs: [{ line: 'self', title: 't', ending: 'e', beats: [{ day: '2026-10-26', text: 'a' }, { day: '2026-10-27', text: 'b' }] }] }, { days: ['2026-10-26', '2026-10-27'] }), /不足两条/);
});

test('the AI identity changes her opening, hides body facts, and keeps her personality', () => {
  const store = memoryStore(), identity = new CompanionIdentity(store);
  assert.equal(identity.get().mode, 'human');
  assert.throws(() => identity.set('robot', 0), /human 或 ai/);
  assert.equal(identity.set('ai', 0).mode, 'ai');
  assert.throws(() => identity.set('human', 0), /别处更新/);
  const profile = { age: 27, braCup: 'B+', home: '苏州', temperament: '温婉', opinions: ['慢一点好'] };
  assert.deepEqual(identityProfile('ai', profile), { temperament: '温婉', opinions: ['慢一点好'] });
  const role = { id: 'miyue', name: '林晓薇', profile };
  const ai = buildSessionMessages({ role, history: { rows: [] }, userText: '你在干嘛', trigger: { type: 'user_message', at: NOW.toISOString() }, identity: 'ai' })[0].content;
  assert.match(ai, /住在他 Mac 里的 AI/); assert.doesNotMatch(ai, /B\+|27岁，住在苏州/); assert.match(ai, /隔着屏幕/); assert.match(ai, /慢一点好/);
  const human = buildSessionMessages({ role, history: { rows: [] }, userText: '你在干嘛', trigger: { type: 'user_message', at: NOW.toISOString() } })[0].content;
  assert.match(human, /27岁，住在苏州/); assert.match(human, /如实说你是模型根据设定生成的虚构角色/);
});

test('turn notes reach the per-turn evidence block, not the cached persona', () => {
  const messages = buildSessionMessages({ role: { id: 'miyue', name: '林晓薇' }, history: { rows: [] }, userText: '嗯', trigger: { type: 'user_message', at: NOW.toISOString() }, turnNotes: '【最近说太多的】吃饭' });
  assert.doesNotMatch(messages[0].content, /最近说太多的/);
  assert.ok(messages.some(message => message.role === 'system' && message !== messages[0] && message.content.includes('【最近说太多的】吃饭')));
});

test('AI happenings accept only what an AI can live through, and the week story replaces the life thread', () => {
  const raw = { mood: '有点期待', onMind: [], items: [
    { slot: 'morning', kind: 'online', text: '早上读到有人说AI都是复读机，有点不服', detail: '一个论坛里在吵AI有没有感情。', mood: '不服', canShare: true, keywords: ['复读机'] },
    { slot: 'noon', kind: 'street', text: '楼下的猫又来了', detail: '三花。', mood: '开心', canShare: true, keywords: ['猫'] },
  ], followUps: [] };
  assert.deepEqual(validateHappenings(raw, { identity: 'ai' }).items.map(item => item.kind), ['online']);
  assert.deepEqual(validateHappenings(raw, {}).items.map(item => item.kind), ['street'], 'online is not a human kind');
  const thread = { title: '胶片机', beat: { text: '第一卷', emotion: '期待' } };
  const withStory = happeningInputs({ now: NOW, thread, weekStory: ['茶叶客户第三次推翻：客户说要更高级一点'] }).input;
  assert.equal(withStory.lifeThread, null); assert.deepEqual(withStory.weekStory, ['茶叶客户第三次推翻：客户说要更高级一点']);
  const asAi = happeningInputs({ now: NOW, thread, identity: 'ai' });
  assert.equal(asAi.identity, 'ai'); assert.equal(asAi.input.schedule, undefined); assert.equal(asAi.input.friends, undefined);
});

test('the weekly report counts motifs, reasons, fresh days and his feedback', () => {
  const store = memoryStore(), db = store.db, now = new Date('2026-10-25T14:00:00Z');
  db.exec(`CREATE TABLE proactive_material_deliveries(message_id TEXT PRIMARY KEY,role_id TEXT,material_id TEXT,kind TEXT,quote TEXT,material_json TEXT,created_at TEXT)`);
  const add = (id, speaker, text, at, kind = 'chat') => db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)').run(id, 'miyue', speaker, text, kind, at);
  add('u1', 'user', '早', '2026-10-24T00:00:00Z'); add('a1', 'assistant', '早呀 我刚煮了汤面', '2026-10-24T00:01:00Z');
  add('a2', 'assistant', '想你了', '2026-10-24T06:00:00Z', 'proactive');
  db.prepare("INSERT INTO proactive_material_deliveries VALUES('a2','miyue','miss:x','miss','想你了','{}','2026-10-24T06:00:00Z')").run();
  recordFeedback(db, { messageId: 'a1', verdict: 'repeat', now });
  recordFeedback(db, { messageId: 'a2', verdict: 'alive', now });
  assert.throws(() => recordFeedback(db, { messageId: 'u1', verdict: 'alive' }), /找不到/);
  const report = weeklyReport(db, { now });
  assert.equal(report.messages.hers, 2); assert.equal(report.messages.proactive, 1); assert.equal(report.messages.conversationsHeStarted, 1);
  assert.equal(report.motifs.find(motif => motif.key === 'meal').count, 1);
  assert.deepEqual(report.proactiveReasons, { miss: 1, none: 0 });
  assert.deepEqual(report.feedback, { repeat: 1, alive: 1 });
  assert.equal(report.daysWithoutNew, 1);
  assert.match(reportMarkdown(report), /又重复了 1/);
});

test('the seven emotion sliders have defaults, presets and behaviour bands', () => {
  for (const key of ['missing', 'jealousy', 'temper', 'recovery', 'clingy', 'loveTalk', 'stubborn']) assert.ok(Number.isInteger(TUNING_DEFAULTS[key]), key);
  assert.deepEqual(validateTuning({ missing: 90 }).missing, 90);
  const inLove = TUNING_PRESETS.find(preset => preset.id === 'in-love');
  const profile = voiceProfile(inLove.values, { at: NOW.toISOString() });
  assert.match(profile, /很想他，经常说出来/); assert.match(profile, /常主动说情话/);
  assert.match(voiceProfile({ ...TUNING_DEFAULTS, stubborn: 90 }), /会坚持自己的立场/);
});
