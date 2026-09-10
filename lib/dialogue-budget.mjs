const DEFAULT_LIMITS = Object.freeze({
  history: Object.freeze({ count: 30, chars: 12_000 }),
  memories: Object.freeze({ count: 30, chars: 12_000 }),
  maxOutputTokens: 2_000,
  replyChars: 16_000,
});

const MIYUE_LIMITS = Object.freeze({
  history: Object.freeze({ count: 32, chars: 18_000 }),
  memories: Object.freeze({ count: 12, chars: 5_000 }),
  maxOutputTokens: 4_096,
  replyChars: 6_000,
});

function verbosityValue(value) {
  const candidate = value && typeof value === 'object' ? value.verbosity : value;
  const number = Number(candidate);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
}

// These are hard transport/context ceilings, not target response lengths.
export function dialogueLimits(roleId, verbosity) {
  if (roleId !== 'miyue') return DEFAULT_LIMITS;
  if ((verbosityValue(verbosity) ?? 50) < 80) return MIYUE_LIMITS;
  return Object.freeze({ ...MIYUE_LIMITS, maxOutputTokens: 6_000 });
}
