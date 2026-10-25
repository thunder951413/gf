import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
import { sessionValue } from '../lib/access-control.mjs';
import { networkConfig } from '../lib/network-config.mjs';

const TOKEN = 'a-long-enough-access-token-for-tests';
const base = { activeRoleIds: ['miyue'], disableStory: true, startDiscovery: false, initialFeeds: [], startWeixin: false, startChatQueue: false, startProactive: false,
  startRecall: false, startResearch: false, startLife: false, startRuntime: false, startDailyLife: false, startLifeThreads: false, startPursuits: false, startDossiers: false, env: {} };

async function fixture(t, extra) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-'));
  const app = await createApp({ ...base, dataDir, ...extra });
  const { port } = await app.listen(0);
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return (route, init = {}) => fetch(`http://127.0.0.1:${port}${route}`, { redirect: 'manual', ...init });
}

test('without a token nothing changes', async t => {
  const get = await fixture(t, {});
  assert.equal((await get('/api/conversations/miyue')).status, 200);
});

test('with a token, remote requests need the bearer token or the login cookie; loopback stays open unless required', async t => {
  const get = await fixture(t, { accessToken: TOKEN, accessLocal: true });
  const denied = await get('/api/conversations/miyue');
  assert.equal(denied.status, 401); assert.equal((await denied.json()).code, 'AUTH_REQUIRED');
  const page = await get('/');
  assert.equal(page.status, 302); assert.match(page.headers.get('location'), /^\/login\?next=%2F/);
  assert.equal((await get('/login')).status, 200);
  assert.equal((await get('/api/conversations/miyue', { headers: { authorization: `Bearer ${TOKEN}` } })).status, 200);
  assert.equal((await get('/api/conversations/miyue', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  assert.equal((await get('/api/conversations/miyue', { headers: { 'x-youjian-token': TOKEN } })).status, 200);
  // Same value the desktop app computes with CryptoKit (desktop/CoreTests.swift).
  assert.equal(sessionValue(TOKEN), '08cf716fb3951292d2363cbcef1cf3aa1d6b1b1a1d5df4fd06eff7cf12682e15');
  const bad = await get('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'nope' }) });
  assert.equal(bad.status, 401);
  const ok = await get('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.ok(!cookie.includes(TOKEN));
  assert.ok(cookie.includes(sessionValue(TOKEN)));
  assert.equal((await get('/api/conversations/miyue', { headers: { cookie: cookie.split(';')[0] } })).status, 200);
});

test('login attempts are rate limited', async t => {
  const get = await fixture(t, { accessToken: TOKEN, accessLocal: true });
  const attempt = () => get('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'nope' }) });
  for (let i = 0; i < 6; i++) assert.equal((await attempt()).status, 401);
  assert.equal((await attempt()).status, 429);
});

test('loopback requests are trusted by default when a token is set', async t => {
  const get = await fixture(t, { accessToken: TOKEN });
  assert.equal((await get('/api/conversations/miyue')).status, 200);
});

test('short tokens are rejected and host names are allowed', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'access-short-'));
  try { await assert.rejects(createApp({ ...base, dataDir, accessToken: 'short' }), /24/); }
  finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  assert.ok(networkConfig({ allowedHosts: 'youjian-box.tail1234.ts.net,192.168.1.20' }).allowedHosts.has('youjian-box.tail1234.ts.net'));
  assert.throws(() => networkConfig({ allowedHosts: 'bad host' }));
});
