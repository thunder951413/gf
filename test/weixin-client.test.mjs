import test from 'node:test';
import assert from 'node:assert/strict';
import { WeixinClient, WEIXIN_ILINK_BASE_URL } from '../lib/weixin-client.mjs';

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('login uses the fixed official endpoint and exposes documented fields', async () => {
  const calls = []; const responses = [json({ qrcode: 'qr-code', qrcode_img_content: 'http://weixin.qq.com/q/abc' }), json({ status: 'confirmed', bot_token: 'bot-secret', ilink_bot_id: 'bot-1', ilink_user_id: 'lin-yuwei', baseurl: WEIXIN_ILINK_BASE_URL })];
  const client = new WeixinClient({ fetchImpl: async (url, options) => { calls.push({ url, options }); return responses.shift(); } });
  assert.deepEqual(await client.startLogin(), { qrcode: 'qr-code', qrcodeUrl: 'http://weixin.qq.com/q/abc' });
  assert.deepEqual(await client.pollLogin('qr-code'), { status: 'confirmed', botToken: 'bot-secret', botId: 'bot-1', userId: 'lin-yuwei', baseUrl: WEIXIN_ILINK_BASE_URL });
  assert.equal(calls[0].url, `${WEIXIN_ILINK_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`);
  assert.deepEqual(JSON.parse(calls[0].options.body), { local_token_list: [] });
  assert.equal(calls[1].options.method, 'GET'); assert.match(calls[1].url, /qrcode=qr-code/);
  assert.equal(calls[0].options.headers.Authorization, undefined); assert.equal(calls[0].options.redirect, 'manual');
});

test('authenticated endpoints use official headers, cursor, and stable client id', async () => {
  const calls = []; const responses = [json({ ret: 0, get_updates_buf: 'next', msgs: [{ from_user_id: 'lin-yuwei' }] }), json({ ret: 0, message_id: '123' }), json({ ret: 0, message_id: '124' })];
  const client = new WeixinClient({ fetchImpl: async (url, options) => { calls.push({ url, options }); return responses.shift(); } });
  assert.deepEqual(await client.getUpdates({ token: 'secret', baseUrl: WEIXIN_ILINK_BASE_URL, cursor: 'old' }), { cursor: 'next', messages: [{ from_user_id: 'lin-yuwei' }] });
  assert.deepEqual(await client.sendText({ token: 'secret', baseUrl: WEIXIN_ILINK_BASE_URL, to: 'lin-yuwei', contextToken: 'ctx', text: '你好', clientId: 'fixed-id' }), { messageId: '123', clientId: 'fixed-id' });
  assert.deepEqual(await client.sendText({ token: 'secret', baseUrl: WEIXIN_ILINK_BASE_URL, to: 'lin-yuwei', contextToken: 'ctx', text: '再见', clientId: 'fixed-id' }), { messageId: '124', clientId: 'fixed-id' });
  for (const call of calls) { assert.equal(call.options.headers.Authorization, 'Bearer secret'); assert.equal(call.options.headers.AuthorizationType, 'ilink_bot_token'); assert.match(call.options.headers['X-WECHAT-UIN'], /^[A-Za-z0-9+/]+=*$/); }
  assert.deepEqual(JSON.parse(calls[0].options.body), { get_updates_buf: 'old', base_info: { channel_version: '2.4.9-beta.0', bot_agent: 'OpenClaw' } });
  assert.deepEqual(JSON.parse(calls[1].options.body).msg, { from_user_id: '', to_user_id: 'lin-yuwei', client_id: 'fixed-id', message_type: 2, message_state: 2, context_token: 'ctx', item_list: [{ type: 1, text_item: { text: '你好' } }] });
  assert.deepEqual(JSON.parse(calls[1].options.body).base_info, { channel_version: '2.4.9-beta.0', bot_agent: 'OpenClaw' });
  assert.equal(JSON.parse(calls[2].options.body).msg.client_id, 'fixed-id');
});

test('send accepts the documented optional ret and message_id fields', async () => {
  const client = new WeixinClient({ fetchImpl: async () => json({}) });
  assert.deepEqual(await client.sendText({ token: 'secret', baseUrl: WEIXIN_ILINK_BASE_URL, to: 'lin-yuwei', contextToken: 'ctx', text: '你好', clientId: 'fixed-id' }), { messageId: undefined, clientId: 'fixed-id' });
});

test('rejects untrusted login base URLs and maps safe business errors', async () => {
  const client = new WeixinClient({ fetchImpl: async () => json({ status: 'confirmed', bot_token: 'leak', ilink_bot_id: 'id', baseurl: 'https://evil.test' }) });
  await assert.rejects(client.pollLogin('qr'), (error) => error.code === 'WEIXIN_INVALID_REQUEST' && !error.message.includes('leak'));
  const errors = new WeixinClient({ fetchImpl: async () => json({ ret: -14, errmsg: 'token expired' }) });
  await assert.rejects(errors.getUpdates({ token: 'x', baseUrl: WEIXIN_ILINK_BASE_URL }), (error) => error.code === 'WEIXIN_SESSION_EXPIRED' && !error.message.includes('expired'));
  const rate = new WeixinClient({ fetchImpl: async () => json({ ret: 429, errmsg: 'secret' }) });
  await assert.rejects(rate.sendText({ token: 'x', baseUrl: WEIXIN_ILINK_BASE_URL, to: 'lin', contextToken: 'ctx', text: 'x', clientId: 'id' }), (error) => error.code === 'WEIXIN_RATE_LIMITED' && error.uncertain === false && !error.message.includes('secret'));
});

test('send reports uncertain delivery for transport failure and rejects arbitrary base URLs before calling fetch', async () => {
  let calls = 0; const client = new WeixinClient({ fetchImpl: async () => { calls++; throw new Error('token-secret'); } });
  await assert.rejects(client.sendText({ token: 'token-secret', baseUrl: WEIXIN_ILINK_BASE_URL, to: 'lin', contextToken: 'ctx', text: 'x', clientId: 'id' }), (error) => error.code === 'WEIXIN_REQUEST_FAILED' && error.uncertain && !error.message.includes('token-secret'));
  await assert.rejects(client.getUpdates({ token: 'x', baseUrl: 'https://evil.test' }), (error) => error.code === 'WEIXIN_INVALID_REQUEST');
  assert.equal(calls, 1);
});

test('multiline replies retain newlines and explicit rejected transient errors are retryable', async () => {
  let body; const client = new WeixinClient({ fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return json({ ret: 429, errmsg: 'rate limited' }); } });
  await assert.rejects(client.sendText({ token: 'x', baseUrl: WEIXIN_ILINK_BASE_URL, to: 'lin', contextToken: 'ctx', text: '第一段\n\n第二段', clientId: 'id' }), (error) => error.code === 'WEIXIN_RATE_LIMITED' && error.retryable && error.uncertain === false);
  assert.equal(body.msg.item_list[0].text_item.text, '第一段\n\n第二段');
});

test('context is prioritized over a token wording and malformed send confirmation is uncertain', async () => {
  const context = new WeixinClient({ fetchImpl: async () => json({ ret: -2, errmsg: 'context token expired' }) });
  await assert.rejects(context.sendText({ token: 'x', baseUrl: WEIXIN_ILINK_BASE_URL, to: 'lin', contextToken: 'ctx', text: 'x', clientId: 'id' }), (error) => error.code === 'WEIXIN_CONTEXT_EXPIRED' && error.uncertain === false);
  const invalid = new WeixinClient({ fetchImpl: async () => json({ ret: 0, message_id: {} }) });
  await assert.rejects(invalid.sendText({ token: 'x', baseUrl: WEIXIN_ILINK_BASE_URL, to: 'lin', contextToken: 'ctx', text: 'x', clientId: 'id' }), (error) => error.code === 'WEIXIN_RESPONSE_INVALID' && error.uncertain);
  const oversized = new WeixinClient({ fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), { status: 200 }) });
  await assert.rejects(oversized.sendText({ token: 'x', baseUrl: WEIXIN_ILINK_BASE_URL, to: 'lin', contextToken: 'ctx', text: 'x', clientId: 'id' }), (error) => error.code === 'WEIXIN_RESPONSE_TOO_LARGE' && error.uncertain);
});
