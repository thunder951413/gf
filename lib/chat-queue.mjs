import {randomUUID} from 'node:crypto';
import {MAX_UNANSWERED_MESSAGES} from './store.mjs';
const invalid=(message,status=400)=>Object.assign(new Error(message),{status,code:'CHAT_QUEUE_INVALID'});

// A rejected generated draft may improve on a fresh attempt. Retrying never
// bypasses validation; the existing durable budget also bounds model cost.
const AUTO_RETRY_CODES=new Set(['MODEL_NETWORK_ERROR','MODEL_TIMEOUT','MODEL_RATE_LIMITED','MODEL_UNAVAILABLE','MODEL_RESPONSE_INVALID','MODEL_REPLY_INVALID','COMPANION_BEHAVIOR_REJECTED']);
const NEVER_RETRY_CODES=new Set(['DIALOGUE_POLICY_REJECTED','MODEL_AUTH_FAILED','MODEL_QUOTA_EXCEEDED','MODEL_REQUEST_REJECTED','MODEL_NOT_CONFIGURED','MODEL_CONFIG_INVALID','MODEL_CANCELLED','STALE_MEMORY','STALE_LIFE_THREAD_PLAN','STALE_COMPANION_TUNING','STALE_DIALOGUE_POLICY','SCENARIO_CHOICE_STALE']);
const cleanCode=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,63}$/.test(value)?value:null;
const cleanIssueCode=value=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)?value:null;
const upstreamStatus=error=>{
  const value=error?.upstreamStatus??error?.providerStatus;
  return Number.isInteger(value)&&value>=100&&value<=599?value:null;
};
const issueCodes=error=>{
  const values=error?.issueCodes??error?.issues;
  if(!Array.isArray(values))return [];
  return values.map(value=>cleanIssueCode(typeof value==='string'?value:value?.code)).filter(Boolean).slice(0,10);
};
const canAutoRetry=error=>{
  const code=cleanCode(error?.code);
  if(NEVER_RETRY_CODES.has(code)||error?.status===409||error?.retryable===false)return false;
  if(error?.retryable===true)return true;
  if(AUTO_RETRY_CODES.has(code))return true;
  return code==='MODEL_REQUEST_FAILED'&&upstreamStatus(error)===null;
};
const errorMessage=(error,{retrying=false,exhausted=false,retryCount=0,maxRetries=0}={})=>{
  const code=cleanCode(error?.code);
  let message;
  if(code==='DIALOGUE_POLICY_REJECTED')message='草稿未通过本次相处偏好检查，消息已保留，可以重试。';
  else if(code==='COMPANION_BEHAVIOR_REJECTED')message='草稿未通过本次回复检查，消息已保留，可以重试或取消。';
  else if(code==='MODEL_AUTH_FAILED')message='模型认证失败，请检查接口密钥后重试。';
  else if(code==='MODEL_QUOTA_EXCEEDED')message='模型额度不足，请补充额度或更换接口后重试。';
  else if(code==='MODEL_REQUEST_REJECTED')message='模型服务未接受请求，请检查模型名称和接口设置。';
  else if(['MODEL_NOT_CONFIGURED','MODEL_CONFIG_INVALID','INVALID_URL'].includes(code))message='模型配置不可用，请检查接口地址和模型设置。';
  else if(['MODEL_RESPONSE_INVALID','MODEL_REPLY_INVALID','MODEL_RESPONSE_TOO_LARGE','MODEL_OUTPUT_LIMIT'].includes(code))message='模型回复格式异常，消息已保留，可以重试或取消。';
  else if(code==='MODEL_RATE_LIMITED')message='模型服务当前请求较多，消息已保留。';
  else if(['MODEL_NETWORK_ERROR','MODEL_TIMEOUT','MODEL_UNAVAILABLE','MODEL_REQUEST_FAILED'].includes(code))message='模型服务暂时无法连接，消息已保留。';
  else if(code==='DAILY_MEMORY_NOT_READY')message='晨间历史整理尚未通过检查，输入已保留；后台整理完成后会继续回复，也可重试或取消。';
  else if(code==='SESSION_REVISION_FAILED')message='草稿发现事实或接续偏差，修正尚未通过核对，输入已保留。';
  else if(error?.status===409||code?.startsWith('STALE_'))message='对话状态已经更新，消息已保留，请稍后重试。';
  else message='这次没有回复成功，消息已保留，可以重试或取消。';
  if(retrying)return `${message} 正在自动重试（${retryCount}/${maxRetries}）。`;
  return exhausted?`${message} 已自动重试 ${retryCount} 次，仍未成功，可以手动重试或取消。`:message;
};
export class ChatQueue {
  constructor(store,{execute,debounceMs=1200,retryDelaysMs=[2000,5000],onSubmit=()=>{}}){
    this.store=store;this.execute=execute;this.debounceMs=debounceMs;this.retryDelaysMs=retryDelaysMs.filter(value=>Number.isFinite(value)&&value>=0);this.onSubmit=onSubmit;this.running=new Map();this.timers=new Map();this.stopped=false;
    store.db.exec(`CREATE TABLE IF NOT EXISTS chat_queue(role_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,state TEXT NOT NULL,items TEXT NOT NULL,options TEXT NOT NULL,error TEXT,ready_at INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS chat_receipts(id TEXT PRIMARY KEY,role_id TEXT NOT NULL,created_at TEXT NOT NULL);CREATE TABLE IF NOT EXISTS chat_failures(id INTEGER PRIMARY KEY AUTOINCREMENT,role_id TEXT NOT NULL,revision INTEGER NOT NULL,error_code TEXT,upstream_status INTEGER,issue_codes TEXT NOT NULL,retry_count INTEGER NOT NULL,scheduled INTEGER NOT NULL,created_at TEXT NOT NULL);`);
    const columns=new Set(store.db.prepare('PRAGMA table_info(chat_queue)').all().map(column=>column.name));
    if(!columns.has('retry_count'))store.db.exec('ALTER TABLE chat_queue ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0');
    if(!columns.has('error_code'))store.db.exec('ALTER TABLE chat_queue ADD COLUMN error_code TEXT');
    if(!columns.has('next_retry_at'))store.db.exec('ALTER TABLE chat_queue ADD COLUMN next_retry_at INTEGER');
  }
  row(role){return this.store.db.prepare('SELECT * FROM chat_queue WHERE role_id=?').get(role);}
  get(role){const r=this.row(role);return r?{role,revision:r.revision,phase:r.state,items:JSON.parse(r.items),error:r.error,errorCode:r.error_code,retryCount:r.retry_count,maxRetries:this.retryDelaysMs.length,nextRetryAt:r.next_retry_at?new Date(r.next_retry_at).toISOString():null}: {role,revision:0,phase:'idle',items:[],error:null,errorCode:null,retryCount:0,maxRetries:this.retryDelaysMs.length,nextRetryAt:null};}
  busy(role){if(role)return ['queued','retrying','compressing','generating','waiting','failed'].includes(this.get(role).phase);return this.store.db.prepare("SELECT 1 FROM chat_queue WHERE state IN ('queued','retrying','compressing','generating','waiting','failed') LIMIT 1").get()!=null;}
  submit(role,text,clientId,options={}){
    if(this.stopped)throw invalid('服务正在停止，请稍后再试',503);
    if(typeof clientId!=='string'||! /^[a-zA-Z0-9_-]{8,100}$/.test(clientId))throw invalid('消息标识无效');
    const receipt=this.store.db.prepare('SELECT role_id FROM chat_receipts WHERE id=?').get(clientId);if(receipt){if(receipt.role_id!==role)throw invalid('消息标识已使用');return this.get(role);}
    const current=this.get(role);const items=current.phase==='idle'?[]:current.items;
    if(items.length>=10||items.reduce((n,i)=>n+i.text.length,0)+text.length>10000)throw invalid('这一轮消息有些多，请等她回复或取消后再发送');
    if(current.phase!=='idle'&&options.contentId===undefined){const prior=JSON.parse(this.row(role).options);if(prior.contentId)options={...options,contentId:prior.contentId};}
    const revision=current.revision+1,updated=[...items,{id:clientId,text,createdAt:this.store.now()}];
    this.store.transaction(()=>{this.store.db.prepare('INSERT INTO chat_receipts VALUES(?,?,?)').run(clientId,role,new Date().toISOString());this.store.db.prepare("INSERT INTO chat_queue(role_id,revision,state,items,options,error,ready_at,retry_count,error_code,next_retry_at) VALUES(?,?,'queued',?,?,NULL,?,0,NULL,NULL) ON CONFLICT(role_id) DO UPDATE SET revision=excluded.revision,state=excluded.state,items=excluded.items,options=excluded.options,error=NULL,ready_at=excluded.ready_at,retry_count=0,error_code=NULL,next_retry_at=NULL").run(role,revision,JSON.stringify(updated),JSON.stringify(options),Date.now()+this.debounceMs);this.store.setChatChannel(role,options.replyChannel);this.onSubmit(role);});
    this.running.get(role)?.controller.abort();clearTimeout(this.timers.get(role));this.timers.delete(role);this.schedule(role);return this.get(role);
  }
  retry(role){const r=this.row(role);if(!r||r.state!=='failed')throw invalid('没有需要重试的消息');this.store.db.prepare("UPDATE chat_queue SET state='queued',revision=revision+1,error=NULL,ready_at=?,retry_count=0,error_code=NULL,next_retry_at=NULL WHERE role_id=?").run(Date.now()+this.debounceMs,role);this.schedule(role);return this.get(role);}
  cancel(role){this.running.get(role)?.controller.abort();clearTimeout(this.timers.get(role));this.timers.delete(role);this.store.db.prepare("UPDATE chat_queue SET state='idle',revision=revision+1,items='[]',error=NULL,retry_count=0,error_code=NULL,next_retry_at=NULL WHERE role_id=?").run(role);return this.get(role);}
  schedule(role){clearTimeout(this.timers.get(role));if(this.stopped)return;const r=this.row(role);if(!r||!['queued','retrying'].includes(r.state))return;this.timers.set(role,setTimeout(()=>{this.timers.delete(role);void this.run(role);},Math.max(0,r.ready_at-Date.now())));}
  recordFailure(role,row,error,scheduled,retryCount){
    this.store.db.prepare('INSERT INTO chat_failures(role_id,revision,error_code,upstream_status,issue_codes,retry_count,scheduled,created_at) VALUES(?,?,?,?,?,?,?,?)').run(role,row.revision,cleanCode(error?.code),upstreamStatus(error),JSON.stringify(issueCodes(error)),retryCount,scheduled?1:0,new Date().toISOString());
    this.store.db.prepare('DELETE FROM chat_failures WHERE id NOT IN (SELECT id FROM chat_failures ORDER BY id DESC LIMIT 200)').run();
  }
  async run(role){if(this.stopped||this.running.has(role))return;const row=this.row(role);if(!row||!['queued','retrying'].includes(row.state))return;const controller=new AbortController();const current=()=>!controller.signal.aborted&&this.row(role)?.revision===row.revision;this.store.db.prepare("UPDATE chat_queue SET state='generating',next_retry_at=NULL WHERE role_id=? AND revision=? AND state IN ('queued','retrying')").run(role,row.revision);
    const work=(async()=>{try{const items=JSON.parse(row.items);await this.execute({role,text:items.map(i=>i.text).join('\n'),userTexts:items.map(i=>i.text),...JSON.parse(row.options)},{signal:controller.signal,isCurrent:current,startedAt:Date.parse(items[0].createdAt),userCreatedAts:items.map(i=>i.createdAt),segmented:true,markPhase:phase=>{if(current())this.store.db.prepare('UPDATE chat_queue SET state=? WHERE role_id=? AND revision=?').run(phase,role,row.revision);},afterSave:()=>{if(!current())throw invalid('已有更新的消息',409);this.store.db.prepare("UPDATE chat_queue SET state='idle',items='[]',error=NULL,retry_count=0,error_code=NULL,next_retry_at=NULL WHERE role_id=? AND revision=?").run(role,row.revision);}});}
      catch(error){
        const durable=this.row(role);
        if(!current()||!durable||durable.revision!==row.revision||durable.state==='idle')return;
        const code=cleanCode(error?.code),retryCount=durable.retry_count||0;
        if(canAutoRetry(error)&&retryCount<this.retryDelaysMs.length){const nextCount=retryCount+1,retryAfterMs=Number.isFinite(error?.retryAfterMs)?Math.min(120000,Math.max(0,error.retryAfterMs)):0,nextRetryAt=Date.now()+Math.max(this.retryDelaysMs[retryCount],retryAfterMs);const message=errorMessage(error,{retrying:true,retryCount:nextCount,maxRetries:this.retryDelaysMs.length});this.store.transaction(()=>{this.store.db.prepare("UPDATE chat_queue SET state='retrying',error=?,error_code=?,ready_at=?,retry_count=?,next_retry_at=? WHERE role_id=? AND revision=?").run(message,code,nextRetryAt,nextCount,nextRetryAt,role,row.revision);this.recordFailure(role,row,error,true,nextCount);});}
        else {const exhausted=canAutoRetry(error)&&this.retryDelaysMs.length>0&&retryCount>=this.retryDelaysMs.length,message=errorMessage(error,{exhausted,retryCount,maxRetries:this.retryDelaysMs.length});this.store.transaction(()=>{this.store.db.prepare("UPDATE chat_queue SET state='failed',error=?,error_code=?,next_retry_at=NULL WHERE role_id=? AND revision=?").run(message,code,role,row.revision);this.recordFailure(role,row,error,false,retryCount);});}
      }
    })();this.running.set(role,{controller,promise:work});await work;this.running.delete(role);this.schedule(role);
  }
  start(){this.stopped=false;for(const row of this.store.db.prepare("SELECT * FROM chat_queue WHERE state IN ('queued','retrying','compressing','generating','waiting')").all()){if(row.state!=='retrying')this.store.db.prepare("UPDATE chat_queue SET state='queued',ready_at=?,next_retry_at=NULL WHERE role_id=?").run(Date.now()+this.debounceMs,row.role_id);this.schedule(row.role_id);}}
  async stop(){this.stopped=true;for(const timer of this.timers.values())clearTimeout(timer);this.timers.clear();for(const task of this.running.values())task.controller.abort();await Promise.all([...this.running.values()].map(t=>t.promise.catch(()=>{})));}
}
export function splitReply(text,mode='companion'){
  if(text.includes('```'))return [text];const target=mode==='scenario'?450:mode==='information'?260:130;
  const pieces=text.match(/[^。！？!?\n]+[。！？!?]*\n*|\n+/gu)||[text];const result=[];let current='';
  for(const piece of pieces){if(current&&current.length+piece.length>target&&result.length<MAX_UNANSWERED_MESSAGES-1){result.push(current.trim());current='';}current+=piece;}
  if(current.trim())result.push(current.trim());return result.filter(Boolean).length?result.filter(Boolean):[text];
}
export class ReplyDelivery {
  constructor(store,{onDelivery=()=>{},random=Math.random}={}){this.store=store;this.onDelivery=onDelivery;this.random=random;store.db.exec(`CREATE TABLE IF NOT EXISTS reply_delivery(id TEXT PRIMARY KEY,role_id TEXT NOT NULL,text TEXT NOT NULL,scope TEXT,due_at INTEGER NOT NULL,state TEXT NOT NULL);`);if(!store.db.prepare('PRAGMA table_info(reply_delivery)').all().some(c=>c.name==='reply_channel'))store.db.exec("ALTER TABLE reply_delivery ADD COLUMN reply_channel TEXT NOT NULL DEFAULT 'desktop'");}
  enqueue(role,parts,scope=null,replyChannel='desktop'){let at=Date.now();for(const text of parts){at+=1200+Math.floor(this.random()*1600);this.store.db.prepare("INSERT INTO reply_delivery(id,role_id,text,scope,due_at,state,reply_channel) VALUES(?,?,?,?,?,'pending',?)").run(randomUUID(),role,text,scope,at,replyChannel === 'weixin' ? 'weixin' : 'desktop');}}
  pending(role){return Number(this.store.db.prepare("SELECT count(*) n FROM reply_delivery WHERE role_id=? AND state='pending'").get(role).n);}
  cancel(role){this.store.db.prepare("UPDATE reply_delivery SET state='cancelled' WHERE role_id=? AND state='pending'").run(role);}
  tick(){
    const roles=this.store.db.prepare("SELECT DISTINCT role_id FROM reply_delivery WHERE state='pending' AND due_at<=?").all(Date.now());
    for(const {role_id:role}of roles){
      let message,scope;
      this.store.transaction(()=>{
        const pending=this.store.db.prepare("SELECT * FROM reply_delivery WHERE role_id=? AND state='pending' ORDER BY due_at,rowid").all(role);
        if(!pending.length||pending[0].due_at>Date.now())return;
        const remaining=MAX_UNANSWERED_MESSAGES-this.store.unansweredAssistantCount(role);
        if(remaining<=0){this.cancel(role);return;}
        const row=pending[0];scope=row.scope;
        // Older versions persisted up to four chunks. Use the last available
        // message for all remaining text with the same provenance and route.
        const batch=[row];
        if(remaining===1)for(const next of pending.slice(1)){
          if(next.scope!==row.scope||next.reply_channel!==row.reply_channel)break;
          batch.push(next);
        }
        message=this.store.addAssistantMessage(role,batch.map(part=>part.text).join('\n'),row.reply_channel);
        if(row.scope)this.store.db.prepare('INSERT INTO scenario_message_scope VALUES(?,?)').run(message.id,row.scope);
        for(const part of batch)this.store.db.prepare("UPDATE reply_delivery SET state='sent' WHERE id=?").run(part.id);
        if(remaining===1){this.cancel(role);return;}
        const rest=this.store.db.prepare("SELECT id FROM reply_delivery WHERE role_id=? AND state='pending' ORDER BY due_at,rowid").all(role);
        let next=Date.now();for(const r of rest){next+=1200+Math.floor(this.random()*1600);this.store.db.prepare('UPDATE reply_delivery SET due_at=? WHERE id=?').run(next,r.id);}
      });
      if(message)this.onDelivery(message,scope);
    }
  }
  start(){this.timer=setInterval(()=>{try{this.tick();}catch{}},300);this.timer.unref();}
  stop(){clearInterval(this.timer);}
}
