const PUBLIC_DESTINATIONS = Object.freeze(['苏州', '扬州', '南京', '无锡', '杭州', '丽江', '大理', '成都', '泉州']);
const PUBLIC_DESTINATION_SET = new Set(PUBLIC_DESTINATIONS);

const TRAVEL_ANGLES = [
  { id: 'food', title: '地方味道与饮食习惯', label: '美食 饮食文化', guidance: '从一道常见食物、口味差异或吃饭方式切入，谈它怎样映出当地人的生活节奏。' },
  { id: 'culture', title: '地方文化如何留在日常里', label: '地方文化 日常生活', guidance: '挑一种仍能在街巷、手艺或节庆中看见的文化痕迹，给出自己的观察，再问对方会留意什么。' },
  { id: 'daily-life', title: '游客视线外的日常生活', label: '城市生活 街巷', guidance: '观察菜场、通勤、邻里空间或一天的作息，聊一座城真正适合生活的部分。' },
  { id: 'history', title: '历史怎样塑造今天的城市', label: '城市历史 人文', guidance: '选一个历史留下的城市性格或空间习惯，谈过去如何仍影响今天，避免堆砌年代。' },
  { id: 'nature', title: '自然环境与城市气质', label: '自然 地理', guidance: '从山水、气候或地貌谈它如何影响食物、建筑和人的活动方式。' },
  { id: 'tourism-tradeoffs', title: '旅行体验与旅游发展的取舍', label: '旅游 文化保护', guidance: '具体谈便利、商业化、居民生活和文化保护之间的一组取舍，并自然邀请对方说说更看重哪一边。' },
  { id: 'architecture', title: '建筑与公共空间里的地方性', label: '建筑 公共空间', guidance: '从一类建筑、街道尺度或公共空间谈地方感怎样被保存或改变。' },
  { id: 'rhythm', title: '适合慢下来感受的城市节奏', label: '旅行 城市观察', guidance: '给出一种不赶景点的体验方式，聊慢旅行会让人看见哪些容易错过的细节。' },
];

const ORDINARY_ANGLES = {
  meal: [
    ['comfort', '一顿饭为什么让人安定', '饮食 生活', '从温度、味道或一起吃饭的氛围谈一顿普通饭如何改变一天的情绪。'],
    ['choice', '今天吃什么背后的选择', '饮食习惯', '谈方便、营养、价格和想吃之间的小取舍，并邀请对方说说自己的判断。'],
    ['memory', '味道带回来的记忆', '食物 记忆', '选一种熟悉味道，聊它为什么比照片更容易把人带回某段生活。'],
    ['ritual', '普通餐桌上的小仪式', '餐桌文化', '观察摆盘、顺序或固定搭配如何让日常吃饭有一点郑重。'],
  ],
  cooking: [
    ['improvise', '做饭时的临场发挥', '家常菜 烹饪', '从缺一种材料时怎样调整，聊经验、直觉和菜谱各自的用处。'],
    ['process', '让人放松的烹饪步骤', '烹饪 生活', '挑洗切煮中的一个具体动作，谈重复劳动为什么有时能整理情绪。'],
    ['waste', '把边角料认真吃完', '食材 节约', '给出一种利用剩余食材的思路，聊节约与好吃怎样同时成立。'],
    ['sharing', '为别人做饭时会改变什么', '家常菜 分享', '谈口味、分量和心意如何因用餐对象而变化。'],
  ],
  clothing: [
    ['weather', '衣服与身体感受', '穿衣 生活', '从温度、材质或活动场景谈一件衣服为什么穿得舒服比看起来合适更复杂。'],
    ['identity', '穿衣表达的分寸', '服饰文化', '聊颜色或轮廓怎样表达心情，同时给自己留下不被风格定义的空间。'],
    ['repair', '旧衣物值得留下的理由', '衣物 修补', '从一次修补或重复穿着谈物品寿命与感情价值。'],
    ['occasion', '场合如何影响穿着选择', '服饰 礼仪', '谈得体、自在和个人表达之间的一次具体权衡。'],
  ],
  commute: [
    ['rhythm', '通勤如何切换一天的状态', '通勤 城市生活', '观察路上的声音、光线或固定动作，聊它怎样帮助人进入或离开工作状态。'],
    ['space', '移动中的个人空间', '公共交通 城市生活', '谈拥挤环境里人们如何用耳机、目光和距离维护边界。'],
    ['route', '熟路里仍会出现的新细节', '城市观察 街道', '从一次绕路或新发现切入，聊熟悉是否会让人忽略身边。'],
    ['tradeoff', '速度与舒适的通勤取舍', '通勤 交通', '比较快、便宜、少换乘或能步行的一组选择，并邀请对方说更重视什么。'],
  ],
  hobby: [
    ['beginner', '保留一点生疏的乐趣', '兴趣 学习', '谈不追求熟练时，兴趣为什么更容易带来好奇和恢复感。'],
    ['practice', '重复练习何时开始有回报', '兴趣 练习', '从一个微小进步聊耐心怎样形成，避免把爱好说成任务。'],
    ['taste', '兴趣怎样慢慢长出审美', '兴趣 审美', '谈比较不同作品或做法后，个人偏好如何变得更清楚。'],
    ['time', '给爱好留时间的现实办法', '兴趣 时间', '给出一种短而可持续的安排，聊完整大块时间是否真的必要。'],
  ],
  family: [
    ['care', '家人表达关心的不同方式', '家庭 沟通', '从一句提醒或一个动作谈关心为什么有时听起来不像关心。'],
    ['boundary', '亲近关系里的边界', '家庭 关系', '谈分享与保留之间的一次具体分寸，邀请对方说怎样才算舒服。'],
    ['tradition', '家庭习惯如何被保留下来', '家庭 习惯', '从一道菜、一个称呼或节日做法聊家庭记忆如何延续。'],
    ['change', '长大后重新认识家人', '家庭 成长', '谈角色变化如何让人看见家人过去未曾理解的一面。'],
  ],
  work: [
    ['craft', '把工作做好的具体标准', '工作 方法', '从一个细节谈完成与做好之间的差别，以及标准该由谁决定。'],
    ['focus', '注意力被打断之后', '工作 专注', '给出一种恢复思路，聊频繁切换如何影响判断和情绪。'],
    ['meaning', '普通工作里的意义感', '工作 价值', '从对他人真正有用的一小部分切入，聊意义是否需要宏大目标。'],
    ['boundary', '工作与生活的边界', '工作 生活', '谈结束一天工作的具体信号，以及边界在现实中为什么会移动。'],
  ],
  local_walk: [
    ['detail', '熟悉街区里的新细节', '苏州 街巷', '观察一扇门、一块招牌或一种声音，聊慢走如何改变对熟悉地方的认识。'],
    ['change', '街区变化带来的得失', '苏州 城市生活', '从一家店或一段路的变化谈便利、记忆和社区关系的取舍。'],
    ['season', '季节如何改变同一条路', '苏州 四季', '从植物、光线或人的活动聊季节怎样重写熟悉的空间。'],
    ['public-life', '街道怎样容纳公共生活', '苏州 公共空间', '观察停留、交谈或休息发生在哪里，聊什么样的街道让人愿意慢下来。'],
  ],
  reading: [
    ['idea', '一个观点怎样改变看法', '阅读 思考', '挑一个可争论的观点，先给出自己的理解，再邀请对方补充或反驳。'],
    ['character', '人物为什么会做出那个选择', '阅读 人物', '从处境和代价分析一个选择，区分理解人物与赞同人物。'],
    ['pace', '读得慢是否也是收获', '阅读 方法', '谈停下来重读、做记号或走神时，阅读体验发生了什么。'],
    ['afterlife', '一本书读完以后留下什么', '阅读 生活', '从一个持续想起的画面或问题聊作品如何进入日常。'],
  ],
  emotional_need: [
    ['name', '给情绪找到更准确的名字', '情绪 觉察', '区分疲惫、委屈、焦虑或孤单，聊命名为什么会让需要变清楚。'],
    ['rest', '休息怎样才真的有效', '休息 情绪', '比较独处、睡眠、散步或聊天带来的不同恢复，并邀请对方说当下更需要哪种。'],
    ['ask', '怎样开口表达需要', '沟通 情绪', '给出一种具体而不指责的表达，聊坦白与负担别人之间的担心。'],
    ['self-kindness', '对自己宽一点的实际做法', '自我关怀', '从降低一个要求或允许一次停顿谈自我体谅如何落到行动上。'],
  ],
};

function ordinaryAngles(category) {
  const entries = ORDINARY_ANGLES[category] || [
    ['experience', '这件小事带来的具体感受', '日常生活', '从一个具体细节谈它怎样影响当下的心情或判断。'],
    ['choice', '日常选择里的取舍', '生活方式', '谈这件事里便利、感受和长期习惯之间的一组取舍。'],
    ['connection', '小事怎样连接人与生活', '生活观察', '观察这件事与身边的人、空间或习惯有什么联系。'],
  ];
  return entries.map(([id, title, label, guidance]) => ({ id, title, label, guidance }));
}

function safeEvent(event) {
  if (!event || typeof event !== 'object' || event.id == null) return null;
  return {
    id: String(event.id),
    type: event.type === 'travel' ? 'travel' : 'ordinary',
    category: typeof event.category === 'string' ? event.category : 'ordinary',
    destination: typeof event.destination === 'string' ? event.destination.trim() : '',
    title: typeof event.title === 'string' ? event.title.trim() : '',
    fictionalCanon: event.fictionalCanon !== false,
  };
}

function resultForNoEvent() {
  return { context: '', topicKey: null, sourceHints: [], publicQuery: null, angle: null, angles: [], eventKey: null };
}

export { PUBLIC_DESTINATIONS, TRAVEL_ANGLES, ORDINARY_ANGLES };

export class LifeTopicRepository {
  constructor(store, { clock = () => new Date() } = {}) {
    if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('store with db and transaction is required');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    this.store = store;
    this.clock = clock;
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS life_topic_events (
        role_id TEXT NOT NULL,
        event_key TEXT NOT NULL,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(role_id, event_key)
      );
      CREATE TABLE IF NOT EXISTS life_topic_deliveries (
        role_id TEXT NOT NULL,
        topic_key TEXT NOT NULL,
        event_key TEXT NOT NULL,
        angle_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        delivered_at TEXT NOT NULL,
        PRIMARY KEY(role_id, topic_key)
      );
      CREATE INDEX IF NOT EXISTS life_topic_deliveries_event
        ON life_topic_deliveries(role_id, event_key, delivered_at);
    `);
  }

  get(event, roleId = 'miyue') {
    if (roleId !== 'miyue') return null;
    const incoming = safeEvent(event);
    if (!incoming) return resultForNoEvent();
    return this.store.transaction(() => {
      const now = new Date(this.clock());
      if (Number.isNaN(now.getTime())) throw new TypeError('clock must return a valid date');
      this.store.db.prepare(`
        INSERT OR IGNORE INTO life_topic_events(role_id,event_key,event_json,created_at)
        VALUES(?,?,?,?)
      `).run(roleId, incoming.id, JSON.stringify(incoming), now.toISOString());
      const stored = JSON.parse(this.store.db.prepare(
        'SELECT event_json FROM life_topic_events WHERE role_id=? AND event_key=?',
      ).get(roleId, incoming.id).event_json);
      const angles = stored.type === 'travel' ? TRAVEL_ANGLES : ordinaryAngles(stored.category);
      const delivered = new Set(this.store.db.prepare(
        'SELECT angle_id FROM life_topic_deliveries WHERE role_id=? AND event_key=?',
      ).all(roleId, stored.id).map((row) => row.angle_id));
      const angle = angles.find((candidate) => !delivered.has(candidate.id)) || null;
      const topicKey = angle ? `life-topic:${stored.id}:${angle.id}` : null;
      const place = stored.type === 'travel' ? stored.destination : '苏州';
      const publicPlace = PUBLIC_DESTINATION_SET.has(place) ? place : '';
      const sourceHints = angle
        ? [...new Set([publicPlace, ...angle.label.split(/\s+/)].filter(Boolean))]
        : [];
      const publicQuery = angle && publicPlace ? `${publicPlace} ${angle.label}` : null;
      const background = stored.type === 'travel'
        ? `林雨薇最近的生活背景围绕${stored.destination || '异地'}旅行；旅行阶段并不决定谈话主题。`
        : `林雨薇正在经历一件“${stored.category}”类日常小事${stored.title ? `：${stored.title}` : '。'}`;
      const prompt = angle
        ? `可以围绕“${angle.title}”自然聊开。${angle.guidance}`
        : '这件事可继续作为谈话背景，但相关角度已经聊过，不必立刻重置或重复开场。';
      const context = [
        '【林雨薇的生活话题背景】',
        background,
        prompt,
        '说出一个具体观察或有分寸的个人看法，再自然邀请对方回应；不要写成行程、阶段或系统状态汇报，也不要假定用户的口味和偏好。',
        '林雨薇的生活事件属于虚构连续性；若使用检索到的城市、食物或文化资料，应明确当作现实世界资料，不要说成她亲身验证过的事实。',
      ].join('\n');
      return {
        context,
        topicKey,
        sourceHints,
        publicQuery,
        angle: angle ? { id: angle.id, title: angle.title } : null,
        angles: angles.map((candidate) => ({ id: candidate.id, title: candidate.title, shared: delivered.has(candidate.id) })),
        eventKey: stored.id,
      };
    });
  }

  markDelivered(roleId, topicKey, messageId) {
    if (roleId !== 'miyue' || typeof topicKey !== 'string' || !messageId) return false;
    const prefix = 'life-topic:';
    const separator = topicKey.lastIndexOf(':');
    if (!topicKey.startsWith(prefix) || separator <= prefix.length || separator === topicKey.length - 1) return false;
    const eventKey = topicKey.slice(prefix.length, separator);
    const angleId = topicKey.slice(separator + 1);
    return this.store.transaction(() => {
      const row = this.store.db.prepare(
        'SELECT event_json FROM life_topic_events WHERE role_id=? AND event_key=?',
      ).get(roleId, eventKey);
      if (!row) return false;
      const event = JSON.parse(row.event_json);
      const angles = event.type === 'travel' ? TRAVEL_ANGLES : ordinaryAngles(event.category);
      const delivered = new Set(this.store.db.prepare(
        'SELECT angle_id FROM life_topic_deliveries WHERE role_id=? AND event_key=?',
      ).all(roleId, eventKey).map((delivery) => delivery.angle_id));
      const pending = angles.find((angle) => !delivered.has(angle.id));
      if (!pending || pending.id !== angleId || topicKey !== `life-topic:${eventKey}:${pending.id}`) return false;
      const at = new Date(this.clock());
      if (Number.isNaN(at.getTime())) throw new TypeError('clock must return a valid date');
      return this.store.db.prepare(`
        INSERT OR IGNORE INTO life_topic_deliveries(role_id,topic_key,event_key,angle_id,message_id,delivered_at)
        VALUES(?,?,?,?,?,?)
      `).run(roleId, topicKey, eventKey, angleId, String(messageId), at.toISOString()).changes === 1;
    });
  }
}
