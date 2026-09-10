import fs from 'node:fs';
import path from 'node:path';
import {loadVisualCatalog,VISUAL_CATALOG_PATH} from './visual-assets.mjs';

const KEY='appearance:miyue:v1';
const DAY=86400000;
const nextMorning=ms=>Math.floor((ms+3600000)/DAY)*DAY+DAY-3600000;
const dimensionKeys=['hairstyleId','outfitId','poseId','expressionId','paletteId'];
const boolKeys=['automatic','locked','sceneCardEnabled','reduceMotion'];
const allowed=new Set([...dimensionKeys,...boolKeys,'assetId','sceneId','season']);
const seasons=new Set(['auto','spring','summer','autumn','winter']);
const fail=message=>Object.assign(new Error(message),{status:400,code:'INVALID_APPEARANCE'});
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export class AppearanceRepository {
  constructor(store,{clock=()=>new Date(),random=Math.random,catalogPath=VISUAL_CATALOG_PATH,catalog,wardrobe,getState=()=>({}),isBusy=()=>false}={}) {
    Object.assign(this,{store,clock,random,catalogPath,providedCatalog:catalog,wardrobe,getState,isBusy});
    this.assetsRoot=path.dirname(catalogPath);
  }
  catalog(){
    if(this.providedCatalog)return this.providedCatalog;
    const stamp=fs.statSync(this.catalogPath).mtimeMs;
    if(stamp!==this.catalogStamp){this.cachedCatalog=loadVisualCatalog(this.catalogPath);this.catalogStamp=stamp;}
    return this.cachedCatalog;
  }
  available(catalog){return catalog.assets.filter(a=>a.status==='approved'&&(this.providedCatalog||fs.existsSync(path.join(this.assetsRoot,a.file))));}
  read(){try{return JSON.parse(this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(KEY)?.value||'null');}catch{return null;}}
  write(s){this.store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY,JSON.stringify(s));}
  now(s){const now=+new Date(this.clock());if(!Number.isFinite(now))throw new TypeError('Invalid appearance clock');const observed=typeof s?.observedAt==='number'?s.observedAt:Date.parse(s?.observedAt)||0;return Math.max(now,observed);}
  compatible(asset,scene,catalog){if(!scene)return true;const entry=catalog.scenes.find(s=>s.id===scene);return entry?.status==='ready'&&entry.compatibleOutfitIds.includes(asset.outfitId);}
  seasonCompatible(sceneId,season,catalog){if(!sceneId||!season||season==='auto')return true;const scene=catalog.scenes.find(item=>item.id===sceneId);return scene?.season==='all'||scene?.season===season;}
  sceneFor(asset,catalog,preferred){
    if(preferred&&this.compatible(asset,preferred,catalog))return preferred;
    return catalog.scenes.find(s=>s.status==='ready'&&s.compatibleOutfitIds.includes(asset.outfitId))?.id??null;
  }
  current(asset,s){return {assetId:asset.id,...Object.fromEntries(dimensionKeys.map(k=>[k,asset[k]])),sceneId:s.sceneId,season:s.season};}
  initial(catalog,now){
    const approved=this.available(catalog),legacySnapshot=this.wardrobe?.snapshot(),legacy=legacySnapshot?.current?.outfitId;
    const asset=approved.find(a=>a.outfitId===legacy&&a.poseId==='idle'&&a.paletteId==='original')||approved[0];
    if(!asset)throw fail('暂无已验收的形象素材');
    const automatic=legacySnapshot?.settings?.automatic??true,locked=legacySnapshot?.settings?.locked??false;
    return {assetId:asset.id,sceneId:this.sceneFor(asset,catalog,'study'),season:'auto',settings:{automatic,locked,sceneCardEnabled:false,reduceMotion:false},revision:0,nextChangeAt:automatic&&!locked?nextMorning(now):null,lastVisualAt:now,observedAt:now,reason:'initial'};
  }
  tick(s,catalog,now){
    const approved=this.available(catalog);let asset=approved.find(a=>a.id===s.assetId),resolution=null;
    if(!asset){const missingId=s.assetId,seed=this.initial(catalog,now);s.assetId=seed.assetId;asset=approved.find(a=>a.id===s.assetId);s.sceneId=this.sceneFor(asset,catalog,s.sceneId);s.revision++;s.reason='asset-removed';resolution={requested:null,rendered:this.current(asset,s),reason:`素材 ${missingId} 已不可用，改用已验收形象`};}
    if(!s.settings.automatic||s.settings.locked||this.isBusy())return resolution;
    if(now>=s.nextChangeAt){
      // Hair remains stable; private attire is never introduced by the random clock.
      const outfits=new Map(catalog.outfits.map(o=>[o.id,o]));
      const candidates=approved.filter(a=>a.hairstyleId===asset.hairstyleId&&a.poseId==='idle'&&outfits.get(a.outfitId)?.access!=='private'&&a.outfitId!=='swimwear'&&this.compatible(a,s.sceneId,catalog));
      // One representative per outfit/palette keeps asset-rich expressions from biasing the draw.
      const looks=[...new Map(candidates.map(a=>[`${a.outfitId}/${a.paletteId}`,a])).values()];
      const alternatives=looks.filter(a=>a.outfitId!==asset.outfitId||a.paletteId!==asset.paletteId);
      if(alternatives.length){asset=alternatives[Math.min(alternatives.length-1,Math.floor(Math.max(0,Number(this.random())||0)*alternatives.length))];s.assetId=asset.id;s.reason='daily';s.lastVisualAt=now;s.revision++;}
      s.nextChangeAt=nextMorning(now);
    }
    if(now-s.lastVisualAt<180000)return resolution;
    const {world={},inner={}}=this.getState();
    const activity=world.activity||'';
    const pose=/睡眠|睡觉|入睡|夜间休息|午睡/u.test(activity)?'sleeping':/读书|阅读|翻书|重读|看书/u.test(activity)?'reading':/散步|逛街|步行/u.test(activity)?'walking':/休息|观影|看电影/u.test(activity)?'resting':'idle';
    const emotion=inner.fatigue>=75?'tired':inner.stress>=70?'concerned':inner.mood>=80?'happy':'soft-smile';
    const sameLook=approved.filter(a=>a.hairstyleId===asset.hairstyleId&&a.outfitId===asset.outfitId&&a.paletteId===asset.paletteId);
    const candidate=sameLook.find(a=>a.poseId===pose&&a.expressionId===emotion)||sameLook.find(a=>a.poseId===pose)||sameLook.find(a=>a.poseId==='idle'&&a.expressionId==='soft-smile');
    if(candidate&&candidate.id!==asset.id){s.assetId=candidate.id;s.reason='life-state';s.lastVisualAt=now;s.revision++;}
    return resolution;
  }
  snapshot(){return this.store.transaction(()=>{
    const manifest=this.catalog();let s=this.read();const now=this.now(s);s??=this.initial(manifest,now);const resolution=this.tick(s,manifest,now);s.observedAt=now;this.write(s);
    const asset=this.available(manifest).find(a=>a.id===s.assetId);
    return {manifest,current:this.current(asset,s),settings:s.settings,revision:s.revision,...(resolution?{resolution}:{})};
  });}
  update(patch){
    if(!patch||typeof patch!=='object'||Array.isArray(patch)||Object.keys(patch).some(k=>!allowed.has(k)))throw fail('形象设置包含未知字段');
    for(const k of boolKeys)if(k in patch&&typeof patch[k]!=='boolean')throw fail(`${k} 必须是开关`);
    if('season'in patch&&patch.season!==null&&!seasons.has(patch.season))throw fail('季节设置无效');
    if('sceneId'in patch&&patch.sceneId!==null&&typeof patch.sceneId!=='string')throw fail('场景设置无效');
    return this.store.transaction(()=>{
      const manifest=this.catalog();let s=this.read();const now=this.now(s);s??=this.initial(manifest,now);
      const before=structuredClone(s),approved=this.available(manifest),previous=approved.find(a=>a.id===s.assetId)||approved[0];
      let asset=previous;
      if('assetId'in patch){asset=approved.find(a=>a.id===patch.assetId);if(!asset)throw fail('该形象素材尚未验收或不存在');for(const k of dimensionKeys)if(k in patch&&patch[k]!==asset[k])throw fail('选定素材与形象参数不一致');}
      else if(dimensionKeys.some(k=>k in patch)){
        const wanted={...previous,...patch};asset=approved.find(a=>dimensionKeys.every(k=>a[k]===wanted[k]));
        if(!asset)throw fail('这个发型、服装、姿势和表情组合还没有可用素材，请选择一组完整造型');
      }
      const sceneId=('sceneId'in patch?patch.sceneId:s.sceneId)??null;
      if(sceneId!==null&&!manifest.scenes.some(x=>x.id===sceneId&&x.status==='ready'))throw fail('场景不存在或尚未完成');
      if(!this.compatible(asset,sceneId,manifest))throw fail('服装与场景不匹配，请一起选择合适的场景');
      const season=('season'in patch?patch.season:s.season)??'auto';
      if(!this.seasonCompatible(sceneId,season,manifest))throw fail('季节与场景不匹配，请选择对应季节的场景');
      s.assetId=asset.id;s.sceneId=sceneId;s.season=season;
      for(const k of boolKeys)if(k in patch)s.settings[k]=patch[k];
      if(!eq({...before,observedAt:0},{...s,observedAt:0})){
        s.revision++;s.nextChangeAt=nextMorning(now);s.lastVisualAt=now;s.reason='manual';
      }
      s.observedAt=now;this.write(s);
      return {manifest,current:this.current(asset,s),settings:s.settings,revision:s.revision};
    });
  }
  selectLegacyOutfit(outfitId){
    const catalog=this.catalog(),asset=this.available(catalog).find(a=>a.outfitId===outfitId&&a.hairstyleId==='original-long'&&a.poseId==='idle'&&a.paletteId==='original');
    if(!asset)throw fail('旧衣柜选择没有对应的已验收形象素材');
    const s=this.snapshot();return this.update({assetId:asset.id,sceneId:this.sceneFor(asset,catalog,s.current.sceneId)});
  }
  context(){
    const {manifest,current}=this.snapshot(),asset=manifest.assets.find(a=>a.id===current.assetId);
    const outfit=manifest.outfits.find(o=>o.id===current.outfitId),hair=manifest.hairstyles.find(h=>h.id===current.hairstyleId);
    const color=current.paletteId==='original'?'':`，${asset.recolorPart||'服装'}为${manifest.palettes.find(p=>p.id===current.paletteId)?.name||''}`;
    const detail=current.paletteId==='original'&&outfit.description?`（${outfit.description.replace(/。$/u,'')}）`:color;
    return `林雨薇当前衣着：${outfit.name}${detail}；${hair.name}。相关时自然参考；桌面背景和表情预览不新增地点、经历或情绪。`;
  }
}
