import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const folder=path.join(root,'output','short_skirt_50');
const manifest=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json'),'utf8'));
const base=process.env.LIFE_APP_URL || 'http://127.0.0.1:8765';
const styleByCode={C:'chinese',J:'japanese',K:'korean'};
const styleName={chinese:'中式街拍',japanese:'日式街拍',korean:'韩式街拍'};
const poseGroupByNumber=number=>number<=10?'basic':number<=20?'hands':number<=30?'walking':number<=40?'setting':'props';

if(manifest.length!==50||manifest.some((row,index)=>row.number!==index+1||!/^look_\d{3}\.png$/.test(row.file)))throw new Error('短裙图清单数量或编号不符');
const request=async(route,body)=>{
  const response=await fetch(base+route,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
  const data=await response.json();
  if(!response.ok)throw new Error(`${route}: ${data.error || response.status}`);
  return data;
};
const current=await request('/api/image-library');
const known=new Set(current.items.map(item=>item.id));
const rows=manifest.map(row=>{
  const file=path.join(folder,row.file);
  const bytes=fs.readFileSync(file);
  const hash=crypto.createHash('sha256').update(bytes).digest('hex');
  const streetStyle=styleByCode[row.code?.[0]];
  const poseNumber=Number(row.poseCode?.slice(1));
  if(!Number.isInteger(poseNumber)||poseNumber<1||poseNumber>50)throw new Error(`姿势编号无效：${row.file}`);
  const poseGroup=poseGroupByNumber(poseNumber);
  const name=`短裙穿搭 ${String(row.number).padStart(3,'0')} · ${row.outfit}`;
  const tags=['短裙穿搭','迷你裙',row.outfit,row.expression,row.headPose,row.gaze,row.poseCode,...(streetStyle?[styleName[streetStyle]]:[])];
  return {...row,bytes,hash,streetStyle,poseGroup,name,tags};
});
if(new Set(rows.map(row=>row.hash)).size!==50)throw new Error('图片内容有重复，停止导入');
const pending=rows.filter(row=>!known.has(row.hash));
console.log(`素材库现有 ${current.items.length} 张；本批已存在 ${50-pending.length} 张，待导入 ${pending.length} 张。`);
if(!process.argv.includes('--apply')){
  console.log('预览完成。使用 --apply 执行导入。');
  process.exit(0);
}
for(let index=0;index<pending.length;index++){
  const row=pending[index];
  await request('/api/image-library/upload',{
    image:`data:image/png;base64,${row.bytes.toString('base64')}`,
    name:row.name,kind:'portrait',background:'transparent',
    ...(row.streetStyle?{streetStyle:row.streetStyle}:{}),
    poseGroup:row.poseGroup,activity:row.pose,activities:[],
    seasons:[],environment:'any',tags:row.tags,
  });
  if((index+1)%10===0||index===pending.length-1)console.log(`已导入 ${index+1} / ${pending.length} 张。`);
}
const after=await request('/api/image-library');
const byId=new Map(after.items.map(item=>[item.id,item]));
const missing=rows.filter(row=>!byId.has(row.hash));
const misclassified=rows.filter(row=>{
  const item=byId.get(row.hash);
  return item&&(item.kind!=='portrait'||item.background!=='transparent'||!item.tags.includes('短裙穿搭')||item.poseGroup!==row.poseGroup||item.streetStyle!==(row.streetStyle||null));
});
if(missing.length||misclassified.length)throw new Error(`导入核对失败：缺少 ${missing.length} 张，分类异常 ${misclassified.length} 张`);
console.log(`完成：素材库现有 ${after.items.length} 张，本批 50 张均已核对。`);
