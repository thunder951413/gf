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
  markdownReport,
  modelRequestedSkip,
  parseArgs,
  shouldExerciseAction,
  summarizeAcceptance,
  validateSuite,
} from '../scripts/evaluate-session-dialogue.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('fixture contains ten isolated stateful trajectories with only explicit user actions after seeding', () => {
  const suite = loadSuite();
  assert.equal(suite.scenarios.length, 10);
  assert.deepEqual(new Set(suite.scenarios.flatMap(row => row.actions.map(action => action.type))), new Set(['chat', 'proactive', 'desktop']));
  for (const scenario of suite.scenarios) {
    assert.ok(scenario.actions.length >= 1);
    assert.ok(scenario.reviewFocus.length >= 1);
    assert.ok(scenario.actions.every(action => action.type !== 'chat' || typeof action.text === 'string'));
    assert.ok(scenario.actions.every(action => !Object.hasOwn(action, 'assistant') && !Object.hasOwn(action, 'reply')),
      'later assistant history must come from the application, not a canned fixture');
  }
  assert.ok(suite.scenarios.find(row => row.id === 'proactive-continuation')?.actions.some(row => row.type === 'proactive'));
  assert.equal(suite.scenarios.find(row => row.id === 'proactive-continuation')?.actions[1].requiresPreviousDelivery, true);
  assert.ok(suite.scenarios.find(row => row.id === 'desktop-invitation-continuation')?.actions.some(row => row.type === 'desktop'));
  assert.deepEqual(suite.scenarios.find(row => row.id === 'reminder-create-update-cancel')?.actions.map(row => row.expectReminder), ['create', 'update', 'cancel']);
});

test('long-history topic-origin regression preserves role ownership without canned later replies', () => {
  const scenario = loadSuite().scenarios.find(row => row.id === 'assistant-topic-origin-long-history');
  assert.ok(scenario);
  assert.ok(scenario.seed.history.length >= 10, 'regression should exercise a noisy multi-day history');
  assert.ok(new Set(scenario.seed.history.map(row => row.createdAt.slice(0, 10))).size >= 5,
    'seed should span unrelated exchanges on several days');

  const opening = scenario.seed.history.at(-1);
  assert.equal(opening.speaker, 'assistant');
  assert.equal(opening.kind, 'proactive');
  assert.match(opening.text, /白矮星/);
  assert.match(opening.text, /想听吗/);
  assert.deepEqual(scenario.seed.history.filter(row => row.text.includes('白矮星')).map(row => row.speaker), ['assistant'],
    'the assistant must own the first white-dwarf mention');

  assert.deepEqual(scenario.actions.map(row => row.type), ['chat', 'chat', 'chat']);
  assert.match(scenario.actions[0].text, /中子星.*红巨星.*黑矮星/);
  assert.equal(scenario.actions[1].text, '刚才白矮星是谁先提的？');
  assert.match(scenario.actions[2].text, /白矮星和黑矮星是什么关系/);
  assert.ok(scenario.actions.every(action => !Object.hasOwn(action, 'assistant') && !Object.hasOwn(action, 'reply')),
    'post-seed assistant replies must be generated and then carried forward through native history');
  assert.deepEqual(scenario.actions.map(action => Object.keys(action).sort()), [
    ['text', 'type'],
    ['advanceMinutes', 'text', 'type'],
    ['advanceMinutes', 'text', 'type'],
  ], 'actions contain only user input and trajectory timing');

  const oldTopics = scenario.seed.history.slice(0, -1).map(row => row.text).join('\n');
  assert.match(oldTopics, /午饭|中午/);
  assert.match(oldTopics, /坐姿|肩膀/);
});

test('validation rejects duplicate ids and every form of canned assistant output', () => {
  const suite = structuredClone(loadSuite());
  suite.scenarios[1].id = suite.scenarios[0].id;
  assert.throws(() => validateSuite(suite), /duplicate scenario id/);
  const second = structuredClone(loadSuite());
  second.scenarios.find(row => row.id === 'proactive-continuation').actions[0].text = 'canned output';
  assert.throws(() => validateSuite(second), /only chat actions/);
  const third = structuredClone(loadSuite());
  third.scenarios.find(row => row.id === 'assistant-topic-origin-long-history').actions[1].reply = '我是先提到的。';
  assert.throws(() => validateSuite(third), /cannot contain canned assistant replies/);
  const fourth = structuredClone(loadSuite());
  fourth.scenarios[0].seed.history.push({ id: 'bad-kind', speaker: 'user', kind: 'proactive', text: '伪造主动消息', createdAt: '2026-09-01T00:00:00Z' });
  assert.throws(() => validateSuite(fourth), /invalid seed history kind/);
  const fifth = structuredClone(loadSuite());
  fifth.scenarios[0].actions[0].requiresPreviousDelivery = true;
  assert.throws(() => validateSuite(fifth), /first action cannot require/);
  const sixth = structuredClone(loadSuite());
  sixth.scenarios[0].actions[1].requiresPreviousDelivery = 'yes';
  assert.throws(() => validateSuite(sixth), /requiresPreviousDelivery must be boolean/);
});

test('dependent action is not exercised after a proactive skip and transcript never presents its input as sent', () => {
  const dependent = { type: 'chat', text: '接着聊刚才那个。', requiresPreviousDelivery: true };
  assert.equal(shouldExerciseAction(dependent, { outcome: 'model_skip' }), false);
  assert.equal(shouldExerciseAction(dependent, { outcome: 'delivered' }), true);
  assert.equal(shouldExerciseAction({ type: 'chat', text: '独立问题。' }, { outcome: 'model_skip' }), true);

  const reviewerLimitation = 'Turn 2 was not exercised because its required previous turn did not deliver. The planned input was not sent, no model call was made, and this turn cannot be reviewed.';
  const transcript = markdownReport({
    suiteVersion: 'fixture', label: 'skip-case', provider: { model: 'fixture' },
    scenarios: [{ title: 'Skipped dependency', reviewFocus: [], runs: [{ blindLabel: 'A', actions: [{
      index: 2, type: 'chat', input: null, plannedInput: dependent.text, outcome: 'not_exercised',
      reviewerLimitation, modelCalls: 0, modelCallKinds: {}, nativeHistory: { beforeCount: 1, afterCount: 1, appended: [] }, durationMs: 0,
    }] }] }],
    budget: { calls: 0, requestBytes: 0, reservedTokens: 0, reportedInputTokens: 0, reportedOutputTokens: 0, limits: { maxCalls: 1, maxWireBytes: 1, maxTokens: 1 } },
  });
  assert.match(transcript, /Planned dependent user input \(not sent\): 接着聊刚才那个。/);
  assert.match(transcript, /Outcome: not exercised/);
  assert.match(transcript, /Reviewer limitation: .*no model call was made/);
  assert.match(transcript, /Mechanism: 0 model calls; native history 1 → 1/);
  assert.doesNotMatch(transcript, /^User: 接着聊刚才那个。$/mu);
});

test('CLI planning supports staged variants and rejects budgets before any live run', () => {
  const suite = loadSuite();
  const options = parseArgs(['--variant', 'session', '--scenario', 'identity-origin-return']);
  const plan = buildPlan(suite, options);
  assert.deepEqual(plan.variants, ['session']);
  assert.deepEqual(plan.scenarios.map(row => row.id), ['identity-origin-return']);
  assert.equal(plan.planningEstimate.nominalCalls, 12);
  assert.throws(() => buildPlan(suite, { ...options, limits: { ...DEFAULT_LIMITS, maxCalls: 5 } }), /exceeds --max-calls/);
  assert.throws(() => parseArgs(['--live']), /requires a unique --label/);
  assert.throws(() => parseArgs(['--variant', 'candidate']), /session, legacy, or both/);
  assert.equal(parseArgs(['--json-only']).jsonOnly, true);
  assert.equal(parseArgs(['--review-file', 'report.json']).reviewFile, 'report.json');
  assert.throws(() => parseArgs(['--review-file', 'report.json', '--live', '--label', 'test']), /cannot be combined/);
  assert.throws(() => parseArgs(['--review-file', 'report.json', '--scenario', 'test']), /run selection/);
});

test('hard budget reserves calls, tokens, per-request bytes, and aggregate bytes before transport', () => {
  const budget = new HardBudget({ maxCalls: 2, maxTokens: 200, maxRequestBytes: 200, maxWireBytes: 300 });
  const payload = { max_tokens: 20, messages: [{ role: 'user', content: 'a'.repeat(20) }] };
  const reservedTokens = Buffer.byteLength(JSON.stringify(payload.messages), 'utf8') + 20;
  assert.deepEqual(budget.reserve(payload, 100), { call: 1, bytes: 100, reservedTokens });
  budget.observeUsage({ prompt_tokens: 7, completion_tokens: 3 });
  assert.equal(budget.snapshot().reportedInputTokens, 7);
  budget.observeUsage({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 8 } });
  assert.equal(budget.snapshot().cachedInputTokens, 8);
  budget.observeUsage(null);
  budget.observeUsage({ prompt_tokens: 'unknown', completion_tokens: -3 });
  assert.equal(budget.snapshot().reportedInputTokens, 17);
  assert.equal(budget.snapshot().reportedOutputTokens, 3);
  assert.throws(() => budget.reserve(payload, 201), /max-request-bytes/);
  budget.reserve(payload, 100);
  assert.throws(() => budget.reserve(payload, 1), /call budget/);
});

function reviewedReport() {
  const action = { index: 1, status: 200, outcome: 'delivered', input: '刚才是谁提的？', reply: '是我先提起的。', nativeHistory: { appended: [{ speaker: 'assistant', text: '是我先提起的。' }] } };
  const dimension = () => ({ verdict: 'pass', evidence: [{ turn: 1, quote: '是我先提起的。', reason: '与原始历史中的发起者一致。' }] });
  return { expectedRuns: 1, scenarios: [{ id: 'origin', runs: [{ blindLabel: 'A', expectedActionCount: 1, actions: [action], review: { originalTurnsRead: true, continuity: dimension(), factualGrounding: dimension(), naturalness: dimension() } }] }] };
}

test('acceptance requires complete delivery, native storage, and quoted review evidence', () => {
  assert.equal(summarizeAcceptance(reviewedReport()).status, 'accepted');
  const pending = reviewedReport();
  pending.scenarios[0].runs[0].review.originalTurnsRead = false;
  assert.equal(summarizeAcceptance(pending).status, 'pending-review');
  const unsupported = reviewedReport();
  unsupported.scenarios[0].runs[0].review.naturalness.evidence[0].quote = '没有出现过的评价';
  assert.equal(summarizeAcceptance(unsupported).status, 'pending-review');
  const skipped = reviewedReport();
  skipped.scenarios[0].runs[0].actions[0].outcome = 'not_exercised';
  assert.equal(summarizeAcceptance(skipped).status, 'incomplete');
  skipped.scenarios[0].runs[0].actions[0].outcome = 'policy_skip';
  assert.equal(summarizeAcceptance(skipped).status, 'incomplete');
  const missing = reviewedReport();
  missing.scenarios[0].runs[0].expectedActionCount = 2;
  assert.equal(summarizeAcceptance(missing).status, 'incomplete');
  const missingRun = reviewedReport();
  missingRun.expectedRuns = 2;
  assert.equal(summarizeAcceptance(missingRun).status, 'incomplete');
  const storage = reviewedReport();
  storage.scenarios[0].runs[0].actions[0].nativeHistory.appended[0].text = '被覆盖的回复';
  assert.equal(summarizeAcceptance(storage).status, 'failed');
  const reminder = reviewedReport();
  reminder.scenarios[0].runs[0].actions[0].reminderState = { expected: 'update', pass: false };
  assert.equal(summarizeAcceptance(reminder).status, 'failed');
  const quality = reviewedReport();
  quality.scenarios[0].runs[0].review.continuity.verdict = 'fail';
  assert.equal(summarizeAcceptance(quality).status, 'failed');
});

test('mechanism observations distinguish semantic, proactive, repair, and ordinary chat calls', () => {
  const body = content => ({ messages: [{ role: 'system', content }] });
  assert.equal(classifyModelCall(body('Classify the current Chinese companion-dialogue turn.')), 'semantic');
  assert.equal(classifyModelCall(body('决定是否主动发起一次联系')), 'proactive');
  assert.equal(classifyModelCall(body('你只判断一段对话现在能否另起话题')), 'proactive-continuity');
  assert.equal(classifyModelCall(body('【本轮提示生成】\n{"type":"scheduled_opportunity"}')), 'session-guidance');
  assert.equal(classifyModelCall(body('【本轮草稿检查】')), 'session-review');
  assert.equal(classifyModelCall(body('【本轮模型修改意见】')), 'session-revision');
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
