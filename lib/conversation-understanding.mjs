// Small, explicit language signals determine permissions, not a guessed hidden
// motive. Unclear messages stay open for the dialogue model to understand.
const withoutQuotes = text => String(text || '').replace(/[“「『][^”」』]*[”」』]/gu, '').replace(/"[^"\n]*"/gu, '');
const closeness = /抱|亲(?:你|我|吻|近)|接吻|依偎|靠近|牵手|握.{0,6}手|体香|香味/u;
const imagined = /梦里|想象|脑补|假如|要是|如果|就像|比如|(?:我|你|咱们|我们).{0,12}(?:想|会).{0,10}(?:抱|亲|吻|靠)/u;
const boundary = /(?:不要|不想|别|停止).{0,8}(?:暧昧|撒娇|亲密|亲近|抱我|亲我)|保持距离|普通朋友/u;
const responseRequest = /具体|细节|画面|念头|感受|内心|小心愿|你会|你想|下次/u;

export function understandTurn(text, conversation = []) {
  const current = withoutQuotes(text).trim();
  const recent = conversation.filter(row => row.speaker === 'user').slice(-2);
  const previous = withoutQuotes(recent.at(-1)?.text || '');
  const declined = boundary.test(current);
  const priorImagined = imagined.test(previous) && closeness.test(previous);
  const romanticImagination = !declined && (
    imagined.test(current) && closeness.test(current) && /你|我们|咱们/u.test(current)
    || priorImagined && responseRequest.test(current)
  );
  const correction = /我是顺着|不是.{0,12}(?:在说|让你|要你|这个意思|那个意思)|你.{0,6}(?:误会|理解错|没理解)|不愿意满足我的小心愿/u.test(current);
  const reflection = /人和人|人们|双方|对方|一般来说|往往|所谓|(?:我觉得|我认为).{0,12}(?:有时|有时候|有的人|很多人|一般)|(?:讨论|谈谈|聊聊).{0,8}(?:看法|观点)/u.test(current)
    && !/我(?:刚|昨天|今天|这次|上次).{0,12}(?:遇到|发生|经历|被|跟.{0,5}吵)/u.test(current);
  const adviceRequested = /怎么办|(?:有什么|给我|帮我|想听|想要|需要).{0,24}(?:建议|办法|方案)|帮我.{0,12}(?:解决|想办法|选择)|要注意什么|需要.{0,4}(?:注意|准备)|怎么(?:处理|缓解|解决|选)|教教我/u.test(current)
    && !/(?:别|不用|不要).{0,6}(?:建议|办法|教我|提醒)/u.test(current);
  const emotionalDetail = /(?:你|自己).{0,12}(?:念头|感受|内心)|(?:画面|具体).{0,12}(?:靠近|抱|亲)|你会想怎么/u.test(current);
  return {
    kind: declined ? 'boundary' : romanticImagination ? 'imagined_closeness' : correction ? 'correction' : reflection ? 'reflection' : adviceRequested ? 'help' : 'open',
    romanticImagination, correction, adviceRequested, emotionalDetail,
    // These identify what was explicitly signalled; they do not assert an
    // event occurred or that the user has an undisclosed emotional problem.
    reality: romanticImagination ? 'imagined' : 'unspecified',
  };
}

export function understandingContext(frame) {
  if (!frame) return '';
  const kind = {
    imagined_closeness: '用户邀请你参与温柔的亲近想象。顺着想象说自己的反应、想做的动作或愿望，用假设和期待的语气；这不是一次需要核实的现实接触，也不改变双方现实地点或经历。',
    correction: '用户正在核对或更正相关内容。这是待回应的请求，不是已证实的上一轮错误。依据当前原话和所给记录核对后回答；用户明确更新的个人事实以最新说法为准，已有错误则直接更正。',
    reflection: '本轮在交流一个看法。围绕观点说出自己的理解或不同想法；没有证据表明用户遇到了相应的私人遭遇。',
    help: '用户明确在求助，针对所问的问题给有用的回答。',
    boundary: '以用户原话明确限制的互动为准，不扩大限制范围，也不由这个分类推断关系降温。否定疏远、讨论措辞不是要求疏远。',
    conversation_preference: '用户在调整聊天方式或愿意聊的话题。按原话调整眼前的回应，这不表示他要求拉开关系或亲密距离；不需要长篇解释自己的聊天习惯。',
    open: '先理解当前这句话的意思，保留用户没有说明的部分；分享动态本身不是请求管理生活，也不等于道别。',
  }[frame.kind];
  return ['【本轮语境】', kind,
    frame.correction && frame.kind !== 'correction' ? '用户也在核对或更正上一条回应。这是待回应的请求，不是已证实的答偏；依据当前原话和所给记录回答，用户明确更新的个人事实以最新说法为准，已有错误则直接更正。' : '',
    frame.emotionalDetail ? '用户要了解你的内心与具体反应。说是什么触动了你、你怎样想或想怎样靠近；从合适的一点展开，不用一串情绪形容词代替内容。' : '',
  ].filter(Boolean).join('\n');
}
