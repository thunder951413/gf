import test from 'node:test';
import assert from 'node:assert/strict';
import { AttentionMemory } from './retrieval.mjs';

const memories = () => [
  { id: 'dive-plan', topic: '潜水', text: '用户周五计划去南澳岛潜水。', born: 0, base: 12, mentions: [], exposures: [], type: 'user', keywords: ['南澳岛'] },
  { id: 'dive-feel', topic: '潜水', text: '用户说潜水像在天上飞，能俯瞰海洋。', born: 0, base: 9, mentions: [], exposures: [], type: 'user' },
  { id: 'dive-dup', topic: '潜水', text: '用户说潜水像在天上飞，能俯瞰海洋。', born: 0, base: 8, mentions: [], exposures: [], type: 'user' },
  { id: 'book', topic: '阅读', text: '最近读一本关于旧衣服的散文集。', born: 0, base: 11, mentions: [], exposures: [], type: 'life' },
  { id: 'phone', topic: '手机', text: '这部手机的屏幕颜色很自然。', born: 0, base: 10, mentions: [], exposures: [], type: 'source' },
  { id: 'fruit', topic: '水果', text: '苹果成熟后很好吃。', born: 0, base: 10, mentions: [], exposures: [], type: 'source' },
  { id: 'future', topic: '徒步', text: '下个月才会发生的徒步记录。', born: 20, base: 20, mentions: [], exposures: [], type: 'life' },
];

test('exports empty history behavior and does not mutate supplied inputs', () => {
  const source = memories(); const before = structuredClone(source);
  const store = new AttentionMemory({ memories: source });
  assert.deepEqual(store.select({ day: 0 }).selected, []);
  store.observeUser({ text: '潜水怎么样？', day: 0, turnId: 'u1' });
  store.select({ text: '潜水怎么样？', day: 0 });
  assert.deepEqual(source, before);
});

test('automatic Chinese lexical retrieval finds two complementary same-topic details, not duplicate', () => {
  const store = new AttentionMemory({ memories: memories() });
  store.observeUser({ text: '南澳岛潜水后来怎么样？', day: 1, turnId: 'u1' });
  const result = store.select({ day: 1 });
  assert.deepEqual(result.selected.map(x => x.id), ['dive-plan', 'dive-feel']);
  assert.equal(result.diagnostics.lexicalOnly, true);
  assert.equal(result.diagnostics.queryPreserved, '南澳岛潜水后来怎么样？');
});

test('mention bursts cap at event time, then decay after user stops', () => {
  const store = new AttentionMemory({ memories: memories(), halfLife: 3 });
  for (let i = 0; i < 100; i++) store.observeUser({ text: '说说潜水', day: 0, turnId: `u${i}` });
  const at0 = store.snapshot(0).memories.find(x => x.id === 'dive-plan').strength;
  const at3 = store.snapshot(3).memories.find(x => x.id === 'dive-plan').strength;
  const at60 = store.snapshot(60).memories.find(x => x.id === 'dive-plan').strength;
  assert.ok(at0 <= 42); assert.equal(at3, at0 / 2); assert.ok(at60 < 0.01);
});

test('assistant self mention does not reinforce and unsupported selection does not count as exposure', () => {
  const store = new AttentionMemory({ memories: memories() });
  const before = store.snapshot(0).memories.find(x => x.id === 'dive-plan').strength;
  const d = store.observeAssistant({ text: '我自己很喜欢潜水。', day: 0, turnId: 'a1', selectedIds: ['dive-plan'] });
  assert.equal(d.assessments[0].used, false);
  assert.equal(store.snapshot(0).memories.find(x => x.id === 'dive-plan').strength, before);
  assert.deepEqual(store.snapshot(0).memories.find(x => x.id === 'dive-plan').exposures, []);
});

test('negation is scoped and expires; explicit switch releases earlier focus', () => {
  const store = new AttentionMemory({ memories: memories() });
  store.observeUser({ text: '先别再提潜水了', day: 1, turnId: 'u1' });
  assert.ok(store.select({ day: 2, mode: 'proactive' }).selected.every(x => x.topic !== '潜水'));
  assert.ok(store.select({ text: '潜水', day: 2 }).selected.length > 0);
  assert.ok(store.select({ day: 5, mode: 'proactive' }).selected.some(x => x.topic === '潜水'));
  store.observeUser({ text: '换个话题，聊聊旧衣服的散文集', day: 6, turnId: 'u2' });
  const selected = store.select({ day: 6 }).selected.map(x => x.id);
  assert.ok(selected.includes('book')); assert.ok(!selected.includes('dive-plan'));
});

test('multi-clause negation suppresses only its clause and proactive does not reuse stale query', () => {
  const store = new AttentionMemory({ memories: memories() });
  store.observeUser({ text: '先不聊潜水，聊聊旧衣服的散文集', day: 1, turnId: 'u1' });
  const reply = store.select({ day: 1 }).selected.map(x => x.id);
  assert.ok(reply.includes('book')); assert.ok(!reply.includes('dive-plan'));
  const proactive = store.select({ day: 1, mode: 'proactive', maxItems: 5 });
  assert.ok(proactive.selected.every(x => x.topic !== '潜水'));
  assert.equal(proactive.diagnostics.queryPreserved, '');
});

test('pronoun followup uses bounded recent focus, then falls silent after long age', () => {
  const store = new AttentionMemory({ memories: memories() });
  store.observeUser({ text: '讲讲南澳岛潜水', day: 1, turnId: 'u1' });
  assert.ok(store.select({ text: '那个后来呢？', day: 2 }).selected.some(x => x.id === 'dive-plan'));
  assert.equal(store.select({ text: '那个后来呢？', day: 12 }).selected.length, 0);
});

test('an old lexically relevant memory is recalled, while future memory is excluded', () => {
  const store = new AttentionMemory({ memories: memories() });
  assert.ok(store.select({ text: '南澳岛潜水', day: 45 }).selected.some(x => x.id === 'dive-plan'));
  assert.equal(store.select({ text: '徒步记录', day: 10 }).selected.length, 0);
  assert.equal(store.snapshot(10).futureCount, 1);
});

test('one shared word fragment does not cause a longer-phrase false positive', () => {
  const store = new AttentionMemory({ memories: memories() });
  const ids = store.select({ text: '苹果手机电池续航', day: 1 }).selected.map(x => x.id);
  assert.ok(!ids.includes('fruit'));
});

test('character budget counts only whole selected records and never clips text', () => {
  const source = memories();
  const store = new AttentionMemory({ memories: source, maxChars: source[0].text.length + 1 });
  const result = store.select({ text: '南澳岛潜水', day: 1 });
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].text, source[0].text);
  assert.equal(result.diagnostics.selectedChars, source[0].text.length);
});

test('supported delivered detail records exposure and reduces proactive repetition', () => {
  const xs = [{ id: 'a', topic: '茶', text: '桂花乌龙带着淡淡茶香。', born: 0, base: 12, mentions: [], exposures: [], type: 'life' }, { id: 'b', topic: '散步', text: '散步时看见蓝色旧招牌。', born: 0, base: 11, mentions: [], exposures: [], type: 'life' }];
  const store = new AttentionMemory({ memories: xs, seed: 3 });
  const d = store.observeAssistant({ text: '桂花乌龙确实有淡淡茶香。', day: 0, turnId: 'a1', selectedIds: ['a'] });
  assert.equal(d.assessments[0].used, true);
  assert.deepEqual(store.snapshot(0).memories.find(x => x.id === 'a').exposures, [0]);
  assert.equal(store.select({ day: 0.1, mode: 'proactive', maxItems: 1 }).selected[0].id, 'b');
});

test('supported assistant use becomes bounded focus for a followup', () => {
  const store = new AttentionMemory({ memories: memories() });
  store.observeAssistant({ text: '南澳岛的周五潜水计划值得接着聊。', day: 1, turnId: 'a1', selectedIds: ['dive-plan'] });
  assert.ok(store.select({ text: '那件事呢？', day: 2 }).selected.some(x => x.id === 'dive-plan'));
});

test('fixed seed gives reproducible proactive near-top choice', () => {
  const xs = memories().slice(0, 5);
  const run = seed => new AttentionMemory({ memories: xs, seed }).select({ day: 0, mode: 'proactive', maxItems: 3 }).selected.map(x => x.id);
  assert.deepEqual(run(77), run(77));
});

test('raw user turns are dated, questions are not asserted, and current turn does not retrieve itself', () => {
  const store = new AttentionMemory();
  store.observeUser({ text: '周五真的要去南澳岛吗？', day: 4, turnId: 'u9' });
  assert.equal(store.select({ day: 4 }).selected.length, 0);
  const raw = store.snapshot(4).memories.find(x => x.recordKind === 'user_utterance');
  assert.equal(raw.text, '周五真的要去南澳岛吗？'); assert.equal(raw.born, 4); assert.equal(raw.asserted, false); assert.equal(raw.type, 'user');
});
