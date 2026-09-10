import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { MomentsRepository, momentLimits } from '../lib/moments.mjs';

const story = { start: 'start', nodes: { start: { id: 'start', title: 'start', body: '', choices: [] } } };

function openStore(dataDir) {
  return new Store({ dataDir, story, initialFeeds: [] });
}

function tempDir(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-moments-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function message(id, role = 'zhixia', speaker = 'assistant', text = `text for ${id}`) {
  return { id, role, speaker, text };
}

function insertMessage(store, value) {
  store.db.prepare(`
    INSERT INTO messages(id,role,speaker,text,kind,content_id,created_at)
    VALUES(?,?,?,?, 'chat', NULL, ?)
  `).run(value.id, value.role, value.speaker, value.text, new Date().toISOString());
}

test('moments persist, list newest first, and stay isolated by role', (t) => {
  const dataDir = tempDir(t);
  let store = openStore(dataDir);
  let repo = new MomentsRepository(store);
  const first = message('first', 'zhixia', 'user');
  const second = message('second', 'wenxi', 'assistant');
  const third = message('third', 'zhixia', 'assistant');
  repo.save(first);
  repo.save(second, { caption: '闻溪的条目' });
  repo.save(third, { image: 'local-image-token' });
  assert.deepEqual(repo.list().map((item) => item.messageId), ['third', 'second', 'first']);
  assert.deepEqual(repo.list({ roleId: 'zhixia' }).map((item) => item.messageId), ['third', 'first']);
  assert.deepEqual(repo.list({ roleId: 'wenxi' }).map((item) => item.messageId), ['second']);
  store.close();

  store = openStore(dataDir);
  repo = new MomentsRepository(store);
  assert.equal(repo.list().length, 3);
  assert.equal(repo.list()[0].image, 'local-image-token');
  assert.equal(repo.list({ roleId: 'wenxi' })[0].caption, '闻溪的条目');
  store.close();
});

test('idempotent save refreshes the snapshot but preserves omitted artwork fields', (t) => {
  const store = openStore(tempDir(t));
  t.after(() => store.close());
  const repo = new MomentsRepository(store);
  const original = message('same');
  const saved = repo.save(original, { image: 'image-a', caption: '最初说明' });
  const repeated = repo.save({ ...original, text: 'edited source text' });
  assert.equal(repeated.messageId, saved.messageId);
  assert.equal(repeated.createdAt, saved.createdAt);
  assert.equal(repeated.text, 'edited source text');
  assert.equal(repeated.image, 'image-a');
  assert.equal(repeated.caption, '最初说明');
  assert.equal(repo.list().length, 1);

  const cleared = repo.save({ ...original, text: 'final source text' }, { image: null, caption: '' });
  assert.equal(cleared.image, null);
  assert.equal(cleared.caption, '');
  assert.equal(cleared.text, 'final source text');
});

test('updates patch only supplied fields and reject invalid patches atomically', (t) => {
  const store = openStore(tempDir(t));
  t.after(() => store.close());
  const repo = new MomentsRepository(store);
  repo.save(message('patch'), { image: 'image-a', caption: 'caption-a' });
  assert.deepEqual(repo.update('patch', { image: 'image-b' }), {
    ...repo.list()[0], image: 'image-b', caption: 'caption-a',
  });
  const beforeFailure = repo.list()[0];
  assert.throws(
    () => repo.update('patch', { image: null, caption: '字'.repeat(momentLimits.maxCaptionLength + 1) }),
    { code: 'INVALID_MOMENT_CAPTION' },
  );
  assert.deepEqual(repo.list()[0], beforeFailure);
  assert.equal(repo.update('patch', { caption: 'caption-b' }).image, 'image-b');
  assert.equal(repo.update('missing', { caption: 'unused' }), null);
});

test('the global item limit permits existing upserts and frees capacity after removal', (t) => {
  const store = openStore(tempDir(t));
  t.after(() => store.close());
  const repo = new MomentsRepository(store);
  for (let index = 0; index < momentLimits.maxItems; index += 1) repo.save(message(`saved-${index}`));
  assert.equal(repo.list().length, momentLimits.maxItems);
  assert.throws(() => repo.save(message('overflow')), { code: 'MOMENT_LIMIT_REACHED' });
  assert.equal(repo.save(message('saved-0'), { caption: 'still allowed' }).caption, 'still allowed');
  assert.equal(repo.remove('saved-1'), true);
  assert.equal(repo.save(message('overflow')).messageId, 'overflow');
  assert.equal(repo.list().length, momentLimits.maxItems);
});

test('removing a scrapbook entry never removes its original chat message', (t) => {
  const store = openStore(tempDir(t));
  t.after(() => store.close());
  const repo = new MomentsRepository(store);
  const original = message('original-chat', 'miyue', 'user', '原始聊天仍应保留');
  insertMessage(store, original);
  repo.save(store.getMessage(original.id), { caption: '收藏快照' });
  assert.equal(repo.remove(original.id), true);
  assert.equal(repo.remove(original.id), false);
  assert.equal(repo.list().length, 0);
  assert.equal(store.getMessage(original.id).text, original.text);
});

test('save validates source shape and caption length before writing', (t) => {
  const store = openStore(tempDir(t));
  t.after(() => store.close());
  const repo = new MomentsRepository(store);
  assert.throws(() => repo.save(message('system', 'zhixia', 'system')), { code: 'INVALID_MOMENT_MESSAGE' });
  assert.throws(
    () => repo.save(message('too-long'), { caption: 'x'.repeat(momentLimits.maxCaptionLength + 1) }),
    { code: 'INVALID_MOMENT_CAPTION' },
  );
  assert.equal(repo.list().length, 0);
});
