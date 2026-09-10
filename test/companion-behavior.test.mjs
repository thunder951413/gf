import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createApp} from '../server.mjs';import {CompanionBehavior,companionIntent} from '../lib/companion-behavior.mjs';import {TUNING_DEFAULTS} from '../lib/companion-tuning.mjs';
async function setup(t,answers=[]){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'behavior-test-')),calls=[];const app=await createApp({dataDir:dir,initialFeeds:[],startPursuits:true,startProactive:false,startRecall:false,lifeRandom:()=>.99,replySleep:async()=>{},env:{LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture'},fetchImpl:async(_url,init)=>{const body=JSON.parse(init.body);calls.push(body);return Response.json({choices:[{message:{content:answers[Math.min(calls.length-1,answers.length-1)]||JSON.stringify({reply:'我喜欢这种自在的感觉。',extra:'',signals:{}})}}]});}});const {port}=await app.listen(0);t.after(async()=>{await app.close();fs.rmSync(dir,{recursive:true,force:true})});return{app,calls,chat:async text=>{const r=await fetch(`http://127.0.0.1:${port}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:'miyue',text})});return{status:r.status,...await r.json()}}};}
test('intent follows user clarification, topic handoff, invitation and rejection rather than old assistant stance',()=>{
 assert.equal(companionIntent('去那边干嘛？').kind,'clarify');assert.equal(companionIntent('没什么想聊的，但是愿意听你说话').kind,'share');
 assert.equal(companionIntent('所以你愿意吗',[{speaker:'user',text:'你愿意做我的月球吗'},{speaker:'assistant',text:'我们刚认识'}]).kind,'receive_closeness');
 assert.equal(companionIntent('今天别撒娇，就当普通朋友聊吧').kind,'boundary');assert.equal(companionIntent('你愿意做我的老师吗').invitation,false);
});
test('emotional requests keep priority when the same message also hands over the topic',async t=>{
 const {app,chat}=await setup(t,[JSON.stringify({reply:'今天累着了，就在这里歇会儿，我陪你。',extra:''})]);
 app.companionTuning.set({pleasing:100,warmth:100,flirtation:100,coyness:100},0);
 const before=app.companionTuning.get();const thread=app.lifeThreads.get('miyue');const pursuit=app.pursuits.get('miyue');
 assert.equal(companionIntent('今天很累，想听你说话，哄哄我').kind,'affection_reply');
 const result=await chat('今天很累，想听你说话，哄哄我');assert.equal(result.status,200);
 assert.match(result.messages.at(-1).text,/我陪你/);assert.ok(!result.messages.at(-1).text.includes(thread.beat.text));assert.ok(!result.messages.at(-1).text.includes(pursuit.stage.action));
 const receipt=app.interactionPolicy.receipt(result.messages.at(-1).id);
 assert.equal(receipt.behavior.intent,'affection_reply');assert.equal(receipt.behavior.comfort,true);assert.equal(receipt.behavior.style.warmth,'柔软体贴');assert.equal(receipt.behavior.style.stance,'偏爱迁就小偏好');
 assert.deepEqual(app.companionTuning.get(),before);assert.equal(app.pursuits.get('miyue').history.length,0);
});
test('explicit coyness still works when a reading topic is present',async t=>{
 const {app,chat}=await setup(t,[JSON.stringify({reply:'那先把书合上，软一点跟你说。',extra:'今天想多赖着你一小会儿，分点注意力给我嘛。'})]);
 const before=app.pursuits.get('miyue');const result=await chat('百草园先放一放，撒个娇给我听');assert.equal(result.status,200);
 assert.match(result.messages.at(-1).text,/赖着你/);assert.equal(app.interactionPolicy.receipt(result.messages.at(-1).id).behavior.extra,'tender');assert.equal(app.pursuits.get('miyue').pendingKey,before.pendingKey);
});
test('a distancing draft is retried once and the delivered response directly receives the invitation',async t=>{
 const {app,calls,chat}=await setup(t,[JSON.stringify({reply:'我们刚认识，先从普通朋友做起。'}),JSON.stringify({reply:'你抬头想到我的时候，我也想听你说一说。',extra:''})]);const result=await chat('你愿意做我的月球吗');assert.equal(result.status,200);assert.equal(calls.length,2);assert.match(result.messages.at(-1).text,/^愿意呀/);assert.doesNotMatch(result.messages.at(-1).text,/刚认识/);assert.equal(app.interactionPolicy.receipt(result.messages.at(-1).id).behavior.retries,1);
});
test('two bad drafts never get committed and repair budget stays at one call',async t=>{
 const {app,calls,chat}=await setup(t,[JSON.stringify({reply:'听你说要出门，我也想去逛逛。'})]);const result=await chat('去那边干嘛？');assert.equal(result.status,422);assert.equal(calls.length,2);assert.equal(app.store.getMessages('miyue').length,0);assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM conversation_receipts').get().n,0);
});
test('explicit request for coyness selects a required act, delivered receipt is backed by actual text',async t=>{
 const {app,chat}=await setup(t,[JSON.stringify({reply:'那我就不装矜持了。',extra:'分一点点注意力给我嘛。'})]);app.companionTuning.set({coyness:0},0);const result=await chat('想听你撒一点娇，别太腻');assert.equal(result.status,200);assert.match(result.messages.at(-1).text,/分一点点/);assert.equal(app.interactionPolicy.receipt(result.messages.at(-1).id).behavior.extra,'tender');
});
test('unplanned extra is omitted rather than making every reply coy',async t=>{
 const {chat}=await setup(t,[JSON.stringify({reply:'这句话是在解释刚才的提议。',extra:'快来抱抱我嘛。'})]);const result=await chat('你刚才是什么意思？');assert.equal(result.status,200);assert.doesNotMatch(result.messages.at(-1).text,/抱抱/);
});
test('each expressive slider changes its programmed opportunity and cooldown prevents consecutive requests',()=>{
 for(const [field,kind]of [['playfulness','playful'],['coyness','tender'],['optimism','hopeful'],['independence','perspective'],['flirtation','affection']]){
  function count(value){let turn=4;let history=[];let count=0;const store={db:{prepare:sql=>sql.startsWith('SELECT payload')?{all:()=>history.map(behavior=>({payload:JSON.stringify({behavior})}))}:{get:()=>({n:turn})}}};const values={...Object.fromEntries(Object.keys(TUNING_DEFAULTS).map(k=>[k,0])),[field]:value};const planner=new CompanionBehavior(store,{get:()=>({values})});for(;turn<404;turn++){const p=planner.plan({scope:'miyue',intent:'respond'},'刚看完一本书，有个小想法。',{inner:{affectionAllowed:true,intimacyBoundary:'open'}});if(p.behavior.extra===kind){count++;if(['tender','affection'].includes(kind))assert.ok(!history.slice(0,3).some(p=>p.extra===kind));}history=[p.behavior,...history].slice(0,12);}return count;}
  assert.equal(count(0),0,field);assert.ok(count(100)>20,field);
 }
});
test('warmth changes delivery guard, pleasing changes comfort load, and unrelated life project stays out of prompt',async t=>{
 const {app,chat,calls}=await setup(t,[JSON.stringify({reply:'你必须听我的。我把话说慢一点。',extra:''})]);app.companionTuning.set({warmth:100,pleasing:100},0);let result=await chat('我今天有点累，不想做决定。');assert.doesNotMatch(result.messages.at(-1).text,/必须/);assert.doesNotMatch(JSON.stringify(calls[0]),/当前个人项目|色卡|预算说明|讨好倾向 100/);assert.match(JSON.stringify(calls[0]),/偏爱迁就小偏好/);assert.ok(calls[0].messages[0].content.length<3000);
 app.companionTuning.set({warmth:0,pleasing:0},1);result=await chat('说说看');assert.match(result.messages.at(-1).text,/必须/);
});

test('required extra cannot silently disappear during final question filtering',async t=>{
 const {app,chat,calls}=await setup(t,[JSON.stringify({reply:'那我软一点说。',extra:'能分一点点注意力给我吗？'}),JSON.stringify({reply:'那我软一点说。',extra:'分一点点注意力给我呀。'})]);app.interactionPolicy.set('miyue',{noQuestions:true});const r=await chat('想听你撒一点娇，别太腻');assert.equal(r.status,200);assert.equal(calls.length,2);assert.match(r.messages.at(-1).text,/分一点点注意力给我呀/);assert.equal(app.interactionPolicy.receipt(r.messages.at(-1).id).behavior.extra,'tender');
});
test('explicit recall finds uncategorized original preferences and honors removal, correction and role scope',async t=>{
 const {app}=await setup(t);const{lookupUserEvidence}=await import('../lib/memory-lookup.mjs');
 const coffee=app.store.saveChatTurn({role:'miyue',text:'喝咖啡呢，意式加奶',reply:'那配你隔空喝一杯。'});app.episodes.observe('miyue',coffee);
 app.store.saveChatTurn({role:'wenxi',text:'喝咖啡呢，独有标记秘密',reply:'记录这次讨论。'});
 let found=lookupUserEvidence(app.store,app.episodes,'miyue','还记得我怎么喝咖啡吗');assert.match(found.context,/意式加奶/);assert.doesNotMatch(found.context,/独有标记秘密/);assert.equal(found.rows[0].id,coffee[0].id);
 assert.equal(lookupUserEvidence(app.store,app.episodes,'miyue','今天聊咖啡').rows.length,0);
 const entry=app.episodes.remember('miyue',coffee.map(r=>r.id));app.episodes.correct('miyue',entry.id,'现在改喝清水了。');found=lookupUserEvidence(app.store,app.episodes,'miyue','还记得我怎么喝咖啡吗');assert.equal(found.rows.length,0);
});

test('unsourced reading and unsupported just-now recollections do not reach delivery',async t=>{const {app}=await setup(t);const p=app.interactionPolicy.plan('miyue','普通聊就好');p.noArticleClaim=true;const result=app.interactionPolicy.enforce('我翻了几篇关于苏州书店的文章。你刚说最近提不起劲。那就轻松点聊。',p);assert.equal(result.reply,'那就轻松点聊。');assert.ok(result.repairs.includes('removed_unsourced_reading'));assert.ok(result.repairs.includes('removed_unsupported_recall'));});

test('explicit coyness has an authored, history-free fallback after the one repair budget',async t=>{const {app,chat,calls}=await setup(t,[JSON.stringify({reply:'那我轻轻说。',extra:''})]);const r=await chat('想听你撒一点娇');assert.equal(r.status,200);assert.equal(calls.length,2);assert.match(r.messages.at(-1).text,/多叫我一声雨薇/);assert.equal(app.interactionPolicy.receipt(r.messages.at(-1).id).behavior.authoredFallback,true);});

test('ordinary companion talk does not attach an old article',async t=>{const{app,chat,calls}=await setup(t);const feed=app.store.addFeed('https://source.test/rss','旧资料');app.store.addContent(feed,[{title:'旧文章独有标记',url:'https://source.test/a',summary:'这是旧文章独有标记正文，只在继续讨论它时才应发送。'}]);const content=app.store.listContent()[0];app.store.saveChatTurn({role:'miyue',text:'聊聊这篇',reply:'这篇资料有自己的背景。',contentId:content.id});await chat('今天有点累，陪我待一会儿');assert.doesNotMatch(JSON.stringify(calls[0]),/旧文章独有标记/);await chat('这篇文章的出处是什么？');assert.match(JSON.stringify(calls[1]),/旧文章独有标记/);});

test('background sources require current topic relevance and explicit affection skips unrelated episodic retrieval',async t=>{
 const {selectLifeContent}=await import('../lib/life-content.mjs');const items=[{title:'苏州旅游资料独有标记',summary:'苏州美食与旅行见闻。'.repeat(900),url:'https://source.test/travel'}],topic={sourceHints:['苏州','美食'],publicQuery:'苏州 美食',travel:true};
 assert.equal(selectLifeContent(items,topic,{text:'软软地撒一点娇吧',requireCurrentTopic:true}).length,0);
 assert.equal(selectLifeContent(items,topic,{text:'当地有哪些美食？',requireCurrentTopic:true,limit:1}).length,1);
 const{app,chat,calls}=await setup(t,[JSON.stringify({reply:'我就软一点说。',extra:'多叫我一声雨薇嘛。'})]);const rows=app.store.saveChatTurn({role:'miyue',text:'我喜欢软软的桂花糕',reply:'糕点旧话题独有标记。'});app.episodes.remember('miyue',rows.map(m=>m.id));await chat('软软地撒一点娇吧');const result=calls[0].messages.find(m=>m.content.startsWith('【本轮背景开始】'));assert.doesNotMatch(result.content,/糕点旧话题独有标记|共同经历证据/);assert.match(JSON.stringify(calls[0]),/我喜欢软软的桂花糕/);
});

test('recall answer bundled with a question is repaired before filtering can drop the answer',async t=>{const{chat,calls}=await setup(t,[JSON.stringify({reply:'你在北京。咖啡是意式加奶，没记错吧？'}),JSON.stringify({reply:'你在北京，喝咖啡是意式加奶。'})]);const r=await chat('你还记得我在哪个城市，怎么喝咖啡吗？');assert.equal(r.status,200);assert.equal(calls.length,2);assert.match(r.messages.at(-1).text,/北京.*意式加奶/);});

test('implicit affection never requires a literal romantic keyword to deliver the ordinary response',async t=>{const{app}=await setup(t);const plan=app.interactionPolicy.plan('miyue','今天我调了一杯柠檬薄荷水');plan.behavior={extra:'affection',explicit:false};const reply='薄荷水加鲜柠檬，白白的汁水看着就清凉。';for(const extra of ['隔着屏幕，倒也有点想尝一口你调的这杯夏天了。','秋天要是有你一起慢慢喝口热汤，应该会很温柔。']){assert.deepEqual(app.companionBehavior.assess(reply,extra,plan),[]);assert.ok(app.interactionPolicy.enforce(app.companionBehavior.compose(reply,extra,plan),plan).reply.includes(extra));}assert.ok(app.companionBehavior.assess(reply,'',plan).includes('missing_or_long_extra'));});

test('editable liking and mood constrain autonomous expressive beats while explicit affection remains available',async t=>{
 const {app}=await setup(t);for(let i=0;i<3;i++)app.store.saveChatTurn({role:'miyue',text:'普通近况'+i,reply:'我听着呢。'});
 app.companionTuning.set({coyness:100,flirtation:100,playfulness:100,optimism:0,independence:0},0);
 const base={intent:'respond',questionBudget:1};let highCount=0;
 for(let i=0;i<80;i++){
  const text='今天路上看见一只猫'+i;
  const low=app.companionBehavior.plan(base,text,{inner:{affection:10,mood:20,affectionAllowed:true}});
  assert.equal(low.behavior.extra,null);
  const high=app.companionBehavior.plan(base,text,{inner:{affection:90,mood:90,affectionAllowed:true}});
  if(high.behavior.extra)highCount++;
 }
 assert.ok(highCount>0);
 const invited=app.companionBehavior.plan(base,'撒个娇给我听',{inner:{affection:10,mood:20,affectionAllowed:false}});
 assert.equal(invited.behavior.extra,'tender');assert.equal(invited.suppressInitiatedAffection,false);
});

test('affection stays warm without inventing physical arrival at her location',async t=>{
 const {calls,chat}=await setup(t,[JSON.stringify({reply:'你过来挨着我坐就行。',extra:''}),JSON.stringify({reply:'抱抱你。今天辛苦了，想靠一会儿的话我陪你聊着，不用急着说什么。',extra:''})]);
 const result=await chat('今天有点累，想抱抱你。');assert.equal(result.status,200);assert.equal(calls.length,2);assert.doesNotMatch(result.messages.at(-1).text,/过来挨着/);assert.match(result.messages.at(-1).text,/抱抱你/);
});

test('proactive drafts cannot invent visiting the user home',()=>{
 const planner=new CompanionBehavior({},{}),plan={behavior:{initiating:true,explicit:false}};
 assert.ok(planner.assess('昨天从你家那边走回来的时候，看到桂花开了。','',plan).includes('invented_offline_presence'));
 assert.deepEqual(planner.assess('昨天在路边看到了桂花，想起和你聊过秋天。','',plan),[]);
});
