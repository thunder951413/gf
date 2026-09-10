# 知乎热点研究接入 · 0.3

用户要求以新浪热点或近期大事发现话题，再通过知乎智能体获得回答，供陪伴角色主动交流。实现使用知乎官方 HTTP API，采集请求仅携带公开话题和已获取的公开来源，不发送任何私聊或个人记忆。实际密钥尚未提供，必须如实显示等待配置，禁止写入假回答。

## 已核对的官方资料（2026-09-06）

- https://developer.zhihu.com/docs?key=zhihu_search
- https://developer.zhihu.com/docs?key=global_search
- https://developer.zhihu.com/docs?key=hot_list
- https://developer.zhihu.com/docs?key=zhida
- https://developer.zhihu.com/docs?key=quota
- 浏览器读取的完整文档仅作本地研究保存在 `.runtime/research/zhihu-*.txt`。

固定 API origin 为 https://developer.zhihu.com；所有调用带 Authorization: Bearer <Access Secret> 和 X-Request-Timestamp: Unix秒。不要使用网页登录 cookie，不发送到自定义域名，不跟随携带凭据的重定向。

- GET /api/v1/content/hot_list?Limit=10：{Code:0,Data:{Items:[{Title,Url,Summary,ThumbnailUrl}]}}，Limit最大30。
- GET /api/v1/content/zhihu_search?Query=...&Count=5：Count最大10，{Code:0,Data:{Items:[{Title,ContentType,ContentID,ContentText,Url,AuthorName,EditTime,VoteUpCount,CommentInfoList:[{Content}],AuthorityLevel}]}}。
- GET /api/v1/content/global_search?Query=...&Count=10&SearchDB=realtime&Filter=publish_time>=<unix>：Count最大20；其他可选Filter按官方host和publish_time语法；相同Items字段。
- POST /v1/chat/completions：仅发送{model:'zhida-agent',messages:[{role:'user',content:...}],stream:false}，无max_tokens/temperature等未承诺字段。模型枚举zhida-fast-1p5/zhida-thinking-1p5/zhida-agent，账号授权可能不同。仅使用choices[0].message.content，不展示或保存reasoning_content。
- GET /api/v1/quota?APIIDs=global_search,zhihu_search,hot_list,zhida_openai：{Code:0,Data:[{APIID,APIName,TotalQuota,TotalUsed,RemainingQuota}]}；官方说此查询不消耗业务额度。只展示原始剩余额度，不猜测官方重置时区。
- 业务错误20001鉴权、30001频限，HTTP401/403/429等必须如实失败，不能解析为成功空列表。不把服务端错误原文/密钥写进日志或前端。

## 文件分工

- Sol：仅 `lib/zhihu-client.mjs` 与 `test/zhihu-client.test.mjs`，实现下面客户端/配置/正规网络传输。
- Terra：仅 `public/app.js`、`public/index.html`、`public/styles.css`，按下文API添加知乎配置和资料证据展示。
- 主代理：`lib/zhihu-research.mjs`、`lib/zhihu-store.mjs`、SQLite现有store、server、model/proactive上下文、测试、文档与后台服务部署。

## 客户端接口（Sol）

export class ZhihuClient({dataDir,env=process.env,fetchImpl?,clock=()=>new Date()})
defaults {enabled:true,model:'zhida-agent',dailyRequestLimit:20,dailyAgentLimit:4,topicsPerRun:2,useHotList:true,useNewsSearch:true}
配置保存在dataDir/zhihu.json，目录700文件600原子写入；key字段accessSecret。env.LIFE_ZHIHU_ACCESS_SECRET可覆盖key。publicConfig()返回defaults所有设置 + {configured,hasKey,isEnvManaged}，永不返回key或key片段。
save(patch)支持上述settings、accessSecret、clearKey:true；空白accessSecret保持旧key（显式clearKey清除）；strict类型校验：dailyRequestLimit整数1..100，dailyAgentLimit0..20且<=dailyRequestLimit，topicsPerRun1..3。拒绝未知字段/错误model/超长secret(4096)，错误status400。settingsSnapshot()可由publicConfig输出全部用于研究循环比较，密钥更换同样需要generation/version变化：publicConfig增加revision整数，每次save递增，envkey不能输出。
方法（均async）：
- hotList({limit=10}={}) -> normalized items
- search(query,{count=5}={}) -> normalized items
- globalSearch(query,{count=10,since?,hosts?}={}) -> normalized items；since ISO或Date由主代理提供，拼出固定语法Filter，不接受任意模型Filter表达式；hosts数组仅公共域名字符串（测试非法注入拒绝）。
- answer(prompt,{model?}={}) -> {text,model}；单user消息，无聊天历史。
- quota() -> [{id,name,total,used,remaining}]；缺失/非法数值不可被当0。
normalized item: {title,url,summary,author?,publishedAt?,votes?,comments?:string[],kind?,authority?}。限制大小，去HTML标记，安全http(s)链接保留原UTM溯源，拒绝js/data/凭据URL。搜索需字段schema存在（Items为array），hot无summary合法。comments最多3条、每条500char，summary最大6000。搜索EditTime是秒，转换ISO；未知日期null。hot.publishedAt=null（热榜上榜时间不是文章发布日期）。
请求默认fetchImpl走自身有界传输：固定https官方origin，拒绝redirect，JSON响应最大2MB，整体超时搜索25s/直答90s；支持已有可信本地HTTP代理env.LIFE_ZHIHU_PROXY || env.LIFE_FEED_PROXY的HTTPS CONNECT，代理仅127.0.0.1不带凭据，TLS验证目标证书。别将Authorization发给CONNECT请求（只在隧道TLS内发送）。传输可用Node内置http/https，无依赖。测试用注入fetchImpl支持标准fetch Response，必须timeout覆盖响应body读取；不用真密钥/真收费API测试。

## 应用API（主代理 + Terra）

GET /api/zhihu -> {config:publicConfig,runtime:{running,lastRunAt,nextRunAt,lastError,lastReason,requestsToday,agentCallsToday,quota?,quotaCheckedAt?},recent:[{id,title,status,createdAt,contentId?,error?}]}
POST /api/zhihu/config 同GETshape。表单填写Secret留空保持；保存在本地，页面保存后清空password。可改默认model三选、dailyRequestLimit/dailyAgentLimit/topicsPerRun、启用、知乎热榜/近期大事搜索开关。无自定义endpoint。
POST /api/zhihu/test -> {ok:true,quota:[...]}，只调用额度接口，不启动Agent；错误走标准{error,code}。
POST /api/zhihu/refresh {} -> {added,reason,...GETshape}，即时体验但不绕过总量/冷却/关闭限制；timeout前端450s。自动刷新和手动刷新合并，不重复研究同一话题。
GET /api/content 的每项扩展 `research` 属性（普通RSS省略）；主动会话使用 `sourceResearch`：
{kind:'zhihu_research',generatedBy:'zhida-agent'|null,topic,discovery:{title,url,source,publishedAt?},references:[{title,url,author,summary,publishedAt?,kind?}],generatedAt}
content.url 为真实话题/来源链接，绝不捏造Agent报告网址；summary标注AI资料整理或知乎回答摘录。页面卡片显示“知乎资料 · AI整理”或“知乎回答摘录”，日期标“整理于”；引用列表显示作者、原链接，至少展开能看见对应摘录；区分新闻来源、真实社区回答、Agent整理，不把综合文本当原作者的话。聊天中的主动消息metadata通过sourceResearch同形提供，至少显示知乎来源链接/作者；后端由主代理提供。
知乎设置卡放在现有设置页面；一起看看顶部加简洁入口/状态：“热点 → 知乎观点 → 一起聊”，提供立即研究按钮及去设置入口。状态刷新不覆盖未保存设置，不自动弹权限、不朗读、不把Secret放进URL/DOM可读状态或日志。

## 研究流程（主代理）

沿用约2小时采集节奏，但独立nextRunAt持久化，RSS与研究异步独立，不能让较慢Agent阻塞陪伴聊天调度。最多每轮2话题，候选来自公开近期新闻（现有RSS与新浪可用入口）、知乎热榜、官方全网搜索近期新闻。对发现时间/原发布日期分别保存；去重、按兴趣匹配抽样、避免仅按热度选择。
每话题先站内搜索真实回答（带作者/溯源URL），再给直答Agent单条公开研究提问，请求事件背景、不同观点、分歧/不确定性和可聊问题；不发送用户私聊和记忆。无真实搜索结果不伪造回答。不存reasoning_content，不自动把Agent任意URL列为证据。
调用计数写SQLite，所有业务请求在调用前预留，失败亦计数，跨重启持久；默认20次业务请求/本地日、其中Agent最多4次，额度测试独立限频。热点缓存与topic去重避免每轮重复消耗；鉴权/429退避，失败保留旧内容；关闭或改配置期间完成的结果不能照常入库。研究结果融入现有候选库，并保留可审阅引用信息。


## 新浪公开热榜与实际运行

固定入口 `https://sinanews.sina.cn/h5/top_news_list.d.html`。从页面 script 中仅 JSON.parse 纯 `SM = {...};` 数据，读取 `SM.data.data.hotList` 的 `info.title` 和 `base.base.url`，不执行脚本。`SM.data.resTime` 是观察时刻，超过六小时拒绝；不能标为新闻发布日期。只保留已知新浪 HTTPS 域名链接，最多50条，20秒整体网络期限，复用 RSS 的有界安全传输与受信任本机代理。

SQLite `content.research_json` 保存整理来源，`proactive_events.source_research` 保存投递时证据快照，删除订阅后已有主动消息仍可核对原链接。`zhihu_attempts` 是调用前预留记录，`zhihu_topics` 保存成功去重和失败重试时间，metadata 中 `zhihu_runtime` 保存研究计划、热点摘要、冷却及额度缓存。关闭研究或改配置期间完成的旧结果丢弃。

研究与主动联系使用不同计时器和租约。研究默认使用主动陪伴中配置的采集间隔并加10%随机浮动；关闭主动陪伴会暂停研究。无密钥时仅发现公开话题。检索后若直答预算不足，只保存明确标记的回答摘录；直答网络调用失败时本话题失败，保留以前成功的资料，不冒充整理成功。

模型上下文显式说明“AI整理/原回答摘录”“未独立核验”和日期含义，并附有界作者、原链接及摘录；引用资料处于普通 user 引用区域，不提升为角色指令。
