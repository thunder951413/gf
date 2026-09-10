import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('.', import.meta.url));
const s = JSON.parse(fs.readFileSync(`${dir}scores.json`));
const m = JSON.parse(fs.readFileSync(`${dir}model-results.json`));
const usage = arm => {
  const rows = m.usage.filter(r => r.arm === arm);
  return { calls: rows.length, input: rows.reduce((n, r) => n + r.usage.prompt_tokens, 0), output: rows.reduce((n, r) => n + r.usage.completion_tokens, 0), cached: rows.reduce((n, r) => n + (r.usage.prompt_cache_hit_tokens || r.usage.prompt_tokens_details?.cached_tokens || 0), 0), ms: Math.round(rows.reduce((n, r) => n + r.durationMs, 0) / rows.length) };
};
const a = usage('all-background'), b = usage('attention-selected');
const md = `# 林雨薇关注度模拟：2026-09-07

结论：带上限的激活分与时间衰减能够实现“聊到时升温、停止提及时淡化、旧事仍可被找回”。但十二次实际模型调用没有显示稳定的聊天质量提升，不能据此宣称自然感已经解决。本实验没有接入正式服务，也没有修改正式聊天、角色参数和用量数据库。

## 实验范围

- 运行方式：本地虚拟时间，七条合成记忆，八类场景；没有等待现实中的几天过去。
- 记忆内容参考用户指出的问题编写，并非提取完整私人聊天。读书、工作和生活细节为实验虚构材料，非核实新闻。
- 相关性、话题切换、接受邀请的指向和否定提及由人工预先标注。这是在隔离检验排序与衰减，**未验证自动识别是否准确**。
- 模型为实际配置的 \`${m.model}\`，沿用项目当前林雨薇固定人设。比较“全部可用背景”和“经筛选背景”，同一组用户输入各跑一遍，保留各自连续回复。
- 为隔离材料选择的效果，没有运行正式服务的行为验收、重写、情感参数注入等流程。因此不能将本次样本解读为线上新旧版本对比。
- 每个条件只有一次采样，没有盲评或统计显著性；下面的语言效果评价由人工阅读作出，没有让模型自评。

## 计分方案与一次修正

初始分 12；基础与激活半衰期均为 3 天；一次有效用户提及加 10；激活上限 30；主动候选最低分 5。都是待调实验参数，不代表人的心理常数。

最初的“所有提及分别衰减，最后把总加分截到 30”存在隐藏积累。修正后，在每次提及发生时更新：

\`激活 = min(30, 旧激活 × 2^(-间隔天数/3) + 10)\`

查询某一时刻时：

\`关注分 = 初始分 × 2^(-记忆年龄/3) + 激活 × 2^(-距最后提及天数/3)\`

超额加分当场丢弃。同轮重复计一次，角色自己提及不加分，负面提及不加分。原始时间和文本没有被改写。

### 正常时间线：第 0、1、2 天分别提及，随后停止

| 第几天 | 潜水关注分 | 能否作为主动候选 |
|---|---:|---|
${s.timeline.map(t => `| ${t.day} | ${t.score} | ${t.proactiveEligible ? '是' : '否'} |`).join('\n')}

第 21 天用户明确问起潜水时，即使关注分只有 0.39，相关性仍能将其找回。关注分控制近期浮现程度，不是删除记忆或改变事实。

### 一天内二十次提及的压力案例

| 第几天 | 累计乘 1.5 | 最后才截断加分 | 修正后当场丢弃超额 |
|---|---:|---:|---:|
${s.stress.map(t => `| ${t.day} | ${t.naive} | ${t.clippedSum} | ${t.bounded} |`).join('\n')}

若 100 次提及集中在同一时刻，最后截断的版本 3 天后还有 36 分；修正后的版本从 42 分降到 21 分。停止强化后确实按指定半衰期下降。

### 排序、相关性与候选内容

| 情形 | 实际选中的记忆 ID |
|---|---|
${s.scenarios.map(c => `| ${c.name} | ${c.selected.map(x => x.id).join('、') || '空，不凑数'} |`).join('\n')}

ID 对应：dive=用户潜水计划；work=她的改稿烦恼；book=日常散文；tea=旧的泡茶分享；movie=海洋纪录片；walk=招牌观察；new-book=新读到的旧衣随笔。

回复时只选相关或仍在进行的话题。主动时按关注分并扣除近期重复分享；每主题最多一条、最多三条、实验预算最多 600 字符。**600 字符不是 600 token**；本实验没有声称实现精确 token 截断。

发现一个选择过严的问题：潜水计划和海洋纪录片被归在同一主题，去重规则同时挡掉了可能有用的纪录片联想。后续应考虑“一个主题包含少量互补细节”，而不是每个主题机械保留一条。

## 排名能否避免主动消息重复

模拟在每次选中后将该条假定为已发送，并写入实验曝光记录；不额外调用模型。这是机制模拟，真实接入时必须记录实际说出的细节，不能把进入提示词等同于已分享。

| 模拟日期 | 不记录已分享 | 记录已分享并冷却 |
|---|---|---|
${s.closedLoop[0].deliveries.map((d, i) => `| ${d.day} | ${d.selected || '空'} | ${s.closedLoop[1].deliveries[i].selected || '空'} |`).join('\n')}

纯排序会连续七次选择潜水。加曝光后，同一天能依次选潜水、工作、读书、泡茶，然后留空；但次日潜水仍会回来。**一天冷却只能减少短期重复，不能保证每天有新内容**。还需要不断产生生活事件，并区分“这个话题还感兴趣”与“这个具体细节已经说过”。

没有新增经历的第 40 天，主动候选为空。这比硬塞陈旧话题合理，但关注度本身不负责创造新的可分享内容。

## 十二次真实模型调用的人工观察

| 检查点 | 观察 |
|---|---|
| 连续聊潜水 | 两组都接住了潜水，不能算筛选版独有改善；筛选版仍问“南澳那边现在水温应该还可以吧”，背景没有这个依据 |
| 用户转向需要安慰 | 两组都停止潜水；筛选版仍新增了急改稿、蜂蜜水等内容，没有因背景为空而只回应用户 |
| 接受讲心事邀请 | 两组都讲出了客户要求含糊的改稿问题，后续能回答设计偏好 |
| 动作描写与模板习惯 | 筛选版仍出现“（轻叹一口气）”，筛选本身没有解决表达习惯 |
| 新生活内容触发主动消息 | 两组都使用了旧衣服的内容；筛选版仍以“它记得你的习惯”抒情收尾，不能据此认为比喻问题已解决 |
| 新增虚构细节 | 模型补写了衣柜、母亲围巾、具体设计配色等；用户允许角色发展新经历，因此不是一概禁止，但之后必须能记住，不能当已核实资料 |

## 调用用量与时间

以下为本次接口实际返回的 token 计数，缓存数属于输入的子集。没有按公开标价推算实际账单。

| 条件 | 调用次数 | 输入 token | 缓存命中输入 | 输出 token | 平均单次耗时 |
|---|---:|---:|---:|---:|---:|
| 全背景 | ${a.calls} | ${a.input} | ${a.cached} | ${a.output} | ${a.ms} ms |
| 关注筛选 | ${b.calls} | ${b.input} | ${b.cached} | ${b.output} | ${b.ms} ms |

这组样本输入减少 ${((1 - b.input / a.input) * 100).toFixed(1)}%，输出反而增加，平均时间几乎相同。两组共享固定前缀、并行执行，缓存可能互相影响；不能承诺这个比例在正式使用中保持，也不能推导长期账单同比下降。

## 参数敏感性

| 半衰期 | 最后一次提及之后，低于主动阈值所需时间（0.25 天步长） |
|---|---:|
${s.sensitivity.map(x => `| ${x.halfLifeDays} 天 | ${x.daysAfterLastMentionBelowThreshold} 天 |`).join('\n')}

统一三天可能使正在读的长书过早退场。身份事实不进入衰减池；持续活动需要另存是否仍在进行，不能仅凭关注分判断活动结束。

## 下一步判断

适合采用修正后的计分作为记忆检索的一层；不建议把“前几条关注内容”作为模型的全部背景。应保留小而稳定的人物与当前生活事实，并在同一主题下允许少量互补内容。真实接入前，还需验证自动提及识别、否定、指代、话题切换，以及实际分享细节的记录。

尚不能宣称：已经让她更像真人、杜绝了比喻或跳题、自动理解已完成、参数已找到最优值。

## 复现与文件

- \`node --test experiments/attention-simulation/attention.test.mjs\`：14 项测试，包括 200 组固定随机种子的压力序列。
- \`node experiments/attention-simulation/simulate.mjs\`：免费重算分数、排序和闭环结果，输出 scores.json。
- \`node experiments/attention-simulation/model-trial.mjs\`：实际付费模型调用；为防止误重复，已有 model-results.json 时拒绝运行。凭据仅从现有配置读取，不输出。
- \`node experiments/attention-simulation/report.mjs\`：用本次已有结果重建报告。
- model-results.json 保存完整提示与原始回复，不包含密钥；以下附上所有回复，不筛掉负面样本。

## 原始试聊

${m.cases.map(c => `### ${c.scenario} / ${c.arm}\n\n${c.turns.map((t, i) => `第 ${i + 1} 轮，材料：${t.selected?.join('、') || '空'}\n\n用户 / 触发：${t.user}\n\n回复：\n\n${t.reply || t.errorCode}\n`).join('\n')}`).join('\n')}
`;
fs.writeFileSync(`${dir}REPORT.md`, md);
console.log(`Report generated with ${m.usage.length} real calls and ${s.scenarios.length} scoring scenarios.`);
