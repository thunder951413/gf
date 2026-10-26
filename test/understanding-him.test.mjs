import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { RelationshipLedger } from '../lib/relationship-ledger.mjs';
import { StoryArcs, weekOf, validateArcs } from '../lib/story-arcs.mjs';
import { CompanionIdentity, worldBible, identityProfile } from '../lib/companion-identity.mjs';
import { validatePersona, applyPersona, savePersona, readPersona } from '../lib/persona-overrides.mjs';
import { buildSessionMessages } from '../lib/session-dialogue.mjs';
import { happeningInputs } from '../lib/daily-happenings.mjs';
import { prepareSessionGuidance } from '../lib/session-guidance.mjs';

function memoryStore() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE messages(id TEXT PRIMARY KEY,role TEXT NOT NULL,speaker TEXT NOT NULL,text TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'chat',content_id TEXT,created_at TEXT NOT NULL)`);
  return { db, transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; } } };
}
const fakeModel = answer => { const calls = []; return { calls, publicConfig: () => ({ configured: true }), complete: async (messages, options) => { calls.push({ messages, options }); return JSON.stringify(typeof answer === 'function' ? answer(messages, options) : answer); } }; };
const NOW = new Date('2026-10-26T02:30:00Z'); // Monday 10:30 Shanghai
const ids = new Map([['m1', 'u1'], ['m2', 'u2'], ['m3', 'u3']]);
const weekDays = week => Array.from({ length: 7 }, (_, i) => new Date(Date.parse(`${week}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10));

test('the ledger learns what he is good at, how he has been, what lights him up, and what she still wants to know', () => {
  const store = memoryStore(), ledger = new RelationshipLedger(store, { model: fakeModel({}), clock: () => NOW, enabled: true });
  ledger.apply('miyue', {
    skills: [{ op: 'add', area: '烘豆', text: '自己烘南美和印尼豆，懂风门和曲线', evidence: ['m1'] }],
    state: [{ op: 'add', text: '这周项目收尾，很累，提不起劲', mood: 'low', evidence: ['m2'] }],
    interests: [{ topic: '咖啡', signal: 'engaged', evidence: ['m1'] }, { topic: '游戏', signal: 'flat', evidence: ['m3'] }],
    curiosity: [{ op: 'add', text: '他为什么开始自己烘豆', evidence: ['m1'] }],
    invitation: [{ text: '下班绕到那条银杏路走一段', why: '他说北京一片黄', evidence: ['m2'] }],
    advice: [{ op: 'add', about: '客户总改方案', text: '先让客户指出喜欢的图再改', evidence: ['m3'] }, { op: 'add', about: '没依据', text: 'x', evidence: ['m9'] }],
  }, ids, { now: NOW });
  // The same area grows rather than repeating.
  ledger.apply('miyue', { skills: [{ op: 'add', area: '烘豆', text: '能凭口感猜出非洲豆拼配', evidence: ['m2'] }], interests: [{ topic: '咖啡', signal: 'engaged', evidence: ['m2'] }] }, ids, { now: NOW });
  assert.deepEqual(ledger.skills('miyue'), [{ area: '烘豆', text: '能凭口感猜出非洲豆拼配' }]);
  assert.deepEqual(ledger.learnedInterests('miyue'), ['咖啡']); assert.deepEqual(ledger.fadingInterests('miyue'), []);
  assert.equal(ledger.pendingAdvice('miyue').length, 1, 'advice without evidence is dropped');
  const block = ledger.stableContext('miyue');
  assert.match(block, /他这几天.*项目收尾/); assert.match(block, /他擅长、有经验的.*烘豆——能凭口感/); assert.match(block, /他给你出过的主意.*客户总改方案/);
  assert.match(block, /他真正来劲的是：咖啡/);
  assert.deepEqual(ledger.materials('miyue', { now: NOW }).map(item => item.kind), ['invite']);
  // Curiosity is asked once, then leaves the hint pool.
  const hinted = Array.from({ length: 8 }, (_, i) => ledger.turnHint('miyue', { now: new Date(+NOW + i * 86400000) })).find(hint => hint.includes('一直想知道'));
  assert.ok(hinted, 'curiosity takes its turn in the daily hint');
  ledger.observe('miyue', [{ id: 'r1', speaker: 'assistant', text: '你当初为什么会开始自己烘豆呀？' }], { now: NOW });
  assert.equal(ledger.list('miyue', { kind: 'curiosity' }).length, 0);
  assert.equal(ledger.list('miyue', { kind: 'curiosity', status: 'asked' }).length, 1);
});

test('interest scores fade every day and a topic he keeps brushing off turns into one to avoid', async () => {
  const store = memoryStore(); let now = NOW;
  const ledger = new RelationshipLedger(store, { model: fakeModel({ interests: [{ topic: '游戏', signal: 'flat', evidence: ['m1'] }] }), clock: () => now, enabled: true,
    listMessages: () => [{ id: 'u1', speaker: 'user', text: '嗯', createdAt: new Date(+now - 3600000 * 20).toISOString() }] });
  for (let day = 0; day < 3; day++) { await ledger.ensure('miyue', { force: true }); now = new Date(+now + 86400000); }
  assert.deepEqual(ledger.fadingInterests('miyue'), ['游戏']);
  assert.match(ledger.stableContext('miyue'), /他不太接的是：游戏/);
});

test('his advice rewrites the rest of her week so she acts on it, and the outcome becomes the first thing she tells him', async () => {
  const store = memoryStore(), week = weekOf(NOW), days = weekDays(week); let now = NOW;
  const arcAnswer = { arcs: [
    { line: 'work', title: '茶叶客户第三次推翻', setup: '包装被打回', stakes: '房租', beats: [{ day: days[0], text: '客户说要更高级', feeling: '烦' }, { day: days[4], text: '她熬夜又改一版', feeling: '累' }], choice: { day: days[0], question: '要不要直接问客户要参考图', options: ['问', '自己猜'] }, ending: '客户还是不满意' },
    { line: 'self', title: '旧速写本', setup: '翻出大学速写本', stakes: '想重新画', beats: [{ day: days[0], text: '翻到一页画花的', feeling: '怀念' }, { day: days[3], text: '画了窗外的树', feeling: '安静' }], ending: '画完一本' }],
    questions: ['你第一次自己烘豆是什么感觉？'], discovery: { day: days[2], field: '发酵风味', hook: '读到咖啡豆处理法会改变风味', link: '他自己烘豆', question: '水洗和日晒你喝得出区别吗' } };
  const reviseAnswer = messages => { const input = JSON.parse(messages[1].content); const client = input.advice.find(item => item.about.includes('客户')), other = input.advice.find(item => item !== client); return { revisions: [
    { adviceId: client.id, arcId: 'a1', followed: 'full', why: '他说得对', beats: [{ day: days[1], text: '她让客户圈出喜欢的三张图', feeling: '踏实' }, { day: days[2], text: '照着方向改完，客户一次通过', feeling: '松了口气', adviceOutcome: true }], ending: '客户一次通过，还加了下一单' },
    { adviceId: other.id, arcId: null, followed: 'no', why: '', beats: [], ending: '' }] }; };
  const model = fakeModel((messages, options) => options.purpose === 'story-arcs' ? arcAnswer : reviseAnswer(messages));
  const identity = new CompanionIdentity(store);
  const arcs = new StoryArcs(store, { model, clock: () => now, identity, enabled: true, gather: () => ({ hisSkills: [{ area: '谈客户', text: '跟甲方谈价有经验' }], hisInterests: ['咖啡'] }) });
  await arcs.ensure('miyue');
  const input = JSON.parse(model.calls[0].messages[1].content);
  assert.deepEqual(input.hisSkills, [{ area: '谈客户', text: '跟甲方谈价有经验' }]); assert.deepEqual(input.hisInterests, ['咖啡']);
  assert.equal(arcs.record('miyue').discovery.field, '发酵风味');
  // His advice arrives the next morning through the ledger; the ledger hands it to the story.
  now = new Date(`${days[1]}T00:30:00Z`);
  const ledger = new RelationshipLedger(store, { model: fakeModel({ advice: [{ op: 'add', about: '客户总推翻', text: '直接让客户指出喜欢的图', evidence: ['m1'] }, { op: 'add', about: '晚饭', text: '别吃太晚', evidence: ['m1'] }] }), clock: () => now, enabled: true,
    listMessages: () => [{ id: 'u1', speaker: 'user', text: '你直接让客户指出喜欢哪几张图', createdAt: NOW.toISOString() }],
    onUpdated: async ({ roleId }) => { const result = await arcs.reviseWithAdvice(roleId, ledger.pendingAdvice(roleId)); for (const entry of result.applied) ledger.markAdviceApplied(entry.adviceId, entry.arcRef); } });
  await ledger.ensure('miyue', { force: true });
  assert.deepEqual(ledger.pendingAdvice('miyue'), [], 'both handled: one taken into the story, one unrelated');
  const work = arcs.record('miyue').arcs[0];
  assert.equal(work.ending, '客户一次通过，还加了下一单'); assert.equal(work.beats[0].day, days[0], 'what already happened stays');
  assert.match(arcs.stableContext('miyue'), /他给过主意“直接让客户指出喜欢的图”，你照做了/);
  assert.doesNotMatch(arcs.stableContext('miyue'), /拿不定的/, 'the choice he answered is settled');
  now = new Date(`${days[2]}T03:00:00Z`);
  const materials = arcs.materials('miyue');
  assert.equal(materials[0].kind, 'advice_outcome'); assert.match(materials[0].scope, /哪一点起了作用/);
  assert.ok(materials.some(item => item.kind === 'discovery'));
  assert.match(arcs.stableContext('miyue'), /这是照他说的“直接让客户指出喜欢的图”做之后的结果/);
  arcs.observe('miyue', [{ id: 'r9', speaker: 'assistant', text: '发酵风味那篇我读了，想到你' }]);
  assert.ok(!arcs.materials('miyue').some(item => item.kind === 'discovery'), 'told once');
});

test('arc validation keeps a well-formed discovery and drops one outside the week', () => {
  const days = ['2026-10-26', '2026-10-27'];
  const arcs = [{ line: 'work', title: 't', ending: 'e', beats: [{ day: days[0], text: 'a' }, { day: days[1], text: 'b' }] }, { line: 'self', title: 's', ending: 'e', beats: [{ day: days[0], text: 'a' }, { day: days[1], text: 'b' }] }];
  assert.equal(validateArcs({ arcs, discovery: { day: days[1], field: '发酵', hook: '读到', link: '烘豆', question: '?' } }, { days }).discovery.field, '发酵');
  assert.equal(validateArcs({ arcs, discovery: { day: '2027-01-01', field: '发酵', hook: '读到' } }, { days }).discovery, null);
});

test('"她是谁" lays his choices over the default persona everywhere she is described', () => {
  const store = memoryStore();
  assert.throws(() => validatePersona([]), /格式无效/);
  savePersona(store.db, { temperament: '嘴硬心软，爱逗他', background: '在杭州开一家小书店，养了一只橘猫', opinions: '纸书比电子书好\n慢一点没关系', speech: '' });
  const saved = readPersona(store.db);
  assert.deepEqual(saved.opinions, ['纸书比电子书好', '慢一点没关系']); assert.equal(saved.speech, undefined);
  const base = { age: 27, home: '苏州', occupation: '设计师', socialCircle: [{ id: 'xiaoyu' }], temperament: '温婉', likes: ['热汤'] };
  const profile = applyPersona(base, saved);
  assert.equal(profile.temperament, '嘴硬心软，爱逗他'); assert.equal(profile.customBackground, '在杭州开一家小书店，养了一只橘猫');
  assert.equal(profile.home, undefined); assert.equal(profile.socialCircle, undefined); assert.deepEqual(profile.likes, ['热汤']);
  assert.equal(base.home, '苏州', 'the default is untouched');
  const persona = buildSessionMessages({ role: { id: 'miyue', name: '林晓薇', profile }, history: { rows: [] }, userText: '在干嘛', trigger: { type: 'user_message', at: NOW.toISOString() } })[0].content;
  assert.match(persona, /在杭州开一家小书店/); assert.doesNotMatch(persona, /27岁，住在苏州/); assert.match(persona, /纸书比电子书好/);
  assert.equal((persona.match(/如实说你是模型根据设定生成的虚构角色/g) || []).length, 1);
  assert.match(worldBible('human', profile.customBackground), /杭州开一家小书店/);
  const day = happeningInputs({ now: NOW, profile }).input;
  assert.equal(day.persona, '在杭州开一家小书店，养了一只橘猫'); assert.equal(day.schedule, undefined); assert.deepEqual(day.friends, []);
  assert.equal(identityProfile('ai', { ...profile, appearance: '短发，穿灰卫衣' }).appearance, '短发，穿灰卫衣', 'the AI keeps her look');
});

test('the preparer can mark a turn where he is really telling her something, so it gets reviewed', async () => {
  const model = fakeModel({ reviewEffort: 'fast', catch: true, turn: { focus: { text: '他在讲烘豆的经验', sourceId: 'current', quote: '烘豆' }, claims: [] }, guidance: [] });
  const messages = buildSessionMessages({ role: { id: 'miyue', name: '林晓薇', profile: {} }, history: { rows: [] }, userText: '我跟你说说烘豆最难的是控风门', trigger: { type: 'user_message', at: NOW.toISOString() } });
  const result = await prepareSessionGuidance({ model, messages, roleId: 'miyue' });
  assert.equal(result.catch, true); assert.equal(result.reviewEffort, 'fast');
});
