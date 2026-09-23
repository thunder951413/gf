import test from 'node:test';
import assert from 'node:assert/strict';
import {
  needsContext,
  resolveNeeds,
  sensualDesireContext,
  sensualDesireLevel,
} from '../lib/companion-needs.mjs';
import { compactCompanionBackground } from '../lib/companion-context.mjs';
import { CompanionBehavior } from '../lib/companion-behavior.mjs';
import { TUNING_DEFAULTS } from '../lib/companion-tuning.mjs';

test('high desire is a persistent wish rather than a mandatory bodily narration', () => {
  const needs = resolveNeeds({ desire: 90, mode: 'warm' });
  assert.match(needs.physical, /刺激|发痒|腿间|抚摸/);
  assert.equal(sensualDesireLevel({ desire: 90, intimacyBoundary: 'open', needs }), 'high');
  assert.match(sensualDesireContext({ desire: 90, intimacyBoundary: 'open', relationshipStage: '恋爱中', needs }), /不要求每轮/);
  assert.match(needsContext(needs, { desire: 90, intimacyBoundary: 'open', relationshipStage: '恋爱中' }), /亲近愿望背景/);
});

test('friendly boundary and attentive mode suppress sensual prompting', () => {
  assert.equal(sensualDesireLevel({ desire: 99, intimacyBoundary: 'friendly', needs: { physical: '想被刺激' } }), 'suppressed');
  assert.equal(sensualDesireLevel({ desire: 99, mode: 'attentive', intimacyBoundary: 'open', needs: { physical: '想被刺激' } }), 'suppressed');
  assert.equal(sensualDesireContext({ desire: 20, intimacyBoundary: 'open', needs: { physical: '' } }), '');
});

test('background retains desire without requiring a physical reaction', () => {
  const text = compactCompanionBackground({
    now: new Date('2026-09-07T03:04:00Z'),
    narrative: true,
    world: {
      at: '2026-09-07T03:04:00Z', location: '苏州的家中', activity: '靠在沙发上发呆',
      person: { name: '林晓薇', age: 27 },
      body: { fatigue: 20, vitality: 70, affectionNeed: 40, desire: 88, affection: 80, mood: 70, stress: 20, security: 70, hunger: 30, playfulness: 60 },
      traits: { warmth: 80, coyness: 60, flirtation: 70, pleasing: 50, sensitivity: 60, optimism: 60, playfulness: 60, independence: 50 },
      needs: { emotional: '想听你说话', physical: '胸口和腿间有点痒，想被你轻轻刺激' },
      relationship: { intimacyBoundary: 'open', stage: '恋爱中', interactions: 20 },
      feelings: { feeling: '心里有点燥', wish: '想靠近' },
    },
    inner: { desire: 88, intimacyBoundary: 'open', relationshipStage: '恋爱中', mode: 'warm', needs: { emotional: '想听你说话', physical: '胸口和腿间有点痒，想被你轻轻刺激' } },
  });
  assert.match(text, /亲近愿望背景/);
  assert.match(text, /不要求每轮/);
});

test('high desire does not expand ordinary replies or impose bodily narration', () => {
  const planner = new CompanionBehavior({ db: { prepare: () => ({ get: () => ({ n: 8 }) }) } }, { get: () => ({ values: TUNING_DEFAULTS }) });
  const policy={ scope: 'miyue', intent: 'respond', maxChars: 100, questionBudget: 1 };
  for(const text of ['早上好喔','今天代码改完了','你喜欢逛小店吗？','好的。']) {
    const low=planner.plan(policy,text,{inner:{desire:0,intimacyBoundary:'open',needs:{physical:''}}});
    const high=planner.plan(policy,text,{inner:{desire:90,intimacyBoundary:'open',needs:{physical:'想抱着你'}}});
    assert.equal(high.behavior.sensualDesire,true);
    assert.equal(high.behavior.sensualBody,false,text);
    assert.equal(high.maxChars,low.maxChars,text);
    assert.equal(high.behavior.targetChars,low.behavior.targetChars,text);
    assert.doesNotMatch(planner.context(high),/自然写入具体身体感受|本轮身体亲近愿望偏高/);
  }
});

test('explicit affection stays welcome while distress and boundaries take priority', () => {
  const planner = new CompanionBehavior({ db: { prepare: () => ({ get: () => ({ n: 8 }) }) } }, { get: () => ({ values: TUNING_DEFAULTS }) });
  const options={inner:{desire:90,intimacyBoundary:'open',needs:{physical:'想抱着你'}}};
  const affectionate=planner.plan({maxChars:300},'想抱抱你',options);
  assert.equal(affectionate.behavior.sensualBody,true);
  assert.equal(affectionate.suppressInitiatedAffection,false);
  assert.match(planner.context(affectionate),/不需要额外描写身体反应/);
  for(const text of ['今天很累，哄哄我','今天别撒娇，就当普通朋友聊吧']) {
    assert.equal(planner.plan({maxChars:300},text,options).behavior.sensualBody,false);
  }
});
