import test from 'node:test';
import assert from 'node:assert/strict';
import { topicSaturationPlan, topicSaturationIssues } from '../lib/topic-saturation.mjs';

const now = new Date('2026-09-28T12:00:00.000Z');
const assistant = text => ({ speaker: 'assistant', text, created_at: now.toISOString() });
const user = text => ({ speaker: 'user', text, created_at: now.toISOString() });

test('discovers an arbitrary recurring motif without a domain topic list', () => {
  const conversation = [
    assistant('窗台上的陶瓷小鹿被太阳照亮了。'), user('我到公司了。'),
    assistant('我又看见那只陶瓷小鹿，角上落了一点灰。'), user('午饭吃过了。'),
    assistant('刚才经过窗边，陶瓷小鹿还朝着门口。'), user('碗已经收好了。'),
  ];
  const plan = topicSaturationPlan({ conversation, userText: '碗已经收好了。', now });
  assert.ok(plan.topics.some(topic => topic.phrase.includes('陶瓷小鹿')));
  assert.deepEqual(topicSaturationIssues('那只陶瓷小鹿的事明天再说。', plan), ['saturated_topic_reuse']);
  assert.deepEqual(topicSaturationIssues('收好就过来坐吧。', plan), []);
});

test('user uptake keeps a recurring subject available', () => {
  const conversation = [
    assistant('窗台上的陶瓷小鹿被太阳照亮了。'), user('陶瓷小鹿是什么颜色？'),
    assistant('那只陶瓷小鹿是浅棕色。'), user('小鹿放在那里挺好。'),
    assistant('陶瓷小鹿还在窗边。'),
  ];
  const plan = topicSaturationPlan({ conversation, userText: '它的角是什么样？', now });
  assert.equal(plan.topics.some(topic => topic.phrase.includes('陶瓷小鹿')), false);
});

test('the current user message can reopen a cooled subject', () => {
  const history = [assistant('陶瓷小鹿在窗边。'), user('我出门了。'), assistant('陶瓷小鹿落灰了。'), user('我到公司了。'), assistant('陶瓷小鹿被挪了一点。')];
  const unrelated = topicSaturationPlan({ conversation: history, userText: '我洗好碗了。', now });
  assert.ok(unrelated.topics.some(topic => topic.phrase.includes('陶瓷小鹿')));
  const reopened = topicSaturationPlan({ conversation: history, userText: '窗边那只小鹿呢？', now });
  assert.equal(reopened.topics.some(topic => topic.phrase.includes('陶瓷小鹿')), false);
  const pronounFollowup = topicSaturationPlan({ conversation: history, userText: '那它后来呢？', focusText: '陶瓷小鹿被挪了一点。', now });
  assert.equal(pronounFollowup.topics.some(topic => topic.phrase.includes('陶瓷小鹿')), false);
});

test('one mention and stale repetition never enter cooldown', () => {
  const stale = new Date(+now - 49 * 60 * 60 * 1000).toISOString();
  const conversation = [
    { speaker: 'assistant', text: '陶瓷小鹿在窗边。', created_at: stale },
    user('早上好。'), assistant('陶瓷小鹿还在原处。'), user('中午好。'), assistant('今天只提到一次陶瓷小鹿。'),
  ];
  const plan = topicSaturationPlan({ conversation, userText: '说点别的。', now });
  assert.equal(plan.topics.some(topic => topic.phrase.includes('陶瓷小鹿')), false);
});
