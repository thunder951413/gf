import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { collectConversationMemory, retrieveConversationMemory, prepareConversationMemoryCandidates, focusMemoryAnswerMessages } from '../lib/conversation-memory.mjs';

function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, role TEXT NOT NULL, speaker TEXT NOT NULL,
      text TEXT NOT NULL, kind TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE recall_state (role_id TEXT PRIMARY KEY, summary TEXT, summary_origin TEXT);
    CREATE VIEW recall_messages AS
      SELECT rowid,id,role,speaker,text,kind,created_at FROM messages;
  `);
  const state = { suppressed: new Set(), consolidated: [], episodes: [], edits: new Map() };
  const store = { db };
  const recallRepo = { consolidated: { snapshot: () => ({ items: state.consolidated }) } };
  const episodes = {
    suppressedSourceIds: () => [...state.suppressed],
    list: () => state.episodes,
  };
  const historyEdits = {
    project: (_scope, rows) => rows.map(row => state.edits.has(row.id) ? { ...row, text: state.edits.get(row.id) } : row),
  };
  const add = ({ id, role = 'miyue', speaker = 'user', text, kind = 'chat', at = '2026-09-12T04:00:00.000Z' }) => {
    db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)')
      .run(id, role, speaker, text, kind, at);
  };
  const args = (extra = {}) => ({ store, recallRepo, episodes, historyEdits, scope: 'miyue', now: '2026-09-16T00:00:00.000Z', ...extra });
  return { db, state, add, args };
}

test('an identified current exchange skips incidental old matches while explicit recall still retrieves them',t=>{
  const f=fixture();t.after(()=>f.db.close());
  f.add({id:'old',text:'我觉得你说的很对，健身要考虑多个因素。'});
  f.add({id:'focus',speaker:'assistant',text:'眼前的话题是一个结果可能有多种原因。'});
  const input={text:'我觉得你说的很对，多个因素在影响',preferCurrentExchange:true,conversation:[{id:'focus',speaker:'assistant'}],semantic:{intent:'respond',continuity:'continue',focusMessageId:'focus',retrievalQuery:'',memoryIds:[]}};
  const local=retrieveConversationMemory(f.args(input));assert.equal(local.selected.length,0);assert.ok(local.rejected.some(row=>row.id==='raw:old'&&row.reason==='current-focus-no-extra-memory'));
  const recall=retrieveConversationMemory(f.args({...input,semantic:{...input.semantic,intent:'recall'}}));assert.ok(recall.selected.some(row=>row.id==='raw:old'));
  const query=retrieveConversationMemory(f.args({...input,semantic:{...input.semantic,retrievalQuery:'健身'}}));assert.ok(query.selected.some(row=>row.id==='raw:old'));
  const chosen=retrieveConversationMemory(f.args({...input,semantic:{...input.semantic,memoryIds:['raw:old']}}));assert.ok(chosen.selected.some(row=>row.id==='raw:old'));
});

test('factual recall keeps history and boundaries while omitting unrelated creative life instructions',()=>{
  const messages=[{role:'system',content:'可以创作新的虚构经历。'},
    {role:'user',content:'【历史资料】她之前说不要亲昵。'},
    {role:'user',content:'【本轮检索到的记忆】日期与更正。'},
    {role:'user',content:'【本轮背景开始】今天酒馆中，可补充虚构阅读经历。\n【当前关系事实（均有来源）】\n当前明确保持朋友距离。\n【其他背景】\n无关活动。'},
    {role:'assistant',content:'最近原话。'},{role:'user',content:'那东西是我送给谁的？'}];
  const result=focusMemoryAnswerMessages(messages);
  assert.equal(result.filter(item=>item.role==='system').length,1);
  assert.doesNotMatch(JSON.stringify(result),/酒馆|创作新的虚构|虚构阅读/);
  for(const content of ['她之前说不要亲昵','日期与更正','最近原话','当前明确保持朋友距离'])assert.ok(JSON.stringify(result).includes(content));
  assert.equal(result.at(-1).content,messages.at(-1).content);
  assert.equal(messages[0].content,'可以创作新的虚构经历。');
});

test('semantic catalogue includes related newer state even when only the older wording matches the question',t=>{
  const f=fixture();t.after(()=>f.db.close());
  f.add({id:'before',text:'阳台薄荷快枯了，准备换盆。',at:'2026-08-20T01:00:00Z'});
  f.add({id:'after',text:'薄荷已经换盆，冒了三片新叶。',at:'2026-09-15T01:00:00Z'});
  for(let i=0;i<30;i++)f.add({id:`d${i}`,text:`无关档案${i}。`,at:'2026-09-15T02:00:00Z'});
  const result=prepareConversationMemoryCandidates(f.args({text:'阳台那株香草怎么样？',conversation:[{id:'after'}]}));
  assert.ok(result.some(item=>item.id==='raw:before'));
  assert.ok(result.some(item=>item.id==='raw:after'));
  assert.ok(result.length<=24);assert.ok(result.reduce((sum,item)=>sum+item.text.length,0)<=5000);
});

test('semantic catalogue uses the same suppression and edited-history projection as final retrieval',t=>{
  const f=fixture();t.after(()=>f.db.close());
  f.add({id:'hidden',text:'隐藏的金色钟表。'});f.state.suppressed.add('hidden');
  f.add({id:'edited',speaker:'assistant',text:'保留的银色钟表。错误黑色钟表。'});
  f.state.edits.set('edited','保留的银色钟表。');
  const result=prepareConversationMemoryCandidates(f.args({text:'钟表是什么颜色？'}));
  assert.doesNotMatch(JSON.stringify(result),/金色|黑色/);assert.match(JSON.stringify(result),/银色/);
});

test('an interaction preference does not reactivate its rejected old subject through query expansion',t=>{
  const f=fixture();t.after(()=>f.db.close());f.add({id:'old-run',text:'半马训练中途退赛让我很难受。'});
  const result=retrieveConversationMemory(f.args({text:'别再提跑步了，我想聊电影。',semantic:{intent:'preference',retrievalQuery:'半马 训练 退赛 电影',memoryIds:['raw:old-run']}}));
  assert.equal(result.context,'');assert.equal(result.selected.length,0);
  assert.ok(result.rejected.some(item=>item.id==='raw:old-run'&&item.reason==='semantic-unrelated'));
});

test('suppressed and history-edited sources cannot reappear through raw or consolidated candidates', t => {
  const f = fixture(); t.after(() => f.db.close());
  f.add({ id: 'suppressed', text: '用户喜欢旧咖啡店。' });
  f.add({ id: 'edited-away', speaker: 'assistant', text: '角色曾说要去旧书店。' });
  f.state.suppressed.add('suppressed');
  f.state.edits.set('edited-away', '');
  f.state.consolidated.push(
    { id: 'from-suppressed', subject: 'user', kind: 'preference', topic: '咖啡店', summary: '用户喜欢旧咖啡店。', status: 'current', lastAt: '2026-09-12T04:00:00Z', evidence: [{ messageId: 'suppressed', quote: '旧咖啡店' }] },
    { id: 'from-edit', subject: 'character', kind: 'event', topic: '旧书店', summary: '角色要去旧书店。', status: 'ongoing', lastAt: '2026-09-12T04:00:00Z', evidence: [{ messageId: 'edited-away', quote: '旧书店' }] },
  );
  assert.deepEqual(collectConversationMemory(f.args()), []);
});

test('only consolidated entries with literal visible quotes survive, including cancelled facts', t => {
  const f = fixture(); t.after(() => f.db.close());
  f.add({ id: 'trip', text: '杭州旅行已经取消了。' });
  f.state.consolidated.push(
    { id: 'valid', subject: 'user', kind: 'event', topic: '杭州旅行', summary: '用户取消了杭州旅行。', status: 'cancelled', lastAt: '2026-09-12T04:00:00Z', evidence: [{ messageId: 'trip', quote: '旅行已经取消' }] },
    { id: 'forged', subject: 'user', kind: 'event', topic: '杭州旅行', summary: '用户改去苏州。', status: 'current', lastAt: '2026-09-12T04:00:00Z', evidence: [{ messageId: 'trip', quote: '改去苏州' }] },
  );
  const candidates = collectConversationMemory(f.args());
  assert.ok(candidates.some(item => item.id === 'consolidated:valid' && item.status === 'cancelled'));
  assert.ok(!candidates.some(item => item.id === 'consolidated:forged'));
  const result = retrieveConversationMemory(f.args({ text: '杭州旅行后来怎么样？' }));
  assert.equal(result.selected[0].id, 'consolidated:valid');
  assert.match(result.context, /取消了杭州旅行/);
  assert.doesNotMatch(result.context, /改去苏州/);
});

test('a user-approved episode correction supersedes its raw source without replaying obsolete wording', t => {
  const f = fixture(); t.after(() => f.db.close());
  f.add({ id: 'drink', text: '我最喜欢红茶。' });
  f.state.episodes.push({
    id: 'episode-drink', corrected: true, correction: '用户更正：现在最喜欢黑咖啡。', correctedAt: '2026-09-15T00:00:00Z',
    createdAt: '2026-09-12T04:00:00Z', pinned: true, suppressed: false, label: '饮料偏好',
    quotes: [{ id: 'drink', speaker: 'user', text: '我最喜欢红茶。' }],
  });
  const result = retrieveConversationMemory(f.args({ text: '我现在最喜欢喝什么？' }));
  assert.deepEqual(result.selected.map(item => item.id), ['episode-drink']);
  assert.match(result.context, /黑咖啡/);
  assert.doesNotMatch(result.context, /最喜欢红茶/);
});

test('raw candidates retain mechanical relative-date annotations from their source time', t => {
  const f = fixture(); t.after(() => f.db.close());
  f.add({ id: 'relative', text: '明天中午去汕头。', at: '2026-09-12T04:00:00.000Z' });
  const candidate = collectConversationMemory(f.args()).find(item => item.id === 'raw:relative');
  assert.match(candidate.dateContext, /“明天”.*2026-09-13（星期日）/);
  const result = retrieveConversationMemory(f.args({ text: '汕头什么时候去？' }));
  assert.match(result.context, /机械日期定位[\s\S]*2026-09-13/);
});

test('wrong-role, story, future, and pre-cutoff assistant rows never become candidates', t => {
  const f = fixture(); t.after(() => f.db.close());
  f.add({ id: 'other-role', role: 'other', text: '另一角色的私密事实。' });
  f.add({ id: 'story', text: '故事里的虚构事件。', kind: 'story' });
  f.add({ id: 'old-assistant', speaker: 'assistant', text: '旧人设样板。' });
  const cutoff = f.db.prepare('SELECT rowid FROM messages WHERE id=?').get('old-assistant').rowid;
  f.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run('persona_cutoff:miyue', String(cutoff));
  f.add({ id: 'future', text: '未来才会知道的消息。', at: '2026-09-20T00:00:00Z' });
  f.add({ id: 'visible', text: '用户喜欢蓝莓。' });
  assert.deepEqual(collectConversationMemory(f.args()).map(item => item.id), ['raw:visible']);
});

test('manual authoritative memory remains complete beyond the ordinary 6000-character retrieval budget', t => {
  const f = fixture(); t.after(() => f.db.close());
  const manual = `用户手动更正：${'边界内容。'.repeat(1300)}`;
  f.db.prepare('INSERT INTO recall_state(role_id,summary,summary_origin) VALUES(?,?,?)').run('miyue', manual, 'manual');
  const result = retrieveConversationMemory(f.args({ text: '边界', budgetChars: 6000 }));
  assert.match(result.context, /用户手动修订的记忆/);
  assert.ok(result.context.includes(manual));
  assert.equal(result.stats.manualChars, `【用户手动修订的记忆｜引用资料】\n${manual}`.length);
  assert.ok(result.stats.totalChars > 6000);
});

test('2000 medium Chinese rows collect and retrieve with measured runtime only', t => {
  const f = fixture(); t.after(() => f.db.close());
  const insert = f.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)');
  f.db.exec('BEGIN');
  for (let index = 0; index < 2000; index += 1) {
    insert.run(`bulk-${index}`, 'miyue', 'user', `第${index}条生活记录，包含散步、读书和晚餐的中等长度中文描述。`, 'chat', '2026-09-12T04:00:00.000Z');
  }
  f.db.exec('COMMIT');
  const started = performance.now();
  const result = retrieveConversationMemory(f.args({ text: '第1999条晚餐记录' }));
  const elapsed = performance.now() - started;
  t.diagnostic(`2000-candidate retrieval: ${elapsed.toFixed(1)}ms`);
  assert.ok(result.selected.some(item => item.id === 'raw:bulk-1999'));
});

test('factual history projection retains the resolved referent and retired progress but drops ambient activity',()=>{
 const rows=[{role:'system',content:'persona'},{role:'user',content:'【本轮背景开始】\n【当前活动】在看另一部电影。\n【已收起的阅读/观影，仅供本轮明确回顾】\n旧书停在第二段，没有读完。\n【本轮语义定位的历史原话，仅作引用】{"speaker":"林晓薇","text":"刚才谈的是睡眠，不是旧书。"}\n【本轮背景结束】'},{role:'user',content:'这个还有什么细节？'}];
 const text=JSON.stringify(focusMemoryAnswerMessages(rows));
 assert.match(text,/刚才谈的是睡眠/);assert.match(text,/旧书停在第二段/);assert.doesNotMatch(text,/在看另一部电影/);
});


test('self-contained affection does not retrieve old routines from incidental words, while chosen evidence and boundaries survive',t=>{
  const f=fixture();t.after(()=>f.db.close());
  f.add({id:'old',speaker:'assistant',text:'刚忙完坐下来，拿起速写本画画。'});
  f.add({id:'boundary',text:'不要叫我宝贝。'});
  f.state.consolidated.push({id:'boundary-rule',subject:'user',kind:'boundary',topic:'称呼',summary:'用户不喜欢宝贝这个称呼。',status:'current',lastAt:'2026-09-12T04:00:00Z',evidence:[{messageId:'boundary',quote:'不要叫我宝贝'}]});
  const input={text:'刚忙完坐下来，想你了',preferCurrentExchange:true,semantic:{intent:'affection',continuity:'new',focusMessageId:null,retrievalQuery:'',memoryIds:[]}};
  const result=retrieveConversationMemory(f.args(input));
  assert.ok(!result.selected.some(x=>x.id==='raw:old'));
  assert.ok(result.selected.some(x=>x.id==='consolidated:boundary-rule'));
  const chosen=retrieveConversationMemory(f.args({...input,semantic:{...input.semantic,memoryIds:['raw:old']}}));
  assert.ok(chosen.selected.some(x=>x.id==='raw:old'));
  const fallback=retrieveConversationMemory(f.args({...input,semantic:null}));
  assert.ok(fallback.selected.some(x=>x.id==='raw:old'));
  const share=retrieveConversationMemory(f.args({...input,semantic:{...input.semantic,intent:'share'}}));
  assert.ok(share.selected.some(x=>x.id==='raw:old'));
});
