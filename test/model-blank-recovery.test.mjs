import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelClient } from '../lib/model.mjs';

const env = { LIFE_MODEL_BASE_URL: 'https://api.deepseek.com', LIFE_MODEL_NAME: 'deepseek-v4-flash', LIFE_MODEL_API_KEY: 'k' };
const reply = content => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }), { status: 200 });

function client(outputs, seen) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-blank-'));
  return new ModelClient({ dataDir, env, fetchImpl: async (_url, init) => { seen.push(JSON.parse(init.body)); return reply(outputs.shift()); } });
}

test('a blank DeepSeek JSON-mode answer is retried once with the identical request', async () => {
  const seen = [];
  const result = await client(['   ', '{"reply":"嗯嗯"}'], seen).complete([{ role: 'user', content: 'hi' }], { jsonObject: true, nonThinking: true });
  assert.equal(result, '{"reply":"嗯嗯"}');
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], seen[0]);
});

test('a second blank answer falls back to plain mode with an explicit envelope reminder', async () => {
  const seen = [];
  const result = await client(['\n\n', ' ', '{"reply":"好呀"}'], seen).complete([{ role: 'user', content: 'hi' }], { jsonObject: true });
  assert.equal(result, '{"reply":"好呀"}');
  assert.equal(seen.length, 3);
  assert.equal(seen[2].response_format, undefined);
  assert.match(seen[2].messages.at(-1).content, /只输出一个完整的 JSON 对象/);
});

test('three blank answers still fail clearly instead of looping', async () => {
  const seen = [];
  await assert.rejects(client([' ', ' ', ' '], seen).complete([{ role: 'user', content: 'hi' }], { jsonObject: true }), { code: 'MODEL_RESPONSE_INVALID' });
  assert.equal(seen.length, 3);
});
