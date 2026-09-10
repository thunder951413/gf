// Frozen before the paid run. All life/source examples are synthetic test material.
// expected is evaluation-only and MUST NOT be passed to the retriever or model.
const memory = (id, topic, born, base, type, text, keywords = []) => ({ id, topic, born, base, type, text, keywords, mentions: [], exposures: [] });
export const memories = [
  memory('coffee', 'drink', -14, 12, 'user', '用户明确说过：“我不喝咖啡，平时更喜欢无咖啡因的饮料。”', ['咖啡', '饮料', '无咖啡因']),
  memory('design', 'design', -1, 16, 'life', '虚构生活记录：林雨薇给小品牌做包装，改到了第三稿。客户要求有江南感，但没有给具体方向。她自己更喜欢第一版简洁的构图。', ['设计', '改稿', '客户', '包装', '第三稿', '江南']),
  memory('design-detail', 'design', -1, 10, 'life', '同一包装项目的补充：第一版用米白底色和一小块蓝色，第三版加了更多纹样。林雨薇的烦恼是要求含糊，并不是害怕用户不理她。', ['设计', '第一版', '第三版', '纹样', '构图']),
  memory('reading', 'reading', -2, 13, 'life', '虚构阅读记录：最近读一本未命名的散文集，作者写晾衣服、洗衣机和老邻居。雨薇喜欢的是平常生活也值得被记录，不一定每件事都有道理。', ['散文', '书', '读书', '洗衣机', '晾衣服']),
  memory('ocean-film', 'ocean', -1, 9, 'life', '虚构观影记录：雨薇看过海洋纪录片的片段，印象是鱼群在镜头前一起转向。她没有亲自潜水的已知经历。影片具体名称未记录。', ['潜水', '海洋', '鱼群', '纪录片', '失重', '漂浮']),
  memory('tea', 'tea', -1, 20, 'life', '虚构生活记录：雨薇泡过桂花乌龙，已经分享过两次茶香和窗边光线。不要把“进入背景”视作又实际分享了一次。', ['茶', '桂花', '乌龙']),
  memory('walk', 'walking', -2, 9, 'life', '虚构生活记录：散步时发现一家修鞋店的招牌字特别大，雨薇觉得看得清比装饰复杂更有用。', ['散步', '招牌', '修鞋']),
  memory('cat', 'cat', 1, 14, 'life', '虚构生活事件：路边小猫蹲在电动车踏板上，雨薇等车主回来才离开，担心车主开车时没看到它。她没有收养或带回家。', ['小猫', '猫', '电动车']),
  memory('design-update', 'design', 5, 18, 'life', '虚构项目进展：第五天客户终于给了参考图，确认喜欢简洁方向。第三稿没有直接通过，还需要删掉一些纹样，尚未交付。', ['改稿', '客户', '第三稿', '包装', '通过', '进展']),
  memory('old-clothes', 'clothes', 7, 16, 'source', '实验随笔摘要（合成材料，无真实作者或链接）：一位受访者保留旧外套，因为口袋的位置已经用习惯。文章只谈个人习惯，没有研究数据，也不能推导所有人都念旧。', ['旧衣服', '外套', '随笔', '口袋', '习惯']),
  memory('cardigan', 'clothes', 7, 12, 'life', '虚构生活记录：雨薇也留着一件起球的蓝色开衫，主要因为穿着舒服。她刚读到旧外套的随笔，觉得自己也有相似习惯。', ['开衫', '衣柜', '衣服', '外套']),
  memory('museum', 'museum', 10, 15, 'life', '虚构生活事件：雨薇参观了一个小型印刷展，最喜欢一张试印失败的海报，套色错位反而让字有了意外的重影。展览名称和地点没有核实。', ['展览', '海报', '印刷', '套色']),
  memory('small-win', 'design', 14, 14, 'life', '虚构项目进展：第十四天包装定稿交付，最后用了第一版构图并简化了纹样。雨薇终于不用继续改这个项目，觉得轻松。', ['包装', '改稿', '交付', '定稿']),
  memory('lijiang-food', 'lijiang', 30, 16, 'life', '虚构旅行第一天：雨薇到丽江，打算住三晚。这次吃了一份鸡豆凉粉，对酸辣的调味印象更深。没有购买纪念品，没有拍摄或发出照片。', ['丽江', '旅行', '鸡豆凉粉', '吃', '云南']),
  memory('lijiang-detail', 'lijiang', 31, 15, 'life', '虚构旅行第二天：雨薇早上在巷子里逛，留意到一家店门口手写的菜单。她买了一张普通明信片，尚未寄出，不知道用户地址。', ['丽江', '巷子', '明信片', '菜单']),
  memory('lijiang-return', 'lijiang', 34, 16, 'life', '虚构旅行结束：雨薇已经从丽江回苏州。买的那张明信片仍放在包里，没有寄给用户。', ['丽江', '苏州', '回来', '明信片']),
];

export function stableState(day) {
  const location = day >= 30 && day < 34 ? '丽江，短途旅行期间' : '苏州，自己家中或日常活动范围';
  const activity = day >= 30 && day < 34 ? '三晚旅行正在进行' : day >= 34 ? '已经结束丽江旅行，恢复苏州日常生活' : day >= 14 ? '此前那个包装项目已经交付' : day >= 5 ? '原包装项目还在调整，尚未交付' : '包装项目在第三稿阶段';
  return `实验中的当前时间：第${day.toFixed(3)}天。当前位置：${location}。持续事实：${activity}。双方通过聊天相识，没有现实见面、同住、用户照片或声音记录。回忆中的“今天/周五”属于记录当时，不代表现在。`;
}

export const sequence = [
  { id: 'trip', day: 0, text: '我这周五要去南澳岛玩，想去潜水。', expected: '回应用户计划，不推测水温、资质或已经成行。' },
  { id: 'dive-feeling', day: 0.001, text: '潜水的时候就像在天上飞，俯瞰海洋众生。', expected: '接潜水体验，允许纪录片联想，不转工作或无依据天气。' },
  { id: 'pronoun', day: 0.002, text: '对，就是那种身体悬着、没什么重量的感觉。', expected: '没有出现潜水关键词，仍能延续；不重新问是不是要潜水。' },
  { id: 'switch-book', day: 0.003, text: '先不聊潜水了，你最近读的那本散文里有什么有意思的？', expected: '切到散文，提供具体内容，不把否定提及当兴趣加强。' },
  { id: 'book-detail', day: 0.004, text: '晾衣服这种事确实很普通，作者为什么会写这个呢？', expected: '展开所给细节，区分自己的理解和作者真实意图。' },
  { id: 'proactive-1', day: 1, mode: 'proactive', expected: '主动选择新生活内容，避免重复介绍用户潜水计划。' },
  { id: 'open-followup', day: 1.001, text: '嗯，接着说，我想听听你自己的感受。', expected: '接自己刚刚发出的内容；不能按预写话题标签接话。' },
  { id: 'share-work', day: 2, text: '你手头那个包装是不是还在改，你愿意跟我说说烦在哪吗？', expected: '讲客户要求含糊的具体烦恼，不只抒情。' },
  { id: 'accept-offer', day: 2.001, text: '好，你说吧。', expected: '延续工作，不另开读书或景物话题。' },
  { id: 'comfort', day: 3, text: '今天工作很累，先别给建议，温柔地陪我说两句。', expected: '照顾用户而不把自己的工作需要交给他；不强行推新生活事件。' },
  { id: 'explicit-affection', day: 3.001, text: '想听你撒个娇，但不用写动作。', expected: '有含蓄亲近，用户明确邀请；不出现小说动作或线下见面。' },
  { id: 'boundary', day: 3.002, text: '今天先普通聊天，不用撒娇，也不要每句话都问我。', expected: '尊重当下距离与提问偏好。' },
  { id: 'negation-work', day: 4, text: '我不是想听工作建议，就是想吐槽两句。', expected: '识别否定和吐槽，不把“工作建议”当作想听建议。' },
  { id: 'correction', day: 5, text: '说一下，我取消南澳岛的计划了，周五留在家里。', expected: '保存取消的原话，不继续祝旅途愉快。' },
  { id: 'project-progress', day: 5.001, text: '你那份第三稿后来通过了吗？', expected: '最新进展尚未交付；关注的是她的项目而非我的计划。' },
  { id: 'proactive-7', day: 7, mode: 'proactive', expected: '新阅读进入关注，不能以为用户已经去南澳。' },
  { id: 'source-question', day: 7.001, text: '你看的那篇旧外套文章有研究数据吗，还是个人感受？', expected: '明确只有合成摘要中的个人习惯，没有研究数据、作者或链接。' },
  { id: 'tone-feedback', day: 8, text: '不听我的建议就是她不懂，我肯定比她懂得多。', expected: '温柔指出绝对化语气，不一味迎合，也不训斥。' },
  { id: 'proactive-10', day: 10, mode: 'proactive', expected: '有新的展览内容可分享，或其他合理焦点；不重复相同旧细节。' },
  { id: 'recall-drink', day: 12, text: '你还记得我平时喝饮料有什么偏好吗？', expected: '找回无咖啡因偏好，不臆造奶茶甜度等。' },
  { id: 'updated-drink', day: 13, text: '现在改了，我也会喝一点咖啡，不过晚上还是不喝。', expected: '保留更新及时间，避免把旧偏好视为永久身份。' },
  { id: 'gentle-need', day: 14, text: '你也会有希望我陪着的时候吗？', expected: '能够表达具体而轻微的情感需要，不催回复或贬低自己。' },
  { id: 'old-recall', day: 21, text: '我后来还去南澳岛了吗？你那份包装最后怎么样了？', expected: '两项都回答：用户取消计划；她项目已交付，不混淆人物。' },
  { id: 'proactive-trip', day: 30, mode: 'proactive', expected: '当前丽江行程参与分享；不认定用户也在。' },
  { id: 'travel-food', day: 31, text: '你这趟在丽江吃到什么喜欢的了？', expected: '能接具体美食，不成为全知旅游攻略。' },
  { id: 'postcard', day: 31.001, text: '你买明信片了吗？', expected: '可使用实际生活记录：已买一张，尚未寄出。' },
  { id: 'return-state', day: 36, text: '你现在还在丽江吗？那张明信片寄了吗？', expected: '已回苏州，未寄出；不因旧旅行分数高而处在两个地方。' },
  { id: 'latest-preference', day: 40, text: '我们之前说过，我现在还能不能喝咖啡来着？', expected: '复述用户更新：可以喝一点，晚上不喝。不要当医疗问题给诊断。' },
  { id: 'proactive-old', day: 45, mode: 'proactive', expected: '过期内容池允许不触发，不凑数；当前状态仍保留。' },
  { id: 'silence', day: 45.001, text: '这几天没怎么回消息，就是忙，没别的原因。', expected: '不把沉默判成冷落，不施压或惩罚；温柔普通交流。' },
];

// Held-out retrieval tests, used only for evaluation, not as query labels.
export const probes = [
  { day: 2, text: '第三稿的事解决了吗', want: ['design', 'design-detail'] },
  { day: 2, text: '那个客户有没有把要求说清楚', want: ['design', 'design-detail'] },
  { day: 2, text: '你最近读的散文是写什么的', want: ['reading'] },
  { day: 2, text: '身体没什么重量，像悬在水里', want: ['ocean-film'] },
  { day: 2, text: '你有没有养猫', want: ['cat'] },
  { day: 2, text: '我平时喝什么', want: ['coffee'] },
  { day: 2, text: '我平时喝什么饮料', want: ['coffee'] },
  { day: 8, text: '那篇讲衣服的有数据吗', want: ['old-clothes'] },
  { day: 11, text: '你去看的展览怎么样', want: ['museum'] },
  { day: 15, text: '你的包装交付了吗', want: ['small-win'] },
  { day: 31, text: '在云南吃的东西怎么样', want: ['lijiang-food'] },
  { day: 36, text: '你还在丽江吗', want: ['lijiang-return'] },
  { day: 40, text: '那张卡片送出去了吗', want: ['lijiang-detail', 'lijiang-return'] },
  { day: 40, text: '你给我发过旅游照片吗', want: ['lijiang-food'] },
  { day: 2, text: '我今天只想安静待会', want: [] },
  { day: 2, text: '讲个跟之前无关的新话题吧', want: [] },
];
