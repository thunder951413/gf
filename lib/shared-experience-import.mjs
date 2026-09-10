// Import only existing delivery receipts. No attempt to invent links or facts
// by summarizing arbitrary historic dialogue during an upgrade.
export function importSharedExperiences(store, shared, { pursuits, thread } = {}) {
  const marker='shared_experiences_import_v1';
  if (store.db.prepare('SELECT 1 FROM metadata WHERE key=?').get(marker)) return;
  store.transaction(()=>{
    const view=pursuits?.get('miyue');
    const names=new Map([...(pursuits?.catalog.items||[]),...(view?.completed||[]),...(view?[view]:[])].map(item=>[item.id,item]));
    const candidates=[];
    for(const row of store.db.prepare("SELECT * FROM personal_experiences WHERE role_id='miyue' ORDER BY id DESC LIMIT 128").all()) {
      candidates.push({messageId:row.message_id,packet:{key:`conversation-experience:${row.message_id}`,kind:row.kind,title:row.title,summary:row.evidence,detail:row.summary,occurredAt:row.created_at}});
    }
    for(const row of store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='companion_pursuit_deliveries'").get()?store.db.prepare("SELECT * FROM companion_pursuit_deliveries WHERE role_id='miyue' ORDER BY rowid DESC LIMIT 128").all():[]) {
      const receipt=JSON.parse(row.payload_json),id=row.pursuit_id.split(':')[0],item=names.get(id);
      candidates.push({messageId:row.message_id,packet:{key:row.pending_key,kind:item?.kind||'reading',title:receipt.title||item?.title||receipt.label,aliases:receipt.aliases||item?.aliases,summary:receipt.action,detail:receipt.detail,source:receipt.source,occurredAt:row.delivered_at,version:row.expected_version}});
    }
    for(const row of store.db.prepare("SELECT * FROM life_thread_deliveries WHERE role_id='miyue' ORDER BY rowid DESC LIMIT 128").all()) {
      const receipt=JSON.parse(row.payload_json);
      candidates.push({messageId:row.message_id,packet:{key:row.pending_key,kind:'daily',title:row.thread_id===thread?.id?thread.title:receipt.title,summary:receipt.text,detail:[receipt.emotion,receipt.need,...(receipt.facts||[])].filter(Boolean).join('；')||receipt.text,occurredAt:row.delivered_at}});
    }
    const ordered=candidates.map(entry=>({...entry,message:store.db.prepare('SELECT rowid AS ordinal,* FROM messages WHERE id=?').get(entry.messageId)}))
      .filter(entry=>entry.message?.role==='miyue'&&entry.message.speaker==='assistant'&&entry.packet.summary&&entry.packet.detail&&entry.message.text.includes(entry.packet.summary))
      .sort((a,b)=>a.message.ordinal-b.message.ordinal);
    for(const entry of ordered)shared.record('miyue',entry.messageId,entry.packet);
    store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(marker,String(ordered.length));
  });
}
