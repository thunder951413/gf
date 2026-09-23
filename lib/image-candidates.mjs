import {imageClassification} from './image-classification.mjs';

export const IMAGE_ACTIVITY_GROUPS=Object.freeze(['sleep','reading','work','cafe','walk','travel','rest','idle']);

const ALIASES={
  sleep:['sleep','睡觉','睡眠','入睡','午睡','夜间休息'],
  reading:['reading','read','阅读','读书','翻书'],
  work:['work','工作','写作','整理','sketch','sketching','速写','画画'],
  cafe:['cafe','coffee','咖啡','酒馆','bar'],
  walk:['walk','散步','逛街','步行','途中'],
  travel:['travel','旅行','出游','抵达','海边','海岸','沙滩'],
  rest:['rest','休息','看电影','放松','回到家','home','居家','meal','吃饭','waking','起床','preparation','准备','music','音乐'],
  idle:['idle','空闲','闲暇'],
};

const strings=value=>Array.isArray(value)?value.filter(value=>typeof value==='string'):typeof value==='string'?[value]:[];
const lower=value=>String(value||'').trim().toLowerCase();

// Catalogue reports answer "what is in the library". They intentionally do
// not apply a live location, so activity counts stay comparable across filters.
export function locationScopeMatches(scope,location,{catalogue=false}={}){
  scope=scope||'any';
  if(scope==='any'||catalogue)return true;
  const value=String(location||'').trim().toLowerCase();
  if(!value)return false;
  if(scope==='home'){
    // Public indoor places win even when their wording contains a private-room hint.
    if(/咖啡|咖啡馆|酒馆|办公室|办公楼|公司|前台|大堂|大厅|餐厅|商场|书店|展馆/.test(value))return false;
    return /家里|家中|卧室|住所|公寓|住宅|客房|房间/.test(value);
  }
  if(scope==='waterfront')return /海边|海岸|沙滩|海滩|泳池|游泳池|游泳馆|水上乐园/.test(value);
  return false;
}

export function activityGroups(value){
  const source=lower(value);
  if(!source)return [];
  return IMAGE_ACTIVITY_GROUPS.filter(group=>source===group||ALIASES[group].some(alias=>source.includes(alias)));
}

export function declaredActivities(item){
  const source=Array.isArray(item?.activities)?item.activities:strings(item?.activity);
  return [...new Set(source.flatMap(activityGroups))];
}

export function itemActivities(item){
  // An explicit list, including [], is an editor decision and must not be
  // contaminated by stale names, tags, or legacy activity text.
  if(Array.isArray(item?.activities))return declaredActivities(item);
  const legacy=declaredActivities(item);
  if(legacy.length)return legacy;
  const values=[item?.name,...strings(item?.tags),...strings(item?.sceneIds)];
  return [...new Set(values.flatMap(activityGroups))];
}

export function isEligibleCutout(item){
  return item?.desktopEligible===true&&Boolean(item?.cutoutUrl||item?.background==='transparent'&&item?.originalUrl);
}

function compatible(item,{season,environment,variant='cutout',location,catalogue=false}){
  if(variant==='cutout'?!isEligibleCutout(item):!item?.originalUrl)return false;
  const classification=imageClassification(item);
  return (!classification.seasons.length||classification.seasons.includes(season))
    && (classification.environment==='any'||classification.environment===environment)
    && locationScopeMatches(item?.locationScope,location,{catalogue});
}

export function imageCandidatePool(items,context={}){
  const group=IMAGE_ACTIVITY_GROUPS.includes(context.group)?context.group:'idle';
  const compatibleItems=(Array.isArray(items)?items:[]).filter(item=>compatible(item,context));
  // Sleep is intentionally isolated: neither direction may borrow a sleep image.
  const safe=group==='sleep'?compatibleItems.filter(item=>itemActivities(item).includes('sleep')):compatibleItems.filter(item=>!itemActivities(item).includes('sleep'));
  const specific=safe.filter(item=>itemActivities(item).includes(group));
  const candidates=(specific.length?specific:safe).slice().sort((a,b)=>String(a.id).localeCompare(String(b.id)));
  return {group,candidates,specificCount:specific.length,fallbackUsed:group!=='sleep'&&!specific.length&&safe.length>0};
}

export function imageCoverageReport(items,{variant='cutout'}={}){
  const matrix={};
  for(const group of IMAGE_ACTIVITY_GROUPS){
    matrix[group]={};
    for(const season of ['spring','summer','autumn','winter']){
      matrix[group][season]={};
      for(const environment of ['indoor','outdoor']){
        const pool=imageCandidatePool(items,{group,season,environment,variant,catalogue:true});
        matrix[group][season][environment]={count:pool.candidates.length,ids:pool.candidates.map(item=>item.id),specificCount:pool.specificCount,fallbackUsed:pool.fallbackUsed};
      }
    }
  }
  return {variant,groups:matrix};
}
