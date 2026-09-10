import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CompanionRelationship, promptInstruction, relationshipUpdateInstruction } from '../lib/companion-relationship.mjs';

class TestStore {
  constructor(filename = ':memory:') { this.db = new DatabaseSync(filename); this.db.exec('CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,role TEXT,speaker TEXT,text TEXT,created_at TEXT)'); }
  transaction(fn) { const nested = this.depth; this.db.exec(nested ? 'SAVEPOINT reltest' : 'BEGIN IMMEDIATE'); this.depth = true; try { const value = fn(); this.db.exec(nested ? 'RELEASE reltest' : 'COMMIT'); return value; } catch (error) { this.db.exec(nested ? 'ROLLBACK TO reltest; RELEASE reltest' : 'ROLLBACK'); throw error; } finally { this.depth = nested; } }
  close() { this.db.close(); }
}
const row = (id, role, speaker, text, createdAt) => ({ id, role, speaker, text, createdAt });
function save(store, rows) { const insert = store.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)'); for (const item of rows) insert.run(item.id, item.role, item.speaker, item.text, item.createdAt); }
function clockAt(initial) { let value = new Date(initial); const fn = () => new Date(value); fn.set = next => { value = new Date(next); }; return fn; }

test('fresh migration reads as friends without inventing history', () => {
  const store = new TestStore(), rel = new CompanionRelationship(store);
  assert.deepEqual(rel.view('miyue').familiarity, { activeDays: 0, firstContactAt: null, lastContactAt: null });
  assert.equal(rel.view('miyue').status.value, 'friends');
  assert.equal(rel.view('miyue').status.explicit, false);
  assert.equal(rel.view('miyue').status.id, null);
  assert.equal(relationshipUpdateInstruction(), promptInstruction());
  assert.equal(rel.promptInstruction(), promptInstruction());
  assert.match(promptInstruction(), /逐字复制/);
  assert.ok(rel.context('miyue').length <= 1000);
});

test('binds candidate actor, role and literal evidence to saved messages', () => {
  const store = new TestStore(), rel = new CompanionRelationship(store, { clock: clockAt('2026-09-08T10:00:00Z') });
  const rows = [row('u1', 'miyue', 'user', '以后叫我阿舟吧', '2026-09-08T09:00:00Z'), row('a1', 'miyue', 'assistant', '好呀，阿舟。', '2026-09-08T09:00:01Z')]; save(store, rows);
  rel.observe('miyue', rows, [{ kind: 'nickname', key: 'user', evidence: '以后叫我阿舟吧', source: 'user', scope: 'persistent' }]);
  const fact = rel.view('miyue').nickname;
  assert.equal(fact.value, '阿舟');
  assert.deepEqual(fact.source.messageIds, ['u1']);
  rel.observe('other', rows, [{ kind: 'nickname', key: 'user', evidence: '以后叫我阿舟吧', source: 'user', scope: 'persistent' }]);
  assert.equal(rel.view('other').nickname, null);
  rel.observe('miyue', rows, [{ kind: 'preference', key: 'comfort', evidence: '用户累时喜欢安静', source: 'user', scope: 'persistent' }]);
  assert.equal(rel.view('miyue').preferences.length, 0);
});

test('status requires explicit proposal and delivered acceptance, never activity counts', () => {
  const store = new TestStore(), rel = new CompanionRelationship(store, { clock: clockAt('2026-09-22T08:00:00Z') });
  const ordinary = Array.from({ length: 12 }, (_, index) => row(`u${index}`, 'miyue', 'user', '今天聊得很开心', `2026-09-${String(index + 1).padStart(2, '0')}T08:00:00Z`)); save(store, ordinary); rel.observe('miyue', ordinary);
  assert.equal(rel.view('miyue').status.value, 'friends');
  const proposal = [row('p1', 'miyue', 'user', '我们正式交往吧', '2026-09-20T08:00:00Z'), row('p2', 'miyue', 'assistant', '愿意呀。', '2026-09-20T08:00:01Z')]; save(store, proposal); rel.observe('miyue', proposal);
  assert.equal(rel.view('miyue').status.value, 'dating');
  assert.ok(rel.view('miyue').status.id);
  assert.deepEqual(rel.view('miyue').status.source.messageIds, ['p1', 'p2']);
  const clear = [row('c1', 'miyue', 'user', '以后只做普通朋友', '2026-09-21T08:00:00Z')]; save(store, clear); rel.observe('miyue', clear);
  assert.equal(rel.view('miyue').status.value, 'friends');
});

test('negated, quoted and hypothetical relationship phrases do not change status', () => {
  const store = new TestStore(), rel = new CompanionRelationship(store, { clock: clockAt('2026-09-09T08:00:00Z') });
  const phrases = ['不要做我女朋友吧', '我不想分手吧', '他说“我们正式交往吧”', '如果我们以后就是恋人了'];
  for (const [index, text] of phrases.entries()) {
    const rows = [row(`u${index}`, 'miyue', 'user', text, `2026-09-08T08:0${index}:00Z`), row(`a${index}`, 'miyue', 'assistant', '我愿意呀。', `2026-09-08T08:0${index}:01Z`)];
    save(store, rows); rel.observe('miyue', rows);
  }
  assert.equal(rel.view('miyue').status.explicit, false);
});

test('captures direct nickname and temporary boundary without model metadata', () => {
  const clock = clockAt('2026-09-08T08:02:00Z'), store = new TestStore(), rel = new CompanionRelationship(store, { clock });
  const rows = [row('u1', 'miyue', 'user', '以后叫我阿舟', '2026-09-08T08:00:00Z'), row('u2', 'miyue', 'user', '今天别暧昧', '2026-09-08T08:01:00Z')];
  save(store, rows); rel.observe('miyue', rows);
  assert.equal(rel.view('miyue').nickname.value, '阿舟');
  assert.equal(rel.view('miyue').boundaries[0].key, 'flirtation');
  assert.equal(rel.view('miyue').boundaries[0].scope, 'today');
  assert.equal(rel.view('miyue').intimacyBoundary, 'friendly');
});

test('accepts a prior actual assistant proposal only with an explicit user answer', () => {
  const store = new TestStore(), rel = new CompanionRelationship(store, { clock: clockAt('2026-09-09T08:00:00Z') });
  const proposal = row('a1', 'miyue', 'assistant', '你愿意做我男朋友吗', '2026-09-08T08:00:00Z'); save(store, [proposal]); rel.observe('miyue', [proposal]);
  const vague = row('u1', 'miyue', 'user', '嗯嗯', '2026-09-08T08:01:00Z'); save(store, [vague]); rel.observe('miyue', [vague]); assert.equal(rel.view('miyue').status.value, 'friends');
  const explicit = row('u2', 'miyue', 'user', '愿意呀。', '2026-09-08T08:02:00Z'); save(store, [explicit]); rel.observe('miyue', [explicit]);
  assert.equal(rel.view('miyue').status.value, 'friends', 'the immediately preceding vague reply breaks proposal acceptance linkage');
  const retry = row('a2', 'miyue', 'assistant', '那你愿意做我男朋友吗', '2026-09-08T08:03:00Z'); save(store, [retry]); rel.observe('miyue', [retry]);
  const accepted = row('u3', 'miyue', 'user', '愿意呀。', '2026-09-08T08:04:00Z'); save(store, [accepted]); rel.observe('miyue', [accepted]);
  assert.equal(rel.view('miyue').status.value, 'dating');
});

test('today boundary expires at Shanghai midnight and reveals persistent boundary', () => {
  const clock = clockAt('2026-09-08T15:20:00Z'), store = new TestStore(), rel = new CompanionRelationship(store, { clock });
  let rows = [row('u1', 'miyue', 'user', '以后别用恋爱昵称', '2026-09-08T10:00:00Z')]; save(store, rows); rel.observe('miyue', rows, [{ kind: 'boundary', key: 'nickname', evidence: rows[0].text, source: 'user', scope: 'persistent' }]);
  rows = [row('u2', 'miyue', 'user', '今晚不想暧昧', '2026-09-08T15:10:00Z')]; save(store, rows); rel.observe('miyue', rows, [{ kind: 'boundary', key: 'flirtation', evidence: rows[0].text, source: 'user', scope: 'today' }]);
  assert.equal(rel.view('miyue').boundaries.length, 2);
  assert.equal(rel.view('miyue').boundaries.find(item => item.key === 'flirtation').validUntil, '2026-09-08T16:00:00.000Z');
  clock.set('2026-09-08T16:00:00Z');
  assert.deepEqual(rel.view('miyue').boundaries.map(item => item.key), ['nickname']);
  assert.equal(rel.view('miyue').intimacyBoundary, 'open');
  assert.equal(rel.view('miyue').hasBoundaryHistory, true);
});

test('a temporary boundary overlays the same persistent key for two hours only', () => {
  const clock = clockAt('2026-09-08T08:00:00Z'), store = new TestStore(), rel = new CompanionRelationship(store, { clock });
  const persistent = row('u1', 'miyue', 'user', '以后暧昧要慢一点', '2026-09-08T07:00:00Z'); save(store, [persistent]);
  rel.update('miyue', { kind: 'boundary', key: 'flirtation', value: persistent.text, revision: 0 });
  const temporary = row('u2', 'miyue', 'user', '这会儿先别暧昧', '2026-09-08T08:00:00Z'); save(store, [temporary]);
  rel.observe('miyue', [temporary], [{ kind: 'boundary', key: 'flirtation', evidence: temporary.text, source: 'user', scope: 'turn' }]);
  assert.equal(rel.view('miyue').boundaries[0].value, temporary.text);
  assert.equal(rel.view('miyue').boundaries[0].validUntil, '2026-09-08T10:00:00.000Z');
  clock.set('2026-09-08T10:00:00Z');
  assert.equal(rel.view('miyue').boundaries[0].value, persistent.text);
});

test('a local invitation does not erase a persistent boundary', () => {
  const store = new TestStore(), rel = new CompanionRelationship(store, { clock: clockAt('2026-09-09T08:00:00Z') });
  const boundary = row('u1', 'miyue', 'user', '以后别主动撒娇', '2026-09-08T08:00:00Z'); save(store, [boundary]); rel.observe('miyue', [boundary], [{ kind: 'boundary', key: 'affection', evidence: boundary.text, source: 'user', scope: 'persistent' }]);
  const invite = row('u2', 'miyue', 'user', '抱抱我', '2026-09-08T09:00:00Z'); save(store, [invite]); rel.observe('miyue', [invite]);
  assert.equal(rel.view('miyue').boundaries[0].value, boundary.text);
  assert.match(rel.context('miyue'), /不主动宣布关系升级/);
});

test('nickname-only boundaries do not close the effective intimacy boundary', () => {
  const store = new TestStore(), rel = new CompanionRelationship(store, { clock: clockAt('2026-09-09T08:00:00Z') });
  const boundary = row('u1', 'miyue', 'user', '以后别用昵称', '2026-09-08T08:00:00Z'); save(store, [boundary]); rel.observe('miyue', [boundary]);
  assert.equal(rel.view('miyue').hasExplicitBoundary, true);
  assert.equal(rel.view('miyue').intimacyBoundary, 'open');
});

test('future facts and contacts stay out of the current projection', () => {
  const clock = clockAt('2026-09-08T08:00:00Z'), store = new TestStore(), rel = new CompanionRelationship(store, { clock });
  const future = row('u1', 'miyue', 'user', '以后叫我未来人', '2026-09-09T08:00:00Z'); save(store, [future]); rel.observe('miyue', [future]);
  assert.equal(rel.view('miyue').nickname, null);
  assert.equal(rel.view('miyue').familiarity.activeDays, 0);
});

test('source suppression, tombstones and later sources rebuild facts safely', () => {
  const clock = clockAt('2026-09-07T08:00:00Z'), store = new TestStore(), rel = new CompanionRelationship(store, { clock });
  rel.update('miyue', { kind: 'preference', key: 'sharing', value: '更早的偏好', revision: 0 });
  clock.set('2026-09-08T08:00:00Z');
  const first = row('u1', 'miyue', 'user', '我喜欢先听具体的小事', '2026-09-08T08:00:00Z'); save(store, [first]); rel.observe('miyue', [first], [{ kind: 'preference', key: 'sharing', evidence: first.text, source: 'user', scope: 'persistent' }]);
  const fact = rel.view('miyue').preferences[0];
  assert.equal(rel.view('miyue', { suppressedSourceIds: ['u1'] }).preferences.length, 0);
  store.db.prepare('DELETE FROM messages WHERE id=?').run('u1');
  assert.equal(rel.view('miyue').preferences.length, 0, 'deleted provenance cannot remain effective');
  save(store, [first]);
  rel.update('miyue', { id: fact.id, action: 'remove', revision: rel.revision('miyue') });
  rel.observe('miyue', [first], [{ kind: 'preference', key: 'sharing', evidence: first.text, source: 'user', scope: 'persistent' }]);
  assert.equal(rel.view('miyue').preferences.length, 0);
  assert.throws(() => rel.update('miyue', { id: fact.id, action: 'remove', revision: rel.revision('miyue') }), error => error.status === 404);
  const second = row('u2', 'miyue', 'user', '我还是喜欢先听具体的小事', '2026-09-09T08:00:00Z'); save(store, [second]); rel.observe('miyue', [second], [{ kind: 'preference', key: 'sharing', evidence: second.text, source: 'user', scope: 'persistent' }]);
  clock.set('2026-09-09T08:01:00Z');
  assert.equal(rel.view('miyue').preferences[0].source.messageIds[0], 'u2');
});

test('optimistic updates survive restart and reject stale writers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'relationship-')), file = path.join(dir, 'db.sqlite');
  let store = new TestStore(file), rel = new CompanionRelationship(store);
  rel.update('miyue', { kind: 'status', value: 'partners', revision: 0 });
  assert.throws(() => rel.update('miyue', { kind: 'nickname', key: 'user', value: '阿舟', revision: 0 }), error => error.status === 409);
  store.close(); store = new TestStore(file); rel = new CompanionRelationship(store);
  assert.equal(rel.view('miyue').status.value, 'partners'); assert.equal(rel.revision('miyue'), 1);
  store.close(); fs.rmSync(dir, { recursive: true });
});

test('observation participates in the caller transaction rollback', () => {
  const store = new TestStore(), rel = new CompanionRelationship(store, { clock: clockAt('2026-09-09T08:00:00Z') });
  const message = row('u1', 'miyue', 'user', '以后叫我阿舟吧', '2026-09-08T08:00:00Z');
  assert.throws(() => store.transaction(() => { save(store, [message]); rel.observe('miyue', [message], [{ kind: 'nickname', key: 'user', evidence: message.text, source: 'user', scope: 'persistent' }]); throw new Error('fail'); }));
  assert.equal(rel.view('miyue').nickname, null); assert.equal(rel.revision('miyue'), 0);
});
