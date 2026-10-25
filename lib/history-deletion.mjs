const invalid=(message,status=400)=>Object.assign(new Error(message),{status,code:'INVALID_HISTORY_DELETION'});
const parse=value=>{try{return JSON.parse(value);}catch{return null;}};
const references=(value,ids)=>typeof value==='string'?ids.has(value):Array.isArray(value)?value.some(item=>references(item,ids)):value&&typeof value==='object'?Object.values(value).some(item=>references(item,ids)):false;

// Remove whole derived records rather than retaining summaries whose evidence
// was removed. Independent records in the same state remain untouched.
function pruneState(value,ids){
  if(Array.isArray(value))return value.filter(item=>!references(item,ids));
  if(!value||typeof value!=='object')return typeof value==='string'&&ids.has(value)?null:value;
  return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,
    Array.isArray(item)?pruneState(item,ids):item&&typeof item==='object'&&references(item,ids)?null:pruneState(item,ids)]));
}

export class HistoryDeletion {
  constructor(store){
    this.store=store;this.db=store.db;
    // Existing consumers use SQLite rowids as durable read/recall cursors.
    // Deleting the newest transcript must never cause a future rowid to be reused.
    this.db.exec(`CREATE TABLE IF NOT EXISTS message_rowid_floor(id INTEGER PRIMARY KEY CHECK(id=1),value INTEGER NOT NULL);
      INSERT OR IGNORE INTO message_rowid_floor VALUES(1,0);
      CREATE TRIGGER IF NOT EXISTS messages_keep_rowid AFTER INSERT ON messages
      WHEN NEW.rowid<=(SELECT value FROM message_rowid_floor WHERE id=1)
      BEGIN
        UPDATE messages SET rowid=(SELECT value+1 FROM message_rowid_floor WHERE id=1) WHERE id=NEW.id;
        UPDATE message_rowid_floor SET value=value+1 WHERE id=1;
      END;`);
  }
  list(role,{limit=50,before=null}={}){
    const count=Number(limit),cursor=before===null?null:Number(before);
    if(!Number.isInteger(count)||count<1||count>100||cursor!==null&&(!Number.isSafeInteger(cursor)||cursor<1))throw invalid('历史分页参数无效');
    const rows=this.db.prepare(`SELECT rowid,id,role,speaker,text,kind,created_at AS createdAt FROM messages WHERE role=?${cursor===null?'':' AND rowid<?'} ORDER BY rowid DESC LIMIT ?`).all(...[role,...(cursor===null?[]:[cursor]),count+1]);
    return {messages:rows.slice(0,count),nextBefore:rows.length>count?rows[count-1].rowid:null};
  }
  delete(role,ids){
    if(!Array.isArray(ids)||!ids.length||ids.length>100||ids.some(id=>typeof id!=='string'||!id||id.length>200)||new Set(ids).size!==ids.length)throw invalid('请选择 1 至 100 条不同的历史消息');
    return this.store.transaction(()=>{
      const selected=ids.map(id=>this.db.prepare('SELECT id,role,rowid FROM messages WHERE id=?').get(id));
      if(selected.some(row=>!row||row.role!==role))throw invalid('所选消息不存在或不属于当前人物，请刷新后重试',404);
      const tables=new Set(this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row=>row.name));
      const columns=table=>this.db.prepare(`PRAGMA table_info("${table}")`).all().map(row=>row.name);
      const targets=new Set(ids),derived=new Set(ids),affectedScopes=new Set([role]);
      const auditMax=tables.has('companion_history_edit_audit')?this.db.prepare('SELECT COALESCE(MAX(id),0) n FROM companion_history_edit_audit').get().n:0;
      const maxRowid=this.db.prepare('SELECT COALESCE(MAX(rowid),0) n FROM messages').get().n;
      this.db.prepare('UPDATE message_rowid_floor SET value=MAX(value,?) WHERE id=1').run(maxRowid);
      // A remembered exchange is indivisible: remove the entry and all of its
      // stored quotes when any selected message contributed to it.
      if(tables.has('episodic_memory_quotes'))for(const id of ids){
        for(const row of this.db.prepare('SELECT entry_id FROM episodic_memory_quotes WHERE message_id=?').all(id)){
          derived.add(row.entry_id);
          const entry=this.db.prepare('SELECT scope FROM episodic_memory_entries WHERE id=?').get(row.entry_id);
          if(entry?.scope)affectedScopes.add(entry.scope);
          this.db.prepare('DELETE FROM episodic_memory_quotes WHERE entry_id=?').run(row.entry_id);
          this.db.prepare('DELETE FROM episodic_memory_entries WHERE id=?').run(row.entry_id);
        }
      }
      for(const [table,fields] of [
        ['character_reflections',['payload']],['character_growth_items',['payload']],['daily_dialogue_chunks',['payload']],
        ['consolidated_memories',['evidence_json']],['companion_relationship_facts',['source_ids']],
        ['companion_social_versions',['source_json']],
      ])if(tables.has(table))for(const row of this.db.prepare(`SELECT rowid AS _rowid,* FROM ${table}`).all()){
        if(fields.some(field=>references(parse(row[field]),targets))){if(row.id)derived.add(row.id);if(table==='consolidated_memories')affectedScopes.add(row.scope);this.db.prepare(`DELETE FROM ${table} WHERE rowid=?`).run(row._rowid);}
      }
      // Explicit message links cover receipts, saved quotes, source cards,
      // followups and cached deliveries; no independently authored memories.
      const linkedTables=[
        'scenario_message_scope','scenario_commits','proactive_events','companion_history_edits','companion_history_edit_audit',
        'personal_experiences','saved_moments','closeness_moments','shared_experiences','followups','followup_observations',
        'episodic_memory_observed','conversation_receipts','life_topic_deliveries','life_thread_deliveries','life_thread_commits',
        'life_thread_plans','companion_pursuit_deliveries','companion_agenda_deliveries','companion_relationship_contacts',
        'daily_life_choice_receipts','companion_source_deliveries','companion_event_materials','companion_event_material_exposures',
        'discussion_topic_deliveries','discussion_topic_responses','companion_dynamics_receipts','companion_social_receipts',
        'grounded_life_participation','proactive_material_deliveries','daily_information_deliveries','daily_happening_shares',
      ];
      const referenceColumns=new Set(['message_id','assistant_message_id','user_message_id','source_message_id','delivery_message_id','committed_message_id','user_id','source_id']);
      for(const table of linkedTables)if(tables.has(table)){
        const fields=columns(table).filter(name=>referenceColumns.has(name));
        if(fields.length)for(const id of ids)this.db.prepare(`DELETE FROM ${table} WHERE ${fields.map(field=>`${field}=?`).join(' OR ')}`).run(...fields.map(()=>id));
      }
      for(const [table,fields] of [
        ['consolidated_memory_audit',['coverage_json','changes_json']],['dialogue_traces',['payload']],
        ['desktop_attention_receipts',['message_ids']],['weixin_outbox',['message_ids']],
        ['grounded_life_receipts',['result_json']],['companion_social_audit',['accepted_json','rejected_json']],
      ])if(tables.has(table))for(const row of this.db.prepare(`SELECT rowid AS _rowid,* FROM ${table}`).all()){
        if(fields.some(field=>references(parse(row[field]),derived)))this.db.prepare(`DELETE FROM ${table} WHERE rowid=?`).run(row._rowid);
      }
      for(const table of ['companion_agenda_state','companion_dynamics_states','companion_pursuit_state','life_thread_runtime'])if(tables.has(table)){
        const row=this.db.prepare(`SELECT * FROM ${table} WHERE role_id=?`).get(role);
        if(!row)continue;
        const state=parse(row.state_json);if(!state||!references(state,targets))continue;
        // Opportunities referring to a removed plan must disappear with it.
        for(const item of state.plans||[])if(references(item,targets)&&item.id)derived.add(item.id);
        const next=pruneState(state,derived);
        if('revision'in next)next.revision=Number(next.revision||0)+1;
        const revision=columns(table).includes('revision')?',revision=revision+1':'';
        this.db.prepare(`UPDATE ${table} SET state_json=?${revision} WHERE role_id=?`).run(JSON.stringify(next),role);
      }
      // Legacy cumulative automatic summaries have no per-message provenance.
      // Clear them; source-backed memories not touched above remain available.
      if(tables.has('recall_state'))for(const scope of affectedScopes)this.db.prepare("UPDATE recall_state SET summary=CASE WHEN summary_origin='manual' THEN summary ELSE '' END,revision=revision+1,last_error=NULL,retry_at=NULL WHERE role_id=?").run(scope);
      if(tables.has('persona_recall_archive'))this.db.prepare('DELETE FROM persona_recall_archive WHERE role=?').run(role);
      for(const [table,column] of [['consolidated_memory_state','scope'],['episodic_memory_state','scope'],['companion_relationship_state','role_id']])if(tables.has(table))for(const scope of affectedScopes)this.db.prepare(`UPDATE ${table} SET revision=revision+1 WHERE ${column}=?`).run(scope);
      if(role==='miyue'&&tables.has('companion_social_meta'))this.db.prepare('UPDATE companion_social_meta SET revision=revision+1 WHERE id=1').run();
      // Content-free audit advances history revision, invalidating in-flight
      // generation and preventing removed sources from reentering old drafts.
      if(tables.has('companion_history_edit_audit'))this.db.prepare("INSERT INTO companion_history_edit_audit(id,message_id,role,action,created_at) VALUES(?,'',?,'delete',?)").run(auditMax+1,role,this.store.now());
      if(tables.has('recall_vectors'))for(const id of derived)this.db.prepare('DELETE FROM recall_vectors WHERE role_id=? AND (item_id=? OR item_id=?)').run(role,id,`raw:${id}`);
      if(tables.has('character_growth_state'))this.db.prepare('UPDATE character_growth_state SET revision=revision+1 WHERE role_id=?').run(role);
      for(const id of ids)this.db.prepare('DELETE FROM messages WHERE id=? AND role=?').run(id,role);
      return {deletedIds:ids,count:ids.length};
    });
  }
}
