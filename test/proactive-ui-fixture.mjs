// Explicit, isolated browser fixture. No real model, feed, notification or voice call.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'youjian-proactive-ui-'));
const feed = { id: 'fixture', url: 'https://example.org/feed', title: '浏览器验收来源', category: '知识' };
const app = await createApp({ dataDir, env: {}, initialFeeds: [feed], random: () => 0.5, proactiveIntervalMs: 1000,
  desktopNotify: async () => ({ requested: true }),
  integrations: {
    fetchFeed: async () => ({ title: feed.title, items: [{ title: '【验收资料】如何感受工作之外的时间', url: 'https://example.org/time', summary: '这是一段专门用于浏览器验收的模拟资料，讨论持续工作后如何感知时间，也讨论有意识地选择休息方式。', publishedAt: new Date().toISOString() }] }),
    probeTts: async () => ({ available: false, state: 'unavailable', stt: { available: false, state: 'unavailable' } }),
  },
  fetchImpl: async (_url, request) => {
    const payload = JSON.parse(request.body), prompt = payload.messages.map(m => m.content).join('\n');
    const id = prompt.match(/ID:([^\n]+)/)?.[1] || null;
    const content = payload.max_tokens === 1800
      ? JSON.stringify({ skip: false, contentId: id, reason: '【验收桩】后台按计划读到一个可讨论的具体主题', message: '【浏览器验收桩】刚读到一段关于时间感的材料。工作之外的时间，你更喜欢留给一个完整的故事，还是几段随手翻看的内容？' })
      : '【浏览器验收桩】我记得刚才那段资料，我们可以继续聊。';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }));
  },
});
app.model.save({ baseUrl: 'http://127.0.0.1:18766/v1', model: 'explicit-proactive-ui-stub' });
app.proactiveRepo.saveSettings({ activeStart: '00:00', activeEnd: '23:59', desktopNotifications: false });
app.proactiveRepo.updateRuntime({ nextContactAt: new Date(Date.now() + 45_000).toISOString() });
await app.listen(18766);
console.log('Isolated proactive UI fixture: http://127.0.0.1:18766/ ; first automatic contact in 45 seconds.');
let closing = false;
async function stop() { if (closing) return; closing = true; await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
