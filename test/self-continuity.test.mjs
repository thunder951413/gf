import test from 'node:test';
import assert from 'node:assert/strict';
import { selfContinuityIssues, selfContinuityPlan } from '../lib/self-continuity.mjs';

const now = new Date('2026-09-11T03:00:00.000Z');
const assistant = (id, text, createdAt = '2026-09-11T01:00:00.000Z') => ({ id, speaker: 'assistant', text, createdAt });
const user = (id, text, createdAt = '2026-09-11T01:01:00.000Z') => ({ id, speaker: 'user', text, createdAt });

test('keeps an explicit completed own work statement with bounded source evidence', () => {
  const plan = selfContinuityPlan({ conversation: [assistant('done', '我这边稿子最后一点弄完，客户回了没问题。')], now });
  assert.equal(plan.completed.length, 1);
  assert.equal(plan.completed[0].topic, 'work');
  assert.equal(plan.completed[0].sourceId, 'done');
  assert.match(plan.context, /已分享的本人近况/);
  assert.equal(plan.context.length <= 600, true);
});

test('unrelated absence and a planned next activity do not erase an actual completed draft',()=>{
  const plan=selfContinuityPlan({conversation:[assistant('mixed','微信里没有同事群。我这边稿子收了尾，正准备歇一会儿。')],now});
  assert.equal(plan.completed[0]?.topic,'work');
  assert.deepEqual(selfContinuityIssues('那版稿子还剩一点收尾。',plan),['completed_work_regression']);
  assert.doesNotMatch(plan.completed[0].text,/同事群|准备/);
});

test('does not treat negated or merely pending work as completed', () => {
  const plan = selfContinuityPlan({ conversation: [
    assistant('pending', '我这边稿子还差最后一点收尾。'),
    assistant('future', '我准备把那版包装稿弄完。'),
  ], now });
  assert.deepEqual(plan.completed, []);
});

test('does not attribute a user statement or a quote to the companion', () => {
  const plan = selfContinuityPlan({ conversation: [
    user('user-done', '我把稿子弄完了。'),
    assistant('quote', '你说“我这边稿子最后一点弄完了”，听起来很轻松。'),
  ], now });
  assert.deepEqual(plan.completed, []);
});

test('only flags an unambiguously same-work regression and permits new work or revisions', () => {
  const plan = selfContinuityPlan({ conversation: [assistant('done', '我这边稿子最后一点弄完，客户回了没问题。')], now });
  assert.deepEqual(selfContinuityIssues('那版稿子还差最后一点收尾。', plan), ['completed_work_regression']);
  assert.deepEqual(selfContinuityIssues('新一版稿子还差最后一点收尾。', plan), []);
  assert.deepEqual(selfContinuityIssues('客户又让我改那版稿子，还差最后一点收尾。', plan), []);
  assert.deepEqual(selfContinuityIssues('我今天在工作。', plan), []);
});

test('limits scan to the newest 24 assistant rows inside 36 hours', () => {
  const old = assistant('old', '我这边稿子最后一点弄完，客户回了没问题。', '2026-09-09T00:00:00.000Z');
  const rows = Array.from({ length: 25 }, (_, index) => assistant(`r${index}`, '我在整理桌子。'));
  const plan = selfContinuityPlan({ conversation: [old, ...rows], now });
  assert.deepEqual(plan.completed, []);
});
