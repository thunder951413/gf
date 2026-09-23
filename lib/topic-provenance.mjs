// Provenance is derived from delivered messages, not inferred from a model's
// summary of the conversation. Unknown origin stays unknown.
export function topicProvenance({ semantic, conversation = [], receiptFor = () => null } = {}) {
  const decision = semantic?.status === 'model' ? semantic.decision : null;
  if (decision?.continuity !== 'continue' || !decision.focusMessageId) return null;
  const focus = conversation.find(row => row.id === decision.focusMessageId && row.speaker === 'assistant');
  if (!focus) return null;
  const last = conversation.findLast(row => row.speaker === 'assistant' || row.speaker === 'user');
  const adjacent = last?.id === focus.id;
  const receipt = receiptFor(focus.id);
  const assistantInitiated = focus.kind === 'proactive' || Boolean(receipt?.behavior?.spontaneousIntroduced);
  return { focusMessageId: focus.id, adjacent, assistantInitiated, focusKind: focus.kind || 'chat' };
}

export function topicProvenanceContext(provenance) {
  if (!provenance?.adjacent) return '';
  return provenance.assistantInitiated
    ? '【本轮话题归属】紧邻的上一条助手消息由你主动发出，用户现在是在回应你先提出的内容。把用户这次新增的看法归给用户，把原话题归给你自己；不要说成用户突然提起、开启或接来这个话题，也不要追问他为何忽然聊到这里。'
    : '【本轮话题归属】用户现在是在回应你紧邻的上一条消息。先承接这段实际交流；不要把他的接话说成无缘无故突然换题。原话题最初由谁发起若无依据，不作断言。';
}

export function topicProvenanceIssues(reply, provenance) {
  if (!provenance?.adjacent) return [];
  const text = String(reply || '');
  // Only reject a narrow, observable inversion. Asking why the user holds a
  // distinct opinion is legitimate; asking why they "suddenly picked up" the
  // assistant's immediately preceding topic is not.
  if (/你.{0,10}(?:忽然|突然).{0,12}(?:接(?:这个|这事|这话|话题)|提起(?:这个|这事|这话题)|聊起(?:这个|这事|这话题))|你.{0,8}(?:怎么|为什么|为何).{0,10}(?:接(?:这个|这事|这话|话题))/u.test(text)) return ['adjacent_topic_attribution'];
  if (provenance.assistantInitiated && /(?:是你|你)(?:先|刚才|之前).{0,5}(?:提起|聊起|说起)(?:这个|这件事|这话题)/u.test(text)) return ['assistant_topic_attributed_to_user'];
  return [];
}
