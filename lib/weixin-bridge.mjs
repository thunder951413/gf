import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const KEY='weixin_bridge_v1', ROLE='miyue';
const defaults={enabled:false,proactiveEnabled:true,cursor:'',messageCursor:0,session:0};
const hash=value=>createHash('sha256').update(value).digest('hex');
const fail=(message,status=400)=>Object.assign(new Error(message),{status,code:'WEIXIN_INVALID'});
const iso=ms=>new Date(ms).toISOString();
const same=(a,b)=>String(a||'').toLowerCase()===String(b||'').toLowerCase();

/** One private WeChat peer, one existing character, one durable chat history. */
export class WeixinBridge {
  constructor(store,{client,submit,isBusy=()=>false,hasPendingReplies=()=>false,clock=()=>new Date(),intervalMs=1200,getChatError=()=>null}={}){
    Object.assign(this,{store,db:store.db,client,submit,isBusy,hasPendingReplies,clock,intervalMs,getChatError});
    this.stopped=true;this.login=null;this.connected=false;this.pollTask=null;this.tickTask=null;
    this.db.exec(`CREATE TABLE IF NOT EXISTS weixin_inbox(
      id TEXT PRIMARY KEY,session INTEGER NOT NULL,text TEXT NOT NULL,state TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS weixin_outbox(
      id TEXT PRIMARY KEY,session INTEGER NOT NULL,message_ids TEXT NOT NULL,text TEXT NOT NULL,
      kind TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL DEFAULT 0,expires_at INTEGER NOT NULL,error TEXT,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS weixin_outbox_state ON weixin_outbox(state,next_at);`);
    // A crashed POST may already have arrived. Do not blindly replay it.
    this.db.prepare("UPDATE weixin_outbox SET state='uncertain',error='上次发送中断，无法确认微信是否收到，未自动重复发送' WHERE state='sending'").run();
  }
  now(){return +this.clock();}
  read(){try{return {...defaults,...JSON.parse(this.db.prepare('SELECT value FROM metadata WHERE key=?').get(KEY)?.value||'{}')};}catch{return {...defaults};}}
  write(patch){const value={...this.read(),...patch};this.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(KEY,JSON.stringify(value));return value;}
  latestRow(){return Number(this.db.prepare('SELECT COALESCE(MAX(rowid),0) AS n FROM messages').get().n);}
  snapshot(){
    const c=this.read(),counts=this.db.prepare('SELECT state,count(*) AS n FROM weixin_outbox WHERE session=? GROUP BY state').all(c.session);
    const count=states=>counts.filter(x=>states.includes(x.state)).reduce((n,x)=>n+x.n,0);
    return {role:ROLE,roleName:'林晓薇',enabled:c.enabled,proactiveEnabled:c.proactiveEnabled,configured:Boolean(c.token&&c.userId),connected:this.connected,
      state:c.lastErrorCode==='auth_expired'?'auth_expired':!c.token?'unbound':!c.enabled?'paused':this.connected?'connected':'connecting',
      accountLabel:c.userId?'已绑定你的微信':null,lastError:c.lastError||this.getChatError()||null,lastInboundAt:c.lastInboundAt||null,lastOutboundAt:c.lastOutboundAt||null,
      pendingCount:count(['pending','sending','waiting_context']),failedCount:count(['failed','uncertain']),
      login:this.login?{status:this.login.status,...(this.login.qrcode?{qrcodeUrl:'/api/weixin/login/qr.png?v='+hash(this.login.qrcode).slice(0,12)}:{}),error:this.login.error||null}:null};
  }
  updateSettings(patch){
    if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.entries(patch).some(([key,value])=>!['enabled','proactiveEnabled'].includes(key)||typeof value!=='boolean'))throw fail('微信设置只能修改接入开关和主动消息开关');
    const c=this.read();
    this.store.transaction(()=>{
      this.write({...patch,...(patch.enabled===true&&!c.enabled?{messageCursor:this.latestRow(),lastError:null,lastErrorCode:null}:{})});
      if(patch.enabled===false)this.db.prepare("UPDATE weixin_outbox SET state='cancelled' WHERE state IN ('pending','waiting_context')").run();
      if(patch.proactiveEnabled===false)this.db.prepare("UPDATE weixin_outbox SET state='cancelled' WHERE kind='proactive' AND state IN ('pending','waiting_context')").run();
    });
    if(patch.enabled===false){this.pollAbort?.abort();this.sendAbort?.abort();this.connected=false;}else this.ensurePolling();
    return this.snapshot();
  }
  async beginLogin(){
    if(this.login?.status==='requesting')throw fail('正在生成二维码，请稍候',409);
    this.loginAbort?.abort();this.loginAbort=new AbortController();const controller=this.loginAbort;
    this.login={status:'requesting'};
    try{
      const result=await this.client.startLogin({signal:controller.signal});
      if(controller.signal.aborted)return this.snapshot();
      this.login={status:'waiting',qrcode:result.qrcode,qrContent:result.qrcodeUrl,expiresAt:this.now()+5*60_000};
      this.loginTask=this.watchLogin(controller).catch(()=>{});
    }catch(error){if(!controller.signal.aborted)this.login={status:'error',error:error.message||'生成二维码失败'};}
    return this.snapshot();
  }
  async watchLogin(controller){
    while(!controller.signal.aborted&&this.login?.qrcode&&this.now()<this.login.expiresAt){
      try{
        const result=await this.client.pollLogin(this.login.qrcode,{signal:controller.signal});
        if(controller.signal.aborted)return;
        if(result.status==='confirmed'){
          if(!result.botToken||!result.botId||!result.userId)throw fail('微信未返回完整的绑定身份，请重新扫码');
          this.bind(result);this.login={status:'confirmed'};return;
        }
        if(['expired','error'].includes(result.status)){this.login={status:result.status,error:result.error||'二维码已失效，请重新生成'};return;}
        if(['scaned_but_redirect','binded_redirect'].includes(result.status)){this.login={status:'error',error:'微信要求切换绑定服务，请重新开始配对'};return;}
        if(['need_verifycode','verify_code_blocked'].includes(result.status)){this.login={status:'error',error:'微信要求额外验证码，请在微信完成验证后重新生成二维码'};return;}
        this.login.status=['scanned','scaned'].includes(result.status)?'scanned':'waiting';
      }catch(error){if(controller.signal.aborted)return;this.login={status:'error',error:error.message||'微信绑定失败，请重试'};return;}
      await delay(1000,undefined,{signal:controller.signal}).catch(()=>{});
    }
    if(!controller.signal.aborted&&this.login?.status!=='confirmed')this.login={status:'expired',error:'二维码已过期，请重新生成'};
  }
  bind({botToken,botId,userId,baseUrl}){
    this.pollAbort?.abort();this.sendAbort?.abort();this.connected=false;
    this.store.transaction(()=>{
      this.db.prepare("UPDATE weixin_outbox SET state='cancelled' WHERE state NOT IN ('sent','expired','cancelled')").run();
      this.db.prepare("UPDATE weixin_inbox SET state='cancelled' WHERE state='pending'").run();
      this.write({...defaults,enabled:true,token:botToken,botId,userId,baseUrl,session:this.read().session+1,messageCursor:this.latestRow(),contextToken:null,lastError:null,lastErrorCode:null,lastInboundAt:null,lastOutboundAt:null});
    });
    this.ensurePolling();
  }
  disconnect(){
    this.loginAbort?.abort();this.pollAbort?.abort();this.sendAbort?.abort();this.login=null;this.connected=false;
    this.store.transaction(()=>{
      this.db.prepare("UPDATE weixin_outbox SET state='cancelled' WHERE state NOT IN ('sent','expired','cancelled')").run();
      this.db.prepare("UPDATE weixin_inbox SET state='cancelled' WHERE state='pending'").run();
      this.write({...defaults,session:this.read().session+1,token:null,userId:null,botId:null,baseUrl:null,contextToken:null,lastError:null,lastErrorCode:null,lastInboundAt:null,lastOutboundAt:null});
    });return this.snapshot();
  }
  ingest(result,session=this.read().session){
    const c=this.read();if(session!==c.session||!c.enabled)return;
    this.store.transaction(()=>{
      for(const msg of result.messages||[]){
        if(msg.message_type!==1||!same(msg.from_user_id,c.userId))continue;
        const text=(msg.item_list||[]).filter(x=>x.type===1).map(x=>x.text_item?.text||'').join('\n').trim();
        const identity=msg.message_id??msg.client_id??msg.seq??hash(JSON.stringify([msg.create_time_ms,msg.item_list]));
        const id='wx-'+hash(`${c.botId}:${c.userId}:${identity}`);
        if(this.db.prepare('SELECT 1 FROM weixin_inbox WHERE id=?').get(id))continue;
        this.db.prepare('INSERT INTO weixin_inbox VALUES(?,?,?,?,?)').run(id,session,text,text&&text.length<=10000?'pending':'unsupported',iso(this.now()));
        if(msg.context_token){
          this.write({contextToken:msg.context_token,contextAt:iso(this.now()),lastError:null,lastErrorCode:null});
          this.db.prepare("UPDATE weixin_outbox SET state='pending',next_at=0,error=NULL WHERE session=? AND state='waiting_context' AND expires_at>?").run(session,this.now());
        }
        this.write({lastInboundAt:iso(this.now()),...(!text||text.length>10000?{lastError:'目前仅接收文字消息，请发送不超过一万字的文字'}:{})});
      }
      this.write({cursor:result.cursor??c.cursor});
    });
  }
  drainInbox(){
    const c=this.read();if(!c.enabled||!c.token||this.isBusy())return;
    for(const row of this.db.prepare("SELECT * FROM weixin_inbox WHERE state='pending' AND session=? ORDER BY rowid LIMIT 20").all(c.session)){
      this.store.transaction(()=>{this.submit(ROLE,row.text,row.id);this.db.prepare("UPDATE weixin_inbox SET state='submitted' WHERE id=?").run(row.id);});
    }
  }
  capture(){
    const c=this.read();if(!c.enabled||!c.token||this.hasPendingReplies())return;
    const rows=this.db.prepare('SELECT rowid AS position,* FROM messages WHERE role=? AND rowid>? ORDER BY rowid LIMIT 200').all(ROLE,c.messageCursor);
    if(!rows.length)return;
    this.store.transaction(()=>{
      let group=[];
      const flush=()=>{
        if(!group.length)return;
        const ids=group.map(x=>x.id),kind=group.every(x=>x.kind==='proactive'||x.kind==='reminder')?'proactive':'reply';
        const text=group.map(x=>x.text).join('\n\n');
        if(kind!=='proactive'||(c.proactiveEnabled&&this.store.chatChannel(ROLE)==='weixin')){
          const id='life-'+hash(`${c.session}:${ids.join(':')}`);
          this.db.prepare("INSERT OR IGNORE INTO weixin_outbox(id,session,message_ids,text,kind,state,expires_at,created_at) VALUES(?,?,?,?,?,'pending',?,?)").run(id,c.session,JSON.stringify(ids),text,kind,this.now()+(kind==='proactive'?6:24)*3600000,iso(this.now()));
        }group=[];
      };
      for(const row of rows){
        if(row.speaker!=='assistant'||row.kind==='story'||(!['proactive','reminder'].includes(row.kind)&&row.reply_channel!=='weixin')){flush();continue;}
        if(group.length&&(group.at(-1).kind!==row.kind||Date.parse(row.created_at)-Date.parse(group.at(-1).created_at)>60_000||group.reduce((n,x)=>n+x.text.length+2,0)+row.text.length>12000))flush();
        group.push(row);
      }flush();this.write({messageCursor:rows.at(-1).position});
    });
  }
  async deliver(){
    const c=this.read();if(!c.enabled||!c.token||c.lastErrorCode==='auth_expired')return;
    // Recheck durable routing before sending, including work queued by older versions.
    this.db.prepare("UPDATE weixin_outbox SET state='cancelled' WHERE state IN ('pending','waiting_context') AND kind='reply' AND EXISTS (SELECT 1 FROM json_each(weixin_outbox.message_ids) ids LEFT JOIN messages m ON m.id=ids.value WHERE COALESCE(m.reply_channel,'desktop')!='weixin')").run();
    if(this.store.chatChannel(ROLE)!=='weixin')this.db.prepare("UPDATE weixin_outbox SET state='cancelled' WHERE kind='proactive' AND state IN ('pending','waiting_context')").run();
    this.db.prepare("UPDATE weixin_outbox SET state='expired',error='消息已过期，未补发旧消息' WHERE expires_at<=? AND state IN ('pending','waiting_context')").run(this.now());
    const row=this.db.prepare("SELECT * FROM weixin_outbox WHERE session=? AND state='pending' AND next_at<=? ORDER BY rowid LIMIT 1").get(c.session,this.now());
    if(!row)return;
    if(!c.contextToken){this.db.prepare("UPDATE weixin_outbox SET state='waiting_context',error='请先在微信给林晓薇发一句话' WHERE id=?").run(row.id);return;}
    this.db.prepare("UPDATE weixin_outbox SET state='sending',attempts=attempts+1 WHERE id=?").run(row.id);
    const controller=new AbortController();this.sendAbort=controller;
    try{
      await this.client.sendText({token:c.token,baseUrl:c.baseUrl,to:c.userId,contextToken:c.contextToken,text:row.text,clientId:row.id,signal:controller.signal});
      if(this.read().session!==c.session)return;
      this.db.prepare("UPDATE weixin_outbox SET state='sent',error=NULL WHERE id=?").run(row.id);
      this.write({lastOutboundAt:iso(this.now()),lastError:null,lastErrorCode:null});
    }catch(error){
      if(this.read().session!==c.session)return;
      const code=error.code||'',message=error.message||'微信发送失败';
      const context=/CONTEXT|TOKEN_EXPIRED/u.test(code)||error.contextExpired;
      const auth=/SESSION_EXPIRED|AUTH_EXPIRED/u.test(code)||error.sessionExpired;
      const uncertain=error.uncertain||controller.signal.aborted;
      const retry=!uncertain&&!context&&!auth&&error.retryable&&row.attempts<2;
      this.db.prepare('UPDATE weixin_outbox SET state=?,error=?,next_at=? WHERE id=?').run(context?'waiting_context':uncertain?'uncertain':retry?'pending':'failed',message,this.now()+Math.min(60_000,5000*2**row.attempts),row.id);
      this.write({lastError:message,lastErrorCode:auth?'auth_expired':context?'context_expired':uncertain?'uncertain':'send_failed'});
      if(context)this.write({contextToken:null});
      if(auth){this.connected=false;this.pollAbort?.abort();}
    }
  }
  async tick(){
    if(this.tickTask)return this.tickTask;
    this.tickTask=(async()=>{this.drainInbox();this.capture();await this.deliver();})().catch(()=>{this.write({lastError:'微信通道暂时处理失败，稍后重试'});}).finally(()=>{this.tickTask=null;});return this.tickTask;
  }
  ensurePolling(){
    const c=this.read();if(this.stopped||this.pollTask||!c.enabled||!c.token||c.lastErrorCode==='auth_expired')return;
    const controller=new AbortController();this.pollAbort=controller;
    this.pollTask=(async()=>{
      while(!this.stopped&&!controller.signal.aborted){
        const current=this.read();if(!current.enabled||current.session!==c.session)break;
        try{
          const result=await this.client.getUpdates({token:current.token,baseUrl:current.baseUrl,cursor:current.cursor,signal:controller.signal});
          if(controller.signal.aborted)break;this.connected=true;if(this.read().lastErrorCode==='connection_failed')this.write({lastError:null,lastErrorCode:null});this.ingest(result,c.session);await this.tick();
          await delay(200,undefined,{signal:controller.signal});
        }catch(error){
          if(controller.signal.aborted)break;this.connected=false;
          const auth=/SESSION_EXPIRED|AUTH_EXPIRED/u.test(error.code||'')||error.sessionExpired;
          this.write({lastError:error.message||'微信连接暂时中断',lastErrorCode:auth?'auth_expired':'connection_failed'});
          if(auth)break;
          await delay(5000,undefined,{signal:controller.signal}).catch(()=>{});
        }
      }
    })().finally(()=>{this.pollTask=null;if(!this.stopped)this.ensurePolling();});
  }
  start(){if(!this.stopped)return;this.stopped=false;this.ensurePolling();this.timer=setInterval(()=>{void this.tick();this.ensurePolling();},this.intervalMs);this.timer.unref?.();}
  async stop(){this.stopped=true;clearInterval(this.timer);this.pollAbort?.abort();this.sendAbort?.abort();this.loginAbort?.abort();await Promise.allSettled([this.pollTask,this.tickTask,this.loginTask].filter(Boolean));}
}
