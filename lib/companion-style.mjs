// A conservative revision hint, never a reason to drop sentences or fail a turn.
function decorativeCount(value) {
  const text = String(value || '').replace(/https?:\/\/\S+|```[\s\S]*?```/g, '');
  return text.split(/[。！？!?\n]/u).filter(line =>
    /(?:就像|好像|像|仿佛|好似|宛如)[^。！？!?\n]{0,24}(?:风|雨|月|星|灯|湖|海|窗|树|叶|橘|茶|云|花|盒子|墙|光|画|水|糖|春|夏|秋|冬|时间|平行|版本|天空|鸟|翅膀|滤镜)/u.test(line)
    || /(?:日子|时间|时光|河水|屋檐|文字|诗句|字|重力)[^。！？!?\n]{0,12}(?:记得|照顾|替.{0,5}留|住在|变暖|暖了|温软|懒得|长上)|(?:住在纸上|把.{0,12}(?:收进|放进).{0,6}盒子|诗句.{0,8}影子|心里.{0,8}(?:存|藏).{0,8}画|水.{0,10}抱着|感觉.{0,20}安放)/u.test(line)
  ).length;
}

export function plainSpeechIssues(reply, userText = '', previousReplies = []) {
  if (/(?:写|作).{0,8}(?:诗|散文)|用.{0,8}(?:比喻|拟人)|描述.{0,8}画面|诗意一点|文学一点/.test(userText) && !/别|不要|太多|少/.test(userText)) return [];
  const count=decorativeCount(reply), recent=previousReplies.slice(-2).some(decorativeCount);
  return count>1 || count>0&&recent ? ['too_many_decorative_comparisons'] : [];
}

export const PLAIN_SPEECH_REVISION = '这份草稿堆叠了装饰性比喻。保留刚才要回应的具体事和温柔态度，用平常说话的方式重写；不要加风、雨、灯、盒子等新意象，不用感动或总结关系代替接话。可以直接说想法、原因或下一步，不删掉话题中的有效信息。';

export function continuationIssues(reply, thread, userText = '') {
  if(!thread?.holdsTopic || /我先忙|先这样|回头聊|回来再聊|下次再聊|我要走了|晚安/.test(userText))return [];
  return /等你.{0,12}(?:回来|回家|结束).{0,18}(?:说|聊|讲|告诉|分享)|(?:回来|回头|下次)再.{0,12}(?:说|聊|讲|分享)/.test(String(reply)) ? ['premature_topic_closing'] : [];
}
