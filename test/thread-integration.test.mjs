import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createApp} from '../server.mjs';
async function setup(t, answers){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'thread-integration-')),calls=[];
  const app=await createApp({dataDir:dir,initialFeeds:[],startPursuits:true,startProactive:false,startRecall:false,replySleep:async()=>{},env:{LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture'},fetchImpl:async(u,o)=>{calls.push(JSON.parse(o.body));return Response.json({choices:[{message:{content:JSON.stringify({reply:answers[Math.min(calls.length-1,answers.length-1)],extra:''})}}]});}});
  const {port}=await app.listen(0);t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true});});
  return {app,calls,chat:async text=>{const r=await fetch(`http://127.0.0.1:${port}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:'miyue',text})});return{status:r.status,...await r.json()};}};
}
test('acceptance fulfills the pending conversation without consuming a new life or reading stage',async t=>{
  const {app,calls,chat}=await setup(t,['我接的包装稿改了三次，还是拿不准客户想要哪种感觉。让我介意的是一直猜要求，没敢直接问清楚。']);
  app.companionTuning.set({warmth:100,pleasing:100,coyness:100},0);const tuning=app.companionTuning.get();
  const prior=app.store.saveChatTurn({role:'miyue',text:'最近还好吗',reply:'愿意陪我说说最近心里那件有点沉的小事吗？'}),pending=app.pursuits.get('miyue').pendingKey;
  const result=await chat('好，你说吧');assert.equal(result.status,200);assert.equal(calls.length,1);
  const background=calls[0].messages.find(m=>m.content.startsWith('【本轮背景开始】')).content;
  assert.match(calls[0].messages.find(m=>m.content.startsWith('【本轮对话计划】')).content,/实际兑现刚才接受的提议/);assert.doesNotMatch(background,/百草园|个人生活线|当前片段/);
  assert.equal(app.pursuits.get('miyue').pendingKey,pending);assert.deepEqual(app.companionTuning.get(),tuning);
  const receipt=app.interactionPolicy.receipt(result.messages.at(-1).id);assert.equal(receipt.behavior.acceptedOffer,true);assert.equal(receipt.behavior.extra,null);assert.ok(receipt.behavior.threadSourceIds.includes(prior.at(-1).id));
});
test('reply to a recent source keeps that source and excludes an older unrelated book',async t=>{
  const {app,calls,chat}=await setup(t,['我也觉得诗里留的是人想记住的部分，街上洗衣晾衣这些小事反而很少被写进去。']);
  app.store.saveChatTurn({role:'miyue',text:'刚才那本书呢',reply:'百草园那段我还在读。'});
  const feed=app.store.addFeed('https://example.org/feed','测试原文');app.store.addContent(feed,[{title:'苏州诗词与真实街巷',url:'https://example.org/suzhou',summary:'诗词记下的意象与今天街巷中的普通生活并不完全相同。资料独有标记：沿河晾晒的衣服。'}],feed.title);const item=app.store.listContent()[0];
  app.proactiveRepo.saveSettings({activeStart:'00:00',activeEnd:'23:59'});
  const at=new Date();app.proactiveRepo.commitDelivery({role:'miyue',text:'你说我们读诗到底是在读一座城，还是读我们心里想让那座城成为的样子？',reason:'街巷资料',kind:'content',contentId:item.id,topicKey:'source',createdAt:at.toISOString(),expectedLastMessageId:app.proactiveRepo.getLastMessageId('miyue')});
  const result=await chat('读的是心里想的样子吧');assert.equal(result.status,200);
  const background=calls[0].messages.find(m=>m.content.startsWith('【本轮背景开始】')).content;
  assert.match(calls[0].messages.find(m=>m.content.startsWith('【本轮对话计划】')).content,/承接紧邻/);assert.doesNotMatch(background,/林晓薇最近在读|重读开头/);
  assert.match(JSON.stringify(calls[0]),/沿河晾晒的衣服/);
});
test('decorative draft gets one focused rewrite, and repeated style warnings never fail the message',async t=>{
  const flowery='平静就好，像风吹在湖面上。叶子落下来，像在给秋天记账。';
  const {calls,chat}=await setup(t,[flowery,'那就趁着这会儿轻松聊聊。我刚才说的稿子还剩一处没改完，字间距调好就能收工了。']);
  const result=await chat('我现在很平静呢');assert.equal(result.status,200);assert.equal(calls.length,2);assert.match(JSON.stringify(calls[1]),/保留刚才要回应的具体事/);assert.doesNotMatch(result.messages.at(-1).text,/像风|秋天记账/);
  const again=await setup(t,[flowery]);const repeated=await again.chat('我现在很平静呢');assert.equal(repeated.status,200);assert.equal(again.calls.length,2);assert.equal(again.app.interactionPolicy.receipt(repeated.messages.at(-1).id).behavior.styleWarnings.length,1);
});

for (const text of ['好，你说吧', '今天有点累，想抱抱']) {
  test(`irrelevant experience stays preserved history without forcing a digest into the current topic: ${text}`, async t => {
    const {app,calls,chat}=await setup(t,['我在呢，今天慢慢聊就好。']);
    app.store.saveChatTurn({role:'miyue',text:'前一个问题',reply:'前一个回答。'});
    const rows=app.store.saveChatTurn({role:'miyue',text:'你看过什么电影',reply:'我看过《小森林》，里面做饭的节奏让我觉得很舒服。'});
    app.personalExperiences.observe('miyue',rows);
    app.store.saveChatTurn({role:'miyue',text:'你最近怎么样',reply:'我今天想跟你说说一个烦心事。'});
    const settings=app.companionTuning.get();
    assert.equal((await chat(text)).status,200);
    const messages=calls[0].messages,backgroundIndex=messages.findIndex(m=>m.content.startsWith('【本轮背景开始】'));
    const background=messages[backgroundIndex].content,archive=messages.find(m=>m.content.startsWith('【历史资料｜'));
    assert.doesNotMatch(background,/近期经历简记|小森林|不强行转场/);
    const archived=JSON.parse(archive.content.split('\n')[1]);
    assert.deepEqual(archived.map(({speaker,text})=>({speaker,text:text.split('\n').at(-1)})),[{speaker:'用户',text:'前一个问题'},{speaker:'林晓薇',text:'前一个回答。'}]);
    assert.ok(archived.every(item=>item.text.startsWith('【历史消息·')),'archive retains its historical timestamp labels');
    assert.ok(messages.filter(m=>m.content.startsWith('【历史资料｜')).every(m=>messages.indexOf(m)<backgroundIndex));
    const suppliedHistory=messages.map(m=>m.content).join('\n');
    assert.match(suppliedHistory,/我看过《小森林》，里面做饭的节奏让我觉得很舒服。/);
    assert.match(suppliedHistory,/我今天想跟你说说一个烦心事。/);
    assert.ok(app.personalExperiences.list('miyue').some(item=>item.title==='小森林'&&item.evidence.includes('做饭')));
    assert.deepEqual(app.companionTuning.get(),settings);
    assert.equal(messages.at(-1).content,text);
  });
}

test('proactive history retains shared facts without reinserting an old-experience digest',async t=>{
  const {app}=await setup(t,['测试']);
  const rows=app.store.saveChatTurn({role:'miyue',text:'最近看了什么',reply:'我看过《小森林》，里面做饭的节奏很舒服。'});
  app.personalExperiences.observe('miyue',rows);
  const proactive=await app.proactive.getRoleContext('miyue');
  assert.match(JSON.stringify(proactive.conversation),/小森林/);
  assert.doesNotMatch(proactive.characterContext,/近期经历简记/);
  assert.match(app.roleContext('miyue',{initiating:false,text:'记得你说过小森林吗'}).characterContext,/小森林/);
  assert.doesNotMatch((await app.proactive.getRoleContext('wenxi')).characterContext,/近期经历简记|小森林/);
});

test('a named old experience remains available on explicit request after leaving the digest',async t=>{
  const {app}=await setup(t,['测试']);
  const rows=app.store.saveChatTurn({role:'miyue',text:'最近看了什么',reply:'我看过《小森林》，里面做饭的节奏很舒服。'});
  app.personalExperiences.observe('miyue',rows);
  app.store.db.prepare('UPDATE personal_experiences SET created_at=?').run('2020-01-01T00:00:00Z');
  assert.doesNotMatch((await app.proactive.getRoleContext('miyue')).characterContext,/小森林/);
  const context=(await app.proactive.getRoleContext('miyue',{initiating:false,text:'之前你看小森林有什么感受'})).characterContext;
  assert.match(context,/角色虚构经历[\s\S]*小森林/);
});
