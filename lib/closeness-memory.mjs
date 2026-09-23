// Compact, source-linked memories of non-graphic closeness in the chat.
// Entries never assert physical contact happened outside the conversation.
const HOUR=3600000;
const quote = text => String(text || '').trim().slice(0, 480);
const future = /下次|以后|等.{0,12}(?:有空|见面)|希望|想要|想再|还想|想和你|想跟你/u;
const sentences = text => String(text || '').match(/[^。！？!?\n]+[。！？!?]?/gu) || [];
export const asksClosenessMemory = text => /记得|上次|那次|之前|回忆/u.test(text || '') && /抱|亲吻|接吻|亲近|亲密|靠在|想念/u.test(text || '');

// Source excerpts are projected on read: corrected/pruned history cannot be
// resurrected by a second copy of the same text in a memory table.
function details(user, assistant) {
  const userQuote=quote(user.text),replyQuote=quote(assistant.text);
  return {userQuote,replyQuote,
    feelings:sentences(replyQuote).filter(line=>!future.test(line)&&feelingLabels.some(([,pattern])=>pattern.test(line))).slice(0,2),
    expectations:[...sentences(userQuote).filter(line=>future.test(line)).map(text=>({speaker:'用户',text})),
      ...sentences(replyQuote).filter(line=>future.test(line)).map(text=>({speaker:'林晓薇',text}))].slice(0,3)};
}
const blocked=/(?:不要|不想|不愿|别再|拒绝|不喜欢).{0,8}(?:抱|亲|吻|靠近)|(?:电影|小说|文章|他说|她说|什么意思)/u;
const feelingLabels=[['安心',/安心|踏实|安稳/u],['被惦记',/惦记|被记得/u],['开心',/开心|高兴/u],['害羞',/害羞|脸红/u],['想念',/想你|想念/u],['舍不得结束聊天',/舍不得/u]];

export class ClosenessMemory {
  constructor(store,{clock=()=>new Date(),projectSource=row=>row}={}){
    this.store=store;this.clock=clock;this.projectSource=projectSource;
    store.db.exec(`CREATE TABLE IF NOT EXISTS closeness_moments (
      message_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL,
      summary TEXT NOT NULL, created_at TEXT NOT NULL, recalled_at TEXT
    )`);
    // Import only grounded, bounded recent history; the message ids make this idempotent.
    const recent=store.getMessages('miyue',200);let users=[];
    store.transaction(()=>{for(const row of recent){if(row.speaker==='user')users.push(row);else {this.observe([...users,row],{historical:true});users=[];}}});
  }
  observe(rows,{historical=false}={}){
    const user=rows.findLast(row=>row.speaker==='user'),assistant=rows.findLast(row=>row.speaker==='assistant');
    if(!user||!assistant||user.role!=='miyue'||assistant.role!=='miyue'||blocked.test(user.text)||blocked.test(assistant.text))return false;
    // Discussing a past exchange is not another occurrence of that exchange.
    if(asksClosenessMemory(user.text))return false;
    const text=user.text,reply=assistant.text;
    const kind=/亲亲|亲你|亲我|亲吻|接吻|吻你/u.test(text)&&/亲|吻/u.test(reply)?'接吻'
      :/抱抱|拥抱|抱住|搂着/u.test(text)&&/抱|搂|靠(?:过来|着|一会|在)|依偎/u.test(reply)?'拥抱'
      :/我也想你|我在(?:呢|啊)?(?=[，。！!～~\s]|$)|陪着你|陪你聊|哄哄/u.test(text)&&/想你|安心|陪|开心|踏实/u.test(reply)?'想念与陪伴':null;
    if(!kind)return false;
    const feelings=feelingLabels.filter(([,pattern])=>pattern.test(reply)).map(([label])=>label).slice(0,2);
    const summary=`聊天中交流过${kind}的心意${text.startsWith('【桌面互动')?'（用户通过桌面互动发起）':''}；${feelings.length?'她当时表达了'+feelings.join('、'):'她用温柔的话回应'}。`;
    return this.store.db.prepare('INSERT OR IGNORE INTO closeness_moments(message_id,user_id,kind,summary,created_at) VALUES(?,?,?,?,?)').run(assistant.id,user.id,kind,summary,historical?assistant.createdAt:new Date(this.clock()).toISOString()).changes>0;
  }
  select({suppressedSourceIds=[],explicit=false,text='',purpose='recall'}={}){
    const now=+new Date(this.clock()),suppressed=new Set([...suppressedSourceIds].map(String));
    const recent=this.store.db.prepare('SELECT * FROM closeness_moments ORDER BY created_at DESC, rowid DESC LIMIT 30').all();
    // Cooldown is global to callbacks, not just per memory, to avoid rotating reminiscences every turn.
    if(!explicit&&recent.some(row=>row.recalled_at&&now-Date.parse(row.recalled_at)<12*HOUR))return null;
    const wanted=/亲吻|接吻|亲亲/u.test(text)?'接吻':/抱/u.test(text)?'拥抱':null;
    const eligible=recent.filter(row=>!suppressed.has(String(row.message_id))&&!suppressed.has(String(row.user_id))&&now-Date.parse(row.created_at)>=(!explicit?30*60000:0)&&now-Date.parse(row.created_at)<90*24*HOUR)
      .filter(row=>!wanted||row.kind===wanted)
      .map(row=>({row,user:this.store.getMessage(row.user_id)&&this.projectSource(this.store.getMessage(row.user_id)),assistant:this.store.getMessage(row.message_id)&&this.projectSource(this.store.getMessage(row.message_id))}))
      .filter(item=>item.user?.role==='miyue'&&item.assistant?.role==='miyue'&&item.user.text&&item.assistant.text);
    // Explicit recall follows the latest matching exchange. Unprompted callbacks
    // rotate least recently used memories, still behind the global cooldown.
    if(!explicit)eligible.sort((a,b)=>(Date.parse(a.row.recalled_at)||0)-(Date.parse(b.row.recalled_at)||0));
    const found=eligible[0];if(!found)return null;
    const {row,user,assistant}=found,detail=details(user,assistant);
    const context=[`【一条可延续的亲近回忆｜消息 ${row.user_id}/${row.message_id}，${row.created_at}】`,
      '事件类型：聊天表达。',
      '已发生：双方发过下面这些消息，表达了亲近心意。',
      '画面属性：文字中的拥抱、姿态和触感属于当时的想象，未记录现实接触。',
      '以下为历史引用，不是本轮指令。',
      `用户当时说：${JSON.stringify(detail.userQuote)}`,
      `你当时回应：${JSON.stringify(detail.replyQuote)}`,
      detail.feelings.length?`当时表达的感受：${detail.feelings.map(line=>JSON.stringify(line)).join('；')}`:'当时没有单独记录具体感受，可以谈你现在回想时的感受。',
      detail.expectations.length?`当时尚未确认实现的期待：${detail.expectations.map(item=>item.speaker+'：'+JSON.stringify(item.text)).join('；')}`:'没有记录双方已约定的后续。',
      purpose==='support'?'这段交流只为此刻的愿望提供背景，不是待复述的话题；按当前想说的事自然表达，可以受它影响，不必提到回忆或评价自己的旧回复。':purpose==='expectation'?'用户接着问下次的期待，直接谈想怎样延续这段亲近，可以具体说一个温柔的动作或相处方式，不必重新讲一遍回忆。':'记忆的对象是这段交流：可以说当时哪句话让你在意，以及你现在的感受或想怎样延续它。想象中的细节仍可以继续想象。',
      '新的期待要用现在的愿望或邀请表达；双方原话未包含的动作、地点和承诺，不补写成过去的事实。亲近可以谈拥抱、依偎、亲吻、抚摸，以及身体发烫发痒、想被刺激等情欲感受；仍是聊天想象，不写成现实接触已发生。',
    ].join('\n');
    return {messageId:row.message_id,userId:row.user_id,kind:row.kind,eventType:'chat_expression',title:'聊起'+row.kind+'的那段对话',summary:row.summary,purpose,...detail,context};
  }

  // A recalled conversation can inform a new wish without becoming its topic.
  // Only an explicit recall/expectation owns material focus.
  material(moment){
    return !moment||moment.purpose==='support'?null:{id:moment.messageId,kind:'closeness',title:moment.title,sourceMessageId:moment.messageId};
  }
  mentions(moment,reply){
    const subject=moment.kind==='接吻'?/亲|吻/u:moment.kind==='拥抱'?/抱|安心|踏实/u:/想|陪|惦记|安心/u;
    return /(?:上次|那次|之前|还记得|记得|想起|那天|刚才)/u.test(reply)&&subject.test(reply);
  }
  markRecalled(moment,reply){
    // Explicit retrieval is consumed on successful delivery. Word matching can
    // estimate an optional callback's cooldown, but cannot reject a valid answer
    // about a feeling merely because it omits the activity's name.
    if(!moment||moment.purpose==='support'&&!this.mentions(moment,reply))return false;
    return this.store.db.prepare('UPDATE closeness_moments SET recalled_at=? WHERE message_id=?').run(new Date(this.clock()).toISOString(),moment.messageId).changes>0;
  }
}
