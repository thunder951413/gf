// What her face and body on the desktop say: her feelings (lib/affect.mjs),
// how much she misses him and the hour become one mood, and the mood picks the
// approved photo that fits it best. Only real, approved complete looks are
// used — a mood never invents a pose or expression the catalog does not have.
export const MOODS = Object.freeze({
  sleepy: { label: '困了', looks: [['sleeping', 'tired'], ['resting', null], [null, 'tired']] },
  hurt: { label: '有点委屈', looks: [['stretch', 'pout'], [null, 'pout'], ['reading', 'neutral'], [null, 'neutral']] },
  longing: { label: '想亲近', looks: [['sitting', 'shy'], [null, 'shy'], ['turning', null], ['resting', null]] },
  missing: { label: '想他', looks: [['cup', 'concerned'], [null, 'concerned'], ['reading', 'neutral'], ['resting', null]] },
  happy: { label: '开心', looks: [['wave', 'happy'], [null, 'happy'], ['sitting', 'shy'], [null, 'soft-smile']] },
  calm: { label: '平常', looks: [] },
});

const shanghaiHour = at => new Date(+new Date(at) + 8 * 3600000).getUTCHours();

// Strongest feeling wins; sleep is not a feeling but it shows.
export function desktopMood({ affect = null, pulse = null, now = new Date(), sleeping = false } = {}) {
  const hour = shanghaiHour(now), why = [];
  if (sleeping || hour < 7) return { id: 'sleepy', label: MOODS.sleepy.label, intensity: 1, why: '夜里在睡' };
  if (affect?.hurt >= 45) return { id: 'hurt', label: MOODS.hurt.label, intensity: affect.hurt / 100, why: affect.causes?.findLast(c => ['dismissive', 'hurtful', 'distant'].includes(c.towardHer))?.why || '' };
  if (affect?.desire >= 70 && hour >= 20) return { id: 'longing', label: MOODS.longing.label, intensity: affect.desire / 100, why: '晚上想他' };
  if (pulse?.level >= 60) return { id: 'missing', label: MOODS.missing.label, intensity: pulse.level / 100, why: `他约${pulse.hoursSinceHim}小时没说话` };
  if (affect?.warmth >= 72) { why.push(affect.causes?.findLast(c => ['tender', 'warm', 'apologetic'].includes(c.towardHer))?.why || ''); return { id: 'happy', label: MOODS.happy.label, intensity: affect.warmth / 100, why: why[0] }; }
  return { id: 'calm', label: MOODS.calm.label, intensity: 0, why: '' };
}

// Rank the approved candidates for a mood. Keeping her hairstyle matters most,
// then the look she wears today; changing outfit is only worth it for a strong
// mood or for the evening at home.
export function pickForMood(candidates, { mood, current, daily, hour = 12 }) {
  const looks = MOODS[mood.id]?.looks || [];
  if (!looks.length || !current) return null;
  const rank = asset => looks.findIndex(([pose, expression]) => (!pose || asset.poseId === pose) && (!expression || asset.expressionId === expression));
  const base = daily || current;
  const scored = candidates.filter(asset => asset.hairstyleId === base.hairstyleId && rank(asset) >= 0).map(asset => {
    const sameLook = asset.outfitId === base.outfitId && asset.paletteId === base.paletteId;
    const homeEvening = asset.outfitId === 'homewear' && (hour >= 19 || hour < 9);
    const outfitCost = sameLook ? 0 : homeEvening ? 1 : mood.intensity >= 0.6 ? 2 : Infinity;
    return { asset, score: rank(asset) * 3 + outfitCost };
  }).filter(entry => Number.isFinite(entry.score)).sort((a, b) => a.score - b.score);
  return scored[0]?.asset || null;
}
