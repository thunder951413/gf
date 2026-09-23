# 主动陪伴实现契约 · 0.2

用户明确要求自动抓取内容并随机发起交流；这是本应用后台能力，不创建 Codex 自动化。默认启用，模型未配置时采集照常、主动聊天如实显示等待模型。

## 分工

- 主代理：lib/store.mjs、server.mjs、lib/proactive-store.mjs（新）、app-data/feeds.json、启动和文档、集成测试。
- Sol 后台代理：仅 lib/proactive.mjs（新）、test/proactive.test.mjs（新）。实现调度/选题/模型生成逻辑，可依赖下述 repository 接口，以 fake repository 独立测试。
- Terra 前端代理：仅 public/index.html、public/app.js、public/styles.css。保持所有现有功能。

## 配置

GET /api/proactive 和 POST /api/proactive/settings 响应同形：
{settings:{enabled:true,fetchIntervalMinutes:120,minGapMinutes:90,maxGapMinutes:180,dailyLimit:4,activeStart:'09:00',activeEnd:'23:00',topics:'时事,科技,知识,文化,关系',notifications:false,desktopNotifications:true},runtime:{nextFetchAt,nextContactAt,lastFetchAt,lastContactAt,lastDecisionAt,lastReason,lastError,fetching,thinking,modelConfigured,quiet,desktopNotificationsAvailable,managedService},recent:[{id,role,kind,reason,createdAt,sourceTitle?,sourceUrl?,feedback?,messageId}],unreadByRole:{zhixia:0,wenxi:0,miyue:0}}
时间ISO或null。POST settings仅更新传入字段。interval 15..1440, mingap 5..1440, maxgap>=min, dailyLimit1..12, topics最长500, times HH:mm且start!=end（支持跨午夜）。notifications属于浏览器提示偏好；不用来自动弹权限。

POST /api/proactive/run -> {delivered:boolean,reason:string,message?:message}，仅跳过计划时间和最近用户活动检测；仍遵守enabled、quiet、时段、次数、未回应上限和模型已配置。不需要点击这个按钮才能自动工作。
POST /api/activity {typing:boolean} -> {ok:true}，typing=true 将后台忙碌截止设为now+45秒，不保存正文。
GET /api/inbox -> {items:[{messageId,role,text,kind,createdAt,sourceTitle?,sourceUrl?}],unreadByRole:{...}}，仅未读主动/提醒消息，最多30。
POST /api/conversations/:role/read {messageId} -> {ok:true}，仅能标记该角色已存在消息之前的记录。
POST /api/proactive/feedback {messageId,value:'good'|'less'|'later'} -> {ok:true}，后两者解除未回应计数；less降低对应source后续候选权重。用户成功回复会将该角色先前未回应主动消息标为responded。
GET会话消息新增：kind='proactive'，sourceTitle?,sourceUrl?,proactiveReason?,proactiveKind?。来源链接由后端提供，不能由模型随意指定。

## 调度模块接口（主代理按此提供 repository）

export class ProactiveEngine({repo,roles,model,refreshContent,clock=()=>new Date(),random=Math.random,isBusy=()=>false,onDelivery=()=>{},tickIntervalMs=15000})
start()：启动unref计时器并异步安排初次tick；不阻塞listen。
stop()：停止计时，等待正在执行任务完成，后续不投递。
tick()：处理到期采集和到期联系，可测试直接await；同引擎并发tick合并。
runNow()：调用主动联系只跳过nextContactAt/recent user/typing，返回上述APIshape；与tick互斥，不得重叠生成。
status()：返回{fetching,thinking}。

repo接口：
- getSettings() -> 上述settings。
- getRuntime() ->持久runtime（不含fetching/thinking/modelConfigured/quiet，主代理拼装）。
- updateRuntime(patch) -> 新runtime，仅字段merge。
- getQuiet() -> bool。
- getLastUserAt() -> ISO|null（最近普通chat用户消息）。
- getLastMessageId(role) -> string|null（检查生成期间是否有新会话）。
- countContactsSince(iso) -> number（reminder+proactive所有主动消息，删除reminder记录不重置预算）。
- countAttemptsSince(iso) -> number；recordAttempt(at)将一次模型生成尝试记录，用于每日最多dailyLimit*3上限。
- unansweredCount(role, sinceIso) -> number（该角色最近24h且未回复/未later/未less的主动消息；读过不算回应）。
- getCandidates() -> content列表，额外字段 category?,dislikedSource?:boolean,used?:boolean；最近使用同URL/规范化title会标used防不同来源重复。source元数据可信映射，正文不可信。
- getRecentContacts(limit=10) -> [{role,kind,contentId?,createdAt,...}]。
- getMemories(role) / getConversation(role,limit=20) -> 对应角色+shared，不得请求别人的正文。
- getStory() -> 当前故事节点与history。
- acquireLease(name,nowIso,untilIso) -> token字符串|null；releaseLease(name,token)。SQLite持久租约避免多实例/重启重叠。name='collect'|'contact'。
- commitDelivery({role,text,kind,contentId,reason,topicKey,createdAt,nextContactAt,expectedLastMessageId}) -> message|null：事务中插入assistant kind=proactive，关联事件，更新nextContactAt；若当前role最后消息已变或quiet/enabled变、预算满，返回null不投递。topicKey供防同一题重复，NULL内容用kind:role:日期。来源自content_id解析。

## 引擎行为

初次nextFetchAt=now，nextContactAt=now+随机1..5分钟，记录后重启不重新抽。enabled=false暂停采集和联系；quiet只暂停联系，采集继续。到期休眠恢复每种最多做一次，不补刷/补发。
采集共用refreshContent()返回{added,errors,items,feeds}；源失败保留旧数据。正常下次120分钟左右±10%；失败下次至少15分钟。采集租约180秒。主代理refreshContent并发上限2、总共最多20源，可复用Promise，manual/auto不会并发抓同批。
联系只能在活动时段（本地时间、支持跨午夜）；合计每天dailyLimit；至少minGap距最后任意主动消息；最近10分钟有用户chat、isBusy任意活跃chat/typing时暂缓；某角色24h未回应达到2则该角色等待用户，其他角色可继续联系。runNow仅豁免计划时间、最近活动、minGap（用户自己点击现在联系），其余不豁免。
同一角色最后一条消息若仍未得到用户回复，之后30分钟内不再自动发起新的主动消息；与全局最短间隔取较晚的可联系时间，生成完成前和数据库提交时再次核对。用户主动聊天或点击“现在联系”仍沿用明确发起交流的路径；约定提醒和同一回复的后续分段按各自投递规则执行。弥月在双方连续6小时没有消息后重新主动联系，可在本轮话题适合且亲近边界允许时自然带一点撒娇或询问近况；已选约定、跟进、剧情等明确目的优先，不拼接固定句式，不责备用户，也不臆测去向。
模型未配置不伪造persona消息，只更新状态，不产生频繁重试。异常15分钟退避；无值得分享内容/模型skip至少30分钟后再考虑。最多dailyLimit*3次/日本地模型尝试，包括失败和skip。关闭/改时段/用户开始回复/跨界等生成期间的变更，完成后再检查，丢弃过期生成；不是发完再撤回。
选题：有来源候选时约65%新内容、20%最近聊过话题、15%故事；缺少history时回退有资料内容或故事邀请。避开连续同role；闻溪偏内容，知夏偏生活关系/延续，弥月只依据明确的虚构故事状态。角色选择先于读取私聊；不得把三角色的私聊混入一个planner。多个源/类别轮换，时间敏感新闻优先7天内，知识文化可30天；排未来>1天、空标题/极短摘要、已用URL/近似title；在质量候选中随机，不按刺激程度排序。
内容可取最多12候选（标题300，summary1000）让选定角色的模型一次选题+写开场，读取本role最近20messages/6k字符、30memories/6k字符。不要中心planner读取别的role私聊。调用model.complete(messages,{maxTokens:1800})；role systemPrompt维持原设定。外部资料只能user消息明确隔离，不进入system。
返回严格JSON：{skip:boolean,contentId:string|null,reason:string,message:string}。接受围栏JSON，校验id来自提供候选、content类型必须有效id、reason<=300、message<=1200；生成必须有具体内容或共同话题，1~4句话+可选自然邀请，避免客服腔和固定寒暄、不说用户未回所以惩罚。来源链接由UI元数据呈现，模型不应编造事实/声称看完完整文章；来源摘要不完整要以已知范围表达。reason只用于UI“为什么联系我”。skip不发消息；无效JSON/空回复不发假消息。
成功用真实正文插入会话，contentId支持下次用户直接回复时延续原文讨论。下一次时间成功后从minGap..maxGap随机抽样并持久化。kind统一content | continuation | story（continuation即上文followup）。

## 前端体验

侧栏增加“主动陪伴”入口，设置上面字段、状态（下次采集/联系/原因/真实错误/需要模型）和最近联系记录；默认不是让用户手动创建任务。可选“现在找我聊一次”测试真实链路，未配置模型时提示去设置。界面用普通中文，避免队列/lease等实现细节。
每5~10秒跨所有role更新inbox（当前页面不在chat也检测）；角色显示未读badge；显示可点击toast/小条“闻溪给你留了一个话题”，点击切换对应角色。仅当前会话可见且消息滚到末尾后markRead；标记最多到已呈现messageId，不能清掉更新到来但没看到的。普通GET不自动标记。
支持用户主动点击“开启浏览器提醒”申请Notification权限；默认不自动弹权限或朗读。通知标题“有间有新消息”、正文不含私密信息、点击打开对应role；页面关闭后不承诺浏览器推送。notifications偏好持久化。另有desktopNotifications开关（默认true），由主代理用macOS系统通知实现，后台服务在线时网页关闭仍可请求通知，实际显示由系统通知权限决定；若此开关开且runtime.desktopNotificationsAvailable则前端不要重复浏览器通知。状态刷新/后台新消息不要重置用户正在填写的设置。主代理将安装可卸载的用户LaunchAgent后台服务（登录后运行），runtime.managedService标明此状态；无需前端做服务管理。
主动消息展示“主动分享/接着聊/故事邀请”badge、原链接、为什么想到这件事（可展开），以及“这个话题不错/少聊这类/稍后再聊”的反馈。不能装作已播放声音。保留普通chat、来源、memory、story和约定提醒功能。

## 验收

时钟/随机注入测试自动到期无需手点、到期自动抓取、固定范围随机、休眠恢复不补发、重启计划不重抽、quiet/活动窗口/每日总量/未回应2/生成过程中用户发言或关开关/重复topic防重、retry退避、无模型有采集无假话、角色隐私隔离、模型格式异常、真实候选id来源、普通回复接上自动文章。使用临时数据库，不在用户库造测试聊天或加假模型。
