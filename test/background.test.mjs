import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

const appDataDir = path.resolve('app-data');
const defaults = { image: null, mode: 'cover', position: 'center', veil: 0.35, blur: 0 };
const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9JXusAAAAASUVORK5CYII=';
const json = body => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function start(t, options = {}) {
  const dataDir = options.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'life-background-'));
  const app = await createApp({ appDataDir, dataDir, initialFeeds: [], startProactive: false, startRecall: false, integrations: { fetchFeed: async () => ({ items: [] }) }, ...options });
  const address = await app.listen(0); const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); if (!options.keepData) fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { app, base, dataDir };
}
async function request(base, pathname, options) {
  const response = await fetch(`${base}${pathname}`, options);
  return { status: response.status, body: await response.json() };
}

test('background defaults, persists across reopen, and resets with the default object', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-background-reopen-'));
  const first = await start(t, { dataDir, keepData: true });
  assert.deepEqual((await request(first.base, '/api/background')).body, defaults);
  const saved = { image: png, mode: 'tile', position: 'bottom', veil: 0.6, blur: 4 };
  assert.deepEqual((await request(first.base, '/api/background', json(saved))).body, saved);
  await first.app.close();
  const second = await createApp({ appDataDir, dataDir, initialFeeds: [], startProactive: false, startRecall: false, integrations: { fetchFeed: async () => ({ items: [] }) } });
  const address = await second.listen(0); const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await second.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  assert.deepEqual((await request(base, '/api/background')).body, saved);
  assert.deepEqual((await request(base, '/api/background', json(defaults))).body, defaults);
});

test('background rejects invalid full objects without mutation and leaves preferences separate', async t => {
  const { base } = await start(t);
  const saved = { image: png, mode: 'contain', position: 'top', veil: 0.2, blur: 2 };
  await request(base, '/api/background', json(saved));
  const bad = [
    { ...saved, image: 'data:image/jpeg;base64,iVBORw0KGgo=' },
    { ...saved, image: 'data:image/svg+xml;base64,PHN2Zy8+' },
    { ...saved, mode: 'repeat' }, { ...saved, position: 'left' },
    { ...saved, veil: Infinity }, { ...saved, blur: 13 },
    { image: null, mode: 'cover', position: 'center', veil: 0.35 },
    { ...saved, extra: true },
  ];
  for (const value of bad) assert.equal((await request(base, '/api/background', json(value))).status, 400);
  const oversized = `data:image/png;base64,${Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(2 * 1024 * 1024)]).toString('base64')}`;
  assert.equal((await request(base, '/api/background', json({ ...saved, image: oversized }))).status, 400);
  assert.deepEqual((await request(base, '/api/background')).body, saved);
  assert.deepEqual((await request(base, '/api/preferences')).body, { replyPace: 'natural', avatars: {} });
});

test('background has a three-megabyte request limit', async t => {
  const { base } = await start(t);
  const response = await fetch(`${base}/api/background`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: `data:image/png;base64,${'A'.repeat(3_200_000)}`, mode: 'cover', position: 'center', veil: 0.35, blur: 0 }) });
  assert.equal(response.status, 413);
  assert.deepEqual((await request(base, '/api/background')).body, defaults);
});
