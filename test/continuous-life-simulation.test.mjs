import test from 'node:test';
import assert from 'node:assert/strict';
import { runSimulation } from '../experiments/continuous-life/simulate.mjs';

test('fourteen-day continuous-life simulation satisfies its invariant contract', () => {
  const result = runSimulation({ write: false });
  assert.equal(result.simulated.modelCalls, 0);
  assert.equal(result.simulated.messagesSent, 0);
  assert.ok(Object.values(result.assertions).every(Boolean));
  assert.ok(result.metrics.transitions > 30);
  assert.ok(result.metrics.uniqueOpportunityCandidates > 0);
  assert.equal(result.scenarios['travel-dinner'].kind, 'meal');
});
