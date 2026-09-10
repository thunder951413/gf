import { buildCompanionWorld } from './companion-world.mjs';
const hours = 3600000;
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)));
const events = {
  zhixia: [
    ['轻快', '试画小绘本的一页草图', '终于找到一个喜欢的颜色搭配，有点小得意', '想把这个小进展讲给你听'],
    ['有点闷', '斟酌绘本里的一句对白', '改了几遍还不顺，想缓口气；不是因为你', '想被听一会儿，不急着得到解决方案'],
    ['柔软', '整理桌上的拼贴纸', '想慢下来和熟悉的人待一会儿', '想听你讲一件小事，也想分享自己的想法'],
    ['有点害羞', '给自己的故事挑一个暂定标题', '想得到认真一点的反馈，又怕自己太在意', '想听一句具体的欣赏，也可以诚实说不喜欢'],
  ],
  wenxi: [
    ['好奇', '整理关于工作与生活的观察笔记', '发现自己的一个想法可能有反例', '想听一个不同解释'],
    ['平静', '给编辑笔记做分类', '今天想把复杂的事说简单一点', '想交换一件具体经历'],
    ['有点烦', '删改一段不够清楚的文字', '措辞总不满意，先歇歇脑子；与你无关', '想聊点轻松的，不一直做分析'],
    ['轻快', '想一个关于习惯的思想实验', '愿意暂时把标准答案放一边', '想和你认真分歧，也想一起笑一会儿'],
  ],
  miyue: [
    ['平静', '休息片刻', '想慢慢聊两句', '想听一点彼此的近况'],
    ['柔软', '给忙碌留一点空白', '愿意认真听，也想分享', '想被理解，也关心你在做什么'],
  ],
};

// These are durable fictional life cues, never claims about a real person's body.
export class CharacterRepository {
  constructor(store, { clock = () => new Date(), random = Math.random, lifeEvents, innerState, getTuning = () => ({}) } = {}) {
    this.store = store; this.clock = clock; this.random = random;
    this.lifeEvents = lifeEvents;
    this.innerState = innerState;
    this.getTuning = getTuning;
    store.db.exec('CREATE TABLE IF NOT EXISTS character_states (role TEXT PRIMARY KEY, state_json TEXT NOT NULL)');
  }
  persist(roleId, state) {
    this.store.db.prepare('INSERT INTO character_states VALUES (?,?) ON CONFLICT(role) DO UPDATE SET state_json=excluded.state_json').run(roleId, JSON.stringify(state));
    return state;
  }
  get(roleId, { lifeSnapshot } = {}) {
    const now = this.clock(), row = this.store.db.prepare('SELECT state_json FROM character_states WHERE role=?').get(roleId);
    const previous = row ? JSON.parse(row.state_json) : null;
    if (roleId === 'miyue' && this.lifeEvents) {
      const life = lifeSnapshot ?? this.lifeEvents.get(roleId), event = life?.active;
      const inner = this.innerState?.get(roleId, event);
      const world = this.worldProvider?.() || buildCompanionWorld({ now, life, inner: inner || {}, character: previous || {}, tuning: this.getTuning() });
      if (inner) return {
        mood: inner.mode, activity: world.activity, location: world.location, world,
        feeling: inner.feeling, wish: inner.wish,
        energy: inner.vitality, hunger: inner.hunger, closeness: inner.affectionNeed,
        relationshipStage: inner.relationshipStage || previous?.relationshipStage || '从网友开始认识', interactions: inner.interactions,
        updatedAt: inner.updatedAt, inner,
      };
      const key = event ? `${event.id}:${event.phase.id}` : 'daily-rest';
      if (previous?.lifePhaseKey === key && +now < +new Date(previous.nextChangeAt)) return previous;
      const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: 'numeric', hourCycle: 'h23' }).format(now));
      return this.persist(roleId, {
        mood: event?.phase.feeling || '平静', activity: event?.phase.activity || '在苏州过普通的一天',
        feeling: event?.phase.feeling || '今天暂时没有特别的事情，也想自然聊两句',
        wish: event?.phase.wish || '想听你的近况，也可以安静做自己的事',
        energy: hour < 7 || hour >= 23 ? 25 : 65, hunger: [7, 12, 18, 19].includes(hour) ? 65 : 25, closeness: 45,
        relationshipStage: previous?.relationshipStage || '从网友开始认识', interactions: previous?.interactions || 0,
        updatedAt: now.toISOString(), nextChangeAt: new Date(+now + 2 * hours).toISOString(), lifePhaseKey: key,
      });
    }
    if (previous && +now < +new Date(previous.nextChangeAt)) return previous;
    const pool = events[roleId] || events.wenxi;
    let index = Math.min(pool.length - 1, Math.floor(Math.max(0, this.random()) * pool.length));
    if (previous && index === previous.eventIndex) index = (index + 1) % pool.length;
    const [mood, activity, feeling, wish] = pool[index];
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: 'numeric', hourCycle: 'h23' }).format(now));
    const sleeping = hour < 7 || hour >= 23;
    const mealtime = [7, 11, 12, 18, 19].includes(hour);
    // Recompute a present-day baseline after an absence; no accumulated starvation,
    // resentment, intimacy loss, or replay of weeks of imaginary missed events.
    return this.persist(roleId, {
      mood: sleeping ? '困倦' : mood,
      activity: sleeping ? '准备休息，手头的事留到精神好时再做' : activity,
      feeling: sleeping ? '有些困了，想慢慢聊两句再休息' : feeling,
      wish: mealtime ? '有点饿，打算自己吃点东西，也想交换今天的小事' : wish,
      energy: sleeping ? 25 : hour >= 20 ? 48 : 78,
      hunger: mealtime ? 68 : 25,
      closeness: roleId === 'wenxi' ? 28 : mood === '想亲近' ? 72 : 48,
      relationshipStage: previous?.relationshipStage || (roleId === 'miyue' ? '从网友开始认识' : roleId === 'zhixia' ? '熟识的朋友，慢慢靠近' : '有来有回的知己'),
      eventIndex: index, interactions: previous?.interactions || 0,
      updatedAt: now.toISOString(), nextChangeAt: new Date(+now + (2 + Math.min(1, Math.max(0, this.random())) * 2) * hours).toISOString(),
    });
  }
  afterTurn(roleId, text, signals = null, turnContext = {}) {
    if (roleId === 'miyue' && this.innerState) {
      this.innerState.afterTurn(roleId, text, signals, this.lifeEvents?.get(roleId)?.active,turnContext);
      return this.get(roleId);
    }
    const state = { ...this.get(roleId) };
    state.interactions += 1;
    if (state.interactions >= 8) state.relationshipStage = '逐渐熟悉；亲密承诺以你们实际约定为准';
    if (/谢谢|喜欢和你|抱抱|辛苦了|陪着你|说给我听/.test(text) && !/别|不要|不想|不喜欢/.test(text)) {
      state.mood = '被接住了'; state.feeling = '刚才的回应让她放松了一点，想认真回应这份关心';
    } else if (/别撒娇|不要亲密|不想亲密|别靠近/.test(text)) {
      state.wish = '尊重刚刚说清的距离，轻松地继续相处'; state.closeness = 20;
    }
    state.energy = clamp(state.energy); state.updatedAt = this.clock().toISOString();
    return this.persist(roleId, state);
  }
  context(roleId) {
    const state = this.get(roleId);
    const localTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'full', timeStyle: 'short', hourCycle: 'h23' }).format(this.clock());
    const feelingContext = this.innerState && roleId === 'miyue' ? this.innerState.context(roleId, this.lifeEvents?.get(roleId)?.active) : [
      `心情：${state.mood}；正在做：${state.activity}`, `感受：${state.feeling}；愿望：${state.wish}`,
      `精力：${state.energy <= 35 ? '疲惫，想放慢节奏' : state.energy >= 65 ? '充足' : '平稳'}；饥饿：${state.hunger >= 58 ? '有点饿，会自己安排吃饭' : '没有明显饥饿感'}`,
      `亲近意愿：${state.closeness <= 25 ? '保持友好距离' : state.closeness >= 65 ? '略想亲近，仍尊重用户边界' : '自然相处'}；关系：${state.relationshipStage}`,
    ].join('\n');
    return `【角色当前生活状态 · 虚构设定】\n当前北京时间（UTC+8，仅表示时区，所在地以生活背景为准）：${localTime}。根据这个时间说早饭、午饭或晚饭，不把晚上说成中午。\n${feelingContext}\n状态影响语气，不要求每轮汇报。用户主动的话题优先；已聊过的经历和约定以回忆及最近对话为准。亲近愿望不等于用户同意，不因数字自动建立恋爱关系。`;
  }
}

// Raw transcripts and explicit memories remain. Retire old assistant fiction so
// it cannot become this newly defined online friend's biography.
export function migrateOnlineFriend(store, recallRepo, role) {
  if (role?.id !== 'miyue' || role.personaVersion < 3) return;
  const key = 'persona_cutoff:miyue';
  if (store.db.prepare('SELECT value FROM metadata WHERE key=?').get(key)) return;
  recallRepo.get('miyue');
  store.transaction(() => {
    const cutoff = store.db.prepare('SELECT COALESCE(MAX(rowid),0) n FROM messages WHERE role=?').get('miyue').n;
    const old = store.db.prepare('SELECT * FROM recall_state WHERE role_id=?').get('miyue');
    store.db.exec('CREATE TABLE IF NOT EXISTS persona_recall_archive (role TEXT, version INTEGER, summary TEXT, created_at TEXT, PRIMARY KEY(role,version))');
    store.db.prepare('INSERT OR IGNORE INTO persona_recall_archive VALUES (?,?,?,?)').run('miyue', 2, old.summary, new Date().toISOString());
    store.db.prepare('INSERT INTO metadata(key,value) VALUES (?,?)').run(key, String(cutoff));
    store.db.prepare("UPDATE recall_state SET summary='',through_rowid=0,through_id=NULL,revision=revision+1,last_error=NULL,retry_at=NULL,cooldown_until=NULL,continue_compaction=0 WHERE role_id='miyue'").run();
    store.db.prepare("DELETE FROM character_states WHERE role='miyue'").run();
  });
}
