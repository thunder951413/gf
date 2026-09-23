// A conservative revision hint, never a reason to drop sentences or fail a turn.
function decorativeCount(value) {
  const text = proseOnly(value);
  return text.split(/[。！？!?\n]/u).filter(line =>
    /(?:就像|好像|像|仿佛|好似|宛如)[^。！？!?\n]{0,24}(?:风|雨|月|星|灯|湖|海|窗|树|叶|橘|茶|云|花|盒子|墙|光|画|水|糖|春|夏|秋|冬|时间|平行|版本|天空|鸟|翅膀|滤镜)/u.test(line)
    || /(?:日子|时间|时光|河水|屋檐|文字|诗句|字|重力)[^。！？!?\n]{0,12}(?:记得|照顾|替.{0,5}留|住在|变暖|暖了|温软|懒得|长上)|(?:住在纸上|把.{0,12}(?:收进|放进).{0,6}盒子|诗句.{0,8}影子|心里.{0,8}(?:存|藏).{0,8}画|水.{0,10}抱着|感觉.{0,20}安放)/u.test(line)
  ).length;
}

// These checks advise a single rewrite.  They deliberately describe a pattern,
// rather than treating a blush, glance, or one small movement as a problem.
function proseOnly(value) {
  return String(value || '')
    .replace(/https?:\/\/\S+|```[\s\S]*?```|`[^`]*`/g, '')
    .replace(/[“\"][^”\"]{0,240}[”\"]|「[^」]{0,240}」|『[^』]{0,240}』/g, '');
}

function creativeWritingRequested(userText) {
  const request = String(userText || '');
  if (/(?:别|不要|太多|少|避免|不想|太(?:像|过))/.test(request)) return false;
  return /(?:写|作).{0,8}(?:诗|散文)|用.{0,8}(?:比喻|拟人)|描述.{0,8}画面|诗意一点|文学一点|(?:写|续写|改写|润色|创作|生成|来一段|用).{0,16}(?:小说|故事|剧本|分镜|舞台剧|诗|散文|诗意|文学|舞蹈|舞步|编舞|走位|blocking|舞台调度)|(?:按|作为).{0,12}(?:小说|剧本|分镜|舞台|诗意|舞蹈|编舞)|(?:小说|剧本|分镜|舞台).{0,10}(?:场景|动作|走位|描写)/iu.test(request);
}

function stagedReactionNarration(value) {
  const text = proseOnly(value);
  const emotionalReaction = /没接住|没接稳|藏不住|装没事|咯噔|愣(?:住|了|一下)|羞(?:得|了)|脸红|耳(?:朵|根).{0,5}(?:热|红)|心(?:里|跳).{0,8}(?:紧|乱|快|漏)|慌(?:了|张)|不知(?:道|所措)|反应不过来|躲不掉|发烫/u.test(text);
  const procedural = /(?:先(?:是)?|接着|随后|过一会儿|一会儿).{0,32}(?:然后|随后|再|又|最后|过一会儿)|(?:然后|随后|再).{0,32}又/u.test(text);
  const gestures = text.match(/(?:脸(?:侧|偏|别|转|埋)|视线(?:飘|移|躲|垂|落|抬)|目光(?:飘|移|躲|垂|落|抬)|抬眼|眼(?:神|睛)?(?:飘|移|躲|垂|抬)|手(?:指|心)?(?:又|悄悄)?(?:蜷|缩|松|收|抬|攥)|(?:缩|松)(?:一下)?肩|肩(?:膀)?(?:缩|绷|抖)|身(?:子|体)?(?:往前|往后|一僵|挪|退|躲)|头(?:偏|侧|低|抬)|脚(?:步)?(?:退|挪)|往(?:前|后)(?:小小)?(?:挪|退)|退回(?:来|去)?|躲开|侧过(?:去)?|别开|移开|收回)/gu) || [];
  const bodySteps = text.match(/(?:往后靠|后背贴|手搭|(?:脖子|肩).{0,6}缩|缩(?:一下)?(?:肩|脖子)|闭着眼|把头偏|头微微偏|手.{0,8}(?:收|攥)|肩.{0,6}(?:松|沉)|(?:脸|视线|目光).{0,4}(?:侧|偏|移|躲|垂)|往(?:前|后|你怀里).{0,4}(?:挪|退))/gu) || [];
  return (emotionalReaction && procedural && gestures.length >= 2)
    || ((emotionalReaction || /抱|亲|怀里|圈着|圈过来/u.test(text)) && bodySteps.length >= 4);
}

export function plainSpeechIssues(reply, userText = '', previousReplies = []) {
  if (creativeWritingRequested(userText)) return [];
  const count=decorativeCount(reply), recent=previousReplies.slice(-2).some(decorativeCount);
  const issues=[];
  if(count>1 || count>0&&recent) issues.push('too_many_decorative_comparisons');
  if(stagedReactionNarration(reply)) issues.push('staged_reaction_narration');
  return issues;
}

export const PLAIN_SPEECH_REVISION = '这份草稿堆叠了装饰性比喻。保留刚才要回应的具体事和温柔态度，用平常说话的方式重写；不要加风、雨、灯、盒子等新意象，不用感动或总结关系代替接话。可以直接说想法、原因或下一步，不删掉话题中的有效信息。';
export const STAGED_REACTION_NARRATION_REVISION = '这份草稿把反应拆成了连贯的镜头动作。保留害羞、心动或想靠近的真实意思，直接用聊天口吻说出来；不必依次安排脸、眼神、手和后退等动作。把逐拍的身体步骤合成自然的感受或愿望，说清楚为什么喜欢、想让对方怎样，而不是逐项描述自己将怎样表演。可以留一个自然的小动作，但不要删掉原本的情绪和回应。';

export function spokenChatGuidance(userText = '') {
  if (creativeWritingRequested(userText)) return '';
  return '用自然的文字聊天：直接说感受、想法或想做什么，围绕正在聊的事给出自己的回应。喜欢就说具体喜欢哪里，好奇就接着问那件事，想念就坦率表达；情绪是态度，不需要每条都先交代自己被这句话打动后的反应。口吻参考（不照抄）：“总算改好了！是哪里出了问题？”“喜欢啊，逛这种店我经常忘了时间。”“我也想多抱你一会儿，今天特别想你。”动作细节按内容需要出现，不把脸、眼神、手和退让拆成连续镜头，也别用固定的害羞或脸红开场。不要以整个人松软、心里一动之类的身体变化作为通用接话方式；也不把普通小事都归结为被理解、被接住的感动。';
}

export function continuationIssues(reply, thread, userText = '', qualityPlan = null) {
  // The resolved turn decision owns closing permission. Lexical fallback is
  // only for callers without a prepared plan, never a competing judgment.
  const closing=qualityPlan?qualityPlan.allowClosing:/我先忙|先这样|回头聊|回来再聊|下次再聊|我要走了|晚安/.test(userText);
  if(!thread?.holdsTopic || closing)return [];
  return /等你.{0,12}(?:回来|回家|结束).{0,18}(?:说|聊|讲|告诉|分享)|(?:回来|回头|下次)再.{0,12}(?:说|聊|讲|分享)/.test(String(reply)) ? ['premature_topic_closing'] : [];
}
