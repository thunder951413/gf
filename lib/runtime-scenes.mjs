import crypto from 'node:crypto';
import {imageClassification} from './image-classification.mjs';

const KEY='runtime-scene-selection:miyue';
const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const words=value=>String(value||'').toLowerCase();
const seasons={spring:'春季',summer:'夏季',autumn:'秋季',winter:'冬季'};
const ACTIVITY_GROUPS=[
  ['sleep',['sleep','睡','入睡','夜间休息','午睡']],
  ['reading',['reading','书','阅读','读书','翻书']],
  ['work',['work','工作','写作','整理']],
  ['cafe',['cafe','咖啡','酒馆']],
  ['walk',['walk','散步','逛街','步行','途中']],
  ['travel',['travel','旅行','出游','海边','抵达']],
  ['rest',['rest','休息','看电影','放松','回到家']],
];
const activityGroup=text=>ACTIVITY_GROUPS.find(([,terms])=>terms.some(term=>text.includes(term)))?.[0]||'idle';
const isCutout=item=>item.desktopEligible===true&&Boolean(item.cutoutUrl||item.background==='transparent');

export function imageEnvironment(runtime){
  const location=words(runtime.current?.location||runtime.world?.location);
  if(/露台|庭院|阳台|户外|室外/.test(location))return 'outdoor';
  if(runtime.current?.kind==='sleep'||/室内|家中|家里|卧室|工作室|办公室|酒店|旅馆/.test(location))return 'indoor';
  if(/户外|室外|街|公园|海边|海岸|沙滩|山间|露台|庭院|阳台|广场|河边|湖边/.test(location))return 'outdoor';
  if(/室内|家|书房|卧室|工作室|办公室|咖啡|酒馆|酒店|旅馆|餐厅|书店|展馆/.test(location))return 'indoor';
  return ['walk','travel'].includes(activityGroup(words(runtime.current?.kind)))?'outdoor':'indoor';
}
export function imageSeason(at){
  const month=Number(new Intl.DateTimeFormat('en',{timeZone:'Asia/Shanghai',month:'numeric'}).format(new Date(at)));
  return month>=3&&month<=5?'spring':month>=6&&month<=8?'summer':month>=9&&month<=11?'autumn':'winter';
}

export class RuntimeScenes {
  constructor(store,{sceneImages,imageLibrary}){Object.assign(this,{store,sceneImages,imageLibrary});}
  read(){try{return JSON.parse(this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(KEY)?.value||'{}');}catch{return {};}}
  save(state){if(JSON.stringify(state)!==JSON.stringify(this.read()))this.store.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(KEY,JSON.stringify(state));return state;}
  fallback(state,reason){
    if(this.sceneImages.snapshot().enabled)this.sceneImages.update({enabled:false});
    return this.save({mode:'automatic',...state,avatarMode:'fallback',candidateCount:0,reason});
  }
  sync(runtime,{force=false}={}){
    if(!force&&(!runtime.settings.enabled||!runtime.settings.automaticScenes))return this.save({mode:'manual',reason:'桌面图片已固定，生活状态仍可独立推进。'});
    const at=new Date(runtime.at||new Date()),now=+at;
    const sceneId=runtime.current?.sceneId,activityId=runtime.current?.id;
    if(!sceneId||!activityId){if(force)throw Object.assign(new Error('当前没有可切换的图片场景。'),{status:409});return this.fallback({activityId,sceneId},'当前活动没有匹配的图片场景，显示备用角色。');}
    const season=runtime.settings.imageSeason&&runtime.settings.imageSeason!=='auto'?runtime.settings.imageSeason:imageSeason(at);
    const environment=runtime.settings.imageEnvironment&&runtime.settings.imageEnvironment!=='auto'?runtime.settings.imageEnvironment:imageEnvironment(runtime);
    const variant=force?'cutout':runtime.settings.imageVariant||'cutout';
    const minutes=runtime.settings.imageRotationMinutes??30;
    const group=activityGroup(words([runtime.current.kind,runtime.current.title].join(' ')));
    const contextKey=JSON.stringify([sceneId,group,season,environment,variant,minutes]);
    const base={activityId,sceneId,activityGroup:group,season,environment,contextKey};
    const library=this.imageLibrary.snapshot();
    // Explicit incompatible classifications are excluded, never silently relaxed.
    const compatible=library.items.filter(item=>{
      if(variant==='cutout'?!isCutout(item):!item.originalUrl)return false;
      const tags=imageClassification(item);
      if(tags.seasons.length&&!tags.seasons.includes(season))return false;
      if(tags.environment!=='any'&&tags.environment!==environment)return false;
      const itemGroup=activityGroup(words([item.activity,...(item.tags||[])].join(' ')));
      return group==='sleep'?itemGroup==='sleep':itemGroup!=='sleep';
    });
    // Match the current activity first; general photos are a fallback when it has no match.
    const specific=compatible.filter(item=>activityGroup(words(item.activity))===group);
    const pool=(specific.length?specific:compatible)
      .sort((a,b)=>a.id.localeCompare(b.id));
    if(!pool.length){if(force)throw Object.assign(new Error('当前季节和状态没有其他可用的透明人物，可在图片素材库调整分类。'),{status:409});return this.fallback(base,`${seasons[season]}·${environment==='indoor'?'室内':'室外'}没有匹配${group==='sleep'?'睡眠状态的':''}${variant==='cutout'?'已启用透明人物':'照片'}，可在图片库调整分类或切换图片版本。`);}
    const previous=this.read(),sameContext=previous.contextKey===contextKey;
    if(force){
      const snapshot=this.sceneImages.snapshot(),active=snapshot.enabled?snapshot.scenes.find(row=>row.id===snapshot.activeSceneId)?.imageUrl:null;
      const shown=pool.find(item=>active&&[item.cutoutUrl,item.originalUrl].some(url=>url&&url.split('/').at(-1)===active.split('/').at(-1)));
      previous.itemId=shown?.id||null;
      if(pool.length===1&&shown)throw Object.assign(new Error('当前只有这一张匹配的透明人物，暂时没有其他形象。'),{status:409});
    }
    const currentItem=pool.find(item=>item.id===previous.itemId);
    const due=minutes>0&&(!previous.nextRotationAt||Date.parse(previous.nextRotationAt)<=now);
    const hold=!force&&sameContext&&currentItem&&!due;
    const poolIds=new Set(pool.map(item=>item.id));
    let selected=currentItem,seen=sameContext?(previous.seen||[]).filter(id=>poolIds.has(id)):[],cycle=previous.cycle||0;
    if(!hold){
      const allowed=pool.filter(item=>!seen.includes(item.id)&&item.id!==previous.itemId);
      if(!allowed.length){seen=[];cycle++;}
      const choices=allowed.length?allowed:pool.filter(item=>item.id!==previous.itemId);
      selected=(choices.length?choices:pool).slice().sort((a,b)=>hash(contextKey+cycle+a.id).localeCompare(hash(contextKey+cycle+b.id)))[0];
      seen=[...seen,selected.id];
    }
    const assetVariant=variant==='cutout'&&selected.cutoutUrl?'cutout':'original';
    const selectedURL=assetVariant==='cutout'?selected.cutoutUrl:selected.originalUrl;
    const desiredURL='/api/scene-images/files/'+selectedURL.split('/').at(-1);
    const current=this.sceneImages.snapshot(),target=current.scenes.find(row=>row.id===sceneId);
    if(!current.enabled||current.activeSceneId!==sceneId||target?.imageUrl!==desiredURL||target?.fit!=='contain')this.imageLibrary.apply({id:selected.id,sceneId,variant:assetVariant,fit:'contain'});
    const selectedAt=hold||sameContext&&selected.id===previous.itemId?previous.selectedAt:at.toISOString();
    const nextRotationAt=minutes>0?(hold?previous.nextRotationAt:new Date(now+minutes*60000).toISOString()):null;
    return this.save({mode:'automatic',...base,avatarMode:variant==='cutout'?'cutout':'photo',itemId:selected.id,itemName:selected.name,variant:assetVariant,imageUrl:desiredURL,selectedAt,nextRotationAt,seen,cycle,candidateCount:pool.length,reason:`${seasons[season]}·${environment==='indoor'?'室内':'室外'}：${selected.name}。${pool.length===1?'当前只有一张匹配图片。':minutes?`每 ${minutes} 分钟轮换，候选 ${pool.length} 张，轮完前不重复。`:'仅随场景条件变化换图。'}`});
  }
}
