import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fixtures, salience, clippedSumScore, naiveScore, select, defaults } from './attention.mjs';
const round = n => Math.round(n * 100) / 100;
const dive = fixtures[0];
const repeated = { ...dive, mentions: Array.from({ length: 20 }, (_, i) => ({ at: i / 20, who: 'user', turn: `u${i}` })) };
const timeline = [0, 1, 2, 3, 6, 9, 12, 21].map(day => ({ day, score: round(salience(dive, day)), proactiveEligible: salience(dive, day) >= defaults.threshold, selected: select(fixtures, { day, mode: 'proactive' }).selected.map(m => m.id) }));
const stress = [1, 7, 21, 42].map(day => ({ day, naive: round(naiveScore(repeated, day)), clippedSum: round(clippedSumScore(repeated, day)), bounded: round(salience(repeated, day)) }));
const scenarios = [
  { name: '正在聊潜水', day: 2, relevance: { sea: 1 }, activeTopic: 'sea' },
  { name: '接受她讲心事的邀请', day: 2, relevance: { design: 1 }, activeTopic: 'design' },
  { name: '明确换成读书话题', day: 2, relevance: { reading: 1 } },
  { name: '只想被陪着，不提供无关生活材料', day: 2, relevance: {} },
  { name: '二十一天后明确问起潜水', day: 21, relevance: { sea: 1 } },
  { name: '说不想再聊潜水', day: 2, relevance: { sea: 1 }, blockedTopics: ['sea'] },
  { name: '七天后主动分享新内容', day: 7, mode: 'proactive' },
  { name: '长期无新增内容', day: 40, mode: 'proactive' },
].map(s => ({ ...s, selected: select(fixtures, s).selected.map(m => ({ id: m.id, score: round(m.score), text: m.text })) }));
const sensitivity = [1, 3, 7].map(h => {
  let day = 2; while (salience(dive, day, { halfLife: h, mentionHalfLife: h }) >= 5) day += 0.25;
  return { halfLifeDays: h, daysAfterLastMentionBelowThreshold: day - 2 };
});
// Close the selection/delivery loop. Each selected item is assumed to have been
// delivered, then exposure is recorded. Real chat must record only actual use.
const closedLoop = [false, true].map(recordExposure => {
  const memories = structuredClone(fixtures), deliveries = [];
  for (const day of [2, 2.2, 2.4, 2.6, 2.8, 3, 4, 7, 7.2, 7.4, 12, 40]) {
    const first = select(memories, { day, mode: 'proactive', maxItems: 1 }).selected[0];
    deliveries.push({ day, selected: first?.id ?? null });
    if (first && recordExposure) {
      const actual = memories.find(m => m.id === first.id);
      (actual.exposures ||= []).push(day);
    }
  }
  return { recordExposure, deliveries };
});
const out = { disclaimer: 'Synthetic fixtures and human-labelled topic relevance. Tests ranking mechanics, not automatic semantic understanding or production chat.', parameters: defaults, timeline, stress, scenarios, sensitivity, closedLoop };
fs.writeFileSync(fileURLToPath(new URL('./scores.json', import.meta.url)), JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(out, null, 2));
