// Replay only explicit, sourced facts from real chronological exchanges once.
// Existing records are untouched; this never creates messages or recommendations.
export function importCompanionRelationship(store,relationship,roleId='miyue') {
 store.db.exec('CREATE TABLE IF NOT EXISTS companion_relationship_imports(role_id TEXT PRIMARY KEY, imported_at TEXT NOT NULL)');
 if(store.db.prepare('SELECT 1 FROM companion_relationship_imports WHERE role_id=?').get(roleId))return false;
 return store.transaction(()=>{
  const rows=store.getMessages(roleId);let turn=[];
  for(const row of rows){
   if(row.speaker==='user'){if(turn.length)relationship.observe(roleId,turn,[]);turn=[row];}
   else if(row.speaker==='assistant'){relationship.observe(roleId,[...turn,row],[]);turn=[];}
  }
  if(turn.length)relationship.observe(roleId,turn,[]);
  store.db.prepare('INSERT INTO companion_relationship_imports(role_id,imported_at) VALUES(?,?)').run(roleId,new Date().toISOString());return true;
 });
}
