// A user turn can leave room for one optional contribution from her own world.
// This is permission to offer a candidate, never an instruction to change topic.
export function conversationalSpace({ semantic, conversation = [], thread = null, activeDiscussion = false, recentIntroduction = false } = {}) {
  if (!semantic || semantic.source !== 'none' || semantic.correction || semantic.acceptsOffer) return null;
  if (['comfort', 'affection', 'boundary', 'preference', 'close', 'recall', 'answer'].includes(semantic.intent)) return null;
  if (semantic.needsCurrentState || semantic.ownLife || semantic.advice || activeDiscussion) return null;
  if (recentIntroduction && semantic.intent !== 'share') return null;
  if (semantic.intent === 'share' || semantic.intent === 'open') return { mode: 'open' };
  if (semantic.intent === 'acknowledge') {
    if (thread?.acceptsOffer) return null;
    const previous = conversation.findLast(row => row.speaker === 'assistant')?.text || '';
    // A short answer to her question or offer is still part of that exchange.
    if (/[?？]\s*$|要不要|想不想|愿不愿意|可以给你|我可以/u.test(previous)) return null;
    return { mode: 'open' };
  }
  if (semantic.intent === 'respond') return { mode: 'related' };
  return null;
}
