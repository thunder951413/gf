import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { EpisodicMemoryRepository } from '../lib/episodic-memory.mjs';
import { lookupUserEvidence, relativeDateAnnotations } from '../lib/memory-lookup.mjs';

const story = { start: 'start', nodes: { start: { id: 'start', title: 'start', body: '', choices: [] } } };

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-lookup-'));
  const store = new Store({ dataDir, story, initialFeeds: [] });
  const episodes = new EpisodicMemoryRepository(store);
  t.after(() => { store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { store, episodes };
}

function addUser(store, { id, text, at }) {
  store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,content_id,created_at) VALUES(?,?,?,?,?,NULL,?)')
    .run(id, 'miyue', 'user', text, 'chat', at);
}

test('relative dates use the original message Beijing calendar across a UTC day boundary', () => {
  assert.deepEqual(relativeDateAnnotations('明天中午去汕头。', '2026-09-12T16:30:00.000Z'), [
    '原话中的“明天”按该消息北京时间 2026-09-13 00:30 对应 2026-09-14（星期一）',
  ]);
});

test('a content-matched recall annotates an actual relative-date source without inventing transport facts', t => {
  const { store, episodes } = fixture(t);
  addUser(store, { id: 'shantou-plan', text: '9月12日说明天中午去汕头。', at: '2026-09-12T04:00:00.000Z' });
  const result = lookupUserEvidence(store, episodes, 'miyue', '我周六去汕头的安排是什么来着？', { now: '2026-09-12T05:00:00.000Z' });
  assert.deepEqual(result.rows.map(row => row.id), ['shantou-plan']);
  assert.match(result.context, /原话中的“明天”按该消息北京时间 2026-09-12 12:00 对应 2026-09-13（星期日）/);
  assert.match(result.context, /当前北京时间为 2026-09-12（星期六）/);
  assert.match(result.context, /9月12日说明天中午去汕头/);
  assert.doesNotMatch(result.context, /车次|赶车|订好|车票/);
});

test('weekday words do not retrieve unrelated relative-date messages as travel evidence', t => {
  const { store, episodes } = fixture(t);
  addUser(store, { id: 'quiet', text: '今天周六，我不太想聊。', at: '2026-09-12T04:00:00.000Z' });
  addUser(store, { id: 'changed-mind', text: '今天有没有改变主意的瞬间？', at: '2026-09-12T04:01:00.000Z' });
  const result = lookupUserEvidence(store, episodes, 'miyue', '我周六要赶哪个车来着？', { now: '2026-09-12T05:00:00.000Z' });
  assert.deepEqual(result.rows, []);
  assert.match(result.context, /没有查到与当前问题匹配的用户原话/);
  assert.doesNotMatch(result.context, /今天周六|改变主意|中午|车次|车票/);
});

test('ambiguous relative wording remains raw text without an absolute-date annotation', t => {
  const { store, episodes } = fixture(t);
  addUser(store, { id: 'ambiguous', text: '过两天或者周末再看看汕头。', at: '2026-09-12T04:00:00.000Z' });
  const result = lookupUserEvidence(store, episodes, 'miyue', '汕头什么时候来着？');
  assert.match(result.context, /过两天或者周末再看看汕头/);
  assert.doesNotMatch(result.context, /原话中的“/);
  assert.deepEqual(relativeDateAnnotations('过两天或者周末再看看', '2026-09-12T04:00:00.000Z'), []);
});
