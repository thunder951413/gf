// Naturalness / token harness. Runs a fixed casual conversation against an
// isolated fork of the real data directory, never the live database.
//   node scripts/evaluate-naturalness.mjs --label base --dry        (no network, prompt-prefix analysis)
//   node scripts/evaluate-naturalness.mjs --label base --live [--tuning '{"verbosity":20}']
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { forkSession } from '../lib/session-snapshot.mjs';
import { createApp } from '../server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), flag = n => args.includes(n), value = n => { const i = args.indexOf(n); return i < 0 ? null : args[i + 1]; };
const label = value('--label'); if (!/^[a-z0-9-]+$/.test(label || '')) throw new Error('--label 唯一英文标签');
const live = flag('--live'), tuning = value('--tuning') ? JSON.parse(value('--tuning')) : null;
const only = value('--turns') ? Number(value('--turns')) : null;
const base = path.join(root, '.runtime', 'naturalness'), template = path.resolve(value('--template') || path.join(base, 'template-v2')), dir = path.join(base, label);
if (fs.existsSync(dir)) throw new Error('标签已存在：' + dir);
if (!fs.existsSync(template)) {
  const src = path.join(root, 'data'), db = new DatabaseSync(path.join(src, 'life.sqlite'), { readOnly: true });
  let provider; try { provider = JSON.parse(fs.readFileSync(path.join(src, 'provider.json'), 'utf8')); } catch {}
  try { await forkSession({ db }, { targetDir: template, sourceDir: null, provider }); } finally { db.close(); }
}
fs.cpSync(template, dir, { recursive: true });

// Casual weekday, continuing from the real history (last message 2026-10-12 09:31 Shanghai).
const TURNS = [
  [20, 'chat', '到公司啦'], [2, 'chat', '嗯嗯'], [3, 'chat', '今天下午要开一下午的会，好烦'],
  [40, 'chat', '你在干嘛呢'], [2, 'chat', '哈哈哈你好可爱'], [5, 'chat', '晚上想看个电影，推荐一个呗'],
  [3, 'chat', '为什么秋天总是犯困啊'], [1, 'chat', '知道啦'], [300, 'chat', '我下班啦，好累'],
  [2, 'chat', '会议开到六点，脑子都空了'], [90, 'proactive', null], [20, 'chat', '刚吃完饭'],
  [10, 'chat', '你今天想我没'], [30, 'chat', '我去洗澡了'],
];
const turns = only ? TURNS.slice(0, only) : TURNS;
// Start 20 minutes after the latest message in the snapshot.
const lastAt = (() => { const db = new DatabaseSync(path.join(dir, 'life.sqlite'), { readOnly: true }); try { return db.prepare('SELECT max(created_at) AS at FROM messages').get().at; } finally { db.close(); } })();
let now = new Date(Date.parse(lastAt || '2026-10-12T01:00:00Z') + 20 * 60000);

const kindOf = messages => {
  const text = messages.filter(m => m.role === 'system').map(m => m.content.slice(0, 40)).join('|');
  if (/【本轮提示生成】/.test(messages.map(m => m.content).join('').slice(0, 60000)) && messages.some(m => m.content.includes('【本轮提示生成】'))) return 'guidance';
  if (messages.some(m => m.role === 'system' && m.content.startsWith('【本轮草稿检查】'))) return 'review';
  if (messages.some(m => m.role === 'system' && m.content.includes('你只判断一段对话现在能否另起话题'))) return 'continuity';
  if (messages.some(m => m.role === 'system' && /【收紧篇幅】/.test(m.content))) return 'tighten';
  return /主动联系/.test(text + messages.at(-1)?.content) ? 'chat' : 'chat';
};
const serial = messages => messages.map(m => `${m.role}\u0000${m.content}\u0001`).join('');
const wire = []; const seen = [];
const lcp = (a, b) => { let i = 0; const n = Math.min(a.length, b.length); while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++; return i; };
const fakeReply = (kind, body) => {
  if (kind === 'guidance') return { reviewEffort: 'fast', turn: { focus: null, claims: [] }, guidance: [] };
  if (kind === 'review') return { guidance: [], ready: true, revision: null, needsReasoning: false };
  if (kind === 'continuity') return { state: 'open', reason: '收尾', evidence: [] };
  const sys = body.messages.map(m => m.content).join('');
  if (/"skip":boolean/.test(sys)) return { skip: false, message: '在吗', reason: '想他', contentId: null, initiative: { state: 'open', materialId: null, quote: '在吗' } };
  return { reply: '嗯嗯\n好呀' };
};
const transport = async (url, init) => {
  const body = JSON.parse(init.body), kind = kindOf(body.messages), s = serial(body.messages);
  const prefix = seen.reduce((best, prev) => Math.max(best, lcp(prev, s)), 0); seen.push(s);
  const row = { kind, chars: s.length, prefixChars: prefix, turn: currentTurn };
  if (!live) { wire.push(row); const content = JSON.stringify(fakeReply(kind, body));
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: Math.round(s.length / 1.6), completion_tokens: 20, total_tokens: Math.round(s.length / 1.6) + 20 } }), { status: 200, headers: { 'content-type': 'application/json' } }); }
  const started = performance.now(); const response = await fetch(url, init); const text = await response.text();
  let parsed; try { parsed = JSON.parse(text); } catch {}
  Object.assign(row, { ms: Math.round(performance.now() - started), usage: parsed?.usage, out: parsed?.choices?.[0]?.message?.content });
  wire.push(row); return new Response(text, { status: response.status, headers: response.headers });
};
let currentTurn = -1;
const app = await createApp({
  dataDir: dir, initialFeeds: [], env: {}, activeRoleIds: ['miyue'], disableStory: true, dailyCompression: true,
  dynamicCompanion: true, sessionDialogue: true, semanticUnderstanding: true, dialogueMemory: true, discussionTopics: true, sourceRelevance: false,
  materialPresentation: 'generated', startDiscovery: false, startWeixin: false, startChatQueue: false, startRuntime: false, startLife: false,
  startLifeThreads: false, startPursuits: false, startDossiers: false, startRecall: false, startProactive: false, startResearch: false,
  startReminders: false, startCharacterGrowth: false, startDailyLife: false, replySleep: async () => {}, clock: () => new Date(now), random: () => 0.42, lifeRandom: () => 0.42,
  integrations: { fetchFeed: async () => { throw new Error('off'); }, fetchArticle: async () => { throw new Error('off'); }, listSpeechVoices: async () => ({ voices: [] }), probeTts: async () => ({ available: false }), closeSpeech: async () => {} },
  fetchSina: async () => ({ items: [] }), zhihuFetchImpl: async () => { throw new Error('off'); }, desktopNotify: async () => ({ requested: false }), fetchImpl: transport,
});
const results = [];
try {
  app.preferences.setReplyPace('instant');
  if (tuning) { const cur = app.companionTuning.get(); app.companionTuning.set({ ...cur.values, ...tuning }, cur.revision); }
  fs.writeFileSync(path.join(dir, 'tuning-used.json'), JSON.stringify(app.companionTuning.get().values));
  app.proactiveRepo.saveSettings({ enabled: true, activeStart: '00:00', activeEnd: '23:59', dailyLimit: 12, minGapMinutes: 5, maxGapMinutes: 20, desktopNotifications: false });
  const address = await app.listen(0), url = `http://127.0.0.1:${address.port}`;
  for (const [index, [advance, type, text]] of turns.entries()) {
    now = new Date(+now + advance * 60000); currentTurn = index;
    const before = app.store.getMessages('miyue').length, callsBefore = wire.length, t0 = performance.now();
    let status = 200, error = null;
    if (type === 'chat') { const r = await fetch(url + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'miyue', text }) }); status = r.status; if (!r.ok) error = (await r.json()).error; }
    else { try { const body = await app.proactive.runNow({ roleId: 'miyue' }); if (!body?.delivered) error = body?.reason || body?.code || 'not delivered'; } catch (e) { error = e.message; } }
    const added = app.store.getMessages('miyue').slice(before).filter(m => m.speaker === 'assistant').map(m => m.text);
    const calls = wire.slice(callsBefore);
    results.push({ index, type, user: text, reply: added.join('\n'), status, error, ms: Math.round(performance.now() - t0), calls });
    process.stderr.write(`#${index} ${type} ${text ?? ''} -> ${added.join(' / ').slice(0, 160)} ${error ?? ''}\n`);
  }
} finally { await app.close(); }
const sum = (xs, f) => xs.reduce((n, x) => n + (f(x) || 0), 0);
// Formulaic-style checks: verbatim example reuse, repeated openings, and
// 4-character phrases that recur across three or more replies.
let voice = null; try { voice = await import('../lib/companion-voice.mjs'); } catch {}
const replies = results.map(r => r.reply).filter(Boolean);
const plain = text => text.replace(/[\s，。！？!?～~、…😏]/gu, '');
const values = { ...(JSON.parse(fs.readFileSync(path.join(dir, 'tuning-used.json'), 'utf8') || '{}')) };
const fragments = voice?.exampleReplies ? voice.exampleReplies(values, { at: new Date(now).toISOString() }) : [];
const grams = new Map();
for (const reply of replies) for (const gram of new Set([...plain(reply)].map((_, i, a) => a.slice(i, i + 4).join('')).filter(g => g.length === 4))) grams.set(gram, (grams.get(gram) || 0) + 1);
const openings = replies.map(r => [...plain(r)].slice(0, 2).join(''));
const formulaic = {
  exampleCopies: replies.filter(r => fragments.some(f => plain(r).includes(f))).length,
  distinctOpenings: `${new Set(openings).size}/${openings.length}`,
  repeatedPhrases: [...grams].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([g, n]) => `${g}×${n}`),
};
const calls = results.flatMap(r => r.calls);
const report = {
  label, live, tuning, turns: results.length,
  callsPerTurn: +(calls.length / results.length).toFixed(2),
  byKind: Object.fromEntries([...new Set(calls.map(c => c.kind))].map(k => { const cs = calls.filter(c => c.kind === k);
    return [k, { n: cs.length, avgChars: Math.round(sum(cs, c => c.chars) / cs.length), prefixReuse: +(sum(cs, c => c.prefixChars) / sum(cs, c => c.chars)).toFixed(3),
      ...(live ? { promptTokens: sum(cs, c => c.usage?.prompt_tokens), cachedTokens: sum(cs, c => c.usage?.prompt_cache_hit_tokens ?? c.usage?.prompt_tokens_details?.cached_tokens) } : {}) }]; })),
  formulaic,
  overallPrefixReuse: +(sum(calls, c => c.prefixChars) / sum(calls, c => c.chars)).toFixed(3),
  ...(live ? { promptTokens: sum(calls, c => c.usage?.prompt_tokens), cachedTokens: sum(calls, c => c.usage?.prompt_cache_hit_tokens ?? c.usage?.prompt_tokens_details?.cached_tokens), completionTokens: sum(calls, c => c.usage?.completion_tokens), medianMs: results.map(r => r.ms).sort((a, b) => a - b)[Math.floor(results.length / 2)] } : {}),
  transcript: results.map(({ calls, ...r }) => ({ ...r, len: r.reply.length, bubbles: r.reply.split('\n').filter(Boolean).length, kinds: calls.map(c => c.kind).join(',') })),
};
fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(dir, 'wire.json'), JSON.stringify(wire, null, 1));
const { transcript, ...summary } = report; console.log(JSON.stringify(summary, null, 1));
