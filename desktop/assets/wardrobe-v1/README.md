# 林雨薇衣柜第一版

三套穿搭 × 站立 / 阅读，共六张静态照片样稿，使用 Codex 内置 imagegen 根据当前头像和上一版姿态生成。四张新图的完整提示词见 [prompts.json](prompts.json)；日常格纹两张复用 [上一版素材记录](../photo-study-v1/README.md)。原始生成文件保留在生成目录，工作区使用副本。

| ID | 穿搭 | 素材 |
| --- | --- | --- |
| everyday | 日常格纹 | sources/everyday-idle.png、sources/everyday-reading.png |
| soft-knit | 温柔针织 | sources/soft-knit-idle.png、sources/soft-knit-reading.png |
| homewear | 舒适居家 | sources/homewear-idle.png、sources/homewear-reading.png |

`sources/` 保留带背景原图：日常格纹含已烘焙的棋盘格，其余是灰色背景。用户确认使用本地抠图后，新增 `cutouts/` 下同名的六张 RGBA PNG，供 0.3.0 桌面角色与衣柜预览使用。它们是静态照片，不包含眨眼或肢体动画。

## 透明素材处理

使用 Mac 本地 Apple Vision 前景实例分割，保留原始 1024×1536 画幅，修整背景边缘，恢复分割遗漏的原图木质椅子支撑与坐垫。没有重新生成脸部或衣服。处理脚本为 `desktop/matte-wardrobe.swift`，运行时桌面应用只读处理好的图片，不进行抠图或模型调用。

```sh
xcrun swiftc -O desktop/matte-wardrobe.swift -o /tmp/youjian-matte -framework Vision -framework CoreImage -framework AppKit
/tmp/youjian-matte desktop/assets/wardrobe-v1/sources desktop/assets/wardrobe-v1/cutouts
```

六张输出均检查了透明、实体与过渡像素，并在深浅背景上对照检查。当前尺寸的边缘收缩面向约 350 点高的桌面显示，细发丝会有损失；如需放大打印或重新构图，应使用原始素材重新处理。

## 状态与接口

- `lib/wardrobe.mjs` 在现有 SQLite metadata 的 `wardrobe:miyue` 行保存当前穿搭、开关、下次更换时间及版本。
- `GET /api/wardrobe` 和 `GET /api/life` 中的 wardrobe 返回同一状态。
- `POST /api/wardrobe` 支持 `{outfitId, automatic, locked}` 的任意子集，严格校验；有正在生成或待送达的回复时返回 409。
- 默认自动：上海时区每天 07:00 起，下一次读取时选一套不同的衣服。当天重复读取及重启保持不变，离线跨多天只选一次，不补演过去的换装。
- 手动选择保留到下一个 07:00；锁定或关闭自动后一直保持。重新启用在下个边界才恢复随机。
- 对话只增加不足 100 个中文字符的当前衣着背景，相关时参考；不由衣着推断地点、活动，不生成新的聊天消息，不增加模型调用。
- 原生衣柜菜单保存成功才改变当前状态；拒绝旧版本回写。样稿窗口仅在内容变化时刷新，六张图片缓存复用。

## 验证

衣柜单测覆盖 07:00 边界、重启、跨天、手动保留、锁定、恢复、时钟回退、非法写入及上下文长度；集成测试捕获实际模型请求，验证选中衣着进入上下文且换装不写聊天。原生桌面编译签名及原有核心测试通过；实测菜单打开、穿搭下拉保存、双图和单阅读预览。上线前后 291 条历史消息和八组设置及模型配置校验无变化。
