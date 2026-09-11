import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { DailyLife, dailyLifeContext } from '../lib/daily-life.mjs';

class Store { constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec('CREATE TABLE messages(id TEXT PRIMARY KEY,role TEXT,speaker TEXT,text TEXT)'); } transaction(fn) { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (error) { this.db.exec('ROLLBACK'); throw error; } } getMessage(id) { return this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) || null; } message(id,speaker,text) { this.db.prepare('INSERT INTO messages VALUES(?,?,?,?)').run(id,'miyue',speaker,text); return this.getMessage(id); } }
const phases = (first, tail) => [{ id: 'doing', label: '正在做', durationMs: first, detail: '正在准备，事情还没有完成。' }, { id: 'recent', label: '最近的事', durationMs: tail, detail: '事情已经告一段落，留下了一点余味。' }];
const catalog = { items: [
  { id: 'nails', kind: 'manicure', title: '换一款指甲', location: '店里', choice:{key:'color',label:'颜色',options:['浅蓝','豆沙'],default:'豆沙',editablePhases:['doing']}, phases: [{...phases(3600000, 7 * 86400000 - 3600000)[0],detail:'正在做{{choice}}色指甲。'},{...phases(3600000, 7 * 86400000 - 3600000)[1],detail:'{{choice}}色在光下很好看。'}] },
  { id: 'shop', kind: 'shopping', title: '挑杯子', location: '苏州的家中', phases: [{ id: 'browsing', label: '在挑选', durationMs: 600000, detail: '正在比较两个釉色。' }, { id: 'waiting', label: '等送达', durationMs: 3600000, detail: '包裹还在路上。' }, { id: 'arrived', label: '刚收到', durationMs: 3600000, detail: '杯子刚送到。' }, { id: 'recent', label: '最近的事', durationMs: 3600000, detail: '新杯子放在桌上。' }] },
  { id: 'cat', kind: 'pet', title: '遇见猫', location: '小区', phases: phases(600000, 3600000) },
  { id: 'chat', kind: 'friend_chat', title: '和朋友聊天', location: '苏州的家中', phases: phases(600000, 3600000) },
  { id: 'cook', kind: 'cooking', title: '烤司康', location: '苏州的家中厨房', phases: phases(600000, 3600000) }
] };
function home(endsAt) { return { kind: 'reading', title: '读书休息', location: '苏州的家中', ...(endsAt ? { endsAt } : {}) }; }
function harness(at = '2026-01-01T12:30:00.000Z', random = () => .01) { let now = new Date(at); const store = new Store(); return { store, set(value) { now = new Date(value); }, engine: new DailyLife(store, { clock: () => now, random, catalog }) }; } // 20:30 Shanghai

test('Shanghai evening seed and manicure expires exactly seven days from start', () => {
  const h = harness(); const event = h.engine.advance({ current: home() }).events[0]; assert.equal(event.phase, 'doing'); assert.equal(event.foreground, true);
  h.set('2026-01-01T13:30:00.000Z'); assert.equal(h.engine.advance({ current: home() }).events[0].phase, 'recent');
  h.set('2026-01-08T12:29:59.999Z'); assert.ok(h.engine.advance({ current: home() }).events.some(e => e.kind === 'manicure'));
  h.set('2026-01-08T12:30:00.000Z'); assert.equal(h.engine.advance({ current: home() }).events.some(e => e.kind === 'manicure'), false);
});
test('generic catalog phases provide truthful shopping states', () => {
  const onlyShop = { items: [catalog.items[1]] }; let now = new Date('2026-01-01T12:30:00Z'); const engine = new DailyLife(new Store(), { clock: () => now, random: () => 0, catalog: onlyShop });
  let view = engine.advance({ current: home() }); assert.equal(view.events[0].phase, 'browsing'); assert.match(view.events[0].detail, /比较/);
  now = new Date('2026-01-01T12:40:00Z'); assert.equal(engine.advance({ current: home() }).events[0].phase, 'waiting');
  now = new Date('2026-01-01T13:40:00Z'); assert.equal(engine.advance({ current: home() }).events[0].phase, 'arrived');
});
test('restart and repeated polling do not reroll or alter semantic revision', () => {
  let calls = 0; const h = harness(undefined, () => { calls++; return .01; }); const one = h.engine.advance({ current: home() }); const used = calls; const repeat = h.engine.advance({ current: home() }); assert.equal(repeat.revision, one.revision); assert.equal(calls, used);
  const restored = new DailyLife(h.store, { clock: () => new Date('2026-01-01T12:30:00Z'), random: () => { throw new Error('rerolled'); }, catalog }); assert.equal(restored.advance({ current: home() }).events[0].id, one.events[0].id);
});
test('work, sleep, appointment and travel suppress foreground and consume a due attempt once', () => {
  for (const current of [{ working: true }, { sleeping: true }, { appointment: true }]) { const h = harness(); assert.equal(h.engine.advance({ current }).events.length, 0); }
  const h = harness(); assert.equal(h.engine.advance({ current: home(), travel: true }).events.length, 0); assert.equal(h.engine.advance({ current: home(), travel: true }).events.length, 0);
  const running = harness(); running.engine.advance({ current: home() }); assert.equal(running.engine.advance({ current: { working: true } }).events[0].phase, 'paused'); assert.equal(running.engine.advance({ current: { working: true } }).events[0].foreground, false);
});
test('a supplied agenda bounds the foreground phase and no second foreground action starts', () => {
  const h = harness(); const view = h.engine.advance({ current: home('2026-01-01T12:45:00Z') }); assert.equal(view.events[0].endsAt, '2026-01-01T12:45:00.000Z'); assert.equal(view.events.filter(e => e.foreground).length, 1);
});
test('an existing foreground event remains foreground in its final five minutes', () => {
  const h = harness(); h.engine.advance({ current: home() }); h.set('2026-01-01T13:25:00Z'); const view = h.engine.advance({ current: home('2026-01-01T13:30:00Z') }); assert.equal(view.events[0].foreground, true); assert.equal(view.events[0].phase, 'doing');
});
test('a blocked first seed is consumed for that Shanghai day and does not reroll later', () => {
  let draws = 0; const h = harness(undefined, () => { draws++; return .01; }); assert.equal(h.engine.advance({ current: { working: true } }).events.length, 0); const afterBlocked = draws; assert.equal(h.engine.advance({ current: home() }).events.length, 0); assert.equal(draws, afterBlocked);
});
test('offline days have no replay storm; thirty evenings stay bounded and diverse', () => {
  const h = harness(); h.engine.advance({ current: home() }); h.set('2026-01-30T12:30:00Z'); assert.ok(h.engine.advance({ current: home() }).events.length <= 2);
  const simulation = harness(); const kinds = new Set(); for (let day = 1; day <= 30; day++) { simulation.set(`2026-01-${String(day).padStart(2, '0')}T12:30:00Z`); const view = simulation.engine.advance({ current: home() }); view.events.forEach(e => kinds.add(e.kind)); assert.ok(view.events.length <= 6); assert.equal(new Set(view.events.map(e => e.kind)).size, view.events.length); } assert.ok(kinds.size >= 4); assert.ok(dailyLifeContext(simulation.engine.advance({ current: home() }), { opening: true }).length <= 1800);
});

test('expired subscription sources are not picked again after restart with a replacement content id', () => {
  const store=new Store();let now=new Date('2026-01-01T12:30:00Z'),id='original',reads=0;
  const options={clock:()=>now,random:()=>.999,catalog,getSources:()=>{reads++;return [{id,title:'社区书店的新年阅读角',url:'https://example.com/books',publishedAt:'2026-01-01T10:00:00Z',summary:'社区书店布置了一个新的阅读角，来借书的人可以留下简短的阅读感想，大家交换自己喜欢的段落和插画，也可以安静地读一会儿。店主希望这里能成为附近居民散步时愿意停留的地方。'}];}};
  const engine=new DailyLife(store,options);assert.equal(engine.advance({current:home()}).events[0].kind,'article');
  engine.advance({current:home()});assert.equal(reads,1,'polls do not rescan subscriptions');
  now=new Date('2026-01-05T13:59:00Z');id='replacement';
  const restored=new DailyLife(store,options);
  assert.ok(restored.advance({current:home()}).events.every(event=>event.kind!=='article'),'canonical URL exclusion survives expiry and restart');
});

test('maximal event context keeps complete quoted JSON and closing guidance within budget',()=>{
  const events=Array.from({length:6},(_,i)=>({title:'事件'+i+'很长的背景'.repeat(30),phaseLabel:'最近',detail:'详细内容'.repeat(50),startedAt:'2026-01-01T12:30:00Z',endsAt:'2026-01-08T12:30:00Z'}));
  events[0].source={title:'书'.repeat(100),source:'刊'.repeat(80),url:'https://example.com/'+ 'a'.repeat(220),excerpt:'"\\'.repeat(210),publishedAt:'2026-01-01T10:00:00Z'};
  const context=dailyLifeContext({events},{opening:true});
  assert.ok(context.length<=1800);
  const json=context.split('\n').find(line=>line.startsWith('{'));
  assert.equal(JSON.parse(json).url,events[0].source.url);
  assert.ok(context.endsWith('没做过的事情只能说有兴趣或想尝试。'));
});

test('verified saved choice updates every phase template, survives restart, and is idempotent',()=>{
  const h=harness(); let view=h.engine.advance({current:home()}); const event=view.events[0]; const u=h.store.message('choice-u','user','我选浅蓝。'); const a=h.store.message('choice-a','assistant','好，就选浅蓝。');
  const candidate={eventId:event.id,action:'choose',value:'浅蓝',evidence:'选浅蓝',responseEvidence:'选浅蓝',userMessageId:u.id,assistantMessageId:a.id};
  let result=h.engine.observe([u,a],[candidate],{expectedRevision:view.revision}); assert.equal(result.accepted.length,1); view=h.engine.advance({current:home()}); assert.equal(view.events[0].choice.selected,'浅蓝'); assert.match(view.events[0].detail,/浅蓝/); assert.match(dailyLifeContext(view),new RegExp(event.id));
  assert.equal(h.engine.observe([u,a],[candidate],{expectedRevision:view.revision}).accepted.length,0);
  h.set('2026-01-01T13:30:00Z'); assert.match(h.engine.advance({current:home()}).events[0].detail,/浅蓝/);
  const restarted=new DailyLife(h.store,{clock:()=>new Date('2026-01-01T13:30:00Z'),catalog,random:()=>.5}); assert.equal(restarted.advance({current:home()}).events[0].choice.selected,'浅蓝');
});
test('choice rejects fabricated, negated, unknown, expired, and stale candidates; fallback requires explicit agreement',()=>{
  const h=harness(); let view=h.engine.advance({current:home()}), event=view.events[0]; const u=h.store.message('u','user','不要浅蓝，我不选它。'); const a=h.store.message('a','assistant','那就不选浅蓝。');
  let r=h.engine.observe([u,a],[{eventId:event.id,action:'choose',value:'浅蓝',evidence:'不要浅蓝',responseEvidence:'不选浅蓝',userMessageId:u.id,assistantMessageId:a.id}],{expectedRevision:view.revision}); assert.equal(r.accepted.length,0);
  r=h.engine.observe([{id:'fake',role:'miyue',speaker:'user',text:'我选浅蓝' },a],[{eventId:event.id,action:'choose',value:'浅蓝',evidence:'选浅蓝',responseEvidence:'浅蓝'}],{expectedRevision:view.revision}); assert.equal(r.accepted.length,0);
  r=h.engine.observe([u,a],[{eventId:event.id,action:'bad',value:'浅蓝',evidence:'浅蓝',responseEvidence:'浅蓝'}],{expectedRevision:view.revision+1}); assert.equal(r.rejected[0].reason,'stale_revision');
  const yes=h.store.message('yes','user','选浅蓝吧'); const agree=h.store.message('agree','assistant','好，就选浅蓝。'); r=h.engine.observe([yes,agree],[],{expectedRevision:view.revision}); assert.equal(r.accepted.length,1);
  h.set('2026-01-01T13:30:00Z'); view=h.engine.advance({current:home()}); r=h.engine.observe([yes,agree],[{eventId:event.id,action:'choose',value:'豆沙',evidence:'选浅蓝',responseEvidence:'选浅蓝'}],{expectedRevision:view.revision}); assert.equal(r.accepted.length,0); assert.equal(r.rejected[0].reason,'not_editable');
});
test('choice validates full saved wording, adopts the default, and rejects unknown manual fields',()=>{
  const h=harness(); const first=h.engine.advance({current:home()}), event=first.events[0]; const hostileU=h.store.message('hostile-u','user','不要选浅蓝，还是豆沙。'); const hostileA=h.store.message('hostile-a','assistant','好，就选浅蓝。');
  let r=h.engine.observe([hostileU,hostileA],[{eventId:event.id,action:'choose',value:'浅蓝',evidence:'选浅蓝',responseEvidence:'选浅蓝',userMessageId:hostileU.id,assistantMessageId:hostileA.id}],{expectedRevision:first.revision}); assert.equal(r.accepted.length,0);
  const u=h.store.message('default-u','user','我决定选豆沙。'), a=h.store.message('default-a','assistant','好，就选豆沙。'); r=h.engine.observe([u,a],[{eventId:event.id,action:'choose',value:'豆沙',evidence:'选豆沙',responseEvidence:'选豆沙',userMessageId:u.id,assistantMessageId:a.id,unexpected:true}],{expectedRevision:first.revision}); assert.equal(r.rejected[0].reason,'unknown_field');
  r=h.engine.observe([u,a],[],{expectedRevision:first.revision}); assert.equal(r.accepted.length,1); const adopted=h.engine.advance({current:home()}).events[0]; assert.equal(adopted.choice.adopted,true); assert.equal(adopted.choice.evidence,'我决定选豆沙。'); assert.throws(()=>h.engine.updateChoice({revision:adopted.instanceStartedAt,eventId:event.id,value:'浅蓝',extra:true}),{status:400});
});
test('SQLite receipt prevents an old saved reply from changing an event after restart',()=>{
  const h=harness(); const view=h.engine.advance({current:home()}), event=view.events[0],u=h.store.message('ledger-u','user','我选浅蓝。'),a=h.store.message('ledger-a','assistant','好，就选浅蓝。'); const c={eventId:event.id,action:'choose',value:'浅蓝',evidence:'选浅蓝',responseEvidence:'选浅蓝',userMessageId:u.id,assistantMessageId:a.id}; h.engine.observe([u,a],[c],{expectedRevision:view.revision}); const restarted=new DailyLife(h.store,{clock:()=>new Date('2026-01-01T12:30:00Z'),catalog,random:()=>.1}); const result=restarted.observe([u,a],[c],{expectedRevision:restarted.advance({current:home()}).revision}); assert.equal(result.rejected[0].reason,'duplicate');
});

test('a clear choice sentence is not lost because the reply later asks an unrelated question',()=>{
  const h=harness();const first=h.engine.advance({current:home()});
  const u=h.store.message('live-u','user','浅蓝好看，选浅蓝吧。');
  const a=h.store.message('live-a','assistant','行，那我听你的，改浅蓝。你眼光平时挺准的？今天过得怎么样？');
  assert.equal(h.engine.observe([u,a],[],{expectedRevision:first.revision}).accepted.length,1);
  assert.equal(h.engine.advance({current:home()}).events[0].choice.selected,'浅蓝');
});
