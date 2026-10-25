import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';

const root=path.resolve(import.meta.dirname,'..');
const dataDir=path.join(root,'data');
const imageDir=path.join(dataDir,'scene-images');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'output','street_portraits_100','manifest.json'),'utf8'));
const keepIds=new Set(manifest.map(row=>crypto.createHash('sha256').update(fs.readFileSync(path.join(root,'output','street_portraits_100',row.file))).digest('hex')));
const db=new DatabaseSync(path.join(dataDir,'life.sqlite'));
db.exec('PRAGMA busy_timeout=5000');
const read=key=>{
  const row=db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
  return row?JSON.parse(row.value):null;
};
const library=read('image-library:v1');
const sceneImages=read('scene-images:v1');
if(!library||!sceneImages)throw new Error('应用图库或桌面场景状态不存在');
const retained=library.items.filter(item=>keepIds.has(item.id));
const removed=library.items.filter(item=>!keepIds.has(item.id));
if(keepIds.size!==100||retained.length!==100||removed.length!==162)throw new Error(`数量与预期不符：保留 ${retained.length}，旧图 ${removed.length}；未执行`);
const assets=items=>new Set(items.flatMap(item=>[item.original?.file,item.cutout?.file].filter(Boolean)));
const keepFiles=assets(retained),oldFiles=assets(removed);
const deleteFiles=[...oldFiles].filter(file=>!keepFiles.has(file));
if(deleteFiles.some(file=>!/^[a-f0-9]{64}\.(?:png|jpg|webp)$/.test(file)))throw new Error('旧图文件名无效；未执行');
const assigned=Object.entries(sceneImages.files||{}).filter(([,file])=>oldFiles.has(file)&&!keepFiles.has(file));
console.log(`旧图库：${removed.length} 张；保留新图：${retained.length} 张；待清理文件：${deleteFiles.length} 个；桌面场景引用：${assigned.length} 处。`);
if(!process.argv.includes('--apply')){
  console.log('仅预览。使用 --apply 才会执行。');
  db.close();process.exit(0);
}
const backup=path.join(root,'output',`removed-image-library-backup-${new Date().toISOString().slice(0,10)}.json`);
fs.writeFileSync(backup,JSON.stringify({library,sceneImages,runtimeSelection:read('runtime-scene-selection:miyue')},null,2),{mode:0o600,flag:'wx'});
let committed=false;
try{
  db.exec('BEGIN IMMEDIATE');
  const current=read('image-library:v1');
  if(current.revision!==library.revision)throw new Error('图库在准备期间发生变化；未执行');
  const nextLibrary={...library,revision:library.revision+1,items:retained,importedFiles:(library.importedFiles||[]).filter(file=>keepFiles.has(file))};
  const nextScene={...sceneImages,revision:sceneImages.revision+1,files:{...sceneImages.files},fits:{...sceneImages.fits}};
  for(const [sceneId] of assigned){delete nextScene.files[sceneId];delete nextScene.fits[sceneId];}
  if(!nextScene.activeSceneId||!nextScene.files[nextScene.activeSceneId]){nextScene.activeSceneId=null;nextScene.enabled=false;}
  db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(nextLibrary),'image-library:v1');
  db.prepare('UPDATE metadata SET value=? WHERE key=?').run(JSON.stringify(nextScene),'scene-images:v1');
  db.prepare('DELETE FROM metadata WHERE key=?').run('runtime-scene-selection:miyue');
  db.exec('COMMIT');committed=true;
}finally{
  if(!committed)db.exec('ROLLBACK');
}
let deleted=0,missing=0;
for(const file of deleteFiles){
  try{fs.unlinkSync(path.join(imageDir,file));deleted++;}
  catch(error){if(error.code==='ENOENT')missing++;else throw error;}
}
const after=read('image-library:v1');
if(after.items.length!==100||after.items.some(item=>!keepIds.has(item.id)))throw new Error('移除后图库校验失败');
console.log(`已移除 ${removed.length} 张旧图，删除 ${deleted} 个文件（${missing} 个原本不存在）；新图仍为 ${after.items.length} 张。`);
console.log(`原图库元数据备份：${backup}`);
db.close();
