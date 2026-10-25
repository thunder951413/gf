import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
const transient=new Set(['chat_queue','reply_delivery','proactive_leases','chat_receipts']);
const excluded = name => /^weixin_/u.test(name) || name === 'sqlite_sequence';
const privateKey = key => /weixin|credential|api[_-]?key|auth[_-]?token|cookie/iu.test(key);
const quote = name => '"'+name.replaceAll('"','""')+'"';

export function exportSession(store,{clock=()=>new Date()}={}) {
  const schema=store.db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all().filter(s=>!excluded(s.tbl_name));
  const tables={};
  // A single read transaction gives all tables the same history/state revision.
  return store.transaction(()=>{
    for(const item of schema.filter(s=>s.type==='table')){
      const rows=store.db.prepare(`SELECT rowid AS _snapshot_rowid,* FROM ${quote(item.name)}`).all();
      tables[item.name]=transient.has(item.name)?[]:item.name==='metadata'?rows.filter(r=>!privateKey(r.key)):rows;
    }
    return {format:'youjian-session',version:1,createdAt:new Date(clock()).toISOString(),schema,tables,
      omitted:['模型密钥与外部账号凭据','微信收发队列与临时投递队列','图片文件（JSON 只包含索引，SQLite 分支会另行复制图片）'],isolation:'导入或分支运行时关闭外部发送、自动任务和到期提醒派送'};
  });
}
export function restoreSession(snapshot,targetDir){
  if(snapshot?.format!=='youjian-session'||snapshot.version!==1||!Array.isArray(snapshot.schema)||!snapshot.tables)throw new Error('INVALID_SESSION_SNAPSHOT');
  if(fs.existsSync(targetDir))throw new Error('分支目标已存在，不能覆盖');
  fs.mkdirSync(targetDir,{recursive:true,mode:0o700});
  const db=new DatabaseSync(path.join(targetDir,'life.sqlite'));
  try{
    db.exec('PRAGMA foreign_keys=OFF;BEGIN IMMEDIATE');
    for(const table of snapshot.schema.filter(s=>s.type==='table')){
      if(excluded(table.name)||table.tbl_name!==table.name||!/^CREATE TABLE /iu.test(table.sql))throw new Error('INVALID_SNAPSHOT_SCHEMA');
      db.prepare(table.sql).run();
      for(const row of snapshot.tables[table.name]||[]){
        const entries=Object.entries(row).map(([k,v])=>[k==='_snapshot_rowid'?'rowid':k,v]);
        const insert=db.prepare(`INSERT INTO ${quote(table.name)} (${entries.map(([k])=>quote(k)).join(',')}) VALUES (${entries.map(()=>'?').join(',')})`);
        insert.run(...entries.map(([,v])=>v));
      }
    }
    for(const item of snapshot.schema.filter(s=>s.type!=='table')){if(!['index','trigger','view'].includes(item.type)||typeof item.sql!=='string'||!/^CREATE (?:UNIQUE )?(?:INDEX|TRIGGER|VIEW) /iu.test(item.sql))throw new Error('INVALID_SNAPSHOT_SCHEMA');db.prepare(item.sql).run();}
    for(const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all())if(transient.has(row.name))db.exec(`DELETE FROM ${quote(row.name)}`);
    db.exec('COMMIT');
  }catch(error){try{db.exec('ROLLBACK');}catch{};db.close();fs.rmSync(targetDir,{recursive:true,force:true});throw error;}
  db.close();fs.chmodSync(path.join(targetDir,'life.sqlite'),0o600);markBranch(targetDir);return targetDir;
}
function markBranch(targetDir){fs.writeFileSync(path.join(targetDir,'session-branch.json'),JSON.stringify({format:'youjian-branch',version:1,isolated:true,createdAt:new Date().toISOString()},null,2),{mode:0o600});}
export async function forkSession(store,{targetDir,sourceDir,provider}={}){
  if(fs.existsSync(targetDir))throw new Error('分支目标已存在，不能覆盖');
  fs.mkdirSync(targetDir,{recursive:true,mode:0o700});
  try{
    await backup(store.db,path.join(targetDir,'life.sqlite'));
    const db=new DatabaseSync(path.join(targetDir,'life.sqlite'));
    try{
      db.exec('PRAGMA foreign_keys=OFF');
      for(const row of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all())if(excluded(row.name)||transient.has(row.name))db.exec(`DELETE FROM ${quote(row.name)}`);
      for(const row of db.prepare('SELECT key FROM metadata').all())if(privateKey(row.key))db.prepare('DELETE FROM metadata WHERE key=?').run(row.key);
      db.exec('VACUUM');
    }finally{db.close();}
    // Artwork belongs to the independent snapshot too. Credentials and live
    // integration configuration never travel with it.
    if(sourceDir)for(const name of ['scene-images','images','art','image-library']){
      const source=path.join(sourceDir,name);if(fs.existsSync(source))fs.cpSync(source,path.join(targetDir,name),{recursive:true});
    }
    if(provider)fs.writeFileSync(path.join(targetDir,'provider.json'),JSON.stringify(provider,null,2),{mode:0o600});
    fs.chmodSync(path.join(targetDir,'life.sqlite'),0o600);markBranch(targetDir);
    return {dataDir:targetDir,isolated:true};
  }catch(error){fs.rmSync(targetDir,{recursive:true,force:true});throw error;}
}
export function isolatedOptions(dataDir){
  return fs.existsSync(path.join(dataDir,'session-branch.json'))?{
    activeRoleIds:['miyue'],disableStory:true,dynamicCompanion:true,sessionDialogue:true,dialogueMemory:true,
    startWeixin:false,startProactive:false,startDiscovery:false,startResearch:false,startReminders:false,startRecall:false,startCharacterGrowth:false,
    startRuntime:false,startLife:false,startDailyLife:false,startLifeThreads:false,startPursuits:false,startDossiers:false,
    listenHost:'127.0.0.1',allowedHosts:[],
  }:{};
}
