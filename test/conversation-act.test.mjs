import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { isAcknowledgement, isRecallRequest } from '../lib/conversation-act.mjs';
import { ConversationPolicyRepository } from '../lib/conversation-policy.mjs';

function policy(t) { const store = { db: new DatabaseSync(':memory:') }; t.after(() => store.db.close()); return new ConversationPolicyRepository(store); }

test('compound acknowledgements suppress follow-up questions without closing a conversation', t => {
  const repo = policy(t);
  assert.equal(isAcknowledgement('嗯嗯，知道了'), true);
  const acknowledgement = repo.plan('miyue', '嗯嗯，知道了');
  assert.equal(acknowledgement.intent, 'respond');
  assert.equal(acknowledgement.questionBudget, 0);
  assert.equal(repo.plan('miyue', '晚安。').intent, 'close');
});

test('an invitation to continue is not a simple acknowledgement and recall requests remain recognized', t => {
  const repo = policy(t);
  assert.equal(isAcknowledgement('好的你说吧'), false);
  assert.equal(repo.plan('miyue', '好的你说吧').questionBudget, 1);
  assert.equal(isRecallRequest('我上次说什么来着？'), true);
  assert.equal(isRecallRequest('我喜欢怎么喝咖啡来着'), true);
  assert.equal(isRecallRequest('今天就聊这个吧'), false);
});

test('practical requests to recall which item use the same recall route',()=>{
 for(const text of ['我周六要赶哪个车来着？','我定的哪班飞机来着','哪趟来着'])assert.equal(isRecallRequest(text),true);
});
