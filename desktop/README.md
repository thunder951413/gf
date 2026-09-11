# 有间桌面 · Mac 原型

在有间网页的「设置 → 林雨薇 · 桌面角色」开启开关即可启动，关闭开关会退出桌面程序。退出后可随时从这里重新打开；暂时隐藏角色时，点击「显示角色」找回。开关会读取实际运行状态，退出桌面程序后会自动更新。也可以双击 `desktop/build/有间桌面.app` 启动。首次构建或修改源码后，在项目目录运行 `npm run desktop:start`。需要 macOS 14 或更新版本、Apple Command Line Tools；运行已编译应用不需要 Node，聊天后台仍使用原有有间服务。

桌面 0.5.3 已修复悬空抠图进入自动选择、缺图阻塞同步及关闭开关误报。图片库中只有开启“允许自动用于桌面角色”的透明素材才进入自动选择；无合适素材时显示完整备用角色。[检查记录](DESKTOP-AUDIT-20260910.md)。

## 使用角色外观

右键桌面人物，选择「切换角色形象」可立即换一张符合当前季节、室内外和活动状态的透明人物图，不需要等待定时轮换，也不会发起聊天或消耗模型 token。没有其他匹配图片时保留当前形象并提示；原有自动轮换开关和间隔保持不变。

桌面默认显示林雨薇的写实透明人物。点击系统菜单栏的心形气泡，选择「形象工坊…」；也可以右键角色打开菜单。工坊只提供目录中已验收的**完整造型**：一次选择会确定同一张照片的发型、衣着、姿态、表情和配色。下拉修改某个维度时，客户端会选取最接近的已验收完整造型；它不会把任意发型、服装、姿势和表情作笛卡尔组合，也不会把一张照片伪装成另一种姿态或表情。

可选场景只影响背景、人物摆放和雨雪等环境动态。人物照片的光照、人物阴影和反射已固定在原图中，切换背景不会重新打光。勾选「桌面显示场景卡片」才显示背景；「减少环境动态」会关闭场景雨雪等动态。选择与当前服装不兼容的场景会被拒绝。

「自动选择合适形象」和「锁定当前形象」由后端的 `/api/appearance` 保存，而不是只保存在桌面窗口内。后端当前实现会在满足自动、未锁定、非忙碌状态时按日程和生活状态选择已有完整素材；生活状态切换带最短停留时间，锁定会停止这种自动切换。`automatic`、`locked`、`sceneCardEnabled` 和 `reduceMotion` 的最终语义、持久化和切换时机以运行中的后端实现为准。离线时桌面只能显示上次已确认的外观，恢复连接后才可应用更改。

写实人物是静态照片 cutout：没有全身 3D 骨骼动画、逐帧眨眼或口型同步。`CharacterScene.swift` 中的 SceneKit 角色仍是备用 3D 路径，可在菜单中切换，不能被描述为写实照片的动画能力。

单击角色或头顶气泡会打开已有聊天，默认进入林雨薇。双击角色会请她主动关心、惦记你；一分钟内再次双击，会接着表达亲亲、抱抱和更亲昵的关怀。第一句还在生成时，追加双击会合并为一次亲昵回应，等第一句说完再接着说。此互动由你发起，关闭定时主动聊天或安静模式也可使用；输入文字聊天会优先接你的话。双击只作为内部邀请，聊天历史仅保存她的回复，不插入操作描述或替用户说话。她像忽然惦记起你、感觉你也在想她一样开口；生成内容若提到操作会进入一次修复检查。网络重试不会重复写入。拖动角色会保留悬浮位置。手动切换外观只改变显示，不会写入角色经历、关系或对话；关闭聊天窗口后角色仍在，退出桌面程序也不停止已有的后台采集和主动消息服务。

## 架构与素材维护

`assets/visual-catalog.json` 是人物、场景和已验收文件的唯一目录。`PhotoPetView.swift` 读取目录与 PNG alpha，按实际透明像素处理鼠标穿透；`NativeSceneCanvas` 负责把透明人物放入可选场景并渲染环境动态。`VisualStudio.swift` 只列出已完成组合，`lib/appearance.mjs` 处理服务端的选择、兼容性、自动状态和持久化。

新增或替换素材后，先更新目录并运行：

```sh
node scripts/verify-visual-assets.mjs
npm run desktop:build
```

验证器从目录动态统计已验收原图、已验收本地换色、ready 场景和背景引用，因而不把这些数量写死。它检查路径安全性和实际存在性、PNG 的 1024×1536 IHDR、透明人物的 RGBA/灰度加 alpha、每个 ready 维度是否有真实已验收照片，以及私密衣着是否只与 private 场景兼容。它不调用模型。

## 验证

`npm run desktop:test` 检验桌面核心行为。`node desktop/attention-test.mjs` 在临时 AppKit 程序与隔离服务中验证三个渲染器的单双击、忙碌重试、追加亲昵和取消行为，不连接正式聊天。`node scripts/verify-visual-assets.mjs` 检验目录和文件契约。两者通过只代表相应的自动化检查完成；桌面 UI 的生产环境交互与视觉验收仍需单独执行。

`desktop/build/有间桌面.app/Contents/MacOS/YoujianDesktop --demo --pose reading` 运行隔离演示，不连接正式服务。加 `--snapshots /绝对目录` 导出透明 PNG 用于外观检查；只在演示中使用。`--test-profile --base-url http://127.0.0.1:测试端口/` 可连接模拟服务，偏好与正式桌面配置隔离。


运行 `node desktop/mock-service.mjs` 后，可用 `--test-profile --base-url http://127.0.0.1:8878/ --check-chat /绝对输出目录` 执行原生聊天窗口自检，导出 WebKit 渲染图和尺寸、测试页识别结果后自动退出。它只适用于模拟服务，不读取正式聊天。`--show-studio` 可在启动时打开形象工坊。

`render-visual-review.swift` 使用同一套 `NativeSceneCanvas` 绘制组合验收图，不需要截取用户桌面：

```sh
swiftc desktop/CompanionCore.swift desktop/PhotoPetView.swift desktop/render-visual-review.swift -o /tmp/youjian-render-review
/tmp/youjian-render-review desktop/assets desktop/assets/visual-v2/review.png
```

当前版本的验收证据和限制见 `desktop/VALIDATION.md`。
