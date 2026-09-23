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
  assert.match(rel.context('miyue'), /你们目前是恋人。/);
  assert.match(rel.context('miyue'), /延续已经建立的恋人关系/);
  const clear = [row('c1', 'miyue', 'user', '以后只做普通朋友', '2026-09-21T08:00:00Z')]; save(store, clear); rel.observe('miyue', clear);
  assert.equal(rel.view('miyue').status.value, 'friends');
  assert.match(rel.context('miyue'), /你们目前是朋友。/);
  assert.doesNotMatch(rel.context('miyue'), /延续已经建立的恋人关系/);
});

test('configured identity is current state without inventing mutual acceptance or overriding temporary boundaries', () => {
  const clock = clockAt('2026-09-14T12:00:00Z'), store = new TestStore(), rel = new CompanionRelationship(store, { clock });
  assert.match(rel.context('miyue'), /目前按朋友相处，尚未约定关系身份/);
  assert.doesNotMatch(rel.context('miyue'), /延续已经建立的恋人关系/);
  rel.update('miyue', { kind: 'status', value: 'dating', revision: 0 });
  rel.update('miyue', { kind: 'boundary', key: 'affection', value: '今天先别亲我', scope: 'today', revision: 1 });
  const context = rel.context('miyue');
  assert.match(context, /你们目前是恋人。/);
  assert.match(context, /当前边界原话：“今天先别亲我”/);
  assert.match(context, /当前亲近方式以有效边界为准/);
  assert.doesNotMatch(context, /双方已经答应|双方已确认|来源：已保存原话/);
  const before = rel.view('miyue');
  assert.equal(before.status.value, 'dating');
  assert.equal(before.status.source.type, 'setting');
  assert.deepEqual(before.status.source.messageIds, []);
  assert.equal(before.intimacyBoundary, 'friendly');
  assert.deepEqual(rel.view('miyue'), before);
  clock.set('2026-09-15T00:00:00Z');
  assert.doesNotMatch(rel.context('miyue'), /当前边界原话/);
  assert.match(rel.context('miyue'), /你们目前是恋人/);
  store.close();
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


test('a validated current preference survives an omitted optional tail as a temporary sourced fact', () => {
  const store=new TestStore(), clock=clockAt('2026-09-15T12:30:00Z'), rel=new CompanionRelationship(store,{clock});
  const current=row('pacing-user','miyue','user','不用分析，就陪我随便说两句。',clock().toISOString());save(store,[current]);
  const semantic={status:'model',decision:{intent:'preference',evidence:'不用分析'}};
  rel.observe('miyue',[current],[],{semantic});
  const fact=rel.view('miyue').preferences.find(item=>item.key==='communication');
  assert.equal(fact.value,current.text);assert.equal(fact.scope,'turn');
  assert.equal(fact.validUntil,'2026-09-15T14:30:00.000Z');assert.deepEqual(fact.source.messageIds,[current.id]);
  assert.equal(rel.view('miyue').intimacyBoundary,'open');assert.equal(rel.view('miyue').status.value,'friends');
  const revision=rel.revision('miyue');rel.observe('miyue',[current],[],{semantic});assert.equal(rel.revision('miyue'),revision);
  assert.equal(rel.view('miyue',{suppressedSourceIds:[current.id]}).preferences.length,0);
  clock.set('2026-09-15T14:31:00Z');assert.equal(rel.view('miyue').preferences.length,0);
});

test('semantic preference retention rejects fallback, wrong evidence, unsaved rows, and quoted speech',()=>{
  for(const [text,semantic,stored] of [
    ['不用分析',{status:'fallback',decision:{intent:'preference',evidence:'不用分析'}},true],
    ['不用分析',{status:'model',decision:{intent:'preference',evidence:'别问我'}},true],
    ['不用分析',{status:'model',decision:{intent:'respond',evidence:'不用分析'}},true],
    ['不用分析',{status:'model',decision:{intent:'preference',evidence:'不用分析'}},false],
    ['他说不用分析',{status:'model',decision:{intent:'preference',evidence:'不用分析'}},true],
  ]){
    const store=new TestStore(),clock=clockAt('2026-09-15T12:30:00Z'),rel=new CompanionRelationship(store,{clock});
    const current=row('u','miyue','user',text,clock().toISOString());if(stored)save(store,[current]);
    rel.observe('miyue',[current],[],{semantic});assert.equal(rel.view('miyue').preferences.length,0,text);store.close();
  }
});

test('an explicit preference candidate retains its supplied scope without a second derived preference',()=>{
  const store=new TestStore(),clock=clockAt('2026-09-15T12:30:00Z'),rel=new CompanionRelationship(store,{clock});
  const current=row('u','miyue','user','以后都少讲一点吧。',clock().toISOString());save(store,[current]);
  rel.observe('miyue',[current],[{kind:'preference',key:'conversation',source:'user',scope:'persistent',evidence:current.text}],{semantic:{status:'model',decision:{intent:'preference',evidence:'少讲一点'}}});
  const prefs=rel.view('miyue').preferences;assert.equal(prefs.length,1);assert.equal(prefs[0].key,'conversation');assert.equal(prefs[0].scope,'persistent');
});

test('semantic boundary fallback retains a saved tonight limit without changing a dating relationship',()=>{
  const clock=clockAt('2026-09-15T14:30:00Z'),store=new TestStore(),rel=new CompanionRelationship(store,{clock});
  rel.update('miyue',{kind:'status',value:'dating',revision:0});
  const current=row('boundary-user','miyue','user','今晚先不亲亲了，就这样靠着，普通聊聊天。不是不喜欢你了。',clock().toISOString());save(store,[current]);
  rel.observe('miyue',[current],[],{semantic:{status:'model',decision:{intent:'boundary',evidence:'今晚先不亲亲了'}}});
  const fact=rel.view('miyue').boundaries.find(item=>item.key==='stated_limit');
  assert.equal(fact.value,current.text);assert.equal(fact.scope,'today');assert.equal(fact.validUntil,'2026-09-15T16:00:00.000Z');
  assert.deepEqual(fact.source.messageIds,[current.id]);assert.equal(rel.view('miyue').status.value,'dating');assert.equal(rel.view('miyue').intimacyBoundary,'open');
  assert.match(rel.context('miyue'),/今晚先不亲亲了/);
  assert.equal(rel.view('miyue',{suppressedSourceIds:[current.id]}).boundaries.length,0);
  clock.set('2026-09-15T16:00:00Z');assert.equal(rel.view('miyue').boundaries.length,0);assert.equal(rel.view('miyue').status.value,'dating');
});

test('a validated temporary semantic boundary canonicalizes a valid intimacy tail to one full-source stated limit',()=>{
  const clock=clockAt('2026-09-15T14:30:00Z'),store=new TestStore(),rel=new CompanionRelationship(store,{clock});
  rel.update('miyue',{kind:'status',value:'dating',revision:0});
  const current=row('u','miyue','user','今晚先不亲亲了，就这样靠着，普通聊聊天。不是不喜欢你了。',clock().toISOString());save(store,[current]);
  rel.observe('miyue',[current],[{kind:'boundary',key:'intimacy',source:'user',scope:'today',evidence:'今晚先不亲亲了，就这样靠着，普通聊聊天。'}],{semantic:{status:'model',decision:{intent:'boundary',evidence:'今晚先不亲亲了'}}});
  const view=rel.view('miyue');assert.equal(view.boundaries.length,1);assert.equal(view.boundaries[0].key,'stated_limit');assert.equal(view.boundaries[0].value,current.text);assert.equal(view.intimacyBoundary,'open');assert.equal(view.status.value,'dating');
});

test('a validated temporary semantic boundary suppresses its same-source lexical boundary duplicate',()=>{
  const store=new TestStore(),clock=clockAt('2026-09-15T12:00:00Z'),rel=new CompanionRelationship(store,{clock});
  const current=row('u','miyue','user','今天别暧昧啦，我们正常聊。',clock().toISOString());save(store,[current]);
  rel.observe('miyue',[current],[],{semantic:{status:'model',decision:{intent:'boundary',evidence:'今天别暧昧'}}});
  const view=rel.view('miyue');assert.equal(view.boundaries.length,1);assert.equal(view.boundaries[0].key,'stated_limit');assert.equal(view.boundaries[0].value,current.text);assert.equal(view.intimacyBoundary,'open');
});

test('a persistent semantic boundary keeps its existing explicit tail category',()=>{
  const store=new TestStore(),clock=clockAt('2026-09-15T12:00:00Z'),rel=new CompanionRelationship(store,{clock});
  const current=row('u','miyue','user','以后不要亲密接触。',clock().toISOString());save(store,[current]);
  rel.observe('miyue',[current],[{kind:'boundary',key:'intimacy',source:'user',scope:'persistent',evidence:current.text}],{semantic:{status:'model',decision:{intent:'boundary',evidence:'以后不要亲密接触'}}});
  const view=rel.view('miyue');assert.equal(view.boundaries.length,1);assert.equal(view.boundaries[0].key,'intimacy');assert.equal(view.boundaries[0].scope,'persistent');assert.equal(view.intimacyBoundary,'friendly');
});

test('semantic boundary fallback never turns a long-term wording into a stated limit',()=>{
  const store=new TestStore(),clock=clockAt('2026-09-15T12:00:00Z'),rel=new CompanionRelationship(store,{clock});
  const current=row('u','miyue','user','以后不要这样开玩笑。',clock().toISOString());save(store,[current]);
  rel.observe('miyue',[current],[],{semantic:{status:'model',decision:{intent:'boundary',evidence:'以后不要这样开玩笑'}}});
  assert.equal(rel.view('miyue').boundaries.length,0);
});

test('semantic stated limits coexist by source and removing one does not hide another',()=>{
  const clock=clockAt('2026-09-15T12:00:00Z'),store=new TestStore(),rel=new CompanionRelationship(store,{clock});
  const first=row('u1','miyue','user','今晚先不亲亲了。',clock().toISOString()),second=row('u2','miyue','user','今晚先不说情话了。',clock().toISOString());save(store,[first,second]);
  const semantic=text=>({semantic:{status:'model',decision:{intent:'boundary',evidence:text}}});
  rel.observe('miyue',[first],[],semantic('今晚先不亲亲了'));rel.observe('miyue',[second],[],semantic('今晚先不说情话了'));
  assert.deepEqual(rel.view('miyue').boundaries.map(item=>item.value),[first.text,second.text]);
  const removed=rel.view('miyue').boundaries[0];rel.update('miyue',{id:removed.id,action:'remove',revision:rel.revision('miyue')});
  assert.deepEqual(rel.view('miyue').boundaries.map(item=>item.value),[second.text]);
});

test('semantic boundary fallback requires an untampered saved user source and a valid model decision',()=>{
  const cases=[
    {text:'今晚先不亲亲了。',semantic:{status:'fallback',decision:{intent:'boundary',evidence:'今晚先不亲亲了'}},stored:true},
    {text:'今晚先不亲亲了。',semantic:{status:'model',decision:{intent:'respond',evidence:'今晚先不亲亲了'}},stored:true},
    {text:'他说今晚先不亲亲了。',semantic:{status:'model',decision:{intent:'boundary',evidence:'今晚先不亲亲了'}},stored:true},
    {text:'“今晚先不亲亲了。”',semantic:{status:'model',decision:{intent:'boundary',evidence:'今晚先不亲亲了'}},stored:true},
    {text:'今晚先不亲亲了。',semantic:{status:'model',decision:{intent:'boundary',evidence:'今晚先不亲亲了'}},stored:false},
  ];
  for(const [index,item] of cases.entries()){
    const store=new TestStore(),clock=clockAt('2026-09-15T12:00:00Z'),rel=new CompanionRelationship(store,{clock});
    const current=row(`u${index}`,'miyue','user',item.text,clock().toISOString());if(item.stored)save(store,[current]);
    rel.observe('miyue',[current],[],{semantic:item.semantic});assert.equal(rel.view('miyue').boundaries.length,0,item.text);store.close();
  }
  for(const [storedRole,storedSpeaker,storedText] of [['other','user','今晚先不亲亲了。'],['miyue','assistant','今晚先不亲亲了。'],['miyue','user','已被篡改']]){
    const store=new TestStore(),clock=clockAt('2026-09-15T12:00:00Z'),rel=new CompanionRelationship(store,{clock});
    save(store,[row('u',storedRole,storedSpeaker,storedText,clock().toISOString())]);
    rel.observe('miyue',[row('u','miyue','user','今晚先不亲亲了。',clock().toISOString())],[],{semantic:{status:'model',decision:{intent:'boundary',evidence:'今晚先不亲亲了'}}});
    assert.equal(rel.view('miyue').boundaries.length,0,`${storedRole}/${storedSpeaker}/${storedText}`);store.close();
  }
});

test('valid optional boundary wins over semantic fallback and each saved source is idempotent',()=>{
  const store=new TestStore(),clock=clockAt('2026-09-15T12:00:00Z'),rel=new CompanionRelationship(store,{clock});
  const current=row('u','miyue','user','今晚先不亲亲了。',clock().toISOString());save(store,[current]);
  const semantic={status:'model',decision:{intent:'boundary',evidence:'今晚先不亲亲了'}};
  rel.observe('miyue',[current],[{kind:'boundary',key:'stated_limit',source:'user',scope:'today',evidence:'今晚先不亲亲了'}],{semantic});
  assert.equal(rel.view('miyue').boundaries.length,1);assert.equal(rel.view('miyue').boundaries[0].value,current.text);const revision=rel.revision('miyue');
  rel.observe('miyue',[current],[],{semantic});assert.equal(rel.view('miyue').boundaries.length,1);assert.equal(rel.revision('miyue'),revision);
  assert.match(promptInstruction(),/boundary 的 key .*stated_limit/);
  rel.observe('miyue',[current],[{kind:'boundary',key:'made_up_limit',source:'user',scope:'today',evidence:current.text}]);assert.equal(rel.view('miyue').boundaries.length,1);
  const permanent=row('later','miyue','user','以后先不亲亲了。',clock().toISOString());save(store,[permanent]);
  rel.observe('miyue',[permanent],[{kind:'boundary',key:'stated_limit',source:'user',scope:'persistent',evidence:permanent.text}]);assert.equal(rel.view('miyue').boundaries.length,1);
});

test('an observed stated limit disappears when its saved source is deleted',()=>{
  const store=new TestStore(),clock=clockAt('2026-09-15T12:00:00Z'),rel=new CompanionRelationship(store,{clock});
  const current=row('u','miyue','user','今晚先不亲亲了。',clock().toISOString());save(store,[current]);
  rel.observe('miyue',[current],[],{semantic:{status:'model',decision:{intent:'boundary',evidence:'今晚先不亲亲了'}}});
  store.db.prepare('DELETE FROM messages WHERE id=?').run(current.id);assert.equal(rel.view('miyue').boundaries.length,0);
});

test('a stated limit loses authority if its saved wording is later tampered',()=>{
  const store=new TestStore(),clock=clockAt('2026-09-15T12:00:00Z'),rel=new CompanionRelationship(store,{clock});
  const current=row('u','miyue','user','今晚先不亲亲了。',clock().toISOString());save(store,[current]);
  rel.observe('miyue',[current],[],{semantic:{status:'model',decision:{intent:'boundary',evidence:'今晚先不亲亲了'}}});
  store.db.prepare('UPDATE messages SET text=? WHERE id=?').run('今晚先不亲亲了，不过现在可以了。',current.id);assert.equal(rel.view('miyue').boundaries.length,0);
});

test('context keeps every active boundary after extensive optional background',()=>{
  const store=new TestStore(),clock=clockAt('2026-09-15T12:00:00Z'),rel=new CompanionRelationship(store,{clock});
  for(let index=0;index<8;index++){
    const background=row(`p${index}`,'miyue','user',`偏好背景${index}${'很长'.repeat(45)}`,clock().toISOString());save(store,[background]);
    rel.observe('miyue',[background],[{kind:'preference',key:'communication',source:'user',scope:'persistent',evidence:background.text}]);
  }
  const limits=[];
  for(let index=0;index<6;index++){
    const limit=row(`b${index}`,'miyue','user',`今晚先不亲亲${index}。`,clock().toISOString());limits.push(limit);save(store,[limit]);
    rel.observe('miyue',[limit],[],{semantic:{status:'model',decision:{intent:'boundary',evidence:`今晚先不亲亲${index}`}}});
  }
  const context=rel.context('miyue');assert.equal(rel.view('miyue').boundaries.length,6);
  for(const limit of limits)assert.ok(context.includes(limit.text));
});
