// Compact, source-linked memories of non-graphic closeness in the chat.
// Entries never assert physical contact happened outside the conversation.
const HOUR=3600000;
const blocked=/(?:不要|不想|不愿|别再|拒绝|不喜欢).{0,8}(?:抱|亲|吻|靠近)|(?:电影|小说|文章|他说|她说|什么意思)/u;
const feelingLabels=[['安心',/安心|踏实|安稳/u],['被惦记',/惦记|被记得/u],['开心',/开心|高兴/u],['害羞',/害羞|脸红/u],['想念',/想你|想念/u],['舍不得结束聊天',/舍不得/u]];

export class ClosenessMemory {
  constructor(store,{clock=()=>new Date()}={}){
    this.store=store;this.clock=clock;
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
    if(!user||!assistant||user.role!=='miyue'||blocked.test(user.text)||blocked.test(assistant.text))return false;
    const text=user.text,reply=assistant.text;
    const kind=/亲亲|亲你|亲我|亲吻|接吻|吻你/u.test(text)&&/亲|吻/u.test(reply)?'接吻'
      :/抱抱|拥抱|抱住|搂着/u.test(text)&&/抱|搂/u.test(reply)?'拥抱'
      :/我也想你|我在(?:呢|啊)?(?=[，。！!～~\s]|$)|陪着你|陪你聊|哄哄/u.test(text)&&/想你|安心|陪|开心|踏实/u.test(reply)?'想念与陪伴':null;
    if(!kind)return false;
    const feelings=feelingLabels.filter(([,pattern])=>pattern.test(reply)).map(([label])=>label).slice(0,2);
    const summary=`聊天中交流过${kind}的心意${text.startsWith('【桌面互动')?'（用户通过桌面互动发起）':''}；${feelings.length?'她当时表达了'+feelings.join('、'):'她用温柔的话回应'}。`;
    return this.store.db.prepare('INSERT OR IGNORE INTO closeness_moments(message_id,user_id,kind,summary,created_at) VALUES(?,?,?,?,?)').run(assistant.id,user.id,kind,summary,historical?assistant.createdAt:new Date(this.clock()).toISOString()).changes>0;
  }
  select({suppressedSourceIds=[],explicit=false}={}){
    const now=+new Date(this.clock()),suppressed=new Set([...suppressedSourceIds].map(String));
    const recent=this.store.db.prepare('SELECT * FROM closeness_moments ORDER BY created_at DESC, rowid DESC LIMIT 30').all();
    // Cooldown is global to callbacks, not just per memory, to avoid rotating reminiscences every turn.
    if(!explicit&&recent.some(row=>row.recalled_at&&now-Date.parse(row.recalled_at)<12*HOUR))return null;
    const found=recent.find(row=>!suppressed.has(String(row.message_id))&&!suppressed.has(String(row.user_id))&&this.store.getMessage(row.message_id)&&this.store.getMessage(row.user_id)&&now-Date.parse(row.created_at)>=(!explicit?30*60000:0)&&now-Date.parse(row.created_at)<90*24*HOUR);
    if(!found)return null;
    return {messageId:found.message_id,userId:found.user_id,kind:found.kind,summary:found.summary,context:`【一条可延续的亲近回忆｜消息 ${found.user_id}/${found.message_id}，${found.created_at}】\n${found.summary} 这是远程聊天里的表达，不是真实见面。本轮用一句自己的感受自然提及这次交流，再回应当下；不照抄，不扩写未记录的动作，不假定用户这次仍然同意。`};
  }
  issues(moment,reply){
    if(!moment)return [];
    const subject=moment.kind==='接吻'?/亲|吻/u:moment.kind==='拥抱'?/抱|安心|踏实/u:/想|陪|惦记|安心/u;
    return /(?:上次|那次|之前|还记得|记得|想起|那天|刚才)/u.test(reply)&&subject.test(reply)?[]:['missing_closeness_callback'];
  }
  markRecalled(moment,reply){
    if(!moment||this.issues(moment,reply).length)return false;
    return this.store.db.prepare('UPDATE closeness_moments SET recalled_at=? WHERE message_id=?').run(new Date(this.clock()).toISOString(),moment.messageId).changes>0;
  }
}
