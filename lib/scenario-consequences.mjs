// Author-owned reactions. Only validated, committed history unlocks each line.
const EFFECTS={
 'rain-lantern':{
  'light-phone':{key:'support',label:'陪她自己处理',value:'stay',text:'你曾替她举灯，让她自己拆信。'},
  'guard-door':{key:'support',label:'替她留出空间',value:'space',text:'你曾去门边留意巡查，让她安静读信。'},
  'offer-stop':{key:'support',label:'允许她停下来',value:'rest',text:'你曾告诉她，今晚不必查完，随时可以停下。'},
  'collect-voices':{key:'material',label:'一起听城市',value:'sound',text:'你们选择收集骑楼里的门铃、车轮与收摊声。'},
  'chase-reflections':{key:'material',label:'一起看光线',value:'light',text:'你们选择追踪轨道和橱窗的雨后反光。'},
  'keep-handwriting':{key:'authorship',label:'保留原稿痕迹',value:'trace',text:'你支持保留批注，并标清她续写的那一笔。'},
  'foreground-new-work':{key:'authorship',label:'看见她的新创作',value:'new',text:'你支持让她的新素材占满最后七秒。'},
 },
 'paper-moon':{
  'keep-human':{key:'creative',label:'接纳意外',value:'accident',text:'你们留下了录音中的意外，并补录翻纸声。'},
  'feed-rerecord':{key:'creative',label:'先照顾身体',value:'rest',text:'你们先休息吃东西，再回来重录。'},
  'move-title':{key:'creative',label:'让偏差成为作品',value:'accident',text:'你们移动标题，让裁切偏差成为构图。'},
  'share-cut':{key:'creative',label:'并肩重做',value:'redo',text:'你们选择一起重切最后一张纸样。'},
 },
 'mirror-tide':{
  'charge-fruit':{key:'care',label:'留下自己的地图',value:'fruit',text:'你们收集镜果，为鸟群留下光源。'},
  'share-map-light':{key:'care',label:'暂借地图的光',value:'map',text:'你提议让她的发光地图暂时照看鸟群。'},
 }
};
export function scenarioConsequences(scenario,history=[],nodeId){
 const byKey=new Map();for(const event of history){const node=scenario.nodes[event.fromNodeId],choice=node?.choices?.find(c=>c.id===event.choiceId&&c.next===event.toNodeId);if(!choice)continue;const effect=EFFECTS[scenario.id]?.[choice.id];if(effect)byKey.set(effect.key,{...effect,choiceId:choice.id,fromNodeId:node.id});}
 const effects=[...byKey.values()];let callback=null;
 const use=(key,lines)=>{const effect=byKey.get(key);if(effect&&lines[effect.value])callback={sourceChoiceId:effect.choiceId,text:lines[effect.value]};};
 if(scenario.id==='rain-lantern'&&['workshop-cut','projection-booth'].includes(nodeId))use('material',{sound:'阮绵把声音轨单独拉出来：“你当时选了听城市，我现在舍不得把那些小声音都埋在配乐里。”',light:'阮绵停在一帧反光上：“还好你当时愿意陪我追这些光。现在剪到这儿，我反而不急着切走了。”'});
 if(scenario.id==='rain-lantern'&&nodeId==='late-supper')use('support',{stay:'她把待办纸推近一点：“你那晚只是替我举着灯，没替我拆信。我挺喜欢那样的——这次也陪我想想就好。”',space:'她把手机扣下：“你那晚替我守着门，我才敢慢慢把信读完。今晚我也想先安静吃完这顿。”',rest:'她看着还没划完的待办，先笑了：“你那晚说过可以停下。我想今天也借用一下这句话。”'});
 if(scenario.id==='rain-lantern'&&['after-rain','lights-among-us'].includes(nodeId))use('authorship',{trace:'“那一笔我没有藏。”她说，“你提醒我把它标清楚以后，留住妈妈的痕迹，也没那么像躲在她身后了。”',new:'“最后七秒，是我自己的。”她笑得有点不好意思，“你当时支持把它放大，我一直记着。”'});
 if(scenario.id==='paper-moon'&&nodeId==='rehearsal')use('creative',{accident:'她翻到校样有些不规整的地方：“我们留下的那个意外，现在倒像是这本书最会呼吸的地方。”',rest:'“那顿饭没白停。”她说，“重录的时候，我终于没再憋着一口气赶完。”',redo:'她把重切的那张纸举起来：“这张是我们一起返工的。我居然有点舍不得让它离开工作台。”'});
 if(scenario.id==='mirror-tide'&&nodeId==='clock-core')use('care',{fruit:'她摸了摸仍在身边的地图：“还好留给鸟群的是镜果。走到这里，我还能展开它看看。”',map:'她看了眼暂时没有地图的位置：“地图的光还留给那些鸟。接下来，我得更认真看眼前的路了。”'});
 return {effects,callback};
}
