import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';
import {composeNewsBrief, newsBriefContext} from '../lib/news-brief.mjs';
import {ContentInbox} from '../lib/content-inbox.mjs';

const at = new Date('2026-09-07T12:00:00');
const article = {title:'城市图书馆开始延长周末开放时间',url:'https://example.org/library',summary:'城市图书馆宣布从本周起延长周末开放时间，周六和周日由下午五点延长到晚上八点。首批安排覆盖三家分馆，读者仍需提前预约，公告说明借阅规则暂时保持原样。',publishedAt:at.toISOString()};
async function setup(t, generate) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'news-brief-')), calls=[];
  const app=await createApp({dataDir:dir,initialFeeds:[],startProactive:false,startLifeThreads:false,startPursuits:false,startRecall:false,clock:()=>at,random:()=>.5,replySleep:async()=>{},env:{LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture'},fetchImpl:async(u,o)=>{
    const request=JSON.parse(o.body);calls.push(request);
    const id=request.messages.map(m=>m.content).join('\n').match(/ID:([^\n]+)/)?.[1];
    const content=generate?await generate(request,id):request.max_tokens===1800?JSON.stringify({skip:false,contentId:id,reason:'周末开放安排有具体变化',message:'有条新闻想分享。',brief:{event:'城市图书馆宣布从本周开始延长周末开放时间，首批包括三家分馆。',details:['周六和周日从下午五点延长到晚上八点，读者仍需提前预约。'],comment:'下班后想多待一会儿的人，应该会喜欢这个安排。'}}):'仍需提前预约，借阅规则暂时保持原样。';
    return Response.json({choices:[{message:{content}}]});
  }});
  const feed=app.store.addFeed('https://example.org/feed','城市公告');app.store.addContent(feed,[article],feed.title);
  app.proactiveRepo.saveSettings({activeStart:'00:00',activeEnd:'23:59',dailyLimit:6,desktopNotifications:false});
  const {port}=await app.listen(0);
  t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  const api=async(route,body)=>{const response=await fetch(`http://127.0.0.1:${port}${route}`,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,...await response.json()};};
  return {app,calls,api,id:app.store.listContent()[0].id};
}

test('manual brief targets Wenxi, gives concrete summary, retains sources for followup and marks read only on view',async t=>{
  const {app,calls,api,id}=await setup(t);
  const result=await api('/api/news/brief',{});
  assert.equal(result.delivered,true,JSON.stringify(result));assert.equal(result.message.role,'wenxi');
  assert.match(result.message.text,/三家分馆/);assert.match(result.message.text,/晚上八点/);assert.doesNotMatch(result.message.text,/有条新闻想分享/);
  assert.equal(calls.length,1);assert.equal((await api('/api/content')).counts.unread,1);
  assert.equal((await api('/api/inbox')).items[0].sourceUrl,article.url);
  assert.equal((await api('/api/conversations/miyue/read',{messageId:result.message.id})).status,404);
  await api('/api/conversations/wenxi/read',{messageId:result.message.id});
  assert.equal((await api('/api/content')).counts.read,1);assert.equal((await api('/api/content')).items.length,0);
  await api('/api/content/state',{ids:[id],action:'unread'});
  await api('/api/conversations/wenxi/read',{messageId:result.message.id});
  assert.equal((await api('/api/content')).counts.unread,1,'replayed cursor must not erase manual restoration');
  await api('/api/content/state',{ids:[id],action:'archive'});
  const reply=await api('/api/chat',{role:'wenxi',text:'还需要预约吗？'});
  assert.equal(reply.status,200);assert.match(JSON.stringify(calls.at(-1)),/读者仍需提前预约/);
  assert.equal(app.store.listContent().length,1);
});

test('only new unread sources are offered; an empty or quiet inbox makes no model call',async t=>{
  const {app,calls,api,id}=await setup(t);
  app.store.setSettings({quiet:true});assert.equal((await api('/api/news/brief',{})).delivered,false);
  app.store.setSettings({quiet:false});await api('/api/content/state',{ids:[id],action:'read'});
  const empty=await api('/api/news/brief',{});assert.equal(empty.delivered,false);assert.match(empty.reason,/未读/);assert.equal(calls.length,0);
});

test('reading a selected source while a brief is generating cancels delivery atomically',async t=>{
  let enter,release;const started=new Promise(r=>enter=r),held=new Promise(r=>release=r);
  const {app,api,id}=await setup(t,async(request,source)=>{enter();await held;return JSON.stringify({skip:false,contentId:source,reason:'来源更新',message:'想听听你的看法。'});});
  const pending=api('/api/news/brief',{});await started;await api('/api/content/state',{ids:[id],action:'read'});release();
  assert.equal((await pending).delivered,false);assert.equal(app.store.getMessages('wenxi').length,0);assert.equal(app.proactiveRepo.recent().length,0);
});

test('thin or malformed draft falls back to sourced substance without another model request',async t=>{
  const {api,calls}=await setup(t,async(request,id)=>JSON.stringify({skip:false,contentId:id,reason:'有新内容',message:'这条很有意思，你怎么看？',brief:{event:'有意思',details:[]}}));
  const result=await api('/api/news/brief',{});assert.equal(result.delivered,true);
  assert.match(result.message.text,/摘要里提到/);assert.match(result.message.text,/晚上八点/);assert.doesNotMatch(result.message.text,/你怎么看/);assert.equal(calls.length,1);
  assert.ok(newsBriefContext({...article,dossier:{excerptFacts:Array(4).fill('字'.repeat(2000))}}).length<2200);
  assert.match(composeNewsBrief(article,null),/三家分馆/);
});

test('existing conversation read positions migrate once and preserve later manual unread',async t=>{
  const {app,id}=await setup(t);
  const rows=app.store.saveChatTurn({role:'wenxi',text:'我看到了',reply:'周末开放安排',contentId:id});
  app.proactiveRepo.markRead('wenxi',rows.at(-1).id);
  app.store.db.exec('DROP TABLE content_inbox');
  const migrated=new ContentInbox(app.store,{clock:()=>at});
  assert.equal(migrated.list().counts.read,1);
  migrated.update([id],'unread');
  assert.equal(new ContentInbox(app.store,{clock:()=>at}).list().counts.unread,1);
});

test('paged API exposes later headlines, filters expired items, and bulk read affects the displayed page only',async t=>{
  const {app,api}=await setup(t),feed=app.store.listFeeds()[0];
  app.store.addContent(feed,Array.from({length:25},(_,i)=>({...article,title:`测试不同新闻 ${i}`,url:`https://example.org/${i}`})),feed.title);
  app.store.addContent(feed,[{...article,title:'已经过期的新闻',url:'https://example.org/old',publishedAt:new Date(+at-15*86400000).toISOString()}],feed.title);
  const first=await api('/api/content'),second=await api('/api/content?page=2');
  assert.equal(first.items.length,20);assert.equal(second.items.length,6);assert.equal(first.counts.expired,1);
  assert.equal(new Set([...first.items,...second.items].map(i=>i.id)).size,26);
  await api('/api/content/state',{ids:first.items.map(i=>i.id),action:'read'});
  assert.equal((await api('/api/content')).counts.unread,6);
  assert.equal((await api('/api/content?status=expired&query=过期')).items.length,1);
  assert.equal(app.store.listContent().length,27);
});

test('pagination keeps related-source evidence from outside the displayed page',async t=>{
  const {app,api,id}=await setup(t),feed=app.store.listFeeds()[0];
  app.store.addContent(feed,[{...article,url:'https://example.org/another-report'}],feed.title);
  const page=await api('/api/content?pageSize=1');
  assert.equal(page.items.length,1);
  assert.ok(page.items[0].relatedItems.some(item=>item.id===id));
});
