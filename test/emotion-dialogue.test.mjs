import test from 'node:test';import assert from 'node:assert/strict';
import {requestEmotionEnvelope,parseEmotionEnvelope} from '../lib/emotion-dialogue.mjs';
test('reply envelope strips private state signals and only accepts evidence from the current user turn',()=>{
 const raw=JSON.stringify({reply:'听起来今天挺累的，先歇会儿。',signals:{tone:'distressed',closeness:'unspecified',evidence:'今天太累了'}});
 assert.deepEqual(parseEmotionEnvelope(raw,'今天太累了'),{reply:'听起来今天挺累的，先歇会儿。',signals:{tone:'distressed',closeness:'unspecified'}});
 assert.equal(parseEmotionEnvelope(raw,'聊聊数据库索引').signals,null);
 assert.throws(()=>parseEmotionEnvelope('{"signals":{}}','x'),{code:'MODEL_REPLY_INVALID'});
 assert.throws(()=>parseEmotionEnvelope('{"reply":','x'),{code:'MODEL_REPLY_INVALID'});
 assert.deepEqual(parseEmotionEnvelope('正常文字回复','x'),{reply:'正常文字回复',signals:null});
});
test('user-initiated prompt respects the user topic and does not mutate the shared prompt',()=>{
 const original=[{role:'system',content:'人物设定'},{role:'user',content:'如何分析这个bug'}];const prompt=requestEmotionEnvelope(original);
 assert.equal(original[0].content,'人物设定');assert.match(prompt[0].content,/两种方式共享同一个人物、状态和真实历史/);assert.match(prompt.at(-2).content,/本轮触发方式：用户消息.*不抢走用户话题/);assert.deepEqual(prompt.at(-1),original[1]);
});
test('complete reply survives a malformed optional signal tail and JSON string replies are unwrapped',()=>{
 assert.deepEqual(parseEmotionEnvelope('{"reply":"可以继续聊。","signals":','x'),{reply:'可以继续聊。',signals:null});
 assert.deepEqual(parseEmotionEnvelope('"正常的中文回复"','x'),{reply:'正常的中文回复',signals:null});
});
test('multi-turn model input keeps assistant history in the same JSON protocol without changing stored text',()=>{
 const original=[{role:'system',content:'人物设定'},{role:'user',content:'今天聊什么'}, {role:'assistant',content:'我刚画完一张草图。'}, {role:'user',content:'画的是什么？'}];
 const before=structuredClone(original);const prompt=requestEmotionEnvelope(original);
 assert.deepEqual(JSON.parse(prompt[2].content),{reply:'我刚画完一张草图。'});
 assert.deepEqual(original,before);assert.deepEqual(prompt.at(-1),original[3]);assert.match(prompt.at(-2).content,/本轮触发方式：用户消息/);
});
