import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

test('default startup leaves existing reading dormant while preserving named discussion', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pursuits-disabled-'));
  let now = new Date('2026-09-07T01:00:00Z');
  const options = {
    dataDir, initialFeeds: [], env: {}, clock: () => new Date(now), random: () => .5,
    startProactive: false, startRecall: false, startRuntime: false,
    startLifeThreads: false, startChatQueue: false,
    integrations: { fetchFeed: async () => ({ items: [] }) },
  };
  let app;
  t.after(async () => {
    await app?.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  app = await createApp({ ...options, startPursuits: true });
  app.pursuits.prepareSession({ current: { kind: 'home', remainingMinutes: 120 } });
  const pursuit = app.pursuits.get('miyue');
  const rows = app.store.saveChatTurn({ role: 'miyue', text: '你读到哪里了？', reply: pursuit.stage.action });
  const message = rows.at(-1);
  assert.equal(app.pursuits.markDelivered(pursuit.pendingKey, message.id, pursuit.version), true);
  app.sharedExperiences.record('miyue', message.id, {
    key: pursuit.pendingKey, kind: pursuit.kind, title: pursuit.title, aliases: pursuit.aliases,
    summary: pursuit.stage.action, detail: pursuit.stage.detail, source: pursuit.source,
  });
  const savedState = app.store.db.prepare('SELECT * FROM companion_pursuit_state').all();
  const savedDeliveries = app.store.db.prepare('SELECT * FROM companion_pursuit_deliveries').all();
  await app.close();

  now = new Date('2026-09-10T01:00:00Z');
  app = await createApp(options);
  const { port } = await app.listen(0);
  assert.equal(app.pursuits, null);
  const life = await (await fetch(`http://127.0.0.1:${port}/api/life`)).json();
  assert.equal(life.pursuit, null);
  for (const request of [
    { initiating: true },
    { initiating: false, text: '换个话题，今天午饭吃什么？' },
    { initiating: false, text: '最近在读什么书？' },
  ]) {
    const context = app.roleContext('miyue', request);
    assert.equal(context.pursuit, undefined);
    assert.equal(context.pursuitView, undefined);
    assert.equal(context.pursuitRoute, undefined);
    const digest = context.characterContext.split('【林晓薇近期经历简记｜虚构角色连续性】')[1]?.split('【')[0] || '';
    assert.doesNotMatch(digest, /百草园|三味书屋|重读开头/);
    assert.doesNotMatch(context.characterContext, /正在持续进行的阅读/);
  }
  const named = app.roleContext('miyue', { initiating: false, text: '百草园里石井栏那段为什么让你在意？' });
  assert.match(named.characterContext, /石井栏/);
  assert.equal(named.sharedExperience?.title, pursuit.title);
  assert.deepEqual(app.store.db.prepare('SELECT * FROM companion_pursuit_state').all(), savedState);
  assert.deepEqual(app.store.db.prepare('SELECT * FROM companion_pursuit_deliveries').all(), savedDeliveries);
  assert.equal(app.store.getMessage(message.id).text, message.text);
});
