import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { isHollowReply, lengthBudget, CHAT_VOICE } from '../lib/companion-voice.mjs';
import { tightenSessionReply, prepareSessionGuidance } from '../lib/session-guidance.mjs';
import { CompanionDynamics } from '../lib/companion-dynamics.mjs';
import { CharacterGrowth } from '../lib/character-growth.mjs';
import { sourcesToExpand, alternateMaterials } from '../lib/session-context.mjs';
import { PROACTIVE_MATERIAL_INSTRUCTION } from '../lib/proactive-materials.mjs';

class TestStore {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec('CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,role TEXT,speaker TEXT,text TEXT,hidden INTEGER DEFAULT 0)'); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const out = fn(); this.db.exec('COMMIT'); return out; } catch (err) { this.db.exec('ROLLBACK'); throw err; } }
  getMessage(id) { return this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) || null; }
  add(id, speaker, text) { this.db.prepare('INSERT INTO messages(id,role,speaker,text) VALUES(?,?,?,?)').run(id, 'miyue', speaker, text); return this.getMessage(id); }
}

test('a short reply of only agreement, care or goodbye words is hollow unless he is wrapping up', () => {
  assert.equal(isHollowReply('嗯嗯 那你也早点睡哦', '今天开会开到七点'), true);
  assert.equal(isHollowReply('好呀～', '周末去看展吧'), true);
  assert.equal(isHollowReply('嗯 到了说一声', '好的呢～'), true);
  assert.equal(isHollowReply('哈哈哈哈 是啊', '这猫也太胖了'), true);
  // He is ending the chat: a short goodbye is the right reply.
  assert.equal(isHollowReply('去吧～', '好呢，去吧去吧'), false);
  assert.equal(isHollowReply('晚安～', '困了 晚安'), false);
  assert.equal(isHollowReply('去吧，你先忙', '我去忙了'), false);
  // Anything of her own makes it a real reply.
  assert.equal(isHollowReply('好呀 看什么展', '周末去看展吧'), false);
  assert.equal(isHollowReply('早呀阿闫，睡醒啦？', '早上好呀'), false);
  assert.equal(isHollowReply('哟 蝶泳也会？那是真厉害', '都会呢 厉害吧'), false);
  assert.equal(isHollowReply('好的'.repeat(14), '你看'), false, 'long replies are left to the length check');
});

test('tighten adds one thing of her own to a hollow reply, and leaves goodbyes alone', async () => {
  const messages = [{ role: 'system', content: 'persona' }, { role: 'system', content: '【当前轮次】' }, { role: 'user', content: '今天被老板夸了' }];
  const budget = lengthBudget({ verbosity: 50 }, { userText: '今天被老板夸了' });
  const raw = JSON.stringify({ reply: '好呀～' });
  const seen = [];
  const fixed = await tightenSessionReply({ model: { complete: async input => { seen.push(input.at(-1).content); return JSON.stringify({ reply: '好呀～ 夸你啥了' }); } }, messages, raw, budget });
  assert.equal(fixed.tightened, true); assert.equal(fixed.reason, 'hollow'); assert.match(seen[0], /别只附和/u);
  const still = await tightenSessionReply({ model: { complete: async () => JSON.stringify({ reply: '嗯嗯' }) }, messages, raw, budget });
  assert.equal(still.code, 'STILL_HOLLOW'); assert.equal(still.raw, raw);
  const speech = await tightenSessionReply({ model: { complete: async () => JSON.stringify({ reply: `好呀～${'他夸你哪儿了'.repeat(12)}` }) }, messages, raw, budget });
  assert.equal(speech.code, 'HOLLOW_REWRITE_TOO_LONG'); assert.equal(speech.raw, raw);
  const night = [...messages.slice(0, -1), { role: 'user', content: '困了 晚安' }];
  const kept = await tightenSessionReply({ model: { complete: async () => { throw new Error('should not be called'); } }, messages: night, raw: JSON.stringify({ reply: '晚安～' }), budget });
  assert.equal(kept.tightened, false); assert.equal(kept.code, undefined);
});

test('the final reviewer treats a hollow draft as needing one line of her own', async () => {
  let prompt = '';
  await prepareSessionGuidance({ model: { complete: async messages => { prompt = messages.map(m => m.content).join('\n'); return JSON.stringify({ guidance: [], ready: true, revision: null, needsReasoning: false }); } },
    messages: [{ role: 'system', content: 'persona' }, { role: 'user', content: '今天被夸了' }], draft: JSON.stringify({ reply: '好呀' }), finalize: true });
  assert.match(prompt, /唯一的内容例外/u); assert.match(prompt, /1\.5倍/u); assert.match(prompt, /道别/u);
});

test('the voice asks her to dig into his topic first and keep news from crowding out her own life', () => {
  assert.match(CHAT_VOICE, /先往深里接/u);
  assert.match(CHAT_VOICE, /只回一两个字时再带出来/u);
  assert.match(PROACTIVE_MATERIAL_INSTRUCTION, /一半一半/u);
  assert.match(PROACTIVE_MATERIAL_INSTRUCTION, /不连续两条都是资讯/u);
});

test('companion dynamics older than a week leave only the expression preference', () => {
  let now = new Date('2026-09-20T00:00:00Z');
  const store = new TestStore(), repo = new CompanionDynamics(store, { clock: () => now });
  const rows = [store.add('u1', 'user', '想让你先说'), store.add('a1', 'assistant', '我想你了，这个话题我们聊完了。')];
  repo.commit('miyue', { dynamics: { feelings: [{ id: 'miss', label: '想念', intensity: 90, description: '很想他', cause: '用户让她先开口', evidence: '我想你了' }],
    threads: [{ id: 'done', subject: '聊完的话题', progress: '聊完了', openQuestion: '', status: 'resolved', evidence: '聊完了' }, { id: 'open', subject: '还没说完的事', progress: '刚开头', openQuestion: '后面怎么说', status: 'open', evidence: '想让你先说' }] } }, { rows, expectedRevision: 0 });
  now = new Date('2026-09-21T00:00:00Z');
  let context = repo.context();
  assert.match(context, /想念/); assert.match(context, /还没说完的事/); assert.doesNotMatch(context, /聊完的话题/);
  now = new Date('2026-09-24T01:00:00Z');
  context = repo.context();
  assert.doesNotMatch(context, /想念/, 'feelings older than three days are not cues'); assert.match(context, /还没说完的事/);
  now = new Date('2026-09-28T00:00:01Z');
  context = repo.context();
  assert.doesNotMatch(context, /伴侣动态数据|还没说完的事|想念/); assert.match(context, /【表达偏好】热恋时可以自然/);
  assert.equal(repo.context('miyue', { includeExpression: false }), '', 'the session block carries the preference itself');
});

test('growth context skips habits and food or care notes and rotates two items by day', () => {
  let now = new Date('2026-10-20T04:00:00Z');
  const growth = new CharacterGrowth(new TestStore(), { clock: () => now, enabled: false });
  const item = (id, kind, text) => ({ id, kind, text, scope: 'enduring', tier: 'stable', at: '2026-10-01T00:00:00Z' });
  const items = [item('interest-soup', 'interest', '天一凉就惦记热粥热汤，粥配小炒、煎个蛋'), item('habit-colors', 'habit', '配色往回调好几遍'),
    item('view-a', 'view', '老招牌比新招牌耐看'), item('view-b', 'view', '独居不等于可怜'), item('view-c', 'view', '留白比塞满难'),
    item('interest-d', 'interest', '爱听人讲细碎场面，比如挑担卖糖粥的木桶冒白气'), { ...item('view-e', 'view', '一次场景'), tier: 'emerging' }];
  growth.get = () => ({ items });
  const shown = () => JSON.parse(growth.context().split('\n')[1]).items.map(entry => entry.id);
  const today = shown();
  assert.equal(today.length, 2);
  assert.ok(today.every(id => ['view-a', 'view-b', 'view-c', 'interest-d'].includes(id)), today.join());
  assert.deepEqual(shown(), today, 'the same day keeps the same items');
  const seen = new Set(today);
  for (let day = 1; day < 4; day++) { now = new Date(Date.parse('2026-10-20T04:00:00Z') + day * 86400000); shown().forEach(id => seen.add(id)); }
  assert.equal(seen.size, 4, 'every eligible item comes round');
});

test('shared source details are attached only when he names or points back at them', () => {
  const items = [{ title: '《异界宿帐》确认参加Steam新品节', url: 'https://example.org/a', at: '2026-10-20T05:00:00Z', summary: '和风温泉旅馆题材的恐怖模拟游戏' },
    { title: '《艾尔塔：逆神》免费试玩版现已加入 Steam 新品节', url: 'https://example.org/b', at: '2026-10-20T08:00:00Z', summary: '高能动作平台游戏' }];
  const body = { body: item => item.summary };
  assert.equal(sourcesToExpand('你今天干嘛了', items, body).size, 0);
  assert.equal(sourcesToExpand('好呀', items, body).size, 0);
  assert.deepEqual([...sourcesToExpand('异界宿帐好玩吗', items, body)], [items[0]]);
  assert.deepEqual([...sourcesToExpand('你说的那个温泉旅馆的游戏是啥样', items, body)], [items[0]]);
  assert.deepEqual([...sourcesToExpand('那篇讲的啥', items, body)], [items[1]], 'a bare pointer means the latest');
  assert.deepEqual([...sourcesToExpand('看看 https://example.org/b', items, body)], [items[1]]);
});

test('right after a news share, an own-life step on offer holds news back for one run', () => {
  const materials = [{ kind: 'daily_info', id: 'd' }, { kind: 'life_thread', id: 't' }, { kind: 'article', id: 'a' }, { kind: 'discussion', id: 'q' }];
  assert.deepEqual(alternateMaterials(materials, [{ kind: 'article' }]).materials.map(item => item.id), ['t', 'q']);
  assert.equal(alternateMaterials(materials, [{ kind: 'daily_info' }]).held, true);
  assert.equal(alternateMaterials(materials, [{ kind: 'life_thread' }]).held, false);
  assert.equal(alternateMaterials(materials, []).held, false);
  const newsOnly = [{ kind: 'article', id: 'a' }, { kind: 'discussion', id: 'q' }];
  assert.deepEqual(alternateMaterials(newsOnly, [{ kind: 'article' }]), { held: false, materials: newsOnly }, 'without her own step news is still offered');
});
