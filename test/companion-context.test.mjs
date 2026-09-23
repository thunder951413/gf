import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compactCompanionSystem, compactCompanionBackground, COMPANION_BACKGROUND_BUDGET_CHARS } from '../lib/companion-context.mjs';

const roles = JSON.parse(fs.readFileSync(new URL('../app-data/roles.json', import.meta.url), 'utf8'));
const miyue = (Array.isArray(roles) ? roles : roles.roles || Object.values(roles)).find((role) => role.id === 'miyue');

function fixture(overrides = {}) {
  return {
    now: new Date('2026-09-07T03:04:00Z'),
    character: {
      activity: '给一份包装稿调整字体层级',
      feeling: '改到第三版时有点疲惫',
      wish: '想先把手里的选择理清楚',
      interactions: 14,
      relationshipStage: '逐渐熟悉的朋友；关系承诺只来自双方明确约定',
    },
    inner: {
      feeling: '内心安稳温和，愿意认真听也愿意分享',
      wish: '想保持有来有回的陪伴',
      interactions: 14,
      relationshipStage: '逐渐熟悉的朋友；关系承诺只来自双方明确约定',
      intimacyBoundary: 'open',
    },
    life: {
      active: {
        id: 'life-1', type: 'ordinary', title: '包装改稿日',
        phase: { location: '苏州的家中', activity: '修改包装稿', feeling: '有点累', wish: '晚点休息' },
        facts: ['不应默认展开的生活事件事实'],
      },
    },
    thread: {
      title: '一册配色小样', status: 'active',
      beat: { title: '挑纸', text: '她正在比较两种纸张。', emotion: '认真又犹豫', need: '想听一个具体意见' },
      knownFacts: ['已经选了偏暖的底色', '用户建议保留留白'],
      choices: [{ id: 'matte', label: '选哑光纸' }],
      futureBeat: { text: '未来作者片段绝不能泄漏' },
    },
    ...overrides,
  };
}

test('companion system is a stable compact prefix without repeated legacy prompt payloads', () => {
  const first = compactCompanionSystem(miyue);
  const changedRuntimeFields = { ...miyue, systemPrompt: '巨量重复系统提示'.repeat(1000), replyExamples: [{ user: 'x', assistant: 'y' }] };
  const second = compactCompanionSystem(changedRuntimeFields);
  assert.equal(first, second);
  assert.ok(first.length >= 650 && first.length <= 1700, `system prefix length was ${first.length}`);
  assert.match(first, /身高165厘米，体重50公斤，罩杯B\+/);
  assert.match(first, /27岁.*成年虚构女性|成年虚构女性.*27岁/);
  assert.match(first, /苏州/);
  assert.match(first, /自由平面设计师/);
  assert.match(first, /父亲做电气维修，母亲做社区工作，父母住在同城/);
  assert.match(first, /没有预设.*共同前史/);
  assert.match(first, /可以回应用户明确邀请的温柔、撒娇或身体亲近/);
  assert.match(first, /亲近愿望影响你想怎样与他相处/);
  assert.doesNotMatch(first, /巨量重复系统提示/);
  assert.equal((first.match(/你是林晓薇/g) || []).length, 1);
});

test('body facts follow the durable profile without inventing an unconfigured bust circumference', () => {
  const updated = compactCompanionSystem({...miyue, profile: {...miyue.profile, weightKg: 51}});
  assert.match(updated, /体重51公斤/);
  assert.doesNotMatch(updated, /体重50公斤|胸围\d/);
  assert.doesNotMatch(compactCompanionSystem({...miyue, profile: {}}), /固定身材设定/);
});

test('background only carries current structured facts and keeps unrelated life project out', () => {
  const text = compactCompanionBackground(fixture());
  assert.match(text, /时间（上海时区）：2026\/09\/07 11:04/);
  assert.match(text, /地点：苏州的家中/);
  assert.match(text, /正在做：给一份包装稿调整字体层级/);
  assert.match(text, /显著感受 1：内心安稳温和/);
  assert.match(text, /显著感受 2：改到第三版时有点疲惫/);
  assert.match(text, /已记录互动 14 次/);
  assert.match(text, /可以自然回应温柔与亲近/);
  assert.doesNotMatch(text, /当前连续性|逐渐熟悉的朋友/);
  assert.doesNotMatch(text, /一册配色小样|已经选了偏暖的底色|未来作者片段/);
  assert.doesNotMatch(text, /不应默认展开的生活事件事实/);
  assert.doesNotMatch(text, /从网友开始认识|刚认识/);
});

test('non-narrative background keeps state facts but withholds unselected wishes as prose material', () => {
  const text = compactCompanionBackground(fixture({
    narrative: false,
    world: {
      at: '2026-09-07T03:04:00Z', location: '苏州的家中', activity: '给一份包装稿调整字体层级',
      person: { name: '林晓薇', age: 27 }, nextTransitionAt: '2026-09-07T04:00:00Z',
      body: { fatigue: 31, vitality: 66, affectionNeed: 92, desire: 88 },
      traits: { warmth: 90, coyness: 80, initiative: 70 },
      needs: { emotional: { due: true, status: '待表达' } },
    },
    episodicContext: '【原话】用户喜欢清淡一点的茶。',
    followupContext: '仅这一轮的跟进事项。',
    initiativeContext: '已选的主动线索。',
  }));
  assert.match(text, /人物：林晓薇，27岁/);
  assert.match(text, /地点：苏州的家中/);
  assert.match(text, /正在做：给一份包装稿调整字体层级/);
  assert.match(text, /疲劳31.*活力66/);
  assert.match(text, /温柔90.*撒娇倾向80/);
  assert.match(text, /已记录互动 14 次/);
  assert.doesNotMatch(text, /显著感受|想保持有来有回|想先把手里的选择理清楚/);
  assert.doesNotMatch(text, /下次状态检查时间|喜欢程度表示|可以自然回应温柔与亲近|更愿意分享和靠近|【此刻的具体愿望】|需求节奏|待表达/);
  assert.match(text, /【原话】用户喜欢清淡一点的茶/);
  assert.match(text, /仅这一轮的跟进事项|已选的主动线索/);
});

test('relationship uses real interactions and explicit intimacy boundary, not stale friend-stage labels', () => {
  const open = compactCompanionBackground(fixture({
    inner: {
      ...fixture().inner,
      interactions: 43,
      relationshipStage: '从网友开始认识',
      intimacyBoundary: 'open',
    },
  }));
  assert.match(open, /已记录互动 43 次/);
  assert.match(open, /可以自然回应温柔与亲近/);
  assert.doesNotMatch(open, /从网友开始认识|用户明确要求朋友距离/);

  const friendly = compactCompanionBackground(fixture({
    inner: { ...fixture().inner, intimacyBoundary: 'friendly' },
  }));
  assert.match(friendly, /按具体原话和有效期执行/);
  assert.doesNotMatch(friendly, /用户明确要求朋友距离|直到用户明确重新邀请/);
  assert.doesNotMatch(friendly, /可以自然回应温柔与亲近/);
});

test('relevant turn includes only whitelisted current thread data and selected known facts', () => {
  const text = compactCompanionBackground(fixture({ includeThread: true }));
  assert.match(text, /一册配色小样/);
  assert.match(text, /项目当前进展：挑纸。她正在比较两种纸张/);
  assert.match(text, /已经选了偏暖的底色/);
  assert.match(text, /用户建议保留留白/);
  assert.doesNotMatch(text, /选哑光纸/); // Choices remain in the UI unless explicitly requested.
  assert.doesNotMatch(text, /未来作者片段绝不能泄漏/);
  assert.match(text, /不得预告、推测或使用未来片段，也不得替用户选择。/);
});

test('paused thread exposes only delivered history and known facts', () => {
  const pausedThread = {
    ...fixture().thread,
    status: 'paused',
    history: [{ title: '第一次挑纸', text: '她已经分享过选择暖白纸的犹豫。' }],
  };
  const text = compactCompanionBackground(fixture({ includeThread: true, thread: pausedThread }));
  assert.match(text, /已经选了偏暖的底色|用户建议保留留白/);
  assert.match(text, /第一次挑纸.*她已经分享过选择暖白纸的犹豫/);
  assert.doesNotMatch(text, /项目当前进展|她正在比较两种纸张|可由用户明确选择|选哑光纸/);
  assert.match(text, /生活线暂停时只把已经分享的内容作为连续性，不把未发送片段当作当前经历。/);
});

test('thread guard is never cut into a partial sentence at the budget edge', () => {
  const oversized = {
    ...fixture().thread,
    beat: { ...fixture().thread.beat, text: '很长的当前片段。'.repeat(200) },
    knownFacts: Array.from({ length: 16 }, (_, index) => `事实${index}：${'很长'.repeat(100)}`),
  };
  const text = compactCompanionBackground(fixture({ includeThread: true, thread: oversized }));
  assert.match(text, /不得预告、推测或使用未来片段，也不得替用户选择。/);
  assert.doesNotMatch(text, /不得预告、推测或使用未来片段，也不得替用户选\n/);
  assert.ok(text.length <= COMPANION_BACKGROUND_BUDGET_CHARS);
});

test('evidence corrections and lead plan are preserved beyond the approximate background budget', () => {
  const correction = `旧说法需要作废。${'证据正文'.repeat(400)}最终更正：用户现在只喝青石茶，不再喝咖啡。`;
  const plan = `先直接回答，再解释依据。${'保持完整计划。'.repeat(220)}计划末尾：不要追问。`;
  const text = compactCompanionBackground(fixture({
    episodicContext: correction,
    planContext: plan,
    followupContext: '普通跟进'.repeat(600),
    initiativeContext: '普通主动线索'.repeat(600),
  }));
  assert.ok(text.includes(correction), 'episodic evidence must be byte-for-byte present');
  assert.ok(text.includes(plan), 'lead behavior plan must be byte-for-byte present');
  assert.doesNotMatch(text, /预算说明|token|主代理/);
  assert.match(text, /【本轮回复要求】/);
  const structured = text.slice(0, text.indexOf('【有出处的共同经历证据'));
  assert.ok(structured.length <= COMPANION_BACKGROUND_BUDGET_CHARS + 1, `structured background length was ${structured.length}`);
});

test('other roles retain their existing system prompt', () => {
  const other = { id: 'wenxi', name: '闻溪', systemPrompt: '闻溪的原始系统提示' };
  assert.equal(compactCompanionSystem(other), other.systemPrompt);
});
