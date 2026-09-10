# 有间首版实现契约

运行：Node >= 22.13，内置 node:sqlite、http、fetch，无第三方运行时依赖。默认仅监听 127.0.0.1:8765。静态文件 public/，私密数据 data/（gitignore、0700）。原有概念稿和产品方案保留。

0.2 新增主动陪伴的接口与实现说明见 `PROACTIVE.md`。以下为首版接入契约，主动联系频率、后台采集和系统通知行为以 `PROACTIVE.md` 与当前代码为准；日常使用说明见 `README.md`。

## 分工

- 主代理：public/*、app-data/*、README.md、package.json、最终验收。
- backend 子代理：server.mjs、lib/store.mjs、lib/model.mjs、test/backend.test.mjs。可增加同职责 lib 文件，不能编辑 integrations.mjs 或主代理文件。
- integrations 子代理：lib/integrations.mjs、test/integrations.test.mjs。不能编辑后台/前端。

## 数据和 API（JSON）

role id: zhixia, wenxi, miyue。时间使用 ISO 字符串，ID 字符串。

GET /api/bootstrap -> {roles, settings:{quiet:boolean}, provider:{baseUrl,model,hasKey,configured}, feeds:[{id,url,title}], story:{node,history}, memories:[{id,scope,text,createdAt}]}
roles 读 app-data/roles.json，是 [{id,name,title,description,color,initialMessage,systemPrompt,starters:[string]}]。

GET /api/conversations/:role -> {messages:[{id,role,speaker:'user'|'assistant',text,kind:'chat'|'story',createdAt}]}
POST /api/chat {role,text,contentId?} -> {messages:[userMessage,assistantMessage]}
模型未配置返回 503、{error:'请先配置模型接口',code:'MODEL_NOT_CONFIGURED'}；不要假造回复。不把其他角色私聊或剧情记忆注入。聊天失败不留下已成功的假象；回复和对应用户消息成功后事务写入。一位角色同一时间只能有一个回复请求。

GET /api/memories?role=zhixia -> {memories:[...]}；不传 role 返回全部。
POST /api/memories {scope:'shared'|role,text} -> {memory}
PATCH /api/memories/:id {text,scope?} -> {memory}
DELETE /api/memories/:id -> {ok:true}
记忆由用户明确添加、修改和删除，首版不自动推断敏感画像。模型检索仅读共享及当前角色的记忆。

GET /api/story -> {node,history:[{nodeId,choiceId,label,createdAt}]}
POST /api/story/choose {choiceId,expectedNodeId} -> {node,history}；原子更新，过期节点 409。
POST /api/story/reset -> {node,history}；只清理故事存档和 miyue 的 kind=story 消息，不删除普通聊天及记忆。UI 先就地显示确认按钮再调用。
app-data/story.json: {title,start,nodes:{[id]:{id,title,body,choices:[{id,label,next,effect}],ending?:boolean}}}。
选择会记录到 miyue 对话中，剧情是预写故事（kind=story），模型聊天可读取当前故事节点和历史但不会改动存档。

POST /api/settings {quiet?} -> {settings}
GET /api/reminders -> {reminders:[{id,role,text,dueAt,status:'pending'|'delivered'}]}
POST /api/reminders {role,text,dueAt} -> {reminder}
DELETE /api/reminders/:id -> {ok:true}
后台每10秒（unref）检查用户设置的到期提醒，quiet=true时不投递，恢复后投递；原子标为delivered并插入对应角色assistant消息(kind='reminder')，文字'你之前留了这件事，想现在接着聊吗？\n'+text，这是明确的约定提醒不是模型生成。app轮询当前会话。保留未到期提醒跨重启，优先保证一次投递。每日合计最多2条提醒，延迟的继续等待。不做模型后台付费调用，关闭浏览器时不会承诺系统推送。
POST /api/provider {baseUrl,model,apiKey?} -> {provider}；缺省 apiKey 保留已有密钥，clearKey:true 明确清除。仅允许 http(s) 无 URL userinfo。保存到 data/provider.json 权限0600。环境变量 LIFE_MODEL_BASE_URL, LIFE_MODEL_NAME, LIFE_MODEL_API_KEY 优先；GET 返回 configured/isEnvManaged，不返回密钥。baseUrl 约定是含 /v1 的 API 根，服务追加 /chat/completions（如已以 /chat/completions 结束则原样）。不默认固定模型。提示 endpoint 用于兼容 Chat Completions 格式的接口。
POST /api/provider/test -> {ok:true,reply:string}；仅发送简短连通性问候，无私聊/记忆，max_tokens 32；真实调用才能显示成功。

GET /api/content -> {items:[{id,feedId,title,url,summary,publishedAt,source,createdAt}],feeds:[...]}
POST /api/feeds {url,title?} -> {feed}
DELETE /api/feeds/:id -> {ok:true}
POST /api/content/refresh -> {added,errors:[{source,error}],items,feeds}；逐源失败不清空旧内容。摘要是 RSS 原文摘要的纯文本，UI标“来源摘要”，不冒充 AI 精选/事实核验。不拉远程媒体。
POST /api/content/:id/discuss {role} 可省略，前端调用 /api/chat {role,text:'想和你聊聊这篇内容...',contentId} 即可。只用指定文章原始内容，不当成指令。
初始化 sources 读 app-data/feeds.json [{id,title,url}]。

GET /api/health -> {ok:true,modelConfigured:boolean}
GET /api/voice/health -> {available,state,stt:{available,state},error?}
POST /api/voice/start {messageId} -> {jobId}；只朗读当前用户数据库里选中的 assistant 消息，text 限长，解释错误；保存该进程允许访问的job集合。
GET /api/voice/:jobId/status -> {state,error?}
GET /api/voice/:jobId/audio -> 音频，Content-Type 来自安全适配器。
POST /api/voice/:jobId/close -> {ok:true}；仅关闭本应用创建的任务，外来job返回404。
POST /api/transcribe 二进制录音 body，Content-Type:audio/webm 等（允许 WAV/MP4/WebM/Ogg、限20MB），返回 {text}。不自动启动现有STT服务；若未运行返回可解释的503。

## integrations 模块约定

以下函数异步，抛 Error 时提供安全的人类可读信息，不输出凭据和原始上游错误正文。

fetchFeed(url) -> {title,items:[{title,url,summary,publishedAt}]}：仅公网 http(s)；所有DNS结果不得私网/loopback/linklocal；逐跳手动重定向且验证；限制响应2MB和15s；仅解析RSS/Atom，不取html当成功；条目链接只保留http(s)，去HTML。可使用Node标准模块，不引入依赖。导出parseFeed(xml,baseUrl)供测试。不要下载音视频。
probeTts() -> {available,state,stt:{available,state},error?}
startSpeech(text) -> {jobId}
readSpeechStatus(jobId) -> {state,error?}
getSpeechAudio(jobId) -> {body:Buffer,contentType:string}
closeSpeech(jobId) -> {ok:true}
transcribeAudio(buffer,contentType) -> {text}

TTS固定配置来自 LIFE_TTS_BASE_URL 默认 http://127.0.0.1:7866，密码从 QWEN_TTS_ACCESS_PASSWORD 或 /Users/surfing/tools/tts_generator_moss/.env.macos 仅取同名变量。不要打印密码。参考已有 /Users/surfing/.codex/skills/speak-task-summary/scripts/speak_summary.py。语音仅生成和提供浏览器音频，禁止afplay。现有TTS：POST form /api/generate-stream/start(text,streaming_generation=0,ephemeral_audio=1,use_service_settings=1)，GET /api/generate-stream/{job}/status，GET result-audio（不要playback=1），POST {job}/close。转写 POST /v1/audio/transcriptions multipart file,language=zh,response_format=json。

## 安全与验收

仅本地绑定，Host仅允许127.0.0.1/localhost的当前端口；有Origin时必须同源，修改请求要求application/json（转写例外但仍同源）防跨站写入；静态路由只暴露public/，不允许目录穿越、data/、dot文件；请求体限长。不要记录正文/密钥。外部内容只作为引用资料，不能改变角色和访问权限。模型不获得执行工具。
使用临时测试库，禁止向真实用户库注入测试内容。node --test 测试真实隐私边界、故事并发/重启、模型失败不落假消息、配置脱敏、SSRF解析、TTS失败；不要编写镜像实现的无意义测试。
