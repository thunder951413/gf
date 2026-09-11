import test from 'node:test';
import assert from 'node:assert/strict';
import { focusLifeEvents, lifeEventTurnContext, lifeEventReplyIssues } from '../lib/life-event-turn.mjs';

const shirt = (phase = 'waiting') => ({ id: 'shirt', kind: 'shopping', title: '挑一件亚麻衬衫', phase, phaseLabel: phase === 'waiting' ? '等送达' : phase, detail: '下单的浅蓝亚麻衬衫已经出库，物流还在路上。', startedAt: '2026-09-06T02:00:00.000Z', choice: { selected: '浅蓝', options: ['米白', '浅蓝'], editable: false, adopted: true, evidence: '我想要浅蓝' } });
const mug = { id: 'mug', kind: 'shopping', title: '挑一只手作马克杯', phase: 'browsing', phaseLabel: '在挑选', detail: '正在比较釉色。', startedAt: '2026-09-06T02:00:00.000Z', foreground: true, choice: { selected: '雾蓝釉', options: ['雾蓝釉', '奶油白釉'], editable: true } };

test('focus follows the current matching object and does not turn old historical work into a daily topic', () => {
  assert.deepEqual(focusLifeEvents({ events: [shirt(), mug] }, { text: '那件衬衫物流到哪了？' }).map(e => e.id), ['shirt']);
  assert.deepEqual(focusLifeEvents({ events: [shirt(), mug] }, { text: '我以前工作时买过一件衬衫' }), [], 'historical user work is not a generic follow-up');
  assert.deepEqual(focusLifeEvents({ events: [shirt(), mug] }, { text: '怎么样？', conversation: [{ speaker: 'assistant', text: '那只马克杯还在挑釉色。' }] }).map(e => e.id), ['mug']);
  assert.equal(focusLifeEvents({ events: [shirt(), mug] }, { text: '今天开会很累', conversation: [{ speaker: 'assistant', text: '那件衬衫已经出库。' }] }).length, 0, 'a current work topic is not a generic event follow-up');
  assert.equal(focusLifeEvents({ events: [shirt(), mug] }, { opening: true }).length, 2);
});

test('context makes the current phase and locked choice authoritative without exposing fields', () => {
  const context = lifeEventTurnContext([shirt()]);
  assert.match(context, /等送达/); assert.match(context, /已选浅蓝，当前阶段不能改动/); assert.match(context, /此前确认：“我想要浅蓝”/); assert.match(context, /旧聊天只表示当时/); assert.match(context, /没有相关话题时不主动/);
  assert.ok(context.length <= 700); assert.doesNotMatch(context, /userMessageId|editable|adopted/);
});

test('reply checks reject the observed stale phase and locked-choice failures', () => {
  assert.deepEqual(lifeEventReplyIssues('那件衬衫还没下单。', [shirt()]), ['shopping_waiting_claims_wrong_state']);
  assert.deepEqual(lifeEventReplyIssues('那就算米白吧，我按米白下单。', [shirt()]), ['shopping_locked_choice_contradiction']);
  assert.ok(lifeEventReplyIssues('这件浅蓝已经收到。', [{ ...shirt('arrived'), phaseLabel: '刚收到' }]).length === 0);
  assert.ok(lifeEventReplyIssues('挑选时还没下单。', [mug]).length === 0);
  assert.ok(lifeEventReplyIssues('如果下次买衬衫，我会考虑米白。', [shirt()]).length === 0);
  assert.ok(lifeEventReplyIssues('上次你建议米白，我记得。', [shirt()]).length === 0);
  assert.ok(lifeEventReplyIssues('还没收到，物流还在路上。', [shirt()]).length === 0);
  assert.deepEqual(lifeEventReplyIssues('如果下次买米白也不错。现在已经收到。', [shirt()]), ['shopping_waiting_claims_wrong_state']);
  assert.deepEqual(lifeEventReplyIssues('上次你说米白。现在米白下单。', [shirt()]), ['shopping_locked_choice_contradiction']);
  assert.ok(lifeEventReplyIssues('那篇文章还在路上。', [{ ...shirt('waiting'), source: { url: 'https://example.com' }, origin: 'subscription' }]).length === 0);
});

test('physical phase contradictions are limited to their matching shopping phase', () => {
  assert.deepEqual(lifeEventReplyIssues('已经下单了。', [mug]), ['shopping_browsing_claims_completed']);
  assert.deepEqual(lifeEventReplyIssues('包裹还在路上。', [{ ...shirt('arrived'), phaseLabel: '刚收到' }]), ['shopping_arrived_claims_in_transit']);
  assert.deepEqual(lifeEventReplyIssues('刚下完单，人还在原地坐了一会儿。',[mug]),['shopping_browsing_claims_completed']);
  assert.deepEqual(lifeEventReplyIssues('昨天下午刚拿到。',[shirt('arrived')],{now:'2026-09-06T03:00:00Z'}),['shopping_arrival_date_contradiction']);
  assert.deepEqual(lifeEventReplyIssues('昨天还没收到，今天到了。',[shirt('arrived')],{now:'2026-09-06T03:00:00Z'}),[]);
});
