// Isolated, explicitly labelled fixtures. No real model/API requests or desktop/audio effects.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'youjian-zhihu-ui-'));
const title = '【验收话题】科技如何影响我们的阅读习惯';
const app = await createApp({ dataDir, env: {}, initialFeeds: [], startProactive: false, researchIntervalMs: 15000, random: () => 0,
  integrations: { fetchFeed: async () => ({ items: [] }), probeTts: async () => ({ available: false, stt: { available: false } }) },
  fetchSina: async () => ({ items: [{ title, url: 'https://so.sina.cn/search/list.d.html?keyword=reading', source: '新浪热榜（验收桩）', publishedAt: null, observedAt: new Date().toISOString() }] }),
  zhihuFetchImpl: async (url, options) => {
    const route = new URL(url).pathname;
    if (route.endsWith('/quota')) return Response.json({ Code: 0, Data: [{ APIID: 'zhihu_search', APIName: '站内检索（验收桩）', TotalQuota: 100, TotalUsed: 5, RemainingQuota: 95 }] });
    if (route.endsWith('/hot_list') || route.endsWith('/global_search')) return Response.json({ Code: 0, Data: { Items: [] } });
    if (route.endsWith('/zhihu_search')) return Response.json({ Code: 0, Data: { Items: [{ Title: title, ContentText: '【验收摘录】短篇信息方便接触新观点，而持续阅读与讨论能帮助理解复杂的问题。这里是隔离测试数据。', Url: 'https://www.zhihu.com/question/123/answer/456?utm_source=test', AuthorName: '验收作者', ContentType: 'answer', EditTime: Math.floor(Date.now() / 1000) }] } });
    await new Promise(r => setTimeout(r, 1500));
    return Response.json({ choices: [{ message: { content: '【验收整理】信息媒介改变了阅读节奏。[1] 的观点是短篇内容与完整阅读可以相互补充。你更喜欢什么样的阅读体验？' } }] });
  },
  fetchImpl: async (_url, options) => { const body = JSON.parse(options.body), id = body.messages.map(m => m.content).join('\n').match(/ID:([^\n]+)/)?.[1] || null; return Response.json({ choices: [{ message: { content: body.max_tokens === 1800 ? JSON.stringify({ skip: false, contentId: id, reason: '【验收】读到值得讨论的知乎资料', message: '【验收开场】这段资料谈到完整阅读和短信息的差别，你平时更喜欢哪一种？' }) : '【验收回复】我们可以接着聊刚才的阅读观点。' } }] }); },
  desktopNotify: async () => ({ requested: false }),
});
app.model.save({ baseUrl: 'http://model.test/v1', model: 'explicit-ui-fixture' });
app.proactiveRepo.saveSettings({ activeStart: '00:00', activeEnd: '23:59', desktopNotifications: false });
await app.listen(18767); app.research.start();
console.log('Isolated Zhihu UI fixture: http://127.0.0.1:18767/');
let closing = false;
async function stop() { if (closing) return; closing = true; await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
