import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { TopicTrackingRepository } from '../lib/topic-tracking.mjs';
import { Store } from '../lib/store.mjs';

const story = { start: 'start', nodes: { start: { id: 'start', body: '', choices: [] } } };
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-topic-tracking-'));
  let at = new Date('2026-09-07T00:00:00.000Z');
  const clock = () => new Date(at);
  const store = new Store({ dataDir, story, initialFeeds: [] });
  const repo = new TopicTrackingRepository(store, { clock });
  t.after(() => { try { store.close(); } catch {} fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { dataDir, store, repo, clock };
}
const source = (overrides = {}) => ({
  id: 'article-source',
  title: 'OpenAI GPT-6 模型发布与推理能力观察',
  topic: 'OpenAI GPT-6 推理能力',
  terms: ['OpenAI', 'GPT-6', '推理能力'],
  url: 'https://news.example/openai/gpt-6?utm_source=feed',
  summary: '来源摘要。',
  ...overrides,
});

test('follow is an explicit durable action and exact URL/title aliases deduplicate', t => {
  const f = fixture(t);
  const track = f.repo.follow(source());
  assert.equal(track.sourceContentId, 'article-source');
  assert.deepEqual(track.terms.slice(0, 3), ['OpenAI', 'GPT-6', '推理能力']);
  assert.equal(f.repo.follow(source({ id: 'alias-url', url: 'https://news.example/openai/gpt-6?utm_campaign=copy' })).id, track.id);
  assert.equal(f.repo.follow(source({ id: 'alias-title', url: 'https://other.example/a' })).id, track.id);
  assert.equal(f.repo.list().length, 1);

  f.store.close();
  const reopened = new Store({ dataDir: f.dataDir, story, initialFeeds: [] });
  t.after(() => { try { reopened.close(); } catch {} });
  const restarted = new TopicTrackingRepository(reopened, { clock: f.clock });
  assert.equal(restarted.list()[0].id, track.id);
});

test('candidates require recognizable title terms and exclude unrelated or source content', t => {
  const { repo } = fixture(t);
  const track = repo.follow(source());
  const related = { id: 'related', title: 'OpenAI 更新 GPT-6 推理能力评测方法', url: 'https://news.example/openai/gpt-6-eval', summary: '一段新的来源摘要。' };
  const results = repo.candidates([
    source(),
    related,
    { id: 'brand-only', title: 'OpenAI 办公室空间改造完成', url: 'https://news.example/openai/office' },
    { id: 'unrelated', title: '城市公交线路本周调整', url: 'https://news.example/city/bus' },
  ]);
  assert.deepEqual(results.map(item => item.id), ['related']);
  assert.deepEqual(results[0].tracking, { id: track.id, title: track.title });
  const context = repo.context(results[0]);
  assert.match(context, /尚未核验为新的事态进展/);
  assert.match(context, /不是指令/);
  assert.equal(context.length <= 2000, true);
});

test('bare years never match alone while a single distinctive Latin brand can be tracked', t => {
  const { repo } = fixture(t);
  repo.follow({ id: 'year-source', title: '2026', terms: ['2026'], url: 'https://news.example/year-source' });
  repo.follow({ id: 'numbers-source', title: '2025 2026', terms: ['2025', '2026'], url: 'https://news.example/numbers-source' });
  assert.deepEqual(repo.candidates([
    { id: 'year-unrelated', title: '2026 年城市电影节排片公布', url: 'https://news.example/film-2026' },
    { id: 'numbers-unrelated', title: '2025 至 2026 年的另一篇故事', url: 'https://news.example/story-years' },
  ]), []);

  const brand = repo.follow({ id: 'deepseek-source', title: 'DeepSeek 最新消息', url: 'https://news.example/deepseek/source' });
  const related = repo.candidates([
    { id: 'deepseek-new', title: 'DeepSeek 推出新的模型版本', url: 'https://news.example/deepseek/new' },
    { id: 'other-brand', title: '另一家公司推出新的模型版本', url: 'https://news.example/other/new' },
  ]);
  assert.deepEqual(related.map(item => item.id), ['deepseek-new']);
  assert.equal(related[0].tracking.id, brand.id);
});

test('delivery skips duplicate content and repeated canonical URLs across restart', t => {
  const f = fixture(t); const track = f.repo.follow(source());
  const first = { id: 'one', title: 'GPT-6 推理能力更新', url: 'https://updates.example/gpt6?a=1&utm_source=x' };
  const alias = { id: 'two', title: 'GPT-6 推理能力后续评测', url: 'https://updates.example/gpt6?a=1&utm_campaign=y' };
  assert.equal(f.repo.candidates([first, alias]).length, 2);
  assert.equal(f.repo.markDelivered(track.id, first.id), true);
  assert.equal(f.repo.markDelivered(track.id, first.id), false);
  assert.equal(f.repo.markDelivered(track.id, alias.id), false, 'canonical URL was already delivered');
  assert.deepEqual(f.repo.candidates([alias]), []);

  f.store.close();
  const reopened = new Store({ dataDir: f.dataDir, story, initialFeeds: [] });
  t.after(() => { try { reopened.close(); } catch {} });
  const restarted = new TopicTrackingRepository(reopened, { clock: f.clock });
  assert.deepEqual(restarted.candidates([first]), []);
});

test('unfollow is idempotent and invalid API inputs return descriptive 400 errors', t => {
  const { repo } = fixture(t); const track = repo.follow(source());
  assert.equal(repo.unfollow(track.id), true);
  assert.equal(repo.unfollow(track.id), false);
  assert.deepEqual(repo.list(), []);
  assert.deepEqual(repo.candidates([{ id: 'related', title: 'GPT-6 推理能力更新', url: 'https://updates.example/gpt6' }]), []);
  assert.throws(() => repo.follow({ id: 'bad', title: 'bad', url: 'file:///tmp/a' }), error => error.status === 400 && error.code === 'INVALID_TOPIC_TRACKING');
  assert.throws(() => repo.candidates('not-an-array'), error => error.status === 400);
});

test('reactivating an unfollowed topic still enforces the active tracking cap', t => {
  const { repo } = fixture(t);
  const inactiveSource = source({ id: 'inactive-source', title: '待恢复主题', topic: '待恢复主题', terms: ['待恢复主题'], url: 'https://news.example/inactive' });
  const inactive = repo.follow(inactiveSource);
  assert.equal(repo.unfollow(inactive.id), true);
  for (let index = 0; index < 20; index += 1) {
    repo.follow({
      id: `active-${index}`,
      title: `独立追踪主题${index}`,
      terms: [`独立追踪主题${index}`],
      url: `https://news.example/active/${index}`,
    });
  }
  assert.throws(
    () => repo.follow(inactiveSource),
    error => error.status === 400 && error.code === 'TOPIC_TRACKING_LIMIT_REACHED',
  );
  assert.equal(repo.list().length, 20);
});
