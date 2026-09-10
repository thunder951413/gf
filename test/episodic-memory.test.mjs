import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { RecallRepository } from '../lib/recall.mjs';
import { EpisodicMemoryRepository } from '../lib/episodic-memory.mjs';

const story = { start: 'start', nodes: { start: { id: 'start', title: 'start', body: '', choices: [] } } };

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-episodic-'));
  let now = new Date('2026-09-07T08:00:00.000Z');
  const clock = () => now;
  const store = new Store({ dataDir, story, initialFeeds: [] });
  new RecallRepository(store, { clock });
  const repo = new EpisodicMemoryRepository(store, { clock });
  t.after(() => { try { store.close(); } catch {} fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { dataDir, store, repo, clock, advance(ms) { now = new Date(now.valueOf() + ms); } };
}

function turn(store, role, userText, assistantText, { scope, at = '2026-09-07T07:00:00.000Z' } = {}) {
  const rows = store.saveChatTurn({ role, text: userText, reply: assistantText });
  store.db.prepare('UPDATE messages SET created_at=? WHERE id IN (?,?)').run(at, rows[0].id, rows[1].id);
  rows.forEach((row) => { row.createdAt = at; });
  if (scope) {
    const insert = store.db.prepare('INSERT INTO scenario_message_scope(message_id,scope) VALUES(?,?)');
    rows.forEach((row) => insert.run(row.id, scope));
  }
  return rows;
}

test('observe accepts only committed, scope-visible evidence and retains meaningful exact quote pairs', (t) => {
  const { store, repo } = fixture(t);
  const rows = turn(store, 'zhixia', '比起咖啡我更喜欢雨天喝乌龙茶。', '那下次下雨时，我提醒你把那只蓝杯也带上。');
  const entries = store.transaction(() => repo.observe('zhixia', rows));
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].quotes.map(({ speaker, text, createdAt }) => ({ speaker, text, createdAt })), [
    { speaker: 'user', text: rows[0].text, createdAt: rows[0].createdAt },
    { speaker: 'assistant', text: rows[1].text, createdAt: rows[1].createdAt },
  ]);
  assert.throws(() => repo.observe('zhixia', [{ ...rows[0], text: '伪造的偏好' }, rows[1]]), { code: 'INVALID_EPISODIC_MEMORY' });
  assert.throws(() => repo.observe('wenxi', rows), { code: 'INVALID_EPISODIC_MEMORY' });
  assert.equal(repo.observe('zhixia', rows)[0].id, entries[0].id);
  assert.equal(repo.list('zhixia').length, 1);
  assert.equal(repo.revision('zhixia'), 1);
});

test('scenario evidence cannot leak into its base role or another scenario and persona cutoff applies', (t) => {
  const { store, repo } = fixture(t);
  const scope = 'zhixia::scenario:rain';
  const scoped = turn(store, 'zhixia', '我不赞同你刚才在雨廊里的判断。', '那我们把分歧写在这张电影票背面。', { scope });
  assert.equal(repo.observe(scope, scoped).length, 1);
  assert.throws(() => repo.remember('zhixia', scoped.map(({ id }) => id)), { code: 'INVALID_EPISODIC_MEMORY' });
  assert.throws(() => repo.remember('zhixia::scenario:snow', scoped.map(({ id }) => id)), { code: 'INVALID_EPISODIC_MEMORY' });

  const old = turn(store, 'miyue', '我喜欢旧称呼。', '我会继续使用旧称呼回应你。');
  const cutoff = store.db.prepare('SELECT rowid FROM messages WHERE id=?').get(old[1].id).rowid;
  store.db.prepare("INSERT INTO metadata(key,value) VALUES('persona_cutoff:miyue',?)").run(String(cutoff));
  assert.throws(() => repo.observe('miyue', old), { code: 'INVALID_EPISODIC_MEMORY' });
});

test('generic turns are skipped, manual evidence is pinned, and restart is idempotent', (t) => {
  const { store, repo, clock } = fixture(t);
  const generic = turn(store, 'wenxi', '谢谢', '不客气。');
  assert.deepEqual(repo.observe('wenxi', generic), []);
  assert.equal(repo.revision('wenxi'), 0);
  const specific = turn(store, 'wenxi', '这份材料我晚点再读。', '好，我先把它留在这里。');
  const pinned = repo.remember('wenxi', specific.map(({ id }) => id), '稍后阅读');
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.label, '稍后阅读');
  assert.throws(() => repo.remember('wenxi', specific.map(({ id }) => id), '甲'.repeat(81)), { code: 'INVALID_EPISODIC_MEMORY' });
  const restarted = new EpisodicMemoryRepository(store, { clock });
  assert.equal(restarted.remember('wenxi', specific.map(({ id }) => id), '稍后阅读').id, pinned.id);
  assert.equal(restarted.list('wenxi').length, 1);
  assert.equal(restarted.revision('wenxi'), 1);
});

test('tombstones suppress automatic resurrection while a correction preserves original evidence', (t) => {
  const { store, repo } = fixture(t);
  const firstRows = turn(store, 'miyue', '我喜欢周六去看海。', '我建议你周六清晨出发，路上更安静。');
  const first = repo.observe('miyue', firstRows)[0];
  assert.equal(repo.remove('miyue', first.id), true);
  assert.equal(repo.remove('miyue', first.id), false);
  assert.deepEqual(repo.observe('miyue', firstRows), []);
  assert.equal(repo.list('miyue', { status: 'tombstone' })[0].id, first.id);
  assert.deepEqual(repo.suppressedSourceIds('miyue').sort(), firstRows.map(({ id }) => id).sort());
  assert.equal(repo.hasOverrides('miyue'), true);

  const secondRows = turn(store, 'miyue', '我更喜欢周日看海，不是周六。', '收到，我会按周日这个偏好来回应。');
  const second = repo.observe('miyue', secondRows)[0];
  const original = second.quotes.map(({ text }) => text);
  const corrected = repo.correct('miyue', second.id, '用户更正：只在每月第一个周日去看海。');
  assert.equal(corrected.corrected, true);
  assert.deepEqual(corrected.quotes.map(({ text }) => text), original);
  assert.match(repo.context([corrected]), /原话已被用户更正/);
  assert.match(repo.context([corrected]), /原话已过时，仅作证据；以用户更正为准/);
  assert.match(repo.context([corrected]), /当前应以此为准/);
  assert.match(repo.context([corrected]), /角色表达或虚构叙事，不是客观事实/);
  assert.match(repo.context([corrected]), new RegExp(secondRows[0].id));
  assert.deepEqual(repo.suppressedSourceIds('miyue').sort(), [...firstRows, ...secondRows].map(({ id }) => id).sort());
  assert.equal(repo.revision('miyue'), 4);
  repo.remove('miyue', second.id);
  const restoredCorrection = repo.remember('miyue', secondRows.map(({ id }) => id));
  assert.equal(restoredCorrection.corrected, true);
  assert.equal(restoredCorrection.correction, corrected.correction);
});

test('retrieval requires evidence overlap, respects budget, ranks exact quotes, and cools used entries', (t) => {
  const { store, repo, advance } = fixture(t);
  const teaRows = turn(store, 'zhixia', '比起咖啡，我最喜欢凤凰单丛。', '下次我建议用盖碗冲凤凰单丛。');
  const tea = repo.observe('zhixia', teaRows)[0];
  const bookRows = turn(store, 'zhixia', '我喜欢睡前读推理小说。', '那我建议今晚先读短篇推理。');
  repo.observe('zhixia', bookRows);
  assert.deepEqual(repo.retrieve('zhixia', '凤凰单丛怎么冲？').map(({ id }) => id), [tea.id]);
  assert.deepEqual(repo.retrieve('zhixia', '今天天气如何？'), []);
  assert.deepEqual(repo.retrieve('zhixia', '谢谢'), []);
  assert.equal(repo.retrieve('zhixia', '凤凰单丛', { charBudget: 20 }).length, 0);
  const selected = repo.retrieve('zhixia', '凤凰单丛', { charBudget: 1500 });
  assert.ok(repo.context(selected).length <= 1500);
  assert.equal(repo.markUsed([tea.id]), 1);
  assert.deepEqual(repo.retrieve('zhixia', '凤凰单丛'), []);
  for (let index = 0; index < 3; index += 1) {
    advance(1_000);
    repo.observe('zhixia', turn(store, 'zhixia', `普通新消息编号${index}`, '我听见了，我们继续聊。'));
  }
  assert.deepEqual(repo.retrieve('zhixia', '凤凰单丛').map(({ id }) => id), [tea.id]);
});

test('the per-role active cap evicts only the oldest unpinned episode', (t) => {
  const { store, repo } = fixture(t);
  const pinnedRows = turn(store, 'wenxi', '请记住这一条具体的蓝色文件线索。', '我会把蓝色文件这段原话作为依据。');
  const pinned = repo.remember('wenxi', pinnedRows.map(({ id }) => id), '蓝色文件');
  let oldestAutomatic;
  for (let index = 0; index < 100; index += 1) {
    const rows = turn(store, 'wenxi', `我喜欢第${index}种具体茶叶。`, `我建议把第${index}种茶叶记进清单。`);
    const entry = repo.observe('wenxi', rows)[0];
    if (index === 0) oldestAutomatic = entry;
  }
  const active = repo.list('wenxi', { status: 'active' });
  assert.equal(active.length, 100);
  assert.equal(repo.hasOverrides('wenxi'),false,'capacity eviction must not disable rolling summaries');
  assert.equal(active.some(({ id }) => id === pinned.id), true);
  assert.equal(active.some(({ id }) => id === oldestAutomatic.id), false);
  assert.equal(repo.list('wenxi', { status: 'tombstone' }).some(({ id }) => id === oldestAutomatic.id), true);
});

test('a removed source cannot return through a different automatic or manual pairing', (t) => {
  const { store, repo } = fixture(t);
  const originalRows = turn(store, 'miyue', '我喜欢把银色票根夹在书里。', '我建议夹在那本绿色诗集里。');
  const removed = repo.observe('miyue', originalRows)[0];
  repo.remove('miyue', removed.id);
  const alternateReply = store.addAssistantMessage('miyue', '这个偏好我会用另一种说法记住。');
  assert.deepEqual(repo.observe('miyue', [originalRows[0], alternateReply]), []);
  assert.equal(repo.list('miyue', { status: 'active' }).length, 0);
  assert.throws(() => repo.remember('miyue', [originalRows[0].id, alternateReply.id]), { code: 'INVALID_EPISODIC_MEMORY' });
  const restored = repo.remember('miyue', originalRows.map(({ id }) => id), '银色票根');
  assert.equal(restored.id, removed.id);
  assert.equal(restored.status, 'active');
});

test('the newest overlapping correction is effective without deleting older corrections', (t) => {
  const { store, repo } = fixture(t);
  const firstRows = turn(store, 'zhixia', '我喜欢星期二去旧书店。', '我建议星期二下午去，那里更安静。');
  const first = repo.observe('zhixia', firstRows)[0];
  const alternateReply = store.addAssistantMessage('zhixia', '我会把星期二旧书店当成这个偏好的依据。');
  const second = repo.remember('zhixia', [firstRows[0].id, alternateReply.id], '旧书店');
  repo.correct('zhixia', first.id, '用户更正：现在只在星期四去旧书店。');
  assert.deepEqual(repo.retrieve('zhixia', '旧书店星期几去？').map(({ id }) => id), [first.id]);
  assert.equal(repo.context([second], 'zhixia'), '');
  assert.equal(repo.list('zhixia').find(({ id }) => id === second.id).suppressed, true);
  repo.correct('zhixia', second.id, '用户再次更正：以后改为星期六去旧书店。');
  assert.deepEqual(repo.retrieve('zhixia', '旧书店星期几去？').map(({ id }) => id), [second.id]);
  const listed = repo.list('zhixia');
  assert.match(listed.find(({ id }) => id === first.id).correction, /星期四/);
  assert.match(listed.find(({ id }) => id === second.id).correction, /星期六/);
});

test('context can enforce an explicit scope when given mixed entry ids', (t) => {
  const { store, repo } = fixture(t);
  const miyue = repo.observe('miyue', turn(store, 'miyue', '我喜欢月白色的信封。', '我建议把信放进月白色信封。'))[0];
  const wenxi = repo.observe('wenxi', turn(store, 'wenxi', '我喜欢深蓝色的资料夹。', '我建议用深蓝色资料夹收材料。'))[0];
  const context = repo.context([miyue, wenxi], 'miyue');
  assert.match(context, new RegExp(miyue.quotes[0].id));
  assert.doesNotMatch(context, new RegExp(wenxi.quotes[0].id));
  assert.doesNotMatch(context, /深蓝色资料夹/);
});
