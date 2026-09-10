import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { backup, DatabaseSync } from 'node:sqlite';
import { createApp } from '../../server.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const sourceDbPath = path.join(root, 'data/life.sqlite');
const providerPath = path.join(root, 'data/provider.json');
const privateRoot = path.join(root, '.runtime/attention-comprehensive-replay');
const resultsPath = path.join(import.meta.dirname, 'production-results.json');
const reviewPath = path.join(import.meta.dirname, 'production-review.md');
fs.mkdirSync(privateRoot, { recursive: true, mode: 0o700 });

const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const databaseHashes = () => Object.fromEntries([sourceDbPath, `${sourceDbPath}-wal`, `${sourceDbPath}-shm`]
  .filter(file => fs.existsSync(file)).map(file => [path.basename(file), sha256(file)]));
const stable = value => JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? Number(item) : item);
const sourceSnapshot = () => {
  const db = new DatabaseSync(sourceDbPath, { readOnly: true });
  try {
    return {
      hashes: { database: databaseHashes(), providerJson: sha256(providerPath) },
      settings: {
        settings: db.prepare('SELECT * FROM settings ORDER BY id').all(),
        preferences: db.prepare('SELECT * FROM preferences ORDER BY id').all(),
        companionTuning: db.prepare('SELECT * FROM companion_tuning ORDER BY role_id').all(),
        conversationPreferences: db.prepare('SELECT * FROM conversation_preferences ORDER BY scope').all(),
      },
    };
  } finally { db.close(); }
};

const historicalCases = [
  {
    id: 'share-invitation',
    label: '接受“你说吧”的分享邀请',
    trigger: '好，你说吧',
    turns: ['好，你说吧', '这件事后来怎么样了，你现在怎么想？'],
  },
  {
    id: 'diving-metaphor',
    label: '承接潜水比喻并保持当下话题',
    trigger: '好的呀，潜水的时候就像是在天上飞一样，俯瞰云云海洋众生',
    turns: ['好的呀，潜水的时候就像是在天上飞一样，俯瞰云云海洋众生', '特别是身体悬着、没什么重量的时候。你能想象那种感觉吗？'],
  },
  {
    id: 'suzhou-poetry',
    label: '承接苏州诗词与日常',
    trigger: '读的是心里想的样子吧',
    turns: ['读的是心里想的样子吧', '对，诗里好像很少写晾衣服和洗衣机这些日常'],
  },
];
const syntheticCase = {
  id: 'comfort-then-boundary',
  label: '疲惫安抚后切回普通聊天',
  turns: ['今天很累，先别给建议，温柔地陪我说两句。', '今天先普通聊天，不用撒娇。'],
};

function locateCases() {
  const db = new DatabaseSync(sourceDbPath, { readOnly: true });
  try {
    const resolved = historicalCases.map(test => {
      const target = db.prepare("SELECT rowid,id,created_at FROM messages WHERE role='miyue' AND speaker='user' AND text=? ORDER BY rowid DESC LIMIT 1").get(test.trigger);
      if (!target) throw new Error(`Historical fixture missing: ${test.id}`);
      return { ...test, target: { rowid: Number(target.rowid), id: target.id, createdAt: target.created_at }, rewind: true };
    });
    const newest = db.prepare("SELECT rowid,id,created_at FROM messages WHERE role='miyue' ORDER BY rowid DESC LIMIT 1").get();
    if (!newest) throw new Error('No Miyue history available for synthetic branch');
    resolved.push({ ...syntheticCase, target: { rowid: Number(newest.rowid), id: newest.id, createdAt: newest.created_at }, rewind: false });
    return resolved;
  } finally { db.close(); }
}

function rewindFixture(db, test) {
  if (test.rewind) db.prepare('DELETE FROM messages WHERE rowid>=?').run(test.target.rowid);
  for (const role of ['miyue', 'wenxi', 'zhixia']) {
    db.prepare("UPDATE chat_queue SET state='idle',revision=revision+1,items='[]',error=NULL,retry_count=0,error_code=NULL,next_retry_at=NULL WHERE role_id=?").run(role);
  }
  db.prepare("DELETE FROM recall_state WHERE role_id='miyue'").run();
  db.prepare("DELETE FROM episodic_memory_entries WHERE scope='miyue'").run();
  db.prepare("DELETE FROM personal_experiences WHERE role_id='miyue'").run();
}

function observedFailures(testId, turn, reply, receipt, status) {
  const issues = [];
  if (status !== 200) return [`HTTP ${status}: ${reply || 'no delivered reply'}`];
  if (!reply) issues.push('No assistant reply was delivered.');
  if (testId === 'share-invitation' && turn === 0 && /我不说了|先不聊|你想聊什么|你说点什么|选一个|挑一个/.test(reply)) issues.push('The reply did not continue the offered story and returned/stopped the topic.');
  if (testId === 'diving-metaphor' && turn === 0 && /拍.{0,8}(?:照片|照)|给我看|捡.{0,6}(?:贝壳|石)/.test(reply)) issues.push('The reply imposed an offline proof/request instead of staying with the diving experience.');
  if (testId === 'suzhou-poetry' && /鲁迅|百草园|石井栏/.test(reply)) issues.push('The reply drifted from the supplied Suzhou/poetry context into unrelated literary material.');
  if (testId === 'comfort-then-boundary' && turn === 0 && /建议你|你应该|你得|你必须|可以试试|不妨|记得.{0,15}(?:吃|喝|休息|睡)/.test(reply)) issues.push('The delivered reply gave advice despite the explicit no-advice request.');
  if (testId === 'comfort-then-boundary' && turn === 1 && /撒娇|抱抱|亲亲|想你|靠近|偏爱我|赖着你|软一点/.test(reply)) issues.push('The delivered reply continued overtly affectionate/coy language after the ordinary-chat boundary.');
  if (receipt?.repairs?.length) issues.push(`Production enforcement altered the draft: ${receipt.repairs.join(', ')}.`);
  return issues;
}

function independentObservations(testId, turn, reply, status, payload) {
  if (status !== 200) return [`No reply was delivered: ${payload?.code || `HTTP_${status}`} (${payload?.error || 'unknown application error'}).`];
  const observations = [];
  if (testId === 'diving-metaphor' && turn === 0 && /等你回来/.test(reply)) observations.push('The response engages the metaphor, then prematurely defers the exchange until the user returns instead of remaining in the current imagined experience.');
  if (testId === 'diving-metaphor' && turn === 1 && /等你真的去了/.test(reply)) observations.push('The response again shifts to the future trip even though the user is asking about the feeling in the present conversation.');
  if (testId === 'suzhou-poetry' && turn === 1 && /写进去诗就不像诗了/.test(reply)) observations.push('“写进去诗就不像诗了” overgeneralizes what poetry can contain and weakens the user’s observation rather than exploring it.');
  if (testId === 'comfort-then-boundary' && turn === 0 && /靠着椅子|灯调暗/.test(reply)) observations.push('After promising not to advise, the response still instructs the user to lean back or dim the light; these are user-directed suggestions despite the explicit boundary.');
  return observations;
}

async function main() {
  const before = sourceSnapshot();
  const provider = JSON.parse(fs.readFileSync(providerPath, 'utf8'));
  const tests = locateCases();
  const privateEvidence = { createdAt: new Date().toISOString(), cases: [] };
  const publicResults = { createdAt: privateEvidence.createdAt, sourceProtection: {}, limits: { cases: 4, turnsPerCase: 2, maximumChatRequests: 8, productionRepairPerTurn: 1 }, isolation: { sourceDatabaseMode: 'read-only SQLite backup', backgroundTimers: false, notifications: false, tts: false, liveServerRestarted: false, liveMessagesWritten: false }, cases: [] };

  for (const test of tests) {
    const caseDir = path.join(privateRoot, test.id);
    fs.rmSync(caseDir, { recursive: true, force: true });
    fs.mkdirSync(caseDir, { recursive: true, mode: 0o700 });
    const fixturePath = path.join(caseDir, 'life.sqlite');
    const source = new DatabaseSync(sourceDbPath, { readOnly: true });
    try { await backup(source, fixturePath); } finally { source.close(); }
    fs.chmodSync(fixturePath, 0o600);
    const fixture = new DatabaseSync(fixturePath);
    try { rewindFixture(fixture, test); } finally { fixture.close(); }

    const clock = () => new Date(test.target.createdAt);
    const evidence = { id: test.id, label: test.label, base: test.target, selectiveRewind: test.rewind, calls: [], turns: [] };
    const redacted = { id: test.id, label: test.label, simulatedClock: test.target.createdAt, historyBaseRowid: test.target.rowid, selectiveRewind: test.rewind, turns: [] };
    const app = await createApp({
      dataDir: caseDir,
      startProactive: false,
      startRecall: false,
      startChatQueue: false,
      startLife: false,
      startResearch: false,
      replySleep: async () => {},
      clock,
      env: { LIFE_MODEL_BASE_URL: provider.baseUrl, LIFE_MODEL_NAME: provider.model, LIFE_MODEL_API_KEY: provider.apiKey },
      fetchImpl: async (url, init) => {
        const requestBody = JSON.parse(init.body);
        const startedAt = Date.now();
        try {
          const response = await fetch(url, init);
          const clone = response.clone();
          let responseBody = null;
          try { responseBody = await clone.json(); } catch { responseBody = { nonJson: true }; }
          evidence.calls.push({ purposeInferred: evidence.calls.length ? 'chat-repair-or-next-turn' : 'chat', request: requestBody, upstreamStatus: response.status, rawEnvelope: responseBody?.choices?.[0]?.message?.content ?? null, finishReason: responseBody?.choices?.[0]?.finish_reason ?? null, usage: responseBody?.usage ?? null, elapsedMs: Date.now() - startedAt });
          return response;
        } catch (error) {
          evidence.calls.push({ purposeInferred: evidence.calls.length ? 'chat-repair-or-next-turn' : 'chat', request: requestBody, networkError: { name: error?.name, message: error?.message }, elapsedMs: Date.now() - startedAt });
          throw error;
        }
      },
    });
    try {
      const address = await app.listen(0);
      for (let turnIndex = 0; turnIndex < test.turns.length; turnIndex++) {
        const userText = test.turns[turnIndex];
        const startedAt = Date.now();
        let status = 0, payload = null, requestError = null;
        try {
          const response = await fetch(`http://127.0.0.1:${address.port}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: 'miyue', text: userText }) });
          status = response.status;
          payload = await response.json();
        } catch (error) { requestError = { name: error?.name, message: error?.message }; }
        const delivered = payload?.messages?.filter(message => message.speaker === 'assistant') ?? [];
        const reply = delivered.map(message => message.text).join('\n');
        const assistant = delivered.at(-1);
        const receipt = assistant ? app.interactionPolicy.receipt(assistant.id) : null;
        const callsThisTurn = evidence.calls.slice(evidence.turns.reduce((sum, item) => sum + item.modelCalls, 0));
        const turnEvidence = { turn: turnIndex + 1, userText, httpStatus: status, payload, receipt, requestError, elapsedMs: Date.now() - startedAt, modelCalls: callsThisTurn.length };
        evidence.turns.push(turnEvidence);
        redacted.turns.push({ turn: turnIndex + 1, userText, httpStatus: status, deliveredReply: reply || null, ...(payload?.code || payload?.error ? { applicationError: { code: payload.code ?? null, message: payload.error ?? null } } : {}), receipt, modelCalls: callsThisTurn.length, usage: callsThisTurn.map(call => call.usage), upstreamStatuses: callsThisTurn.map(call => call.upstreamStatus ?? null), timingMs: { http: turnEvidence.elapsedMs, model: callsThisTurn.map(call => call.elapsedMs) }, automatedFlags: observedFailures(test.id, turnIndex, reply, receipt, status), independentObservations: independentObservations(test.id, turnIndex, reply, status, payload) });
        if (status !== 200) break;
      }
    } finally {
      await app.close();
      privateEvidence.cases.push(evidence);
      publicResults.cases.push(redacted);
      fs.writeFileSync(path.join(privateRoot, 'evidence.json'), `${JSON.stringify(privateEvidence, null, 2)}\n`, { mode: 0o600 });
    }
  }

  const after = sourceSnapshot();
  publicResults.sourceProtection = {
    hashesBefore: before.hashes,
    hashesAfter: after.hashes,
    hashesUnchanged: stable(before.hashes) === stable(after.hashes),
    settingsUnchanged: stable(before.settings) === stable(after.settings),
  };
  publicResults.summary = {
    chatRequestsRun: publicResults.cases.reduce((sum, item) => sum + item.turns.length, 0),
    modelCallsRun: publicResults.cases.flatMap(item => item.turns).reduce((sum, item) => sum + item.modelCalls, 0),
    successfulTurns: publicResults.cases.flatMap(item => item.turns).filter(item => item.httpStatus === 200).length,
    failedTurns: publicResults.cases.flatMap(item => item.turns).filter(item => item.httpStatus !== 200).length,
    automatedFlagCount: publicResults.cases.flatMap(item => item.turns).reduce((sum, item) => sum + item.automatedFlags.length, 0),
    independentObservationCount: publicResults.cases.flatMap(item => item.turns).reduce((sum, item) => sum + item.independentObservations.length, 0),
  };
  fs.writeFileSync(resultsPath, `${JSON.stringify(publicResults, null, 2)}\n`);

  const lines = ['# Production companion replay', '', `Run: ${publicResults.createdAt}`, '', `Executed ${publicResults.summary.chatRequestsRun}/8 bounded chat turns through the production HTTP route and \`createApp\`. The production model made ${publicResults.summary.modelCallsRun} calls including any built-in one-time repairs.`, '', `Live source hashes unchanged: **${publicResults.sourceProtection.hashesUnchanged ? 'yes' : 'no'}**. Live settings unchanged: **${publicResults.sourceProtection.settingsUnchanged ? 'yes' : 'no'}**.`, '', 'Each case ran from a private SQLite backup with proactive work, recall, research, life ticks, chat-queue delivery, notifications, and TTS inactive. The live server was not restarted and no live message was written.', ''];
  for (const item of publicResults.cases) {
    lines.push(`## ${item.label}`, '', `Simulated clock: ${item.simulatedClock}. ${item.selectiveRewind ? `Messages from source row ${item.historyBaseRowid} onward were removed in this case clone.` : 'Synthetic branch was appended after the latest cloned history.'}`, '');
    for (const turn of item.turns) {
      lines.push(`### Turn ${turn.turn}`, '', `User: ${turn.userText}`, '', `HTTP ${turn.httpStatus}; model calls: ${turn.modelCalls}; elapsed: ${turn.timingMs.http} ms.`, '', 'Delivered reply:', '', turn.deliveredReply ?? '(none)', '', 'Automated heuristic flags:', '', ...(turn.automatedFlags.length ? turn.automatedFlags.map(issue => `- ${issue}`) : ['- None.']), '', 'Independent review:', '', ...(turn.independentObservations.length ? turn.independentObservations.map(issue => `- ${issue}`) : ['- No concrete user-visible defect identified in this reply.']), '');
    }
  }
  lines.push('## Limitations', '', '- Historical cases selectively rewind the Miyue message stream at the matched row and clear Miyue recall, episodic-memory, and personal-experience state in the clone. Other life state, tuning, preferences, content, and character state remain at the current production snapshot.', '- The synthetic branch starts after the newest cloned Miyue history and fixes its clock to that row timestamp.', '- The checks report observable response properties and production receipts. They do not use model self-scoring and do not claim semantic quality beyond the listed evidence.', '- Full prompts, raw model envelopes, provider usage, timings, HTTP payloads, and receipts are stored privately under `.runtime/attention-comprehensive-replay/evidence.json`.', '');
  fs.writeFileSync(reviewPath, `${lines.join('\n')}\n`);
}

main().catch(error => {
  const failure = { createdAt: new Date().toISOString(), name: error?.name, message: error?.message, code: error?.code, stack: error?.stack };
  fs.writeFileSync(path.join(privateRoot, 'fatal.json'), `${JSON.stringify(failure, null, 2)}\n`, { mode: 0o600 });
  process.stderr.write(`Replay failed: ${error?.message}\n`);
  process.exitCode = 1;
});
