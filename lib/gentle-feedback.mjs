const HOUR = 3600000;
// Conservative cues from the current utterance, not a personality score.
const cues = [
  ['替别人决定', /(?:你|他|她)(?:只管|必须|就该|就得)(?:听我的|照我说的做)|(?:别问|不用想|别想那么多)[，, ]*(?:听我的|照做)/],
  ['轻视别人', /(?:你|他|她|他们|她们|别人)(?:懂什么|什么都不懂|就是(?:废物|蠢货|傻子))|(?:一群|都是)(?:废物|蠢货|傻子)/],
  ['把自己当成唯一标准', /(?:只有我|除了我)(?:才)?(?:懂|会|能)|(?:你们|他们|别人)(?:都|根本)?(?:不配|没资格)(?:评价|说话|反驳)/],
  ['否定感受', /(?:你|他|她)(?:就是|只是|太)(?:矫情|玻璃心)|这有什么好(?:难过|委屈|生气)的/],
];
export class GentleFeedbackRepository {
  constructor(store,{clock=()=>new Date()}={}) { this.store=store;this.clock=clock;store.db.exec('CREATE TABLE IF NOT EXISTS gentle_feedback(role_id TEXT PRIMARY KEY, turns INTEGER NOT NULL DEFAULT 0, last_turn INTEGER, last_at TEXT)'); }
  plan(roleId,text) {
    const row=this.store.db.prepare('SELECT * FROM gentle_feedback WHERE role_id=?').get(roleId)||{turns:0};
    const now=new Date(this.clock());
    const recent=row.last_at && (now-new Date(row.last_at)<6*HOUR || row.turns-row.last_turn<6);
    const source=String(text||'');
    // Quoted examples and requests for self-reflection deserve a direct answer,
    // not an automatic warning that treats the quoted speech as the user's view.
    const discussing=/[“”「」『』"]|是不是|这样说|怎么说|如何表达|帮我改|他说|她说|对方说|不该|不应该|别说/.test(source);
    const match=!recent&&!discussing ? cues.map(([kind,pattern])=>({kind,evidence:source.match(pattern)?.[0]})).find(item=>item.evidence) : null;
    return {roleId,turn:row.turns+1,offer:Boolean(match),context:match ? `【本轮相处提示】当前一句话“${match.evidence}”可能让人感到${match.kind}。先理解他表达的意思，再温柔、简短地说出这句话给你的感受，提醒部分最多一句、不超过45字；不要展开分析，不猜测他的动机，不用“被掐住”等强烈比喻，不另写第二段建议。不要说他这个人爹味、自大或有问题，不要求道歉，不审问；顺势继续原话题。这个提示不是人格判断。` : recent ? '【本轮相处提示】最近已经提过表达方式，当前不要再次主动纠正或说教；用户主动问沟通建议时可以直接回答。' : ''};
  }
  commit(plan) {
    if(!plan?.roleId)return;
    this.store.db.prepare(`INSERT INTO gentle_feedback(role_id,turns,last_turn,last_at) VALUES(?,?,?,?) ON CONFLICT(role_id) DO UPDATE SET turns=excluded.turns,last_turn=COALESCE(excluded.last_turn,gentle_feedback.last_turn),last_at=COALESCE(excluded.last_at,gentle_feedback.last_at)`).run(plan.roleId,plan.turn,plan.offer?plan.turn:null,plan.offer?new Date(this.clock()).toISOString():null);
  }
}
