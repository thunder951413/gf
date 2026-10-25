import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelClient } from '../lib/model.mjs';
import { currentDialogueTime, withDialogueTime } from '../lib/dialogue-time.mjs';
import { createApp } from '../server.mjs';

test('Shanghai date rolls over at UTC 16:00 including weekday and year', () => {
  assert.match(currentDialogueTime('2026-12-31T15:59:59Z'), /2026-12-31 23:59:59 星期四/);
  assert.match(currentDialogueTime('2026-12-31T16:00:01Z'), /2027-01-01 00:00:01 星期五/);
  assert.match(currentDialogueTime('2026-09-09T00:03:04Z'), /2026-09-09 08:03:04 星期三.*Asia\/Shanghai.*UTC\+08:00/);
});

test('every dialogue purpose refreshes its provider payload without rewriting history or cache prefix', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dialogue-clock-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let now = '2026-09-09T15:59:59Z';
  const calls = [];
  const model = new ModelClient({ dataDir, clock: () => new Date(now),
    env: { LIFE_MODEL_BASE_URL: 'https://fixture.test/v1', LIFE_MODEL_NAME: 'fixture' },
    fetchImpl: async (_, init) => { calls.push(JSON.parse(init.body));return Response.json({ choices: [{ message: { content: '收到' } }] }); },
  });
  const messages = [{ role: 'system', content: '固定角色设定' }, { role: 'user', content: '昨天聊的事' }, { role: 'assistant', content: '我记得。' }, { role: 'user', content: '今晚呢？' }];
  const original = structuredClone(messages);
  for (const purpose of ['chat', 'chat-repair', 'proactive', 'life', 'emotion', 'understanding']) {
    await model.complete(messages, { purpose });
    const sent = calls.at(-1).messages;
    assert.deepEqual(sent.slice(0, -2), messages.slice(0, -1));
    assert.deepEqual(sent.at(-1), messages.at(-1));
    assert.match(sent.at(-2).content, /2026-09-09 23:59:59/);
    assert.equal(sent.at(-2).role, 'system');
    assert.equal(sent.filter(m => m.role === 'user').length, messages.filter(m => m.role === 'user').length);
    assert.equal(sent.filter(m => m.content.startsWith('【本轮当前时间】')).length, 1);
  }
  now = '2026-09-09T16:00:01Z';
  await model.complete(messages, { purpose: 'chat' });
  assert.match(calls.at(-1).messages.at(-2).content, /2026-09-10 00:00:01/);
  assert.deepEqual(messages, original, 'A retry must start from untouched input, not accumulate old time blocks');
  for (const purpose of ['memory', 'connection-test']) {
    await model.complete(messages, { purpose });
    assert.deepEqual(calls.at(-1).messages, messages);
  }
  assert.deepEqual(withDialogueTime(messages, { purpose:'memory' }), messages);
});

test('real chat API uses the injected current clock for all roles and does not save the clock block in chat', async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-date-api-'));
  const calls = [];
  const app = await createApp({ dataDir, roles: ['miyue','wenxi','zhixia'].map(id => ({id,name:id,systemPrompt:'自然回应当前用户。'})), clock: () => new Date('2026-09-09T16:05:06Z'), initialFeeds: [],
    startProactive:false,startRecall:false,startPursuits:false,startLifeThreads:false,startDossiers:false,startResearch:false,startChatQueue:false,
    replySleep:async()=>{},env:{ LIFE_MODEL_BASE_URL:'https://fixture.test/v1',LIFE_MODEL_NAME:'fixture' },
    fetchImpl:async(_,init)=>{calls.push(JSON.parse(init.body));return Response.json({choices:[{message:{content:JSON.stringify({reply:'我在听，你说。',extra:''})}}]});},
  });
  t.after(async()=>{await app.close();fs.rmSync(dataDir,{recursive:true,force:true});});
  const {port}=await app.listen(0);
  for(const role of ['miyue','wenxi','zhixia']){
    const start=calls.length;
    const response=await fetch(`http://127.0.0.1:${port}/api/chat`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role,text:'你在吗？'})});
    assert.equal(response.status,200);await response.arrayBuffer();assert.ok(calls.length>start);
    for(const call of calls.slice(start))assert.match(call.messages.at(-2).content,/2026-09-10 00:05:06 星期四/);
    assert.ok(app.store.getMessages(role).every(m=>!m.text.includes('【本轮当前时间】')));
  }
});


test('event-triggered generation keeps zero user utterances after time injection', () => {
  const messages = [{role:'system',content:'本轮是主动联系，没有用户新消息。'}, {role:'assistant',content:'这是之前主动说的一句话。'}];
  const sent=withDialogueTime(messages,{purpose:'proactive',now:'2026-09-25T12:10:00Z'});
  assert.equal(sent.filter(m=>m.role==='user').length,0);
  assert.equal(sent.at(-1).role,'system');
  assert.deepEqual(sent.slice(0,-1),messages);
});
