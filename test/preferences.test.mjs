import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createApp } from '../server.mjs';

const appDataDir = path.resolve('app-data');
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JXusAAAAASUVORK5CYII=';
const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function start(t, options = {}) {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'life-preferences-'));
  const app = await createApp({ appDataDir, dataDir, initialFeeds: [], startProactive: false, startRecall: false, integrations: { fetchFeed: async () => ({ items: [] }) }, env: { LIFE_MODEL_BASE_URL: 'https://model.test/v1', LIFE_MODEL_NAME: 'fixture' }, fetchImpl: async () => Response.json({ choices: [{ message: { content: '回复' } }] }), ...options });
  const address = await app.listen(0); const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); if (!options.keepData) fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { app, base, dataDir };
}
async function request(base, pathname, options) {
  const response = await fetch(`${base}${pathname}`, options);
  return { status: response.status, body: await response.json() };
}

test('history window preferences enforce boundaries and reject an invalid patch atomically', async t => {
  const { base } = await start(t, { replySleep: async () => {} });
  const initial = (await request(base, '/api/preferences')).body;
  assert.equal(initial.historyWindowDays, 7);
  assert.equal(initial.historyMaxTokens, 60000);

  const updated = (await request(base, '/api/preferences', json({ historyWindowDays: 14, historyMaxTokens: 120000 }))).body;
  assert.equal(updated.historyWindowDays, 14);
  assert.equal(updated.historyMaxTokens, 120000);

  const partial = (await request(base, '/api/preferences', json({ historyWindowDays: 3 }))).body;
  assert.equal(partial.historyWindowDays, 3);
  assert.equal(partial.historyMaxTokens, 120000);

  assert.equal((await request(base, '/api/preferences', json({ historyWindowDays: 1, historyMaxTokens: 1000 }))).status, 200);
  assert.equal((await request(base, '/api/preferences', json({ historyWindowDays: 30, historyMaxTokens: 200000 }))).status, 200);
  assert.equal((await request(base, '/api/preferences', json({ historyWindowDays: 0 }))).status, 400);
  assert.equal((await request(base, '/api/preferences', json({ historyWindowDays: 31 }))).status, 400);
  assert.equal((await request(base, '/api/preferences', json({ historyMaxTokens: 500 }))).status, 400);
  assert.equal((await request(base, '/api/preferences', json({ historyMaxTokens: 300000 }))).status, 400);
  assert.equal((await request(base, '/api/preferences', json({}))).status, 400);

  assert.equal((await request(base, '/api/preferences', json({ historyWindowDays: 7, historyMaxTokens: 999 }))).status, 400);
  const after = (await request(base, '/api/preferences')).body;
  assert.equal(after.historyWindowDays, 30);
  assert.equal(after.historyMaxTokens, 200000);
  assert.equal((await request(base, '/api/preferences', json({ historyWindowDays: 0, historyMaxTokens: 60000 }))).status, 400);
  const afterSecondInvalidPatch = (await request(base, '/api/preferences')).body;
  assert.equal(afterSecondInvalidPatch.historyWindowDays, 30);
  assert.equal(afterSecondInvalidPatch.historyMaxTokens, 200000);
});

test('legacy preference databases migrate history defaults and retain saved values after restart', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-preferences-legacy-'));
  const db = new DatabaseSync(path.join(dataDir, 'life.sqlite'));
  db.exec("CREATE TABLE preferences (id INTEGER PRIMARY KEY CHECK(id=1), reply_pace TEXT NOT NULL CHECK(reply_pace IN ('natural', 'instant'))); INSERT INTO preferences(id, reply_pace) VALUES(1, 'instant');");
  db.close();

  const first = await start(t, { dataDir, keepData: true, replySleep: async () => {} });
  assert.deepEqual((await request(first.base, '/api/preferences')).body, { replyPace: 'instant', avatars: {}, historyWindowDays: 7, historyMaxTokens: 60000 });
  assert.equal((await request(first.base, '/api/preferences', json({ historyWindowDays: 18, historyMaxTokens: 150000 }))).status, 200);
  await first.app.close();

  const second = await createApp({ appDataDir, dataDir, initialFeeds: [], startProactive: false, startRecall: false, replySleep: async () => {} });
  const address = await second.listen(0);
  t.after(async () => { await second.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  assert.deepEqual((await request(`http://127.0.0.1:${address.port}`, '/api/preferences')).body, { replyPace: 'instant', avatars: {}, historyWindowDays: 18, historyMaxTokens: 150000 });
});

test('preferences default to natural, persist avatars, and reject invalid images without mutation', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-preferences-persist-'));
  const first = await start(t, { dataDir, keepData: true, replySleep: async () => {} });
  assert.deepEqual((await request(first.base, '/api/preferences')).body, { replyPace: 'natural', avatars: {}, historyWindowDays: 7, historyMaxTokens: 60000 });
  assert.deepEqual((await request(first.base, '/api/preferences', json({ roleId: 'miyue', avatar: png }))).body, { replyPace: 'natural', avatars: { miyue: png }, historyWindowDays: 7, historyMaxTokens: 60000 });
  const invalid = await request(first.base, '/api/preferences', json({ roleId: 'miyue', avatar: 'data:image/svg+xml;base64,PHN2Zy8+' }));
  assert.equal(invalid.status, 400);
  assert.equal((await request(first.base, '/api/preferences', json({ roleId: 'unknown', avatar: png }))).status, 400);
  assert.equal((await request(first.base, '/api/preferences', json({ roleId: 'miyue', avatar: `data:image/png;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(400 * 1024)]).toString('base64')}` }))).status, 400);
  assert.equal((await request(first.base, '/api/preferences', json({ roleId: 'miyue', avatar: png.replace('image/png', 'image/jpeg') }))).status, 400);
  assert.deepEqual((await request(first.base, '/api/preferences')).body, { replyPace: 'natural', avatars: { miyue: png }, historyWindowDays: 7, historyMaxTokens: 60000 });
  assert.deepEqual((await request(first.base, '/api/preferences', json({ replyPace: 'instant' }))).body, { replyPace: 'instant', avatars: { miyue: png }, historyWindowDays: 7, historyMaxTokens: 60000 });
  assert.deepEqual((await request(first.base, '/api/preferences', json({ roleId: 'miyue', avatar: null }))).body, { replyPace: 'instant', avatars: {}, historyWindowDays: 7, historyMaxTokens: 60000 });
  await first.app.close();
  const second = await createApp({ appDataDir, dataDir, initialFeeds: [], startProactive: false, startRecall: false, replySleep: async () => {} });
  const address = await second.listen(0);
  t.after(async () => { await second.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  assert.deepEqual((await request(`http://127.0.0.1:${address.port}`, '/api/preferences')).body, { replyPace: 'instant', avatars: {}, historyWindowDays: 7, historyMaxTokens: 60000 });
});

test('natural pacing counts model time and instant pacing never sleeps', async t => {
  let now = 0; let call = 0; const sleeps = [];
  const { base } = await start(t, {
    replyNow: () => now, replyRandom: () => 0,
    replySleep: async ms => { sleeps.push(ms); },
    fetchImpl: async () => {
      call += 1;
      if (call === 1) now = 3500;
      if (call === 3) now = 4500;
      if (call === 4) return new Response('failed', { status: 500 });
      return Response.json({ choices: [{ message: { content: '回复' } }] });
    },
  });
  assert.equal((await request(base, '/api/chat', json({ role: 'miyue', text: '你好' }))).status, 200);
  assert.deepEqual(sleeps, [500]);
  assert.equal((await request(base, '/api/preferences', json({ replyPace: 'instant' }))).status, 200);
  now = 0;
  assert.equal((await request(base, '/api/chat', json({ role: 'miyue', text: '再见' }))).status, 200);
  assert.deepEqual(sleeps, [500]);
  await request(base, '/api/preferences', json({ replyPace: 'natural' }));
  now = 0;
  assert.equal((await request(base, '/api/chat', json({ role: 'miyue', text: '模型很慢' }))).status, 200);
  assert.deepEqual(sleeps, [500]);
  now = 0;
  assert.equal((await request(base, '/api/chat', json({ role: 'miyue', text: '模型失败' }))).status, 502);
  assert.deepEqual(sleeps, [500]);
});

test('a paced reply remains busy and hidden until its turn commits', { timeout: 5000 }, async t => {
  let release; let sleeping;
  const sleepStarted = new Promise(resolve => { sleeping = resolve; });
  const { base } = await start(t, { replyRandom: () => 0, replySleep: (_ms, signal) => new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal?.addEventListener('abort', abort, { once: true });
    release = () => { signal?.removeEventListener('abort', abort); resolve(); };
    sleeping();
  }) });
  const pending = request(base, '/api/chat', json({ role: 'miyue', text: '等一下' }));
  await sleepStarted;
  try {
    assert.equal((await request(base, '/api/chat', json({ role: 'miyue', text: '第二句' }))).status, 409);
    assert.deepEqual((await request(base, '/api/conversations/miyue')).body.messages, []);
  } finally { release(); }
  assert.equal((await pending).status, 200);
  assert.equal((await request(base, '/api/conversations/miyue')).body.messages.length, 2);
});
