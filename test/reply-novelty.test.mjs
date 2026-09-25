import test from 'node:test';
import assert from 'node:assert/strict';
import { replyNoveltyPlan, replyNoveltyIssues, replyNoveltyMatches } from '../lib/reply-novelty.mjs';

const now = new Date('2026-09-12T12:00:00.000Z');
const assistant = (text, createdAt = now.toISOString()) => ({ speaker: 'assistant', text, createdAt });
const user = text => ({ speaker: 'user', text });

test('a changed preference is a new fact even with nearly identical words',()=>{
  const plan=replyNoveltyPlan({now,conversation:[assistant('我喜欢这件蓝色外套，尤其是领口的设计。')]});
  assert.deepEqual(replyNoveltyIssues('我不再喜欢这件蓝色外套，尤其是领口的设计。',plan),[]);
});

test('finds a substantial near-duplicate without relying on any topic words', () => {
  const plan = replyNoveltyPlan({ now, conversation: [user('说说近况'), assistant('我把窗边那盆植物挪开了，下午的光落在地板上特别安静。')] });
  assert.deepEqual(replyNoveltyIssues('下午我把窗边的植物移走，阳光落在地板上，屋里一下安静下来。', plan), ['repeated_reply_content']);
});

test('merges consecutive assistant bubbles from one user turn before comparing', () => {
  const plan = replyNoveltyPlan({ now, conversation: [user('然后呢'), assistant('我把一张旧票根夹进书里。'), assistant('纸边有点卷，但我还是把它留住了。')] });
  assert.equal(plan.recent.length, 1);
  assert.deepEqual(replyNoveltyIssues('那张旧票根纸边有点卷，我还是夹进书里留住了。', plan), ['repeated_reply_content']);
});

test('returns complete-sentence spans for a caller to repair without editing itself', () => {
  const plan = replyNoveltyPlan({ now, conversation: [assistant('我把唱片翻到 B 面，针落下去时房间里只剩一点沙沙声。')] });
  const reply = '我把唱片翻到B面，针落下去后房间里只剩细小的沙沙声。后来我去泡了茶。';
  const [match] = replyNoveltyMatches(reply, plan);
  assert.equal(reply.slice(match.start, match.end), '我把唱片翻到B面，针落下去后房间里只剩细小的沙沙声。');
  assert.match(match.previousText, /唱片翻到 B 面/);
  assert.ok(match.confidence >= 0.7);
});

test('short social phrases do not count as repetition', () => {
  const plan = replyNoveltyPlan({ now, conversation: [assistant('晚安，想你。')] });
  assert.deepEqual(replyNoveltyIssues('晚安，想你。', plan), []);
});

test('explicit review and follow-up of an old matter are allowed', () => {
  const conversation = [user('说说近况'), assistant('我把窗边那盆植物挪开了，下午的光落在地板上特别安静。')];
  for (const userText of ['你刚才说窗边那盆植物后来怎么样？', '还记得你上次挪开的植物吗？']) {
    const plan = replyNoveltyPlan({ now, conversation, userText });
    assert.equal(plan.reviewing, true);
    assert.deepEqual(replyNoveltyIssues('我把窗边那盆植物挪开了，下午的光落在地板上特别安静。', plan), []);
  }
});

test('numbers, negation, and status changes remain meaningful rather than being stripped for matching', () => {
  const plan = replyNoveltyPlan({ now, conversation: [assistant('那版稿子还没完成，还剩两页需要慢慢收尾。')] });
  assert.deepEqual(replyNoveltyIssues('那版稿子已经完成了，两页也都收好了。', plan), []);
  assert.deepEqual(replyNoveltyIssues('那版稿子还没完成，还剩三页需要慢慢收尾。', plan), []);
});

test('repeated lived-state clauses trigger an issue even when new wording is attached', () => {
  const dishes = replyNoveltyPlan({ now, conversation: [assistant('我这边刚把碗洗完，人就靠在厨房门边跟你说话，要是你在就好了。')] });
  const dishReply = '我这边碗刚洗完，人还靠在厨房门边没挪窝，正想歇一下。';
  assert.deepEqual(replyNoveltyIssues(dishReply, dishes), ['repeated_reply_content']);
  assert.ok(replyNoveltyMatches(dishReply, dishes).every(match => !match.exact));

  const sofa = replyNoveltyPlan({ now, conversation: [assistant('我人窝在沙发上，毯子一直盖上，刚吃完饭。')] });
  assert.deepEqual(replyNoveltyIssues('我在家里刚吃完饭，碗还堆在水池里没洗呢，人窝在沙发上，毯子盖着。', sofa), ['repeated_reply_content']);
});

test('an isolated mention from a long prior report does not turn a new itinerary into repetition', () => {
  const plan = replyNoveltyPlan({ now, conversation: [assistant('你说到那扇亮灯的窗户时，我本来只是讲一件路过看见的事，可你一说要坐我旁边听，那盏灯好像就变成了咱们这间屋里的灯，人从灯下走过去，我还会偏头看你一眼。')] });
  const reply = '刚才那扇亮灯的窗户其实只是一件，我还留着几桩：一只蹲着的猫，一碗没吃完的豆花，还有昨天在巷口等雨停时碰见的人。';
  assert.deepEqual(replyNoveltyIssues(reply, plan), []);
});

test('a shared place at the edge of a long earlier report can introduce a different new fact', () => {
  const plan = replyNoveltyPlan({ now, conversation: [assistant('那家面包店门口的长椅上，我原本只是讲自己停下来躲雨的事。')] });
  const reply = '那家面包店门口只是开头，后来我在巷子里遇见一个给流浪猫喂水的人。';
  assert.deepEqual(replyNoveltyIssues(reply, plan), []);
});

test('a compact repeated lived state still triggers when surrounded by a longer previous report', () => {
  const plan = replyNoveltyPlan({ now, conversation: [assistant('今天忙完后我把盘子洗净，又给窗边的植物浇了水，人还窝在沙发上，毯子一直盖着，刚吃完饭。')] });
  const reply = '我还窝在沙发上，毯子也盖着，正想歇一下。';
  assert.deepEqual(replyNoveltyIssues(reply, plan), ['repeated_reply_content']);
});

test('quoted shared wording with changed negation and page count remains a new state', () => {
  const plan = replyNoveltyPlan({ now, conversation: [assistant('“窗边那盏灯”我还没关，今天只读了两页。')] });
  assert.deepEqual(replyNoveltyIssues('“窗边那盏灯”已经关了，今天读到三页。', plan), []);
});

test('only an unchanged complete sentence is marked exact and eligible for caller-side removal', () => {
  const line = '我把票根夹进书里，纸边有点卷。';
  const plan = replyNoveltyPlan({ now, conversation: [assistant(line)] });
  const [match] = replyNoveltyMatches(line, plan);
  assert.equal(match.exact, true);
  assert.equal(match.text, line);
});

test('explicit continuation and direct factual follow-ups allow relevant repetition', () => {
  const conversation = [assistant('我这边刚把碗洗完，人就靠在厨房门边跟你说话。')];
  for (const userText of ['碗洗了没？', '还在厨房吗？', '继续说', '后来呢？']) {
    const plan = replyNoveltyPlan({ now, conversation, userText });
    assert.equal(plan.reviewing, true, userText);
    assert.deepEqual(replyNoveltyIssues('我这边刚把碗洗完，人就靠在厨房门边跟你说话。', plan), []);
  }
});

test('new progress and numeric facts do not become removable exact matches', () => {
  const plan = replyNoveltyPlan({ now, conversation: [assistant('那版稿子还没完成，还剩两页需要慢慢收尾。')] });
  const reply = '那版稿子已经完成了，三页也都收好了。';
  assert.deepEqual(replyNoveltyIssues(reply, plan), []);
  assert.deepEqual(replyNoveltyMatches(reply, plan), []);
});

test('known history older than six hours does not constrain a fresh reply', () => {
  const old = new Date(+now - 7 * 60 * 60 * 1000).toISOString();
  const plan = replyNoveltyPlan({ now, conversation: [assistant('我把窗边那盆植物挪开了，下午的光落在地板上特别安静。', old)] });
  assert.equal(plan.recent.length, 0);
  assert.deepEqual(replyNoveltyIssues('我把窗边那盆植物挪开了，下午的光落在地板上特别安静。', plan), []);
});

test('consecutive proactive assistant messages are compared even with no new user turn', () => {
  const plan = replyNoveltyPlan({ initiating: true, now, conversation: [assistant('我把唱片翻到 B 面，针落下去时房间里只剩一点沙沙声。'), assistant('窗外的风把晾着的纸轻轻吹响了。')] });
  assert.equal(plan.initiating, true);
  assert.deepEqual(replyNoveltyIssues('我把唱片翻到B面，针落下去后房间里只剩细小的沙沙声。', plan), ['repeated_reply_content']);
});

test('plan context is bounded and says recent speech is background, not a demand for novelty', () => {
  const plan = replyNoveltyPlan({ now, conversation: Array.from({ length: 8 }, (_, index) => assistant(`第${index}段内容`.repeat(100))) });
  assert.ok(plan.context.length <= 600);
  assert.match(plan.context, /只作背景/);
  assert.match(plan.context, /不要求每轮都开新话题/);
  assert.ok(plan.recent.length <= 4);
});

test('an explicit correction blocks the same action even when the draft reverses its word order', () => {
  const plan = replyNoveltyPlan({ now, userText: '躺着呢，你不用一直说要跺一脚了，我知道了。', conversation: [assistant('我走到门口，跺一脚才进屋。')] });
  plan.reviewing = true;
  assert.equal(plan.correction, '跺一脚');
  assert.match(plan.context, /停止重复/);
  assert.deepEqual(replyNoveltyIssues('好，我刚到门口，脚一跺就进来了。', plan), ['repeated_corrected_content']);
  assert.deepEqual(replyNoveltyIssues('好，我不再反复讲那个动作了。你躺着休息一会儿。', plan), []);
});
