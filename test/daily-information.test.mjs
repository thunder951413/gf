import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { DailyInformation,INFORMATION_CATEGORIES } from '../lib/daily-information.mjs';
import { parsePageLinks,fetchPageLinks } from '../lib/integrations.mjs';
import { HistoryDeletion } from '../lib/history-deletion.mjs';
import { workCalendar } from '../lib/work-calendar.mjs';
const NOW=new Date('2026-10-06T04:30:00Z');
const source=(category='food')=>({id:category,title:category,category,url:`https://example.org/${category}/rss`,intervalMinutes:120});
function fixture(t,options={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'daily-info-'));let now=NOW;
 const store=new Store({dataDir:dir,initialFeeds:[],clock:()=>now,story:{start:'x',nodes:{x:{id:'x',choices:[]}}}});
 const info=new DailyInformation(store,{sources:[source()],clock:()=>now,...options});
 t.after(async()=>{await info.stop();store.close();fs.rmSync(dir,{recursive:true,force:true});});
 return {info,store,set:value=>now=new Date(value)};
}
const item=(title='番茄鸡蛋面',url='https://example.org/noodles')=>({title,url,summary:'家常午饭，食材简单。'.repeat(30),publishedAt:NOW.toISOString()});

test('collection persists only bounded hints, deduplicates canonical links and titles, and never reads details',async t=>{
 let feeds=0,details=0;const {info}=fixture(t,{fetchFeed:async()=>{feeds++;return {items:[item(),item('番茄鸡蛋面','https://example.org/noodles?utm_source=feed'),item('番茄鸡蛋面','https://other.example.org/same'),item('未来发布','https://example.org/future')]};},fetchArticle:async()=>{details++;throw Error();}});
 const result=await info.refresh();assert.equal(result.added,2);assert.equal(feeds,1);assert.equal(details,0);
 assert.ok(info.list().every(i=>i.brief.length<=160));assert.equal((await info.refresh()).added,0);assert.equal(feeds,1);
 await info.refresh({force:true});assert.equal(feeds,2);assert.equal(info.status().total,2);
});
test('one failing source does not block others and its persistent backoff does not retry every tick',async t=>{
 const calls=[];const {info,set}=fixture(t,{sources:[source(),source('film')],fetchFeed:async url=>{calls.push(url);if(url.includes('/food'))throw Error('暂不可用');return {items:[item('电影报道','https://example.org/film')]};}});
 const result=await info.refresh();assert.equal(result.added,1);assert.equal(result.errors.length,1);
 await info.refresh();assert.equal(calls.length,2);set(+NOW+16*60000);await info.refresh();assert.equal(calls.length,3);
 const status=info.status().sources.find(i=>i.id==='food');assert.equal(status.failures,2);assert.ok(status.next_at);
});
test('refresh coalesces and stopping an in-flight fetch never writes its late result',async t=>{
 let resolve;const {info}=fixture(t,{fetchFeed:()=>new Promise(r=>resolve=r)});
 const first=info.refresh();assert.equal(info.refresh({force:true}),first);const stop=info.stop();resolve({items:[item()]});await stop;await first;assert.equal(info.status().total,0);
});
test('candidate slate includes every available category within budget, gives meals food, and tracks actual delivered topics only',t=>{
 const categories=Object.keys(INFORMATION_CATEGORIES),{info,store}=fixture(t,{sources:categories.map(c=>source(c))});
 for(const category of categories)info.ingest(source(category),[item(`${category}新线索`,`https://example.org/${category}`),item(`${category}另一项`,`https://example.org/${category}-2`)]);
 const offered=info.slate({activity:{kind:'meal'}});assert.equal(offered[0].category,'food');assert.equal(new Set(offered.map(i=>i.category)).size,9);
 assert.ok(offered.reduce((n,i)=>n+JSON.stringify(i).length,0)<=4000);assert.equal(info.recent().length,0);
 const rows=store.saveChatTurn({role:'miyue',text:'午饭吃什么？',reply:'我想吃一碗热面。\n\n清爽一点，吃起来舒服。'});info.record(rows[1],offered[0].id);
 assert.equal(info.recent().length,1);assert.ok(!info.slate().some(i=>i.id===offered[0].id));
 new HistoryDeletion(store).delete('miyue',[rows[1].id]);assert.equal(info.recent().length,0);assert.equal(store.db.prepare('SELECT COUNT(*) n FROM daily_information_deliveries').get().n,0);
});
test('details are fetched on demand once, coalesced and cached with truthful scope',async t=>{
 let reads=0;const {info}=fixture(t,{fetchArticle:async()=>{reads++;return {text:'来源写明番茄、鸡蛋、面条，先炒番茄再加水煮面。'.repeat(120)};}});
 info.ingest(source(),[item()]);const id=info.list()[0].id;
 const results=await Promise.all([info.explore(`daily-info:${id}`),info.explore(id)]);assert.equal(reads,1);assert.equal(results[0].unknown,false);assert.ok(results[0].excerpt.length<=2200);
 assert.match(results[0].scope,/不保证全文/);assert.equal((await info.explore(id)).cached,true);assert.equal(reads,1);
});
test('failed detail fetch searches only the selected public title and never treats unavailable content as read',async t=>{
 const queries=[];const {info}=fixture(t,{fetchArticle:async()=>{throw Error('blocked');},search:async query=>{queries.push(query);return [];}});
 info.ingest(source(),[item()]);const detail=await info.explore(info.list()[0].id);assert.deepEqual(queries,['番茄鸡蛋面']);assert.equal(detail.unknown,true);assert.match(detail.scope,/细节未知/);assert.equal(info.status().details,0);
 assert.equal((await info.explore('完全无关的内容')).unknown,true);
});
test('category search uses program-owned public terms, persists only hints and never sends private query fragments',async t=>{
 const queries=[];const {info}=fixture(t,{search:async query=>{queries.push(query);return [{title:'正在播出的社区剧',url:'https://example.org/show',summary:'公开介绍'}];}});
 const result=await info.explore('search:series');assert.equal(result.unknown,false);assert.match(queries[0],/2026-10 正在播出的电视剧/);assert.equal(info.status().total,1);assert.equal(info.status().details,0);
 await info.explore('search:我的私人经历');assert.equal(queries.length,1);
});
test('on-demand category index reaches beyond leading news, stays bounded and does not read articles',async t=>{
 let reads=0;const {info}=fixture(t,{fetchArticle:async()=>{reads++;return {text:'详情'};}});
 const products=source('products');info.ingest(products,Array.from({length:40},(_,i)=>({...item(i===30?'新推出的轻量鼠标':`行业简讯第${i}条`,`https://example.org/product-${i}`),publishedAt:new Date(+NOW-i*60000).toISOString()})));
 const directory=await info.explore('products');assert.ok(directory.items.some(i=>i.title==='新推出的轻量鼠标'));assert.equal(reads,0);assert.ok(directory.items.reduce((n,i)=>n+JSON.stringify(i).length,0)<=6000);assert.ok(directory.items.every(i=>!Object.hasOwn(i,'brief')));
});
test('a publisher correction updates its hint and invalidates cached details without rewriting a delivered conversation',async t=>{
 let reads=0;const {info,store}=fixture(t,{fetchArticle:async()=>{reads++;return {text:'来源详情'};}});
 info.ingest(source(),[item('原报道标题')]);const id=info.list()[0].id;await info.explore(id);
 const rows=store.saveChatTurn({role:'miyue',text:'这条新闻怎么样？',reply:'这条报道让我想到一个问题。'});info.record(rows[1],id);
 info.ingest(source(),[item('更正后的标题')]);assert.equal(info.item(id).title,'更正后的标题');assert.equal(info.status().details,0);
 await info.explore(id);assert.equal(reads,2);assert.equal(info.recent()[0].title,'原报道标题');assert.equal(store.getMessage(rows[1].id).text,rows[1].text);
});
test('suppressing or correcting a delivery removes its repetition evidence',t=>{
 let visible=true;const {info,store}=fixture(t,{projectSource:row=>visible?row:null});info.ingest(source(),[item()]);
 const rows=store.saveChatTurn({role:'miyue',text:'聊点什么。',reply:'我想吃番茄面。'});info.record(rows[1],info.list()[0].id);assert.equal(info.recent().length,1);visible=false;assert.equal(info.recent().length,0);
});
test('public link indexes retain title links only, discard navigation and foreign hosts, and do not execute scripts',()=>{
 const html='<a href="/recipe-12.html"><img alt="热汤面"></a><a href="/recipe-12.html">重复</a><a href="https://elsewhere.example/recipe-13.html">异站</a><a href="/index.html">首页</a><script>throw Error("execute")</script>';
 assert.deepEqual(parsePageLinks(html,'https://example.org/recipes',{linkPattern:'/recipe-[0-9]+\\.html'}).items,[{title:'热汤面',url:'https://example.org/recipe-12.html',summary:'',publishedAt:null}]);
});
test('public link transport rejects a private address before requesting it',async()=>{
 let called=false;await assert.rejects(fetchPageLinks('http://127.0.0.1/index',{transport:async()=>{called=true;}}));assert.equal(called,false);
});
test('calendar recognizes National Day, official make-up workdays, weekends and unknown-year fallback',()=>{
 assert.equal(workCalendar('2026-10-06T02:00:00Z').holiday,'国庆');assert.equal(workCalendar('2026-10-06T02:00:00Z').restDay,true);
 assert.equal(workCalendar('2026-10-10T02:00:00Z').restDay,false);assert.equal(workCalendar('2026-10-11T02:00:00Z').restDay,true);
 assert.equal(workCalendar('2027-10-01T02:00:00Z').holiday,null);
});
test('unprompted sharing offers only the categories the interest directions cover, news first',t=>{
 const categories=Object.keys(INFORMATION_CATEGORIES),{info}=fixture(t,{sources:categories.map(c=>source(c))});
 for(const category of categories)info.ingest(source(category),[item(`${category}新线索`,`https://example.org/${category}`)]);
 const offered=info.slate({activity:{kind:'rest'},topics:'时事,科技,知识,文化,关系,心理学,哲学,旅游,感情,爱情'});
 const seen=new Set(offered.map(i=>i.category));
 assert.equal(offered[0].category,'news');assert.equal(seen.has('games'),false);assert.equal(seen.has('food'),false);
 for(const category of ['news','products','travel','film','series','books','music'])assert.ok(seen.has(category),category);
 assert.ok(info.slate({topics:'游戏'}).every(i=>i.category==='games'));
 assert.equal(new Set(info.slate({activity:{kind:'rest'}}).map(i=>i.category)).size,9);
});
