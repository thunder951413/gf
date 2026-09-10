import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const dir = fileURLToPath(new URL('.', import.meta.url));
const suffix = process.argv.includes('--v2') ? '-v2' : '';
const model = JSON.parse(fs.readFileSync(`${dir}results${suffix}.json`));
const offline = JSON.parse(fs.readFileSync(`${dir}offline-results.json`));
const safe = v => String(v ?? '').replaceAll('|', '／').replaceAll('\n', ' ');
const metrics = model.arms.map(arm => {
  const usage = model.usage.filter(x => x.arm === arm.name), delivered = arm.turns.filter(x => x.status === 'delivered');
  return { name: arm.name, turns: arm.turns.length, delivered: delivered.length, skipped: arm.turns.filter(x => x.status.startsWith('skipped')).length, failed: arm.turns.filter(x => !['delivered', 'skipped-no-content'].includes(x.status)).length, calls: usage.length, repairs: arm.turns.filter(x => x.attempts.length > 1).length, postRepairStyleWarnings: delivered.filter(x => x.receipt?.behavior?.styleWarnings?.length).length, input: usage.reduce((s, x) => s + (x.usage?.prompt_tokens || 0), 0), output: usage.reduce((s, x) => s + (x.usage?.completion_tokens || 0), 0), cached: usage.reduce((s, x) => s + (x.usage?.prompt_cache_hit_tokens || x.usage?.prompt_tokens_details?.cached_tokens || 0), 0), averageMs: Math.round(usage.reduce((s, x) => s + x.durationMs, 0) / usage.length), questionReplies: delivered.filter(x => /[？?]/.test(x.reply)).length, averageChars: Math.round(delivered.reduce((s, x) => s + x.reply.length, 0) / delivered.length) };
});
const grouped = [];
for (const h of [1, 3, 7]) for (const exposure of [false, true]) {
  const runs = offline.runs.filter(r => r.halfLife === h && r.recordExposure === exposure);
  const mean = key => (runs.reduce((s, r) => s + r[key], 0) / runs.length).toFixed(1);
  grouped.push({ halfLife: h, recordExposure: exposure, deliveries: mean('deliveries'), uniqueDetails: mean('uniqueDetails'), repeats: mean('consecutiveRepeats'), emptyDays: mean('emptyDays'), lastDeliveryDay: mean('lastDeliveryDay') });
}
const concise = { model: model.model, metrics, retrieval: { probes: offline.probeResults.length, anyHit: offline.probeResults.filter(r => r.anyExpectedFound).length, misses: offline.probeResults.filter(r => !r.anyExpectedFound) }, grouped, armErrors: model.armErrors };
fs.writeFileSync(`${dir}summary${suffix}.json`, JSON.stringify(concise, null, 2));
let md = `# 关注度全面模拟：完整记录${suffix}\n\n模型：${model.model}。运行：${model.startedAt}—${model.finishedAt}。\n\n${model.design}\n\n${suffix ? '这是修正后的关注组连续回放；下方离线长时间表格与首轮检索表仍引用冻结的 v1 结果，修正后检索结果单列在 offline-v2-results.json。' : ''}\n\n## 机制与生成调用\n\n`;
md += '| 条件 | 交流节点 | 发出回复 | 无内容跳过 | 失败 | 模型调用 | 发生改写 | 改写后仍有风格警告 | 输入 token | 缓存输入 | 输出 token | 平均调用耗时 |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n';
md += metrics.map(m => `| ${m.name} | ${m.turns} | ${m.delivered} | ${m.skipped} | ${m.failed} | ${m.calls} | ${m.repairs} | ${m.postRepairStyleWarnings} | ${m.input} | ${m.cached} | ${m.output} | ${m.averageMs} ms |`).join('\n');
md += '\n\n这些是程序可直接计数的现象，不是语义质量评分。“发出回复”不代表自然、正确或令人满意。缓存属于输入子集。两组并行且共用固定前缀，不能用本次缓存比例保证长期账单。\n\n## 自动检索：独立问题\n\n';
md += '| 问题 | 预期相关记录 | 实际选择 | 是否找到至少一项预期（或应为空） |\n|---|---|---|---|\n';
md += offline.probeResults.map(p => `| ${safe(p.text)} | ${p.want.join('、') || '空'} | ${p.selected.join('、') || '空'} | ${p.anyExpectedFound ? '是' : '否'} |`).join('\n');
md += '\n\n预期标签未提供给检索器。记录自带主题与关键词，因此这并非无标注语义检索；检索器仅使用分词和字面相似度。命中率不表示选出的其他材料都相关。\n\n## 长时间模拟\n\n30 个组合（3 种半衰期 × 是否记录已分享 × 5 个种子），每组 91 天，共 2,730 次选择。这里发送的是选中材料的原文，用于隔离曝光机制，没有模型生成；因此是对曝光识别的理想输入，不能代表真实聊天中的识别准确率。\n\n';
md += '| 半衰期 | 记录已分享 | 平均发出次数 | 不同细节数 | 连续次日重复数 | 无内容天数 | 最后分享日 |\n|---|---|---:|---:|---:|---:|---:|\n';
md += grouped.map(g => `| ${g.halfLife} 天 | ${g.recordExposure ? '是' : '否'} | ${g.deliveries} | ${g.uniqueDetails} | ${g.repeats} | ${g.emptyDays} | ${g.lastDeliveryDay} |`).join('\n');
md += '\n\n固定的生活材料池在第 34 天后不再新增；后续空白是有意测试内容耗尽，不是实际生活引擎产生新事件的测试。\n\n## 所有连续对话（包含失败）\n';
const ids = [...new Set(model.arms.flatMap(a => a.turns.map(t => t.id)))];
for (const id of ids) {
  const example = model.arms.flatMap(a => a.turns).find(t => t.id === id);
  md += `\n### 第 ${example.day} 天 · ${id}\n\n用户：${example.user || '应用触发主动分享，没有用户来信'}\n\n预先固定的观察目标：${example.expected}\n`;
  for (const arm of model.arms) {
    const t = arm.turns.find(t => t.id === id); if (!t) continue;
    md += `\n**${arm.name}** · ${t.status} · ${t.attempts.length} 次生成\n\n选择材料：${t.selectedIds.join('、') || '空'}\n\n${t.reply || t.errorCode || '没有候选内容，跳过主动发送。'}\n`;
    const repairs = t.receipt?.repairs || [], warnings = t.receipt?.behavior?.styleWarnings || [];
    if (repairs.length || warnings.length) md += `\n程序处理：${repairs.join('、') || '无'}；仍有风格警告：${warnings.join('、') || '无'}。\n`;
  }
}
md += '\n## 文件与复现\n\n- fixtures.mjs：模型调用前固定的材料、30 个交流节点、16 个检索测试。\n- retrieval.mjs：实验检索机制；没有接入生产。\n- run.mjs：实际模型实验；已有 results.json 时拒绝重复付费运行。\n- offline.mjs：免费重算长时间模拟与独立检索问题。\n- results.json：全部原始请求、模型草稿、最终回复、收据与用量，不含密钥。\n- production-review.md：隔离数据库中通过真实 HTTP 路由回放的独立结果。\n\n本实验不包含浏览器界面、TTS、真实定时唤醒、线上抓取或自动摘要质量认证。固定生活状态由模拟时钟推进，自动虚构新经历的长期入库尚未接入本实验。\n';
fs.writeFileSync(`${dir}TRANSCRIPTS${suffix}.md`, md);
console.log(JSON.stringify(concise, null, 2));
