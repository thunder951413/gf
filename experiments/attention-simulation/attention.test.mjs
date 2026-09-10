import test from 'node:test';
import assert from 'node:assert/strict';
import { salience, clippedSumScore, naiveScore, select, fixtures } from './attention.mjs';
const item = (changes = {}) => ({ id: 'x', topic: 'x', born: 0, base: 12, text: '记忆内容', mentions: [], ...changes });
test('base halves in three days; old records do not disappear from storage', () => {
  const x = item(); assert.equal(salience(x, 3), 6); assert.equal(salience(x, 6), 3); assert.equal(x.base, 12);
});
test('mentions decay independently and do not rejuvenate original timestamp', () => {
  const x = item({ mentions: [{ at: 3, who: 'user', turn: 'u1' }] });
  assert.equal(salience(x, 3), 16); assert.equal(salience(x, 6), 8); assert.equal(x.born, 0);
});
test('same turn repeated words do not multiply activation', () => {
  const m = { at: 0, who: 'user', turn: 'u1' };
  assert.equal(salience(item({ mentions: [m, m, m] }), 0), 22);
});
test('assistant self-mentions and negative user references do not reinforce', () => {
  assert.equal(salience(item({ mentions: [{ at: 0, who: 'assistant', turn: 'a1' }, { at: 0, who: 'user', negative: true, turn: 'u1' }] }), 0), 12);
});
test('one hundred affirmative mentions stay bounded and eventually fade', () => {
  const x = item({ mentions: Array.from({ length: 100 }, (_, i) => ({ at: 0, who: 'user', turn: `u${i}` })) });
  assert.equal(salience(x, 0), 42); assert.ok(salience(x, 60) < 5); assert.ok(naiveScore(x, 60) > 1e10);
});
test('discarded overflow avoids hidden boost plateau and halves after mentions stop', () => {
  const x = item({ mentions: Array.from({ length: 100 }, (_, i) => ({ at: 0, who: 'user', turn: `u${i}` })) });
  assert.equal(clippedSumScore(x, 3), 36);
  assert.equal(salience(x, 3), 21); assert.equal(salience(x, 3), salience(x, 0) / 2);
});
test('current topic wins; unrelated high ambient score is not stuffed in', () => {
  assert.deepEqual(select(fixtures, { day: 2, relevance: { sea: 1 } }).selected.map(x => x.id), ['dive']);
});
test('explicit topic switch releases previous focus', () => {
  assert.deepEqual(select(fixtures, { day: 2, relevance: { reading: 1 } }).selected.map(x => x.id), ['book']);
});
test('old relevant memory can return below proactive threshold', () => {
  assert.ok(salience(fixtures[0], 21) < 5);
  assert.equal(select(fixtures, { day: 21, relevance: { sea: 1 } }).selected[0].id, 'dive');
});
test('no relevant memory means empty selection; no minimum filler count', () => {
  assert.equal(select(fixtures, { day: 2 }).selected.length, 0);
  assert.equal(select(fixtures, { day: 40, mode: 'proactive' }).selected.length, 0);
});
test('blocked, superseded and future memories never enter focus', () => {
  const xs = [item({ id: 'future', born: 3 }), item({ id: 'superseded', superseded: true }), item()];
  assert.equal(select(xs, { day: 2, relevance: { x: 1 }, blockedTopics: ['x'] }).selected.length, 0);
  assert.deepEqual(select(xs, { day: 2, relevance: { x: 1 } }).selected.map(x => x.id), ['x']);
});
test('recently sent details excluded from proactive, but can answer user followup', () => {
  const x = item({ exposures: [0] });
  assert.equal(select([x], { day: 0.1, mode: 'proactive' }).selected.length, 0);
  assert.equal(select([x], { day: 0.1, relevance: { x: 1 } }).selected.length, 1);
});
test('one item per topic; item count and character budget respected', () => {
  const xs = [item(), item({ id: 'dup' }), item({ id: 'y', topic: 'y' })];
  assert.equal(select(xs, { day: 0, mode: 'proactive' }).selected.length, 2);
  assert.equal(select(xs, { day: 0, mode: 'proactive', charBudget: 4 }).selected.length, 1);
  assert.equal(select(xs, { day: 0, mode: 'proactive', maxItems: 1 }).selected.length, 1);
});
test('200 reproducible stress sequences: bounded, non-increasing after last mention, finally below threshold', () => {
  let seed = 123; const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 2 ** 32; };
  for (let run = 0; run < 200; run++) {
    const x = item({ mentions: Array.from({ length: Math.floor(random() * 200) }, (_, i) => ({ at: random() * 10, who: random() > 0.2 ? 'user' : 'assistant', turn: `u${i}` })) });
    let last = Infinity;
    for (let day = 10; day <= 100; day++) { const s = salience(x, day); assert.ok(s <= 42 && s <= last); last = s; }
    assert.ok(last < 5);
  }
});
