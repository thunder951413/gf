// Retrieval can inform wording for this one turn.  It deliberately has no
// dependency on a state repository: remembering is not a relationship update.
const MAX_CONTEXT = 900;
const clip = (value, length) => String(value || '').replace(/\s+/gu, ' ').trim().slice(0, length);
const none = () => ({ kind: 'none', context: '', sourceIds: [], evidence: [], stateMutation: false });

function userTurn(trigger) { return trigger?.type === 'user_message'; }
function decisionOf(semantic) { return semantic?.decision || semantic || {}; }
function explicitlyDominant(text, decision) {
  if (['boundary', 'preference', 'close', 'source'].includes(decision?.intent)) return true;
  // Do not turn a bare “我不想…” into an interaction preference: it may be
  // content such as “我不想放弃”.  These are only explicit routing requests.
  return /(?:换个话题|别再提|不要再提|不想聊(?:这|这个|此事|这个话题)|停止(?:聊|提)|先这样吧|只聊(?:工作|正事)|保持(?:距离|普通朋友)|不要越界)/u.test(text);
}
function unusableSemantic(semantic, decision) {
  const topicEvidence = [semantic?.evidence, decision?.evidence].flatMap(value => Array.isArray(value) ? value : [value]).join(' ');
  return semantic?.status === 'fallback' || decision?.ambiguous === true || decision?.ambiguity === true
    || decision?.topicSwitch === true && /(?:换个话题|别再提|不要再提|不想聊|停止(?:聊|提))/u.test(topicEvidence);
}
function idsOf(record) {
  const values = Array.isArray(record?.sourceIds) ? record.sourceIds : record?.id == null ? [] : [record.id];
  return [...new Set(values.map(value => clip(value, 120)).filter(Boolean))].slice(0, 6);
}
function isCharacterFiction(record) {
  return /^(?:character|companion|fiction|scene|life_event|runtime)/u.test(String(record?.kind || ''))
    || record?.fictional === true || record?.subject === 'character';
}
function realityOf(record) {
  if (record?.subject === 'shared') return 'attributed_conversation';
  return isCharacterFiction(record) ? 'character_fictional_past' : 'user_past_reality';
}
function confidenceOf(record) {
  const named = String(record?.confidence || '').toLowerCase();
  if (['high', 'certain', 'confirmed'].includes(named) || record?.mandatory) return 'high';
  if (['low', 'none', 'uncertain', 'ambiguous'].includes(named) || record?.ambiguous || record?.lowConfidence) return 'low';
  if(record?.channels?.semanticEvidence===1&&record?.lowConfidence===false)return 'high';
  const direct = Number(record?.channels?.direct);
  if (Number.isFinite(direct) && direct > 0) return direct >= 1 ? 'high' : 'medium';
  // A strong semantic expansion is independently useful when the selector
  // explicitly did not flag it low-confidence.  It does not rescue weak hits.
  const semantic = Number(record?.channels?.semantic);
  if (Number.isFinite(semantic)) return semantic >= 1 ? 'high' : semantic > 0 ? 'medium' : 'low';
  const score = Number(record.score);
  return Number.isFinite(score) && score >= .7 ? 'high' : 'low';
}
function usable(record) {
  if (!record || typeof record !== 'object') return false;
  // Selection metadata is sufficient here; this preview does not quote memory.
  return confidenceOf(record) === 'high' && (idsOf(record).length > 0 || clip(record.topic, 100));
}
function literalSemanticEvidence(semantic, userText) {
  const decision = decisionOf(semantic);
  const candidates = [semantic?.evidence, decision?.evidence].flatMap(value => Array.isArray(value) ? value : [value]);
  return candidates.map(value => clip(value, 120)).filter(value => value && userText.includes(value)).slice(0, 2);
}

export function previewTurnReaction({ trigger, semantic = null, userText = '', memory = null, currentState = null } = {}) {
  const text = typeof userText === 'string' ? userText : '';
  const decision = decisionOf(semantic);
  // currentState is intentionally unused: this function is a pure preview.
  void currentState;
  if (!userTurn(trigger) || explicitlyDominant(text, decision) || unusableSemantic(semantic, decision)) return none();
  const injected = Array.isArray(memory?.selected) ? memory.selected : [];
  const represented = Array.isArray(memory?.represented) ? memory.represented : [];
  const records = [...injected.map(record => ({ ...record, represented: false })), ...represented.map(record => ({ ...record, represented: true }))]
    .filter(usable).slice(0, 2);
  if (!records.length) return none();

  const sourceIds = [...new Set(records.flatMap(idsOf))].slice(0, 8);
  if (!sourceIds.length) return none();
  const evidence = records.map(record => ({
    id: clip(record.id, 120) || null,
    kind: clip(record.kind, 80) || 'memory',
    subject: clip(record.subject, 100) || null,
    sourceIds: idsOf(record),
    at: clip(record.at, 40) || null,
    topic: clip(record.topic, 120) || null,
    confidence: confidenceOf(record),
    represented: Boolean(record.represented),
    reality: realityOf(record),
  }));
  const lines = ['【当轮回应线索】'];
  for (const item of evidence) {
    const owner = item.reality === 'character_fictional_past' ? '角色过去的虚构经历'
      : item.reality === 'attributed_conversation' ? '已标注的对话记录' : '用户过去提到的现实';
    const subject = item.topic ? `关于“${item.topic}”` : '这项过去证据';
    const attribution = item.reality === 'attributed_conversation' ? '严格按已标说话人引用，不能把角色经历当作用户现实；' : '';
    lines.push(`${owner}（非当前状态；来源 ${item.sourceIds.join('、')}）：${attribution}${subject}${item.represented ? '已在本轮材料中呈现，勿重复注入。' : '可作为确认的依据。'}`);
  }
  const literal = literalSemanticEvidence(semantic, text);
  if (literal.length) lines.push(`本轮用户原话可直接核对：${literal.join('；')}`);
  lines.push('仅在确有必要时据此自然确认，不强行追忆、不额外添加一句回应，也不据此作出新的承诺。');
  return { kind: 'memory_acknowledgement', context: clip(lines.join('\n'), MAX_CONTEXT), sourceIds, evidence, stateMutation: false };
}
