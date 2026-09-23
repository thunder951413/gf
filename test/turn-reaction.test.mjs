import assert from 'node:assert/strict';
import test from 'node:test';
import { previewTurnReaction } from '../lib/turn-reaction.mjs';

const trigger = { type: 'user_message' };
const memory = { selected: [{ id: 'm-1', kind: 'raw', subject: 'user', topic: '周末探望外婆', sourceIds: ['msg-7'], at: '2026-09-10T10:00:00Z', confidence: 'high' }] };

test('reaction is a bounded pure preview grounded in selected past evidence', () => {
  const state = { relationshipStage: 'friends', mood: 50 };
  const first = previewTurnReaction({ trigger, userText: '周末那件事我改到下周了。', memory, currentState: state });
  const retry = previewTurnReaction({ trigger, userText: '周末那件事我改到下周了。', memory, currentState: state });
  assert.deepEqual(retry, first);
  assert.equal(first.stateMutation, false);
  assert.equal(first.kind, 'memory_acknowledgement');
  assert.deepEqual(first.sourceIds, ['msg-7']);
  assert.match(first.context, /过去提到的现实/);
  assert.match(first.context, /非当前状态/);
  assert.equal(first.context.length <= 900, true);
  assert.deepEqual(state, { relationshipStage: 'friends', mood: 50 });
});

test('lost topic, ambiguity, boundaries, and non-user triggers do not resurrect memory', () => {
  for (const input of [
    { trigger, userText: '换个话题吧，今天吃什么？', memory },
    { trigger, userText: '那件事呢？', memory, semantic: { decision: { ambiguous: true } } },
    { trigger, userText: '别再提这件事。', memory },
    { trigger: { type: 'scheduled_opportunity' }, userText: '', memory },
    { trigger, userText: '今天吃什么？', memory, semantic: { decision: { topicSwitch: true }, evidence: '换个话题' } },
  ]) assert.deepEqual(previewTurnReaction(input), { kind: 'none', context: '', sourceIds: [], evidence: [], stateMutation: false });
});

test('fictional character history stays explicitly fictional and semantic evidence must be literal', () => {
  const result = previewTurnReaction({ trigger, userText: '你说的雨天我记得。', semantic: { evidence: '雨天', decision: { evidence: '不存在的话' } }, memory: { selected: [{ id: 'scene', kind: 'character_experience', subject: 'character', topic: '雨天等车', sourceIds: ['scene-2'], confidence: 'high' }] } });
  assert.match(result.context, /角色过去的虚构经历/);
  assert.match(result.context, /雨天/);
  assert.doesNotMatch(result.context, /不存在的话/);
});

test('a self-contained new update can use high-confidence past evidence without joy inference', () => {
  const result = previewTurnReaction({ trigger, userText: '结果终于出来了。', semantic: { decision: { continuity: 'new' } }, memory: { selected: [{ id: 'result', kind: 'consolidated', subject: 'user', topic: '资格考试结果', sourceIds: ['msg-result'], confidence: 'high' }] } });
  assert.equal(result.kind, 'memory_acknowledgement');
  assert.match(result.context, /资格考试结果/);
  assert.doesNotMatch(result.context, /开心|高兴|喜悦|关系|亲密|数值/);
});

test('ordinary content using “不想” is not mistaken for an interaction preference', () => {
  const result = previewTurnReaction({ trigger, userText: '我不想放弃，结果终于出来了。', memory: { selected: [{ id: 'result', kind: 'consolidated', subject: 'user', topic: '资格考试结果', sourceIds: ['msg-result'], confidence: 'high' }] } });
  assert.equal(result.kind, 'memory_acknowledgement');
});

test('represented high-confidence memory is usable without repeating its source material', () => {
  const result = previewTurnReaction({ trigger, userText: '结果终于出来了。', memory: { represented: [{ id: 'result', kind: 'consolidated', subject: 'user', topic: '资格考试结果', sourceIds: ['msg-result'], channels: { direct: 2 }, represented: true }] } });
  assert.match(result.context, /已在本轮材料中呈现，勿重复注入/);
});

test('shared episodes remain attributed conversation rather than user reality', () => {
  const result = previewTurnReaction({ trigger, userText: '那次之后我也想了很多。', memory: { selected: [{ id: 'shared', kind: 'episode', subject: 'shared', topic: '雨天等车', sourceIds: ['msg-user', 'msg-character'], confidence: 'high' }] } });
  assert.match(result.context, /已标注的对话记录/);
  assert.match(result.context, /不能把角色经历当作用户现实/);
  assert.doesNotMatch(result.context, /用户过去提到的现实/);
});

test('strong explicitly non-low-confidence semantic expansion can guide a preview, weak expansion cannot', () => {
  const base = { id: 'expanded', kind: 'consolidated', subject: 'user', topic: '资格考试结果', sourceIds: ['msg-result'], channels: { direct: 0, semantic: 1.2 }, lowConfidence: false };
  assert.equal(previewTurnReaction({ trigger, userText: '结果终于出来了。', memory: { selected: [base] } }).kind, 'memory_acknowledgement');
  assert.equal(previewTurnReaction({ trigger, userText: '结果终于出来了。', memory: { selected: [{ ...base, channels: { direct: 0, semantic: .5 } }] } }).kind, 'none');
});
