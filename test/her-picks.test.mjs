import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DailyInformation } from '../lib/daily-information.mjs';
import { HerPicks, validPicks, HER_PICKS_INSTRUCTION } from '../lib/her-picks.mjs';
import { reviewRisk } from '../server.mjs';

const NOW = new Date('2026-10-27T01:00:00Z'); // 09:00 Shanghai
function memoryStore() {
  const db = new DatabaseSync(':memory:');
  return { db, getMessage: () => null, transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; } } };
}
const fakeModel = answer => { const calls = []; return { calls, publicConfig: () => ({ configured: true }), complete: async (messages, options) => { calls.push({ messages, options }); return JSON.stringify(typeof answer === 'function' ? answer(messages, options) : answer); } }; };
function information(store) {
  const sources = [{ id: 'tech', category: 'products', url: 'https://example.com/tech' }, { id: 'books', category: 'books', url: 'https://example.com/books' }, { id: 'food', category: 'food', url: 'https://example.com/food' }];
  const info = new DailyInformation(store, { sources, clock: () => NOW, enabled: false });
  info.ingest(sources[0], Array.from({ length: 30 }, (_, i) => ({ title: `新手机发布 第${i}款`, url: `https://example.com/p${i}`, summary: '参数', publishedAt: '2026-10-26T10:00:00Z' })));
  info.ingest(sources[1], [{ title: '汪曾祺散文新编出版', url: 'https://example.com/b1', summary: '收录未刊稿', publishedAt: '2026-10-20T10:00:00Z' }]);
  info.ingest(sources[2], [{ title: '秋天的桂花糖芋苗', url: 'https://example.com/f1', summary: '家常做法', publishedAt: '2026-10-25T10:00:00Z' }]);
  return info;
}

test('she goes through today\'s headlines with her own taste; a flood of one category cannot crowd out the rest', async () => {
  const store = memoryStore(), info = information(store);
  const book = info.list({ category: 'books' })[0], phone = info.list({ category: 'products' })[0];
  const model = fakeModel(messages => ({ picks: [
    { id: book.id, why: '大学在旧书摊买的第一本就是他的', take: '未刊稿会不会反而更像他本人', shared: '读书' },
    { id: phone.id, why: '想看看拍照有没有进步', take: '参数越来越像，样子却都一样', shared: '不存在的话题' },
    { id: 'made-up', why: 'x', take: 'y', shared: null },
  ] }));
  const picks = new HerPicks(store, { model, information: info, clock: () => NOW, gather: () => ({ world: '苏州设计师', tastes: ['汪曾祺'], shared: ['读书', 'AI'] }) });
  const candidates = picks.candidates();
  assert.equal(candidates.filter(item => item.category === 'products').length, 5, 'at most five per category');
  assert.ok(candidates.some(item => item.category === 'books') && candidates.some(item => item.category === 'food'));
  const result = await picks.ensure('miyue');
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.picks.map(pick => pick.id), [book.id, phone.id], 'ids that were not offered are dropped');
  assert.equal(result.picks[1].shared, null, 'only a real shared topic is kept');
  const input = JSON.parse(model.calls[0].messages[1].content);
  assert.deepEqual(input.shared, ['读书', 'AI']); assert.deepEqual(input.tastes, ['汪曾祺']);
  assert.match(HER_PICKS_INSTRUCTION, /不写“因为他喜欢”/);
  assert.equal((await picks.ensure('miyue')).reason, 'ready', 'once a day');
  const materials = picks.materials('miyue');
  assert.equal(materials[0].id, `daily-info:${book.id}`); assert.equal(materials[0].kind, 'daily_info');
  assert.deepEqual(materials[0].herAngle, { why: '大学在旧书摊买的第一本就是他的', take: '未刊稿会不会反而更像他本人', shared: '读书' });
  // Once she has told him, it is no longer on offer.
  store.getMessage = id => ({ id, role: 'miyue', text: '汪曾祺那本新编出了', createdAt: NOW.toISOString() });
  info.record({ id: 'r1', role: 'miyue', text: '汪曾祺那本新编出了', createdAt: NOW.toISOString() }, book.id);
  assert.deepEqual(picks.materials('miyue').map(item => item.id), [`daily-info:${phone.id}`]);
});

test('she does not pick before morning, and an empty feed is not counted as a failure', async () => {
  const store = memoryStore();
  const info = new DailyInformation(store, { sources: [], clock: () => NOW, enabled: false });
  const early = new HerPicks(store, { model: fakeModel({ picks: [] }), information: info, clock: () => new Date('2026-10-26T21:00:00Z') });
  assert.equal(early.due('miyue'), 'before-morning');
  const picks = new HerPicks(store, { model: fakeModel({ picks: [] }), information: info, clock: () => NOW });
  assert.equal((await picks.ensure('miyue')).reason, 'no-candidates');
  assert.equal(picks.due('miyue'), 'due');
  assert.deepEqual(validPicks({ picks: [{ id: 'a', why: '', take: 't' }] }, [{ id: 'a' }]), [], 'a pick needs her reason');
});

test('a fast turn is reviewed only for something the reviewer can check', () => {
  const context = { informationCandidates: [{ id: 'daily-info:abc' }] };
  const plain = { toolCalls: [], parsed: { reply: '嗯', informationId: null, dynamics: { needs: [], feelings: [] }, companionship: {} } };
  assert.deepEqual(reviewRisk(plain, { reviewEffort: 'fast' }, context), [], 'empty envelopes are not a reason');
  assert.deepEqual(reviewRisk({ ...plain, parsed: { ...plain.parsed, informationId: 'abc' } }, {}, context), ['information']);
  assert.deepEqual(reviewRisk({ ...plain, parsed: { ...plain.parsed, informationId: 'nope' } }, {}, context), [], 'an id that was never offered is not public evidence');
  assert.deepEqual(reviewRisk({ ...plain, toolCalls: [{ name: 'state' }] }, { catch: true }, context), ['tools', 'catch']);
  assert.deepEqual(reviewRisk({ ...plain, parsed: { dynamics: { needs: [{ id: 'n' }] } } }, {}, context), ['records']);
});
