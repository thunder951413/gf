import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEY='scene-images:v1';
const MAX_BYTES=12*1024*1024;
const MAX_DIMENSION=12000;
const MAX_PIXELS=40_000_000;
export const SCENES=[
  ['study','书房'],['summer-coast','夏日海岸'],['autumn-cafe','秋日咖啡馆'],
  ['winter-home','冬日居所'],['private-bedroom','私密卧室'],['spring-study','春日窗边'],
];

function invalid(message='场景图片设置无效',code='INVALID_SCENE_IMAGE'){const error=new Error(message);error.status=400;error.code=code;return error;}
function dimensions(data,mime){
  if(mime==='image/png'){
    if(data.length<45||!data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))||data.subarray(12,16).toString('ascii')!=='IHDR'||!data.subarray(-12,-8).equals(Buffer.from([0,0,0,0]))||data.subarray(-8,-4).toString('ascii')!=='IEND')return null;
    return [data.readUInt32BE(16),data.readUInt32BE(20)];
  }
  if(mime==='image/jpeg'){
    if(data.length<4||data[0]!==0xff||data[1]!==0xd8||data.at(-2)!==0xff||data.at(-1)!==0xd9)return null;
    let offset=2;
    while(offset+4<=data.length){while(data[offset]===0xff)offset++;const marker=data[offset++];if(marker===0xd9||marker===0xda)break;if(offset+2>data.length)return null;const length=data.readUInt16BE(offset);if(length<2||offset+length>data.length)return null;if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)&&length>=7)return [data.readUInt16BE(offset+5),data.readUInt16BE(offset+3)];offset+=length;}
    return null;
  }
  if(mime==='image/webp'){
    if(data.length<25||data.subarray(0,4).toString('ascii')!=='RIFF'||data.subarray(8,12).toString('ascii')!=='WEBP'||data.readUInt32LE(4)+8!==data.length)return null;
    const kind=data.subarray(12,16).toString('ascii');
    if(kind==='VP8X'&&data.length>=30)return [1+data.readUIntLE(24,3),1+data.readUIntLE(27,3)];
    if(kind==='VP8 '&&data.length>=30&&data[23]===0x9d&&data[24]===0x01&&data[25]===0x2a)return [data.readUInt16LE(26)&0x3fff,data.readUInt16LE(28)&0x3fff];
    if(kind==='VP8L'&&data.length>=25&&data[20]===0x2f){const bits=data.readUInt32LE(21);return [(bits&0x3fff)+1,((bits>>>14)&0x3fff)+1];}
    return null;
  }
  return null;
}
export function decodeImage(value){
  if(typeof value!=='string')throw invalid('图片必须是 PNG、JPEG 或 WebP 数据','INVALID_IMAGE');
  const match=value.match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/);
  if(!match||match[2].length%4!==0||(match[2].includes('=')&&!/=+$/.test(match[2])))throw invalid('图片数据格式无效','INVALID_IMAGE');
  const data=Buffer.from(match[2],'base64');
  if(!data.length||data.length>MAX_BYTES||data.toString('base64')!==match[2])throw invalid(data.length>MAX_BYTES?'图片不能超过 12MB':'图片数据格式无效',data.length>MAX_BYTES?'IMAGE_TOO_LARGE':'INVALID_IMAGE');
  const size=dimensions(data,match[1]);
  if(!size)throw invalid('图片内容与格式不匹配或图片已损坏','INVALID_IMAGE');
  if(!size[0]||!size[1]||size[0]>MAX_DIMENSION||size[1]>MAX_DIMENSION||size[0]*size[1]>MAX_PIXELS)throw invalid('图片尺寸过大','IMAGE_DIMENSIONS_TOO_LARGE');
  const ext=match[1]==='image/png'?'png':match[1]==='image/jpeg'?'jpg':'webp';
  return {data,ext,hash:crypto.createHash('sha256').update(data).digest('hex')};
}

export class SceneImagesRepository{
  constructor(store,{dataDir}){this.store=store;this.dir=path.join(dataDir,'scene-images');fs.mkdirSync(this.dir,{recursive:true,mode:0o700});}
  read(){
    const row=this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(KEY);let saved={};
    try{saved=row?JSON.parse(row.value):{};}catch{}
    return {enabled:Boolean(saved.enabled),activeSceneId:typeof saved.activeSceneId==='string'?saved.activeSceneId:null,revision:Number.isSafeInteger(saved.revision)?saved.revision:0,files:saved.files&&typeof saved.files==='object'?saved.files:{},fits:saved.fits&&typeof saved.fits==='object'?saved.fits:{}};
  }
  snapshot(){const state=this.read();return {enabled:state.enabled,activeSceneId:state.activeSceneId,revision:state.revision,scenes:SCENES.map(([id,name])=>({id,name,imageUrl:state.files[id]?`/api/scene-images/files/${state.files[id]}`:null,fit:state.fits[id]==='cover'?'cover':'contain'}))};}
  update(patch){
    if(!patch||typeof patch!=='object'||Array.isArray(patch))throw invalid();
    const allowed=new Set(['sceneId','image','fit','activeSceneId','enabled']),keys=Object.keys(patch);
    if(!keys.length||keys.some(key=>!allowed.has(key)))throw invalid();
    const state=this.read(),ids=new Set(SCENES.map(item=>item[0]));
    if('sceneId'in patch&&(!ids.has(patch.sceneId)))throw invalid('场景不存在','INVALID_SCENE_ID');
    if(('image'in patch||'fit'in patch)&&!('sceneId'in patch))throw invalid('修改图片或显示方式时必须指定场景','SCENE_ID_REQUIRED');
    if('fit'in patch&&!['contain','cover'].includes(patch.fit))throw invalid('显示方式无效');
    if('activeSceneId'in patch&&!ids.has(patch.activeSceneId))throw invalid('场景不存在','INVALID_SCENE_ID');
    if('enabled'in patch&&typeof patch.enabled!=='boolean')throw invalid('启用状态无效');
    let decoded=null;if('image'in patch&&patch.image!==null)decoded=decodeImage(patch.image);
    const next={...state,files:{...state.files},fits:{...state.fits}};
    if('fit'in patch)next.fits[patch.sceneId]=patch.fit;
    if('image'in patch){
      if(patch.image===null){delete next.files[patch.sceneId];if(next.activeSceneId===patch.sceneId){next.activeSceneId=null;next.enabled=false;}}
      else next.files[patch.sceneId]=`${decoded.hash}.${decoded.ext}`;
    }
    if('activeSceneId'in patch){if(!next.files[patch.activeSceneId])throw invalid('请先为这个场景上传图片','SCENE_IMAGE_REQUIRED');next.activeSceneId=patch.activeSceneId;}
    if('enabled'in patch){if(patch.enabled&&(!next.activeSceneId||!next.files[next.activeSceneId]))throw invalid('启用前请选择已有图片的场景','SCENE_IMAGE_REQUIRED');next.enabled=patch.enabled;}
    next.revision=state.revision+1;
    if(decoded){const file=path.join(this.dir,`${decoded.hash}.${decoded.ext}`);if(!fs.existsSync(file))fs.writeFileSync(file,decoded.data,{mode:0o600,flag:'wx'});}
    this.store.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run(KEY,JSON.stringify(next));
    return this.snapshot();
  }
  file(name){const state=this.read();if(!/^[a-f0-9]{64}\.(?:png|jpg|webp)$/.test(name)||!Object.values(state.files).includes(name))return null;const file=path.join(this.dir,name);try{const stat=fs.statSync(file);if(!stat.isFile())return null;return {file,stat,type:name.endsWith('.png')?'image/png':name.endsWith('.jpg')?'image/jpeg':'image/webp'};}catch{return null;}}
  context(){const state=this.read();if(!state.enabled)return null;const scene=SCENES.find(item=>item[0]===state.activeSceneId);return scene?`当前界面使用用户亲自选择的完整场景照片（${scene[1]}）。你无法从这张图片推断她此刻的衣着、发型、外貌或现实生活状态；不要把旧版生成形象中的衣着和发型描述成当前事实。`:null;}
}
