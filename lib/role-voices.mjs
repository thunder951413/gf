export class RoleVoiceRepository {
  constructor(store){this.store=store;store.db.exec('CREATE TABLE IF NOT EXISTS role_voices(role_id TEXT PRIMARY KEY,voice_id TEXT,voice_name TEXT)');}
  list(){return Object.fromEntries(this.store.db.prepare('SELECT * FROM role_voices').all().map(r=>[r.role_id,{voiceId:r.voice_id,name:r.voice_name}]));}
  get(roleId){return this.list()[roleId]||null;}
  set(roleId,voice){this.store.db.prepare('INSERT INTO role_voices VALUES(?,?,?) ON CONFLICT(role_id) DO UPDATE SET voice_id=excluded.voice_id,voice_name=excluded.voice_name').run(roleId,voice?.id||null,voice?.name||null);return this.list();}
  initialize(voices,roleIds){const current=this.list();for(const [roleId,name] of Object.entries({miyue:'龙安柔',wenxi:'龙安欢',zhixia:'龙星'})){if(!roleIds.includes(roleId)||Object.hasOwn(current,roleId))continue;const v=voices.find(v=>v.name===name);if(v)this.set(roleId,v);}return this.list();}
}
