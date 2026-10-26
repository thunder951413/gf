// Turn-by-turn simulation on an isolated fork of the data directory, with the
// real model and the real chat/proactive/morning code paths, but no HTTP
// server (works where binding a port is not allowed). Built so another agent
// can play him one message at a time.
//
//   node scripts/simulate-session.mjs init --label x [--source data/life.sqlite] [--start 2026-10-26T08:00+08:00] [--identity human|ai] [--preset in-love]
//   node scripts/simulate-session.mjs say --label x --text "早上好" [--advance 30m]
//   node scripts/simulate-session.mjs proactive --label x [--advance 2h]
//   node scripts/simulate-session.mjs morning --label x [--advance 1d] [--at 08:00]
//   node scripts/simulate-session.mjs show --label x
//   node scripts/simulate-session.mjs log --label x
//   node scripts/simulate-session.mjs persona --label x --json '{"background":"...","temperament":"..."}'
//   node scripts/simulate-session.mjs affect --label x   (her current feelings and recent appraisals)
//   node scripts/simulate-session.mjs ledger --label x   (relationship ledger snapshot, incl. learned interests)
// Each command prints one JSON object. Everything stays in .runtime/simulations/<label>/.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { forkSession } from '../lib/session-snapshot.mjs';
import { createApp } from '../server.mjs';
import { TUNING_PRESETS } from '../lib/companion-tuning.mjs';
import { weeklyReport, reportMarkdown } from '../lib/weekly-report.mjs';
import { savePersona } from '../lib/persona-overrides.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...rest] = process.argv.slice(2);
const value = name => { const i = rest.indexOf(name); return i < 0 ? null : rest[i + 1]; };
const label = value('--label');
if (!/^[a-z0-9-]+$/.test(label || '')) fail('--label 需要英文小写标签');
const dir = path.join(root, '.runtime', 'simulations', label), statePath = path.join(dir, 'sim.json');
const out = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
function fail(message) { process.stdout.write(JSON.stringify({ error: message }) + '\n'); process.exit(1); }
const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
const writeState = state => fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
const shanghai = at => new Date(+new Date(at) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
function advance(now, spec) {
  if (!spec) return now;
  const match = /^(\d+(?:\.\d+)?)(m|h|d)$/u.exec(spec); if (!match) fail('--advance 形如 30m、3h、1d');
  return new Date(+now + Number(match[1]) * { m: 60000, h: 3600000, d: 86400000 }[match[2]]);
}

if (command === 'init') {
  if (fs.existsSync(dir)) fail('标签已存在：' + dir);
  const source = path.resolve(value('--source') || path.join(root, 'data', 'life.sqlite'));
  const db = new DatabaseSync(source, { readOnly: true });
  let provider; try { provider = JSON.parse(fs.readFileSync(path.join(root, 'data', 'provider.json'), 'utf8')); } catch {}
  try { await forkSession({ db }, { targetDir: dir, sourceDir: null, provider }); } finally { db.close(); }
  const start = value('--start') ? new Date(value('--start')) : new Date();
  writeState({ now: start.toISOString(), identity: value('--identity') || null, preset: value('--preset') || null, createdAt: new Date().toISOString(), firstMessageRowid: null });
}

const state = readState();
let now = new Date(state.now);
const wirePath = path.join(dir, 'wire.jsonl');
const transport = async (url, init = {}) => {
  const started = performance.now();
  const response = await fetch(url, init);
  const text = await response.text();
  let parsed; try { parsed = JSON.parse(text); } catch {}
  let purpose = null; try { purpose = JSON.parse(init.body || '{}')?.metadata?.purpose || null; } catch {}
  fs.appendFileSync(wirePath, JSON.stringify({ at: now.toISOString(), command, ms: Math.round(performance.now() - started), status: response.status, usage: parsed?.usage || null, purpose }) + '\n');
  return new Response(text, { status: response.status, headers: response.headers });
};
const app = await createApp({
  dataDir: dir, initialFeeds: [], env: {}, activeRoleIds: ['miyue'], disableStory: true, dailyCompression: true,
  dynamicCompanion: true, sessionDialogue: true, semanticUnderstanding: true, dialogueMemory: true, discussionTopics: true, sourceRelevance: false,
  materialPresentation: 'generated', startDiscovery: false, startWeixin: false, startChatQueue: false, startRuntime: false, startLife: false,
  startPursuits: false, startDossiers: false, startRecall: false, startProactive: false, startResearch: false, startDailyHappenings: false,
  startReminders: false, startCharacterGrowth: false, startDailyLife: false, startDailyInformation: false, chatDebounceMs: 0,
  replySleep: async () => {}, clock: () => new Date(now), replyRandom: () => 0,
  integrations: { fetchFeed: async () => { throw new Error('off'); }, fetchArticle: async () => { throw new Error('off'); }, listSpeechVoices: async () => ({ voices: [] }), probeTts: async () => ({ available: false }), closeSpeech: async () => {} },
  fetchSina: async () => ({ items: [] }), zhihuFetchImpl: async () => { throw new Error('off'); }, desktopNotify: async () => ({ requested: false }), fetchImpl: transport,
});
const assistantSince = rowid => app.store.db.prepare("SELECT id,text,kind,created_at FROM messages WHERE role='miyue' AND speaker='assistant' AND rowid>? ORDER BY rowid").all(rowid);
const lastRowid = () => app.store.db.prepare('SELECT COALESCE(MAX(rowid),0) n FROM messages').get().n;
async function settle(timeoutMs = 240000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const queued = app.store.db.prepare("SELECT state,error FROM chat_queue WHERE role_id='miyue'").get();
    const pending = app.store.db.prepare("SELECT COUNT(*) n FROM reply_delivery WHERE role_id='miyue' AND state='pending'").get().n;
    if (queued?.state === 'failed') return { error: queued.error || "failed" };
    if ((!queued || queued.state === 'idle') && !pending && !app.chatQueue.busy('miyue')) return {};
    if (Date.now() > deadline) return { error: 'timeout' };
    await new Promise(resolve => setTimeout(resolve, 250));
  }
}

try {
  app.preferences.setReplyPace('instant');
  if (command === 'init') {
    // Without --identity the fork keeps whatever identity the source had.
    if (state.identity && state.identity !== app.companionIdentity.get().mode) app.companionIdentity.set(state.identity, app.companionIdentity.get().revision, { now });
    if (state.preset) { const preset = TUNING_PRESETS.find(item => item.id === state.preset); if (!preset) fail('没有这个预设'); app.companionTuning.set(preset.values, app.companionTuning.get().revision); }
    state.firstMessageRowid = lastRowid(); writeState(state);
    out({ ok: true, dir, now: shanghai(now), identity: app.companionIdentity.get().mode, tuning: app.companionTuning.get().values });
  } else if (command === 'say') {
    const text = value('--text'); if (!text) fail('--text 必填');
    now = advance(now, value('--advance'));
    await app.dailyMemory.ensureBeforeInteraction('miyue').catch(() => {});
    const before = lastRowid();
    app.chatQueue.start(); app.replyDelivery.start();
    app.chatQueue.submit('miyue', text, `sim-${Date.now()}`, { replyChannel: 'desktop' });
    const settled = await settle();
    state.now = now.toISOString(); writeState(state);
    out({ at: shanghai(now), he: text, she: assistantSince(before).map(row => row.text), ...settled });
  } else if (command === 'proactive') {
    now = advance(now, value('--advance'));
    const before = lastRowid();
    const result = await app.proactive.runNow({ roleId: 'miyue' }).catch(error => ({ delivered: false, reason: error.message }));
    const added = assistantSince(before);
    const material = added.length ? app.store.db.prepare('SELECT material_id,kind FROM proactive_material_deliveries WHERE message_id=?').get(added.at(-1).id) || null : null;
    state.now = now.toISOString(); writeState(state);
    out({ at: shanghai(now), delivered: Boolean(result?.delivered), reason: result?.reason || null, she: added.map(row => row.text), material });
  } else if (command === 'morning') {
    now = advance(now, value('--advance') || '1d');
    if (value('--at')) { const day = new Date(+now + 8 * 3600000).toISOString().slice(0, 10); now = new Date(`${day}T${value('--at')}:00+08:00`); }
    const memory = await app.dailyMemory.ensureBeforeInteraction('miyue').catch(error => ({ status: 'failed', error: error.message }));
    const arcs = await app.storyArcs.ensure('miyue', { force: true });
    const ledger = await app.relationshipLedger.ensure('miyue', { force: true });
    const happenings = await app.dailyHappenings.ensure('miyue', { force: true, ignoreBusy: true });
    state.now = now.toISOString(); writeState(state);
    const snap = app.dailyHappenings.snapshot('miyue');
    out({ at: shanghai(now), memory: memory?.status, arcs: { status: arcs.status, error: arcs.error }, ledger: { status: ledger.status, added: ledger.added, closed: ledger.closed, updated: ledger.updated, error: ledger.error },
      happenings: { status: happenings.status, error: happenings.error, mood: snap.mood, onMind: snap.onMind, items: snap.items.map(item => item.text), followUps: snap.userThreads.filter(item => item.status === 'open').map(item => item.text) },
      week: app.storyArcs.stableContext('miyue') });
  } else if (command === 'show') {
    out({ at: shanghai(now), identity: app.companionIdentity.get().mode, week: app.storyArcs.stableContext('miyue'), ledger: app.relationshipLedger.stableContext('miyue'),
      today: app.dailyHappenings.stableContext('miyue'), report: reportMarkdown(weeklyReport(app.store.db, { now })) });
  } else if (command === 'persona') {
    const values = savePersona(app.store.db, JSON.parse(value('--json') || '{}'));
    out({ ok: true, values, note: '下一条命令起生效' });
  } else if (command === 'ledger') {
    const snap = app.relationshipLedger.snapshot('miyue');
    out({ open: Object.fromEntries(Object.entries(snap.open).map(([kind, items]) => [kind, items.map(({ text, topic, area, about, her, his, mood, appliedArc }) => Object.fromEntries(Object.entries({ text, topic, area, about, her, his, mood, appliedArc }).filter(([, v]) => v !== undefined)))])),
      interests: snap.interests, week: app.storyArcs.stableContext('miyue') });
  } else if (command === 'affect') {
    const snap = app.affect.snapshot('miyue', { now });
    out({ at: shanghai(now), state: Object.fromEntries(Object.entries(snap.state).filter(([key]) => ['warmth', 'hurt', 'desire', 'security'].includes(key)).map(([k, v]) => [k, Math.round(v)])),
      causes: snap.state.causes, feeling: app.affect.context('miyue', { now }), recent: snap.recent.slice(0, 6) });
  } else if (command === 'log') {
    const rows = app.store.db.prepare("SELECT speaker,text,kind,created_at FROM messages WHERE role='miyue' AND rowid>? ORDER BY rowid").all(state.firstMessageRowid || 0);
    out(rows.map(row => `${shanghai(row.created_at)} ${row.speaker === 'user' ? '他' : row.kind === 'proactive' ? '她（主动）' : '她'}：${row.text}`));
  } else if (command !== 'init') fail('未知命令：' + command);
} finally { await app.close(); }
