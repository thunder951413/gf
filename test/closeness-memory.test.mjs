import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {ClosenessMemory} from '../lib/closeness-memory.mjs';

test('closeness memories retain source links, import idempotently, obey suppression/deletion and callback cooldown',()=>{
 let now=new Date('2026-09-10T10:00:00Z');
 const rows=[{id:'user-1',role:'miyue',speaker:'user',text:'抱抱你。',createdAt:'2026-09-09T10:00:00Z'},{id:'reply-1',role:'miyue',speaker:'assistant',text:'隔着聊天给你一个拥抱，这会儿很安心。',createdAt:'2026-09-09T10:00:01Z'}];
 const store={db:new DatabaseSync(':memory:'),getMessages:()=>rows,getMessage:id=>rows.find(row=>row.id===id),transaction:fn=>fn()};
 const memory=new ClosenessMemory(store,{clock:()=>now});
 new ClosenessMemory(store,{clock:()=>now});assert.equal(store.db.prepare('SELECT COUNT(*) n FROM closeness_moments').get().n,1);
 const selected=memory.select({purpose:'support'});assert.ok(selected);assert.match(selected.context,/user-1\/reply-1/);assert.match(selected.summary,/拥抱.*安心/);
 assert.equal(memory.select({suppressedSourceIds:['user-1']}),null);
 assert.equal(memory.markRecalled(selected,'今天也想你。'),false);
 assert.equal(memory.markRecalled(selected,'还记得上次聊起拥抱的安心。'),true);
 assert.equal(memory.select(),null);
 now=new Date(+now+12*3600000);assert.ok(memory.select());
 rows.pop();assert.equal(memory.select(),null,'deleted source is never recalled');store.db.close();
});

test('quotes, refusals and the other role do not become shared closeness events',()=>{
 const store={db:new DatabaseSync(':memory:'),getMessages:()=>[],getMessage:()=>null,transaction:fn=>fn()};
 const memory=new ClosenessMemory(store);
 for(const [text,role] of [['不要抱我','miyue'],['小说里她说抱抱你','miyue'],['抱抱你','wenxi']]){
   assert.equal(memory.observe([{id:'u',role,speaker:'user',text},{id:'a',role,speaker:'assistant',text:'想给你拥抱，觉得安心。'}]),false);
 }
 assert.equal(store.db.prepare('SELECT COUNT(*) n FROM closeness_moments').get().n,0);store.db.close();
});

test('old summary rows recover real details and distinguish expectations, without another model or migration',()=>{
 const rows=[{id:'u',role:'miyue',speaker:'user',text:'抱抱你，先靠着我歇一会儿。下次也想这样陪着你。',createdAt:'2026-09-09T10:00:00Z'},
 {id:'a',role:'miyue',speaker:'assistant',text:'抱着你时，听见你说不用急着讲话，我觉得很踏实。下次想靠着你听完一首歌。',createdAt:'2026-09-09T10:00:01Z'}];
 const store={db:new DatabaseSync(':memory:'),getMessages:()=>rows,getMessage:id=>rows.find(row=>row.id===id),transaction:fn=>fn()};
 const memory=new ClosenessMemory(store,{clock:()=>new Date('2026-09-10T10:00:00Z')});
 const selected=memory.select();
 assert.equal(selected.userQuote,rows[0].text);assert.equal(selected.replyQuote,rows[1].text);
 assert.ok(selected.feelings.some(x=>x.includes('不用急着讲话')));
 assert.ok(selected.expectations.some(x=>x.text.includes('听完一首歌')&&x.speaker==='林晓薇'));
 assert.match(selected.context,/尚未确认实现的期待/);assert.doesNotMatch(selected.context,/本轮用一句/);
 memory.projectSource=row=>row.speaker==='assistant'?null:row;
 assert.equal(memory.select(),null,'pruned replies cannot reenter from a stored label');
 store.db.close();
});

test('unsolicited callbacks rotate only after cooldown; explicit recall chooses requested kind',()=>{
 const now=new Date('2026-09-12T10:00:00Z'),rows=[];
 for(const [id,text,reply] of [['old','抱抱你。','抱着你，觉得安心。'],['new','亲亲你。','想亲吻你，心里开心。']])rows.push({id:'u'+id,role:'miyue',speaker:'user',text,createdAt:'2026-09-10T10:00:00Z'},{id:'a'+id,role:'miyue',speaker:'assistant',text:reply,createdAt:'2026-09-10T10:00:01Z'});
 const store={db:new DatabaseSync(':memory:'),getMessages:()=>rows,getMessage:id=>rows.find(row=>row.id===id),transaction:fn=>fn()};
 const memory=new ClosenessMemory(store,{clock:()=>now});
 const first=memory.select();assert.equal(first.kind,'接吻');memory.markRecalled(first,'想起上次说的亲吻。');
 assert.equal(memory.select(),null);assert.equal(memory.select({explicit:true,text:'上次抱抱'}).kind,'拥抱');
 now.setHours(now.getHours()+13);assert.equal(memory.select().kind,'拥抱');store.db.close();
});

test('support memories preserve chat-expression provenance without requiring a reminiscence',()=>{
 const rows=[{id:'u',role:'miyue',speaker:'user',text:'突然想抱抱你。',createdAt:'2026-09-09T10:00:00Z'},
 {id:'a',role:'miyue',speaker:'assistant',text:'要是能抱着，我会觉得安心，还想多待一会儿。',createdAt:'2026-09-09T10:00:01Z'}];
 const store={db:new DatabaseSync(':memory:'),getMessages:()=>rows,getMessage:id=>rows.find(row=>row.id===id),transaction:fn=>fn()};
 const memory=new ClosenessMemory(store,{clock:()=>new Date('2026-09-10T10:00:00Z')});
 const support=memory.select({purpose:'support'});
 assert.equal(support.eventType,'chat_expression');assert.equal(memory.material(support),null);
 assert.match(support.context,/属于当时的想象/);assert.equal(support.replyQuote,rows[1].text);
 assert.equal(memory.markRecalled(support,'有点想你，想多听听你的声音。'),false);
 assert.equal(store.db.prepare('SELECT recalled_at FROM closeness_moments').get().recalled_at,null);
 assert.equal(memory.markRecalled(support,'想起上次聊抱抱的那句话，今天也想多陪你。'),true);
 assert.equal(memory.select({purpose:'support'}),null,'only an actual callback starts recall cooldown');
 const recall=memory.select({explicit:true,text:'你记得上次抱抱吗？'});
 assert.equal(memory.material(recall).title,'聊起拥抱的那段对话');
 assert.equal(memory.markRecalled(recall,'记得，先想靠近，接着才有点紧张。'),true,'a valid feeling callback need not repeat 抱/安心/踏实');
 assert.equal(memory.material(memory.select({explicit:true,purpose:'expectation'})).kind,'closeness');
 store.db.close();
});
