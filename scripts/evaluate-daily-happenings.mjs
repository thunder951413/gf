// Daily happenings harness, always on an isolated fork of the data directory.
//   node scripts/evaluate-daily-happenings.mjs --dry  [--label x] [--source path/to/life.sqlite] [--day YYYY-MM-DD]
//   node scripts/evaluate-daily-happenings.mjs --live --label x [--source path/to/life.sqlite] [--day YYYY-MM-DD] [--out dir]
// --dry uses a fake model (no network) and prints the generated happenings,
// mood, follow-up candidates and the prompt blocks they inject. --live uses the
// configured model: generate today's happenings, then six chat turns and two
// proactive contacts; the report goes to .runtime/daily-happenings/<label>/.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { forkSession } from '../lib/session-snapshot.mjs';
import { createApp } from '../server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), flag = n => args.includes(n), value = n => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1]; };
const live = flag('--live'), dry = flag('--dry') || !live;
const label = value('--label') || (dry ? `dry-${Date.now()}` : null);
if (!/^[a-z0-9-]+$/.test(label || '')) throw new Error('--label 需要英文小写标签');
const dir = path.resolve(value('--out') || path.join(root, '.runtime', 'daily-happenings'), label);
if (fs.existsSync(dir)) throw new Error('标签已存在：' + dir);
const sourceFile = path.resolve(value('--source') || path.join(root, 'data', 'life.sqlite'));
{
  const db = new DatabaseSync(sourceFile, { readOnly: true });
  let provider; try { provider = JSON.parse(fs.readFileSync(path.join(root, 'data', 'provider.json'), 'utf8')); } catch {}
  try { await forkSession({ db }, { targetDir: dir, sourceDir: null, provider: provider || (dry ? { provider: 'openai-compatible', baseUrl: 'https://example.invalid/v1', model: 'fake', apiKey: 'fake' } : undefined) }); } finally { db.close(); }
}
// The day after the latest message, so yesterday is organised in the morning as in real use.
const lastAt = (() => { const db = new DatabaseSync(path.join(dir, 'life.sqlite'), { readOnly: true }); try { return db.prepare('SELECT max(created_at) AS at FROM messages').get().at; } finally { db.close(); } })();
const day = value('--day') || new Date(Date.parse(lastAt || new Date().toISOString()) + 8 * 3600000 + 86400000).toISOString().slice(0, 10);
const at = clock => new Date(`${day}T${clock}:00+08:00`);
const TURNS = [
  ['08:10', 'chat', '早上好呀'], ['12:40', 'chat', '你今天干嘛了'], ['12:44', 'chat', '我在改一个报表'], ['12:46', 'chat', '嗯嗯'],
  ['15:30', 'proactive', null], ['18:40', 'chat', '晚上吃啥'], ['21:00', 'proactive', null], ['23:10', 'chat', '困了，睡了'],
];
let now = at('06:30');

const systemText = messages => messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
const kindOf = messages => {
  const sys = systemText(messages);
  if (sys.startsWith('你为虚构人物林晓薇')) return 'happenings';
  if (sys.startsWith('你将一天内的一小段历史对话压缩')) return 'compression';
  if (sys.startsWith('你核对原文与压缩记录')) return 'compression-review';
  if (sys.includes('你只判断一段对话现在能否另起话题')) return 'continuity';
  if (sys.includes('【本轮提示生成】')) return 'guidance';
  if (messages.some(m => m.role === 'system' && m.content.includes('【本轮草稿检查】'))) return 'review';
  if (/"skip":boolean/.test(sys)) return 'proactive';
  if (messages.at(-1)?.role === 'system' && /【收紧篇幅】|【别只附和】|【/.test(messages.at(-1).content) && messages.at(-2)?.role === 'assistant') return 'rewrite';
  return 'chat';
};
const between = (text, start) => { const i = text.indexOf(start); if (i < 0) return null; const rest = text.slice(i + start.length); const line = rest.split('\n')[0]; try { return JSON.parse(line); } catch { return null; } };
// Fake answers: just enough structure to exercise the real code paths.
const fake = (kind, messages) => {
  if (kind === 'happenings') {
    const input = JSON.parse(messages.at(-1).content);
    const items = [
      { slot: 'morning', kind: 'street', text: '早上下楼看见三花蹲在电动车座上晒太阳，赶都赶不走', detail: '楼下那只三花这几天总占着同一辆电动车，车主无奈地推着别的车走了。', mood: '好笑', canShare: true, keywords: ['三花', '电动车'] },
      { slot: 'noon', kind: 'friend', text: '小郁中午发来一张她们社新书封面，问我丑不丑', detail: '小郁在出版社做编辑，封面是烫金的大字，她觉得太土但领导喜欢；我觉得字距太挤。', mood: '想吐槽', canShare: true, keywords: ['小郁', '封面'] },
    ];
    if (input.news[0]) items.push({ slot: 'afternoon', kind: 'news-reaction', text: `看到“${input.news[0].title.slice(0, 18)}”，有点想法`, detail: `新闻导语：${input.news[0].lead.slice(0, 60)}。她觉得这事挺值得聊。`, mood: '琢磨', canShare: true, keywords: [input.news[0].title.slice(0, 4)] });
    const candidate = input.userCandidates.at(-1);
    return { mood: '早上被三花逗乐，中午替小郁的封面犯愁，整体挺松快', onMind: ['小郁那个封面到底改不改', input.lifeThread ? `${input.lifeThread.title}` : '周末想去走走'],
      items, followUps: candidate ? [{ sourceId: candidate.id, text: '你前两天说的那个事后来怎么样啦', askAfterDays: 1, keywords: [...new Set(candidate.text.match(/[\p{Script=Han}]{2,4}/gu) || [])].slice(1, 3) }] : [] };
  }
  if (kind === 'compression') {
    const input = JSON.parse(messages.at(-1).content);
    return { items: input.conversation.map(row => ({ kind: 'topic', status: 'unknown', text: `${row.speaker === 'user' ? '用户' : '角色'}说：${row.text.slice(0, 200)}`, evidence: [row.id] })), omitted: [] };
  }
  if (kind === 'compression-review') return { ok: true, issues: [], omitted: [] };
  if (kind === 'continuity') return { state: 'open', reason: '收尾', evidence: [] };
  if (kind === 'guidance') return { reviewEffort: 'fast', turn: { focus: null, claims: [] }, guidance: [] };
  if (kind === 'review') return { guidance: [], ready: true, revision: null, needsReasoning: false };
  const sys = systemText(messages);
  if (kind === 'proactive') {
    const materials = between(sys, '可供主动分享的材料：') || [];
    const own = materials.find(item => item.kind === 'daily_happening') || materials.find(item => item.kind === 'user_thread');
    return own ? { skip: false, message: `诶跟你说 ${own.title}`, reason: '想分享', contentId: null, initiative: { state: 'open', materialId: own.id, quote: `诶跟你说 ${own.title}`.slice(0, 40) } }
      : { skip: false, message: '在干嘛呀 有点想你', reason: '想他', contentId: null, initiative: { state: 'open', materialId: null, quote: '' } };
  }
  const own = between(sys, '她今天自己的小事（可顺口提，不必提；他在说自己的事时先接他的）：') || [];
  return own[0] ? { reply: `嗯嗯 ${own[0].text}`, usedIds: [own[0].id] } : { reply: '哈哈 好呀 那你先说说你的' };
};

const wire = [];
const transport = async (url, init) => {
  const body = JSON.parse(init.body), kind = kindOf(body.messages);
  const row = { turn: currentTurn, kind, chars: body.messages.reduce((n, m) => n + m.content.length, 0) };
  if (kind === 'chat' || kind === 'proactive') row.messages = body.messages;
  if (kind === 'happenings') row.input = JSON.parse(body.messages.at(-1).content);
  if (dry) {
    const content = JSON.stringify(fake(kind, body.messages)); row.out = content; wire.push(row);
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: Math.round(row.chars / 1.6), completion_tokens: 40, total_tokens: Math.round(row.chars / 1.6) + 40 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const started = performance.now(); const response = await fetch(url, init); const text = await response.text();
  let parsed; try { parsed = JSON.parse(text); } catch {}
  Object.assign(row, { ms: Math.round(performance.now() - started), usage: parsed?.usage, out: parsed?.choices?.[0]?.message?.content });
  wire.push(row); return new Response(text, { status: response.status, headers: response.headers });
};
let currentTurn = 'morning';
const app = await createApp({
  dataDir: dir, initialFeeds: [], env: {}, activeRoleIds: ['miyue'], disableStory: true, dailyCompression: true, dailyHappenings: true,
  dynamicCompanion: true, sessionDialogue: true, semanticUnderstanding: true, dialogueMemory: true, discussionTopics: true, sourceRelevance: false,
  materialPresentation: 'generated', startDiscovery: false, startWeixin: false, startChatQueue: false, startRuntime: false, startLife: false,
  startPursuits: false, startDossiers: false, startRecall: false, startProactive: false, startResearch: false,
  startReminders: false, startCharacterGrowth: false, startDailyLife: false, startDailyInformation: false, replySleep: async () => {}, clock: () => new Date(now), random: () => 0.42, lifeRandom: () => 0.42,
  integrations: { fetchFeed: async () => { throw new Error('off'); }, fetchArticle: async () => { throw new Error('off'); }, listSpeechVoices: async () => ({ voices: [] }), probeTts: async () => ({ available: false }), closeSpeech: async () => {} },
  fetchSina: async () => ({ items: [] }), zhihuFetchImpl: async () => { throw new Error('off'); }, desktopNotify: async () => ({ requested: false }), fetchImpl: transport,
});
const blocks = messages => {
  const background = messages.find(m => m.content.startsWith('【长期背景】'))?.content.split('\n').filter(line => line.includes('【她今天的状态】')) || [];
  const evidence = messages.find(m => m.content.startsWith('【本轮背景证据】'))?.content.split('\n').filter(line => /她今天自己的小事|今天已经跟他讲过|可以问问他|usedIds|可供主动分享的材料/.test(line)) || [];
  const last = messages.find(m => m.content.startsWith('【当前轮次】'))?.content.split('\n').find(line => line.startsWith('最终只输出 JSON')) || null;
  return { background, evidence: evidence.map(line => line.length > 900 ? line.slice(0, 900) + '…' : line), finalProtocol: last };
};
const results = [];
let morning;
try {
  app.preferences.setReplyPace('instant');
  app.proactiveRepo.saveSettings({ enabled: true, activeStart: '00:00', activeEnd: '23:59', dailyLimit: 12, minGapMinutes: 5, maxGapMinutes: 20, desktopNotifications: false });
  const organised = await app.dailyMemory.ensureBeforeInteraction('miyue');
  const generated = await app.dailyHappenings.generate('miyue');
  morning = { day, organised, generated: { status: generated.status, error: generated.error, raw: generated.raw }, snapshot: app.dailyHappenings.snapshot('miyue') };
  process.stderr.write(`morning ${day}: memory=${organised.status} happenings=${generated.status} ${generated.error || ''}\n`);
  const address = await app.listen(0), url = `http://127.0.0.1:${address.port}`;
  for (const [index, [clock, type, text]] of TURNS.entries()) {
    now = at(clock); currentTurn = index;
    const before = app.store.getMessages('miyue').length, callsBefore = wire.length, sharedBefore = app.dailyHappenings.snapshot('miyue');
    let error = null;
    if (type === 'chat') { const r = await fetch(url + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'miyue', text }) }); if (!r.ok) error = (await r.json()).error; }
    else { try { const body = await app.proactive.runNow({ roleId: 'miyue' }); if (!body?.delivered) error = body?.reason || body?.code || 'not delivered'; } catch (e) { error = e.message; } }
    const added = app.store.getMessages('miyue').slice(before).filter(m => m.speaker === 'assistant');
    const after = app.dailyHappenings.snapshot('miyue');
    const calls = wire.slice(callsBefore), main = calls.filter(c => c.kind === type).at(-1);
    const material = type === 'proactive' ? app.store.db.prepare('SELECT material_id,kind FROM proactive_material_deliveries WHERE message_id=?').get(added.at(-1)?.id || '') || null : null;
    results.push({ index, at: `${day} ${clock}`, type, user: text, reply: added.map(m => m.text).join('\n'), error,
      sharedNow: after.items.filter(item => item.shared && !sharedBefore.items.find(old => old.id === item.id)?.shared).map(item => `${item.id} ${item.text}（${item.receipt}）`),
      askedNow: after.userThreads.filter(item => item.status !== 'open' && sharedBefore.userThreads.find(old => old.id === item.id)?.status === 'open').map(item => `${item.id} ${item.status} ${item.text}`),
      proactiveMaterial: material, calls: calls.map(c => c.kind).join(','), prompt: main ? blocks(main.messages) : null });
    process.stderr.write(`#${index} ${clock} ${type} ${text ?? ''} -> ${added.map(m => m.text).join(' / ').slice(0, 160)} ${error ?? ''}\n`);
  }
} finally { await app.close(); }
const report = { label, live, day, morning: { ...morning, input: wire.find(row => row.kind === 'happenings')?.input || null, output: wire.find(row => row.kind === 'happenings')?.out || null }, turns: results, final: null };
{
  const db = new DatabaseSync(path.join(dir, 'life.sqlite'), { readOnly: true });
  try { report.final = { happenings: db.prepare('SELECT * FROM daily_happening_shares').all(), userThreads: db.prepare('SELECT id,text,status,ask_after,mode FROM user_threads').all(),
    usage: db.prepare('SELECT payload FROM model_usage').all().map(row => JSON.parse(row.payload)).filter(row => row.purpose === 'daily-happenings') }; } catch (error) { report.final = { error: error.message }; } finally { db.close(); }
}
fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(dir, 'wire.json'), JSON.stringify(wire.map(({ messages, ...row }) => row), null, 1));
const snap = morning?.snapshot;
console.log(`== ${day} 晨间生成：${morning?.generated.status}${morning?.generated.error ? ' ' + morning.generated.error : ''}`);
if (snap) {
  console.log(`心情：${snap.mood}\n惦记：${snap.onMind.join('；')}\n参考新闻：${snap.news.join(' | ')}`);
  for (const item of snap.items) console.log(`小事 ${item.id} [${item.slot}/${item.kind}/${item.mood}] ${item.text}\n    背景：${item.detail}  关键词：${item.keywords.join('、')}`);
  for (const thread of snap.userThreads) console.log(`回头问 ${thread.id} [${thread.status}，${thread.askAfter} 起] ${thread.text}\n    依据：${thread.sourceText}`);
}
for (const turn of results) {
  console.log(`\n#${turn.index} ${turn.at} ${turn.type}${turn.user ? ' 用户：' + turn.user : ''}\n  回复：${turn.reply || '（无）'}${turn.error ? '  错误：' + turn.error : ''}`);
  if (turn.sharedNow.length || turn.askedNow.length || turn.proactiveMaterial) console.log(`  记为已分享：${turn.sharedNow.join('；') || '无'}  问过：${turn.askedNow.join('；') || '无'}  主动材料：${turn.proactiveMaterial ? turn.proactiveMaterial.kind + ' ' + turn.proactiveMaterial.material_id : '无'}`);
  if (turn.prompt && (dry ? [1, 4].includes(turn.index) : true)) console.log('  注入：' + JSON.stringify(turn.prompt, null, 1).replace(/\n/g, '\n  '));
}
console.log(`\n报告：${dir}/report.json`);
