import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import {decodeImage,SCENES} from './scene-images.mjs';
import {imageClassification,IMAGE_ENVIRONMENTS,IMAGE_SEASONS} from './image-classification.mjs';
import {IMAGE_ACTIVITY_GROUPS,imageCoverageReport,itemActivities} from './image-candidates.mjs';

const KEY='image-library:v1';
const KINDS=new Set(['scene','portrait']);
const BACKGROUNDS=new Set(['keep','transparent','needs-removal']);
const FITS=new Set(['contain','cover']);
export const IMAGE_OUTFIT_STYLES=Object.freeze(['ladylike','homewear','lingerie','swimwear','sailor','bodycon','shorts','sportswear','resort']);
export const IMAGE_STREET_STYLES=Object.freeze(['chinese','japanese','korean']);
export const IMAGE_POSE_GROUPS=Object.freeze(['basic','hands','walking','setting','props']);
export const IMAGE_LOCATION_SCOPES=Object.freeze(['any','home','waterfront']);
const FILE_NAME=/^[a-f0-9]{64}\.(?:png|jpg|webp)$/;

function invalid(message='图片库设置无效',code='INVALID_IMAGE_LIBRARY'){
  const error=new Error(message);error.status=400;error.code=code;return error;
}
function object(value){return value&&typeof value==='object'&&!Array.isArray(value);}
function exact(value,allowed,message){
  if(!object(value)||Object.keys(value).some(key=>!allowed.has(key)))throw invalid(message);
}
function text(value,label,{optional=false,max=120}={}){
  if(optional&&value===undefined)return undefined;
  if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw invalid(`${label}无效`);
  return value.trim();
}
function stringList(value,label,{allowed,max=24}={}){
  if(value===undefined)return undefined;
  if(!Array.isArray(value)||value.length>max)throw invalid(`${label}无效`);
  const result=[];
  for(const entry of value){
    if(typeof entry!=='string'||!entry.trim()||entry.trim().length>64||(allowed&&!allowed.has(entry)))throw invalid(`${label}无效`);
    if(!result.includes(entry.trim()))result.push(entry.trim());
  }
  return result;
}
function mime(name){return name.endsWith('.png')?'image/png':name.endsWith('.jpg')?'image/jpeg':'image/webp';}
function publicItem(item){
  const {original,cutout,...metadata}=item;
  const classification=imageClassification(item);
  return {...metadata,...classification,activities:itemActivities(item),outfitStyle:IMAGE_OUTFIT_STYLES.includes(item.outfitStyle)?item.outfitStyle:null,streetStyle:IMAGE_STREET_STYLES.includes(item.streetStyle)?item.streetStyle:null,poseGroup:IMAGE_POSE_GROUPS.includes(item.poseGroup)?item.poseGroup:null,locationScope:IMAGE_LOCATION_SCOPES.includes(item.locationScope)?item.locationScope:'any',classificationInferred:{seasons:!Object.prototype.hasOwnProperty.call(item,'seasons'),environment:!Object.prototype.hasOwnProperty.call(item,'environment'),activities:!Object.prototype.hasOwnProperty.call(item,'activities')},desktopEligible:item.desktopEligible===true,originalUrl:`/api/image-library/files/${original.file}`,cutoutUrl:cutout?`/api/image-library/files/${cutout.file}`:null};
}
function activityList(value){
  const result=stringList(value,'活动分类',{allowed:new Set(IMAGE_ACTIVITY_GROUPS),max:8});
  if(result?.includes('sleep')&&result.length>1)throw invalid('睡眠活动不能与其他活动分类共用');
  return result;
}
function hasTransparentPixel(png){
  // decodeImage has already verified the PNG envelope and IHDR. Cutouts are kept
  // deliberately narrow: 8-bit grayscale/RGB with an explicit alpha channel.
  const bitDepth=png[24],colorType=png[25],channels=colorType===4?2:colorType===6?4:0;
  if(bitDepth!==8||!channels||png[26]!==0||png[27]!==0||png[28]!==0)return false;
  const width=png.readUInt32BE(16),height=png.readUInt32BE(20),chunks=[];let offset=8;
  while(offset+12<=png.length){const length=png.readUInt32BE(offset),type=png.subarray(offset+4,offset+8).toString('ascii');if(offset+12+length>png.length)return false;if(type==='IDAT')chunks.push(png.subarray(offset+8,offset+8+length));offset+=12+length;if(type==='IEND')break;}
  let raw;try{raw=zlib.inflateSync(Buffer.concat(chunks),{maxOutputLength:width*height*channels+height});}catch{return false;}
  const stride=width*channels;if(raw.length!==height*(stride+1))return false;let prior=Buffer.alloc(stride),pos=0;
  for(let y=0;y<height;y++){
    const filter=raw[pos++],row=Buffer.alloc(stride);
    for(let x=0;x<stride;x++){
      const source=raw[pos++],left=x>=channels?row[x-channels]:0,up=prior[x],upperLeft=x>=channels?prior[x-channels]:0;
      if(filter===0)row[x]=source;else if(filter===1)row[x]=(source+left)&255;else if(filter===2)row[x]=(source+up)&255;else if(filter===3)row[x]=(source+Math.floor((left+up)/2))&255;else if(filter===4){const p=left+up-upperLeft,pa=Math.abs(p-left),pb=Math.abs(p-up),pc=Math.abs(p-upperLeft);row[x]=(source+(pa<=pb&&pa<=pc?left:pb<=pc?up:upperLeft))&255;}else return false;
    }
    for(let x=channels-1;x<stride;x+=channels)if(row[x]<255)return true;prior=row;
  }
  return false;
}
function transparentAsset(item,dir){
  const candidates=[item.cutout,...(item.background==='transparent'?[item.original]:[])];
  for(const asset of candidates){
    if(!asset?.file?.endsWith('.png'))continue;
    try{if(hasTransparentPixel(fs.readFileSync(path.join(dir,asset.file))))return asset;}catch{}
  }
  return null;
}

export class ImageLibraryRepository{
  constructor(store,{dataDir,sceneImages}){
    if(!sceneImages||typeof sceneImages.read!=='function'||typeof sceneImages.update!=='function')throw new TypeError('sceneImages repository is required');
    this.store=store;this.sceneImages=sceneImages;this.dir=path.join(dataDir,'scene-images');
    fs.mkdirSync(this.dir,{recursive:true,mode:0o700});
  }
  read(){
    const row=this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(KEY);let saved={};
    try{saved=row?JSON.parse(row.value):{};}catch{}
    return {revision:Number.isSafeInteger(saved.revision)?saved.revision:0,items:Array.isArray(saved.items)?saved.items.filter(item=>object(item)&&typeof item.id==='string'):[],importedFiles:Array.isArray(saved.importedFiles)?saved.importedFiles.filter(file=>typeof file==='string'&&FILE_NAME.test(file)):[]};
  }
  write(state){this.store.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(KEY,JSON.stringify(state));}
  importAssigned(state){
    const assigned=this.sceneImages.read().files;let changed=false;const known=new Set(state.importedFiles),grouped=new Map();
    for(const [sceneId,file] of Object.entries(assigned))if(SCENES.some(([id])=>id===sceneId)&&FILE_NAME.test(file)){const ids=grouped.get(file)||[];ids.push(sceneId);grouped.set(file,ids);}
    for(const [file,sceneIds] of grouped){
      if(known.has(file))continue;
      // A library asset assigned through apply, including a cutout, is already
      // represented. Recording it prevents the lazy importer from creating a
      // second item or restoring metadata the user deliberately edited away.
      if(state.items.some(item=>item.original?.file===file||item.cutout?.file===file)){known.add(file);changed=true;continue;}
      const disk=path.join(this.dir,file);try{if(!fs.statSync(disk).isFile())continue;}catch{continue;}
      const now=new Date().toISOString(),item={id:file.slice(0,64),name:SCENES.find(([id])=>id===sceneIds[0])[1],kind:'scene',sceneIds,tags:[],activity:'',background:'keep',desktopEligible:false,original:{file,type:mime(file)},cutout:null,createdAt:now,updatedAt:now};
      state.items.push(item);known.add(file);changed=true;
    }
    state.importedFiles=[...known];if(changed){state.revision++;this.write(state);}
    return state;
  }
  snapshot(){
    const state=this.importAssigned(this.read());
    const items=state.items.map(publicItem);
    return {revision:state.revision,items,coverage:imageCoverageReport(items),scenes:SCENES.map(([id,name])=>({id,name}))};
  }
  upload(patch){
    exact(patch,new Set(['image','name','sceneIds','tags','kind','activity','activities','background','seasons','environment','outfitStyle','streetStyle','poseGroup','locationScope']));
    if(!('image'in patch))throw invalid('必须提供图片','IMAGE_REQUIRED');
    const decoded=decodeImage(patch.image),state=this.importAssigned(this.read());
    const ids=new Set(SCENES.map(([id])=>id));
    const name=text(patch.name,'名称',{optional:true})||`图片 ${state.items.length+1}`;
    const sceneIds=stringList(patch.sceneIds,'场景',{allowed:ids})||[];
    const tags=stringList(patch.tags,'标签')||[];
    const kind=patch.kind===undefined?'portrait':patch.kind;
    const activity=patch.activity===undefined?'':(typeof patch.activity==='string'&&patch.activity.trim().length<=120?patch.activity.trim():(()=>{throw invalid('活动描述无效');})());
    const activities=activityList(patch.activities);
    const background=patch.background===undefined?'keep':patch.background;
    const seasons=stringList(patch.seasons,'适用季节',{allowed:new Set(IMAGE_SEASONS),max:4});
    const environment=patch.environment;
    const outfitStyle=patch.outfitStyle;
    const streetStyle=patch.streetStyle;
    const poseGroup=patch.poseGroup;
    const locationScope=patch.locationScope===undefined?'any':patch.locationScope;
    if(!KINDS.has(kind))throw invalid('图片类型无效');if(!BACKGROUNDS.has(background))throw invalid('背景状态无效');
    if(environment!==undefined&&!IMAGE_ENVIRONMENTS.includes(environment))throw invalid('室内外分类无效');
    if(outfitStyle!==undefined&&outfitStyle!==null&&!IMAGE_OUTFIT_STYLES.includes(outfitStyle))throw invalid('服装风格无效');
    if(streetStyle!==undefined&&streetStyle!==null&&!IMAGE_STREET_STYLES.includes(streetStyle))throw invalid('街拍风格无效');
    if(poseGroup!==undefined&&poseGroup!==null&&!IMAGE_POSE_GROUPS.includes(poseGroup))throw invalid('姿势类别无效');
    if(!IMAGE_LOCATION_SCOPES.includes(locationScope))throw invalid('地点范围无效');
    if(state.items.some(item=>item.id===decoded.hash))return this.snapshot();
    const file=`${decoded.hash}.${decoded.ext}`,disk=path.join(this.dir,file);
    if(!fs.existsSync(disk))fs.writeFileSync(disk,decoded.data,{mode:0o600,flag:'wx'});
    const now=new Date().toISOString();state.items.push({id:decoded.hash,name,kind,sceneIds,tags,activity,...(activities===undefined?{}:{activities}),background,...(seasons===undefined?{}:{seasons}),...(environment===undefined?{}:{environment}),...(outfitStyle?{outfitStyle}:{}),...(streetStyle?{streetStyle}:{}),...(poseGroup?{poseGroup}:{}),...(locationScope==='any'?{}:{locationScope}),desktopEligible:false,original:{file,type:mime(file)},cutout:null,createdAt:now,updatedAt:now});state.revision++;this.write(state);
    return this.snapshot();
  }
  metadata(patch){
    exact(patch,new Set(['id','name','sceneIds','tags','kind','activity','activities','background','desktopEligible','seasons','environment','outfitStyle','streetStyle','poseGroup','locationScope']));
    const id=text(patch.id,'图片 ID',{max:64}),state=this.importAssigned(this.read()),item=state.items.find(entry=>entry.id===id);
    if(!item)throw invalid('图片不存在','IMAGE_NOT_FOUND');if(Object.keys(patch).length===1)throw invalid();
    if('name'in patch)item.name=text(patch.name,'名称');
    if('sceneIds'in patch)item.sceneIds=stringList(patch.sceneIds,'场景',{allowed:new Set(SCENES.map(([sceneId])=>sceneId))});
    if('tags'in patch)item.tags=stringList(patch.tags,'标签');
    if('kind'in patch){if(!KINDS.has(patch.kind))throw invalid('图片类型无效');item.kind=patch.kind;}
    if('activity'in patch)item.activity=typeof patch.activity==='string'&&patch.activity.trim().length<=120?patch.activity.trim():(()=>{throw invalid('活动描述无效');})();
    if('activities'in patch)item.activities=activityList(patch.activities);
    if('background'in patch){if(!BACKGROUNDS.has(patch.background))throw invalid('背景状态无效');item.background=patch.background;}
    if('seasons'in patch)item.seasons=stringList(patch.seasons,'适用季节',{allowed:new Set(IMAGE_SEASONS),max:4});
    if('environment'in patch){if(!IMAGE_ENVIRONMENTS.includes(patch.environment))throw invalid('室内外分类无效');item.environment=patch.environment;}
    if('outfitStyle'in patch){if(patch.outfitStyle!==null&&!IMAGE_OUTFIT_STYLES.includes(patch.outfitStyle))throw invalid('服装风格无效');if(patch.outfitStyle===null)delete item.outfitStyle;else item.outfitStyle=patch.outfitStyle;}
    if('streetStyle'in patch){if(patch.streetStyle!==null&&!IMAGE_STREET_STYLES.includes(patch.streetStyle))throw invalid('街拍风格无效');if(patch.streetStyle===null)delete item.streetStyle;else item.streetStyle=patch.streetStyle;}
    if('poseGroup'in patch){if(patch.poseGroup!==null&&!IMAGE_POSE_GROUPS.includes(patch.poseGroup))throw invalid('姿势类别无效');if(patch.poseGroup===null)delete item.poseGroup;else item.poseGroup=patch.poseGroup;}
    if('locationScope'in patch){if(!IMAGE_LOCATION_SCOPES.includes(patch.locationScope))throw invalid('地点范围无效');if(patch.locationScope==='any')delete item.locationScope;else item.locationScope=patch.locationScope;}
    if('desktopEligible'in patch){
      if(typeof patch.desktopEligible!=='boolean')throw invalid('桌面资格必须是布尔值');
      if(patch.desktopEligible&&!transparentAsset(item,this.dir))throw invalid('桌面资格只能在已验证含透明像素的透明衍生图，或背景标为透明且原图确有透明像素时启用','DESKTOP_ELIGIBILITY_REQUIRES_TRANSPARENCY');
      item.desktopEligible=patch.desktopEligible;
    }else if(item.desktopEligible===true&&!transparentAsset(item,this.dir))item.desktopEligible=false;
    item.updatedAt=new Date().toISOString();state.revision++;this.write(state);return this.snapshot();
  }
  derivative(patch){
    exact(patch,new Set(['id','image']));const id=text(patch.id,'图片 ID',{max:64});if(!('image'in patch))throw invalid('必须提供图片','IMAGE_REQUIRED');
    const decoded=decodeImage(patch.image);if(decoded.ext!=='png'||!hasTransparentPixel(decoded.data))throw invalid('透明衍生图必须是含有透明像素的 8 位 PNG','CUTOUT_TRANSPARENCY_REQUIRED');
    const state=this.importAssigned(this.read()),item=state.items.find(entry=>entry.id===id);if(!item)throw invalid('图片不存在','IMAGE_NOT_FOUND');
    const file=`${decoded.hash}.png`,disk=path.join(this.dir,file);if(!fs.existsSync(disk))fs.writeFileSync(disk,decoded.data,{mode:0o600,flag:'wx'});
    const replaced=item.cutout?.file!==file;item.cutout={file,type:'image/png'};if(replaced)item.desktopEligible=false;
    item.updatedAt=new Date().toISOString();state.revision++;this.write(state);return this.snapshot();
  }
  apply(patch){
    exact(patch,new Set(['id','sceneId','variant','fit']));const id=text(patch.id,'图片 ID',{max:64});
    if(!SCENES.some(([sceneId])=>sceneId===patch.sceneId))throw invalid('场景不存在','INVALID_SCENE_ID');
    if(!['original','cutout'].includes(patch.variant))throw invalid('图片版本无效');if(patch.fit!==undefined&&!FITS.has(patch.fit))throw invalid('显示方式无效');
    const state=this.importAssigned(this.read()),item=state.items.find(entry=>entry.id===id);if(!item)throw invalid('图片不存在','IMAGE_NOT_FOUND');
    const asset=patch.variant==='cutout'?item.cutout:item.original;if(!asset)throw invalid('图片没有透明衍生版本','CUTOUT_REQUIRED');
    const disk=path.join(this.dir,asset.file);let data;try{data=fs.readFileSync(disk);}catch{throw invalid('图片文件不存在','IMAGE_FILE_NOT_FOUND');}
    this.sceneImages.update({sceneId:patch.sceneId,image:`data:${asset.type};base64,${data.toString('base64')}`,...(patch.fit===undefined?{}:{fit:patch.fit}),activeSceneId:patch.sceneId,enabled:true});
    return this.snapshot();
  }
  file(name){
    if(!FILE_NAME.test(name))return null;const state=this.importAssigned(this.read());
    if(!state.items.some(item=>item.original.file===name||item.cutout?.file===name))return null;
    const file=path.join(this.dir,name);try{const stat=fs.statSync(file);return stat.isFile()?{file,stat,type:mime(name)}:null;}catch{return null;}
  }
}
