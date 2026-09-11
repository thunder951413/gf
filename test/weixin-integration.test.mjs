import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

const appDataDir = path.resolve('app-data');
const noVoice = { fetchFeed: async () => ({ items: [] }), probeTts: async () => ({ available: false }) };
const waitFor = async (predicate, message = 'condition was not met') => {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(message);
};

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-weixin-integration-'));
  const modelCalls = [], sends = [];
  const weixinClient = {
    async getUpdates() { return { cursor: '', messages: [] }; },
    async startLogin() { return { qrcode: 'qr-token', qrcodeUrl: 'http://weixin.test/authorize/qr-token' }; },
    async pollLogin() { return { status: 'wait' }; },
    async sendText(payload) { sends.push(payload); return { messageId: 'sent-1', clientId: payload.clientId }; },
  };
  const app = await createApp({
    appDataDir, dataDir, initialFeeds: [], integrations: noVoice, startRecall: false,
    startProactive: false, startResearch: false, startRuntime: false, startWeixin: false,
    replySleep: async () => {}, chatDebounceMs: 1,
    env: { LIFE_MODEL_BASE_URL: 'https://fixture.test/v1', LIFE_MODEL_NAME: 'fixture' },
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body); modelCalls.push(body);
      return Response.json({ choices: [{ message: { content: '我看到你这句话了，慢慢和我说。' } }] });
    },
    weixinClient,
    weixinQrEncode: async content => Buffer.from(`PNG:${content}`),
  });
  const address = await app.listen(0); const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  async function request(route, body) {
    const response = await fetch(`${base}${route}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const type = response.headers.get('content-type') || '';
    return { response, body: type.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer()) };
  }
  return { app, base, request, modelCalls, sends };
}

test('bound Weixin input goes through Miyue’s normal queue once, filters outsiders, and delivers one merged reply', async t => {
  const f = await fixture(t);
  f.app.weixin.bind({ botToken: 'wx-secret', botId: 'bot-1', userId: 'lin-yuwei', baseUrl: 'https://ilinkai.weixin.qq.com' });
  f.app.weixin.ingest({ cursor: 'foreign-cursor', messages: [{ message_id: 'foreign', message_type: 1, from_user_id: 'other-user', context_token: 'foreign-context', item_list: [{ type: 1, text_item: { text: '不要处理' } }] }] });
  f.app.weixin.ingest({ cursor: 'owner-cursor', messages: [{ message_id: 'owner-1', message_type: 1, from_user_id: 'lin-yuwei', context_token: 'owner-context', item_list: [{ type: 1, text_item: { text: '今晚有点想你' } }] }] });
  f.app.weixin.ingest({ cursor: 'owner-cursor', messages: [{ message_id: 'owner-1', message_type: 1, from_user_id: 'lin-yuwei', context_token: 'owner-context', item_list: [{ type: 1, text_item: { text: '今晚有点想你' } }] }] });
  await f.app.weixin.tick();
  await waitFor(() => f.app.store.getMessages('miyue').length === 2, 'Miyue reply should finish through the normal chat queue');
  assert.equal(f.modelCalls.length, 1, 'the replayed inbound message must not invoke the model twice');
  const prompt = f.modelCalls[0].messages.map(message => message.content).join('\n');
  assert.match(prompt, /今晚有点想你/);
  assert.match(prompt, /林雨薇|雨薇/);
  assert.doesNotMatch(prompt, /不要处理/);
  assert.doesNotMatch(prompt, /微信机器人|second bot/i);

  await f.app.weixin.tick();
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].to, 'lin-yuwei');
  assert.equal(f.sends[0].contextToken, 'owner-context');
  assert.equal(f.sends[0].text, '我看到你这句话了，慢慢和我说。');
  assert.deepEqual(f.app.store.getMessages('miyue').map(row => row.text), ['今晚有点想你', '我看到你这句话了，慢慢和我说。']);
});

test('Weixin API snapshots redact credentials, validate settings, render local QR content, and disconnect keeps chat history', async t => {
  const f = await fixture(t);
  f.app.weixin.bind({ botToken: 'wx-secret', botId: 'bot-1', userId: 'lin-yuwei', baseUrl: 'https://ilinkai.weixin.qq.com' });
  f.app.store.saveChatTurn({ role: 'miyue', text: '已经聊过的话', reply: '我记得。' });
  const status = await f.request('/api/weixin');
  assert.equal(status.response.status, 200);
  assert.equal(status.body.role, 'miyue');
  assert.equal(status.body.roleName, '林雨薇');
  assert.doesNotMatch(JSON.stringify(status.body), /wx-secret/);
  const invalid = await f.request('/api/weixin/settings', { enabled: true, role: 'wenxi' });
  assert.equal(invalid.response.status, 400);
  const login = await f.request('/api/weixin/login', {});
  assert.equal(login.response.status, 200);
  const qr = await fetch(`${f.base}/api/weixin/login/qr.png`);
  assert.equal(qr.status, 200);
  assert.match(qr.headers.get('content-type') || '', /^image\/png/);
  assert.equal((await qr.text()), 'PNG:http://weixin.test/authorize/qr-token');
  const disconnected = await f.request('/api/weixin/disconnect', {});
  assert.equal(disconnected.response.status, 200);
  assert.equal(disconnected.body.configured, false);
  assert.deepEqual(f.app.store.getMessages('miyue').map(row => row.text), ['已经聊过的话', '我记得。']);
});
