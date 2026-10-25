import { randomUUID } from 'node:crypto';
import { normalizeTravelPlan, travelState } from './travel-state.mjs';

export const LIFE_EVENT_VERSION = '1.0.0';
export const DEFAULT_WEEKLY_TRAVEL_CHANCE = 0.05;
export const DAILY_ORDINARY_EVENT_CHANCE = 0.9;

export const CATEGORY_WEIGHTS = Object.freeze({
  meal: 11,
  cooking: 10,
  clothing: 7,
  commute: 7,
  hobby: 12,
  family: 8,
  work: 15,
  local_walk: 10,
  reading: 10,
  emotional_need: 10,
});

const ordinary = (category, id, title, location, variants, sourceHints) => Object.freeze({
  category, id, title, location, variants, sourceHints,
});

// These are small, fictional pieces of 林晓薇's own life. They deliberately avoid
// live weather, news, shop-opening, and other claims that would need verification.
export const ORDINARY_EVENT_CATALOG = Object.freeze([
  ordinary('meal', 'meal-noodle', '给自己认真做一顿面', '苏州的家中', [
    ['番茄鸡蛋面', '切番茄时把酸甜味想得很具体', '端着热面坐到窗边慢慢吃', '今天想吃得踏实一点'],
    ['葱油拌面', '把葱段小火熬到焦香', '拌匀后给碗边擦得干干净净', '想把普通一餐过得有仪式感'],
  ], ['家常面食', '独居做饭', '苏州日常']),
  ordinary('meal', 'meal-breakfast', '补上一顿不赶时间的早餐', '苏州的家中', [
    ['热豆浆和鸡蛋', '把豆浆温好又切了半个苹果', '收拾餐桌时发现心也静下来了', '想提醒自己别拿忙当作漏餐的理由'],
    ['吐司与酸奶碗', '把坚果和水果分成很顺眼的颜色', '吃完顺手记下下次想换的搭配', '想从照顾身体开始一天'],
  ], ['早餐搭配', '居家生活', '自我照料']),
  ordinary('meal', 'meal-leftovers', '把冰箱里的零碎变成晚饭', '苏州的家中', [
    ['清冰箱炒饭', '把剩米饭、青菜和鸡蛋排成一盘', '尝过味道后觉得意外地合拍', '想减少浪费也省一点心力'],
    ['蔬菜汤和饭团', '把零散食材煮成一锅清汤', '捏了两个小饭团留作夜里加餐', '想用简单办法照顾疲惫的自己'],
  ], ['剩菜利用', '简单晚餐', '减少浪费']),
  ordinary('meal', 'meal-snack', '给下午留一份小点心', '苏州的家中工作桌旁', [
    ['桂花藕粉', '冲藕粉时耐心搅到透亮', '把甜度调得很轻，慢慢喝完', '想给工作留一个柔软停顿'],
    ['水果小碟', '把梨和橙子切成刚好入口的小块', '边吃边把屏幕亮度调低了一格', '想让眼睛和脑子都休息一会儿'],
  ], ['下午点心', '工作间歇', '居家自由职业']),

  ordinary('cooking', 'cook-dumpling', '练一批不太规整的饺子', '苏州的家中厨房', [
    ['香菇青菜饺子', '拌馅时试着把水分控制得更好', '把最好看的六只单独冻起来', '想下次包给家人时更熟练'],
    ['玉米鸡肉饺子', '照着自己的笔记调整咸淡', '煮破了两只，但剩下的都很饱满', '想允许手艺慢慢变好'],
  ], ['包饺子', '家庭味道', '厨艺练习']),
  ordinary('cooking', 'cook-soup', '慢慢煮一锅家常汤', '苏州的家中厨房', [
    ['菌菇豆腐汤', '洗净菌菇后把火调得很小', '盛汤时留了一份明天午饭的量', '想让两顿饭都省一点力气'],
    ['萝卜排骨汤', '给萝卜切了大小一致的滚刀块', '闻着清淡的香气整理了厨房', '想找回小时候家里开饭的安定感'],
  ], ['家常汤', '备餐', '苏州家庭记忆']),
  ordinary('cooking', 'cook-bake', '试做一盘小烘焙', '苏州的家中厨房', [
    ['香蕉燕麦饼', '把熟香蕉压成泥，反复调整厚薄', '挑出一块形状最可爱的拍了照', '想给生活添一点不实用的开心'],
    ['芝麻司康', '折面团时努力不让自己过度加工', '烤好后掰开看内部是否松软', '想练习耐心，也接受小瑕疵'],
  ], ['家庭烘焙', '手作点心', '慢生活']),
  ordinary('cooking', 'cook-recipe-note', '整理自己的懒人菜谱', '苏州的家中餐桌', [
    ['十分钟晚餐清单', '把常备食材和最快做法写成卡片', '给每道菜画了一个很小的配色图标', '想在赶稿时也有办法好好吃饭'],
    ['一人份调味表', '重新量了一遍常用勺子的容量', '把偏淡与偏辣的比例分开记下', '想减少每次下厨前的犹豫'],
  ], ['菜谱笔记', '一人食', '生活整理']),

  ordinary('clothing', 'clothes-mend', '把一件旧衣服修好', '苏州的家中', [
    ['针脚补衬衫', '挑了最接近原色的线慢慢缝袖口', '熨平后发现它还能穿很久', '想珍惜真正舒服的东西'],
    ['加固帆布袋', '给磨薄的提手补了一层布', '装进书试了试承重才放心', '想让常用物陪自己久一点'],
  ], ['衣物修补', '旧物继续使用', '手工']),
  ordinary('clothing', 'clothes-closet', '重新搭一套常穿衣服', '苏州的家中衣柜前', [
    ['灰蓝色日常搭配', '把上衣、长裤和耳饰放在一起比较', '拍下组合，省得下次出门重想', '想穿得自在又有一点精神'],
    ['米白与墨绿色搭配', '试着用一条旧丝巾做小面积点色', '走到镜子远处看整体比例', '想用熟悉衣服换一点新鲜感'],
  ], ['日常穿搭', '配色', '衣柜整理']),
  ordinary('clothing', 'clothes-season-box', '整理衣物收纳盒', '苏州的家中卧室', [
    ['叠好不常穿的针织衫', '按材质重新分类并放入标签', '留出一格给需要修补的衣物', '想让房间清爽，也让找衣服容易些'],
    ['清点围巾和帽子', '把颜色相近的配件放到同一格', '决定把一条几乎没用过的送给表妹', '想减少闲置又保留喜欢的质感'],
  ], ['衣物收纳', '配饰整理', '居家秩序']),
  ordinary('clothing', 'clothes-color-study', '做一页穿搭配色小练习', '苏州的家中工作桌', [
    ['从旧衣服取色', '用常穿的三件衣服画了六组色块', '选出一组以后接商稿也能参考的配色', '想把生活观察带回设计工作'],
    ['给基础色找点缀色', '把耳饰和袜子的颜色逐一试配', '在速写本上留下两组意外好看的组合', '想保持对颜色的敏感'],
  ], ['服装配色', '平面设计练习', '色彩观察']),

  ordinary('commute', 'commute-bus-sketch', '在公交路上记下小构图', '苏州市区公交途中', [
    ['车窗框景', '用手机备忘录画了几笔窗框与街道比例', '下车前把线条整理成三个构图关键词', '想积累不依赖项目的视觉素材'],
    ['座椅色块', '观察扶手、座椅和提示牌的颜色关系', '记下一组可以用于海报的撞色', '想让通勤也有一点发现'],
  ], ['苏州公交', '通勤观察', '构图素材']),
  ordinary('commute', 'commute-bike', '骑共享单车去交一份样稿', '苏州市区熟悉街道', [
    ['慢骑去打印点', '提前出门，选了车少的熟路', '交完样稿后在门口核对了文件页数', '想让线下交付从容一点'],
    ['带着色样去见客户', '把色样夹牢后才开始骑车', '到达时衣角有点皱，但材料完整', '想独立把每个小环节照顾好'],
  ], ['苏州骑行', '自由职业交付', '城市日常']),
  ordinary('commute', 'commute-walk-errand', '步行办完一件小差事', '苏州住处周边', [
    ['去寄一份设计打样', '出门前又核对了一遍地址和包装', '回程把快递单号收进项目笔记', '想把琐事做完再安心休息'],
    ['去取装裱材料', '带着尺寸纸条避免拿错', '回家后立刻按项目分好材料', '想减少工作桌上的未完成感'],
  ], ['步行办事', '设计打样', '项目管理']),
  ordinary('commute', 'commute-route-note', '更新自己的常用路线备注', '苏州的家中', [
    ['整理客户见面路线', '把几个常去地点按交通方式重新标注', '补上每段路给自己预留的缓冲时间', '想减少临出门时的慌张'],
    ['整理打印与装裱路线', '把办事顺序按距离排了一遍', '删掉一条早就不用的旧备注', '想让下次跑腿更轻松'],
  ], ['苏州路线', '通勤规划', '自由职业']),

  ordinary('hobby', 'hobby-watercolor', '画一张没有甲方的水彩', '苏州的家中工作桌', [
    ['画青绿色小瓶子', '只用三种颜色叠出玻璃的明暗', '停在刚刚好的位置，没有继续修', '想保留纯粹为自己画画的时间'],
    ['画窗边植物', '先画叶片间的空隙再补轮廓', '在角落签了当天的小日期', '想重新喜欢上不追求用途的画'],
  ], ['水彩练习', '自由创作', '设计师爱好']),
  ordinary('hobby', 'hobby-collage', '做一页纸张拼贴', '苏州的家中地板上', [
    ['旧包装纸拼贴', '按触感和颜色剪出不规则形状', '留了一块空白让画面能呼吸', '想试试不靠电脑完成一张画面'],
    ['票据与色纸拼贴', '把留存的小票裁去个人信息再组合', '用铅笔补了几根轻线连接色块', '想给日常碎片一个新顺序'],
  ], ['纸张拼贴', '视觉实验', '手工']),
  ordinary('hobby', 'hobby-photo-sort', '整理一组日常照片', '苏州的家中', [
    ['挑出门窗细节照片', '按形状而不是拍摄日期重新分组', '选了四张做成一页私人小册', '想看见自己反复被什么吸引'],
    ['挑出路面纹理照片', '删掉重复和失焦的画面', '给留下的照片写了极短的颜色备注', '想积累属于自己的视觉词典'],
  ], ['照片整理', '视觉素材', '个人观察']),
  ordinary('hobby', 'hobby-music-list', '重排一张工作歌单', '苏州的家中', [
    ['按工作节奏排歌', '把开工、专注和收尾分成三段', '试听后删掉一首会让自己分心的歌', '想让独处工作不那么空'],
    ['整理旧歌收藏', '从收藏里挑出十首熟悉但不吵的歌', '给歌单换了自己画的简洁封面', '想用熟悉声音陪伴今晚'],
  ], ['个人歌单', '工作陪伴', '封面设计']),

  ordinary('family', 'family-call-mom', '和妈妈通一会儿电话', '苏州的家中', [
    ['聊家常菜', '问了最近家里常做什么菜，也交换了做法', '挂电话后把妈妈说的调味顺序记下来', '想和家里保持轻松而具体的联系'],
    ['聊阳台植物', '听妈妈讲一盆植物新长出的叶子', '约好下次回去帮她拍得好看一点', '想让关心落在小事情上'],
  ], ['江苏家庭', '母女通话', '家常联系']),
  ordinary('family', 'family-cousin', '给表妹看一份作品集', '苏州的家中线上聊天', [
    ['帮表妹挑作品顺序', '先问她最想表达什么再调整页面', '只提了三条能立刻修改的意见', '想帮忙但不给她太大压力'],
    ['帮表妹看配色', '把两个方案放在一起解释视觉重心', '鼓励她保留自己最喜欢的一版', '想做一个可靠又不越界的姐姐'],
  ], ['家人互助', '作品集建议', '线上联系']),
  ordinary('family', 'family-recipe', '誊写一道家里的做法', '苏州的家中餐桌', [
    ['外婆的蒸蛋做法', '把“适量”换算成自己能复现的比例', '在页边画了小时候用过的碗', '想留住家庭记忆里的味道'],
    ['爸爸的炒饭做法', '按他说的顺序重新写成清楚步骤', '标出他总会多放一点的葱花', '想把口头传下来的细节保存好'],
  ], ['家庭菜谱', '江苏家常', '记忆整理']),
  ordinary('family', 'family-package', '整理一份寄给家人的小包裹', '苏州的家中', [
    ['寄几张自己做的明信片', '逐张检查边角再写短短问候', '用旧纸板加固，避免运输时折弯', '想用手做的东西表达惦记'],
    ['寄给表妹的绘画材料', '挑出状态好的笔和没拆封的纸', '附上一张说明每种纸特点的小卡片', '想把闲置材料变成她的灵感'],
  ], ['家庭包裹', '手作心意', '物品分享']),

  ordinary('work', 'work-logo', '推进一版商用标志草案', '苏州的家中工作室', [
    ['餐饮品牌标志草案', '先把客户关键词压成三个视觉方向', '收掉最花哨的一版，留下可读性更好的两个', '想做出经得起实际使用的方案'],
    ['生活方式品牌标志草案', '用黑白轮廓检查图形是否站得住', '给明天要细化的方向写了明确备注', '想在创意和交付之间找到平衡'],
  ], ['商业平面设计', '标志草案', '自由职业']),
  ordinary('work', 'work-layout', '校对一组版式细节', '苏州的家中工作室', [
    ['宣传折页排版', '逐页检查字号、行距和图片边缘', '发现并修正了一处页码顺序', '想让交付里的小细节也可靠'],
    ['活动海报系列', '把三张海报缩小并排看视觉一致性', '统一了日期信息的层级', '想让系列感自然出现'],
  ], ['商业排版', '印刷校对', '设计交付']),
  ordinary('work', 'work-client-call', '开一次边界清楚的客户沟通', '苏州的家中线上会议', [
    ['确认修改范围', '把意见分成必要修改与新增需求', '会后立刻发了简短确认清单', '想保护时间，也让合作更顺畅'],
    ['确认交付规格', '逐项问清尺寸、格式和使用场景', '把模糊的截止时间落实到具体日期', '想避免双方靠猜测推进项目'],
  ], ['客户沟通', '需求确认', '自由职业边界']),
  ordinary('work', 'work-portfolio', '更新一页个人作品集', '苏州的家中工作室', [
    ['补一页包装设计案例', '重新挑选过程图并压缩说明文字', '把客户未公开的信息全部移除', '想让作品集诚实呈现自己的能力'],
    ['补一页视觉系统案例', '用实际应用图解释设计怎样落地', '调整顺序让读者先看到问题再看方案', '想为下一次合作准备得更充分'],
  ], ['设计作品集', '案例整理', '自由职业成长']),

  ordinary('local_walk', 'walk-alley', '沿熟悉的小巷慢走一圈', '苏州住处附近街巷', [
    ['看门窗与墙面比例', '刻意放慢脚步观察门牌和窗格', '回家后凭记忆画下一个小轮廓', '想从熟悉地方重新找到细节'],
    ['找安静的转角', '绕开赶路的人群走了一条旧路线', '在一个转角停下来听了片刻环境声', '想给脑子一点不输入信息的空白'],
  ], ['苏州街巷', '本地散步', '建筑细节']),
  ordinary('local_walk', 'walk-canal', '去河边走一小段', '苏州城区河道边', [
    ['观察水面倒影', '只看桥洞和倒影形成的形状', '记住一组深绿与灰白的颜色关系', '想把注意力从屏幕拉回身体'],
    ['沿河数桥', '走过几座熟悉的小桥也没有赶时间', '回程换了另一侧路面看不同视角', '想用轻微变化刷新熟悉路线'],
  ], ['苏州河道', '步行放松', '视觉观察']),
  ordinary('local_walk', 'walk-garden-memory', '在园林旧照片里规划一次散步', '苏州的家中', [
    ['重看自己拍的漏窗', '按纹样把照片分成三组', '记下以后想亲眼再看的两个角度', '想延续对家乡空间的好奇'],
    ['重看石径与廊道', '用简单线条描出路径转折', '决定下次只带小速写本出门', '想让未来的本地散步有一个小主题'],
  ], ['苏州园林', '散步计划', '空间观察']),
  ordinary('local_walk', 'walk-neighborhood-map', '画一张私人版街区小地图', '苏州住处附近', [
    ['标记舒服的步行段', '凭记忆画出常走的路与几个转角', '用不同线型区分安静和热闹的路段', '想更了解自己生活的半径'],
    ['标记视觉素材点', '补上常拍墙面、树影和招牌的位置', '留出空白等以后慢慢增加', '想把散步积累变成长期的小项目'],
  ], ['苏州街区', '手绘地图', '生活半径']),

  ordinary('reading', 'read-essay', '给自己安排一段设计阅读', '苏州的家中', [
    ['想找一篇关于留白的随笔', '从自己的书签和藏书里找合适材料，不预设文章内容', '用自己的项目经验写下一条关于留白的想法', '想让阅读真的进入判断，而不只收藏'],
    ['想找一篇关于字体的随笔', '先列出自己真正想弄懂的字体问题', '在笔记里画了两个来自自己观察的字形比较', '想把专业兴趣养得更深一点'],
  ], ['设计阅读', '随笔笔记', '平面设计']),
  ordinary('reading', 'read-fiction', '读一小段睡前小说', '苏州的家中卧室', [
    ['重读一册短篇小说', '挑了一篇熟悉的故事慢慢读', '在最喜欢的段落旁夹了一张素色书签', '想让一天在别人的故事里轻轻收尾'],
    ['读新小说的前两章', '忍住没有先看简介后的剧情提示', '记下自己对一个人物的第一印象', '想保留第一次阅读的好奇'],
  ], ['小说阅读', '睡前习惯', '私人阅读']),
  ordinary('reading', 'read-art-book', '翻一本旧画册找灵感', '苏州的家中地毯上', [
    ['看传统纹样画册', '用便签标出节奏特别好的两页', '合上书后凭印象重画了一种结构', '想吸收方法而不是直接照搬图案'],
    ['看摄影构图画册', '把喜欢的跨页缩成几个黑白块', '发现自己总被偏心构图吸引', '想更清楚自己的视觉偏好'],
  ], ['艺术画册', '视觉研究', '灵感整理']),
  ordinary('reading', 'read-notes', '整理最近的阅读摘记', '苏州的家中书桌', [
    ['合并重复的设计笔记', '删掉脱离上下文就看不懂的摘录', '给真正有用的三条补上自己的解释', '想让笔记以后仍然能用'],
    ['给小说摘记分主题', '把人物、场景和句子感受分开归档', '保留了一条当时没看懂的疑问', '想看见阅读中的自己怎样变化'],
  ], ['阅读笔记', '知识整理', '个人档案']),

  ordinary('emotional_need', 'emotion-quiet', '给自己留一段安静时间', '苏州的家中', [
    ['二十分钟不碰屏幕', '把手机翻面放远，只坐着喝温水', '重新拿起手机前先写下当前感受', '想从持续回应别人中退开一会儿'],
    ['关掉工作通知', '把未完成事项写在纸上后暂时合起电脑', '听见房间里很细小的日常声音', '想确认休息不需要先被挣得'],
  ], ['情绪休息', '自由职业边界', '自我照料']),
  ordinary('emotional_need', 'emotion-message', '想找一个可信的人说几句', '苏州的家中线上聊天', [
    ['说说今天的小挫败', '先分清自己想被听见还是想要建议', '把事情讲短一些，也诚实说出疲惫', '希望得到不催促的陪伴'],
    ['分享一个小小进展', '挑出真正让自己开心的那一部分', '没有把进展包装成多大的成就', '希望有人记得她认真走过这些步骤'],
  ], ['情绪陪伴', '线上朋友', '温和沟通']),
  ordinary('emotional_need', 'emotion-boundary', '重新确认一条工作边界', '苏州的家中工作桌', [
    ['拒绝临时加急', '把可行交付时间写得清楚而礼貌', '发送后没有反复补充解释', '想保护休息，也对承诺负责'],
    ['暂停无止境修改', '整理已完成轮次和原始约定', '提出下一轮需要重新确认费用与时间', '想练习在合作里照顾自己'],
  ], ['工作边界', '情绪需要', '自由职业']),
  ordinary('emotional_need', 'emotion-small-win', '记下一件今天做成的小事', '苏州的家中', [
    ['记录按时收尾', '写下自己怎样把一个难题拆小', '给明天留了一句不苛刻的提醒', '想看见过程，而不是只盯最终结果'],
    ['记录一次坦率表达', '回想自己没有勉强答应的那个瞬间', '承认拒绝之后仍有一点不安', '想慢慢相信自己的边界'],
  ], ['情绪记录', '小进展', '自我肯定']),
]);

export const TRAVEL_EVENT_CATALOG = Object.freeze([
  ['yangzhou', '扬州', '从苏州出发去扬州短住', ['想换个城市看园林与街巷的尺度', '带了小速写本和轻便换洗衣物', '这是一段虚构的个人行程']],
  ['nanjing', '南京', '从苏州出发去南京短住', ['想看看城市里新旧空间怎样相遇', '计划只带一个轻便背包', '这是一段虚构的个人行程']],
  ['wuxi', '无锡', '从苏州出发去无锡短住', ['想沿熟悉的江南城市做一次小观察', '带着相机但不要求自己拍作品', '这是一段虚构的个人行程']],
  ['hangzhou', '杭州', '从苏州出发去杭州短住', ['想暂时离开工作桌，换一种生活节奏', '提前整理了必须离线保存的项目资料', '这是一段虚构的个人行程']],
  ['lijiang', '丽江', '去丽江住几天', ['想了解当地吃食、纳西文化与古城的日常生活', '带了轻便行李，给自己留一些随意走走的时间', '这是一段虚构的个人行程']],
  ['dali', '大理', '去大理换个生活节奏', ['对当地饮食、白族文化和人们的日常好奇', '想慢慢观察生活，不把每一天塞满', '这是一段虚构的个人行程']],
  ['chengdu', '成都', '去成都住几天', ['想聊聊当地饮食与城市生活', '给自己留了逛街和休息的时间', '这是一段虚构的个人行程']],
  ['quanzhou', '泉州', '去泉州走走看看', ['对闽南饮食、城市历史和地方习惯感兴趣', '想从小事认识一座城市', '这是一段虚构的个人行程']],
].map(([id, destination, title, facts]) => Object.freeze({ id, destination, title, facts })));

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

function asDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('clock must return a valid date');
  return date;
}

function shanghaiParts(date) {
  const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(), weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(), minute: shifted.getUTCMinutes(),
  };
}

const pad = (number) => String(number).padStart(2, '0');

export function shanghaiDayKey(dateValue) {
  const p = shanghaiParts(asDate(dateValue));
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function shanghaiWeekInfo(dateValue) {
  const date = asDate(dateValue);
  const p = shanghaiParts(date);
  const localMidnightUtc = Date.UTC(p.year, p.month - 1, p.day) - SHANGHAI_OFFSET_MS;
  const daysSinceMonday = (p.weekday + 6) % 7;
  const monday = new Date(localMidnightUtc - daysSinceMonday * 24 * HOUR_MS);
  const nextMonday = new Date(monday.getTime() + 7 * 24 * HOUR_MS);
  return { key: shanghaiDayKey(monday), nextAt: nextMonday.toISOString() };
}

function safeParse(value, fallback = null) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function drawIndex(random, length) { return Math.min(length - 1, Math.floor(Math.max(0, Math.min(0.999999999999, random())) * length)); }

function weightedChoice(random, items, weightOf) {
  const total = items.reduce((sum, item) => sum + weightOf(item), 0);
  let cursor = Math.max(0, Math.min(0.999999999999, random())) * total;
  for (const item of items) {
    cursor -= weightOf(item);
    if (cursor < 0) return item;
  }
  return items.at(-1);
}

function phaseAt(event, now) {
  const elapsedHours = Math.max(0, (now.getTime() - Date.parse(event.startedAt)) / HOUR_MS);
  let index = 0;
  for (let i = 1; i < event.phases.length; i += 1) {
    if (elapsedHours >= event.phases[i].offsetHours) index = i;
  }
  return Math.max(event.phaseIndex || 0, index);
}

function advancePhase(event, now) {
  const index = phaseAt(event, now);
  if (index === event.phaseIndex && event.phase?.id === event.phases[index]?.id) return false;
  event.phaseIndex = index;
  const { offsetHours: _offsetHours, ...phase } = event.phases[index];
  event.phase = phase;
  if (phase.location) event.location = phase.location;
  if (phase.destination) event.destination = phase.destination;
  return true;
}

function currentPhase(phases, index = 0) {
  const { offsetHours: _offsetHours, ...phase } = phases[index];
  return phase;
}

const DURATION_HOURS = Object.freeze({
  meal: [1, 2, 3], cooking: [1, 2, 3], clothing: [2, 4, 6], commute: [1, 2, 3],
  hobby: [2, 3, 4], family: [1, 2, 3], work: [4, 6, 8], local_walk: [1, 2, 3],
  reading: [2, 3, 4], emotional_need: [1, 2, 3],
});

function isTemplateEligible(template, hour) {
  if (hour < 7) return false;
  if (hour >= 21) {
    return template.category === 'reading'
      || template.category === 'emotional_need'
      || ['hobby-photo-sort', 'hobby-music-list'].includes(template.id);
  }
  if (template.id === 'meal-breakfast') return hour >= 7 && hour < 10;
  if (template.id === 'meal-snack') return hour >= 14 && hour < 17;
  if (template.category === 'meal') return hour >= 10 && hour < 21;
  if (template.category === 'cooking') return hour >= 8 && hour < 21;
  if (template.category === 'commute') return hour >= 8 && hour < 19;
  if (template.category === 'work') return hour >= 9 && hour < 20;
  if (template.category === 'local_walk') return hour >= 8 && hour < 20;
  if (template.category === 'family') return hour >= 9 && hour < 21;
  return hour < 23;
}

function ordinaryPhaseLocations(template) {
  if (template.category === 'commute' || ['walk-alley', 'walk-canal'].includes(template.id)) {
    return [template.location, '苏州的家中'];
  }
  return [template.location, template.location];
}

function publicEvent(event) { return clone(event); }

function travelText(value, fallback, field) {
  if (value == null || value === '') return fallback;
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 160) {
    const error = new TypeError(`${field} must be a non-empty string of at most 160 characters`);
    error.status = 400; error.code = 'INVALID_TRAVEL_PLAN'; throw error;
  }
  return value.trim();
}

function travelTextList(value, fallback, field) {
  if (value == null) return [...fallback];
  if (!Array.isArray(value) || value.length > 12) {
    const error = new TypeError(`${field} must be an array with at most 12 entries`);
    error.status = 400; error.code = 'INVALID_TRAVEL_PLAN'; throw error;
  }
  return value.map((item, index) => travelText(item, '', `${field}[${index}]`));
}

function createTravelEvent({ now, plan, title, facts, sourceHints, templateId = 'travel-planned', cleanupAt = null, legacyBoundaryRuntime = false }) {
  const startedAt = now.toISOString();
  const offset = value => (Date.parse(value) - now.getTime()) / HOUR_MS;
  const route = [plan.homeCity, ...plan.stops.map(stop => stop.city), plan.homeCity];
  const destinations = plan.stops.map(stop => stop.city).join('、');
  const phases = [{
    id: 'plan', title: '行程已安排', offsetHours: 0, location: `${plan.homeCity}的家中`, destination: plan.stops[0].city,
    activity: `照常生活，也整理去${destinations}需要的随身物品`, feeling: '对换一个生活环境有一点期待', wish: '想让行程松弛一些',
  }, {
    id: 'outbound', title: '出发途中', offsetHours: offset(plan.departAt),
    location: `从${plan.homeCity}前往${plan.stops[0].city}的途中`, destination: plan.stops[0].city,
    activity: `带着轻便行李前往${plan.stops[0].city}`, feeling: '正在从熟悉的日常切换到新的地方', wish: '想平稳抵达后先安顿下来',
  }];
  plan.stops.forEach((stop, index) => {
    phases.push({
      id: index ? `away-${index + 1}` : 'away', title: `在${stop.city}停留`, offsetHours: offset(stop.arriveAt),
      location: stop.city, destination: stop.city, activity: `住在${stop.city}，照常吃饭、休息、阅读，也在附近走走`,
      feeling: '新鲜感渐渐落进普通生活', wish: '想按身体的节奏过这几天',
    });
    const next = plan.stops[index + 1];
    phases.push(next ? {
      id: `transfer-${index + 1}`, title: `前往${next.city}`, offsetHours: offset(stop.leaveAt),
      location: `从${stop.city}前往${next.city}的途中`, destination: next.city,
      activity: `收好行李，从${stop.city}前往${next.city}`, feeling: '在两段停留之间慢慢换场', wish: '想顺利到达下一处住处',
    } : {
      id: 'return', title: '返程途中', offsetHours: offset(stop.leaveAt),
      location: `从${stop.city}返回${plan.homeCity}的途中`, destination: stop.city,
      activity: '收好随身物品，在返程路上休息', feeling: '开始想念熟悉的生活节奏', wish: '想平安回家',
    });
  });
  phases.push({
    id: 'home', title: '已经回家', offsetHours: offset(plan.returnAt), location: `${plan.homeCity}的家中`, destination: plan.homeCity,
    activity: '回到家安顿行李，恢复平常的生活节奏', feeling: '身体有点累，心里慢慢安定下来', wish: '想先好好休息',
  });
  phases.sort((left, right) => left.offsetHours - right.offsetHours);
  const eventTitle = travelText(title, `去${destinations}住几天`, 'title');
  const eventFacts = travelTextList(facts, [`计划从${plan.homeCity}出发`, `会在${destinations}停留`, '这是虚构但持续有效的个人行程'], 'facts');
  const hints = travelTextList(sourceHints, plan.stops.flatMap(stop => [`${stop.city}日常生活`, `${stop.city}城市空间`]), 'sourceHints');
  return {
    id: `life-miyue-${now.getTime()}-${randomUUID()}`,
    roleId: 'miyue', type: 'travel', category: 'travel', templateId,
    title: eventTitle, location: phases[0].location,
    itinerary: route, travelPlan: clone(plan),
    destination: plan.stops[0].city, startedAt,
    endsAt: cleanupAt || plan.returnAt,
    phase: currentPhase(phases), phaseIndex: 0, phases,
    deliveredPhaseIds: [], facts: eventFacts, sourceHints: hints, fictionalCanon: true,
    ...(legacyBoundaryRuntime ? { legacyBoundaryRuntime: true } : {}),
  };
}

export class LifeEventRepository {
  constructor(store, { clock = () => new Date(), random = Math.random } = {}) {
    if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('store with db and transaction is required');
    if (typeof clock !== 'function' || typeof random !== 'function') throw new TypeError('clock and random must be functions');
    this.store = store;
    this.clock = clock;
    this.random = random;
    this.timer = null;
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS life_event_runtime (
        role_id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS life_event_journal (
        event_id TEXT PRIMARY KEY,
        role_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ends_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS life_event_journal_role_started
        ON life_event_journal(role_id, started_at DESC);
    `);
  }

  #initialState() {
    return {
      version: LIFE_EVENT_VERSION,
      revision: 0,
      weeklyTravelChance: DEFAULT_WEEKLY_TRAVEL_CHANCE,
      checkedWeek: null,
      nextWeeklyCheckAt: null,
      weeklyDecision: null,
      dailyCheckedDate: null,
      dailyDecision: null,
      dailySchedule: null,
      activeEventId: null,
    };
  }

  #loadState() {
    const row = this.store.db.prepare('SELECT state_json FROM life_event_runtime WHERE role_id=?').get('miyue');
    const parsed = row ? safeParse(row.state_json) : null;
    return { ...this.#initialState(), ...(parsed || {}) };
  }

  #saveState(state, now) {
    state.version = LIFE_EVENT_VERSION;
    this.store.db.prepare(`
      INSERT INTO life_event_runtime(role_id,state_json,updated_at) VALUES(?,?,?)
      ON CONFLICT(role_id) DO UPDATE SET state_json=excluded.state_json, updated_at=excluded.updated_at
    `).run('miyue', JSON.stringify(state), now.toISOString());
  }

  #loadEvent(id) {
    if (!id) return null;
    const row = this.store.db.prepare('SELECT event_json FROM life_event_journal WHERE event_id=? AND role_id=?').get(id, 'miyue');
    return row ? safeParse(row.event_json) : null;
  }

  #saveEvent(event, now) {
    this.store.db.prepare(`
      INSERT INTO life_event_journal(event_id,role_id,event_json,started_at,ends_at,updated_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(event_id) DO UPDATE SET event_json=excluded.event_json, updated_at=excluded.updated_at
    `).run(event.id, 'miyue', JSON.stringify(event), event.startedAt, event.endsAt, now.toISOString());
  }

  #recentEvents(limit = 12) {
    return this.store.db.prepare(`
      SELECT event_json FROM life_event_journal
      WHERE role_id=? ORDER BY started_at DESC, rowid DESC LIMIT ?
    `).all('miyue', limit).map((row) => safeParse(row.event_json)).filter(Boolean);
  }

  #createTravel(now) {
    const trip = TRAVEL_EVENT_CATALOG[drawIndex(this.random, TRAVEL_EVENT_CATALOG.length)];
    // Keep short-distance travel in daylight, even when the weekly draw runs at midnight.
    const departure = new Date(now.getTime() + SHANGHAI_OFFSET_MS + 24 * HOUR_MS);
    const hour = departure.getUTCHours();
    if (hour < 9) departure.setUTCHours(9, 0, 0, 0);
    else if (hour >= 16) departure.setUTCHours(16, 0, 0, 0);
    const departAt = new Date(departure.getTime() - SHANGHAI_OFFSET_MS);
    const arriveAt = new Date(departAt.getTime() + 3 * HOUR_MS);
    const leaveAt = new Date(departAt.getTime() + 48 * HOUR_MS);
    const returnAt = new Date(departAt.getTime() + 51 * HOUR_MS);
    const plan = normalizeTravelPlan({
      homeCity: '苏州', departAt, returnAt,
      stops: [{ city: trip.destination, arriveAt, leaveAt }],
    });
    // Keep the historical post-return cleanup window for old readers. The
    // authoritative travel state is already `returned` at returnAt.
    const cleanupAt = new Date(returnAt.getTime() + 21 * HOUR_MS).toISOString();
    return createTravelEvent({
      now, plan, title: trip.title, facts: trip.facts,
      sourceHints: ['旅行见闻', `${trip.destination}城市空间`, '旅行速写', '独自短住'],
      templateId: `travel-${trip.id}`, cleanupAt,
    });
  }

  #createOrdinary(now) {
    const hour = shanghaiParts(now).hour;
    const eligibleCatalog = ORDINARY_EVENT_CATALOG.filter((item) => isTemplateEligible(item, hour));
    if (!eligibleCatalog.length) return null;
    const recent = this.#recentEvents(8).filter((event) => event.type === 'ordinary');
    const avoidedCategories = new Set(recent.slice(0, 2).map((event) => event.category));
    const eligibleCategories = [...new Set(eligibleCatalog.map((item) => item.category))];
    let categories = eligibleCategories.filter((category) => !avoidedCategories.has(category));
    if (!categories.length) categories = eligibleCategories;
    const category = weightedChoice(this.random, categories, (item) => CATEGORY_WEIGHTS[item]);
    const avoidedTemplates = new Set(recent.slice(0, 6).map((event) => event.templateId));
    let templates = eligibleCatalog.filter((item) => item.category === category && !avoidedTemplates.has(item.id));
    if (!templates.length) templates = eligibleCatalog.filter((item) => item.category === category);
    const template = templates[drawIndex(this.random, templates.length)];
    const variant = template.variants[drawIndex(this.random, template.variants.length)];
    const durationOptions = DURATION_HOURS[category];
    const durationHours = durationOptions[drawIndex(this.random, durationOptions.length)];
    const [variantTitle, startActivity, laterActivity, wish] = variant;
    const [startLocation, laterLocation] = ordinaryPhaseLocations(template);
    const laterOffset = Math.min(durationHours / 2, ['meal', 'cooking', 'commute'].includes(category) ? 0.5 : category === 'work' ? 2 : 1);
    const phases = [
      { id: 'start', title: '正在发生', offsetHours: 0, location: startLocation, activity: startActivity, feeling: '愿意把注意力放回眼前这件小事', wish },
      { id: 'later', title: '稍后进展', offsetHours: laterOffset, location: laterLocation, activity: laterLocation !== template.location ? `已经回到家，回想刚才的过程：${laterActivity}` : laterActivity, feeling: '做过一点之后，心里比刚开始更松一些', wish },
    ];
    return {
      id: `life-miyue-${now.getTime()}-${randomUUID()}`,
      roleId: 'miyue', type: 'ordinary', category, templateId: template.id,
      title: `${template.title}：${variantTitle}`, location: startLocation,
      startedAt: now.toISOString(), endsAt: new Date(now.getTime() + durationHours * HOUR_MS).toISOString(),
      durationHours, phase: currentPhase(phases), phaseIndex: 0, phases,
      deliveredPhaseIds: [],
      facts: [`林晓薇今天给自己安排了“${variantTitle}”`, `最初地点是${template.location}，后续位置以当前阶段为准`, wish, '这是她虚构但持续有效的个人生活经历'],
      sourceHints: [...template.sourceHints], fictionalCanon: true,
    };
  }

  #tickInside(now) {
    const state = this.#loadState();
    let active = this.#loadEvent(state.activeEventId);
    let changed = false;

    if (active) {
      changed = advancePhase(active, now) || changed;
      if (now.getTime() >= Date.parse(active.endsAt)) {
        active.status = 'completed';
        active.completedAt = active.endsAt;
        this.#saveEvent(active, now);
        state.activeEventId = null;
        active = null;
        changed = true;
      } else if (changed) {
        this.#saveEvent(active, now);
      }
    } else if (state.activeEventId) {
      state.activeEventId = null;
      changed = true;
    }

    const week = shanghaiWeekInfo(now);
    if (!state.checkedWeek || week.key > state.checkedWeek) {
      if (active?.type === 'travel') {
        state.checkedWeek = week.key;
        state.nextWeeklyCheckAt = week.nextAt;
        state.weeklyDecision = { week: week.key, result: 'skipped_traveling', checkedAt: now.toISOString() };
      } else if (active) {
        // A short ordinary event may cross Monday midnight. Defer this week's one
        // draw until it ends, instead of losing or banking the opportunity.
        if (state.nextWeeklyCheckAt !== active.endsAt) {
          state.nextWeeklyCheckAt = active.endsAt;
          changed = true;
        }
      } else {
        state.checkedWeek = week.key;
        state.nextWeeklyCheckAt = week.nextAt;
        const draw = this.random();
        const selected = draw < state.weeklyTravelChance;
        state.weeklyDecision = { week: week.key, result: selected ? 'selected' : 'not_selected', checkedAt: now.toISOString(), draw };
        if (selected) {
          active = this.#createTravel(now);
          state.activeEventId = active.id;
          this.#saveEvent(active, now);
        }
      }
      if (!active || active.type === 'travel') changed = true;
    } else if (state.checkedWeek === week.key && state.nextWeeklyCheckAt !== week.nextAt) {
      state.nextWeeklyCheckAt = week.nextAt;
      changed = true;
    }

    const day = shanghaiDayKey(now);
    const localHour = shanghaiParts(now).hour;
    const needsDailyCheck = !state.dailyCheckedDate || day > state.dailyCheckedDate;
    // A continuously running service must not choose breakfast at 07:00 every day.
    // Draw and persist one daytime slot overnight; an app resumed later uses the
    // current eligible time instead of replaying a missed event.
    if (!active && needsDailyCheck && localHour < 7 && (!state.dailySchedule || day > state.dailySchedule.day)) {
      const hour = 7 + drawIndex(this.random, 15);
      state.dailySchedule = { day, notBefore: `${day}T${pad(hour)}:00:00+08:00` };
      changed = true;
    }
    const waitingForSlot = state.dailySchedule?.day === day && now.getTime() < Date.parse(state.dailySchedule.notBefore);
    if (!active && needsDailyCheck && localHour >= 7 && !waitingForSlot) {
      state.dailyCheckedDate = day;
      const draw = this.random();
      const selected = draw < DAILY_ORDINARY_EVENT_CHANCE;
      state.dailyDecision = { day, result: selected ? 'selected' : 'none', checkedAt: now.toISOString(), draw };
      if (selected) {
        active = this.#createOrdinary(now);
        if (active) {
          state.activeEventId = active.id;
          this.#saveEvent(active, now);
        } else {
          state.dailyDecision.result = 'none_eligible';
        }
      }
      changed = true;
    }

    const hasRuntime = Boolean(this.store.db.prepare('SELECT 1 FROM life_event_runtime WHERE role_id=?').get('miyue'));
    if (changed || !hasRuntime) {
      state.revision = Number(state.revision || 0) + 1;
      this.#saveState(state, now);
    }
    return { state, active };
  }

  get(roleId = 'miyue') {
    if (roleId !== 'miyue') return null;
    const now = asDate(this.clock());
    return this.store.transaction(() => {
      const { state, active } = this.#tickInside(now);
      const pending = Boolean(active && !active.deliveredPhaseIds.includes(active.phase.id));
      return {
        enabled: true,
        weeklyTravelChance: state.weeklyTravelChance,
        checkedWeek: state.checkedWeek,
        nextWeeklyCheckAt: state.nextWeeklyCheckAt,
        nextCheckAt: [state.nextWeeklyCheckAt, state.dailySchedule?.notBefore]
          .filter(value => Number.isFinite(Date.parse(value)) && Date.parse(value) > now.getTime())
          .sort((a, b) => Date.parse(a) - Date.parse(b))[0] || null,
        active: publicEvent(active),
        recent: this.#recentEvents(12).map(publicEvent),
        pending,
        version: `${LIFE_EVENT_VERSION}:${state.revision}`,
      };
    });
  }

  tick(roleId = 'miyue') { return this.get(roleId); }

  context(roleId = 'miyue') {
    const snapshot = this.get(roleId);
    if (!snapshot) return '';
    const now = asDate(this.clock());
    const p = shanghaiParts(now);
    const localTime = `${shanghaiDayKey(now)} ${pad(p.hour)}:${pad(p.minute)}`;
    const completed = snapshot.recent
      .filter((event) => event.id !== snapshot.active?.id && Date.parse(event.endsAt) <= now.getTime())
      .slice(0, 2)
      .map((event) => `${event.title}（${shanghaiDayKey(new Date(event.startedAt))} 至 ${shanghaiDayKey(new Date(event.endsAt))}）`);
    const lines = [
      '【虚构生活事实｜林晓薇】',
      `上海时区本地时间：${localTime}`,
    ];
    if (snapshot.active) {
      const event = snapshot.active;
      const trip = travelState(event, now);
      const travelPlaces = trip?.stops.map(stop => stop.city).join('、') || event.destination;
      lines.push(
        `最近的生活背景：${event.title}`,
        `大致近况：${event.type === 'travel' ? trip?.status === 'staying' ? `这几天住在${trip.currentCity}，日常围绕当地的吃饭、休息、阅读和散步` : trip?.status === 'returned' ? `已经从${travelPlaces}回到${trip.homeCity}` : `接下来会去${travelPlaces}住几天` : event.phase.activity}`,
        `感受：${event.phase.feeling}`, `愿望：${event.phase.wish}`,
        `已固定事实：${event.facts.join('；')}`,
      );
    } else {
      lines.push('当前没有进行中的个人事件。');
    }
    lines.push(
      `最近完成：${completed.length ? completed.join('；') : '暂无'}`,
      '这是林晓薇的虚构个人生活连续性。事件用来带出有内容的聊天；不播报行程时间，不等阶段变化才聊当地文化。已聊过的内容按对话回顾，错过的阶段不得集中补发。用户的当前话题优先。',
      '不得把现实用户、真实人物或实时外部事件的活动说成她亲历。',
    );
    return lines.join('\n').slice(0, 1800);
  }

  pendingTopic(roleId = 'miyue') {
    const snapshot = this.get(roleId);
    if (!snapshot?.active || !snapshot.pending) return null;
    return `life:${snapshot.active.id}:${snapshot.active.phase.id}`;
  }

  markDelivered(roleId, topicKey, messageId) {
    if (roleId !== 'miyue' || typeof topicKey !== 'string' || !messageId) return false;
    const now = asDate(this.clock());
    return this.store.transaction(() => {
      const state = this.#loadState();
      const event = this.#loadEvent(state.activeEventId);
      if (!event || now.getTime() >= Date.parse(event.endsAt)) return false;
      advancePhase(event, now);
      const expected = `life:${event.id}:${event.phase.id}`;
      if (topicKey !== expected || event.deliveredPhaseIds.includes(event.phase.id)) return false;
      event.deliveredPhaseIds.push(event.phase.id);
      event.phaseDeliveries = { ...(event.phaseDeliveries || {}), [event.phase.id]: { messageId: String(messageId), deliveredAt: now.toISOString() } };
      this.#saveEvent(event, now);
      state.revision = Number(state.revision || 0) + 1;
      this.#saveState(state, now);
      return true;
    });
  }

  planTravel({ homeCity = '苏州', departAt, returnAt, stops, title, facts, sourceHints } = {}) {
    const now = asDate(this.clock());
    const plan = normalizeTravelPlan({ homeCity, departAt, returnAt, stops });
    if (Date.parse(plan.departAt) < now.getTime()) {
      const error = new RangeError('departAt must not be in the past');
      error.status = 400; error.code = 'INVALID_TRAVEL_PLAN'; throw error;
    }
    const event = createTravelEvent({ now, plan, title, facts, sourceHints });
    this.store.transaction(() => {
      const state = this.#loadState();
      const existing = this.#loadEvent(state.activeEventId);
      if (existing && now.getTime() < Date.parse(existing.endsAt)) {
        const error = new Error('another life event is already active');
        error.status = 409; error.code = 'ACTIVE_LIFE_EVENT'; throw error;
      }
      if (existing) {
        existing.status = 'completed';
        existing.completedAt = existing.endsAt;
        this.#saveEvent(existing, now);
      }
      state.activeEventId = event.id;
      state.revision = Number(state.revision || 0) + 1;
      this.#saveEvent(event, now);
      this.#saveState(state, now);
    });
    return this.get();
  }

  saveSettings({ weeklyTravelChance } = {}) {
    if (weeklyTravelChance !== undefined && (!Number.isFinite(weeklyTravelChance) || weeklyTravelChance < 0 || weeklyTravelChance > 1)) {
      const error = new RangeError('weeklyTravelChance must be a finite number between 0 and 1');
      error.status = 400;
      error.code = 'INVALID_LIFE_SETTINGS';
      throw error;
    }
    const now = asDate(this.clock());
    return this.store.transaction(() => {
      const state = this.#loadState();
      if (weeklyTravelChance !== undefined && weeklyTravelChance !== state.weeklyTravelChance) {
        state.weeklyTravelChance = weeklyTravelChance;
        state.revision = Number(state.revision || 0) + 1;
        this.#saveState(state, now);
      } else if (!this.store.db.prepare('SELECT 1 FROM life_event_runtime WHERE role_id=?').get('miyue')) {
        this.#saveState(state, now);
      }
      return { weeklyTravelChance: state.weeklyTravelChance };
    });
  }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => { try { this.tick(); } catch {} }, 60_000);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this;
  }
}
