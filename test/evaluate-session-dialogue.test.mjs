import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_LIMITS,
  HardBudget,
  buildPlan,
  classifyModelCall,
  compareReminderTransition,
  loadSuite,
  modelRequestedSkip,
  parseArgs,
  validateSuite,
} from '../scripts/evaluate-session-dialogue.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('fixture contains nine isolated stateful trajectories with only explicit user actions after seeding', () => {
  const suite = loadSuite();
  assert.equal(suite.scenarios.length, 9);
  assert.deepEqual(new Set(suite.scenarios.flatMap(row => row.actions.map(action => action.type))), new Set(['chat', 'proactive', 'desktop']));
  for (const scenario of suite.scenarios) {
    assert.ok(scenario.actions.length >= 1);
    assert.ok(scenario.reviewFocus.length >= 1);
    assert.ok(scenario.actions.every(action => action.type !== 'chat' || typeof action.text === 'string'));
    assert.ok(scenario.actions.every(action => !Object.hasOwn(action, 'assistant') && !Object.hasOwn(action, 'reply')),
      'later assistant history must come from the application, not a canned fixture');
  }
  assert.ok(suite.scenarios.find(row => row.id === 'proactive-continuation')?.actions.some(row => row.type === 'proactive'));
  assert.ok(suite.scenarios.find(row => row.id === 'desktop-invitation-continuation')?.actions.some(row => row.type === 'desktop'));
  assert.deepEqual(suite.scenarios.find(row => row.id === 'reminder-create-update-cancel')?.actions.map(row => row.expectReminder), ['create', 'update', 'cancel']);
});

test('validation rejects duplicate ids and assistant text smuggled into non-chat actions', () => {
  const suite = structuredClone(loadSuite());
  suite.scenarios[1].id = suite.scenarios[0].id;
  assert.throws(() => validateSuite(suite), /duplicate scenario id/);
  const second = structuredClone(loadSuite());
  second.scenarios.find(row => row.id === 'proactive-continuation').actions[0].text = 'canned output';
  assert.throws(() => validateSuite(second), /only chat actions/);
});

test('CLI planning supports staged variants and rejects budgets before any live run', () => {
  const suite = loadSuite();
  const options = parseArgs(['--variant', 'session', '--scenario', 'identity-origin-return']);
  const plan = buildPlan(suite, options);
  assert.deepEqual(plan.variants, ['session']);
  assert.deepEqual(plan.scenarios.map(row => row.id), ['identity-origin-return']);
  assert.equal(plan.planningEstimate.nominalCalls, 6);
  assert.throws(() => buildPlan(suite, { ...options, limits: { ...DEFAULT_LIMITS, maxCalls: 5 } }), /exceeds --max-calls/);
  assert.throws(() => parseArgs(['--live']), /requires a unique --label/);
  assert.throws(() => parseArgs(['--variant', 'candidate']), /session, legacy, or both/);
});

test('hard budget reserves calls, tokens, per-request bytes, and aggregate bytes before transport', () => {
  const budget = new HardBudget({ maxCalls: 2, maxTokens: 200, maxRequestBytes: 200, maxWireBytes: 300 });
  const payload = { max_tokens: 20, messages: [{ role: 'user', content: 'a'.repeat(20) }] };
  const reservedTokens = Buffer.byteLength(JSON.stringify(payload.messages), 'utf8') + 20;
  assert.deepEqual(budget.reserve(payload, 100), { call: 1, bytes: 100, reservedTokens });
  budget.observeUsage({ prompt_tokens: 7, completion_tokens: 3 });
  assert.equal(budget.snapshot().reportedInputTokens, 7);
  assert.throws(() => budget.reserve(payload, 201), /max-request-bytes/);
  budget.reserve(payload, 100);
  assert.throws(() => budget.reserve(payload, 1), /call budget/);
});

test('mechanism observations distinguish semantic, proactive, repair, and ordinary chat calls', () => {
  const body = content => ({ messages: [{ role: 'system', content }] });
  assert.equal(classifyModelCall(body('Classify the current Chinese companion-dialogue turn.')), 'semantic');
  assert.equal(classifyModelCall(body('决定是否主动发起一次联系')), 'proactive');
  assert.equal(classifyModelCall(body('【外部工具回执｜recall】\n{"type":"scheduled_opportunity"}')), 'tool-followup');
  assert.equal(classifyModelCall(body('上一份草稿需要改正；这是唯一一次修复。')), 'repair');
  assert.equal(classifyModelCall(body('请自然回应用户。')), 'chat');
});

test('intentional proactive skips and reminder state transitions are structural observations', () => {
  const row = content => ({ response: { body: { choices: [{ message: { content } }] } } });
  assert.equal(modelRequestedSkip([row('{"skip":true,"message":"","reason":"现在没有自然切口","contentId":null}')]), true);
  assert.equal(modelRequestedSkip([row('{"skip":false,"message":"想聊聊","reason":"有话想说","contentId":null}')]), false);
  const before = [{ id: 'r1', role: 'miyue', text: '浇水', dueAt: '2026-09-23T01:30:00.000Z', status: 'pending' }];
  const updated = [{ ...before[0], dueAt: '2026-09-23T02:00:00.000Z' }];
  assert.equal(compareReminderTransition('create', [], before).pass, true);
  assert.equal(compareReminderTransition('update', before, updated).pass, true);
  assert.equal(compareReminderTransition('cancel', updated, []).pass, true);
  assert.equal(compareReminderTransition('update', before, before).pass, false);
});

test('default invocation is a config-free, network-free dry run', () => {
  const output = execFileSync(process.execPath, ['scripts/evaluate-session-dialogue.mjs', '--variant', 'legacy', '--scenario', 'temporal-plan-unknown-outcome'], { cwd: root, encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.networkCalls, 0);
  assert.equal(result.providerConfigRead, false);
  assert.deepEqual(result.variants, ['legacy']);
  assert.deepEqual(result.scenarios, ['temporal-plan-unknown-outcome']);
  assert.equal(fs.existsSync(path.join(root, '.runtime', 'session-eval', 'temporal-plan-unknown-outcome')), false);
});
