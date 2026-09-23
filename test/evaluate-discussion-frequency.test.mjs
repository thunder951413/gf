import test from 'node:test';
import assert from 'node:assert/strict';
import { runExperiment } from '../scripts/evaluate-discussion-frequency.mjs';

test('discussion frequency experiment is reproducible and isolates expected opportunity changes',()=>{
  const first=runExperiment({samples:2000,seed:42}),second=runExperiment({samples:2000,seed:42});
  assert.deepEqual(first,second);assert.equal(first.passed,true);
  assert.ok(first.variants.wants_more.targetOpportunityShare>first.variants.no_feedback.targetOpportunityShare);
  assert.ok(first.variants.less.targetOpportunityShare<first.variants.no_feedback.targetOpportunityShare);
  assert.equal(first.variants.blocked.targetOpportunityShare,0);
  assert.ok(Object.values(first.variants.blocked.categoryOpportunityShares).some(value=>value>0));
  assert.match(first.interpretation,/not message sending frequency/);
});
