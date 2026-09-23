import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTurnMemory } from '../lib/turn-memory.mjs';

const at = '2026-09-01T00:00:00.000Z';
const memory = (id, text, extra = {}) => ({ id, text, kind: 'raw', subject: 'user', sourceIds: [`s-${id}`], at, ...extra });

test('direct Chinese lexical evidence outweighs semantic expansion and unrelated topics', () => {
  const result = selectTurnMemory({
    query: '我喝咖啡喜欢加什么？', semanticQuery: '饮料 牛奶 茶',
    candidates: [memory('coffee', '用户喝咖啡时喜欢加燕麦奶。'), memory('tea', '用户喜欢桂花乌龙茶。'), memory('film', '用户周末看了科幻电影。')],
  });
  assert.equal(result.selected[0].id, 'coffee');
  assert.equal(result.selected[0].selectionReason, 'direct-match');
  assert.ok(result.selected[0].channels.direct > result.selected[0].channels.semantic);
  assert.ok(!result.selected.some(item => item.id === 'film'));
});

test('caller semantic paraphrase can recall an otherwise unmatched event with strong semantic metadata', () => {
  const result = selectTurnMemory({ query: '那次出门怎么样？', semanticQuery: '汕头 旅行 海边', candidates: [memory('trip', '用户曾去汕头海边散步。'), memory('work', '用户完成了季度报表。')] });
  assert.deepEqual(result.selected.map(item => item.id), ['trip']);
  assert.equal(result.selected[0].selectionReason, 'semantic-match');
  assert.equal(result.selected[0].lowConfidence, false);
  assert.equal(result.selected[0].text, '用户曾去汕头海边散步。');
});

test('corrected consolidated fact wins over obsolete raw evidence sharing a source', () => {
  const result = selectTurnMemory({ query: '我现在喜欢喝什么？', candidates: [
    memory('old', '用户喜欢红茶。', { sourceIds: ['drink-source'] }),
    memory('current', '用户现在喜欢黑咖啡。', { sourceIds: ['drink-source'], kind: 'consolidated', corrected: true, status: 'current' }),
  ] });
  assert.deepEqual(result.selected.map(item => item.id), ['current']);
  assert.deepEqual(result.rejected.find(item => item.id === 'old'), { id: 'old', reason: 'superseded-by:current' });
  assert.match(result.context, /有出处的结构化简记；较新原话优先/);
});

test('recent source evidence is represented without injection; approved manual memory is allowed', () => {
  const result = selectTurnMemory({ query: '不要催促的边界是什么？', recentSourceIds: ['s-recent'], candidates: [
    memory('recent', '用户不喜欢被催促。'),
    { id: 'forged', kind: 'episode', subject: 'user', text: '用户喜欢被催促。', sourceIds: [] },
    { id: 'manual', kind: 'manual', subject: 'user', text: '用户不喜欢被催促。', sourceIds: [], pinned: true },
  ] });
  assert.deepEqual(result.selected.map(item => item.id), ['manual']);
  assert.deepEqual(result.represented.map(item => item.id), ['recent']);
  assert.equal(result.represented[0].injected, false);
  assert.equal(result.represented[0].text, '用户不喜欢被催促。');
  assert.equal(result.stats.injectedItems, 1);
  assert.equal(result.rejected.find(item => item.id === 'forged').reason, 'no-evidence');
  assert.match(result.context, /用户批准的手工记忆/);
  assert.doesNotMatch(result.context, /条目:recent/);
});

test('all sources must be recent to represent an item; corrected mandatory wording is still injected', () => {
  const result = selectTurnMemory({ query: '回复边界', recentSourceIds: ['a'], candidates: [
    memory('partial', '用户的回复边界是不必立刻回复。', { sourceIds: ['a', 'b'] }),
    memory('corrected', '用户更正：不要催回复。', { sourceIds: ['a'], kind: 'consolidated', corrected: true, mandatory: true }),
  ] });
  assert.deepEqual(result.selected.map(item => item.id), ['corrected', 'partial']);
  assert.deepEqual(result.represented, []);
  assert.match(result.context, /用户更正：不要催回复/);
});

test('cancelled is a current factual status and supersedes the old plan for the same query', () => {
  const result = selectTurnMemory({ query: '杭州旅行计划', candidates: [
    memory('plan', '用户计划去杭州旅行。', { sourceIds: ['trip-source'] }),
    memory('cancelled', '用户已经取消杭州旅行。', { sourceIds: ['trip-source'], kind: 'consolidated', corrected: true, status: 'cancelled' }),
  ] });
  assert.deepEqual(result.selected.map(item => item.id), ['cancelled']);
  assert.equal(result.selected[0].status, 'cancelled');
});

test('a summary sharing one source cannot hide a different raw fact that answers the query', () => {
  const result = selectTurnMemory({ query: '那家面馆叫什么？', candidates: [
    memory('trip-summary', '用户已经取消杭州旅行。', { sourceIds: ['mixed-source'], kind: 'consolidated', corrected: true, status: 'cancelled' }),
    memory('raw-detail', '用户说杭州那家面馆叫春风面馆。', { sourceIds: ['mixed-source'] }),
  ] });
  assert.deepEqual(result.selected.map(item => item.id), ['raw-detail']);
});

test('mechanical date context survives selection and formatting with attribution', () => {
  const result = selectTurnMemory({ query: '汕头什么时候', candidates: [memory('dated', '用户原话：明天去汕头。', {
    dateContext: ['原话中的“明天”对应 2026-09-13（星期日）'], status: 'current',
  })] });
  assert.deepEqual(result.selected[0].dateContext, ['原话中的“明天”对应 2026-09-13（星期日）']);
  assert.equal(result.selected[0].speaker, 'user');
  assert.match(result.context, /机械日期定位[\s\S]*2026-09-13/);
});

test('generic new-update language does not recall a large irrelevant corpus', () => {
  const candidates = Array.from({ length: 40 }, (_, index) => memory(`noise-${index}`, `我今天更新了一下普通记录 ${index}。`));
  const result = selectTurnMemory({ query: '我今天有个新更新', semanticQuery: '最近 更新 情况', candidates });
  assert.deepEqual(result.selected, []);
});

test('mandatory boundaries remain whole and expose budget overflow', () => {
  const text = `用户明确要求：${'不要催促。'.repeat(20)}`;
  const result = selectTurnMemory({ query: '随便聊聊', budgetChars: 40, maxItems: 0, candidates: [memory('boundary', text, { mandatory: true, status: 'current' })] });
  assert.equal(result.selected.length, 1);
  assert.equal(result.selected[0].selectionReason, 'mandatory');
  assert.match(result.context, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(result.stats.mandatoryOverflow, true);
  assert.ok(result.stats.overflowChars > 0);
});

test('whole evidence blocks obey budget and carry speaker, time, and source attribution', () => {
  const first = memory('one', '用户的项目代号是 Blue Harbor 蓝港。');
  const second = memory('two', '用户的另一个项目代号是 Green Field 绿野。');
  const probe = selectTurnMemory({ query: 'Blue Harbor 项目', candidates: [first] });
  const result = selectTurnMemory({ query: '项目代号 Blue Harbor Green Field', budgetChars: probe.stats.chars + 5, candidates: [first, second] });
  assert.equal(result.selected.length, 1);
  assert.match(result.context, /主体:用户/);
  assert.match(result.context, /时间:2026-09-01T00:00:00.000Z/);
  assert.match(result.context, /来源:s-(one|two)/);
  assert.match(result.context, /【内容开始】[\s\S]+【内容结束】/);
  assert.equal(result.rejected.some(item => item.reason === 'budget'), true);
});

test('temporal hints rank similar events by bounded recency but cannot retrieve by time alone', () => {
  const result = selectTurnMemory({ query: '最近那次露营', now: '2026-09-16T00:00:00Z', candidates: [
    memory('old', '用户去崇明露营。', { at: '2025-01-01T00:00:00Z' }),
    memory('new', '用户去安吉露营。', { at: '2026-09-14T00:00:00Z' }),
    memory('noise', '用户最近心情一般。', { at: '2026-09-15T00:00:00Z' }),
  ] });
  assert.equal(result.selected[0].id, 'new');
  assert.ok(result.selected.some(item => item.id === 'old'));
  assert.ok(!result.selected.some(item => item.id === 'noise'));
});

test('validated semantic IDs select evidence without word overlap and ignore unknown IDs', () => {
  const result = selectTurnMemory({
    query: '那件事后来呢？', semanticIds: ['trip', 'does-not-exist'],
    candidates: [memory('trip', '用户曾在汕头海边散步。'), memory('work', '用户完成季度报表。')],
  });
  assert.deepEqual(result.selected.map(item => item.id), ['trip']);
  assert.equal(result.selected[0].selectionReason, 'semantic-evidence');
  assert.equal(result.selected[0].channels.semanticEvidence, 1);
  assert.equal(result.selected[0].lowConfidence, false);
  assert.doesNotMatch(result.context, /does-not-exist/);
});

test('semantic evidence ranks ahead of a weak direct hit without suppressing useful direct evidence', () => {
  const result = selectTurnMemory({
    query: '旅行', semanticIds: ['semantic-trip'],
    candidates: [memory('weak-direct', '用户提到过一次旅行。'), memory('semantic-trip', '用户曾在青岛看海。')],
  });
  assert.deepEqual(result.selected.map(item => item.id), ['semantic-trip', 'weak-direct']);
  assert.equal(result.selected[0].selectionReason, 'semantic-evidence');
  assert.equal(result.selected[1].selectionReason, 'direct-match');
});

test('semantic evidence prefers corrected same-source state and still injects the correction', () => {
  const result = selectTurnMemory({
    query: '后来怎样？', semanticIds: ['old'], recentSourceIds: ['shared-source'],
    candidates: [
      memory('old', '用户计划去杭州。', { sourceIds: ['shared-source'] }),
      memory('current', '用户后来取消杭州行程。', { sourceIds: ['shared-source'], kind: 'consolidated', corrected: true, status: 'cancelled' }),
    ],
  });
  assert.deepEqual(result.selected.map(item => item.id), ['current']);
  assert.deepEqual(result.represented, []);
  assert.equal(result.selected[0].selectionReason, 'semantic-evidence');
});

test('semantic evidence obeys whole-item budget while mandatory evidence is preserved', () => {
  const semantic = memory('semantic', `用户去过海边。${'完整细节。'.repeat(40)}`);
  const boundary = memory('boundary-budget', '用户不希望被催促。', { mandatory: true });
  const result = selectTurnMemory({ query: '后来呢', semanticIds: ['semantic'], budgetChars: 120, candidates: [semantic, boundary] });
  assert.deepEqual(result.selected.map(item => item.id), ['boundary-budget']);
  assert.equal(result.rejected.find(item => item.id === 'semantic').reason, 'budget');
  assert.doesNotMatch(result.context, /用户去过海边/);
});

test('generic function-word direct hits do not react, while explicit multiword evidence remains', () => {
  const generic = selectTurnMemory({ query: '那个地方最后怎么样？', candidates: [memory('noise-place', '用户当时去了一个地方，最后回来了。')] });
  assert.deepEqual(generic.selected, []);
  const explicit = selectTurnMemory({ query: '汕头海边散步怎么样？', candidates: [memory('trip-direct', '用户在汕头海边散步。')] });
  assert.deepEqual(explicit.selected.map(item => item.id), ['trip-direct']);
  assert.equal(explicit.selected[0].selectionReason, 'direct-match');
});

test('omitting semantic IDs preserves prior retrieval and adds the global evidence rule', () => {
  const lexical = selectTurnMemory({ query: '桂花乌龙茶', candidates: [memory('tea-default', '用户喜欢桂花乌龙茶。')] });
  assert.deepEqual(lexical.selected.map(item => item.id), ['tea-default']);
  assert.equal(lexical.selected[0].channels.semanticEvidence, 0);
  assert.match(lexical.context, /按说话人和时间解释，不补未记录细节，最新状态优先/);
});

test('a current-history focus can reject lexical-only older memory while retaining selected and mandatory evidence', () => {
  const result = selectTurnMemory({
    query: '这话不是你跟我说的么', requireSelectedEvidence: true, semanticIds: ['selected'],
    candidates: [
      memory('ambient-one', '用户最近健身时说过这话。'),
      memory('ambient-two', '用户睡觉前也说过类似的话。'),
      memory('selected', '用户明确要回顾上次讨论的那句话。'),
      memory('boundary', '用户不希望被催促回复。', { mandatory: true }),
    ],
  });
  assert.deepEqual(result.selected.map(item => item.id), ['boundary', 'selected']);
  assert.deepEqual(result.rejected.filter(item => item.reason === 'current-focus-no-extra-memory').map(item => item.id), ['ambient-one', 'ambient-two']);
  assert.doesNotMatch(result.context, /健身|睡觉/);
});

test('an empty current-focus selection does not turn a lexical echo into older-memory context', () => {
  const candidates = [memory('echo', '用户曾说这个观点很有道理。')];
  const baseline = selectTurnMemory({ query: '这个观点确实很有道理', candidates });
  const focused = selectTurnMemory({ query: '这个观点确实很有道理', candidates, requireSelectedEvidence: true });
  assert.deepEqual(baseline.selected.map(item => item.id), ['echo']);
  assert.deepEqual(focused.selected, []);
  assert.deepEqual(focused.rejected, [{ id: 'echo', reason: 'current-focus-no-extra-memory' }]);
});

test('an explicit empty semantic review filters reviewed lexical noise only', () => {
  const result = selectTurnMemory({
    query: '旅行怎么样', semanticIds: [], semanticReviewedIds: ['reviewed'],
    candidates: [memory('reviewed', '用户提到过旅行。'), memory('unreviewed', '用户喜欢旅行摄影。')],
  });
  assert.deepEqual(result.selected.map(item => item.id), ['unreviewed']);
  assert.deepEqual(result.rejected.find(item => item.id === 'reviewed'), { id: 'reviewed', reason: 'semantic-unrelated' });
});

test('semantic review rejection never removes mandatory evidence', () => {
  const result = selectTurnMemory({
    query: '无关问题', semanticReviewedIds: ['boundary-reviewed'],
    candidates: [memory('boundary-reviewed', '用户不希望被催促回复。', { mandatory: true })],
  });
  assert.deepEqual(result.selected.map(item => item.id), ['boundary-reviewed']);
  assert.equal(result.selected[0].selectionReason, 'mandatory');
});

test('positive same-source selection preserves its corrected canonical target through review', () => {
  const result = selectTurnMemory({
    query: '杭州行程后来怎样', semanticIds: ['old-reviewed'], semanticReviewedIds: ['old-reviewed', 'current-reviewed'],
    candidates: [
      memory('old-reviewed', '用户计划去杭州。', { sourceIds: ['review-source'] }),
      memory('current-reviewed', '用户已取消杭州行程。', { sourceIds: ['review-source'], kind: 'consolidated', corrected: true, status: 'cancelled' }),
    ],
  });
  assert.deepEqual(result.selected.map(item => item.id), ['current-reviewed']);
  assert.equal(result.selected[0].selectionReason, 'semantic-evidence');
  assert.ok(!result.rejected.some(item => item.id === 'current-reviewed'));
});

test('same-source unrelated reviewed summary cannot steal a granular semantic selection', () => {
  const result = selectTurnMemory({
    query: '那件安排后来呢', semanticIds: ['raw-two-facts'], semanticReviewedIds: ['raw-two-facts', 'coffee-summary'],
    candidates: [
      memory('raw-two-facts', '用户说周四搬家，还提到自己喜欢黑咖啡。', { sourceIds: ['two-fact-source'] }),
      memory('coffee-summary', '用户喜欢黑咖啡。', { sourceIds: ['two-fact-source'], kind: 'consolidated', corrected: true, status: 'current', topic: '咖啡偏好' }),
    ],
  });
  assert.deepEqual(result.selected.map(item => item.id), ['raw-two-facts']);
  assert.equal(result.selected[0].selectionReason, 'semantic-evidence');
  assert.deepEqual(result.rejected.find(item => item.id === 'coffee-summary'), { id: 'coffee-summary', reason: 'semantic-unrelated' });
  assert.match(result.context, /周四搬家/);
});
