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
 const selected=memory.select();assert.ok(selected);assert.match(selected.context,/user-1\/reply-1/);assert.match(selected.summary,/拥抱.*安心/);
 assert.equal(memory.select({suppressedSourceIds:['user-1']}),null);
 assert.deepEqual(memory.issues(selected,'今天也想你。'),['missing_closeness_callback']);
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
