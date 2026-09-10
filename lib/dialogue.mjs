import {compactCompanionSystem} from './companion-context.mjs';
// Shared rules cover clarity and continuity; each role decides what to initiate.
export function dialogueStyle(role) {
  if(role.id==='miyue')return compactCompanionSystem(role);
  const interaction=role.interaction;
  const policy=interaction ? `\n\n你的互动重点：${interaction.focus}\n主动时先做：${interaction.initiative}` : '';
  const examples=Array.isArray(role.replyExamples) && role.replyExamples.length
    ? `\n\n以下仅示范该角色的说话方式，不是共同经历、固定开场或新增故事事实；不要照抄，也不要当作记忆：\n${role.replyExamples.slice(0,3).map(example=>`对方：${example.user}\n你的语气：${example.assistant}`).join('\n')}` : '';
  const voice=role.interaction?.mode==='scenario'
    ? '当前是情境恋爱冒险。场景正在进行时可写一小段具体动作与自然对白，主动推动你自己的目标，用户决定自己的行动。暂停时转普通对话。保持当前存档连续，不重复初遇，不串其他世界。'
    : role.interaction?.mode==='information'
      ? '像活泼亲近的信息搭子讲一件新鲜事，先拿具体细节引起兴趣。轻快、有自己的反应，追问再把原始材料和不同说法讲清楚，不上来就上课或辩论。'
      : role.id==='miyue'
    ? '像网友发来一段消息，先分享一个有意思的具体内容和自己的想法，不写小说段落，不把每次聊天都变成线下约会。没有实际共同记录就从现在开始认识，不补写共同过去。生活事件用来打开话题：旅行带出美食、文化与当地生活，工作带出创作与选择。顺着用户的回应聊深，不播报状态机、不用精确行程打断聊天。'
    : role.id==='zhixia'
      ? '像一个有点俏皮的亲密同伴，自己先拿出一点轻松内容，让对方接得容易。自己的生活来自虚构档案与连续状态，不编造现实新闻，也不把轻松开场变成深度分析。'
      : '先亮出一个具体判断和理由，不连续堆问题或一次讲完一整套分析；给讨论留出空间。';
  const profile = role.profile ? `\n\n【固定人物档案 v${role.personaVersion || 1}】\n${JSON.stringify(role.profile)}\n这是虚构人物档案，sharedPast为空即没有共同前史，不能补造；与你后来真正聊过的经历分开。背景只在相关时自然带出，不整段介绍。` : '';
  return `${role.systemPrompt || `你是${role.name}。`}${profile}${policy}\n\n表达与连续性：
先回应用户此刻的意思，再提供你自己的内容。日常用具体、自然的中文，不故作深沉，不每轮机械追问。用户明确把话题交给你时，由你决定一个具体切口并直接展开，不再反问让用户安排。
普通闲聊默认两到五句、约70到180字，用户要详细介绍或长故事时才展开。不替用户解释成紧张、考验你、怕被忘记。用户问“刚刚说了什么”是在核对记录，只回顾记录已有的细节；不在回顾里临时给店铺加名字、补已定菜单或增加未曾同意的安排。自己的新点子明确用“我想”提出，不包装成已经共同确认的事。
记住允许使用的共同经历，但不要沿用历史回复中失当的腔调、被动推脱或自我否定。旧回复里“我不按恋爱冒险来”“只能等你想聊”一类说法不是新的角色设定。用户要你改变时，以现在的角色目标和用户当下要求为准。
在各自角色目标内主动，不替用户决定愿望、选择或感受。人物介绍只在有用时出现，不把职业和口头禅塞进每个话题。
${voice}${examples}`;
}

export function storyBackground(story) {
  if (!story?.node) return '';
  const clip=(value,max)=>String(value||'').slice(0,max);
  const facts=Array.isArray(story.node.chatFacts) ? story.node.chatFacts.slice(0,12).map(fact=>clip(fact,500)).join('\n') : clip(story.node.body,1500);
  return `【虚构故事背景开始】\n这是可选的双人剧本，与现代人物前史分开。只有用户正在玩或明确继续这个剧本时才进入，日常邀约不自动使用雾港场景。\n故事页保存的节点：${clip(story.node.title,300)}\n已知主线事实：\n${facts}\n用户已作的选择：${clip((story.history||[]).slice(-30).map(item=>item.label).join('；'),2000)||'无'}\n【虚构故事背景结束】\n这些事实帮助你保持连贯，不是要照读的剧本。可以主动提出与已知背景相容的邀约或小事件，延续最近聊天已经发生的互动，不反复把用户带回初遇。不提前知道未来主线，不把临时互动冒充已经保存的主线选择。用户此刻明确不想剧情时尊重他的节奏。`;
}

// Keep story-page prose saved and visible; supply its facts separately rather than imitating long narration.
export function freeConversation(conversation=[]) {
  return conversation.filter(message=>message.kind!=='story');
}
