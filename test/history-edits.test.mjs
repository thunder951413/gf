import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { HistoryEdits, historySourceHash } from '../lib/history-edits.mjs';

class Store {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec('CREATE TABLE messages(id TEXT PRIMARY KEY,role TEXT,speaker TEXT,text TEXT,kind TEXT,created_at TEXT)'); }
  transaction(fn) { this.db.exec('BEGIN'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
}
const add = (store, id, text, { role = 'miyue', speaker = 'assistant', kind = 'chat' } = {}) => store.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(id, role, speaker, text, kind, '2026-01-01T00:00:00.000Z');
const edit = (id, text, keptSpans, extra = {}) => ({ id, sourceHash: historySourceHash(text), keptSpans, reason: 'shorten', ...extra });
const fixture = t => { const store = new Store(); const repo = new HistoryEdits(store, { clock: () => new Date('2026-01-02T00:00:00Z') }); t.after(() => store.db.close()); return { store, repo }; };

test('forbids user rows without writing the batch', t => {
  const { store, repo } = fixture(t), text = '开头。保留一。删掉。保留二。'; add(store, 'a', text); add(store, 'u', '用户原文', { speaker: 'user' });
  assert.throws(() => repo.set('miyue', [edit('a', text, [{ start: 3, end: 7 }]), edit('u', '用户原文', [], { sourceHash: historySourceHash('用户原文') })]), { code: 'INVALID_HISTORY_EDIT' });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM companion_history_edits').get().n, 0);
});

test('valid edits retain row fields, support multibyte JavaScript offsets, omission, and reversion', t => {
  const { store, repo } = fixture(t), text = '甲😀乙丙'; add(store, 'a', text); add(store, 'b', 'omit');
  repo.set('miyue', [edit('a', text, [{ start: 1, end: 3 }, { start: 3, end: 5 }]), edit('b', 'omit', [])]);
  const source = store.db.prepare('SELECT * FROM messages WHERE id=?').get('a'); const projected = repo.project('miyue', [source, { ...source, id: 'b', text: 'omit' }]);
  assert.equal(projected[0].text, '😀\n乙丙'); assert.equal(projected.length, 1); assert.equal(projected[0].created_at, source.created_at);
  assert.equal(store.db.prepare('SELECT text FROM messages WHERE id=?').get('a').text, text); assert.deepEqual(repo.remove('miyue', ['a', 'b']), { count: 2 });
  assert.deepEqual(repo.project('miyue', [source]).map(row => row.text), [text]);
});

test('rejects source mismatch, wrong scope, stories, bounds, and overlaps without partial writes', t => {
  const { store, repo } = fixture(t); add(store, 'a', 'abcdef'); add(store, 'other', 'abcdef', { role: 'wenxi' }); add(store, 'story', 'abcdef', { kind: 'story' });
  for (const bad of [edit('a', 'wrong', [{ start: 0, end: 1 }]), edit('other', 'abcdef', [{ start: 0, end: 1 }]), edit('story', 'abcdef', [{ start: 0, end: 1 }]), edit('a', 'abcdef', [{ start: 0, end: 7 }]), edit('a', 'abcdef', [{ start: 0, end: 3 }, { start: 2, end: 4 }])]) assert.throws(() => repo.set('miyue', [bad]), { code: 'INVALID_HISTORY_EDIT' });
  assert.throws(() => repo.set('miyue', [edit('a', 'abcdef', [{ start: 0, end: 1 }]), edit('other', 'abcdef', [{ start: 0, end: 1 }])]), { code: 'INVALID_HISTORY_EDIT' });
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM companion_history_edits').get().n, 0);
});

test('stale source hashes fall back to original text and stats distinguish active from stale', t => {
  const { store, repo } = fixture(t); add(store, 'a', 'abcdef'); repo.set('miyue', [edit('a', 'abcdef', [{ start: 1, end: 3 }])]);
  assert.deepEqual(repo.stats('miyue'), { active: 1, stale: 0, originalChars: 6, keptChars: 2 }); store.db.prepare('UPDATE messages SET text=? WHERE id=?').run('changed', 'a');
  const row = store.db.prepare('SELECT * FROM messages WHERE id=?').get('a'); assert.equal(repo.project('miyue', [row])[0].text, 'changed');
  assert.deepEqual(repo.stats('miyue'), { active: 0, stale: 1, originalChars: 0, keptChars: 0 });
});

test('reviewed rewrites preserve originals and audit superseding and restoration atomically', t => {
  const {store,repo}=fixture(t);add(store,'a','今天周六，又刚拆了杯子。');
  const source=store.db.prepare('SELECT * FROM messages WHERE id=?').get('a');
  repo.set('miyue',[{id:'a',sourceHash:historySourceHash(source.text),replacement:'今天周日，还用那只杯子。',reason:'更正日期和已发生进度'}]);
  assert.equal(repo.project('miyue',[source])[0].text,'今天周日，还用那只杯子。');
  assert.equal(store.db.prepare('SELECT text FROM messages WHERE id=?').get('a').text,source.text);
  assert.equal(repo.list('miyue')[0].original,source.text);
  assert.throws(()=>repo.set('miyue',[{id:'a',sourceHash:historySourceHash(source.text),replacement:'错误',keptSpans:[],reason:'不能混合两种方式'}]),{code:'INVALID_HISTORY_EDIT'});
  assert.equal(store.db.prepare('SELECT count(*) n FROM companion_history_edit_audit').get().n,1);
  repo.remove('miyue',['a']);assert.equal(repo.project('miyue',[source])[0].text,source.text);
  assert.equal(store.db.prepare('SELECT count(*) n FROM companion_history_edit_audit').get().n,2);
});

test('revision changes only when a history edit audit entry is written', t => {
  const { store, repo } = fixture(t); add(store, 'a', '需要修订的历史');
  const source = store.db.prepare('SELECT * FROM messages WHERE id=?').get('a');
  assert.equal(repo.revision('miyue'), 0);
  repo.project('miyue', [source]); repo.stats('miyue'); repo.list('miyue');
  assert.equal(repo.revision('miyue'), 0, 'read operations must not invalidate a prepared reply');
  repo.set('miyue', [edit('a', source.text, [{ start: 0, end: 2 }])]);
  assert.equal(repo.revision('miyue'), 1);
  repo.remove('miyue', ['a']);
  assert.equal(repo.revision('miyue'), 2, 'restoring the original writes a removal audit entry');
  assert.equal(repo.remove('miyue', ['missing']).count, 0);
  assert.equal(repo.revision('miyue'), 2);
});
