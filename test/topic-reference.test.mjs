import assert from 'node:assert/strict';
import test from 'node:test';
import { referencedTopicHistory } from '../lib/topic-reference.mjs';

const row = (speaker, text, id) => ({ speaker, text, id });

test('finds an older topic despite different callback wording and preserves its following reply', () => {
  const history = [
    row('user', '人与人相处有误解时，我觉得应该解释清楚。', 'u-explain'),
    row('assistant', '因为你在意对方是否把你当成讲道理的人。', 'a-explain'),
    row('user', '午饭吃面还是米饭？', 'u-food'),
    row('assistant', '我会选面。', 'a-food'),
  ];
  const selected = referencedTopicHistory('刚才说到人和人之间的解释，你怎么看？', history);
  assert.deepEqual(selected.map(item => item.id), ['u-explain', 'a-explain']);
});

test('does not treat an innocuous use of 刚才 or an external quote as a past-topic callback', () => {
  const history = [row('user', '我刚才按摩了肩膀。', 'u'), row('assistant', '那先歇会。', 'a')];
  assert.deepEqual(referencedTopicHistory('我刚才按摩了，舒服多了。', history), []);
  assert.deepEqual(referencedTopicHistory('他说“刚才说到解释”，我觉得好笑。', history), []);
});

test('returns nothing for an explicit marker without a meaningful match', () => {
  const history = [row('user', '我喜欢骑车。', 'u-bike'), row('assistant', '风吹着会很舒服。', 'a-bike')];
  assert.deepEqual(referencedTopicHistory('之前聊到量子计算，你怎么看？', history), []);
  assert.deepEqual(referencedTopicHistory('上次提到那个，你怎么看？', history), []);
});

test('selects at most two complete user-plus-following-assistant exchanges in chronological order without mutating source rows', () => {
  const history = [
    row('user', '误解要解释，才能让人知道自己讲道理。', 'u-old'),
    row('assistant', '我也会把缘由说清。', 'a-old'),
    row('assistant', '不是为了争赢。', 'a-old-2'),
    row('user', '有误解时解释是为了继续相处。', 'u-new'),
    row('assistant', '这样对方才知道你的认真。', 'a-new'),
    row('user', '换个话题。', 'u-last'),
    row('assistant', '好。', 'a-last'),
  ];
  const before = structuredClone(history);
  const selected = referencedTopicHistory('之前聊到误解解释的事，你怎么看？', history);
  assert.deepEqual(selected.map(item => item.id), ['u-old', 'a-old', 'a-old-2', 'u-new', 'a-new']);
  assert.deepEqual(history, before);
  assert.equal(selected.every(item => history.includes(item)), true);
});
