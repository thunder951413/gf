import { randomUUID } from 'node:crypto';
export function splitSpeech(text) {
  const chunks=[]; let rest=String(text);
  while(rest.length){
    const max=chunks.length?180:100;
    if(rest.length<=max){chunks.push(rest);break;}
    const sample=rest.slice(0,max), matches=[...sample.matchAll(/[。！？!?；;\n]/gu)];
    const last=matches.findLast(m=>m.index>=Math.min(32,max/3));
    const end=last?last.index+last[0].length:max;
    chunks.push(rest.slice(0,end));rest=rest.slice(end);
  }
  return chunks;
}

// The TTS service produces one file per job. Keep two segments in flight so
// the first sentence can play while the next is generated, with one cancel ID.
export class SegmentedSpeech {
  constructor(integrations,{clock=()=>Date.now(),isVisible=()=>true}={}){
    this.integrations=integrations;this.clock=clock;this.isVisible=isVisible;this.sessions=new Map();
    this.timer=setInterval(()=>{for(const [id,s] of this.sessions)if(this.clock()-s.touchedAt>300000)this.close(id).catch(()=>{});},30000);this.timer.unref();
  }
  start(message,options={}){
    if(this.sessions.size>=8)throw Object.assign(new Error('语音任务较多，请先停止旧任务'),{status:429,code:'VOICE_SESSION_LIMIT'});
    const id=randomUUID(),s={id,messageId:message.id,role:message.role,sourceText:message.text,chunks:splitSpeech(message.text),segments:[],next:0,current:0,options,closed:false,touchedAt:this.clock(),pending:new Set()};
    this.sessions.set(id,s);this.pump(s);return {sessionId:id,segmentCount:s.chunks.length};
  }
  get(id){const s=this.sessions.get(id);if(!s||s.closed)throw Object.assign(new Error('语音已停止'),{status:404,code:'VOICE_SESSION_NOT_FOUND'});s.touchedAt=this.clock();return s;}
  async validate(s){if(!this.isVisible(s.messageId,s.sourceText)){await this.close(s.id);throw Object.assign(new Error('原消息已删除或更正，请重新朗读'),{status:409,code:'VOICE_SOURCE_CHANGED'});}}
  pump(s){
    while(!s.closed&&s.next<s.chunks.length&&s.next<s.current+2){
      const index=s.next++,segment={index,state:'starting',jobId:null};s.segments[index]=segment;
      const pending=(async()=>{
        try{const result=await this.integrations.startSpeech(s.chunks[index],s.options);segment.jobId=result.jobId;
          if(s.closed){await this.integrations.closeSpeech(result.jobId);return;}segment.state='generating';
        }catch{if(!s.closed){segment.state='error';segment.error='本地语音服务暂时无法生成这一段。';}}
      })().finally(()=>s.pending.delete(pending));s.pending.add(pending);
    }
  }
  async status(id){
    const s=this.get(id);await this.validate(s);
    await Promise.all(s.segments.filter(c=>c.state==='generating').map(async segment=>{
      try{const status=await this.integrations.readSpeechStatus(segment.jobId);segment.state=['finished','error','cancelled','closed'].includes(status.state)?status.state:'generating';}
      catch{segment.state='error';segment.error='本地语音状态暂不可读取。';}
    }));
    return {sessionId:id,segmentCount:s.chunks.length,current:s.current,segments:s.segments.map(({jobId,...segment})=>segment)};
  }
  async audio(id,index){const s=this.get(id);await this.validate(s);const c=s.segments[index];if(!c||c.state!=='finished')throw Object.assign(new Error('这一段尚未生成'),{status:409,code:'VOICE_SEGMENT_NOT_READY'});return this.integrations.getSpeechAudio(c.jobId);}
  async advance(id,index){
    const s=this.get(id);await this.validate(s);
    if(!Number.isInteger(index)||index!==s.current||s.segments[index]?.state!=='finished')throw Object.assign(new Error('语音播放顺序无效'),{status:409,code:'INVALID_VOICE_ADVANCE'});
    const c=s.segments[index];c.state='played';s.current++;
    await this.integrations.closeSpeech(c.jobId).catch(()=>{});c.jobId=null;this.pump(s);
    if(s.current===s.chunks.length){await this.close(id);return {finished:true};}return {finished:false,current:s.current};
  }
  async close(id){const s=this.sessions.get(id);if(!s)return {closed:true};s.closed=true;this.sessions.delete(id);await Promise.allSettled([...s.pending]);await Promise.allSettled(s.segments.filter(c=>c.jobId).map(c=>this.integrations.closeSpeech(c.jobId)));return {closed:true};}
  async stop(){clearInterval(this.timer);await Promise.allSettled([...this.sessions.keys()].map(id=>this.close(id)));}
}
