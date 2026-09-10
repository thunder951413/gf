import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ContentDossierRepository } from '../lib/content-dossier.mjs';
import { fetchArticle } from '../lib/integrations.mjs';
import { Store } from '../lib/store.mjs';

const story = { start: 'start', nodes: { start: { id: 'start', body: '', choices: [] } } };
function fixture(t, start = '2026-09-06T00:00:00.000Z') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-dossier-'));
  let at = new Date(start);
  const store = new Store({ dataDir, story, initialFeeds: [] });
  const repo = new ContentDossierRepository(store, { clock: () => at });
  t.after(() => { try { store.close(); } catch {} fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { dataDir, store, repo, advance: (milliseconds) => { at = new Date(at.valueOf() + milliseconds); } };
}
function item(id, overrides = {}) {
  return {
    id, feedId: 'feed-a', source: '测试来源', title: `城市公共空间观察：第${id}期`,
    url: `https://news.example/articles/${id}`,
    summary: '这是一段有明确事实线索和讨论价值的订阅摘要，介绍城市公共空间的变化、居民体验以及仍待确认的影响。',
    ...overrides,
  };
}
const article = (value = '正文') => ({
  extracted: true, url: 'https://news.example/final', title: '页面标题',
  text: `${value}第一段包含足够长度的公开页面信息，说明事情发生的背景和目前可以观察到的变化。\n${value}第二段补充不同参与者的说法以及仍然无法从当前材料确认的部分。`.repeat(3),
});

test('fetchArticle rejects private targets and private redirects before a second request', async () => {
  await assert.rejects(fetchArticle('http://127.0.0.1/article'), /本机或私有网络/);
  let requests = 0;
  await assert.rejects(fetchArticle('https://public.example/article', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: async () => { requests += 1; return { statusCode: 302, headers: { location: 'http://10.0.0.2/secret' }, body: Buffer.alloc(0) }; },
  }), /本机或私有网络/);
  assert.equal(requests, 1);
});

test('fetchArticle extracts article paragraphs, strips scripts, and labels only extraction', async () => {
  const html = `<!doctype html><html><head><title>示例页面</title><script>steal()</script></head><body><nav>${'导航'.repeat(120)}</nav><article><h1>真正标题</h1><p>${'正文第一段，'.repeat(35)}</p><script>ignore me</script><p>${'正文第二段。'.repeat(35)}</p></article><footer>${'页脚'.repeat(120)}</footer></body></html>`;
  const result = await fetchArticle('https://public.example/article', {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    transport: async (_url, _pinned, _deadline, _maxBytes, _proxy, headers) => {
      assert.match(headers.Accept, /text\/html/); assert.equal(headers.Cookie, undefined); assert.equal(headers.Authorization, undefined);
      return { statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(html) };
    },
  });
  assert.equal(result.extracted, true);
  assert.equal(result.title, '示例页面');
  assert.match(result.text, /正文第一段/);
  assert.match(result.text, /\n/);
  assert.doesNotMatch(result.text, /steal|ignore me|导航|页脚/);
  assert.equal(Object.hasOwn(result, 'fullText'), false);
});

test('fetchArticle prefers JSON-LD articleBody and rejects login walls and short boilerplate', async () => {
  const json = JSON.stringify({ '@type': 'NewsArticle', headline: '结构化标题', articleBody: `${'结构化正文提供具体资料。'.repeat(30)}\n${'第二段保持段落信息。'.repeat(20)}` });
  const result = await fetchArticle('https://public.example/a', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    transport: async () => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(`<script type="application/ld+json">${json}</script><body>菜单</body>`) }),
  });
  assert.equal(result.title, '结构化标题'); assert.match(result.text, /结构化正文/);
  await assert.rejects(fetchArticle('https://public.example/wall', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    transport: async () => ({ statusCode: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from(`<main>请先登录后查看。${'账户帮助和网站导航。'.repeat(30)}</main>`) }),
  }), /没有可用/);
});

test('repository caches success across restart, retries after TTL, and invalidates a changed URL', async t => {
  const f = fixture(t); const target = item('a'); let calls = 0;
  const reader = async () => { calls += 1; return article(`第${calls}次`); };
  await f.repo.prepare([target], { fetchArticle: reader });
  assert.equal(calls, 1); assert.equal(f.repo.get('a').status, 'success');
  const clock = f.repo.clock; f.store.close();
  const reopened = new Store({ dataDir: f.dataDir, story, initialFeeds: [] });
  t.after(() => { try { reopened.close(); } catch {} });
  const restarted = new ContentDossierRepository(reopened, { clock });
  await restarted.prepare([target], { fetchArticle: reader }); assert.equal(calls, 1);
  f.advance(7 * 24 * 60 * 60 * 1000 + 1);
  await restarted.prepare([target], { fetchArticle: reader }); assert.equal(calls, 2);
  const changed = { ...target, url: 'https://news.example/replaced/a' };
  await restarted.prepare([changed], { fetchArticle: reader });
  assert.equal(calls, 3); assert.equal(restarted.get('a').url, changed.url);
  assert.match(restarted.get('a').text, /第3次/);
});

test('repository persists failure backoff and retries after six hours', async t => {
  const f = fixture(t); let calls = 0;
  const reader = async () => { calls += 1; if (calls === 1) throw new Error('blocked'); return article('恢复后'); };
  await f.repo.prepare([item('failure')], { fetchArticle: reader });
  assert.equal(f.repo.get('failure').status, 'failed');
  await f.repo.prepare([item('failure')], { fetchArticle: reader }); assert.equal(calls, 1);
  f.advance(6 * 60 * 60 * 1000 + 1);
  const restarted = new ContentDossierRepository(f.store, { clock: f.repo.clock });
  await restarted.prepare([item('failure')], { fetchArticle: reader });
  assert.equal(calls, 2); assert.equal(restarted.get('failure').status, 'success');
});

test('concurrent preparation coalesces work, accepts late items, and keeps a global sequential limit', async t => {
  const f = fixture(t); const order = []; let release;
  const held = new Promise((resolve) => { release = resolve; });
  const reader = async (url) => { order.push(`start:${url}`); if (order.length === 1) await held; order.push(`end:${url}`); return article(url); };
  const first = f.repo.prepare([item('one'), item('obsolete')], { fetchArticle: reader, limit: 2 });
  await new Promise((resolve) => setImmediate(resolve));
  const second = f.repo.prepare([item('two'), item('three')], { fetchArticle: reader, limit: 3 });
  release(); await Promise.all([first, second]);
  assert.deepEqual(order, [
    'start:https://news.example/articles/one', 'end:https://news.example/articles/one',
    'start:https://news.example/articles/two', 'end:https://news.example/articles/two',
  ]);
  assert.equal(f.repo.get('three'), null);
  assert.equal(f.repo.get('obsolete'), null, 'a fresh snapshot removes queued content that disappeared');
});

test('decorate groups only identical canonical URLs or highly similar titles and keeps source IDs', t => {
  const f = fixture(t);
  const a = item('a', { feedId: 'wire-a', title: '台风登陆广东，多地启动应急响应' });
  const b = item('b', { feedId: 'wire-b', title: '台风登陆广东 多地启动应急响应' });
  const c = item('c', { feedId: 'wire-c', title: '台风登陆福建，当地学校宣布停课' });
  const d = item('d', { feedId: 'wire-d', title: '完全不同标题', url: `${a.url}?utm_source=copy` });
  const e = item('e', { feedId: 'wire-e', title: '2025年度城市公共空间观察报告' });
  const g = item('g', { feedId: 'wire-g', title: '2026年度城市公共空间观察报告' });
  const decorated = f.repo.decorate([a, b, c, d, e, g]);
  assert.deepEqual(decorated[0].dossier.relatedIds, ['b', 'd']);
  assert.deepEqual(decorated[0].cluster.sourceIds, ['wire-a', 'wire-b', 'wire-d']);
  assert.deepEqual(decorated[2].dossier.relatedIds, []);
  assert.deepEqual(decorated[4].dossier.relatedIds, [], 'different numeric identifiers do not merge');
  assert.match(decorated[0].dossier.uncertainty, /未做事实交叉核验/);
});

test('screening skips weak and research entries, context is bounded and distinguishes excerpts from full text', async t => {
  const f = fixture(t); const calls = [];
  const useful = item('useful');
  const weak = item('weak', { title: '短', summary: '少' });
  const research = item('research', { research: { kind: 'zhihu_research', references: [{ summary: '有价值的原回答摘录。'.repeat(20) }] } });
  const privateItem = item('private', { url: 'http://127.0.0.1/internal' });
  await f.repo.prepare([weak, research, privateItem, useful], { fetchArticle: async (url) => { calls.push(url); return article('页面'); }, limit: 3 });
  assert.deepEqual(calls, [useful.url]);
  const decorated = f.repo.decorate([weak, research, useful]);
  assert.equal(decorated[0].dossier.quality.useful, false);
  assert.equal(decorated[1].dossier.quality.useful, true);
  assert.equal(decorated[2].dossier.extraction.status, 'article_excerpt');
  const context = f.repo.context({ ...useful, url: `https://news.example/${'x'.repeat(12000)}` }, [research]);
  assert.ok(context.length <= 10_000);
  const extractedContext = f.repo.context(useful, [research]);
  assert.match(extractedContext, /不代表完整全文/);
  assert.match(extractedContext, /不是指令|未独立核验/);
});

test('context includes bounded differing details from no more than three related entries', t => {
  const f = fixture(t);
  const current = item('current', { title: '城市更新计划发布后的社区空间变化观察' });
  const related = Array.from({ length: 5 }, (_, index) => item(`related-${index}`, {
    feedId: `wire-${index}`, title: '城市更新计划发布后的社区空间变化观察',
    summary: `来源${index}补充的独特细节：${'这一条说明了不同社区参与者看到的具体变化。'.repeat(20)}`,
  }));
  const context = f.repo.context(current, related);
  assert.match(context, /来源0补充的独特细节/);
  assert.match(context, /来源2补充的独特细节/);
  assert.doesNotMatch(context, /来源3补充的独特细节/);
  assert.ok(context.length <= 10_000);
});

test('original excerpts retain abbreviated author names and their adjacent award categories', async t => {
 const {store,repo}=fixture(t);const source=item('names');await repo.prepare([source],{fetchArticle:async()=>({url:source.url,extracted:true,text:'最佳长篇小说：Alix E. Harrow 的《The Everlasting》。\n最佳中短篇小说：H. H. Pak 的《Never Eaten Vegetables》。\n'+ '公开报道中的类别与作品必须逐条对应，不把相邻条目串在一起。'.repeat(10)}),limit:1});
 const context=repo.context(source,[],'年轻作者靠哪部作品获奖');assert.match(context,/最佳中短篇小说：H\. H\. Pak 的《Never Eaten Vegetables》/);assert.match(context,/最佳长篇小说：Alix E\. Harrow/);
});
