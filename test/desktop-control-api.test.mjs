import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

test('desktop API reports actual state, validates the switch and preserves origin checks', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-api-'));
  let running = false;
  const changes = [];
  const desktopControl = {
    status: async () => ({ available: true, running }),
    setEnabled: async enabled => { changes.push(enabled); running = enabled; return desktopControl.status(); },
  };
  const app = await createApp({ dataDir, desktopControl, initialFeeds: [], env: {},
    startProactive: false, startRecall: false, startRuntime: false, startChatQueue: false,
    integrations: { fetchFeed: async () => ({ items: [] }) },
  });
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const { port } = await app.listen(0), url = `http://127.0.0.1:${port}/api/desktop`;
  const post = (body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.deepEqual(await (await fetch(url)).json(), { available: true, running: false });
  assert.equal((await post({ enabled: 'true' })).status, 400);
  assert.equal((await post({})).status, 400);
  assert.equal((await post({ enabled: true }, { Origin: 'https://outside.test' })).status, 403);
  assert.deepEqual(changes, []);
  assert.equal((await (await post({ enabled: true })).json()).running, true);
  running = false; // The user quits from the native menu.
  assert.equal((await (await fetch(url)).json()).running, false);
  assert.equal((await (await post({ enabled: true })).json()).running, true);
  assert.equal((await (await post({ enabled: false })).json()).running, false);
  assert.deepEqual(changes, [true, true, false]);
});
