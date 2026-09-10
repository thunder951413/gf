import test from 'node:test';
import assert from 'node:assert/strict';
import { ExperienceCycle } from './cycle.mjs';

export const plans = [{
  id: 'reading', title: '一周慢读', endsAt: '2026-09-08T00:00:00Z',
  phases: [
    { id: 'start', at: '2026-09-01T00:00:00Z', expiresAt: '2026-09-03T00:00:00Z', text: '刚读了开头。', details: ['第一天的具体细节'] },
    { id: 'middle', at: '2026-09-03T00:00:00Z', expiresAt: '2026-09-06T00:00:00Z', text: '读到了中段，有个想法变了。', details: ['和开头的差别', '让我改观的片段'] },
    { id: 'end', at: '2026-09-07T00:00:00Z', expiresAt: '2026-09-10T00:00:00Z', text: '这本读完了，留下一个疑问。', details: ['结尾的细节', '为什么没有简单结论'] },
  ],
}];
test('life reaches later stages without a single delivered message', () => {
  const cycle = new ExperienceCycle(plans);
  assert.equal(cycle.prepare('2026-09-04T00:00:00Z').id, 'middle');
  assert.equal(cycle.deliveries.size, 0);
  assert.equal(cycle.current('2026-09-09T00:00:00Z')[0].eventStatus, 'ended');
  assert.equal(cycle.prepare('2026-09-09T00:00:00Z').id, 'end');
});
test('prepared drafts are not delivery and retries do not consume twice', () => {
  const cycle = new ExperienceCycle(plans), now = '2026-09-01T12:00:00Z';
  const card = cycle.prepare(now);
  assert.deepEqual(cycle.prepare(now), card);
  assert.equal(cycle.commit(card, 'message1', now), true);
  assert.equal(cycle.commit(card, 'message1', now), true);
  assert.equal(cycle.commit(card, 'message2', now), false);
  assert.equal(cycle.deliveries.size, 1);
});
test('no response prevents repeated openers but does not freeze the event', () => {
  const cycle = new ExperienceCycle(plans), now = '2026-09-01T12:00:00Z';
  cycle.commit(cycle.prepare(now), 'message1', now);
  assert.equal(cycle.prepare('2026-09-04T00:00:00Z'), null);
  assert.equal(cycle.current('2026-09-04T00:00:00Z')[0].id, 'middle');
  cycle.replyTo('message1');
  assert.equal(cycle.prepare('2026-09-04T00:00:00Z').id, 'middle');
});
test('a reply recovers the particular shared material even after the event progresses', () => {
  const cycle = new ExperienceCycle(plans), now = '2026-09-01T12:00:00Z';
  cycle.commit(cycle.prepare(now), 'message1', now);
  cycle.current('2026-09-09T00:00:00Z');
  const material = cycle.replyTo('message1');
  assert.equal(material.id, 'start');
  assert.deepEqual(material.details, ['第一天的具体细节']);
  assert.equal(cycle.replyTo('unknown-message'), null);
});
test('quiet hours and expired material suppress contact without deleting history', () => {
  const cycle = new ExperienceCycle(plans);
  assert.equal(cycle.prepare('2026-09-04T00:00:00Z', { quiet: true }), null);
  assert.equal(cycle.prepare('2026-09-12T00:00:00Z'), null);
  assert.equal(cycle.current('2026-09-12T00:00:00Z')[0].id, 'end');
});
