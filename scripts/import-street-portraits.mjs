import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'..');
const folder=path.join(root,'output','street_portraits_100');
const manifest=JSON.parse(fs.readFileSync(path.join(folder,'manifest.json'),'utf8'));
const base=process.env.LIFE_APP_URL || 'http://127.0.0.1:8765';
const styleMap={
  'Chinese urban':['chinese','中式街拍'],
  'Japanese street':['japanese','日式街拍'],
  'Korean street':['korean','韩式街拍'],
};
const outfitNames=[
  '白立领衬衫与直筒牛仔裤','盘扣短外套与阔腿裤','印花衬衫与长半裙','亚麻上衣与米色宽裤','黑色上衣与深色长裙',
  '改良旗袍上衣与牛仔裤','中式短夹克与工装裤','刺绣马甲与直筒裤','墨绿衬衫与黑色中裙','红针织衫与灰色西裤',
  '宽肩西装与水洗牛仔裤','短皮夹克与高腰长裙','条纹衬衫与百褶中裙','米色风衣与牛仔裤','牛仔衬衫与豹纹中裙',
  '白衬衫与藏蓝阔腿裤','丝巾黑上衣与白色长裤','拼色开衫与直筒裤','长马甲与同色宽裤','运动夹克与缎面中裙',
  '白T与宽松牛仔裤','条纹T与卡其长裙','宽松衬衫与针织背心','牛仔衬衫与蕾丝叠穿','牛仔夹克与碎花连衣裙',
  '宽松连衣裙与短马甲','Polo衫与卡其A字裙','印花卫衣与百褶长裙','海军蓝西装与浅色牛仔裤','工装外套与宽松奇诺裤',
  '开衫格纹衬衫与灯芯绒裤','短牛仔外套与宽腿裤','T恤薄纱裙叠牛仔裤','背带裙与白衬衫','背带裤与条纹T恤',
  '米色风衣与格纹长裤','黑T与蕾丝中裙','白衬衫与印花长裙','同色系宽松套装','复古图案衬衫与阔腿裤',
  '短西装与高腰牛仔裤','宽肩西装与宽松西裤','白衬衫与黑色百褶裙','灰针织衫与牛仔长裙','短牛仔夹克与直筒裤',
  '宽松卫衣与百褶裙','皮夹克与长半裙','黑上衣与深色阔腿牛仔裤','格纹衬衫与工装裤','棒球夹克与牛仔中裙',
  '黑色长大衣与牛仔裤','短羽绒服与针织连衣裙','针织上衣与宽松西裤','宽松衬衫与缎面中裙','牛仔套装与彩色帽子',
  '条纹Polo衫与百慕大短裤','深色连帽卫衣与长裙','白色短夹克与黑色宽裤','开衫与格纹中裙','宽松长衬衫与百慕大短裤',
];
const poseNames=[
  '三分之二侧身','单腿承重','前脚点地','前后错步','交叉站立','宽步站立','侧身回头','背身回望','微向前倾','仰头迎光',
  '单手插袋','双手插袋','扶衣领','整理袖口','扶眼镜','拨头发','手扶后颈','一手叉腰','双手身前轻握','双手背后',
  '迎面慢走','横穿画面','走远回头','迈步停顿','转身瞬间','回头找人','提包走路','外套搭肩走','边走边看手机','前脚踏步',
  '单肩轻靠','背靠墙','扶栏杆','倚门框','看橱窗','站在街角','街角等人','树影下侧站','轻扶立柱','楼梯平台站姿',
  '拿咖啡杯','站着翻书','调整耳机','整理围巾','撑伞侧站','抱花束','提购物袋','看腕表','低头轻笑','远望回眸',
];

if(manifest.length!==100||outfitNames.length!==60||poseNames.length!==50)throw new Error('清单数量不符');
const request=async(route,body)=>{
  const response=await fetch(base+route,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{});
  const data=await response.json();
  if(!response.ok)throw new Error(`${route}: ${data.error || response.status}`);
  return data;
};
const current=await request('/api/image-library');
const known=new Set(current.items.map(item=>item.id));
let imported=0,skipped=0;
for(const row of manifest){
  const file=path.join(folder,row.file);
  const bytes=fs.readFileSync(file);
  const hash=crypto.createHash('sha256').update(bytes).digest('hex');
  if(known.has(hash)){skipped++;continue;}
  const [streetStyle,styleName]=styleMap[row.style]||[];
  if(!streetStyle)throw new Error(`未知风格：${row.style}`);
  const outfitIndex=row.id<=60?row.id-1:row.id<=74?row.id-61:row.id<=87?20+row.id-75:40+row.id-88;
  const poseIndex=(row.id-1)%50;
  const poseGroup=row.id===80?'basic':['basic','hands','walking','setting','props'][Math.floor(poseIndex/10)];
  const poseName=row.id===80?'前脚站姿':poseNames[poseIndex];
  const outfitName=outfitNames[outfitIndex];
  const name=`${styleName} ${String(row.id).padStart(3,'0')} · ${outfitName}`;
  const uploaded=await request('/api/image-library/upload',{
    image:`data:image/png;base64,${bytes.toString('base64')}`,
    name,kind:'portrait',background:'transparent',streetStyle,poseGroup,
    activity:poseName,activities:[],seasons:[],environment:'any',
    tags:['站姿',poseName,outfitName,'透明背景'],
  });
  if(!uploaded.items.some(item=>item.id===hash&&item.streetStyle===streetStyle&&item.poseGroup===poseGroup))throw new Error(`导入后未找到分类：${row.file}`);
  known.add(hash);imported++;
  if(imported%10===0)process.stdout.write(`已导入 ${imported} 张\n`);
}
process.stdout.write(`完成：新增 ${imported} 张，已存在 ${skipped} 张。\n`);
