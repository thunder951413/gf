import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const plan=JSON.parse(fs.readFileSync(path.join(root,'output','wuwa_female_photoreal','generation-plan.json'),'utf8'));
const base=process.env.LIFE_APP_URL||'http://127.0.0.1:8765';
if(plan.totalCharacters!==45||plan.images.length!==90)throw new Error('鸣潮清单数量不符');
const request=async(route,body)=>{
  const response=await fetch(base+route,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
  const data=await response.json();
  if(!response.ok)throw new Error(`${route}: ${data.error||response.status}`);
  return data;
};
const current=await request('/api/image-library');
const known=new Set(current.items.map(item=>item.id));
const rows=plan.images.map(row=>{
  const bytes=fs.readFileSync(row.target);
  const hash=crypto.createHash('sha256').update(bytes).digest('hex');
  const poseGroup=/step|walk|turn|sway/i.test(row.pose.action)?'walking':/charm|note|ornament|hat/i.test(row.pose.action)?'props':'hands';
  return {...row,bytes,hash,poseGroup};
});
if(new Set(rows.map(row=>row.hash)).size!==90)throw new Error('图片内容重复，停止导入');
const pending=rows.filter(row=>!known.has(row.hash));
console.log(`素材库现有 ${current.items.length} 张；本批已存在 ${90-pending.length} 张，待导入 ${pending.length} 张。`);
if(!process.argv.includes('--apply'))process.exit(0);
for(let i=0;i<pending.length;i++){
  const row=pending[i];
  await request('/api/image-library/upload',{
    image:`data:image/png;base64,${row.bytes.toString('base64')}`,
    name:`鸣潮 · ${row.character} · ${String(row.variant).padStart(2,'0')}`,
    kind:'portrait',background:'transparent',poseGroup:row.poseGroup,
    activity:row.pose.action,activities:[],seasons:[],environment:'any',
    tags:['鸣潮','鸣潮角色','真人照片','同一人物','可爱动作',row.character,row.element,row.pose.expression,row.pose.head,row.pose.gaze],
  });
  if((i+1)%10===0||i===pending.length-1)console.log(`已导入 ${i+1} / ${pending.length} 张。`);
}
const after=await request('/api/image-library');
const byId=new Map(after.items.map(item=>[item.id,item]));
const missing=rows.filter(row=>!byId.has(row.hash));
const bad=rows.filter(row=>{
  const item=byId.get(row.hash);
  return item&&(item.kind!=='portrait'||item.background!=='transparent'||!item.tags.includes('鸣潮角色')||item.poseGroup!==row.poseGroup);
});
if(missing.length||bad.length)throw new Error(`导入核对失败：缺少 ${missing.length} 张，分类异常 ${bad.length} 张`);
console.log(`完成：本批 90 张均已核对，素材库现有 ${after.items.length} 张。`);
