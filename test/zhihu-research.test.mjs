import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { parseSinaHotTopics } from '../lib/integrations.mjs';
import { researchContext } from '../lib/research-context.mjs';

const at = new Date('2026-09-06T12:00:00');
const topic = { title: '【验收】科技如何改变阅读习惯', url: 'https://so.sina.cn/search/list.d.html?keyword=reading', source: '新浪热榜', summary: '', publishedAt: null, observedAt: at.toISOString() };
const answer = { Title: topic.title, Url: 'https://www.zhihu.com/question/123/answer/456?utm_source=openapi', ContentType: 'answer', AuthorName: '验收作者', ContentText: '【验收摘录】阅读媒介改变了注意力分配，但长时间阅读和社交讨论也可能帮助理解复杂问题。', EditTime: Math.floor(+at / 1000) };
const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
function transport(calls, override) {
  return async (url, options) => {
    const u = new URL(url), body = options.body ? JSON.parse(options.body) : null;
    calls.push({ pathname: u.pathname, query: u.search, body });
    const custom = await override?.(u, options, body); if (custom) return custom;
    if (u.pathname.endsWith('/quota')) return Response.json({ Code: 0, Data: [{ APIID: 'zhihu_search', APIName: '站内检索', TotalQuota: 100, TotalUsed: 5, RemainingQuota: 95 }] });
    if (u.pathname.endsWith('/hot_list')) return Response.json({ Code: 0, Data: { Items: [{ Title: topic.title, Url: topic.url }] } });
    if (u.pathname.endsWith('/global_search')) return Response.json({ Code: 0, Data: { Items: [] } });
    if (u.pathname.endsWith('/zhihu_search')) return Response.json({ Code: 0, Data: { Items: [answer] } });
    return Response.json({ choices: [{ message: { content: '【验收整理】背景与观点存在分歧。[1] 认为媒介影响注意力。你怎样安排阅读？ https://invented.invalid/report', reasoning_content: '不要保存的推理' } }] });
  };
}
async function setup(t, options = {}) {
  const dir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'youjian-zhihu-test-'));
  let time = new Date(at), sinaCalls = 0; const calls = [];
  const app = await createApp({ replySleep: async () => {},  dataDir: dir, env: {}, startProactive: false, clock: () => new Date(time), random: () => 0, lifeRandom: () => .99,
    initialFeeds: [], integrations: { fetchFeed: async () => { throw new Error('Virtual feed must not use RSS'); } },
    fetchSina: async () => { sinaCalls++; return { items: [topic] }; }, zhihuFetchImpl: transport(calls, options.override), ...options });
  app.proactiveRepo.saveSettings({ activeStart: '00:00', activeEnd: '23:59', desktopNotifications: false });
  const address = await app.listen(0), base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); if (!options.keepData) fs.rmSync(dir, { recursive: true, force: true }); });
  return { app, calls, dir, get sinaCalls() { return sinaCalls; }, advance: minutes => { time = new Date(+time + minutes * 60000); }, request: async (route, body) => { const res = await fetch(base + route, body === undefined ? undefined : json(body)); return { status: res.status, body: await res.json() }; } };
}
const configure = app => app.zhihuClient.save({ accessSecret: 'explicit-fixture-key', useHotList: false });
async function eventually(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('timer did not complete'); }

test('real independent timer discovers public headlines without a key or fake content, persists schedule', async t => {
  const f = await setup(t, { keepData: true, researchIntervalMs: 10 }); f.app.research.start();
  await eventually(() => f.app.zhihuRepo.runtime().nextRunAt);
  assert.equal(f.sinaCalls, 1); assert.equal(f.calls.length, 0); assert.equal(f.app.store.listContent().length, 0);
  assert.equal(f.app.zhihuRepo.runtime().headlines[0].publishedAt, null);
  assert.equal(f.app.store.getMessages('zhixia').length, 0);
  const next = f.app.zhihuRepo.runtime().nextRunAt; await f.app.close();
  const second = await setup(t, { dataDir: f.dir }); await second.app.research.tick();
  assert.equal(second.sinaCalls, 0); assert.equal(second.app.zhihuRepo.runtime().nextRunAt, next);
});

test('full official request pipeline saves author evidence, excludes private data and reasoning, feeds both chat paths', async t => {
  const modelCalls = [];
  const f = await setup(t, { fetchImpl: async (_url, options) => { const body = JSON.parse(options.body); modelCalls.push(body); const id = body.messages.map(m => m.content).join('\n').match(/ID:([^\n]+)/)?.[1] || null; return Response.json({ choices: [{ message: { content: body.max_tokens === 1800 ? JSON.stringify({ skip: false, contentId: id, reason: '可聊的公开资料', message: '【验收开场】这段阅读资料让我想到你的习惯，你怎么看？' }) : '【验收回复】可以继续讨论。' } }] }); } });
  f.app.proactive.roles = [JSON.parse(fs.readFileSync('app-data/roles.json','utf8')).find(role=>role.id==='wenxi')];
  configure(f.app); f.app.store.addMemory('shared', '不要发给知乎的私密爱好'); f.app.store.addMemory('zhixia', '阮绵的私聊记忆');
  const result = await f.request('/api/zhihu/refresh', {}); assert.equal(result.body.added, 1);
  assert.deepEqual(f.calls.map(c => c.pathname), ['/api/v1/content/global_search', '/api/v1/content/zhihu_search', '/v1/chat/completions']);
  assert.doesNotMatch(JSON.stringify(f.calls), /不要发给知乎的私密爱好|阮绵的私聊记忆/);
  assert.deepEqual(Object.keys(f.calls.at(-1).body).sort(), ['messages', 'model', 'stream']); assert.equal(f.calls.at(-1).body.messages.length, 1);
  const content = f.app.store.listContent()[0]; assert.equal(content.research.references[0].url, answer.Url); assert.equal(content.research.references[0].author, answer.AuthorName);
  assert.doesNotMatch(JSON.stringify(content), /invented.invalid|不要保存的推理/); assert.match(content.summary, /AI 资料整理/);
  assert.match(researchContext(content.research), /不是新闻发生时间/);
  assert.equal((await f.app.refreshContent()).errors.length, 0);
  f.app.model.save({ baseUrl: 'http://model.test/v1', model: 'fixture' });
  const sent = await f.app.proactive.runNow(); assert.equal(sent.delivered, true);
  const message = f.app.store.getMessages('wenxi')[0]; assert.equal(message.sourceResearch.references[0].author, answer.AuthorName);
  assert.match(JSON.stringify(modelCalls[0]), /验收作者/); assert.doesNotMatch(JSON.stringify(modelCalls[0]), /阮绵的私聊记忆/);
  assert.equal((await f.request('/api/chat', { role: 'wenxi', text: '继续聊' })).status, 200); assert.match(JSON.stringify(modelCalls[1]), /验收作者/);
  assert.equal((await f.request('/api/zhihu/refresh', {})).body.added, 0);
  assert.equal(f.calls.filter(c => c.pathname.endsWith('/zhihu_search')).length, 1);
  f.app.store.deleteFeed('zhihu-research'); assert.equal(f.app.store.getMessages('wenxi')[0].sourceResearch.references[0].url, answer.Url);
});

test('concurrent refreshes coalesce and config changes discard in-flight output', async t => {
  let release, entered; const ready = new Promise(r => { entered = r; }); const hold = new Promise(r => { release = r; });
  const f = await setup(t, { override: async u => { if (u.pathname === '/v1/chat/completions') { entered(); await hold; } } }); configure(f.app);
  const one = f.app.research.runNow(), two = f.app.research.runNow(); assert.equal(one, two); await ready;
  f.app.zhihuClient.save({ enabled: false }); release(); await one;
  assert.equal(f.app.store.listContent().length, 0); assert.equal(f.calls.filter(c => c.pathname === '/v1/chat/completions').length, 1);
  const before = f.calls.length; await f.app.research.runNow(); assert.equal(f.calls.length, before);
});

test('stop during a network call causes no later agent request or commit', async t => {
  let release, entered; const ready = new Promise(r => { entered = r; }); const hold = new Promise(r => { release = r; });
  const f = await setup(t, { override: async u => { if (u.pathname.endsWith('/zhihu_search')) { entered(); await hold; } } }); configure(f.app);
  const running = f.app.research.runNow(); await ready; const stopping = f.app.research.stop(); release(); await Promise.all([running, stopping]);
  assert.equal(f.app.store.listContent().length, 0); assert.equal(f.calls.filter(c => c.pathname === '/v1/chat/completions').length, 0);
});

test('request reservations count failures and persist across restarts; manual cannot bypass daily cap', async t => {
  const f = await setup(t, { keepData: true, override: async u => u.pathname.endsWith('/zhihu_search') ? new Response('upstream private body', { status: 500 }) : null });
  configure(f.app); f.app.zhihuClient.save({ useNewsSearch: false, useHotList: true, dailyRequestLimit: 2, dailyAgentLimit: 1 });
  await f.app.research.runNow(); assert.equal(f.app.zhihuRepo.usage().requestsToday, 2); assert.equal(f.app.store.listContent().length, 0);
  await f.app.close(); const second = await setup(t, { dataDir: f.dir });
  await second.app.research.runNow(); await second.app.research.runNow(); assert.equal(second.calls.length, 0); assert.equal(second.app.zhihuRepo.usage().requestsToday, 2);
  assert.doesNotMatch(JSON.stringify(second.app.zhihuRepo.runtime()), /upstream private body/);
});

test('rate limit response establishes persistent cooldown even for manual runs and settings saves', async t => {
  const f = await setup(t, { override: async () => new Response('raw upstream key', { status: 429 }) }); configure(f.app);
  await f.app.research.runNow(); assert.equal(f.calls.length, 1);
  await f.request('/api/zhihu/config', { topicsPerRun: 1 }); await f.app.research.runNow(); assert.equal(f.calls.length, 1);
  assert.ok(f.app.zhihuRepo.runtime().cooldownUntil); assert.doesNotMatch(JSON.stringify(f.app.zhihuRepo.runtime()), /raw upstream key/);
  f.advance(16); await f.app.research.runNow(); assert.equal(f.calls.length, 2);
});

test('quota test caches results, never consumes business reservations or exposes key', async t => {
  const f = await setup(t); const saved = await f.request('/api/zhihu/config', { accessSecret: 'explicit-fixture-key' });
  assert.doesNotMatch(JSON.stringify(saved.body), /explicit-fixture-key/);
  assert.equal((await f.request('/api/zhihu/test', {})).body.quota[0].remaining, 95);
  assert.equal((await f.request('/api/zhihu/test', {})).body.quota[0].remaining, 95);
  assert.equal(f.calls.length, 1); assert.equal(f.app.zhihuRepo.usage().requestsToday, 0);
  assert.equal(fs.statSync(path.join(f.dir, 'zhihu.json')).mode & 0o777, 0o600);
});

test('no actual answer prevents agent calls; zero agent budget stores explicit original excerpts', async t => {
  const f = await setup(t, { override: async u => u.pathname.endsWith('/zhihu_search') ? Response.json({ Code: 0, Data: { Items: [{ ...answer, Url: 'https://www.zhihu.com/question/123', ContentType: 'question' }] } }) : null }); configure(f.app);
  await f.app.research.runNow(); assert.equal(f.app.store.listContent().length, 0); assert.equal(f.calls.length, 2);
  const other = await setup(t); configure(other.app); other.app.zhihuClient.save({ dailyAgentLimit: 0 }); await other.app.research.runNow();
  const content = other.app.store.listContent()[0]; assert.equal(content.research.generatedBy, null); assert.match(content.summary, /未调用智能体/); assert.equal(other.app.zhihuRepo.usage().agentCallsToday, 0);
});

test('Sina public JSON parser rejects stale/executable payloads and unsafe links; observed time is not publication', () => {
  const data = { data: { resTime: +at, data: { hotList: [{ info: { title: '公开热点' }, base: { base: { url: 'https://so.sina.cn/search/list.d.html?keyword=x' } } }, { info: { title: 'unsafe' }, base: { base: { url: 'http://127.0.0.1/private' } } }] } } };
  const page = `<script>SM = ${JSON.stringify(data)};</script>`;
  const parsed = parseSinaHotTopics(page, at); assert.equal(parsed.items.length, 1); assert.equal(parsed.items[0].publishedAt, null);
  assert.throws(() => parseSinaHotTopics(page, new Date(+at + 86400000)));
  assert.throws(() => parseSinaHotTopics(`<script>SM = ${JSON.stringify(data)}; alert('execute')</script>`, at));
  assert.throws(() => parseSinaHotTopics('<script>SM = function(){return {}}</script>', at));
});

test('regional research uses only public destination keywords within the existing request budget', async t => {
  const f = await setup(t, { clock: () => new Date('2026-09-07T08:00:00Z'), lifeRandom: () => 0 });
  configure(f.app); f.app.store.addMemory('miyue', '用户私聊里说的秘密地点不要外发');
  await f.request('/api/zhihu/refresh', {});
  const search = f.calls.find(call => call.pathname.endsWith('/global_search'));
  assert.ok(search); assert.match(decodeURIComponent(search.query), /扬州/);
  assert.doesNotMatch(JSON.stringify(f.calls), /秘密地点|林晓薇|用户私聊/);
  assert.equal(f.calls.filter(call => call.pathname.endsWith('/global_search')).length, 1);
});

test('an event reserves a regional research topic even against hot news and keeps evergreen sources', async t => {
 const regional={Title:'扬州饮食与传统生活',Url:'https://zhuanlan.zhihu.com/p/789',ContentText:'这是一篇较早的扬州饮食文化文章，讨论日常吃饭与城市生活节奏的关系。',PublishTime:1500000000};
 const f=await setup(t,{lifeRandom:()=>0,override:async u=>u.pathname.endsWith('/global_search')?Response.json({Code:0,Data:{Items:[regional]}}):null});configure(f.app);f.app.zhihuClient.save({topicsPerRun:1});
 const result=await f.app.research.runNow();assert.equal(result.added,1);
 const global=f.calls.find(c=>c.pathname.endsWith('/global_search'));const params=new URLSearchParams(global.query);assert.match(params.get('Query'),/扬州.*美食/);assert.doesNotMatch(global.query,/publish|since|time_range|2026/);
 const searched=f.calls.find(c=>c.pathname.endsWith('/zhihu_search'));assert.match(decodeURIComponent(searched.query),/扬州饮食/);assert.match(f.app.store.listContent()[0].research.lifeTopic,/扬州/);assert.equal(f.calls.filter(c=>c.pathname.endsWith('/global_search')).length,1);
});
