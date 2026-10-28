import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { RelationshipLedger, restingUntil } from '../lib/relationship-ledger.mjs';
import { repeatedPhrases, noveltyContext } from '../lib/novelty-guard.mjs';
import { happeningInputs, validateHappenings, AI_HAPPENING_KINDS } from '../lib/daily-happenings.mjs';

const NOW = new Date('2026-10-27T12:00:00Z');
const DAY = 86400000;
function memoryStore() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE messages(id TEXT PRIMARY KEY,role TEXT NOT NULL,speaker TEXT NOT NULL,text TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'chat',content_id TEXT,created_at TEXT NOT NULL)`);
  return { db, transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; } } };
}
const ids = new Map([['m1', 'u1']]);

test('what she brought up rests a while, and everything sinks as days pass instead of being dug back up', () => {
  const store = memoryStore(); let now = NOW;
  const ledger = new RelationshipLedger(store, { model: {}, clock: () => now, enabled: true });
  ledger.apply('miyue', { jokes: [{ op: 'add', text: '存档搁你这儿', meaning: '记忆在他那', evidence: ['m1'] }, { op: 'add', text: '嫌完还得回来哄我', meaning: '吵嘴账', evidence: ['m1'] }],
    skills: [{ op: 'add', area: '吃烧鸭', text: '能分出皮的热冷', evidence: ['m1'] }], changed: [{ op: 'add', about: '看新闻', text: '他说看两边怎么说，她现在真会去翻另一边', evidence: ['m1'] }] }, ids, { now });
  assert.match(ledger.stableContext('miyue', { now }), /存档搁你这儿/); assert.match(ledger.stableContext('miyue', { now }), /嫌完还得回来哄我/);
  assert.match(ledger.stableContext('miyue', { now }), /你因为他变过的.*看新闻：他说看两边怎么说/);
  // She uses the joke and cites his skill; both are marked from what she actually said.
  const used = ledger.observe('miyue', [{ id: 'r1', speaker: 'assistant', text: '嫌完还得回来哄我，你吃烧鸭分得出皮的热冷，我信' }], { now });
  assert.equal(used.length, 2);
  const joke = ledger.list('miyue', { kind: 'joke' }).find(item => item.text === '嫌完还得回来哄我');
  assert.equal(joke.useCount, 1); assert.equal(restingUntil(joke, now), new Date(+now + 24 * 3600000).toISOString());
  // The background is judged once a day (it is cached), so the rest shows from the next day.
  assert.match(ledger.stableContext('miyue', { now }), /嫌完还得回来哄我/, 'unchanged for the rest of today');
  now = new Date(+NOW + 6 * 3600000);
  assert.doesNotMatch(ledger.stableContext('miyue', { now }), /嫌完还得回来哄我|吃烧鸭/, 'the next day it is out of her head');
  now = new Date(+NOW + 2 * DAY);
  assert.match(ledger.stableContext('miyue', { now }), /嫌完还得回来哄我/, 'once rested, still near the surface');
  // Nothing is dug back up: a month on, with nothing new said about it, it has sunk.
  now = new Date(+NOW + 25 * DAY);
  assert.doesNotMatch(ledger.stableContext('miyue', { now }), /嫌完还得回来哄我|存档搁你这儿/, 'sunk below the horizon');
  assert.match(ledger.stableContext('miyue', { now }), /吃烧鸭/, 'what she knows about him stays longer');
  // Two days after she changed because of him, it becomes something to tell him.
  now = new Date(+NOW + 3 * DAY);
  const changed = ledger.materials('miyue', { now }).find(item => item.kind === 'changed');
  assert.equal(changed?.title, '看新闻'); assert.match(changed.scope, /哪句话、哪件事/);
  assert.ok(ledger.markUsed(changed.id, 'r3', { now }));
  assert.ok(!ledger.materials('miyue', { now }).some(item => item.kind === 'changed'), 'told once');
});

test('repetition is read off her own messages: a burst over her usual vocabulary counts, answering him does not', () => {
  const rows = [];
  const say = (speaker, text, daysAgo) => rows.push({ speaker, text, createdAt: new Date(+NOW - daysAgo * DAY).toISOString() });
  // Four earlier weeks of her ordinary talk: 心里 is just how she speaks.
  for (let day = 8; day < 36; day++) { say('assistant', '我心里想着你呢', day); say('assistant', '今天慢慢过', day); }
  // This week she keeps bringing up 烧鸭 on her own, and 程序 while he said it only once.
  for (let day = 0; day < 7; day++) { say('assistant', '我心里挺好的', day); say('assistant', '今天又想吃烧鸭了，皮脆', day); }
  for (let day = 0; day < 4; day++) say('assistant', '程序不吵架，我吵', day);
  say('user', '都是程序', 1);
  // 张居正 came up because he keeps bringing it.
  for (let day = 0; day < 4; day++) { say('user', '张居正那段', day); say('assistant', '张居正后来呢', day); }
  const found = repeatedPhrases(rows, { now: NOW });
  const words = found.map(item => item.word);
  assert.ok(words.includes('烧鸭') && words.includes('程序'), JSON.stringify(found));
  assert.ok(!words.includes('心里') && !words.includes('张居正'), JSON.stringify(found));
  assert.match(noveltyContext(rows, { now: NOW }), /【你最近老提的】.*烧鸭/);
  assert.deepEqual(repeatedPhrases(rows.filter(row => Date.parse(row.createdAt) >= +NOW - 7 * DAY), { now: NOW }), [], 'no baseline, no judgement');
});

test('as an AI her day can come from what she read today, and only from that', () => {
  const base = { now: NOW, identity: 'ai', chunks: [], recent: [] };
  const withReadings = happeningInputs({ ...base, readings: [{ title: '两百年的老石屋', why: '旧物有痕迹', take: '修旧屋的人在躲什么' }], avoid: ['程序', '冷冰冰'] });
  assert.deepEqual(withReadings.input.readings, [{ title: '两百年的老石屋', why: '旧物有痕迹', take: '修旧屋的人在躲什么' }]); assert.deepEqual(withReadings.input.avoid, ['程序', '冷冰冰']);
  assert.ok(AI_HAPPENING_KINDS.includes('reading'));
  const item = { slot: 'morning', kind: 'reading', text: '老石屋那篇我又翻了一遍', detail: '想知道修旧屋的人在躲什么', mood: '好奇', canShare: true, keywords: ['老石屋'] };
  const value = { mood: '平静', onMind: [], items: [item], followUps: [] };
  assert.equal(validateHappenings(value, withReadings).items.length, 1);
  assert.throws(() => validateHappenings(value, happeningInputs(base)), /没有可用的小事/, 'nothing read, nothing to react to');
});

test('a reply that only agrees is read as the topic running out, which is when she brings something of her own', async () => {
  const { isLull, lullNote } = await import('../lib/novelty-guard.mjs');
  for (const text of ['你说得对哦', '是呢', '哈哈哈', '嗯嗯', '可不么', '确实', '好呀😊']) assert.ok(isLull(text), text);
  for (const text of ['教人认账？', '没有呢，只是时候到了就觉得应该喝两杯', '我也是，我也想你。我还想你黏我呢。', '你这个小调皮。']) assert.ok(!isLull(text), text);
  assert.match(lullNote('是呢'), /拿一件你自己的事讲/); assert.equal(lullNote('你最近看了什么'), '');
});

test('when she reaches out the morning after, she is told when they last talked and how it ended', async () => {
  const { lastTalkFact } = await import('../lib/session-context.mjs');
  const store = memoryStore();
  store.db.prepare("INSERT INTO messages(id,role,speaker,text,created_at) VALUES('u1','miyue','user','晚安 小薇','2026-10-27T15:19:18Z')").run();
  const morning = lastTalkFact(store, 'miyue', new Date('2026-10-28T00:00:00Z'));
  assert.equal(morning.at, '昨天 23:19'); assert.equal(morning.hisLastWords, '晚安 小薇'); assert.match(morning.note, /别说他昨天一直没出现/);
  store.db.prepare("INSERT INTO messages(id,role,speaker,text,created_at) VALUES('u2','miyue','user','早','2026-10-28T01:00:00Z')").run();
  assert.equal(lastTalkFact(store, 'miyue', new Date('2026-10-28T02:00:00Z')), null, 'he already spoke today');
});

test('a joke he has had enough of is put away, and the record says plainly who 她 and 他 are', () => {
  const store = memoryStore(); const now = NOW;
  const ledger = new RelationshipLedger(store, { model: {}, clock: () => now, enabled: true });
  ledger.apply('miyue', { jokes: [{ op: 'add', text: '存档搁你这儿', meaning: '记忆在他那', evidence: ['m1'] }] }, ids, { now });
  assert.match(ledger.stableContext('miyue', { now }), /“她”就是你晓薇，“他”是阿闫/);
  const id = ledger.list('miyue', { kind: 'joke' })[0].id;
  ledger.apply('miyue', { jokes: [{ op: 'retire', id, evidence: ['m1'] }] }, ids, { now });
  assert.doesNotMatch(ledger.stableContext('miyue', { now }), /存档搁你这儿/);
});
