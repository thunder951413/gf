import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Store } from '../lib/store.mjs';
import { DialogueTraceRepository } from '../lib/dialogue-trace.mjs';

const story = { start: 'start', nodes: { start: { id: 'start', body: '', choices: [] } } };
function fixture(t, maxRecords = 300) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-dialogue-trace-'));
  let now = new Date('2026-09-16T01:00:00Z');
  const store = new Store({ dataDir, story, initialFeeds: [] });
  const repo = new DialogueTraceRepository(store, { maxRecords, clock: () => now });
  t.after(() => { store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { repo, advance: () => { now = new Date(+now + 1000); } };
}

test('trace keeps lifecycle metadata but strips text, prompts, secrets, and arbitrary errors', t => {
  const { repo } = fixture(t);
  const trace = repo.record({ id: 't-1', roleId: 'miyue', userText: 'private user text', assistantText: 'private answer', prompt: 'secret prompt', error: 'token=secret', stageTimings: { retrieve: 12, nope: -1 }, retrieval: { scores: [{ id: 'm-1', score: .91, text: 'do not keep' }], rejections: ['weak-match'] }, promptBlocks: { plan: 410, rawPrompt: 'secret' }, outcome: { status: 'repaired', message: 'secret' }, revision: 3, repairIssues: ['format'], reaction: { kind: 'memory_acknowledgement', sourceIds: ['msg-1'], evidence: 'private' } });
  const json = JSON.stringify(trace);
  assert.match(json, /retrieve/); assert.match(json, /memory_acknowledgement/);
  assert.doesNotMatch(json, /private|secret|token=|do not keep/);
  assert.deepEqual(repo.list(), [trace]);
});

test('trace retention is role-isolated and list remains ordered', t => {
  const { repo, advance } = fixture(t, 2);
  repo.record({ id: 'one', roleId: 'miyue', outcome: 'ok' }); advance();
  repo.record({ id: 'other', roleId: 'other', outcome: 'ok' }); advance();
  repo.record({ id: 'two', roleId: 'miyue', outcome: 'ok' }); advance();
  repo.record({ id: 'three', roleId: 'miyue', outcome: 'ok' });
  assert.deepEqual(repo.list().map(row => row.id), ['three', 'two']);
  assert.deepEqual(repo.list({ roleId: 'other' }).map(row => row.id), ['other'], 'one role cannot evict another role’s trace');
});

test('trace accepts server trigger form and retains bounded degradation metadata only', t => {
  const { repo } = fixture(t);
  const trace = repo.record({ trigger: 'user_message', repairCount: 2, retrieval: { status: 'degraded', errorCode: 'TIMEOUT', selected: [{ id: 'row', sourceIds: ['msg-1'], score: null, text: 'private source content' }] } });
  assert.equal(trace.trigger.type, 'user_message');
  assert.equal(trace.repairCount, 2);
  assert.equal(trace.retrieval.status, 'degraded');
  assert.equal(trace.retrieval.errorCode, 'TIMEOUT');
  assert.equal(trace.retrieval.selected[0].score, null);
  assert.equal(trace.retrieval.selected[0].chars, 'private source content'.length);
  assert.doesNotMatch(JSON.stringify(trace), /private source content/);
});
