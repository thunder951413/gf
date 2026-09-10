// Metadata is quoted user-level material, never promoted into persona instructions.
export function researchContext(research, count = 5, chars = 600) {
  if (!research || research.kind !== 'zhihu_research') return '';
  return `资料性质：${research.generatedBy ? 'AI整理' : '原回答摘录'}，未独立核验，不代表知乎社区共识。整理时间：${research.generatedAt || '未知'}，此时间不是新闻发生时间。\n话题来源：${String(research.discovery?.source || '').slice(0, 200)}\n可核对的原回答：\n${(research.references || []).slice(0, count).map((ref, i) => `[${i + 1}] 作者：${String(ref.author || '未提供').slice(0, 200)}；标题：${String(ref.title || '').slice(0, 300)}；链接：${String(ref.url || '').slice(0, 2000)}；更新于：${ref.publishedAt || '未知'}\n摘录：${String(ref.summary || '').slice(0, chars)}`).join('\n')}`;
}
