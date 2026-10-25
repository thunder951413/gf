import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-page-'));
  let tick = Date.parse('2026-10-01T00:00:00Z');
  const app = await createApp({ dataDir, activeRoleIds: ['miyue'], disableStory: true, startDiscovery: false, initialFeeds: [], startWeixin: false, startChatQueue: false,
    startProactive: false, startRecall: false, startResearch: false, startLife: false, startRuntime: false, startDailyLife: false, startLifeThreads: false, startPursuits: false, startDossiers: false,
    clock: () => new Date(tick += 1000), env: {} });
  for (let i = 0; i < 10; i++) app.store.saveChatTurn({ role: 'miyue', text: `问${i}`, reply: `答${i}` });
  const { port } = await app.listen(0);
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return async route => (await fetch(`http://127.0.0.1:${port}${route}`)).json();
}

test('conversation pages return the newest window in order, then earlier pages, with hasMore', async t => {
  const get = await fixture(t);
  const all = await get('/api/conversations/miyue');
  assert.equal(all.messages.length, 20); assert.equal(all.hasMore, false);
  const latest = await get('/api/conversations/miyue?limit=6');
  assert.deepEqual(latest.messages.map(m => m.text), ['问7', '答7', '问8', '答8', '问9', '答9']);
  assert.equal(latest.hasMore, true);
  assert.ok(latest.pending);
  const earlier = await get(`/api/conversations/miyue?limit=6&before=${latest.messages[0].id}`);
  assert.deepEqual(earlier.messages.map(m => m.text), ['问4', '答4', '问5', '答5', '问6', '答6']);
  const first = await get(`/api/conversations/miyue?limit=6&before=${all.messages[4].id}`);
  assert.deepEqual(first.messages.map(m => m.text), ['问0', '答0', '问1', '答1']); assert.equal(first.hasMore, false);
  const unknown = await get('/api/conversations/miyue?limit=6&before=missing');
  assert.deepEqual(unknown.messages, []); assert.equal(unknown.hasMore, false);
});
