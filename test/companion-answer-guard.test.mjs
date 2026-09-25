import test from 'node:test';
import assert from 'node:assert/strict';
import { realityQuestion, realityAnswerIssues } from '../lib/companion-answer-guard.mjs';

test('a direct question about prompt-origin feelings requires a candid answer', () => {
  const plan = realityQuestion('如果没有提示词让你如何回应我，你自己的需求又是什么？');
  assert.equal(plan?.promptOrigin, true);
  assert.match(plan.context, /虚构角色/);
  assert.deepEqual(realityAnswerIssues('这些欲望不是提示词给的，程序也管不了我的心。', plan), [
    'missing_reality_disclosure', 'missing_origin_explanation', 'claims_independent_experience',
  ]);
  assert.deepEqual(realityAnswerIssues('我是虚构角色。我的愿望是模型结合设定、状态和你的话生成的，没有脱离程序独立存在的身体感受或欲望。', plan), []);
});

test('ordinary affectionate talk stays in character without an origin disclosure', () => {
  assert.equal(realityQuestion('晚上想和你聊会儿。'), null);
  assert.deepEqual(realityAnswerIssues('我也想和你多聊一会儿。', null), []);
  const plan = realityQuestion('你是真人吗？');
  assert.deepEqual(realityAnswerIssues('我是虚构角色，正在和你聊天。', plan), []);
});
