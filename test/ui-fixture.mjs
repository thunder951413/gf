// Explicit test fixture: isolated temporary data and deterministic model transport.
// Never use this entry point for the user's daily application.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'youjian-ui-'));
const app = await createApp({ dataDir, env: {}, fetchImpl: async (_url, request) => {
  const payload = JSON.parse(request.body);
  const user = payload.messages.filter(m => m.role === 'user').at(-1)?.content || '';
  return new Response(JSON.stringify({ choices: [{ message: { content: `【浏览器验收桩，不是真实模型】收到：${user.slice(0, 160)}` } }] }), { headers: { 'Content-Type': 'application/json' } });
} });
app.model.save({ baseUrl: 'http://127.0.0.1:18765/v1', model: 'ui-test-fixture' });
await app.listen(18765);
console.log('UI fixture ready at http://127.0.0.1:18765 (temporary isolated database)');
async function stop() { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
