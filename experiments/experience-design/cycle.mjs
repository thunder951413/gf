// Design prototype only: authored fixtures supply content; no language inference
// and no production imports or writes. Time controls progress, delivery does not.
export class ExperienceCycle {
  constructor(plans) {
    this.plans = structuredClone(plans);
    this.deliveries = new Map();
    this.replies = new Set();
  }
  current(now) {
    return this.plans.flatMap(plan => {
      const reached = plan.phases.filter(phase => Date.parse(phase.at) <= Date.parse(now)).at(-1);
      return reached ? [{ ...structuredClone(reached), eventId: plan.id,
        eventStatus: Date.parse(now) >= Date.parse(plan.endsAt) ? 'ended' : 'active',
        cardId: `${plan.id}:${reached.id}`, title: plan.title }] : [];
    });
  }
  prepare(now, { quiet = false, minGapMs = 3600000 } = {}) {
    if (quiet) return null;
    const sent = [...this.deliveries.values()].sort((a, b) => Date.parse(b.sentAt) - Date.parse(a.sentAt));
    // This fixture policy allows one unanswered opener. Production keeps the
    // user's configured limit, rather than treating no response as punishment.
    if (sent.some(item => !this.replies.has(item.messageId))) return null;
    if (sent[0] && Date.parse(now) - Date.parse(sent[0].sentAt) < minGapMs) return null;
    return this.current(now)
      .filter(item => Date.parse(item.expiresAt) > Date.parse(now))
      .filter(item => item.text && item.details?.length)
      .filter(item => !sent.some(delivery => delivery.cardId === item.cardId))
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || a.cardId.localeCompare(b.cardId))[0] || null;
  }
  commit(card, messageId, now) {
    const existing = this.deliveries.get(messageId);
    if (existing) return existing.cardId === card?.cardId;
    if (!messageId || !card) return false;
    const current = this.prepare(now);
    if (current?.cardId !== card.cardId) return false;
    this.deliveries.set(messageId, { ...current, messageId, sentAt: now });
    return true;
  }
  replyTo(messageId) {
    const material = this.deliveries.get(messageId);
    if (!material) return null;
    this.replies.add(messageId);
    // The opened message retains its own material, even if life has moved on.
    return structuredClone(material);
  }
}
