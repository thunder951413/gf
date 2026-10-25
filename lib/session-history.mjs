// One identity map is used by the writer, reviewer, diagnostics and recall.
export function sessionHistoryRecord(row, role = {}, index = 0) {
  const speaker = row.speaker === 'assistant' ? 'assistant' : 'user';
  return { id: row.id || `window:${index}`, speaker,
    authorId: speaker === 'assistant' ? role.id || 'character' : 'user',
    authorName: speaker === 'assistant' ? role.name || '角色' : '用户',
    kind: row.kind || 'chat', at: row.createdAt || row.created_at || null,
    text: String(row.text ?? row.content ?? '') };
}

// Native history messages directly precede their 【相邻对话】 metadata block.
export function nativeHistoryRange(messages) {
  const meta = messages.findIndex(m => m.role === 'system' && String(m.content).startsWith('【相邻对话】'));
  if (meta < 0) return { start: -1, end: -1, meta };
  let start = meta;
  while (start > 0 && ['user', 'assistant'].includes(messages[start - 1].role)) start--;
  return { start, end: meta, meta };
}

// Read only the structured archive and its adjacent-message metadata. IDs and
// authors are assigned by the application, never inferred from first-person text.
export function sessionEvidenceSources(messages) {
  const sources = [];
  const native = nativeHistoryRange(messages);
  let current = false;
  for (const [index, message] of messages.entries()) {
    if (message.role === 'system' && ['【历史原文记录】','【相邻对话】'].some(prefix => message.content.startsWith(prefix))) {
      let records;
      try { records = JSON.parse(message.content.slice(message.content.indexOf('\n') + 1)); } catch { continue; }
      if (!Array.isArray(records)) continue;
      if (message.content.startsWith('【相邻对话】')) {
        const natives = messages.slice(native.start, native.end);
        records.forEach((metadata, i) => { const row = natives[i];
          if (row && metadata?.speaker === row.role) sources.push({ id: metadata.id, speaker: row.role, text: row.content }); });
      }
      else for (const row of records) if (['user','assistant'].includes(row.speaker) && typeof row.text === 'string') {
        sources.push({ id: row.id || `archive:${sources.length}`, speaker: row.speaker, text: row.text });
      }
    } else if (message.role === 'system' && message.content.startsWith('【当前轮次】')) current = true;
    else if (current && message.role === 'user' && index > native.meta) sources.push({ id: 'current', speaker: 'user', text: message.content });
  }
  return sources;
}

// Leading stable blocks (persona, long-term background, archive) are shared
// verbatim by the writer, the preparer and the reviewer so the provider can
// reuse one cached prefix; the call-specific instruction follows them.
export function sessionStablePrefix(messages) {
  const prefix = [];
  for (const m of messages) {
    if (m.role !== 'system') break;
    if (m.content.startsWith('【当前轮次】') || m.content.startsWith('【本轮背景证据】') || m.content.startsWith('【相邻对话】')) break;
    prefix.push(m);
  }
  return prefix;
}

// The reviewer is a separate reader, so historical assistant messages must be
// quoted as evidence rather than masquerading as the reviewer's own answers.
export function sessionReviewEvidence(messages, { includePersona = false } = {}) {
  const native = nativeHistoryRange(messages);
  const currentStart = messages.findIndex(m => m.role === 'system' && m.content.startsWith('【当前轮次】'));
  const prefixLength = sessionStablePrefix(messages).length;
  return messages.flatMap((m, index) => {
    if (index < prefixLength) return [];
    if (native.start >= 0 && index >= native.start && index < native.end) {
      return [{ role: 'system', content: `【历史原话｜${m.role === 'assistant' ? '角色本人' : '用户'}】\n${m.content}` }];
    }
    if (m.role === 'user' && currentStart >= 0 && index > currentStart) return [m];
    if (m.role !== 'system') return [];
    if (['【历史原文记录】','【相邻对话】','【本轮背景证据】','【历史窗口范围】','【外部工具回执｜'].some(p => m.content.startsWith(p))) return [m];
    if (m.content.startsWith('【当前轮次】')) return [{ ...m, content: m.content.split('\n').slice(0, 2).join('\n') }];
    return [];
  });
}
