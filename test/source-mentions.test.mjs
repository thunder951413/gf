import test from 'node:test';
import assert from 'node:assert/strict';
import { mentionedSources } from '../lib/source-mentions.mjs';

const suzhou = {
  contentId: 'suzhou',
  title: '苏州这座城市是不是过誉了? - 知乎｜知乎观点',
  url: 'https://www.zhihu.com/question/12345?utm_source=feed',
};
const other = { id: 'other', title: '上海适合周末散步的老街', url: 'https://example.com/shanghai' };

test('matches a quoted substantive title after publisher suffixes are removed', () => {
  assert.deepEqual(mentionedSources('来源是《苏州这座城市是不是过誉了? - 知乎｜知乎观点》。', [suzhou, other]), [suzhou]);
  assert.deepEqual(mentionedSources('我想接着聊“苏州这座城市是不是过誉了？”这篇。', [suzhou, other]), [suzhou]);
  assert.deepEqual(mentionedSources('下午那条“苏州是不是过誉了”的讨论我后来又想了一会儿。', [suzhou, other]), [suzhou]);
  assert.deepEqual(mentionedSources('苏州的美食是不是很好吃？', [suzhou, other]), []);
});

test('normalizes title punctuation and whitespace', () => {
  const source = { id: 'punctuation', title: 'AI：怎样改变城市生活？｜知乎观点', url: 'https://example.com/ai-city' };
  assert.deepEqual(mentionedSources('就《AI 怎样改变 城市生活》而言，我同意。', [source]), [source]);
});

test('matches canonical source URLs after tracking parameters are removed', () => {
  const source = { id: 'url', title: '不会被标题提及的长文章', url: 'https://example.com/story?a=1&utm_source=rss#section' };
  assert.deepEqual(mentionedSources('来源是 https://example.com/story?utm_medium=email&a=1 。', [source]), [source]);
});

test('does not attribute short or unrelated titles from ordinary conversation', () => {
  const short = { id: 'short', title: 'AI', url: 'https://example.com/ai' };
  const broad = { id: 'broad', title: '新闻', url: 'https://example.com/news' };
  assert.deepEqual(mentionedSources('AI 最近发展很快，今天有什么新闻？', [short, broad, other]), []);
  assert.deepEqual(mentionedSources('我想去苏州散步，也想看看上海的建筑。', [suzhou, other]), []);
});
