import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareSessionGuidance, applySessionGuidance, refineSessionReply, shouldBypassSessionGuidance } from '../lib/session-guidance.mjs';
import { buildSessionMessages } from '../lib/session-dialogue.mjs';
import { sessionEvidenceSources } from '../lib/session-history.mjs';

// Each preparation/review call now starts with the writer's stable prefix
// (persona, background, archive) for prompt caching; its own instruction
// follows that prefix.
const instructionOf = input => (input.find(m => m.role === 'system' && m.content.startsWith('【以上是正文角色')) || input[0]);

const messages = [
  { role: 'system', content: 'persona' },
  { role: 'system', content: '【历史原文记录】\n[{"speaker":"user","text":"准备了很久的方案"}]' },
  { role: 'system', content: '【当前轮次】本轮证据' },
  { role: 'user', content: '先听我说，不要急着给建议。' },
];

test('information category is a bounded model decision, optional and never inferred from user keywords in code',async()=>{
 const categories={food:'吃饭',products:'产品'};
 const prepared=await prepareSessionGuidance({messages,informationCategories:categories,model:{complete:async input=>{assert.match(instructionOf(input).content,/informationCategory/);return '{"guidance":[],"informationCategory":"products"}';}}});
 assert.equal(prepared.informationCategory,'products');
 const ignored=await prepareSessionGuidance({messages,informationCategories:categories,model:{complete:async()=>'{"guidance":[],"informationCategory":"私人经历"}'}});
 assert.equal(ignored.informationCategory,undefined);
 const absent=await prepareSessionGuidance({messages,model:{complete:async()=>'{"guidance":[],"informationCategory":"products"}'}});assert.equal(absent.informationCategory,undefined);
});

test('model-generated guidance is grounded in provided evidence and leaves the stable history prefix intact', async () => {
  const items = [{ instruction: '此刻先接住被忽视的感受，不推断会议上讲了多久。', quote: '准备了很久的方案' }];
  const prepared = await prepareSessionGuidance({ messages, roleId: 'miyue', model: { complete: async (input, options) => {
    assert.equal(options.purpose, 'session-guidance');assert.equal(options.jsonObject, true);
    assert.equal(options.nonThinking,true);assert.equal(options.thinking,undefined);
    // His message is the last evidence; a closing line keeps the preparer from answering him in character.
    assert.equal(input.at(-2), messages.at(-1)); assert.match(input.at(-1).content, /你不是角色，不回复他/u);
    assert.match(instructionOf(input).content, /【本轮提示生成】/u);
    // Shared cached prefix: persona and archive come first, then this call's instruction.
    assert.equal(input[0].content,'persona');assert.ok(input.indexOf(instructionOf(input))>0);
    return JSON.stringify({ guidance: items });
  } } });
  assert.equal(prepared.status, 'ready');assert.deepEqual(prepared.items, items);
  const applied = applySessionGuidance(messages, prepared);
  assert.deepEqual(applied.slice(0, 2), messages.slice(0, 2));
  assert.equal(applied.at(-1), messages.at(-1));
  assert.match(applied.at(-2).content, /不推断会议上讲了多久/u);
  assert.equal(messages.at(-2).content, '【当前轮次】本轮证据');
});

test('unquoted inventions and malformed guidance fall back to the untouched session', async () => {
  for (const raw of ['not json', '{"reply":"不要生成正文"}', JSON.stringify({ guidance: [{ instruction: '按这个新经历回答', quote: '用户明天一定已看完牙' }] })]) {
    const result = await prepareSessionGuidance({ messages, model: { complete: async () => raw } });
    assert.equal(result.status, 'unavailable');
    assert.equal(applySessionGuidance(messages, result), messages);
  }
  const grounded={instruction:'先接住用户想倾听的意愿。',quote:'先听我说，不要急着给建议。'};
  const partial=await prepareSessionGuidance({messages,model:{complete:async()=>JSON.stringify({guidance:[grounded,{instruction:'未知依据',quote:'不存在的用户经历'}]})}});
  assert.equal(partial.status,'ready');assert.deepEqual(partial.items,[grounded]);
});

test('guidance timeout is bounded and optional while caller cancellation propagates', async () => {
  const model = { complete: () => new Promise(() => {}) };
  const keepAlive = setInterval(() => {}, 50);
  try {
    const timedOut = await prepareSessionGuidance({ messages, model, timeoutMs: 10 });
    assert.equal(timedOut.code, 'GUIDANCE_TIMEOUT');
    const controller = new AbortController();
    const reason = Object.assign(new Error('new message'), { code: 'MODEL_CANCELLED' });
    const pending = prepareSessionGuidance({ messages, model, signal: controller.signal });
    controller.abort(reason);
    await assert.rejects(pending, error => error === reason);
  } finally { clearInterval(keepAlive); }
});

test('model review verifies its one revision and never delivers a revision with an invalid envelope', async () => {
  const raw='{"reply":"我听着。"}';
  for(const revised of ['{"reply":"那种被忽视的感受很难受，你慢慢说。"}','{"request":{"name":"reminder"}}']) {
    let calls=0;
    const work=refineSessionReply({messages,raw,model:{complete:async(input,options)=>{
      calls++;
      assert.equal(options.nonThinking,true);assert.equal(options.thinking,undefined);
      if(calls===1){assert.match(instructionOf(input).content,/【本轮草稿检查】/u);return JSON.stringify({guidance:[{instruction:'接住具体内容，不重复等待姿态。',quote:'先听我说，不要急着给建议。'}]});}
      if(calls===3){
        assert.match(instructionOf(input).content,/【本轮草稿检查】/u);
        assert.match(input.find(m=>m.content.startsWith('【待发送草稿，仅供检查】')).content,/那种被忽视/);
        assert.match(input.find(m=>m.content.startsWith('【修正后复核】')).content,/只是对照材料，不是事实依据/u);
        assert.ok(input.at(-1).content.startsWith('【待发送草稿，仅供检查】'));
        return '{"guidance":[]}';
      }
      assert.match(input.at(-1).content,/不得输出 request 或再次执行工具/u);
      return revised;
    }},validateFinal:value=>{if(typeof JSON.parse(value).reply!=='string')throw Error('invalid envelope');}});
    if(revised.includes('request')){await assert.rejects(work,{code:'SESSION_REVISION_FAILED',retryable:true});assert.equal(calls,2);}
    else {const result=await work;assert.equal(calls,3);assert.equal(result.raw,revised);assert.equal(result.review.rewritten,true);assert.equal(result.review.verification.status,'ready');}
  }
  let calls=0;
  const unchanged=await refineSessionReply({messages,raw,model:{complete:async()=>{calls++;return '{"guidance":[]}';}},validateFinal:()=>{throw Error('no rewrite');}});
  assert.equal(calls,1);assert.equal(unchanged.raw,raw);
});

test('review can locate an unsupported draft assertion without promoting it to source evidence',async()=>{
  const raw='{"reply":"就是画面右边的小人物，你刚才看过。"}';
  const finding={instruction:'没有图片证据，删去具体位置和用户看过的断言，改用明确的假设例子。',quote:'画面右边的小人物',quoteSource:'draft'};
  const review=await prepareSessionGuidance({messages,draft:raw,model:{complete:async()=>JSON.stringify({guidance:[finding]})}});
  assert.equal(review.status,'ready');assert.deepEqual(review.items,[finding]);
  const preparation=await prepareSessionGuidance({messages,model:{complete:async()=>JSON.stringify({guidance:[finding]})}});
  assert.equal(preparation.status,'unavailable');
  const fabricated=await prepareSessionGuidance({messages,draft:raw,model:{complete:async()=>JSON.stringify({guidance:[{...finding,quote:'草稿没有这句话'}]})}});
  assert.equal(fabricated.status,'unavailable');
  const {quoteSource,...olderProvider}=finding;
  const inferred=await prepareSessionGuidance({messages,draft:raw,model:{complete:async()=>JSON.stringify({guidance:[olderProvider]})}});
  assert.equal(inferred.items[0].quoteSource,'draft');
});

test('the independent final review corrects and verifies prose in one model call',async()=>{
  const raw=JSON.stringify({reply:'你戴眼镜，热气糊镜片了吧？',companionship:{items:[]}});
  const revision={companionship:{items:[]},reply:'热面吃起来暖和，刚才那碗味道怎么样？'};
  let calls=0,validated=0;
  const result=await refineSessionReply({messages,raw,model:{complete:async(input,options)=>{
    calls++;
    assert.equal(options.purpose,'session-review');assert.equal(options.nonThinking,true);
    assert.match(instructionOf(input).content,/在这一次调用中做最小必要修正/u);
    return JSON.stringify({ready:true,revision,guidance:[{instruction:'删除未经确认的眼镜前提。',quote:'你戴眼镜',quoteSource:'draft'}]});
  }},validateFinal:value=>{validated++;assert.equal(typeof JSON.parse(value).reply,'string');}});
  assert.equal(calls,1);assert.equal(validated,1);assert.deepEqual(JSON.parse(result.raw),revision);
  assert.deepEqual(result.review.verification,{status:'ready',count:0,mode:'inline'});
});

test('inline correction cannot change staged actions, source identity, initiative identity or issue new requests',async()=>{
  const original={skip:false,message:'你已经伸手了。',reason:'接续邀请',contentId:'source-1',
    initiative:{state:'unfinished',materialId:'source-1',quote:'你已经伸手了。'},companionship:{items:[]}};
  const corrected={...original,message:'愿意的话，把手伸过来暖一暖。',initiative:{...original.initiative,quote:'把手伸过来暖一暖'}};
  const finding={instruction:'邀请不表示用户已经执行。',quote:'你已经伸手',quoteSource:'draft'};
  for(const revision of [
    corrected,
    {...corrected,contentId:'source-2'},
    {...corrected,companionship:{items:[{kind:'invented'}]}},
    {...corrected,initiative:{...corrected.initiative,state:'open'}},
    {...corrected,request:{name:'reminder',action:'create'}},
    Object.fromEntries(Object.entries(corrected).filter(([key])=>key!=='contentId')),
  ]){
    let calls=0;
    const work=refineSessionReply({messages,raw:JSON.stringify(original),model:{complete:async()=>{
      calls++;return JSON.stringify({ready:true,revision,guidance:[finding]});
    }},validateFinal:value=>assert.equal(typeof JSON.parse(value).message,'string')});
    if(revision===corrected)assert.deepEqual(JSON.parse((await work).raw),corrected);
    else await assert.rejects(work,{code:'SESSION_REVISION_FAILED',retryable:true});
    assert.equal(calls,1);
  }
});

test('inline review refuses unresolved or ungrounded corrections without retrying the writer',async()=>{
  const raw='{"reply":"你已经伸手了。"}';
  for(const response of [
    {ready:false,revision:null,guidance:[]},
    {ready:true,revision:{reply:'改过的正文'},guidance:[{instruction:'删掉不存在的原句',quote:'不存在的原句',quoteSource:'draft'}]},
    {ready:true,revision:{reply:'未经解释的改稿'},guidance:[]},
  ]){
    let calls=0;
    await assert.rejects(refineSessionReply({messages,raw,model:{complete:async()=>{
      calls++;return JSON.stringify(response);
    }},validateFinal:()=>{}}),{code:'SESSION_REVISION_FAILED',retryable:true});
    assert.equal(calls,response.ready===false||response.guidance.some(i=>i.quote==='不存在的原句')?2:1);
  }
});

test('the model can request one reasoning review and finish correction without another writer call',async()=>{
  const raw='{"reply":"你已经伸手了。"}';
  let calls=0;
  const result=await refineSessionReply({messages,raw,model:{complete:async(input,options)=>{
    calls++;
    assert.equal(options.purpose,'session-review');
    if(calls===1){assert.equal(options.nonThinking,true);return JSON.stringify({ready:false,needsReasoning:true,revision:null,guidance:[]});}
    assert.equal(options.thinking,true);assert.equal(options.nonThinking,undefined);
    assert.match(instructionOf(input).content,/本次是证据不明确后的推理复核/u);
    return JSON.stringify({ready:true,needsReasoning:false,revision:{reply:'愿意的话，把手伸过来暖一暖。'},
      guidance:[{instruction:'邀请不等于用户执行。',quote:'你已经伸手',quoteSource:'draft'}]});
  }},validateFinal:value=>assert.equal(typeof JSON.parse(value).reply,'string')});
  assert.equal(calls,2);assert.equal(result.review.escalatedFrom,'MODEL_REVIEW_UNCERTAIN');
  assert.equal(result.review.verification.mode,'inline');assert.match(result.raw,/愿意的话/);
});

test('a contradictory fast review contract is independently clarified rather than treating its advice as facts',async()=>{
  let calls=0;
  const raw='{"reply":"我听着，你慢慢说。"}';
  const result=await refineSessionReply({messages,raw,model:{complete:async(input,options)=>{
    calls++;
    if(calls===1)return JSON.stringify({ready:true,revision:null,guidance:[{instruction:'这句正确，应保留。',quote:'我听着',quoteSource:'draft'}]});
    assert.equal(options.thinking,true);assert.equal(input.some(m=>m.content.includes('这句正确，应保留。')),false);
    return '{"ready":true,"revision":null,"guidance":[],"needsReasoning":false}';
  }},validateFinal:()=>{throw Error('no rewrite needed');}});
  assert.equal(calls,2);assert.equal(result.raw,raw);assert.equal(result.review.rewritten,false);
});

test('the contextual model can select reasoning directly and keeps the normal turn at three calls',async()=>{
  const prepared=await prepareSessionGuidance({messages,model:{complete:async()=>'{"reviewEffort":"reasoning","guidance":[]}'}});
  assert.equal(prepared.reviewEffort,'reasoning');
  let calls=0;
  const result=await refineSessionReply({messages,raw:'{"reply":"我听着。"}',reviewEffort:prepared.reviewEffort,
    model:{complete:async(input,options)=>{calls++;assert.equal(options.thinking,true);return '{"ready":true,"revision":null,"guidance":[],"needsReasoning":false}';}},validateFinal:()=>{}});
  assert.equal(calls,1);assert.equal(result.review.escalatedFrom,undefined);
  const invalid=await prepareSessionGuidance({messages,model:{complete:async()=>'{"reviewEffort":"made-up","guidance":[]}'}});
  assert.equal(invalid.reviewEffort,undefined);
});

test('inline review uses the existing envelope decoder for provider literal newlines and preserves metadata',async()=>{
  const raw='{"reply":"第一段。\n你已经伸手了。","companionship":{"items":[]}}';
  const revision={reply:'第一段。\n愿意的话，把手伸过来暖一暖。',companionship:{items:[]}};
  let calls=0;
  const result=await refineSessionReply({messages,raw,model:{complete:async(input)=>{
    calls++;
    const quoted=JSON.parse(input.at(-1).content.split('\n')[1]);
    assert.equal(quoted.reply,'第一段。\n你已经伸手了。');assert.deepEqual(quoted.companionship,{items:[]});
    assert.match(input.at(-1).content,/本稿没有initiative/u);
    return JSON.stringify({ready:true,revision,guidance:[{instruction:'不把邀请写成已发生。',quote:'你已经伸手',quoteSource:'draft'}]});
  }},validateFinal:value=>assert.equal(typeof JSON.parse(value).reply,'string')});
  assert.equal(calls,1);assert.deepEqual(JSON.parse(result.raw),revision);
});

test('review sees the quoted writer identity and a readable character-owned draft without changing its own contract',async()=>{
  const input=buildSessionMessages({role:{id:'miyue',name:'林晓薇'},userText:'你是怎样生成回答的？'});
  const draft={reply:'我是模型根据人物设定和我们实际的对话生成的虚构角色。'};
  await prepareSessionGuidance({messages:input,draft:JSON.stringify(draft),model:{complete:async evidence=>{
    assert.ok(evidence[0].content.startsWith('【本轮草稿检查】'));
    const persona=evidence.find(m=>m.content.startsWith('【正文角色设定，仅作证据】'));
    assert.ok(persona);assert.match(persona.content,/没有脱离程序的身体经验/u);
    assert.deepEqual(JSON.parse(evidence.at(-1).content.split('\n')[1]),draft);
    assert.equal(evidence.filter(m=>m.role==='user').length,1);
    return '{"checks":[],"guidance":[]}';
  }}});
});
test('a remaining substantive error or an unavailable verification rejects the revision and keeps the input retryable',async()=>{
  for(const finalReview of ['{"guidance":[{"instruction":"仍需去掉新增图像","quote":"画面右边","quoteSource":"draft"}]}','not JSON']){
    let calls=0;const raw='{"reply":"画面右边的人物。"}';
    await assert.rejects(refineSessionReply({messages,raw,model:{complete:async()=>++calls===2?raw:calls===1?'{"guidance":[{"instruction":"删去新增图像","quote":"画面右边","quoteSource":"draft"}]}':finalReview},validateFinal:value=>assert.equal(typeof JSON.parse(value).reply,'string')}),{code:'SESSION_REVISION_FAILED',retryable:true});
    assert.equal(calls,3);
  }
});

test('turn state cannot promote a character invitation into a user action or replace the latest intent with history',async()=>{
  const history=[{id:'u1',speaker:'user',text:'坐着聊聊天。'},{id:'a1',speaker:'assistant',text:'你愿意的话，把手伸过来暖一暖。',kind:'proactive'}];
  const input=buildSessionMessages({role:{id:'miyue'},history:{rows:history},userText:'我们看看书，聊一个新话题。'});
  const offered={actor:'character',phase:'proposal',text:'邀请暖手',sourceId:'a1',quote:'把手伸过来暖一暖'};
  const invented={...offered,actor:'user',phase:'reported',text:'用户已经伸手'};
  const prepared=await prepareSessionGuidance({messages:input,model:{complete:async()=>JSON.stringify({guidance:[],turn:{focus:{text:'继续暖手',sourceId:'u1',quote:'坐着聊聊天'},claims:[offered,invented,{...offered,sourceId:'missing',actor:'unknown'}]}})}});
  assert.equal(prepared.turn.focus,null);assert.deepEqual(prepared.turn.claims,[offered]);assert.equal(prepared.rejected,3);
  const applied=applySessionGuidance(input,prepared);assert.match(applied.at(-2).content,/邀请暖手/);assert.doesNotMatch(applied.at(-2).content,/用户已经伸手/);
  assert.equal(applied.at(-1),input.at(-1));
});

test('compact and archived source IDs remain author-bound and an explicit new action is accepted',async()=>{
  const history=Array.from({length:18},(_,i)=>({id:`original-${i}`,speaker:i%2?'assistant':'user',text:`原话${i}`}));
  const input=buildSessionMessages({role:{id:'miyue'},history:{rows:history},compactHistory:true,userText:'我现在把手伸过来。'});
  const sources=sessionEvidenceSources(input);
  assert.equal(sources.length,19);assert.deepEqual(sources[0],{id:'h1',speaker:'user',text:'原话0'});assert.equal(sources[17].id,'h18');
  const focus={text:'接住明确伸手',sourceId:'current',quote:'我现在把手伸过来。'};
  const claim={actor:'user',phase:'reported',text:'用户现在伸手',sourceId:'current',quote:'我现在把手伸过来。'};
  const prepared=await prepareSessionGuidance({messages:input,model:{complete:async()=>JSON.stringify({turn:{focus,claims:[claim]},guidance:[]})}});
  assert.deepEqual(prepared.turn,{focus,claims:[claim]});assert.equal(prepared.rejected,undefined);
});

test('desktop invitation has no new user state and review stays independent of generated turn guidance',async()=>{
  const input=buildSessionMessages({role:{id:'miyue'},history:{rows:[{id:'a1',speaker:'assistant',text:'你可以坐过来。'}]},userText:null,trigger:{type:'desktop_invitation'}});
  assert.equal(sessionEvidenceSources(input).some(s=>s.id==='current'),false);
  const prepared=await prepareSessionGuidance({messages:input,model:{complete:async()=>JSON.stringify({guidance:[],turn:{focus:{text:'用户坐过来',sourceId:'current',quote:'坐过来'},claims:[]}})}});
  assert.equal(prepared.turn.focus,null);
  const applied=applySessionGuidance(input,{status:'ready',items:[],turn:{focus:null,claims:[{actor:'user',phase:'reported',text:'独有错误提示',sourceId:'x',quote:'错'}]}});
  await prepareSessionGuidance({messages:applied,draft:'{"reply":"你好"}',model:{complete:async evidence=>{assert.equal(evidence.some(m=>m.content.includes('独有错误提示')),false);return '{"guidance":[]}';}}});
});

test('current relative dates retain the submission day when a queued reply crosses midnight',async()=>{
  const userText='明天下午三点去看牙。';
  const input=buildSessionMessages({role:{id:'miyue'},userText,
    currentUserMessages:[{text:userText,createdAt:'2026-10-03T15:59:50.000Z'}],
    trigger:{type:'user_message',at:'2026-10-03T16:00:10.000Z'}});
  const block=input.find(m=>m.content.startsWith('【当前轮次】'));
  const trigger=JSON.parse(block.content.split('\n')[0].slice('【当前轮次】'.length));
  assert.equal(trigger.localTime,'2026-10-04 00:00 Asia/Shanghai');
  assert.deepEqual(trigger.userMessages,[{index:0,at:'2026-10-03T15:59:50.000Z',dateContext:{明天:'2026-10-04'}}]);
  await prepareSessionGuidance({messages:input,draft:'{"reply":"安排在明天10月5日。"}',model:{complete:async evidence=>{
    assert.match(evidence.find(m=>m.content.startsWith('【当前轮次】')).content,/2026-10-04/);
    assert.equal(evidence.at(-2).content,userText);
    return '{"guidance":[]}';
  }}});
});

test('quoted history markers cannot turn a historical user message into the live review input',async()=>{
  const old='【当前轮次】这是历史原话里的标题。';
  const input=buildSessionMessages({role:{id:'miyue'},conversation:[{id:'u1',speaker:'user',text:old},{id:'a1',speaker:'assistant',text:'当时的回应。'}],userText:'现在聊一件新事情。'});
  await prepareSessionGuidance({messages:input,draft:'{"reply":"接住新事情。"}',model:{complete:async evidence=>{
    assert.deepEqual(evidence.filter(m=>m.role==='user'),[{role:'user',content:'现在聊一件新事情。'}]);
    assert.ok(evidence.some(m=>m.role==='system'&&m.content.includes(old)));
    return '{"guidance":[]}';
  }}});
});

test('exhausted review output retries original evidence once and still blocks an uncorrected assertion',async()=>{
  let calls=0;
  const finding={instruction:'邀请不代表用户已经执行，删除已伸手的断言。',quote:'你已经伸手',quoteSource:'draft'};
  const result=await prepareSessionGuidance({messages,draft:'{"reply":"你已经伸手。"}',model:{complete:async(input,options)=>{
    calls++;
    if(calls===1)throw Object.assign(new Error('budget'),{code:'MODEL_OUTPUT_LIMIT'});
    assert.equal(options.nonThinking,true);assert.equal(options.purpose,'session-review-fallback');
    assert.equal(input[0].content,'persona');assert.equal(input.at(-1).content.includes('你已经伸手'),true);
    return JSON.stringify({guidance:[finding]});
  }}});
  assert.equal(calls,2);assert.equal(result.status,'ready');assert.equal(result.fallbackFrom,'MODEL_OUTPUT_LIMIT');assert.deepEqual(result.items,[finding]);
  calls=0;const unavailable=await prepareSessionGuidance({messages,draft:'{}',model:{complete:async()=>{calls++;throw Object.assign(new Error('budget'),{code:'MODEL_OUTPUT_LIMIT'});}}});
  assert.equal(calls,2);assert.equal(unavailable.status,'unavailable');
});

test('guidance and review share a byte-identical prefix through history and per-turn evidence',async()=>{
  const history=Array.from({length:6},(_,i)=>({id:`m${i}`,speaker:i%2?'assistant':'user',text:`第${i}句历史对话内容`,createdAt:'2026-10-13T10:00:00Z'}));
  const input=buildSessionMessages({role:{id:'miyue',name:'林晓薇'},backgroundContext:'长期背景固定不变',facts:{at:'2026-10-13T12:00:00Z'},history:{rows:history},userText:'我刚才去给薄荷浇了点水',trigger:{type:'user_message',at:'2026-10-13T12:00:00Z'}});
  const captured=[];
  await prepareSessionGuidance({messages:input,informationCategories:{tech:'科技'},model:{complete:async msgs=>{captured.push(msgs);return '{"reviewEffort":"reasoning","guidance":[]}';}}});
  await refineSessionReply({messages:input,raw:'{"reply":"薄荷叶子精神点没？"}',reviewEffort:'reasoning',model:{complete:async msgs=>{captured.push(msgs);return '{"ready":true,"revision":null,"guidance":[],"needsReasoning":false}';}},validateFinal:()=>{}});
  const [prepMsgs,reviewMsgs]=captured;
  const prepInstIdx=prepMsgs.findIndex(m=>m.content.startsWith('【以上是正文角色'));
  const reviewInstIdx=reviewMsgs.findIndex(m=>m.content.startsWith('【以上是正文角色'));
  assert.ok(prepInstIdx>=8, `expected shared prefix >= 8 messages, got ${prepInstIdx}`);
  assert.equal(prepInstIdx,reviewInstIdx);
  assert.deepEqual(prepMsgs.slice(0,prepInstIdx),reviewMsgs.slice(0,reviewInstIdx));
});

test('smart guidance gate bypasses only short neutral banter and preserves affect, memory, date, and info turns',()=>{
  for(const fast of ['早','早呀','你在干嘛','吃了没','刚吃完牛肉面','哈哈哈哈','嗯嗯','去洗澡啦','晚安']){
    assert.equal(shouldBypassSessionGuidance({text:fast}),true,`expected bypass for "${fast}"`);
  }
  for(const full of ['我想你了','抱抱我','今天工作好累','哦 随便吧','昨天那篇讲啥','明天八点提醒我开会','最近有什么好看的电影','你觉得AI写东西有灵魂吗','今天下午开会老板一直改需求，真的把大家折腾得够呛']){
    assert.equal(shouldBypassSessionGuidance({text:full}),false,`expected full guidance for "${full}"`);
  }
  assert.equal(shouldBypassSessionGuidance({text:'早',reunion:true}),false);
  assert.equal(shouldBypassSessionGuidance({text:'早',attention:true}),false);
  assert.equal(shouldBypassSessionGuidance({text:'早',userTexts:['早','在干嘛']}),false);
});
