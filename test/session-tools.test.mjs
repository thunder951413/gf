import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSessionReadTools } from '../lib/session-tools.mjs';
import { promptInstruction as relationshipRecording } from '../lib/companion-relationship.mjs';
import { promptInstruction as agendaRecording } from '../lib/companion-agenda.mjs';
import { LIFE_UPDATE_INSTRUCTION } from '../lib/companion-updates.mjs';

function fixture(t) {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE messages (id TEXT PRIMARY KEY, role TEXT NOT NULL, speaker TEXT NOT NULL, text TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE VIEW recall_messages AS SELECT rowid,id,role,speaker,text,kind,created_at FROM messages;
  `);
  const memory = { suppressed: new Set(), consolidated: [], episodes: [], edits: new Map() };
  const content = [];
  const store = { db, listContent: () => content };
  const recallRepo = { consolidated: { snapshot: () => ({ items: memory.consolidated }) } };
  const episodes = { suppressedSourceIds: () => [...memory.suppressed], list: () => memory.episodes };
  const historyEdits = { project: (_role, rows) => rows.flatMap(row => memory.edits.has(row.id) ? (memory.edits.get(row.id) ? [{ ...row, text: memory.edits.get(row.id) }] : []) : [row]) };
  const add = ({ id, text, role = 'miyue', speaker = 'user', kind = 'chat', at = '2026-09-20T00:00:00.000Z' }) => {
    db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)').run(id, role, speaker, text, kind, at);
  };
  const state = {
    at: '2026-09-25T04:00:00.000Z', current: { activity: '在窗边读书', location: '家里' }, life: { events: [] },
    relationship: { label: '朋友' }, agenda: { plans: ['周日看展'] }, reminders: [], social: { recent: [] },
    interests: { current: '版画' }, recordingProtocol: 'companionship.relationship 与 companionship.agenda 都是可选记录；evidence 必须逐字来自消息。',
    note: '这些是当前记录。',
  };
  const args = extra => ({ store, recallRepo, episodes, historyEdits, clock: () => new Date('2026-09-25T04:00:00.000Z'), getState: () => state, ...extra });
  t.after(() => db.close());
  return { db, memory, content, add, state, args };
}

test('recall exposes only visible corrected evidence and respects persona cutoff', async t => {
  const f = fixture(t);
  f.add({ id: 'hidden', text: '用户把金色礼物送给了甲。' });
  f.memory.suppressed.add('hidden');
  f.add({ id: 'old-assistant', speaker: 'assistant', text: '用户把银色礼物送给了乙。' });
  const cutoff = f.db.prepare('SELECT rowid FROM messages WHERE id=?').get('old-assistant').rowid;
  f.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('persona_cutoff:miyue', String(cutoff));
  f.add({ id: 'edited', speaker: 'assistant', text: '用户把蓝色礼物送给了丙，后来改成丁。' });
  f.memory.edits.set('edited', '用户更正：蓝色礼物送给了丁。');
  f.memory.consolidated.push({
    id: 'gift-correction', subject: 'character', kind: 'fact', topic: '蓝色礼物', summary: '蓝色礼物送给了丁。', status: 'current',
    lastAt: '2026-09-20T00:00:00.000Z', evidence: [{ messageId: 'edited', quote: '蓝色礼物送给了丁' }],
  });
  const execute = createSessionReadTools(f.args());
  const result = await execute({ name: 'recall', query: '还记得上次赠送的蓝色东西给谁了吗？' });
  assert.equal(result.unknown, false);
  assert.ok(result.items.some(item => item.id === 'consolidated:gift-correction'));
  assert.deepEqual(result.items.find(item => item.id === 'consolidated:gift-correction').sourceIds, ['edited']);
  assert.equal(result.items.find(item => item.id === 'consolidated:gift-correction').at, '2026-09-20T00:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(result), /金色|银色|后来改成丙/);
});

test('episode correction supersedes obsolete raw wording without a hidden fallback', async t => {
  const f = fixture(t);
  f.add({ id: 'drink', text: '我最喜欢红茶。' });
  f.memory.episodes.push({ id: 'episode-drink', corrected: true, correction: '用户更正：现在最喜欢黑咖啡。', correctedAt: '2026-09-24T00:00:00Z', createdAt: '2026-09-20T00:00:00Z', pinned: true, suppressed: false, label: '饮料偏好', quotes: [{ id: 'drink', speaker: 'user', text: '我最喜欢红茶。' }] });
  const result = await createSessionReadTools(f.args())({ name: 'recall', query: '我现在最爱喝什么？' });
  assert.deepEqual(result.items.map(item => item.id), ['episode-drink']);
  assert.match(JSON.stringify(result), /黑咖啡/);
  assert.doesNotMatch(JSON.stringify(result), /最喜欢红茶/);
});

test('cached source lookup is explicitly non-current and has bounded evidence', async t => {
  const f = fixture(t);
  f.content.push(
    { id: 'old', title: '自由泳换气研究', url: 'https://example.test/swim', summary: '换气时头部随躯干转动。'.repeat(200), publishedAt: null },
    { id: 'other', title: '烘焙记录', url: 'https://example.test/bread', summary: '面包发酵。', publishedAt: '2026-09-24T00:00:00Z' },
  );
  const result = await createSessionReadTools(f.args())({ name: 'sources', query: '游泳呼吸资料' });
  assert.equal(result.scope.coverage, 'local-cache-only');
  assert.equal(result.scope.internetSearched, false);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].publishedAt, null);
  assert.ok(result.items[0].evidence.length <= 700);
  assert.match(result.notice.join(' '), /不能据此断言这是最新信息/);
  assert.match(result.notice.join(' '), /没有发布时间/);
});

test('all tool results obey item and section budgets', async t => {
  const f = fixture(t);
  for (let index = 0; index < 20; index += 1) {
    f.add({ id: `row-${index}`, text: `蓝色礼物第${index}次记录。${'相关细节。'.repeat(100)}` });
    f.content.push({ id: `source-${index}`, title: `蓝色礼物资料 ${index}`, url: `https://example.test/${index}`, summary: '来源证据。'.repeat(200), publishedAt: '2026-09-20T00:00:00Z' });
  }
  f.state.life = { huge: '状态'.repeat(5000), rows: Array.from({ length: 100 }, (_, index) => ({ index, detail: '细节'.repeat(100) })) };
  f.state.social = { huge: '"\\'.repeat(5000) };
  f.state.interests = { huge: '兴趣'.repeat(5000) };
  const execute = createSessionReadTools(f.args());
  const recall = await execute({ name: 'recall', query: '蓝色礼物' });
  const sources = await execute({ name: 'sources', query: '蓝色礼物资料' });
  const state = await execute({ name: 'state', query: '当前在做什么' });
  assert.ok(recall.items.length <= 6);
  assert.ok(recall.items.reduce((sum, item) => sum + item.text.length, 0) <= 2800);
  assert.equal(recall.truncated, true);
  assert.ok(sources.items.length <= 5);
  assert.ok(sources.items.every(item => item.evidence.length <= 700));
  assert.ok(JSON.stringify(state.items).length <= 7500);
  assert.equal(state.items.find(item => item.section === 'life').truncated, true);
  assert.equal(state.truncated, true);
});

test('cancellation is checked before work and after asynchronous callbacks', async t => {
  const f = fixture(t);
  const before = new AbortController(); before.abort();
  const execute = createSessionReadTools(f.args());
  await assert.rejects(execute({ name: 'state', query: '当前状态' }, { signal: before.signal }), error => error.name === 'AbortError');

  const during = new AbortController();
  const withSearch = createSessionReadTools(f.args({ searchSources: async (_query, { signal }) => {
    assert.equal(signal, during.signal);
    during.abort();
    return [{ title: '不应返回', summary: '已取消' }];
  } }));
  await assert.rejects(withSearch({ name: 'sources', query: '资料' }, { signal: during.signal }), error => error.name === 'AbortError');
});

test('invalid names and empty or oversized queries are rejected cleanly', async t => {
  const f = fixture(t);
  const execute = createSessionReadTools(f.args());
  await assert.rejects(execute({ name: 'write', query: 'x' }), error => error.code === 'UNKNOWN_SESSION_TOOL');
  await assert.rejects(execute({ name: 'recall', query: '  ' }), error => error.code === 'INVALID_SESSION_TOOL_QUERY');
  await assert.rejects(execute({ name: 'recall', query: 'x'.repeat(501) }), error => error.code === 'INVALID_SESSION_TOOL_QUERY');
});

test('state returns the complete server snapshot shape, preserves actionable fields, and never mutates it', async t => {
  const f = fixture(t);
  f.state.reminders = [{ id: 'reminder-1', role: 'miyue', text: '带伞', dueAt: '2026-09-26T01:00:00.000Z', status: 'pending' }];
  f.state.recordingProtocol = `${relationshipRecording()}\n${agendaRecording()}\n${LIFE_UPDATE_INSTRUCTION}`;
  f.state.secret = 'must stay outside tool results';
  const before = structuredClone(f.state);
  const result = await createSessionReadTools(f.args())({ name: 'state', query: '关系怎么样' });
  assert.deepEqual(result.items.map(item => item.section), ['at', 'current', 'life', 'relationship', 'agenda', 'reminders', 'social', 'interests', 'recordingProtocol', 'note']);
  assert.deepEqual(result.items.find(item => item.section === 'reminders').value.items[0], f.state.reminders[0]);
  const protocol = result.items.find(item => item.section === 'recordingProtocol');
  assert.equal(protocol.truncated, false);
  assert.equal(protocol.value, f.state.recordingProtocol);
  assert.match(protocol.value, /companionship\.agenda/);
  assert.equal(result.scope.evidence, 'current-session-snapshot');
  assert.doesNotMatch(JSON.stringify(result), /must stay outside/);
  assert.deepEqual(f.state, before);
});
