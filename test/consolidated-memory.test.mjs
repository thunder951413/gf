import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConsolidatedMemoryRepository } from '../lib/consolidated-memory.mjs';

class Store {
  constructor(file = ':memory:') { this.db = new DatabaseSync(file); this.db.exec("CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,role TEXT,speaker TEXT,text TEXT,kind TEXT,created_at TEXT); CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT); CREATE VIEW IF NOT EXISTS recall_messages AS SELECT rowid,id,role,speaker,text,kind,created_at FROM messages;"); }
  transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } }
  close() { this.db.close(); }
}
function add(store, id, text, speaker = 'user', role = 'miyue', at = '2026-09-01T00:00:00.000Z') { store.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(id, role, speaker, text, 'chat', at); return store.db.prepare('SELECT rowid,* FROM recall_messages WHERE id=?').get(id); }
function input(rows, candidates, revision = 0, ignored = []) { const last = rows.at(-1); return { expectedRevision: revision, fromCursor: rows[0].rowid - 1, through: { rowid: last.rowid, id: last.id }, rows, candidates, ignored, now: '2026-09-10T00:00:00.000Z', model: 'test' }; }
function candidate(row, summary = 'Likes tea', extra = {}) { return { subject: 'user', kind: 'preference', topic: 'drinks', summary, status: 'current', evidence: [{ messageId: row.id, quote: 'tea' }], ...extra }; }

test('repeated candidates stay one bounded memory and replay CAS is stale', () => {
  const store = new Store(); const repo = new ConsolidatedMemoryRepository(store);
  let revision = 0;
  let row;
  for (let i = 0; i < 100; i++) { row = add(store, `u${i + 1}`, 'tea again', 'user', 'miyue', `2026-09-${String((i % 9) + 1).padStart(2, '0')}T01:00:00.000Z`); const result = repo.apply('miyue', input([row], [candidate(row)], revision)); revision = result.revision; }
  assert.equal(repo.snapshot('miyue').items.length, 1); assert.equal(repo.snapshot('miyue').items[0].mentions, 100);
  assert.equal(repo.apply('miyue', input([row], [candidate(row)], 0)).status, 'stale'); store.close();
});

test('same-batch same-topic candidates reuse the just-created memory', () => {
  const store = new Store(), one = add(store, 'u1', 'tea'), two = add(store, 'u2', 'tea still'); const repo = new ConsolidatedMemoryRepository(store);
  const result = repo.apply('miyue', input([one, two], [candidate(one), candidate(two)]));
  const item = repo.snapshot('miyue').items[0];
  assert.equal(result.stats.created, 1); assert.equal(result.stats.repeated, 1); assert.equal(result.stats.updated, 0); assert.equal(repo.snapshot('miyue').items.length, 1); assert.equal(item.mentions, 2); assert.equal(item.evidence.length, 2);
  store.close();
});

test('cursor batches must be complete, ordered, and anchored to the current cursor', () => {
  const store = new Store(), one = add(store, 'u1', 'tea'), two = add(store, 'u2', 'coffee'); const repo = new ConsolidatedMemoryRepository(store);
  assert.throws(() => repo.apply('miyue', input([two], [candidate(two, 'Likes coffee', { evidence: [{ messageId: two.id, quote: 'coffee' }] })])));
  assert.equal(repo.snapshot('miyue').revision, 0);
  const first = repo.apply('miyue', input([one, two], [candidate(one), candidate(two, 'Likes coffee', { evidence: [{ messageId: two.id, quote: 'coffee' }] })]));
  const bad = input([two], [candidate(two, 'Likes coffee', { evidence: [{ messageId: two.id, quote: 'coffee' }] })], first.revision); bad.fromCursor = 0;
  assert.throws(() => repo.apply('miyue', bad)); assert.equal(repo.snapshot('miyue').revision, first.revision); store.close();
});

test('correction replaces only with newer evidence; forged, foreign and uncovered input is atomic', () => {
  const store = new Store(), old = add(store, 'u1', 'I like tea', 'user', 'miyue', '2026-09-01T00:00:00Z'), fresh = add(store, 'u2', 'I now prefer coffee', 'user', 'miyue', '2026-09-09T00:00:00Z'), other = add(store, 'x1', 'I like tea', 'user', 'other'); const repo = new ConsolidatedMemoryRepository(store);
  let out = repo.apply('miyue', input([old], [candidate(old)], 0));
  out = repo.apply('miyue', input([fresh], [{ ...candidate(fresh, 'Likes coffee'), topic: 'drinks', evidence: [{ messageId: 'u2', quote: 'coffee' }] }], out.revision)); assert.equal(repo.snapshot('miyue').items[0].summary, 'Likes coffee');
  const before = repo.snapshot('miyue');
  assert.throws(() => repo.apply('miyue', input([fresh], [{ ...candidate(fresh), evidence: [{ messageId: 'u2', quote: 'forged' }] }], before.revision)));
  assert.throws(() => repo.apply('miyue', input([other], [candidate(other)], before.revision)));
  assert.deepEqual(repo.snapshot('miyue'), before); store.close();
});

test('ignored coverage, suppression, capacity and restart are persisted', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-')), file = path.join(folder, 'x.sqlite'); let store = new Store(file); const row = add(store, 'u1', 'hello tea'); let hidden = new Set(); let repo = new ConsolidatedMemoryRepository(store, { getSuppressedSourceIds: () => [...hidden] });
  repo.apply('miyue', input([row], [], 0, [{ messageId: 'u1', reason: 'greeting' }])); assert.equal(repo.snapshot('miyue').revision, 1);
  const rows = []; for (let i = 0; i < 101; i++) rows.push(add(store, `p${i}`, `tea ${i}`, 'user', 'miyue', `2026-09-10T${String(i % 24).padStart(2, '0')}:00:00Z`));
  let revision = 1;
  for (const group of [rows.slice(0, 40), rows.slice(40, 80), rows.slice(80)]) {
    const result = repo.apply('miyue', input(group, group.map((r, i) => ({ ...candidate(r, `Preference ${r.id}`, { topic: `t${r.id}` }), evidence: [{ messageId: r.id, quote: `tea ${Number(r.id.slice(1))}` }] })), revision));
    assert.equal(result.status, 'updated'); revision = result.revision;
  }
  assert.equal(repo.snapshot('miyue').items.length, 100); hidden.add('p1'); assert.equal(repo.context('miyue').includes('source:p1)'), false); store.close();
  store = new Store(file); repo = new ConsolidatedMemoryRepository(store); assert.equal(repo.snapshot('miyue').revision, 4); assert.ok(repo.snapshot('miyue').items.length <= 100); store.close(); fs.rmSync(folder, { recursive: true });
});

test('reset clears derived state, moves to the latest qualified cursor, and invalidates pending revisions', () => {
  const store = new Store(), first = add(store, 'u1', 'tea'), last = add(store, 'u2', 'coffee'); const repo = new ConsolidatedMemoryRepository(store);
  repo.apply('miyue', input([first], [candidate(first)], 0));
  const reset = repo.reset('miyue', { now: '2026-09-11T00:00:00Z' });
  assert.equal(reset.cursor.id, last.id); assert.equal(repo.snapshot('miyue').items.length, 0);
  assert.equal(repo.apply('miyue', input([last], [{ ...candidate(last, 'Likes coffee'), evidence: [{ messageId: last.id, quote: 'coffee' }] }], 1)).status, 'stale');
  store.close();
});

test('identical event descriptions on different dates remain separate, while punctuation-only preference repeats do not grow',()=>{
  const store=new Store(),repo=new ConsolidatedMemoryRepository(store);
  const first=add(store,'trip1','去了丽江','user','miyue','2026-08-01T00:00:00Z');
  const second=add(store,'trip2','去了丽江','user','miyue','2026-09-01T00:00:00Z');
  const event=(row,topic)=>({subject:'user',kind:'event',topic,summary:'去丽江旅行。',status:'completed',evidence:[{messageId:row.id,quote:'去了丽江'}]});
  repo.apply('miyue',input([first,second],[event(first,'8月丽江旅行'),event(second,'9月丽江旅行')]));
  assert.equal(repo.snapshot('miyue').items.length,2);
  assert.equal(repo.snapshot('miyue').items.find(x=>x.topic==='8月丽江旅行').firstAt,first.created_at);
  const third=add(store,'tea1','tea'),fourth=add(store,'tea2','tea');
  repo.apply('miyue',input([third,fourth],[candidate(third,'Likes tea.'),candidate(fourth,'Likes tea!')],1));
  assert.equal(repo.snapshot('miyue').items.length,3);
  assert.equal(repo.snapshot('miyue').items.find(x=>x.topic==='drinks').summary,'Likes tea.');
  store.close();
});

test('character ledger entries are query-projected without changing user facts or source state', () => {
  const store = new Store(), repo = new ConsolidatedMemoryRepository(store);
  const user = add(store, 'u1', '我不喝含糖饮料，也别催我喝水。');
  const tea = add(store, 'a1', '我下午泡了桂花乌龙茶。', 'assistant');
  const work = add(store, 'a2', '绿金那版包装稿刚刚改完。', 'assistant');
  const boundary = add(store, 'a3', '我不希望被催着回复。', 'assistant');
  const mood = add(store, 'a4', '今天感觉很平静。', 'assistant');
  const rows = [user, tea, work, boundary, mood];
  repo.apply('miyue', input(rows, [
    { subject: 'user', kind: 'preference', topic: '饮料偏好', summary: '用户不喝含糖饮料。', status: 'current', evidence: [{ messageId: user.id, quote: '不喝含糖饮料' }] },
    { subject: 'user', kind: 'boundary', topic: '饮水提醒', summary: '用户不希望被催喝水。', status: 'current', evidence: [{ messageId: user.id, quote: '别催我喝水' }] },
    { subject: 'character', kind: 'fact', topic: '桂花乌龙茶', summary: '她下午泡了桂花乌龙茶。', status: 'past', evidence: [{ messageId: tea.id, quote: '泡了桂花乌龙茶' }] },
    { subject: 'character', kind: 'topic', topic: '绿金包装改稿', summary: '她刚改完绿金包装稿。', status: 'completed', evidence: [{ messageId: work.id, quote: '绿金那版包装稿刚刚改完' }] },
    { subject: 'character', kind: 'boundary', topic: '回复节奏', summary: '她不希望被催着回复。', status: 'current', evidence: [{ messageId: boundary.id, quote: '不希望被催着回复' }] },
    { subject: 'character', kind: 'fact', topic: '今天感觉', summary: '她今天感觉很平静。', status: 'past', evidence: [{ messageId: mood.id, quote: '今天感觉很平静' }] },
    { subject: 'shared', kind: 'topic', topic: '桂花乌龙茶', summary: '双方聊过桂花乌龙茶。', status: 'past', evidence: [{ messageId: user.id, quote: '不喝含糖饮料' }, { messageId: tea.id, quote: '泡了桂花乌龙茶' }] },
  ]));
  const before = repo.snapshot('miyue');
  const plain = repo.context('miyue');
  assert.match(plain, /桂花乌龙茶/); assert.match(plain, /绿金包装稿/);
  const unrelated = repo.context('miyue', { characterQuery: '国际新闻有什么新消息' });
  assert.match(unrelated, /用户不喝含糖饮料/);
  assert.match(unrelated, /用户不希望被催喝水/);
  assert.match(unrelated, /她不希望被催着回复/);
  assert.doesNotMatch(unrelated, /桂花乌龙茶|绿金包装稿/);
  assert.doesNotMatch(repo.context('miyue', { characterQuery: '我今天到了，感觉还行' }), /她今天感觉很平静/);
  const teaQuery = repo.context('miyue', { characterQuery: '桂花乌龙茶怎么泡' });
  assert.match(teaQuery, /她下午泡了桂花乌龙茶/); assert.match(teaQuery, /双方聊过桂花乌龙茶/);
  assert.match(repo.context('miyue', { characterQuery: '绿金包装稿后来怎么样' }), /绿金包装稿/);
  assert.deepEqual(repo.snapshot('miyue'), before);
  store.close();
});


test('memory projection separates an ordinary user update from coincidentally matching character life and old topics',()=>{
 const store=new Store(),repo=new ConsolidatedMemoryRepository(store);
 const user=add(store,'user-coffee','我喜欢咖啡加奶，不喜欢被催睡觉。我想象过一个听雨的小院。');
 const character=add(store,'char-coffee','我在改包装时泡了杯咖啡。','assistant');
 repo.apply('miyue',input([user,character],[
  {subject:'user',kind:'preference',topic:'咖啡偏好',summary:'用户喜欢咖啡加奶。',status:'current',evidence:[{messageId:user.id,quote:'我喜欢咖啡加奶'}]},
  {subject:'user',kind:'boundary',topic:'睡觉提醒',summary:'用户不喜欢被催睡觉。',status:'current',evidence:[{messageId:user.id,quote:'不喜欢被催睡觉'}]},
  {subject:'user',kind:'topic',topic:'听雨小院',summary:'用户想象过一个听雨的小院。',status:'past',evidence:[{messageId:user.id,quote:'我想象过一个听雨的小院'}]},
  {subject:'character',kind:'event',topic:'改包装',summary:'角色改包装时泡咖啡。',status:'ongoing',evidence:[{messageId:character.id,quote:'我在改包装时泡了杯咖啡'}]},
 ]));
 const before=repo.snapshot('miyue');
 const update=repo.context('miyue',{characterQuery:'开完会买杯咖啡',includeCharacter:false});
 assert.match(update,/咖啡加奶/);assert.match(update,/不喜欢被催睡觉/);assert.doesNotMatch(update,/改包装|听雨/);
 assert.match(repo.context('miyue',{characterQuery:'你那回改包装喝咖啡',includeCharacter:true}),/改包装/);
 assert.match(repo.context('miyue',{characterQuery:'那次听雨的小院'}),/听雨/);
 assert.match(repo.context('miyue'),/听雨|改包装/);
 assert.deepEqual(repo.snapshot('miyue'),before);store.close();
});
