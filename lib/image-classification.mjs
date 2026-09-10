export const IMAGE_SEASONS=['spring','summer','autumn','winter'];
export const IMAGE_ENVIRONMENTS=['indoor','outdoor','any'];

const SEASON_WORDS={
  spring:['spring','春天','春日','春季','樱花'],
  summer:['summer','夏天','夏日','夏季','盛夏'],
  autumn:['autumn','fall','秋天','秋日','秋季','银杏'],
  winter:['winter','冬天','冬日','冬季','雪景'],
};
const OUTDOOR_WORDS=['outdoor','outside','street','beach','coast','balcony','terrace','courtyard','garden','park','hiking','seaside','walk','travel','户外','室外','街头','街道','街角','街边','街景','海边','海岸','沙滩','阳台','露台','庭院','公园','花园','远足','步行','散步','旅行'];
const INDOOR_WORDS=['indoor','inside','bedroom','living room','kitchen','study room','library','室内','卧室','客厅','厨房','书房','图书馆','居家'];
const BROAD_INDOOR_WORDS=['cafe','coffee shop','museum','gallery','bookshop','咖啡馆','咖啡店','博物馆','美术馆','画廊','书店'];
const ACTIVITY_INDOOR_WORDS=['work','sleep','read','rest','工作','睡觉','睡眠','读书','阅读','休息'];

function values(item,includeScenes=false){
  const result=[item?.name,item?.activity,...(Array.isArray(item?.tags)?item.tags:[])];
  if(includeScenes)result.push(...(Array.isArray(item?.sceneIds)?item.sceneIds:[]));
  return result.filter(value=>typeof value==='string').join(' ').toLowerCase();
}
function contains(text,words){return words.some(word=>text.includes(word));}

export function imageClassification(item){
  const explicitSeasons=Object.prototype.hasOwnProperty.call(item||{},'seasons');
  const explicitEnvironment=Object.prototype.hasOwnProperty.call(item||{},'environment');
  let seasons;
  if(explicitSeasons)seasons=Array.isArray(item.seasons)?item.seasons.filter(value=>IMAGE_SEASONS.includes(value)):[];
  else{
    const strong=values(item),fromScenes=values({sceneIds:item?.sceneIds},true);
    seasons=IMAGE_SEASONS.filter(season=>contains(strong,SEASON_WORDS[season]));
    if(!seasons.length)seasons=IMAGE_SEASONS.filter(season=>contains(fromScenes,SEASON_WORDS[season]));
  }
  let environment;
  if(explicitEnvironment)environment=IMAGE_ENVIRONMENTS.includes(item.environment)?item.environment:'any';
  else{
    const strong=values(item),scenes=values({sceneIds:item?.sceneIds},true);
    if(contains(strong,OUTDOOR_WORDS))environment='outdoor';
    else if(contains(strong,INDOOR_WORDS)||contains(strong,BROAD_INDOOR_WORDS)||contains(strong,ACTIVITY_INDOOR_WORDS))environment='indoor';
    else if(contains(scenes,OUTDOOR_WORDS))environment='outdoor';
    else if(contains(scenes,INDOOR_WORDS)||contains(scenes,BROAD_INDOOR_WORDS))environment='indoor';
    else environment='any';
  }
  return {seasons:[...new Set(seasons)],environment};
}
