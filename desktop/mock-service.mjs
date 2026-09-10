// Manual native UI test fixture; isolated from life.sqlite and model services.
import http from 'node:http';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Store} from '../lib/store.mjs';
import {AppearanceRepository} from '../lib/appearance.mjs';
import {randomUUID} from 'node:crypto';
import {WARDROBE_CATALOG} from '../lib/wardrobe.mjs';
let messages=[{id:'baseline',speaker:'assistant',text:'这是一条旧消息，不应在首次连接时弹出。'}];
let activity='重读一本喜欢的书';
let outfitId='soft-knit', revision=0, automatic=true, locked=false;
const wardrobe=()=>({roleId:'miyue',catalog:WARDROBE_CATALOG,settings:{automatic,locked},current:{outfitId,...Object.fromEntries(Object.entries(WARDROBE_CATALOG.find(x=>x.id===outfitId)).filter(([key])=>key!=='id')),changedAt:'2026-09-08T00:00:00Z',reason:'manual'},revision,nextChangeAt:null});
const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'youjian-desktop-mock-'));
const store=new Store({dataDir,story:{start:'start',nodes:{start:{}}},initialFeeds:[]});
const appearance=new AppearanceRepository(store,{wardrobe:{snapshot:wardrobe},getState:()=>({world:{activity},inner:{mood:50}})});
appearance.update({assetId:'original-long-soft-knit-idle-soft-smile-original',sceneId:'study',locked:true});
const requests={};
const server=http.createServer(async(req,res)=>{
  requests[req.url]=(requests[req.url]||0)+1;
  const json=value=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(value));};
  if(req.url==='/api/conversations/miyue')return json({messages});
  if(req.url==='/api/inbox')return json({items:[]});
  if(req.url==='/api/life')return json({world:{activity,location:'苏州的家中',event:null},wardrobe:wardrobe()});
  if(req.url==='/api/appearance'){
    try {if(req.method==='POST'){const chunks=[];for await(const chunk of req)chunks.push(chunk);return json(appearance.update(JSON.parse(Buffer.concat(chunks).toString()||'{}')));}return json(appearance.snapshot());}
    catch(error){res.statusCode=error.status||500;return json({error:error.message});}
  }
  if(req.url==='/api/wardrobe'){
    if(req.method==='POST'){
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const patch=JSON.parse(Buffer.concat(chunks).toString()||'{}');
      if(patch.outfitId && WARDROBE_CATALOG.some(x=>x.id===patch.outfitId))outfitId=patch.outfitId;
      if(typeof patch.automatic==='boolean')automatic=patch.automatic;
      if(typeof patch.locked==='boolean')locked=patch.locked;
      revision++;
    }
    return json(wardrobe());
  }
  if(req.url==='/__test/status')return json({requests,count:messages.length});
  if(req.method==='POST'&&req.url==='/__test/message'){
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const data=JSON.parse(Buffer.concat(chunks).toString()||'{}');
    const message={id:randomUUID(),speaker:'assistant',text:data.text||'刚读到一段很喜欢的话，想和你聊聊。'};
    messages.push(message);return json({id:message.id});
  }
  if(req.method==='POST'&&req.url==='/__test/activity'){
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    activity=JSON.parse(Buffer.concat(chunks)).activity;return json({ok:true});
  }
  if(req.url==='/'){
    res.setHeader('Content-Type','text/html; charset=utf-8');
    return res.end('<body style="background:#f7f0e9;font:20px -apple-system;padding:50px;color:#54414b"><h1>有间 · 桌面连接测试</h1><p>气泡点击已打开聊天窗口。本页不连接生产数据库或模型。</p><button class="role-button" data-role="miyue">林雨薇</button><p><textarea placeholder="独立测试，不会发送真实消息" style="font:inherit;width:80%;height:120px"></textarea></p></body>');
  }
  res.statusCode=404;json({error:'not found'});
});
server.listen(Number(process.argv[2]||8878),'127.0.0.1',()=>console.log(`Desktop mock listening at http://127.0.0.1:${server.address().port}/`));

for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{store.close();fs.rmSync(dataDir,{recursive:true,force:true});process.exit(0);}));
