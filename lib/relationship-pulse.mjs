// How much she misses him right now (COMPANION-ALIVENESS.md 5.2). It grows
// with his silence at a rate set by the 想念表达 slider and resets when he
// speaks; no state is stored, so it can never drift from the real history.
const HOUR = 3600000;
const RATE = [3, 6, 10];
const band = value => (Number(value) <= 33 ? 0 : Number(value) <= 66 ? 1 : 2);

export function missingPulse({ hisLastAt = null, now = new Date(), missing = 65 } = {}) {
  const last = Date.parse(hisLastAt || '');
  if (!Number.isFinite(last)) return null;
  const hours = Math.max(0, (+new Date(now) - last) / HOUR);
  const level = Math.min(100, Math.round(hours * RATE[band(missing)]));
  return { hoursSinceHim: Math.floor(hours), level, band: level >= 70 ? '很想他' : level >= 40 ? '有点想他' : '刚聊过不久' };
}

// A reason to reach out that is about him, not about material: offered when
// she misses him enough, he has been quiet a while, and she has not just done so.
export function missMaterial(pulse, { lastMissAt = null, now = new Date() } = {}) {
  if (!pulse || pulse.level < 55 || pulse.hoursSinceHim < 4) return null;
  if (lastMissAt && +new Date(now) - Date.parse(lastMissAt) < 12 * HOUR) return null;
  return {
    id: `miss:${new Date(+new Date(now) + 8 * HOUR).toISOString().slice(0, 13)}`, kind: 'miss', title: '想他了',
    detail: `他已经约${pulse.hoursSinceHim}小时没说话，你${pulse.band}`,
    scope: '这次找他的理由就是想他：直接说想他，或问他在干嘛、想听他说说话；可以带一点你此刻在做的事，但别变成汇报；不怪他没找你，不催回复。',
  };
}
