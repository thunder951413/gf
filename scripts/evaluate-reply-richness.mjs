import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { createApp } from '../server.mjs';

// This deliberately requires an explicit opt-in.  A normal invocation, --help,
// and test discovery must never contact the configured provider.
const HELP = `Usage: node scripts/evaluate-reply-richness.mjs --run --label <label> [--cases affection,lunch,open-chat] [--heldout] [--history-edits private.json]

Replays up to three short Chinese companion turns against the configured provider.
Each request runs from a private, short-lived SQLite/provider copy.  It never
writes data/life.sqlite, starts WeChat, or starts background services.`;
if (process.argv.includes('--help') || process.argv.includes('-h')) { console.log(HELP); process.exit(0); }
if (!process.argv.includes('--run')) { console.log('Use --run --label <label> for a bounded, isolated replay.'); process.exit(0); }

const valueAfter = flag => { const index = process.argv.indexOf(flag); return index < 0 ? '' : String(process.argv[index + 1] || ''); };
const label = valueAfter('--label');
if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(label)) throw new Error('Use a --label of 1–40 lowercase letters, digits, or hyphens.');

const CASES = [
  { name: 'affection', text: '嗯呢，我刚收拾完，也是开了电脑呢。在想你' },
  { name: 'lunch', text: '饿了～再等会出去吃饭，你吃了么' },
  { name: 'open-chat', text: '先不聊工作了，陪我聊一会儿吧' },
];
const selectedNames = valueAfter('--cases') ? valueAfter('--cases').split(',') : CASES.map(item => item.name);
if (!selectedNames.length || selectedNames.some(name => !CASES.some(item => item.name === name))) throw new Error('Invalid --cases selection.');
const selected = CASES.filter(item => selectedNames.includes(item.name));
const editsPath=valueAfter('--history-edits');
const reviewedEdits=editsPath?JSON.parse(fs.readFileSync(editsPath,'utf8')):[];
if(!Array.isArray(reviewedEdits)||reviewedEdits.length>50)throw new Error('Invalid reviewed history batch');
const heldout=process.argv.includes('--heldout');
const variations={affection:'明明才聊过一会儿，现在又有点想你了，想抱抱你。',lunch:'准备去填饱肚子啦，你中午想吃点什么呀？', 'open-chat':'歇会儿，想听你随便说点自己的小想法，别一直讲干活了。'};
if(heldout)for(const item of selected)item.text=variations[item.name];

const MAX_REQUESTS = 8;
const MAX_WIRE_BYTES = 650_000;
const REQUEST_TIMEOUT_MS = 90_000;
const root = path.resolve('.runtime', `reply-richness-${label}`);
const reportPath = path.join(root, 'results.json');
const snapshotPath = path.join(root, 'source.sqlite');
if (fs.existsSync(root)) throw new Error(`Replay directory already exists at ${root}; inspect its results before another paid run.`);
fs.mkdirSync(root, { recursive: true, mode: 0o700 }); fs.chmodSync(root, 0o700);
const save = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
save(path.join(root, 'run-started.json'), { label, startedAt: new Date().toISOString(), cases: selectedNames, limits: { maxRequests: MAX_REQUESTS, maxWireBytes: MAX_WIRE_BYTES, requestTimeoutMs: REQUEST_TIMEOUT_MS } });

const source = new DatabaseSync('data/life.sqlite', { readOnly: true });
const findSource = source.prepare(`SELECT id, text, created_at AS createdAt
  FROM messages WHERE role='miyue' AND speaker='user' AND text=? ORDER BY created_at DESC, rowid DESC LIMIT 1`);
const findReply = source.prepare(`SELECT id, text, created_at AS createdAt
  FROM messages WHERE role='miyue' AND speaker='assistant' AND created_at>=? ORDER BY created_at, rowid LIMIT 1`);
const newest = source.prepare("SELECT created_at AS createdAt FROM messages WHERE role='miyue' ORDER BY created_at DESC, rowid DESC LIMIT 1").get();
const evaluationNow = new Date(Math.max(Date.now(), new Date(newest.createdAt).getTime() + 1)).toISOString();
for (const item of selected) {
  item.source = findSource.get(item.text) || null;
  item.productionReply = item.source ? findReply.get(item.source.createdAt) || null : null;
  // These are new continuation prompts on one current-history snapshot, rather
  // than historical rewinds. This prevents current derived state from being
  // paired with a clock before the historical source that created it.
  item.at = evaluationNow;
}
await backup(source, snapshotPath); source.close(); fs.chmodSync(snapshotPath, 0o600);

let requestCount = 0;
let wireBytes = 0;
const requestLog = [];
const usage = [];
async function boundedFetch(url, init = {}) {
  const body = String(init.body || '');
  const bytes = Buffer.byteLength(body, 'utf8');
  if (requestCount >= MAX_REQUESTS) throw new Error(`Replay request budget reached (${MAX_REQUESTS}).`);
  if (wireBytes + bytes > MAX_WIRE_BYTES) throw new Error(`Replay wire budget would exceed ${MAX_WIRE_BYTES} bytes.`);
  requestCount++; wireBytes += bytes;
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) forwardAbort(); else init.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('reply-richness replay timeout')), REQUEST_TIMEOUT_MS); timeout.unref();
  const started = Date.now();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    let payload = null; try { payload = await response.clone().json(); } catch {}
    const entry = { at: new Date().toISOString(), bytes, status: response.status, durationMs: Date.now() - started, usage: payload?.usage || {}, messages: (() => { try { return JSON.parse(body).messages || []; } catch { return []; } })() };
    requestLog.push(entry); usage.push(entry.usage);
    return response;
  } finally { clearTimeout(timeout); init.signal?.removeEventListener('abort', forwardAbort); }
}

function currentHistoryIsolation() {
  return { mode: 'current-history-new-input', historyCutoff: null, derivedState: 'current production snapshot; this is not a historical replay' };
}

async function replay(item) {
  const dir = path.join(root, item.name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700);
  fs.copyFileSync(snapshotPath, path.join(dir, 'life.sqlite'));
  fs.copyFileSync('data/provider.json', path.join(dir, 'provider.json')); fs.chmodSync(path.join(dir, 'provider.json'), 0o600);
  const isolation = currentHistoryIsolation();
  let app;
  const firstRequest = requestLog.length;
  const startRequests = requestCount, startBytes = wireBytes;
  try {
    app = await createApp({ dataDir: dir, clock: () => new Date(item.at), env: {}, fetchImpl: boundedFetch,
      dynamicCompanion: true, semanticUnderstanding: true, dialogueMemory: true, discussionTopics: true, materialPresentation: 'generated', turnReaction: false,
      startDiscovery: false, startWeixin: false, startChatQueue: false, startProactive: false, startRecall: false, startResearch: false,
      startLife: false, startRuntime: false, startLifeThreads: false, startPursuits: false, startDossiers: false, startDailyLife: false, replySleep: async () => {} });
    if(reviewedEdits.length)app.historyEdits.set('miyue',reviewedEdits);
    app.preferences.setReplyPace('instant');
    const { port } = await app.listen(0);
    const response = await fetch(`http://127.0.0.1:${port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'miyue', text: item.text }) });
    const body = await response.json();
    const traceRow = app.store.db.prepare('SELECT payload FROM dialogue_traces ORDER BY rowid DESC LIMIT 1').get();
    const reply = body.messages?.filter(row => row.speaker === 'assistant').map(row => row.text).join('\n') || body;
    return { name: item.name, input: item.text, clock: item.at, status: response.status, reply, trace: traceRow ? JSON.parse(traceRow.payload) : null,
      productionComparison: item.source ? { sourceMessageId: item.source.id, sourceCreatedAt: item.source.createdAt, actualReply: item.productionReply ? { id: item.productionReply.id, text: item.productionReply.text, createdAt: item.productionReply.createdAt } : null, note: 'The source reply is a qualitative reference only. This request is a new continuation on current history, not an exact replay.' } : { actualReply: null, note: 'New prompt with the current production history; no exact production reply exists for comparison.' },
      isolation, reviewedHistoryEdits:reviewedEdits.length, calls: requestCount - startRequests, wireBytes: wireBytes - startBytes, requestMessages: requestLog.slice(firstRequest) };
  } finally {
    if (app) await app.close();
    // Provider credentials and the entire private database are ephemeral. The
    // report retains only the bounded request messages, trace, usage, and reply.
    fs.rmSync(path.join(dir, 'provider.json'), { force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const results = [];
const totals = () => ({ requests: requestCount, wireBytes, inputTokens: usage.reduce((sum, item) => sum + (item.prompt_tokens || 0), 0), outputTokens: usage.reduce((sum, item) => sum + (item.completion_tokens || 0), 0) });
try {
  for (const item of selected) {
    results.push(await replay(item));
    save(path.join(root, 'partial-results.json'), { label, results, totals: totals() });
  }
  save(reportPath, { label, generatedAt: new Date().toISOString(), mode: 'current-history new-continuation evaluation; not an exact historical replay', limits: { maxRequests: MAX_REQUESTS, maxWireBytes: MAX_WIRE_BYTES, requestTimeoutMs: REQUEST_TIMEOUT_MS }, results, totals: totals(), reviewGuidance: '人工评阅回复是否接住亲近、饮食和开放聊天请求，是否避免只谈工作、喝水、让用户先忙或重复收尾。记录用于审阅，不自动以关键词判定自然性。' });
  console.log(JSON.stringify({ report: reportPath, totals: totals(), cases: results.map(row => ({ name: row.name, status: row.status, calls: row.calls })) }));
} catch (error) {
  save(reportPath, { label, generatedAt: new Date().toISOString(), failed: true, error: { message: error.message, code: error.code || null }, partialResults: results, totals: totals(), usage: requestLog });
  throw error;
} finally {
  fs.rmSync(snapshotPath, { force: true });
  // A failure before replay() reaches its finally can leave an empty case folder.
  for (const item of selected) fs.rmSync(path.join(root, item.name), { recursive: true, force: true });
}
