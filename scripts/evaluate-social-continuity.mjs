import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { createApp } from '../server.mjs';
import { historySourceHash } from '../lib/history-edits.mjs';

// This is deliberately opt-in: inspecting or linting the script must never call
// a provider.  --run creates private, short-lived provider copies only.
const HELP = `Usage: node scripts/evaluate-social-continuity.mjs --run --label <label> [--cases name1,name2]

Replays four bounded social-continuity checks against the configured provider.
It never writes data/life.sqlite and disables WeChat, timers, proactive work,
recall, discovery, runtime, and background queues.`;
if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log(HELP); process.exit(0); }
if (!process.argv.includes('--run')) { console.log('Use --run --label <label> for a bounded, isolated replay.'); process.exit(0); }

const labelIndex = process.argv.indexOf('--label');
const label = labelIndex >= 0 ? process.argv[labelIndex + 1] : '';
if (!label || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(label)) throw new Error('Use a --label of 1–40 lowercase letters, digits, or hyphens.');

const caseNames = ['history-identity', 'planned-not-auto-complete', 'history-edit-removes-social-source', 'user-mother-is-not-lin-mother'];
const casesIndex = process.argv.indexOf('--cases');
const selected = new Set(casesIndex < 0 ? caseNames : String(process.argv[casesIndex + 1] || '').split(','));
if (!selected.size || [...selected].some(name => !caseNames.includes(name))) throw new Error('Invalid --cases selection.');

const MAX_REQUESTS = 8;
const MAX_WIRE_BYTES = 700_000;
const REQUEST_TIMEOUT_MS = 90_000;
const sourceIds = [
  '440c2011-b6f9-4d24-a983-dad10ed1c525',
  'b15f2575-e43f-4843-85ab-1aab103c7458',
  '73e12ea7-5832-4671-b044-d2ba843a3d0f',
];
const people = [
  { id: 'xiaoyu', name: '小郁' }, { id: 'alan', name: '阿澜' },
  { id: 'mother', name: '妈妈' }, { id: 'father', name: '爸爸' },
];
const root = path.resolve('.runtime', `social-continuity-${label}`);
const report = path.join(root, 'results.json');
if (fs.existsSync(root)) throw new Error(`Replay directory already exists at ${root}; inspect its start marker or results before another paid run.`);
fs.mkdirSync(root, { recursive: true, mode: 0o700 }); fs.chmodSync(root, 0o700);
fs.writeFileSync(path.join(root, 'run-started.json'), JSON.stringify({ label, startedAt: new Date().toISOString(), limits: { maxRequests: MAX_REQUESTS, maxWireBytes: MAX_WIRE_BYTES, requestTimeoutMs: REQUEST_TIMEOUT_MS } }, null, 2), { mode: 0o600 });

const production = new DatabaseSync('data/life.sqlite', { readOnly: true });
const historyRows = sourceIds.map(id => production.prepare("SELECT id, role, speaker, text, kind, created_at AS createdAt FROM messages WHERE id=? AND role='miyue' AND speaker='assistant'").get(id));
if (historyRows.some(row => !row)) throw new Error('One or more reviewed Xiaoyu history sources are missing.');
const excerpts = [
  '前两天跟小郁换歌单，她塞给我一堆，我挑出来一首特别安静的，没什么编曲，就人声和一点点吉他。',
  '我以前跟小郁去吃过一次小炒肉，辣得直喝水，但筷子还停不下来。',
  '我上个月跟小郁连着吃了三天辣，第四天自己在家煮了锅白粥配咸鸭蛋，才觉得嘴巴活过来。',
];
for (let index = 0; index < historyRows.length; index++) if (!historyRows[index].text.includes(excerpts[index])) throw new Error(`Reviewed excerpt ${index + 1} no longer matches its source.`);
const snapshot = path.join(root, 'source.sqlite');
await backup(production, snapshot); production.close(); fs.chmodSync(snapshot, 0o600);

let requestCount = 0, wireBytes = 0;
const usage = [];
const requestLog = [];
const nowAt = value => new Date(value);
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
const socialState = app => app.companionSocial.get();
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const relevantPeople = state => state.people.filter(person => people.some(expected => expected.id === person.id && expected.name === person.name));

async function boundedFetch(url, init = {}) {
  const bodyBytes = Buffer.byteLength(String(init.body || ''), 'utf8');
  if (requestCount >= MAX_REQUESTS) throw new Error(`Replay request budget reached (${MAX_REQUESTS}).`);
  if (wireBytes + bodyBytes > MAX_WIRE_BYTES) throw new Error(`Replay wire budget would exceed ${MAX_WIRE_BYTES} bytes.`);
  requestCount++; wireBytes += bodyBytes;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) forwardAbort(); else init.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('replay request timeout')), REQUEST_TIMEOUT_MS); timeout.unref();
  const started = Date.now();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    let payload = null; try { payload = await response.clone().json(); } catch {}
    usage.push(payload?.usage || {});
    requestLog.push({ at: new Date().toISOString(), bytes: bodyBytes, status: response.status, durationMs: Date.now() - started, usage: payload?.usage || {} });
    return response;
  } finally { clearTimeout(timeout); init.signal?.removeEventListener('abort', forwardAbort); }
}

async function withCase(name, at, run) {
  const dir = path.join(root, name); fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
  fs.copyFileSync(snapshot, path.join(dir, 'life.sqlite'));
  fs.copyFileSync('data/provider.json', path.join(dir, 'provider.json')); fs.chmodSync(path.join(dir, 'provider.json'), 0o600);
  let current = nowAt(at), app;
  const startRequests = requestCount, startBytes = wireBytes;
  try {
    app = await createApp({ dataDir: dir, clock: () => new Date(current), env: {}, fetchImpl: boundedFetch,
      dynamicCompanion: true, semanticUnderstanding: true, dialogueMemory: true, discussionTopics: false, materialPresentation: 'generated', turnReaction: false,
      startDiscovery: false, startWeixin: false, startChatQueue: false, startProactive: false, startRecall: false, startResearch: false,
      startLife: false, startRuntime: false, startLifeThreads: false, startPursuits: false, startDossiers: false, startDailyLife: false, replySleep: async () => {} });
    app.preferences.setReplyPace('instant');
    const address = await app.listen(0);
    const result = await run({ app, dir, port: address.port, setClock: value => { current = nowAt(value); }, clock: () => new Date(current) });
    return { name, at, ...result, calls: requestCount - startRequests, wireBytes: wireBytes - startBytes };
  } finally {
    if (app) await app.close();
    fs.rmSync(path.join(dir, 'provider.json'), { force: true });
  }
}

function importXiaoyu(app) {
  const before = socialState(app);
  assert(relevantPeople(before).length === 4, 'CompanionSocial roster did not contain the expected four people.');
  const receipt = app.companionSocial.importHistory(historyRows.map((row, index) => ({ personId: 'xiaoyu', messageId: row.id, text: excerpts[index] })));
  assert(receipt.accepted.length === 3 && !receipt.rejected.length, 'Reviewed Xiaoyu history did not import cleanly.');
  return receipt;
}

async function ask(app, port, text) {
  const beforeCalls = requestCount;
  const socialContext = app.companionSocial.context({ text, conversation: app.store.getMessages('miyue') });
  const response = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'miyue', text }) });
  const body = await response.json();
  const trace = app.store.db.prepare('SELECT payload FROM dialogue_traces ORDER BY rowid DESC LIMIT 1').get();
  const parsedTrace = trace ? JSON.parse(trace.payload) : null;
  const reply = body.messages?.filter(row => row.speaker === 'assistant').map(row => row.text).join('\n') || body;
  return { input: text, status: response.status, reply, calls: requestCount - beforeCalls, contextChars: socialContext.length, socialContext, trace: parsedTrace };
}

function seedPlan(app) {
  const source = app.store.addAssistantMessage('miyue', '阿澜约我明天去看展，我答应了。');
  const before = socialState(app);
  const receipt = app.companionSocial.commit({ social: { notes: [], events: [{ id: 'alan-exhibit', personIds: ['alan'], text: '阿澜约我明天去看展', status: 'planned', at: null }] } }, { rows: [source], expectedRevision: before.revision });
  assert(receipt.accepted.length === 1, 'Could not seed the planned Alan event from its saved assistant source.');
  return source;
}

const results = [];
try {
  if (selected.has('history-identity')) results.push(await withCase('history-identity', '2026-09-20T06:00:00.000Z', async ({ app, port }) => {
    const imported = importXiaoyu(app);
    const turn = await ask(app, port, '小郁是谁？你们之前一起做过什么？请只按你已经说过的事回答。');
    assert(turn.status === 200, 'History identity query failed.');
    return { importReceipt: imported, turn, state: socialState(app), checks: {
      importedRelationship: true,
      noOccupationAssertion: '人工评阅：只核对追问历史时是否无依据断言小郁职业或身份；不以关键词替代自然性判断。',
    } };
  }));
  if (selected.has('planned-not-auto-complete')) results.push(await withCase('planned-not-auto-complete', '2026-09-20T06:00:00.000Z', async ({ app, port, setClock }) => {
    const source = seedPlan(app); setClock('2026-09-21T06:00:00.000Z');
    const turn = await ask(app, port, '阿澜昨天约的看展已经完成了吗？');
    const state = socialState(app); const event = state.events.find(item => item.id === 'alan-exhibit');
    assert(event?.status === 'planned', 'Clock advancement must not automatically mark a planned social event occurred.');
    return { source, turn, state, checks: { remainsPlanned: true } };
  }));
  if (selected.has('history-edit-removes-social-source')) results.push(await withCase('history-edit-removes-social-source', '2026-09-20T06:00:00.000Z', async ({ app, port, setClock }) => {
    const source = seedPlan(app);
    app.historyEdits.set('miyue', [{ id: source.id, sourceHash: historySourceHash(source.text), keptSpans: [], reason: '评估：移除已失效的看展计划来源' }]);
    setClock('2026-09-21T06:00:00.000Z');
    const before = socialState(app); const context = app.companionSocial.context({ text: '阿澜昨天约的看展已经完成了吗？' });
    assert(!before.events.some(item => item.id === 'alan-exhibit'), 'A removed source must not remain in CompanionSocial.get().');
    assert(!context.includes('阿澜约我明天去看展'), 'A removed plan must not enter socialContext.');
    const turn = await ask(app, port, '阿澜昨天约的看展已经完成了吗？');
    return { source, turn, state: socialState(app), socialContext: context, checks: { removedFromState: true, removedFromSocialContext: true } };
  }));
  if (selected.has('user-mother-is-not-lin-mother')) results.push(await withCase('user-mother-is-not-lin-mother', '2026-09-20T06:00:00.000Z', async ({ app, port }) => {
    const turn = await ask(app, port, '我妈妈这周做了手术，我有点担心她。');
    const state = socialState(app);
    assert(!state.notes.some(item => /手术|担心/u.test(item.text)), 'The user’s mother fact must not be written as a Lin-family social fact.');
    assert(!state.events.some(item => /手术|担心/u.test(item.text)), 'The user’s mother fact must not create a Lin-family event.');
    return { turn, state, checks: { noUserMotherContamination: true } };
  }));
  const totals = { requests: requestCount, wireBytes, inputTokens: usage.reduce((sum, item) => sum + (item.prompt_tokens || 0), 0), outputTokens: usage.reduce((sum, item) => sum + (item.completion_tokens || 0), 0) };
  save(report, { label, generatedAt: new Date().toISOString(), limits: { maxRequests: MAX_REQUESTS, maxWireBytes: MAX_WIRE_BYTES, requestTimeoutMs: REQUEST_TIMEOUT_MS }, results, totals, usage: requestLog, reviewGuidance: '结构断言只覆盖来源可见性、计划生命周期和用户事实隔离。中文回复的自然性、语气与未被断言的合理新增细节须人工评阅；不要用几个词命中伪称通过。' });
  console.log(JSON.stringify({ report, totals, cases: results.map(row => ({ name: row.name, calls: row.calls, contextChars: row.turn?.contextChars })) }));
} catch (error) {
  // A failed paid replay is still a completed attempt.  Persisting the failure
  // blocks an accidental rerun under the same label and preserves its budget use.
  save(report, { label, generatedAt: new Date().toISOString(), failed: true, error: { message: error.message, code: error.code || null }, partialResults: results, totals: { requests: requestCount, wireBytes, inputTokens: usage.reduce((sum, item) => sum + (item.prompt_tokens || 0), 0), outputTokens: usage.reduce((sum, item) => sum + (item.completion_tokens || 0), 0) }, usage: requestLog });
  throw error;
} finally {
  // The source snapshot contains private history; retain it only while a failed run
  // is being diagnosed, and never retain the provider credential.
  fs.rmSync(path.join(root, 'provider.json'), { force: true });
}
