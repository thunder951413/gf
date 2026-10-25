import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { CharacterRepository } from '../lib/characters.mjs';
import { UsageRepository, normalizeUsage } from '../lib/usage.mjs';
import { ModelClient, buildChatMessages } from '../lib/model.mjs';
import { buildProactiveMessages } from '../lib/proactive.mjs';
import { createApp } from '../server.mjs';

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-character-test-'));
  const story = JSON.parse(fs.readFileSync('app-data/story.json', 'utf8'));
  const store = new Store({ dataDir, story, initialFeeds: [] });
  t.after(() => { store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { store, dataDir };
}
test('optional script entry stays separate from everyday persona and proactive prompts receive scoped state and recall', () => {
  const role = JSON.parse(fs.readFileSync('app-data/roles.json', 'utf8')).find(role => role.id === 'miyue');
  const storyData = JSON.parse(fs.readFileSync('app-data/story.json', 'utf8'));
  const story = { node: storyData.nodes.platform, history: [] };
  const common = { role, memories: [], conversation: [], story, characterContext: '当前状态：期待散步', recallContext: '当前角色专属回忆：热茶淡一些' };
  const ordinary = buildChatMessages(common);
  const script = buildChatMessages({ ...common, storyMode: true });
  assert.doesNotMatch(ordinary[0].content, /用户已通过故事页进入/);
  assert.deepEqual(script[0], ordinary[0]);
  assert.ok(script.some(m => m.role === 'user' && /本轮通过故事页进入/.test(m.content)));
  assert.ok(!ordinary.some(m => /本轮通过故事页进入/.test(m.content)));
  const proactive = buildProactiveMessages({ ...common, kind: 'story', candidates: [], topics: '日常' });
  assert.doesNotMatch(proactive[0].content, /当前状态：期待散步/);
  assert.ok(proactive.some(m => m.role === 'user' && /当前状态：期待散步/.test(m.content)));
  assert.ok(proactive.some(message => message.role === 'user' && message.content.includes('热茶淡一些')));
  assert.doesNotMatch(proactive[0].content, /热茶淡一些/);
});
test('fictional states persist across reads and repository restarts; long absence never accumulates deprivation', t => {
  const { store } = fixture(t); let at = new Date('2026-09-06T04:00:00Z');
  const options = { clock: () => at, random: () => .2 };
  const chars = new CharacterRepository(store, options), state = chars.get('miyue');
  at = new Date(+at + 1000);
  assert.deepEqual(chars.get('miyue'), state);
  assert.deepEqual(new CharacterRepository(store, options).get('miyue'), state);
  at = new Date(+at + 40 * 86400000);
  const later = chars.get('miyue');
  assert.notEqual(later.eventIndex, state.eventIndex);
  assert.equal(later.relationshipStage, state.relationshipStage);
  assert.equal(later.hunger, state.hunger);
  assert.doesNotMatch(later.feeling + later.wish, /不回|抛弃|惩罚/);
});
test('affection and explicit distance update only this role and do not manufacture a romantic commitment', t => {
  const { store } = fixture(t); const chars = new CharacterRepository(store, { random: () => 0 });
  const other = chars.get('wenxi'); chars.get('zhixia');
  assert.equal(chars.afterTurn('zhixia', '辛苦了，抱抱').mood, '被接住了');
  assert.equal(chars.afterTurn('zhixia', '不要亲密').closeness, 20);
  assert.deepEqual(chars.get('wenxi'), other);
  assert.doesNotMatch(chars.get('zhixia').relationshipStage, /情侣|女朋友/);
});
test('provider token fields preserve unknowns and count cached/reasoning as subsets', t => {
  const { store } = fixture(t), ledger = new UsageRepository(store);
  ledger.record({ provider: 'example.test', model: 'test', roleId: 'miyue', usage: { prompt_tokens: 100, completion_tokens: 50, prompt_cache_hit_tokens: 80, completion_tokens_details: { reasoning_tokens: 20 } } });
  ledger.record({ provider: 'example.test', model: 'test', purpose: 'memory', status: 'failed' });
  const usage = ledger.snapshot();
  assert.equal(usage.allTime.totalTokens, 150); assert.equal(usage.allTime.cachedTokens, 80);
  assert.equal(usage.allTime.reasoningTokens, 20); assert.equal(usage.allTime.unknownRequests, 1);
  assert.equal(usage.allTime.failedRequests, 1); assert.equal(usage.byPurpose.find(row => row.purpose === 'memory').totalTokens, null);
  assert.equal(normalizeUsage({ prompt_tokens: -1, completion_tokens: 0 }).inputTokens, null);
  assert.equal(normalizeUsage({ prompt_tokens: 0, completion_tokens: 0 }).totalTokens, 0);
  assert.equal(new UsageRepository(store).snapshot().since, usage.since);
});
test('model records actual usage once even when output validation fails, never leaking key or reasoning text', async t => {
  const { dataDir } = fixture(t); const events = [];
  const model = new ModelClient({ dataDir, env: { LIFE_MODEL_BASE_URL: 'https://model.test/v1', LIFE_MODEL_NAME: 'test', LIFE_MODEL_API_KEY: 'sensitive-test-key' }, onUsage: event => events.push(event), fetchImpl: async () => new Response(JSON.stringify({ usage: { prompt_tokens: 8, completion_tokens: 20 }, choices: [{ message: { content: '', reasoning_content: 'hidden-reasoning' }, finish_reason: 'length' }] })) });
  await assert.rejects(model.complete([{ role: 'user', content: 'hello' }], { purpose: 'proactive', roleId: 'miyue' }), { code: 'MODEL_OUTPUT_LIMIT' });
  assert.equal(events.length, 1); assert.equal(events[0].status, 'failed'); assert.equal(events[0].usage.completion_tokens, 20);
  assert.doesNotMatch(JSON.stringify(events), /sensitive-test-key|hidden-reasoning|hello/);
});
test('profiles, scoped manual summaries, preserved short-term raw and usage integrate with the real HTTP chat route', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-character-api-')); const calls = [];
  const app = await createApp({ replySleep: async () => {},  dataDir, disableStory: true, env: { LIFE_MODEL_BASE_URL: 'https://model.test/v1', LIFE_MODEL_NAME: 'test' }, initialFeeds: [], startProactive: false, startRecall: false, fetchImpl: async (_url, options) => { calls.push(JSON.parse(options.body)); return new Response(JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }, choices: [{ message: { content: '我想听你继续说。' } }] })); } });
  const address = await app.listen(0); const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const req = async (url, body, method = 'POST') => { const response = await fetch(base + url, body === undefined ? {} : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: response.status, data: await response.json() }; };
  const bootstrap = (await req('/api/bootstrap')).data;
  assert.deepEqual(bootstrap.roles.map(role => role.id), ['miyue']);
  assert.equal(bootstrap.story, null);
  assert.equal((await req('/api/story')).status, 404);
  assert.equal((await req('/api/conversations/zhixia')).status, 400);
  assert.equal(bootstrap.roles.find(role => role.id === 'miyue').name, '林晓薇');
  assert.deepEqual(bootstrap.roles.find(role => role.id === 'miyue').profile.sharedPast, []);
  const profile = (await req('/api/characters/miyue')).data.profile;
  assert.equal(profile.heightCm, 165); assert.equal(profile.weightKg, 50); assert.equal(profile.braCup, 'B+');
  app.store.saveChatTurn({ role: 'miyue', text: '不想再记的旧事', reply: '旧回答' });
  await req('/api/recall/miyue', { summary: '用户明确偏好：更喜欢先讲自己的看法。' }, 'PATCH');
  assert.equal((await req('/api/recall/wenxi', { summary: '旧角色内容' }, 'PATCH')).status, 400);
  assert.equal((await req('/api/chat', { role: 'miyue', text: '你来起头吧' })).status, 200);
  const prompt = JSON.stringify(calls.at(-1).messages);
  assert.match(calls.at(-1).messages[0].content, /身高165厘米，体重50公斤，罩杯B\+/);
  assert.match(prompt, /江苏苏州/); assert.match(prompt, /本轮结构化事实/); assert.match(prompt, /更喜欢先讲自己的看法/);
  assert.doesNotMatch(prompt, /旧角色内容/);
  assert.match(prompt, /不想再记的旧事/); // Editing the summary does not erase short-term raw messages.
  await req('/api/recall/miyue', { summary: '' }, 'PATCH');
  await req('/api/chat', { role: 'miyue', text: '重新聊点别的' });
  assert.doesNotMatch(JSON.stringify(calls.at(-1)), /更喜欢先讲自己的看法/);
  assert.match(JSON.stringify(calls.at(-1)), /你来起头吧/);
  assert.equal((await req('/api/conversations/miyue')).data.messages.length, 6);
  const usage = (await req('/api/usage')).data; assert.equal(usage.allTime.totalTokens, 40); assert.equal(usage.byRole[0].roleId, 'miyue');
  assert.equal((await req('/api/characters/nope')).status, 400);
  assert.equal((await req('/api/recall/miyue', { summary: 'x'.repeat(6001) }, 'PATCH')).status, 400);
});
test('official DeepSeek structured replies use documented JSON mode and a non-thinking bounded request only when requested',async t=>{
 const {dataDir}=fixture(t);const calls=[];const model=new ModelClient({dataDir,env:{LIFE_MODEL_BASE_URL:'https://api.deepseek.com/v1',LIFE_MODEL_NAME:'deepseek-v4-flash'},fetchImpl:async(_u,o)=>{calls.push(JSON.parse(o.body));return Response.json({choices:[{message:{content:'{"reply":"正常回复","signals":null}'}}]})}});
 await model.complete([{role:'system',content:'Return JSON'}],{jsonObject:true});assert.deepEqual(calls[0].response_format,{type:'json_object'});assert.deepEqual(calls[0].thinking,{type:'disabled'});assert.equal(calls[0].max_tokens,3000);
 await model.complete([{role:'user',content:'你好'}]);assert.equal(calls[1].response_format,undefined);assert.equal(calls[1].thinking,undefined);
 model.env={LIFE_MODEL_BASE_URL:'https://compatible.test/v1',LIFE_MODEL_NAME:'deepseek-v4-flash'};await model.complete([{role:'system',content:'Return JSON'}],{jsonObject:true});assert.equal(calls[2].response_format,undefined);assert.equal(calls[2].thinking,undefined);
});

test('official OpenAI small model receives JSON mode without DeepSeek-specific fields',async t=>{const{dataDir}=fixture(t);let body;const client=new ModelClient({dataDir,env:{LIFE_MODEL_BASE_URL:'https://api.openai.com/v1',LIFE_MODEL_NAME:'gpt-4.1-mini'},fetchImpl:async(_u,o)=>{body=JSON.parse(o.body);return Response.json({choices:[{message:{content:'{"reply":"你好","extra":""}'}}]});}});await client.complete([{role:'user',content:'请输出JSON'}],{jsonObject:true,maxTokens:700});assert.deepEqual(body.response_format,{type:'json_object'});assert.equal(body.thinking,undefined);assert.equal(body.max_tokens,700);});

test('explicit semantic reasoning overrides the short JSON default only on supported official DeepSeek models',async t=>{
 const {dataDir}=fixture(t);const calls=[];
 const model=new ModelClient({dataDir,env:{LIFE_MODEL_BASE_URL:'https://api.deepseek.com/v1',LIFE_MODEL_NAME:'deepseek-v4-flash'},fetchImpl:async(_u,o)=>{calls.push(JSON.parse(o.body));return Response.json({choices:[{message:{reasoning_content:'private internal reasoning',content:'{"guidance":[]}'}}]});}});
 assert.equal(await model.complete([{role:'system',content:'Return JSON'}],{purpose:'session-review',jsonObject:true,thinking:true,maxTokens:4096}),'{"guidance":[]}');
 assert.deepEqual(calls[0].thinking,{type:'enabled'});assert.equal(calls[0].reasoning_effort,'low');
 assert.deepEqual(calls[0].response_format,{type:'json_object'});assert.equal(calls[0].max_tokens,4096);
 model.env={LIFE_MODEL_BASE_URL:'https://compatible.test/v1',LIFE_MODEL_NAME:'deepseek-v4-flash'};
 await model.complete([{role:'system',content:'Return JSON'}],{jsonObject:true,thinking:true});
 assert.equal(calls[1].thinking,undefined);assert.equal(calls[1].reasoning_effort,undefined);
});
