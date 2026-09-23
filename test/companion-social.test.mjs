import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { CompanionSocial } from '../lib/companion-social.mjs';

class TestStore {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec('CREATE TABLE messages(id TEXT PRIMARY KEY,role TEXT,speaker TEXT,text TEXT,kind TEXT,hidden INTEGER DEFAULT 0,created_at TEXT)'); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  getMessage(id) { return this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) || null; }
  add(id, speaker, text, { role = 'miyue', kind = 'chat', createdAt = '2026-09-18T10:00:00.000Z' } = {}) { this.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,0,?)').run(id, role, speaker, text, kind, createdAt); return this.getMessage(id); }
  close() { this.db.close(); }
}

const people = [
  { id: 'father', name: '父亲', aliases: ['爸爸'], relationship: '父亲', background: '住在南京，喜欢修老相机。' },
  { id: 'mother', name: '母亲', aliases: ['妈妈'], relationship: '母亲' },
  { id: 'xiaoyu', name: '小郁', aliases: [], relationship: '朋友' },
  { id: 'alan', name: '阿澜', aliases: [], relationship: '朋友' },
];
function fixture() {
  let now = new Date('2026-09-20T10:00:00.000Z'); const store = new TestStore();
  const repo = new CompanionSocial(store, { people, clock: () => new Date(now), projectSource: row => row.hidden ? false : row });
  return { store, repo, set: value => { now = new Date(value); }, close: () => store.close() };
}
function commit(repo, row, social, revision = repo.get().revision) { return repo.commit({ social }, { rows: [row], expectedRevision: revision }); }

test('writes exact assistant excerpts, updates a cross-day plan by id, and returns a bounded focused context', () => {
  const f = fixture();
  const first = f.store.add('a1', 'assistant', '爸爸说周末一起吃饭，我答应周六过去。');
  let receipt = commit(f.repo, first, { events: [{ id: 'dad-meal', personIds: ['father'], text: '爸爸说周末一起吃饭', status: 'planned', at: null }] });
  assert.equal(receipt.revision, 1); f.set('2026-09-22T10:00:00.000Z');
  const next = f.store.add('a2', 'assistant', '我和爸爸周六已经一起吃完饭了。');
  receipt = commit(f.repo, next, { events: [{ id: 'dad-meal', personIds: ['father'], text: '我和爸爸周六已经一起吃完饭了', status: 'occurred', at: '2026-09-21T12:00:00.000Z' }] });
  assert.equal(receipt.revision, 2); assert.equal(f.repo.get().events[0].status, 'occurred');
  const context = f.repo.context({ text: '你和爸爸吃饭怎么样？', maxChars: 600 });
  assert.match(context, /人物名册/u); assert.match(context, /已经一起吃完饭/u); assert.ok(context.length <= 600); f.close();
});

test('rejects user contamination, forged unsaved rows, another role evidence, and invalid lifecycle transitions', () => {
  const f = fixture();
  const user = f.store.add('u1', 'user', '你妈妈已经搬家了。');
  let out = commit(f.repo, user, { notes: [{ id: 'mom', personId: 'mother', text: '妈妈已经搬家了', status: 'active' }] });
  assert.equal(out.rejected[0].reason, 'invalid_assistant_source');
  const fake = { id: 'fake', speaker: 'assistant', text: '妈妈已经搬家了', kind: 'chat' };
  out = commit(f.repo, fake, { notes: [{ id: 'mom', personId: 'mother', text: '妈妈已经搬家了', status: 'active' }] });
  assert.equal(out.rejected[0].reason, 'invalid_assistant_source');
  const assistant = f.store.add('a1', 'assistant', '阿澜约我周末去看展。', { role: 'other' });
  out = commit(f.repo, assistant, { events: [{ id: 'show', personIds: ['alan'], text: '阿澜约我周末去看展', status: 'cancelled', at: null }] });
  assert.equal(out.rejected[0].reason, 'invalid_assistant_source');
  const plan = f.store.add('a2', 'assistant', '阿澜约我周末去看展。');
  out = commit(f.repo, plan, { events: [{ id: 'show', personIds: ['alan'], text: '阿澜约我周末去看展', status: 'planned', at: null }] });
  const bad = f.store.add('a3', 'assistant', '爸爸问起阿澜的展已经结束了。');
  out = commit(f.repo, bad, { events: [{ id: 'show', personIds: ['father'], text: '爸爸问起阿澜的展已经结束了', status: 'occurred', at: null }] });
  assert.equal(out.rejected[0].reason, 'participants_changed');
  const future = f.store.add('a4', 'assistant', '爸爸问起阿澜的展已经结束了。');
  out = commit(f.repo, future, { events: [{ id: 'show', personIds: ['alan'], text: '爸爸问起阿澜的展已经结束了', status: 'occurred', at: '2026-10-01T00:00:00.000Z' }] });
  assert.equal(out.rejected[0].reason, 'future_occurred'); f.close();
});

test('uses receipts for idempotency and optimistic revisions for concurrent commits', () => {
  const f = fixture(); const one = f.store.add('a1', 'assistant', '小郁给我发了新书单。');
  const proposal = { notes: [{ id: 'books', personId: 'xiaoyu', text: '小郁给我发了新书单', status: 'active' }] };
  const first = commit(f.repo, one, proposal, 0), repeat = commit(f.repo, one, proposal, 0);
  assert.deepEqual(repeat, first); const two = f.store.add('a2', 'assistant', '妈妈今天给我做了汤。');
  assert.throws(() => commit(f.repo, two, { notes: [{ id: 'soup', personId: 'mother', text: '妈妈今天给我做了汤', status: 'active' }] }, 0), error => error.status === 409 && error.code === 'STALE_COMPANION_SOCIAL'); f.close();
});

test('history projection hides a current version and restores its earlier visible version', () => {
  const f = fixture(); const old = f.store.add('a1', 'assistant', '爸爸说明天会来。');
  commit(f.repo, old, { notes: [{ id: 'dad-visit', personId: 'father', text: '爸爸说明天会来', status: 'active' }] });
  const update = f.store.add('a2', 'assistant', '爸爸改成下周会来。');
  commit(f.repo, update, { notes: [{ id: 'dad-visit', personId: 'father', text: '爸爸改成下周会来', status: 'active' }] });
  assert.equal(f.repo.get().notes[0].text, '爸爸改成下周会来'); f.store.db.prepare('UPDATE messages SET hidden=1 WHERE id=?').run('a2');
  assert.equal(f.repo.get().notes[0].text, '爸爸说明天会来'); f.store.db.prepare('UPDATE messages SET hidden=1 WHERE id=?').run('a1');
  assert.equal(f.repo.get().notes.length, 0); f.close();
});

test('life observation only starts foreground doing activity and requires the same instance to mark it occurred', () => {
  const f = fixture();
  let result = f.repo.observeLife([{ id: 'walk', participants: ['爸爸'], detail: '和爸爸在河边散步', phase: 'paused', foreground: true, startedAt: '2026-09-20T09:00:00.000Z' }]);
  assert.equal(result.accepted.length, 0); result = f.repo.observeLife([{ id: 'walk', participants: ['爸爸'], detail: '和爸爸在河边散步', phase: 'doing', foreground: true, instanceStartedAt: '2026-09-20T09:00:00.000Z' }]);
  assert.equal(result.accepted.length, 1); let event = f.repo.get().events[0]; assert.equal(event.lifePhase, 'ongoing'); assert.equal(event.shared, false); assert.equal(event.at, null);
  result = f.repo.observeLife([{ id: 'walk', participants: ['爸爸'], detail: '和爸爸在河边散步结束', phase: 'recent', instanceStartedAt: '2026-09-20T08:00:00.000Z' }]);
  assert.equal(result.accepted.length, 0); result = f.repo.observeLife([{ id: 'walk', participants: ['爸爸'], detail: '和爸爸在河边散步结束', phase: 'recent', instanceStartedAt: '2026-09-20T09:00:00.000Z' }]);
  event = f.repo.get().events[0]; assert.equal(event.status, 'occurred'); assert.equal(event.at, '2026-09-20T09:00:00.000Z'); assert.match(f.repo.context({ text: '你和爸爸在做什么？' }), /"status":"occurred"/u); f.close();
});

test('history import is excerpt-only, checks projected source, and is idempotent', () => {
  const f = fixture(); f.store.add('a1', 'assistant', '我昨天和妈妈聊了她的新工作。');
  const first = f.repo.importHistory([{ personId: 'mother', messageId: 'a1', text: '妈妈聊了她的新工作' }]);
  assert.equal(first.accepted.length, 1); assert.equal(f.repo.get().notes[0].history, true);
  const second = f.repo.importHistory([{ personId: 'mother', messageId: 'a1', text: '妈妈聊了她的新工作' }]); assert.equal(second.accepted[0].idempotent, true);
  f.store.db.prepare('UPDATE messages SET hidden=1 WHERE id=?').run('a1'); const hidden = f.repo.importHistory([{ personId: 'mother', messageId: 'a1', text: '妈妈聊了她的新工作' }]);
  assert.equal(hidden.accepted[0].idempotent, true); f.close();
});

test('normalizes complete ISO values, permits a standalone occurred event, and treats social null as optional', () => {
  const f = fixture(); const row = f.store.add('a-iso', 'assistant', '妈妈昨天已经打完电话了。');
  const out = commit(f.repo, row, { events: [{ id: 'mom-call', personIds: ['mother'], text: '妈妈昨天已经打完电话了', status: 'occurred', at: '2026-09-19T18:00:00+08:00' }] });
  assert.equal(out.accepted.length, 1); assert.equal(f.repo.get().events[0].at, '2026-09-19T10:00:00.000Z');
  const empty = f.repo.commit({ social: null }, { expectedRevision: out.revision }); assert.deepEqual(empty, { accepted: [], rejected: [], revision: out.revision }); f.close();
});

test('completion retains the visible planned-source dependency and does not survive a hidden plan', () => {
  const f = fixture(); const plan = f.store.add('a-plan', 'assistant', '小郁约我周六去喝咖啡。');
  commit(f.repo, plan, { events: [{ id: 'coffee', personIds: ['xiaoyu'], text: '小郁约我周六去喝咖啡', status: 'planned', at: null }] });
  const done = f.store.add('a-done', 'assistant', '我和小郁周六已经喝完咖啡。');
  commit(f.repo, done, { events: [{ id: 'coffee', personIds: ['xiaoyu'], text: '我和小郁周六已经喝完咖啡', status: 'occurred', at: '2026-09-19T11:00:00Z' }] });
  assert.equal(f.repo.get().events[0].status, 'occurred'); f.store.db.prepare('UPDATE messages SET hidden=1 WHERE id=?').run('a-plan');
  assert.equal(f.repo.get().events.length, 0); f.close();
});

test('context has complete ids and source anchors, uses only nearby conversation, and does not carry unrelated plans when recent is off', () => {
  const f = fixture(); const dad = f.store.add('a-dad', 'assistant', '爸爸约我下周一起吃饭。');
  commit(f.repo, dad, { events: [{ id: 'dad-plan', personIds: ['father'], text: '爸爸约我下周一起吃饭', status: 'planned', at: null }] });
  const history = f.store.add('a-history', 'assistant', '前两天妈妈说她换了工作。', { createdAt: '2026-09-10T08:00:00.000Z' });
  f.repo.importHistory([{ personId: 'mother', messageId: history.id, text: '前两天妈妈说她换了工作' }]);
  const none = f.repo.context({ text: '今天想聊点别的', conversation: Array.from({ length: 8 }, () => ({ text: '小郁的旧消息' })), includeRecent: false, maxChars: 1200 });
  assert.match(none, /father=父亲/u); assert.doesNotMatch(none, /dad-plan/u);
  const focused = f.repo.context({ text: '妈妈最近怎样？', includeRecent: false, maxChars: 1200 });
  const line = focused.split('\n').find(value => value.startsWith('{')); assert.ok(line); const parsed = JSON.parse(line);
  assert.equal(parsed.personId, 'mother'); assert.equal(parsed.status, 'active'); assert.equal(parsed.at, null); assert.equal(parsed.sourceAt, '2026-09-10T08:00:00.000Z'); assert.ok(parsed.reportedAt); f.close();
});

test('life intake rejects loose participant names and paused dirty events, processes six entries, and preserves chat sharing on recent completion', () => {
  const f = fixture();
  let out = f.repo.observeLife([{ id: 'bad', participants: ['小郁的狗'], detail: '小郁的狗在跑', phase: 'doing', foreground: true }, { id: 'pause', participants: ['爸爸'], detail: '暂停散步', phase: 'paused', doing: true }]);
  assert.equal(out.accepted.length, 0);
  out = f.repo.observeLife(people.map((person, index) => ({ id: `life-${index}`, participants: [person.name], detail: `${person.name}正在活动`, phase: 'doing', foreground: true, instanceStartedAt: `2026-09-20T0${index}:00:00Z` })).concat([{ id: 'life-4', participants: ['父亲'], detail: '父亲正在活动二', phase: 'doing', foreground: true, instanceStartedAt: '2026-09-20T05:00:00Z' }, { id: 'life-5', participants: ['母亲'], detail: '母亲正在活动二', phase: 'doing', foreground: true, instanceStartedAt: '2026-09-20T06:00:00Z' }]));
  assert.equal(out.accepted.length, 6);
  const doing = f.repo.get().events.find(event => event.id === 'life:life-0'); const chat = f.store.add('a-life', 'assistant', '爸爸正在河边散步，我想晚点再回。');
  commit(f.repo, chat, { events: [{ id: doing.id, personIds: ['father'], text: '爸爸正在河边散步', status: 'planned', at: null }] });
  f.repo.observeLife([{ id: 'life-0', participants: ['父亲'], detail: '爸爸散步结束', phase: 'recent', instanceStartedAt: '2026-09-20T00:00:00Z' }]);
  const finished = f.repo.get().events.find(event => event.id === doing.id); assert.equal(finished.status, 'occurred'); assert.equal(finished.shared, true); assert.equal(finished.text, '爸爸正在河边散步'); f.close();
});

test('paraphrasing the user family in an assistant reply cannot become Lin family evidence', () => {
  const f = fixture(); const row = f.store.add('empathy', 'assistant', '你妈妈最近做了手术，难怪你担心。');
  const out = commit(f.repo, row, { notes: [{ id: 'wrong-mother', personId: 'mother', text: row.text, status: 'active' }] });
  assert.equal(out.accepted.length, 0); assert.equal(f.repo.get().notes.length, 0); f.close();
});

test('further event updates preserve the original plan dependency, and a missing plan cannot be cancelled', () => {
  const f = fixture();
  const plan = f.store.add('plan', 'assistant', '小郁约我晚上吃饭。');
  commit(f.repo, plan, { events: [{ id: 'meal', personIds: ['xiaoyu'], text: plan.text, status: 'planned', at: null }] });
  const done = f.store.add('done', 'assistant', '我和小郁已经吃完饭了。');
  commit(f.repo, done, { events: [{ id: 'meal', personIds: ['xiaoyu'], text: done.text, status: 'occurred', at: null }] });
  const more = f.store.add('more', 'assistant', '我和小郁吃饭时还说起了那本书。');
  commit(f.repo, more, { events: [{ id: 'meal', personIds: ['xiaoyu'], text: more.text, status: 'occurred', at: null }] });
  f.store.db.prepare('UPDATE messages SET hidden=1 WHERE id=?').run(plan.id);
  assert.equal(f.repo.get().events.length, 0);
  const cancel = f.store.add('unknown', 'assistant', '我和小郁的另一顿饭取消了。');
  const out = commit(f.repo, cancel, { events: [{ id: 'unknown-meal', personIds: ['xiaoyu'], text: cancel.text, status: 'cancelled', at: null }] });
  assert.equal(out.accepted.length, 0); f.close();
});

test('group references retrieve both parents without importing the user parents', () => {
  const store = new TestStore();
  const repo = new CompanionSocial(store, { people, groups: [{ personIds: ['mother', 'father'], aliases: ['爸妈', '父母'] }] });
  const one = store.add('parent-plan', 'assistant', '我打算周末回爸妈家吃饭。');
  assert.equal(commit(repo, one, { events: [{ id: 'parents-meal', personIds: ['mother', 'father'], text: one.text, status: 'planned', at: null }] }).accepted.length, 1);
  assert.match(repo.context({ text: '父母那边呢？', includeRecent: false }), /parents-meal/);
  const two = store.add('user-parents', 'assistant', '你爸妈最近挺忙的。');
  assert.equal(commit(repo, two, { notes: [{ id: 'bad', personId: 'father', text: two.text, status: 'active' }] }).accepted.length, 0);
  store.close();
});

test('life history stays bounded even when an older conversation event sorts before it', () => {
  const f = fixture();
  const row = f.store.add('old-plan', 'assistant', '小郁约我以后喝咖啡。');
  commit(f.repo, row, { events: [{ id: 'old-plan', personIds: ['xiaoyu'], text: row.text, status: 'planned', at: null }] });
  for (let i = 0; i < 70; i++) {
    f.set(new Date(Date.parse('2026-09-20T10:00:00Z') + (i + 1) * 86400000));
    const event = { id: `call-${i}`, participants: ['妈妈'], detail: '和妈妈通电话', phase: 'doing', foreground: true, instanceStartedAt: new Date(Date.parse('2026-09-20T10:00:00Z') + (i + 1) * 86400000).toISOString() };
    f.repo.observeLife([event]); f.repo.observeLife([{ ...event, phase: 'recent' }]);
  }
  const events = f.repo.get().events;
  assert.equal(events.length, 64); assert.ok(events.some(event => event.id === 'life:call-69'));
  assert.ok(events.some(event => event.id === 'old-plan')); f.close();
});
