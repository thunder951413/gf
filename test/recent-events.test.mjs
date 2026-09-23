import test from 'node:test';
import assert from 'node:assert/strict';
import { recentEventDigest, RECENT_EVENTS_BUDGET_CHARS } from '../lib/recent-events.mjs';

const now = new Date('2026-09-07T12:00:00Z');
const event = { id: 'trip', title: '丽江短途游', startedAt: '2026-09-04T12:00:00Z', phase: { title: '在丽江', location: '丽江', activity: '逛菜市场，尝了米线' }, phases: [{ activity: '明天抵达大理，尚未发生' }] };

test('already repeated experiences retain their identity without reintroducing all details; naming one restores detail',()=>{
  const thread={id:'collage',title:'用旧纸片拼一张小幅拼贴',history:[{deliveredAt:'2026-09-07T10:00:00Z',title:'装好相框',text:'我把旧纸片拼贴装进木相框，放在书架旁。'}]};
  const conversation=[{speaker:'assistant',text:'旧纸片做成拼贴了。'},{speaker:'user',text:'好看。'},{speaker:'assistant',text:'纸片拼贴已经装好。'}];
  const common=recentEventDigest({now,thread,conversation,userText:'你最近还有什么小事呀？'});
  assert.match(common,/近期已分享多次/);
  assert.doesNotMatch(common,/放在书架旁/);
  const explicit=recentEventDigest({now,thread,conversation,userText:'那张拼贴放在哪里了？'});
  assert.match(explicit,/放在书架旁/);
  assert.doesNotMatch(explicit,/近期已分享多次/);
});

test('current and historical life are concise, deduplicated and do not expose scheduled phases', () => {
  const result = recentEventDigest({ now, life: { active: event, recent: [event] } });
  assert.equal(result.split('丽江短途游').length - 1, 1);
  assert.match(result, /当前：在丽江.*尝了米线/);
  assert.doesNotMatch(result, /明天|大理/);
  assert.match(result, /不是用户的.*本轮状态和用户最新更正优先/s);
});

test('latest delivered project progress replaces old progress and keeps the negative', () => {
  const result = recentEventDigest({ now, thread: { id: 'design', title: '包装稿', beat: { text: '客户已批准第四稿' }, history: [
    { deliveredAt: '2026-09-06T01:00:00Z', title: '第三稿', text: '第三稿仍未获批，客户还在讨论。' },
    { deliveredAt: '2026-09-05T01:00:00Z', title: '第二稿', text: '第二稿已发出。' },
  ] } });
  assert.match(result, /第三稿仍未获批/);
  assert.doesNotMatch(result, /第二稿|第四稿|已批准/);
});

test('pending reading and story drafts are absent until actually shared', () => {
  assert.equal(recentEventDigest({ now, pursuit: { title: '百草园', stage: { action: '未读的新章节' }, history: [] }, thread: { title: '小样', beat: { text: '尚未分享' } } }), '');
  const result = recentEventDigest({ now, pursuit: { title: '百草园', stage: { action: '未读的新章节' }, history: [{ deliveredAt: '2026-09-06T01:00:00Z', label: '开头', action: '重读开头，注意到了草木的名字。' }] } });
  assert.match(result, /重读开头/);
  assert.doesNotMatch(result, /未读的新章节/);
});

test('a newer conversational experience replaces the older record of the same work', () => {
  const result = recentEventDigest({ now, pursuit: { completed: [{ title: '局外人', completedAt: '2026-09-01T01:00:00Z', lastAction: '那时觉得很轻松' }] }, experiences: [{ title: '《局外人》', createdAt: '2026-09-06T01:00:00Z', summary: '现在读来很压抑。' }] });
  assert.match(result, /很压抑/);
  assert.doesNotMatch(result, /很轻松/);
});

test('recent dates sort first; future, invalid and older than thirty days are excluded', () => {
  const result = recentEventDigest({ now, experiences: [
    ['旧书', '2026-07-01'], ['未来', '2026-10-01'], ['坏日期', 'bad'], ['昨天', '2026-09-06'], ['今天', '2026-09-07'],
  ].map(([title, createdAt]) => ({ title, createdAt, summary: '看过。' })) });
  assert.doesNotMatch(result, /旧书|未来｜|坏日期/);
  assert.ok(result.indexOf('今天｜') < result.indexOf('昨天｜'));
});

test('six entries and a fixed character budget bound even large input without clipping sentences', () => {
  const experiences = Array.from({ length: 100 }, (_, i) => ({ title: `作品${i}`, createdAt: '2026-09-07', summary: '很长的感悟'.repeat(90) + '，但是还没有读完。' }));
  const result = recentEventDigest({ now, experiences });
  assert.ok(result.length <= RECENT_EVENTS_BUDGET_CHARS);
  assert.equal(result.split('\n').length - 2, 6);
  assert.doesNotMatch(result, /很长的感悟/);
});

test('digest stays stable between events and changes when the recorded phase changes', () => {
  const a = recentEventDigest({ now, life: { active: event } });
  assert.equal(a, recentEventDigest({ now: new Date(+now + 60000), life: { active: event } }));
  const b = recentEventDigest({ now, life: { active: { ...event, phase: { title: '回苏州', activity: '已经回到家，整理照片' } } } });
  assert.match(b, /已经回到家/);
  assert.doesNotMatch(b, /逛菜市场/);
  assert.notEqual(a, b);
});

test('authoritative runtime suppresses a conflicting ordinary activity from current status', () => {
  const ordinary = {
    id: 'random-collage', type: 'ordinary', title: '家里做拼贴', startedAt: '2026-09-07T01:00:00Z',
    phase: { title: '剪贴', location: '苏州的家中地板上', activity: '按触感和颜色剪出拼贴纸片' },
  };
  const runtime = { current: { title: '处理上午的工作', location: '苏州的工作室', startedAt: '2026-09-07T01:00:00Z' }, world: { activity: '处理上午的工作', location: '苏州的工作室' } };
  const result = recentEventDigest({ now, life: { active: ordinary, recent: [ordinary] }, runtime });
  assert.equal(result, '');
  assert.doesNotMatch(result, /拼贴|正在发生|当前/);
});

test('runtime-confirmed matching activity may appear as current using authoritative wording', () => {
  const ordinary = { id: 'work', type: 'ordinary', title: '包装改稿', startedAt: '2026-09-07T01:00:00Z', phase: { location: '苏州工作室', activity: '调整包装字体' } };
  const runtime = { current: { title: '调整包装字体', location: '苏州工作室', startedAt: '2026-09-07T01:00:00Z' } };
  const result = recentEventDigest({ now, life: { active: ordinary }, runtime });
  assert.match(result, /当前（以持续生活安排为准）：苏州工作室，调整包装字体/);
});
