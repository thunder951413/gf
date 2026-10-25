import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { forkSession, restoreSession } from '../lib/session-snapshot.mjs';
import { createApp } from '../server.mjs';
const args=process.argv.slice(2), value=flag=>{const i=args.indexOf(flag);return i<0?null:args[i+1];};
const target=value('--out'), imported=value('--import'), source=value('--source');
let dataDir=value('--serve');
if(target){
  const targetDir=path.resolve(target);
  if(imported){restoreSession(JSON.parse(fs.readFileSync(path.resolve(imported),'utf8')),targetDir);}
  else{
    if(!source)throw new Error('需要 --source 数据目录或 --import 导出文件');
    const sourceDir=path.resolve(source), db=new DatabaseSync(path.join(sourceDir,'life.sqlite'),{readOnly:true});
    try{let provider;try{provider=JSON.parse(fs.readFileSync(path.join(sourceDir,'provider.json'),'utf8'));}catch{}
      await forkSession({db},{targetDir,sourceDir,provider});
    }finally{db.close();}
  }
  dataDir=targetDir;console.log(JSON.stringify({dataDir,isolated:true}));
}
if(dataDir&&(args.includes('--run')||value('--serve'))){
  if(!fs.existsSync(path.join(dataDir,'session-branch.json')))throw new Error('只允许运行带隔离标记的分支目录');
  const app=await createApp({dataDir:path.resolve(dataDir),startChatQueue:true,initialFeeds:[]});
  const address=await app.listen(Number(value('--port')||0));console.log(`隔离分支：http://127.0.0.1:${address.port}`);
  process.on('SIGINT',async()=>{await app.close();process.exit(0);});process.on('SIGTERM',async()=>{await app.close();process.exit(0);});
}else if(!target)console.log('用法：node scripts/companion-branch.mjs --source data --out .runtime/branches/my-test --run\n或：--import export.json --out .runtime/branches/my-test --run\n或：--serve .runtime/branches/my-test --port 8766');
