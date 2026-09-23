import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationalSpace } from '../lib/conversational-space.mjs';

const semantic = (intent, extra = {}) => ({ intent, source: 'none', ...extra });
test('open exchanges and related updates leave different kinds of room', () => {
  assert.equal(conversationalSpace({ semantic: semantic('open') }).mode, 'open');
  assert.equal(conversationalSpace({ semantic: semantic('share') }).mode, 'open');
  assert.equal(conversationalSpace({ semantic: semantic('respond', { continuity: 'continue' }) }).mode, 'related');
  assert.equal(conversationalSpace({ semantic: semantic('acknowledge'), conversation: [{ speaker: 'assistant', text: '这件事让我想了很久。' }] }).mode, 'open');
});
test('an answer to her question and an active thread keep their focus', () => {
  assert.equal(conversationalSpace({ semantic: semantic('acknowledge'), conversation: [{ speaker: 'assistant', text: '你想听后面怎么做吗？' }] }), null);
  assert.equal(conversationalSpace({ semantic: semantic('acknowledge'), thread: { acceptsOffer: true } }), null);
  assert.equal(conversationalSpace({ semantic: semantic('acknowledge'), thread: { holdsTopic: true }, conversation: [{ speaker: 'assistant', text: '我觉得这个角度很有意思。' }] }).mode, 'open');
});
test('care, facts, correction, sources, and current-state requests protect the turn', () => {
  for (const intent of ['comfort', 'affection', 'boundary', 'preference', 'close', 'recall', 'answer']) assert.equal(conversationalSpace({ semantic: semantic(intent) }), null);
  for (const extra of [{ source: 'new' }, { correction: true }, { acceptsOffer: true }, { needsCurrentState: true }, { ownLife: true }, { advice: true }]) assert.equal(conversationalSpace({ semantic: semantic('respond', extra) }), null);
  assert.equal(conversationalSpace({ semantic: semantic('respond'), activeDiscussion: true }), null);
  assert.equal(conversationalSpace({ semantic: null }), null);
});
test('a recently introduced topic gets room to continue before another appears', () => {
  assert.equal(conversationalSpace({ semantic: semantic('open'), recentIntroduction: true }), null);
  assert.equal(conversationalSpace({ semantic: semantic('respond'), recentIntroduction: true }), null);
  assert.equal(conversationalSpace({ semantic: semantic('share'), recentIntroduction: true }).mode, 'open');
});
