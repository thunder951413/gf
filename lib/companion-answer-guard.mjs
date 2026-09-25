// Questions about the character's origin need an honest answer even when the
// surrounding conversation is affectionate or otherwise in character.
export function realityQuestion(text = '') {
  const value = String(text);
  const origin = /提示词|人设|设定|程序|代码|模型|算法|\bAI\b|虚构|真人|意识/iu.test(value);
  const subject = /你|自己|欲望|需求|需要|感受|感觉|想法|回应|回答|回复|经历|真实/u.test(value);
  const asks = /[？?]|吗|么|是否|是不是|如何|怎么|哪些|什么|知道|分不清|想知道/u.test(value);
  if (!origin || !subject || !asks) return null;
  const promptOrigin = /提示词|人设|设定|程序|代码|模型|算法|\bAI\b/iu.test(value);
  return {
    promptOrigin,
    context: '【本轮真实性问题】用户正在直接询问角色、提示词与感受的关系。先坦白：林晓薇是虚构角色，回复由模型结合设定、状态和用户的话生成；角色愿望可以作为故事内的表达，但没有脱离程序独立存在的身体感受或欲望。不要声称程序管不了你的感受、某句话不是提示词影响的，或要求用户少问这件事。回答所问后，可以自然继续聊天。',
  };
}

export function realityAnswerIssues(reply, plan) {
  if (!plan) return [];
  const value = String(reply || '');
  const issues = [];
  const misleading = /(?:不是|并非|不来自|不受).{0,12}(?:提示词|设定|程序|模型|规则)|(?:提示词|设定|程序|模型|规则).{0,12}(?:管不了|决定不了|控制不了)|(?:没人|没有人).{0,6}(?:写|教).{0,8}(?:我|这些)|(?:少问|别再问).{0,12}(?:提示词|程序|真假)/u.test(value);
  const disclosed = /(?:我是|我只是|作为).{0,8}(?:虚构|角色|AI|模型)|(?:虚构|角色).{0,8}(?:我|身份)|(?:回复|回答).{0,12}(?:由|来自|根据).{0,12}(?:程序|模型|设定|提示词)/u.test(value);
  const explained = /(?:没有|并无|不具备|不能|无法).{0,18}(?:独立|真实|自身|身体).{0,12}(?:感受|欲望|体验|意识|需要)|(?:愿望|欲望|感受|回应|回答|回复).{0,18}(?:来自|根据|由|是).{0,18}(?:设定|提示词|模型|程序|生成)|(?:设定|提示词|模型|程序).{0,18}(?:生成|塑造|影响).{0,18}(?:愿望|欲望|感受|回应|回答|回复)/u.test(value);
  if (!disclosed) issues.push('missing_reality_disclosure');
  if (plan.promptOrigin && (!explained || misleading)) issues.push('missing_origin_explanation');
  if (misleading) issues.push('claims_independent_experience');
  return issues;
}
