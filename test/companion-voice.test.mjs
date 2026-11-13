import test from 'node:test';
import assert from 'node:assert/strict';
import { lengthBudget, pushesAway, repeatsRecent, recurringHabits, voiceProfile, CHAT_VOICE, singleMessage } from '../lib/companion-voice.mjs';
import { tightenSessionReply } from '../lib/session-guidance.mjs';
import { tuningPreview, tuningBand } from '../lib/companion-tuning.mjs';

test('short teasing questions stay on the chat budget; a real question or explicit follow-up opens generous room', () => {
  assert.equal(lengthBudget({ verbosity: 50 }, { userText: '为啥会这样啊' }).detail, false);
  assert.equal(lengthBudget({ verbosity: 50 }, { userText: '那你会怎样呀' }).detail, false);
  assert.equal(lengthBudget({ verbosity: 50 }, { userText: '你给我讲讲为什么会这样' }).detail, true);
  assert.equal(lengthBudget({ verbosity: 50 }, { userText: '展开说说' }).detail, true);
  assert.ok(lengthBudget({ verbosity: 50 }, { userText: '哪句诗呀' }).target >= 55);
  assert.ok(lengthBudget({ verbosity: 50 }, { userText: '为啥' }).hard < 70);
});

test('push-away phrases and cross-turn reuse are detected deterministically', () => {
  assert.equal(pushesAway('等你有空再聊这个，我这边也接着忙'), true);
  assert.equal(pushesAway('你那边下午撑住啊，不打扰你'), true);
  assert.equal(pushesAway('去吧～ 加油'), false);
  assert.deepEqual(repeatsRecent('那就赖着呗，谁先动谁是小狗', ['这句话我记着了，谁先动谁是小狗。'], ''), { kind: 'phrase', fragment: '谁先动谁是小' });
  assert.deepEqual(repeatsRecent('是你的宝贝，行了吧😏', ['快回来，别让我对着碗干等😏'], ''), { kind: 'emoji', fragment: '😏' });
  // Quoting the user's own words is not self-repetition, and short overlaps are normal.
  assert.equal(repeatsRecent('炸鸡配咖喱酱，这吃法头回听说', ['炸鸡配咖喱酱？'], '炸鸡配咖喱酱蘸着吃'), null);
  assert.equal(repeatsRecent('那我也不动', ['那我也先不动了，搂着你'], ''), null);
});

test('the voice profile tells her not to fold under pushback and not to narrate the two layers of a shared scene', () => {
  assert.match(CHAT_VOICE, /不用马上认错/u);
  assert.match(CHAT_VOICE, /不解释“这是想象”/u);
  assert.match(CHAT_VOICE, /少说“我这边”/u);
  assert.doesNotMatch(voiceProfile({ independence: 100 }), /忙的时候会说晚点聊/u);
});

test('tighten rewrites a proactive message that hands the chat back, and keeps the original when the rewrite still does', async () => {
  const messages = [{ role: 'system', content: 'persona' }, { role: 'assistant', content: '昨天那家店不错' }, { role: 'system', content: '【当前轮次】' }];
  const raw = JSON.stringify({ skip: false, message: '稿子改到第三版了，你那边撑住啊，不打扰你', reason: 'r', contentId: null });
  const budget = lengthBudget({ verbosity: 50 }, { proactive: true });
  const calls = [];
  const rewritten = await tightenSessionReply({ model: { complete: async input => { calls.push(input.at(-1).content); return JSON.stringify({ skip: false, message: '刚把第三版改完，眼睛都花了，你下午怎么样', reason: 'r', contentId: null }); } }, messages, raw, budget, field: 'message' });
  assert.equal(rewritten.tightened, true); assert.equal(rewritten.reason, 'push-away'); assert.match(calls[0], /别把话送走/u);
  const kept = await tightenSessionReply({ model: { complete: async () => JSON.stringify({ skip: false, message: '你先忙吧，晚点聊', reason: 'r', contentId: null }) }, messages, raw, budget, field: 'message' });
  assert.equal(kept.tightened, false); assert.equal(kept.code, 'STILL_PUSHING'); assert.equal(kept.raw, raw);
  // Ordinary replies are not checked for push-away: the user may have said goodbye.
  const reply = await tightenSessionReply({ model: { complete: async () => { throw new Error('should not be called'); } }, messages: [...messages, { role: 'user', content: '我去忙了' }], raw: JSON.stringify({ reply: '去吧，你先忙' }), budget: lengthBudget({ verbosity: 50 }, { userText: '我去忙了' }) });
  assert.equal(reply.tightened, false);
});

test('tuning preview reports the same three bands the voice profile uses', () => {
  assert.equal(tuningBand(66), 'mid'); assert.equal(tuningBand(67), 'high'); assert.equal(tuningBand(33), 'low');
  const preview = tuningPreview({ pleasing: 60, warmth: 100, sensitivity: 60, optimism: 100, playfulness: 100, coyness: 100, flirtation: 100, initiative: 100, verbosity: 50, independence: 100 });
  assert.match(preview.notes[0], /三档/u); assert.match(preview.notes[0], /独立性高/u);
  assert.ok(preview.notes.some(note => /互相拉扯/u.test(note)));
  assert.ok(!preview.notes.some(note => /主动亲昵至少间隔/u.test(note)));
  assert.equal(voiceProfile({ warmth: 70 }), voiceProfile({ warmth: 100 }));
});

test('one reply is one message', () => {
  assert.equal(singleMessage('嗯\n那就火锅'), '嗯 那就火锅');
});

test('care and work-report habits are flagged only when they recur and he did not bring them up', () => {
  const recent = ['又拿咖啡当早饭啊，中午那顿可得吃够', '哈哈哈对', '嗯嗯'];
  assert.deepEqual(recurringHabits('你那边也多点热乎的吃～', recent, '汤真好喝').map(h => h.kind), ['care']);
  assert.deepEqual(recurringHabits('你那边也多点热乎的吃～', ['哈哈', '嗯', '好呀', '对呀'], '汤真好喝'), []);
  assert.deepEqual(recurringHabits('泡面也挺好，凉了就坨了', recent, '刚泡好面准备吃午饭'), []);
  // Work reports look back 3 replies (2 needed), care looks back 4 (1 needed).
  assert.deepEqual(recurringHabits('可别看太晚，我配色还没选定呢。', ['我这边配色还没定下来', '早点睡', '配色我打算先放着'], '床尾就是电视').map(h => h.kind).sort(), ['care', 'self-work']);
});

test('tighten removes a recurring habit once and keeps the draft when the rewrite still has it', async () => {
  const messages = [{ role: 'system', content: 'persona' }, { role: 'assistant', content: '我这边配色还没定下来' }, { role: 'user', content: '慢慢来' }, { role: 'assistant', content: '配色我先放着' }, { role: 'system', content: '【当前轮次】' }, { role: 'user', content: '床尾就是电视' }];
  const raw = JSON.stringify({ reply: '那也太爽了，我配色还没选定呢。' });
  const budget = lengthBudget({ verbosity: 50 }, { userText: '床尾就是电视' });
  const seen = [];
  const fixed = await tightenSessionReply({ model: { complete: async input => { seen.push(input.at(-1).content); return JSON.stringify({ reply: '那也太爽了，躺着就能看。' }); } }, messages, raw, budget });
  assert.equal(fixed.tightened, true); assert.equal(fixed.reason, 'habit-self-work'); assert.match(seen[0], /例行公事/u);
  const kept = await tightenSessionReply({ model: { complete: async () => JSON.stringify({ reply: '配色还是没定' }) }, messages, raw, budget });
  assert.equal(kept.code, 'STILL_HABIT'); assert.equal(kept.raw, raw);
});

test('the voice keeps uncertain real-world facts honest and her own recent words above program state', () => {
  assert.match(CHAT_VOICE, /拿不准就直说记不清/u);
  assert.match(CHAT_VOICE, /优先于程序给的穿着和日程/u);
});

test('a high-volume feed does not dominate proactive candidates and long summaries do not buy interest matches', async () => {
  const { proactiveInternals } = await import('../lib/proactive.mjs');
  const now = new Date('2026-10-19T03:00:00Z'), at = new Date('2026-10-18T03:00:00Z').toISOString();
  const games = Array.from({ length: 30 }, (_, i) => ({ id: `g${i}`, title: `新游戏${i}上线`, summary: '这是一款游戏。'.repeat(60) + '讲述了文化和科技。', source: 'gcores', category: '游戏', publishedAt: at, url: `https://g/${i}` }));
  const news = Array.from({ length: 5 }, (_, i) => ({ id: `n${i}`, title: `时事要闻${i}`, summary: '国际新闻一则，涉及多国科技政策的最新进展和讨论。', source: 'bbc', category: '时事', publishedAt: at, url: `https://n/${i}` }));
  let seed = 3; const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  let gameShare = 0, total = 0;
  for (let i = 0; i < 500; i++) for (const c of proactiveInternals.qualityCandidates([...games, ...news], { topics: '时事,科技,文化' }, now, random).slice(0, 3)) { total++; if (c.source === 'gcores') gameShare++; }
  // 30 of 35 items are games. Before balancing (and with the interest word found
  // deep in their long summaries) they took about 85% of the top three; now the
  // two sources carry roughly equal total weight.
  assert.ok(gameShare / total < 0.6, `games ${gameShare / total}`);
});

test('the per-feed weight from feeds.json raises that source share; item volume does not', async () => {
  const { proactiveInternals } = await import('../lib/proactive.mjs');
  const now = new Date('2026-10-19T03:00:00Z'), at = new Date('2026-10-18T03:00:00Z').toISOString();
  const make = (source, n, feedWeight) => Array.from({ length: n }, (_, i) => ({ id: `${source}${i}`, title: `${source} 条目 ${i}`, summary: '一段足够长的摘要内容，用来进入候选池，没有兴趣词。', source, category: '综合', publishedAt: at, url: `https://${source}/${i}`, feedWeight }));
  const share = (items, source) => { let seed = 5, hit = 0, total = 0; const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let i = 0; i < 800; i++) { const first = proactiveInternals.qualityCandidates(items, { topics: '' }, now, random)[0]; total++; if (first.source === source) hit++; } return hit / total; };
  const equal = share([...make('a', 40, 1), ...make('b', 4, 1)], 'b');
  assert.ok(equal > 0.4 && equal < 0.6, `volume-independent ${equal}`);
  assert.ok(share([...make('a', 10, 1), ...make('news', 10, 2)], 'news') > 0.6);
});

test('a reply given as an array of bubbles is stored as one message, not as bracketed JSON', async () => {
  const { parseEmotionEnvelope } = await import('../lib/emotion-dialogue.mjs');
  assert.equal(parseEmotionEnvelope('["好呢", "那我先找部剧看，饭好了记得说一声"]', '').reply, '好呢 那我先找部剧看，饭好了记得说一声');
  assert.equal(parseEmotionEnvelope('{"reply":["嗯","知道啦。","晚点说"]}', '').reply, '嗯 知道啦。晚点说');
  assert.equal(parseEmotionEnvelope('[笑] 好呀', '').reply, '[笑] 好呀');
});

test('the current life-thread step is offered as proactive material', async () => {
  const { proactiveMaterialSlate } = await import('../lib/proactive-materials.mjs');
  const slate = proactiveMaterialSlate({ thread: { pendingKey: 'thread:1:beat:0', title: '用旧纸片拼一张小幅拼贴', beat: { text: '翻出一盒旧票根和包装纸。', emotion: '期待' }, knownFacts: ['不用于工作'] } });
  assert.equal(slate.length, 1); assert.equal(slate[0].kind, 'life_thread'); assert.equal(slate[0].id, 'thread:1:beat:0');
  assert.equal(proactiveMaterialSlate({ thread: { pendingKey: null } }).length, 0);
});

test('an unprompted message already counts one earlier work report as a habit', () => {
  const recent = ['下午弄稿子弄到现在', '嗯嗯', '好呀'];
  assert.deepEqual(recurringHabits('配色总算改到最后一版', recent, ''), []);
  assert.deepEqual(recurringHabits('配色总算改到最后一版', recent, '', { strict: true }).map(h => h.kind), ['self-work']);
});
