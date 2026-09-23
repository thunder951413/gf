const TONES = new Set(['supportive', 'playful', 'distressed', 'distant', 'neutral']);
const CLOSENESS = new Set(['invited', 'declined', 'unspecified']);

// Some compatible endpoints emit literal newlines inside JSON strings. Repair
// only control-character escaping; never invent quotes, braces or missing text.
function parseEnvelopeJson(source) {
  let output='',quoted=false,escaped=false;
  for(const char of source){
    if(quoted&&char.charCodeAt(0)<32){output+=JSON.stringify(char).slice(1,-1);continue;}
    output+=char;
    if(escaped){escaped=false;continue;}
    if(quoted&&char==='\\'){escaped=true;continue;}
    if(char==='"')quoted=!quoted;
  }
  return JSON.parse(output);
}

function completeReplyBeforeBrokenTail(source) {
  // A quote alone does not prove the body ended: it may be an unescaped
  // quotation inside the prose. Validate the object prefix and next field.
  for (const match of source.matchAll(/"reply"\s*:\s*("(?:\\.|[^"\\])*")/g)) {
    const end = match.index + match[0].length;
    if (!/^\s*,\s*"(?:extra|signals|experience)"\s*:/.test(source.slice(end))) continue;
    try {
      const prefix = parseEnvelopeJson(source.slice(0, end) + '}');
      if (validReply(prefix.reply)) return prefix.reply.trim();
    } catch { /* Nested fields and malformed earlier values are not a body. */ }
  }
  return null;
}
const validReply = reply => typeof reply === 'string' && reply.trim().length > 0 && reply.length <= 16000;

const ENVELOPE_PROTOCOL = `回复协议：只输出一个 JSON 对象，不要 Markdown 围栏。
你可以接收用户消息，也可以由生活事件主动联系；两种方式共享同一个人物、状态和真实历史。本轮触发方式在末尾说明。
用户触发时输出 {"reply":"自然中文正文","extra":"","signals":{"tone":"neutral","closeness":"unspecified","evidence":""},"experience":null}。
主动触发时输出 {"skip":false,"contentId":null,"reason":"交流缘由","message":"自然中文正文","extra":"","experience":null}；没有值得分享的内容可 skip=true。
tone 允许 supportive、playful、distressed、distant、neutral；closeness 允许 invited、declined、unspecified。signals 只描述本次用户明确说出的语气和亲近邀请或拒绝，evidence 引用当前用户原话，无直接依据就 neutral、unspecified 和空 evidence。不描述你自己的状态，不推测潜台词。
extra 按本轮行为填写一句额外表达或空字符串，不重复正文。不为填字段增加亲昵或第二个话题。自然补充自己的虚构经历或新感受时可附 experience:{kind:"reading|film|daily",title:"作品或事情名",summary:"简短记忆",evidence:"本次正文中实际说出的原话"}，否则 null；只记自己的经历，不替用户编经历。
正文不提协议、数值、signals 或记录过程。生活与需求是背景状态，不是正文必须逐项呈现的内容。明显撒娇邀约仍按当前冷却低频出现，尊重明确距离，不因高需求每条都催促用户。`;

export function requestEmotionEnvelope(messages, behavior = null, { initiating = false, trigger: explicitTrigger = null } = {}) {
  const copy = messages.map(message => message.role === 'assistant'
    ? { ...message, content: JSON.stringify({reply:message.content}) }
    : { ...message });
  copy[0].content += '\n'+ENVELOPE_PROTOCOL;
  // Desktop attention marks an ordinary reply plan as initiating. It starts
  // an independent invitation while retaining the user-reply JSON contract.
  // Its trigger goes after history, so no historical user row is mistaken for
  // the current input.
  if(explicitTrigger)initiating=explicitTrigger.type==='scheduled_opportunity';
  const desktopInvitation = explicitTrigger?explicitTrigger.type==='desktop_invitation':!initiating&&behavior?.initiating===true;
  const trigger = {role:'user',content:initiating
    ? '【本轮触发方式：主动联系】状态和安排已经由服务端处理。按已给交流机会或资料分享自己的观察、感受、想法或小愿望。没有值得说的可跳过，不为触发事件而汇报作息。输出主动联系 JSON，message 是正文。'
    : desktopInvitation
      ? '【本轮触发方式：独立邀请】这是一次由你主动开启的桌面交流邀请，不是用户刚发来的文字。历史消息只供延续语气和已知事实，尤其不要把最后一条历史用户消息当作本轮输入或逐句回应。自然主动说一两句想说的话；不必提问，不转去资讯。输出用户触发 JSON，reply 是正文。'
    : '【本轮触发方式：用户消息】先回应最后的用户消息。状态和安排已经由服务端处理，自己的生活仅在相关时参与，不抢走用户话题。输出用户触发 JSON，reply 是正文。'};
  const index = !initiating && !desktopInvitation && copy.at(-1)?.role==='user' ? copy.length-1 : copy.length;
  copy.splice(index,0,trigger);
  return copy;
}

export function parseEmotionEnvelope(raw, userText) {
  const text = String(raw || '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  const source = (fenced?.[1] || text).trim();
  // Existing compatible models may still answer in plain text.
  if (!source.startsWith('{')) {
    // Some text-only adapters wrap an otherwise ordinary reply in a JSON string.
    if (source.startsWith('"')) { try { const reply = JSON.parse(source); if (typeof reply === 'string' && reply.trim()) return { reply: reply.trim(), signals: null }; } catch {} }
    return { reply: text, signals: null };
  }
  let result;
  try { result = parseEnvelopeJson(source); } catch {
    // A complete reply remains useful if only the optional signal tail broke.
    const reply = completeReplyBeforeBrokenTail(source);
    if (reply !== null) return { reply, signals: null };
    throw invalidReply();
  }
  if (!result || !validReply(result.reply)) throw invalidReply();
  const signals = result.signals;
  const evidence = typeof signals?.evidence === 'string' ? signals.evidence.trim() : '';
  const valid = signals && TONES.has(signals.tone) && CLOSENESS.has(signals.closeness)
    && evidence.length > 0 && evidence.length <= 160 && String(userText).includes(evidence);
  // The model supplies small categorical cues; it cannot set numeric state,
  // invent a shared past, grant consent, or write arbitrary memories.
  return { reply: result.reply.trim(), signals: valid ? { tone: signals.tone, closeness: signals.closeness } : null, ...(result.experience?{experience:result.experience}:{}) };
}
function invalidReply() { return Object.assign(new Error('模型没有返回完整的对话正文，请稍后重试'), { status: 502, code: 'MODEL_REPLY_INVALID' }); }

export function emotionExtra(raw){try{const value=parseEnvelopeJson(String(raw).replace(/^```(?:json)?\s*|\s*```$/g,''));return typeof value.extra==='string'?value.extra.trim():'';}catch{return '';}}
