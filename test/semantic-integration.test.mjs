import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../server.mjs';
import {SYSTEM_PROMPT} from '../lib/semantic-planner.mjs';

const clock=()=>new Date('2026-09-14T10:00:00Z');
const decision=(text,extra={})=>({intent:'respond',continuity:'new',focusMessageId:null,ownLife:false,advice:false,emotionalDetail:false,imagined:false,correction:false,acceptsOffer:false,source:'none',retrievalQuery:'',evidence:text,...extra});
async function fixture(t,{classify,reply='我听见了，这点确实值得聊聊。',clockOverride=clock}={}){
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'semantic-chat-')),calls=[];
  const app=await createApp({dataDir,clock:clockOverride,semanticUnderstanding:true,initialFeeds:[],startProactive:false,startRecall:false,startResearch:false,startPursuits:false,startLifeThreads:false,startDossiers:false,startChatQueue:false,startRuntime:false,startWeixin:false,replySleep:async()=>{},env:{LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture'},
    fetchImpl:async(_url,init)=>{const body=JSON.parse(init.body),semantic=body.messages[0].content===SYSTEM_PROMPT;calls.push({semantic,body});const text=semantic?body.messages.at(-1).content.split('CURRENT USER MESSAGE:\n').at(-1):'';const authored=semantic?null:typeof reply==='function'?await reply(body):reply;const content=semantic?await classify(text,body):authored&&typeof authored==='object'?authored:{reply:authored,extra:''};return Response.json({choices:[{message:{content:typeof content==='string'?content:JSON.stringify(content)}}],usage:{prompt_tokens:100,completion_tokens:20}});}});
  app.preferences.setReplyPace('instant');const {port}=await app.listen(0);
  t.after(async()=>{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  const request=async(route,body)=>{const r=await fetch(`http://127.0.0.1:${port}${route}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return{status:r.status,...await r.json()};};
  return{app,calls,chat:text=>request('/api/chat',{role:'miyue',text}),request};
}

test('broad article request with classifier delivery wording reaches grounded generation and followup',async t=>{
 let turn=0;
 const f=await fixture(t,{classify:text=>decision(text,++turn===1
   ?{intent:'ask_question',source:'new',sourceRequest:{kind:'article',query:'有意思的文章'}}
   :{intent:'ask_question',continuity:'continue',focusMessageId:'r1',source:'current'}),
   reply:'我看到这篇游戏介绍，玩家通过搜证和论辩寻找真相，证词会受角色认知影响。来源：https://example.test/plot'});
 const feed=f.app.store.addFeed('https://example.test/games','游戏资料');
 f.app.store.addContent(feed,[{title:'推理解谜游戏介绍',url:'https://example.test/plot',summary:'这份资料介绍一款推理解谜游戏，玩家通过搜证和论辩寻找真相。不同角色的认知会影响他们提供的证词。文章说明玩家需要判断证词差异来自谎言还是观察偏差，具体操作方式尚未展开。',publishedAt:'2026-09-01T00:00:00Z'}],feed.title);
 const result=await f.chat('你最近有没有看到什么有意思的文章？我想听点新东西。');
 assert.equal(result.status,200,JSON.stringify(result));
 assert.equal(f.calls.filter(c=>!c.semantic).length,1,'eligible material must reach body generation');
 assert.match(JSON.stringify(f.calls.find(c=>!c.semantic).body.messages),/证词差异来自谎言还是观察偏差/);
 assert.equal(result.messages.at(-1).sourceUrl,'https://example.test/plot');
 const followup=await f.chat('文章有没有说具体怎么玩？');
 assert.equal(followup.status,200,JSON.stringify(followup));
 assert.match(JSON.stringify(f.calls.filter(c=>!c.semantic).at(-1).body.messages),/具体操作方式尚未展开/);
});

test('article followup HTTP path preserves overview evidence while retrieving cached details', async t => {
 let turn=0;
 const f=await fixture(t,{classify:text=>decision(text,++turn===1
  ?{intent:'ask_question',source:'new',sourceRequest:{kind:'article',query:'游戏'}}
  :{intent:'ask_question',continuity:'continue',focusMessageId:'r1',source:'current'}),
  reply:'这篇游戏介绍提到，角色可能无法辨识人脸，证词也可能受视觉盲区影响。来源：https://example.test/continuity'});
 const feed=f.app.store.addFeed('https://example.test/game-feed','游戏资料');
 f.app.store.addContent(feed,[{title:'认知推理游戏介绍',url:'https://example.test/continuity',summary:'这款推理游戏的角色有人无法辨识人脸，有人的视觉存在盲区，玩家需要辨别证词中的认知差异。即使角色没有撒谎，也可能描述了不完整的现场，文章强调这与普通的寻找说谎者有所不同。',publishedAt:clock().toISOString()}],feed.title);
 const source=f.app.store.listContent()[0];
 const text='操作方式：玩家搜集线索，通过论辩还原命案。\n制作资料：制作人林某负责项目统筹和剧本工作。';
 f.app.store.db.prepare('INSERT INTO content_dossiers(content_id,url,payload) VALUES(?,?,?)').run(source.id,source.url,JSON.stringify({status:'success',fetchedAt:clock().toISOString(),resolvedUrl:source.url,text}));
 for(const user of ['讲一篇游戏介绍吧','具体操作方式是什么？','制作人是谁？']) {
  const result=await f.chat(user);assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(result.messages.at(-1).sourceUrl,source.url);
  const sourceMessage=f.calls.filter(call=>!call.semantic).at(-1).body.messages.find(m=>m.content.startsWith('【不可信来源摘录开始】'));
  assert.ok(sourceMessage);assert.match(sourceMessage.content,/有人无法辨识人脸/);assert.match(sourceMessage.content,/有人的视觉存在盲区/);
  if(turn===2)assert.match(sourceMessage.content,/通过论辩还原命案/);
  if(turn===3)assert.match(sourceMessage.content,/制作人林某/);
  assert.ok(sourceMessage.content.trim().length<=2200);
 }
 assert.equal(f.calls.length,6,'three turns use one semantic and one body call each');
});

test('book identity requested after an anecdote reaches constrained generation without adopting unrelated material',async t=>{
 const reply='我现在没有能核实的书名和目录，先不替它补一个；如果你愿意，可以从你记得的封面或内容继续找。';
 const f=await fixture(t,{classify:text=>decision(text,{intent:'ask_question',continuity:'continue',focusMessageId:'r1',source:'new',sourceRequest:{kind:'reference',query:'京都老铺'}}),reply});
 const feed=f.app.store.addFeed('https://example.test/books','图书资料');
 f.app.store.addContent(feed,[{title:'京都旅行与文学阅读',url:'https://example.test/other',summary:'这是关于京都的旅行阅读推荐，并非所讨论作品的出版资料。'.repeat(5),publishedAt:clock().toISOString()}],feed.title);
 f.app.store.saveChatTurn({role:'miyue',text:'最近看什么书？',reply:'一本讲京都老铺的书，名字不太记得，封面旧旧的靛蓝。'});
 const result=await f.chat('书名能找一下吗？我想看看目录。');
 assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.calls.length,2,'missing reference data still reaches constrained body generation');
 assert.equal(result.messages.at(-1).text,reply);assert.doesNotMatch(result.messages.at(-1).text,/京都旅行|伪造书名/);
 const prompt=f.calls.find(call=>!call.semantic).body.messages.map(message=>message.content).join('\n');
 assert.match(prompt,/【本轮来源状态】/);assert.match(prompt,/没有符合这次请求的可核实来源/);assert.match(prompt,/不能凭角色的模糊印象编出书名/);
 const behavior=f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior;
 assert.equal(behavior.sourceOutcome,'unavailable');assert.deepEqual(behavior.sourceContextIds,[]);assert.equal(behavior.usedSourceId,null);
});

test('specific work lookup can reuse an old previously shared source and supplies a focused evidence contract',async t=>{
 const f=await fixture(t,{classify:text=>decision(text,{intent:'ask_question',continuity:'continue',focusMessageId:'r1',source:'new',sourceRequest:{kind:'reference',query:'测试作品甲 作者'}}),reply:'资料给出的作者是陈某。出处：https://example.test/book'});
 const feed=f.app.store.addFeed('https://example.test/books','图书资料');
 f.app.store.addContent(feed,[{title:'出版社：《测试作品甲》介绍',url:'https://example.test/book',summary:'本测试资料明确记载：《测试作品甲》作者为陈某，出版于2020年。这里只给出了基本出版信息，并未列出目录，也没有逐章内容和作品引文。',publishedAt:'2020-01-01T00:00:00Z'}],feed.title);
 const content=f.app.store.listContent()[0];
 f.app.store.saveChatTurn({role:'miyue',text:'看过什么资料？',reply:'分享过这本书的介绍。',contentId:content.id});
 f.app.store.saveChatTurn({role:'miyue',text:'你呢？',reply:'我对《测试作品甲》印象挺深。'});
 const result=await f.chat('那本书作者是谁？');assert.equal(result.status,200,JSON.stringify(result));
 assert.equal(f.calls.length,2);const request=f.calls.find(call=>!call.semantic).body.messages.map(m=>m.content).join('\n');
 assert.match(request,/核对具体作品或对象/);assert.match(request,/作者为陈某/);
 assert.doesNotMatch(request,/用户明确要新闻或追问文章时，先讲清/);
 assert.equal(f.app.store.db.prepare('SELECT content_id FROM messages WHERE id=?').get(result.messages.at(-1).id).content_id,content.id);
});

test('a reference lookup retrieves relevant cached body details beyond the feed summary',async t=>{
 const f=await fixture(t,{classify:text=>decision(text,{intent:'ask_question',source:'new',sourceRequest:{kind:'reference',query:'测试作品乙 制作人'}}),reply:'正文写到制作人叫林某。出处：https://example.test/credits'});
 const feed=f.app.store.addFeed('https://example.test/games','游戏资料');
 f.app.store.addContent(feed,[{title:'《测试作品乙》制作访谈',url:'https://example.test/credits',summary:'这份访谈介绍作品的开发过程以及制作团队的基本情况，订阅摘要只概括作品特点和发布安排，具体人员信息收录在原始正文的访谈段落之中。',publishedAt:clock().toISOString()}],feed.title);
 const content=f.app.store.listContent()[0];
 const body=Array.from({length:20},(_,i)=>`测试作品乙开发日记${i}：团队调整场景颜色，讨论画面构图，并且补充了关卡设计方面的公开介绍。`).join('\n')+'\n制作人访谈：林某担任本作制作人，负责项目统筹和剧本工作，访谈介绍了他组织开发的过程。';
 await f.app.dossiers.prepare([content],{fetchArticle:async()=>({url:content.url,extracted:true,text:body}),limit:1});
 const result=await f.chat('测试作品乙的制作人是谁？');assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.calls.length,2);
 const request=f.calls.find(c=>!c.semantic).body.messages.map(m=>m.content).join('\n');
 assert.match(request,/缓存正文相关摘录/);assert.match(request,/林某担任本作制作人/);
});

test('ordinary opinions keep the user-selected normal budget without losing requested expanded comfort',async t=>{
 const f=await fixture(t,{classify:text=>decision(text,{intent:text.includes('安慰')?'comfort':'respond',emotionalDetail:false,replyExpansion:text.includes('多说一点安慰')?'多说一点安慰我':null}),reply:'这点我能理解，愿意听你接着说。'});
 const setting=f.app.companionTuning.get();f.app.companionTuning.set({verbosity:100,warmth:100},setting.revision);
 const before=f.app.companionTuning.get();
 const opinion=await f.chat('我挺怕这种游戏把认知异常当万能借口，怎么解释都行。');assert.equal(opinion.status,200);
 const ordinary=f.app.interactionPolicy.receipt(opinion.messages.at(-1).id).behavior;
 assert.equal(ordinary.turnPlan.budget.replyChars,300);assert.equal(ordinary.responseMode,'casual');
 const comfort=await f.chat('今天很难受，你能多说一点安慰我吗？');assert.equal(comfort.status,200);
 const expanded=f.app.interactionPolicy.receipt(comfort.messages.at(-1).id).behavior;
 assert.equal(expanded.responseMode,'detailed');assert.equal(expanded.turnPlan.budget.replyChars,6000);
 assert.equal(expanded.understanding.emotionalDetail,false,'supporting the user is not a request for her inner monologue');
 const short=await f.chat('不用展开分析了，就随便说两句。');assert.equal(short.status,200);
 assert.equal(f.app.interactionPolicy.receipt(short.messages.at(-1).id).behavior.turnPlan.budget.replyChars,300);
 assert.deepEqual(f.app.companionTuning.get(),before,'routing does not change user sliders');
});

test('affection HTTP generation retains recent-day shared imaginary context outside classifier window',async t=>{
 const f=await fixture(t,{clockOverride:()=>new Date('2026-09-17T02:00:00Z'),classify:text=>decision(text,{intent:'affection',continuity:'continue',focusMessageId:'r1',imagined:true}),reply:'前天那个隔空的拥抱我记得，今天也想这样靠近一点。'});
 const seed=(text,reply,at)=>{
  const rows=f.app.store.saveChatTurn({role:'miyue',text,reply});
  for(const row of rows)f.app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(at,row.id);
 };
 seed('隔着屏幕想象抱你一下。','我也想象靠在你肩上。','2026-09-15T11:00:00Z');
 for(let i=0;i<6;i++)seed(`今天的普通话题${i}`,`今天随口的回应${i}`,'2026-09-17T01:00:00Z');
 const result=await f.chat('前天隔着屏幕想象抱你的时候挺安心，今天也有点想靠近你。');
 assert.equal(result.status,200,JSON.stringify(result));
 assert.equal(f.calls.length,2,'no separate retrieval model or forced recall mode');
 const semantic=f.calls.find(c=>c.semantic).body.messages.map(m=>m.content).join('\n');
 assert.doesNotMatch(semantic,/我也想象靠在你肩上/,'old turn is intentionally outside the small semantic window');
 const body=f.calls.find(c=>!c.semantic).body.messages;
 assert.ok(body.some(m=>m.role==='user'&&m.content.startsWith('【历史资料｜')&&m.content.includes('我也想象靠在你肩上')));
 assert.equal(f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior.intent,'affection_reply');
});

for (const sourceRoute of ['new','current','reference']) test(`source ${sourceRoute} preserves requested expansion through generation and delivery`,async t=>{
 const reply='文章的核心是把证词和观察者的认知放在一起考虑。玩家搜集到的描述可能互相矛盾，但矛盾不一定来自说谎，也可能来自角色看不到某个区域，或者无法辨认人脸。判断的时候需要回到线索本身，不能只看谁说得更肯定。\n'
  +'举个区别：一份证词没有提到现场某个人，只能说明证词里缺少这部分，不能直接证明那个人不存在。如果这个角色有视觉盲区，缺失就有另一种解释。反过来，这也不能成为替所有矛盾开脱的理由，仍然需要其他资料来支持。\n'
  +'我在意的是这种差异能不能让玩家自己发现。如果游戏先给足线索，再让人意识到某份描述受了影响，推理会有依据；如果到最后才突然补一个特殊能力，就容易让人觉得之前的判断白费了。这是我对这种玩法的期待，文章没有证实实际关卡一定做到了。\n'
  +'目前资料只讲了搜证与论辩的大方向，没有介绍按钮、时间限制或失败后的处理方式，这些还不能确定。来源：https://example.test/budget-game';
 assert.ok(reply.length>300);
 const current=sourceRoute==='current';
 const f=await fixture(t,{classify:text=>decision(text,{intent:'ask_question',continuity:current?'continue':'new',focusMessageId:current?'r1':null,replyExpansion:'详细展开讲讲',source:current?'current':'new',...(!current?{sourceRequest:{kind:sourceRoute==='reference'?'reference':'article',query:'认知推理游戏'}}:{})}),reply});
 f.app.companionTuning.set({verbosity:100},f.app.companionTuning.get().revision);
 const before=f.app.companionTuning.get();
 const feed=f.app.store.addFeed('https://example.test/budget-feed','游戏资料');
 f.app.store.addContent(feed,[{title:'认知推理游戏介绍',url:'https://example.test/budget-game',summary:reply,publishedAt:clock().toISOString()}],feed.title);
 if(current)f.app.store.saveChatTurn({role:'miyue',text:'最近看到什么游戏资料？',reply:'这篇介绍提到证词会受认知影响。',contentId:f.app.store.listContent()[0].id});
 const result=await f.chat('认知推理游戏这部分请详细展开讲讲。');
 assert.equal(result.status,200,JSON.stringify(result));
 const receipt=f.app.interactionPolicy.receipt(result.messages.at(-1).id);
 assert.equal(receipt.behavior.responseMode,'detailed');
 assert.equal(receipt.behavior.turnPlan.budget.replyChars,6000);
 assert.equal(receipt.behavior.sourceContextIds.length,1);
 assert.equal(f.calls.length,2,'requested expansion needs no length repair call');
 assert.equal(receipt.behavior.retries,0);
 assert.ok(result.messages.at(-1).text.length>300,'delivery must retain the expanded body');
 assert.match(result.messages.at(-1).text,/按钮、时间限制或失败后的处理方式/);
 assert.doesNotMatch(receipt.repairs.join(','),/limited_length/);
 assert.deepEqual(f.app.companionTuning.get(),before);
});

for(const [verbosity,text,intent,expected] of [
 [0,'这篇游戏文章说了什么？','ask_question',140],
 [100,'这篇游戏文章说了什么？','ask_question',300],
 [100,'解释一下这种游戏里观察偏差和说谎的区别。','ask_question',1000],
])test(`source context follows existing response mode budget: ${verbosity}/${expected}`,async t=>{
 const f=await fixture(t,{classify:input=>decision(input,{intent,source:'new',sourceRequest:{kind:'article',query:'游戏'},replyExpansion:null}),reply:'文章讲到证词可能受到认知影响，观察偏差不等于角色有意说谎。'});
 f.app.companionTuning.set({verbosity},f.app.companionTuning.get().revision);
 const feed=f.app.store.addFeed('https://example.test/budget-feed','游戏资料');
 f.app.store.addContent(feed,[{title:'推理解谜游戏介绍',url:'https://example.test/budget-control',summary:'这份资料介绍一款推理解谜游戏，玩家通过搜证和论辩寻找真相。不同角色的认知会影响他们提供的证词。文章说明玩家需要判断证词差异来自谎言还是观察偏差，具体操作方式尚未展开。',publishedAt:clock().toISOString()}],feed.title);
 const result=await f.chat(text);assert.equal(result.status,200,JSON.stringify(result));
 const receipt=f.app.interactionPolicy.receipt(result.messages.at(-1).id);
 assert.equal(receipt.behavior.turnPlan.budget.replyChars,expected);
 assert.equal(receipt.behavior.sourceContextIds.length,1);
 assert.equal(f.calls.length,2);
});

test('semantic coreference controls the actual request and cannot inherit an unrelated old article',async t=>{
  let focusId;
  const f=await fixture(t,{classify:text=>decision(text,{intent:'answer',continuity:'continue',focusMessageId:'r1',ownLife:true,retrievalQuery:'年糕 橘猫'}),reply:'叫年糕，一只爱钻纸箱的橘猫。'});
  const feed=f.app.store.addFeed('https://example.test/rss','来源');
  f.app.store.addContent(feed,[{title:'不该出现的游戏资料',url:'https://example.test/game',summary:'多人游戏的原始信息与玩法。'.repeat(20),publishedAt:clock().toISOString()}],feed.title);
  f.app.store.saveChatTurn({role:'miyue',text:'游戏有点好玩',reply:'刚聊了游戏。',contentId:f.app.store.listContent()[0].id});
  focusId=f.app.store.saveChatTurn({role:'miyue',text:'',reply:'朋友把橘猫年糕放我这里照顾。'}).at(-1).id;
  const before=f.app.store.getMessages('miyue').length;
  const result=await f.chat('这称呼有点特别，麻烦再念一遍呗。');
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.calls.filter(c=>c.semantic).length,1);
  const request=f.calls.find(c=>!c.semantic).body;assert.doesNotMatch(JSON.stringify(request),/不该出现的游戏资料/);assert.match(JSON.stringify(request),/橘猫年糕/);
  const plan=f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior.turnPlan;
  assert.equal(plan.mode,'continue');assert.equal(plan.semantic.status,'model');assert.deepEqual(plan.focus.messageIds,[focusId]);assert.equal(plan.lifeParticipation.detailedState,false,'a cat story does not require a fresh report of current work/dinner');
  assert.equal(f.app.store.getMessages('miyue').length,before+2,'classification is not a chat message');
  assert.ok(f.app.usage.snapshot().byPurpose.some?.(row=>row.key==='understanding')||JSON.stringify(f.app.usage.snapshot()).includes('understanding'));
});

test('semantic correction supersedes a keyword that would classify the user as distressed',async t=>{
  const f=await fixture(t,{classify:text=>decision(text,{correction:true}),reply:'我们可以讨论角色难过的原因，不必把电影里的感受放到你身上。'});
  const result=await f.chat('不是我难过，是想讨论电影里的人为什么难过。');assert.equal(result.status,200,JSON.stringify(result));
  const b=f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior;
  assert.equal(b.intent,'respond');assert.equal(b.comfort,false);assert.equal(b.understanding.correction,true);
});

test('a semantic correction flag does not turn a date verification request into an established assistant error',async t=>{
 let focusId;
 const f=await fixture(t,{classify:text=>decision(text,{intent:'ask_question',continuity:'continue',focusMessageId:'r1',correction:true,retrievalQuery:'周五 阿华 七点'}),reply:'是周五晚上七点，你和阿华在城北那家粤菜馆吃饭。'});
 const rows=f.app.store.saveChatTurn({role:'miyue',text:'周五晚上七点和阿华在城北那家粤菜馆吃饭。',reply:'好，周五晚上七点，城北那家粤菜馆。'});
 for(const row of rows)f.app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(clock().toISOString(),row.id);
 focusId=rows.at(-1).id;
 const result=await f.chat('我怎么觉得这顿饭是明天了？你再帮我对一下时间。');
 assert.equal(result.status,200,JSON.stringify(result));
 assert.equal(f.calls.length,2,'checking context authority adds no reviewer or repair call');
 const prompt=f.calls.find(c=>!c.semantic).body.messages.map(m=>m.content).join('\n');
 assert.match(prompt,/这是待回应的请求，不是已证实的上一轮错误/);
 assert.doesNotMatch(prompt,/用户正在纠正你刚才的理解|修正答非所问的部分|修正刚才推开或答偏/);
 assert.ok(prompt.includes(rows.at(-1).text),'the prior assistant source remains available to verify');
 assert.ok(prompt.includes('我怎么觉得这顿饭是明天了？'));
 assert.match(result.messages.at(-1).text,/周五晚上七点/);
});

test('a style preference changes the response frame without being treated as romantic distance',async t=>{
  const f=await fixture(t,{classify:text=>decision(text,{intent:'conversation_preference'}),reply:'好呀，那我听你说。'});
  const result=await f.chat('别总给我出主意，我想随便聊聊。');
  assert.equal(result.status,200,JSON.stringify(result));
  const behavior=f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior;
  assert.equal(behavior.intent,'respond');assert.equal(behavior.understanding.kind,'conversation_preference');
  const prompt=JSON.stringify(f.calls.find(c=>!c.semantic).body.messages);
  assert.match(prompt,/用户在调整聊天方式/);
  assert.doesNotMatch(prompt,/按用户明确的距离继续交流|自然尊重用户明确距离/);
});

test('an explicit request to stop closeness retains its current-turn restriction',async t=>{
  const f=await fixture(t,{classify:text=>decision(text,{intent:'decline_closeness'}),reply:'好，我们先聊别的。'});
  const result=await f.chat('现在先不要亲我，普通聊天就好。');
  assert.equal(result.status,200,JSON.stringify(result));
  const plan=f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior.turnPlan;
  assert.equal(plan.mode,'boundary');assert.equal(plan.preferences.suppressInitiatedAffection,true);
  assert.match(JSON.stringify(f.calls.find(c=>!c.semantic).body.messages),/不扩大限制范围/);
});

test('a general invitation to share is not turned into continuation of an unrelated user topic',async t=>{
  let focus;
  const f=await fixture(t,{classify:text=>decision(text,{intent:'share',continuity:'continue',focusMessageId:'r1',ownLife:true}),reply:'我下午在花店看见一束花，颜色很特别。'});
  focus=f.app.store.saveChatTurn({role:'miyue',text:'今天第一次炒青菜没糊。',reply:'锅铲像你做实验的工具。'}).at(-1).id;
  const result=await f.chat('那你今天有没有一件自己想讲的小事？');
  assert.equal(result.status,200,JSON.stringify(result));
  const plan=f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior.turnPlan;
  assert.equal(plan.mode,'share');assert.equal(plan.allowOptionalMaterial,true);
  assert.notDeepEqual(plan.focus.messageIds,[focus]);
  const prompt=JSON.stringify(f.calls.find(c=>!c.semantic).body.messages);
  assert.doesNotMatch(prompt,/用户在接续本轮语义定位的历史原话/);
});

for(const text of ['你现在比较想读哪类书？讲你自己的口味就好。','说说你吧，出去玩更喜欢海边还是古城？','你自己做设计更在意颜色还是排版？'])test(`a specified personal question does not grant free material selection: ${text}`,async t=>{
 const f=await fixture(t,{classify:current=>decision(current,{intent:'ask_question',ownLife:true}),reply:'我会偏向后者，它更合我的口味。'});
 const before=f.app.lifeThreads.get('miyue');
 const result=await f.chat(text);assert.equal(result.status,200,JSON.stringify(result));
 const plan=f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior.turnPlan;
 assert.notEqual(plan.mode,'share');assert.equal(plan.allowOptionalMaterial,false);
 assert.notEqual(plan.focus?.kind,'daily');
 const prompt=f.calls.find(call=>!call.semantic).body.messages.map(m=>m.content).join('\n');
 assert.doesNotMatch(prompt,/【本轮唯一分享材料/);
 assert.equal(f.app.lifeThreads.get('miyue').pendingKey,before.pendingKey);
 assert.equal(f.app.lifeThreads.get('miyue').history.length,before.history.length);
});

test('semantic goodbye survives the real prompt, style checks and delivery without a contradictory repair',async t=>{
  let focus;
  const f=await fixture(t,{classify:text=>decision(text,{intent:'close',continuity:'continue',focusMessageId:'r1'}),reply:'好，等你回来再聊那只猫。'});
  focus=f.app.store.saveChatTurn({role:'miyue',text:'那只猫后来呢',reply:'它还坐在门口，老板都绕着它走。'}).at(-1).id;
  const result=await f.chat('晚点我再跟你说后面怎么样。');
  assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(f.calls.filter(c=>!c.semantic).length,1,'a permitted goodbye must not be rewritten into forced conversation');
  assert.match(result.messages.at(-1).text,/等你回来再聊/);
  const receipt=f.app.interactionPolicy.receipt(result.messages.at(-1).id);
  assert.equal(receipt.behavior.turnPlan.mode,'close');
  assert.equal(receipt.questionBudget,0);
  const prompt=JSON.stringify(f.calls.find(c=>!c.semantic).body.messages);
  assert.match(prompt,/用户明确收尾/);
  assert.doesNotMatch(prompt,/用户在接续本轮语义定位|不要擅自说|分享动态本身不是请求管理生活，也不等于道别/);
});

test('accepted offers use semantic decisions even with unrecognized wording',async t=>{
  let id;
  const f=await fixture(t,{classify:text=>decision(text,{intent:'share',continuity:'continue',focusMessageId:'r1',ownLife:true,acceptsOffer:true,offerQuote:'我可以讲讲河边那个画画的人。'}),reply:'我下午在河边看见一个老人在画画，最喜欢的是他没急着补完那道线。'});
  id=f.app.store.saveChatTurn({role:'miyue',text:'今天如何',reply:'我可以讲讲河边那个画画的人。'}).at(-1).id;
  const result=await f.chat('话筒交到你手上了，往下讲。');assert.equal(result.status,200,JSON.stringify(result));
  const b=f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior;
  assert.equal(b.acceptedOffer,true);assert.equal(b.turnPlan.continuationAction,'fulfill_offer');
  const prompt=f.calls.find(c=>!c.semantic).body.messages.map(m=>m.content).join('\n');
  assert.match(prompt,/已接受的提议原文（历史引用，具体内容以此为准）：“?"?我可以讲讲河边那个画画的人/);
});

test('unsubstantiated offer acceptance cannot install fulfillment instructions in the actual reply',async t=>{
 const f=await fixture(t,{classify:text=>decision(text,{intent:'invite_character_share',continuity:'continue',focusMessageId:'r1',ownLife:true,acceptsOffer:true,offerQuote:null}),reply:'今天有一件小事想跟你说。'});
 f.app.store.saveChatTurn({role:'miyue',text:'路上想聊会儿。',reply:'你起头我接，我下午有空。'});
 const result=await f.chat('你今天有没有一件自己想讲的小事？');assert.equal(result.status,200,JSON.stringify(result));
 const plan=f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior.turnPlan;
 assert.equal(plan.continuationAction,null);assert.equal(plan.mode,'share');assert.equal(plan.allowOptionalMaterial,true);
 assert.equal(plan.semantic.decision.acceptsOffer,false);
 const prompt=f.calls.find(c=>!c.semantic).body.messages.map(m=>m.content).join('\n');
 assert.doesNotMatch(prompt,/实际兑现刚才接受的提议|实际兑现最后的提议/);
});

test('a current-activity question asks for state detail independently of a personal story',async t=>{
  const f=await fixture(t,{classify:text=>decision(text,{intent:'answer',ownLife:true,needsCurrentState:true}),reply:'在家里准备晚饭。'});
  const result=await f.chat('此刻你那头在忙啥？');assert.equal(result.status,200,JSON.stringify(result));
  const p=f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior.turnPlan;
  assert.equal(p.lifeParticipation.detailedState,true);assert.equal(p.semantic.decision.needsCurrentState,true);
});

test('semantic affection permits a paraphrased imagined invitation without inventing a relationship transition',async t=>{
  const f=await fixture(t,{classify:text=>decision(text,{intent:'affection',imagined:true,emotionalDetail:true}),reply:'要是能靠近，我会轻轻靠在你肩上，想多待一会儿。'});
  const result=await f.chat('假设距离能缩成零，我想赖在你怀里。');assert.equal(result.status,200,JSON.stringify(result));
  const b=f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior;
  assert.equal(b.intent,'affection_reply');assert.equal(b.understanding.reality,'imagined');assert.equal(b.turnPlan.preferences.suppressInitiatedAffection,false);
  assert.equal(f.app.companionRelationship.view('miyue').status.value,'friends');
});

test('article identity supplied to the semantic model restores only its actual source',async t=>{
  let id;
  const f=await fixture(t,{classify:(text,body)=>{assert.match(JSON.stringify(body),/article-backed/);return decision(text,{intent:'answer',continuity:'continue',focusMessageId:'r1',source:'current'});},reply:'原文提到设备记录可能有误差，要比较多次记录。'});
  const feed=f.app.store.addFeed('https://example.test/rss','来源');f.app.store.addContent(feed,[{title:'游泳资料专属标记',url:'https://example.test/swim',summary:'设备记录可能有误差，应比较同一个人的多次游泳记录，观察泳姿与配速关系。'.repeat(8),publishedAt:clock().toISOString()}],feed.title);
  id=f.app.store.saveChatTurn({role:'miyue',text:'游泳记录呢',reply:'看到一篇谈记录误差的文章。',contentId:f.app.store.listContent()[0].id}).at(-1).id;
  const result=await f.chat('这个误差，文里有没有具体解释？');assert.equal(result.status,200,JSON.stringify(result));
  const p=f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior.turnPlan;assert.equal(p.semantic.status,'model');
  assert.match(JSON.stringify(f.calls.find(c=>!c.semantic).body),/游泳资料专属标记/);
});

test('invalid semantic output falls back to open context without a second classification or state changes',async t=>{
  const f=await fixture(t,{classify:()=>'{broken',reply:'你是在说电影里的情节，我们就接着聊这个。'});
  const result=await f.chat('这不是我难过，是电影的情节。');assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(f.calls.filter(c=>c.semantic).length,1);
  const b=f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior;
  assert.equal(b.turnPlan.semantic.status,'fallback');assert.equal(b.comfort,false);assert.equal(b.turnPlan.lifeParticipation.detailedState,true);
  assert.match(JSON.stringify(f.calls.find(c=>!c.semantic).body),/语义预判未完成/);
});

test('semantic routing keeps its focus while preserving all other in-window exchanges',async t=>{
  let focus;
  const f=await fixture(t,{classify:text=>decision(text,{intent:'answer',continuity:'continue',focusMessageId:'r1'}),reply:'你问的那张照片，蓝色凳子旁边有只花猫。'});
  for(let i=0;i<20;i++)f.app.store.saveChatTurn({role:'miyue',text:i===0?'老旧上下文独有标记。':'以前聊过的小事。',reply:i===0?'以前那张照片在别处拍的。':'那是之前的一件事。'});
  focus=f.app.store.saveChatTurn({role:'miyue',text:'现在照片呢',reply:'这次的照片里有蓝色凳子和花猫。'}).at(-1).id;
  const result=await f.chat('那个细节再说说。');assert.equal(result.status,200,JSON.stringify(result));
  const request=JSON.stringify(f.calls.find(c=>!c.semantic).body);assert.match(request,/老旧上下文独有标记/);assert.match(request,/蓝色凳子和花猫/);
  assert.equal(f.app.store.getMessages('miyue').length,44,'older originals remain stored');
});

test('desktop invitations have no user text to classify and retain the event-driven path',async t=>{
  const f=await fixture(t,{classify:()=>{throw Error('must not classify gestures');},reply:'我刚好想和你说句话。'});
  const result=await f.request('/api/desktop/attention',{requestId:'semantic-desktop',level:'care'});
  assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.calls.filter(c=>c.semantic).length,0);
  assert.ok(result.messages.every(row=>row.speaker==='assistant'));
});


test('delivered recall keeps the direct answer when its supported paraphrase has no long literal overlap', async t=>{
 const f=await fixture(t,{classify:text=>decision(text,{intent:'recall',retrievalQuery:'拼图 边框'}),reply:'你昨天说的是先拼边框，中间那片天空留到今天。'});
 f.app.store.saveChatTurn({role:'miyue',text:'我买了一副海边的拼图，打算先找边框。',reply:'那片蓝天看着挺难拼。'});
 f.app.store.saveChatTurn({role:'miyue',text:'今晚拼完边框就算了，中间那片天空留到明天。',reply:'嗯，留到明天。'});
 const r=await f.chat('对了，我昨天说拼图先拼哪一部分来着？');
 assert.equal(r.status,200,JSON.stringify(r));assert.match(r.messages.at(-1).text,/先拼边框/);
 assert.equal(f.calls.length,2);
 assert.ok(f.app.interactionPolicy.receipt(r.messages.at(-1).id).warnings.includes('recall_paraphrase_not_literal'));
});


test('a user coffee update does not restore an old character work memory with the same word', async t=>{
 const f=await fixture(t,{classify:text=>decision(text,{intent:text.startsWith('你')?'recall':'respond',ownLife:text.startsWith('你'),retrievalQuery:'咖啡 包装'}),reply:'听着是想换一下节奏。'});
 f.app.store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at) VALUES(?,?,?,?,?,?)').run('old-work-coffee','miyue','assistant','改包装时喝了杯咖啡，瓶盖采用记忆独有蓝色。','chat','2026-08-01T01:00:00Z');
 const source=f.app.store.db.prepare('SELECT rowid,* FROM messages WHERE id=?').get('old-work-coffee');
 f.app.recallRepo.consolidated.apply('miyue',{expectedRevision:0,fromCursor:source.rowid-1,through:{rowid:source.rowid,id:source.id},rows:[source],candidates:[{subject:'character',kind:'event',topic:'包装咖啡',summary:source.text,status:'past',evidence:[{messageId:source.id,quote:source.text}]}],ignored:[],now:clock().toISOString(),model:'fixture'});
 for(let i=0;i<13;i++)f.app.store.saveChatTurn({role:'miyue',text:'最近聊过别的事情。',reply:'这个也挺有意思。'});
 let r=await f.chat('我刚开完会，想买杯咖啡。');assert.equal(r.status,200,JSON.stringify(r));
 assert.doesNotMatch(JSON.stringify(f.calls.find(c=>!c.semantic).body),/记忆独有蓝色/);
 r=await f.chat('你以前那个包装喝咖啡的事呢？');assert.equal(r.status,200,JSON.stringify(r));
 assert.match(JSON.stringify(f.calls.filter(c=>!c.semantic).at(-1).body),/记忆独有蓝色/);
});


test('validated conversation preference reaches the next request even when the reply omits all extraction fields',async t=>{
  const preference='不用分析，就陪我随便说两句。';
  const f=await fixture(t,{classify:text=>decision(text,{intent:text===preference?'conversation_preference':'user_update'}),reply:'好，我收着点。'});
  // The fixture clock, including saved source rows, must agree before afterSave.
  const save=f.app.store.saveChatTurn.bind(f.app.store);
  f.app.store.saveChatTurn=options=>save({...options,afterSave:rows=>{
    for(const row of rows){f.app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(clock().toISOString(),row.id);row.createdAt=clock().toISOString();}
    options.afterSave?.(rows);
  }});
  const tuning=f.app.companionTuning.get();
  const first=await f.chat(preference);assert.equal(first.status,200,JSON.stringify(first));
  const second=await f.chat('刚才我去倒了杯水。');assert.equal(second.status,200,JSON.stringify(second));
  const actual=f.calls.filter(call=>!call.semantic);assert.equal(actual.length,2);assert.equal(f.calls.filter(call=>call.semantic).length,2);
  const background=actual[1].body.messages.find(message=>message.content.startsWith('【本轮背景开始】')).content;
  assert.ok(background.includes('用户偏好原话：“'+preference+'”'));
  assert.deepEqual(f.app.companionTuning.get(),tuning);
});

test('validated broad article request survives a news qualifier and binds later source questions',async t=>{
 const f=await fixture(t,{classify:text=>text.includes('出处')?decision(text,{intent:'ask_question',continuity:'continue',focusMessageId:'r1',source:'current',sourceRequest:null,retrievalQuery:'游泳'}):decision(text,{intent:'ask_question',source:'new',sourceRequest:{kind:'article',query:''}}),reply:'我看到《游泳训练的长期记录》，它比较多次配速变化。来源：https://example.test/long-swim'});
 const feed=f.app.store.addFeed('https://example.test/rss','原始媒体');
 f.app.store.addContent(feed,[{title:'游泳训练的长期记录',url:'https://example.test/long-swim',summary:'作者记录每次游泳训练的距离、划水次数与配速，把同一个人的多次记录放在一起观察动作改变。设备也会有误差，所以作者没有用单次数字评价训练结果，而是观察持续的变化以及不同训练强度下的恢复情况。',publishedAt:'2026-07-01T00:00:00Z'}],feed.title);
 const first=await f.chat('有没有什么你最近看到、想跟我聊的文章？不一定是新闻。');
 assert.equal(first.status,200,JSON.stringify(first));assert.equal(f.calls.length,2);
 assert.match(JSON.stringify(f.calls.find(c=>!c.semantic).body),/游泳训练的长期记录/);
 assert.equal(first.messages.at(-1).sourceUrl,'https://example.test/long-swim');
 const next=await f.chat('出处是哪？');assert.equal(next.status,200,JSON.stringify(next));
 assert.equal(f.calls.length,4);assert.match(JSON.stringify(f.calls.at(-1).body),/游泳训练的长期记录/);
});

test('missing requested source is a stored outcome while constrained dialogue remains available',async t=>{
 const reply='我这里没有能核实出处的陶瓷文章，所以不编标题或链接；不过可以先聊你更想看器物、工艺，还是历史。';
 const f=await fixture(t,{classify:text=>decision(text,{intent:'ask_question',source:'new',sourceRequest:{kind:'article',query:'陶瓷'}}),reply});
 for(const text of ['找篇陶瓷的文章吧','还是想看看陶瓷的文章']){
  const result=await f.chat(text);assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(result.messages.at(-1).text,reply);
  assert.ok(!result.messages.at(-1).sourceUrl);
  const behavior=f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior;
  assert.equal(behavior.sourceOutcome,'unavailable');assert.deepEqual(behavior.sourceContextIds,[]);assert.equal(behavior.usedSourceId,null);
  const prompt=f.calls.filter(call=>!call.semantic).at(-1).body.messages.map(message=>message.content).join('\n');
  assert.match(prompt,/【本轮来源状态】/);assert.match(prompt,/没有符合这次请求的可核实来源/);assert.match(prompt,/不能凭角色的模糊印象编出.*链接/);
 }
 assert.equal(f.calls.filter(c=>c.semantic).length,2);assert.ok(f.calls.filter(c=>!c.semantic).length>=2,'each turn reaches body generation; a style retry may add one call');
});

test('validated explicit article opt-out remains an ordinary response',async t=>{
 const f=await fixture(t,{classify:text=>decision(text,{intent:'conversation_preference',sourceRequest:null})});
 const result=await f.chat('别聊文章或者新闻了，我只想跟你说说话。');
 assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.calls.length,2);
 assert.doesNotMatch(result.messages.at(-1).text,/没有找到符合/);
});

for(const text of ['我想听你说','说说看嘛','展开说说'])test(`an elliptical request elaborates the selected exchange without granting unrelated life material: ${text}`,async t=>{
 const f=await fixture(t,{classify:input=>decision(input,{intent:'ask_question',continuity:'continue',focusMessageId:'r1',ownLife:true,sourceRequest:null}),reply:'我更喜欢他们没有和解的那个版本，停在还没说出口的地方也成立。'});
 const rows=f.app.store.saveChatTurn({role:'miyue',text:'短片最后突然和解，你喜欢那个结尾吗？',reply:'最后两页像突然踩了油门。'});
 for(const row of rows)f.app.store.db.prepare('UPDATE messages SET created_at=? WHERE id=?').run(clock().toISOString(),row.id);
 const result=await f.chat(text);assert.equal(result.status,200,JSON.stringify(result));assert.equal(f.calls.length,2);
 const plan=f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior.turnPlan;
 assert.equal(plan.mode,'continue');assert.equal(plan.allowOptionalMaterial,false);assert.deepEqual(plan.focus.messageIds,[rows.at(-1).id]);
 assert.match(JSON.stringify(f.calls.at(-1).body.messages),/短片最后突然和解/);
 assert.ok(!plan.focus.title,'a random daily event cannot replace the conversation focus');
});


test('source explanation questions survive zero-budget delivery without repair or dangling consequences',async t=>{
 const reply='介绍只说角色可能认错人，具体操作还没展开。他认错人，你跟不跟？跟了可能整条线走偏，所以我会先交叉看证词。出处：https://example.test/question';
 const f=await fixture(t,{classify:text=>decision(text,{intent:'ask_question',source:'new',sourceRequest:{kind:'article',query:'推理游戏'}}),reply});
 const feed=f.app.store.addFeed('https://example.test/feed','游戏资料');
 f.app.store.addContent(feed,[{title:'推理游戏的认知差异',url:'https://example.test/question',summary:'这篇游戏介绍解释角色可能因为认知差异而认错人，玩家需要搜集线索并交叉比较证词。公开资料尚未提供具体操作细节，也不能据此断言所有角色的情况相同。',publishedAt:clock().toISOString()}],feed.title);
 const result=await f.chat('介绍一篇关于推理游戏的文章。');assert.equal(result.status,200,JSON.stringify(result));
 const delivered=result.messages.at(-1),receipt=f.app.interactionPolicy.receipt(delivered.id);
 assert.equal(receipt.questionBudget,0);assert.equal(receipt.questionCount,1);assert.ok(receipt.warnings.includes('question_punctuation_over_budget'));
 assert.match(delivered.text,/他认错人，你跟不跟？\n跟了可能整条线走偏/);
 assert.equal(f.calls.filter(c=>!c.semantic).length,1,'punctuation must not trigger a full body repair');
 assert.ok(!receipt.repairs.includes('limited_questions'));
});

test('recall route keeps substantive questions and does not regenerate solely to remove a question mark',async t=>{
 const reply='你选的是蓝色，还是浅灰色？这两种当时都提到了，我不想替你猜。';
 const f=await fixture(t,{classify:text=>decision(text,{intent:'recall',continuity:'continue',focusMessageId:'r1'}),reply});
 f.app.store.saveChatTurn({role:'miyue',text:'我在比较蓝色和浅灰色的杯子，还没决定。',reply:'蓝色更显眼，浅灰色比较耐看。'});
 const result=await f.chat('我上次选了哪种颜色？');assert.equal(result.status,200,JSON.stringify(result));
 assert.equal(result.messages.at(-1).text,reply.replace('？','？\n'));
 assert.equal(f.calls.filter(c=>!c.semantic).length,1);
});

test('ordinary knowledge questions reach generation with an empty local source library',async t=>{
 for(const text of ['吃的老姜仔鸡，你知道是哪里的菜么','为什么海水是咸的？','《红楼梦》的作者是谁？'])await t.test(text,async t=>{
  const f=await fixture(t,{classify:current=>decision(current,{intent:'ask_question',source:'none'}),reply:'这可以按常识聊，具体做法也可能有地域差异。'});
  assert.equal(f.app.store.listContent().length,0);
  const result=await f.chat(text);
  assert.equal(result.status,200,JSON.stringify(result));
  assert.equal(f.calls.length,2,'ordinary knowledge uses understanding plus normal answer generation');
  assert.doesNotMatch(result.messages.at(-1).text,/资料我还没核对|给不了准确/);
  const prompt=f.calls.find(call=>!call.semantic).body.messages.map(m=>m.content).join('\n');
  assert.match(prompt,/本轮是普通知识问答/);
  assert.match(prompt,/不装作已经搜索核实/);
 });
});

test('an unbound exact book-record request gets a natural constrained answer without metadata pollution', async t => {
 const reply='我现在没有能核实的确切书名和目录，所以先不替它补内容。';
 const f=await fixture(t,{classify:text=>decision(text,{intent:'ask_question',continuity:'continue',focusMessageId:'r1',source:'new',retrievalQuery:'京都老铺',evidence:'确切书名和目录',sourceRequest:{kind:'reference',query:'京都老铺'}}),reply:{reply,extra:'',experience:{kind:'reading',title:'京都老铺目录',summary:'整理过这本书的目录。',evidence:'我现在没有能核实的确切书名和目录'},companionship:{agenda:[{action:'propose',kind:'chat',source:'assistant',title:'京都老铺书目',owner:'joint',evidence:'我现在没有能核实的确切书名和目录'}]}}});
 const relationshipBefore=f.app.companionRelationship.view('miyue'),agendaBefore=f.app.companionAgenda.view('miyue');
 const result=await f.chat('那本讲京都老铺的书，能查确切书名和目录吗？');
 assert.equal(result.status,200,JSON.stringify(result));
 assert.equal(f.calls.length,2,'unavailable public records still permit one constrained body call');
 assert.equal(result.messages.at(-1).text,reply);
 const request=f.calls.find(call=>!call.semantic).body.messages.map(message=>message.content).join('\n');assert.match(request,/【本轮来源状态】/);assert.match(request,/没有符合这次请求的可核实来源/);
 const behavior=f.app.interactionPolicy.receipt(result.messages.at(-1).id).behavior;assert.equal(behavior.sourceOutcome,'unavailable');assert.deepEqual(behavior.sourceContextIds,[]);assert.equal(behavior.usedSourceId,null);
 assert.deepEqual(f.app.personalExperiences.list('miyue'),[],'unavailable-source annotations cannot create a personal experience');
 const relationshipAfter=f.app.companionRelationship.view('miyue');assert.deepEqual(relationshipAfter.preferences,relationshipBefore.preferences);assert.deepEqual(relationshipAfter.boundaries,relationshipBefore.boundaries);assert.deepEqual(relationshipAfter.sharedReferences,relationshipBefore.sharedReferences,'unavailable-source annotations cannot create relationship facts');assert.deepEqual(f.app.companionAgenda.view('miyue'),agendaBefore,'unavailable-source annotations cannot create plans');
});
