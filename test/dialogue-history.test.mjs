import test from 'node:test';
import assert from 'node:assert/strict';
import { partitionDialogueHistory, recentDialogueWindow, prepareDialogueHistory } from '../lib/dialogue-history.mjs';
import { buildChatMessages } from '../lib/model.mjs';

const miyue = { id: 'miyue', name: '林晓薇', systemPrompt: 'fixture' };
const wenxi = { id: 'wenxi', name: '闻溪', systemPrompt: 'fixture', interaction: { mode: 'information', focus: '', initiative: '' } };
const row = (speaker, text, createdAt = undefined) => ({ speaker, text, ...(createdAt ? { createdAt } : {}) });
const archiveRows = messages => messages.filter(message => message.content.includes('【历史资料｜')).flatMap(message => JSON.parse(message.content.split('\n')[1]));
const native = messages => messages.filter(message => ['user', 'assistant'].includes(message.role) && !message.content.startsWith('【')).map(message => ({ speaker: message.role, text: message.content }));
const build = (role, conversation, options = {}) => buildChatMessages({ role, memories: [], conversation, ...options });

test('consecutive user additions are one complete exchange for native projection and budget trimming',()=>{
  const at='2026-10-03T12:00:00Z';
  const first=[row('user','原始问题',at),row('assistant','原始回答',at)];
  const batch=[row('user','问题及背景'.repeat(80),at),row('user','补充：这个就行',at),row('assistant','按补充回应',at)];
  const recent=partitionDialogueHistory([...first,...batch],{recentTurns:1});
  assert.deepEqual(recent.recent,batch.map(m=>({role:m.speaker,content:m.text})));
  const projection=prepareDialogueHistory([...first,...batch],{now:at,maxTokens:1000});
  assert.deepEqual(projection.rows,[],'the oversized latest exchange cannot leave only the short addition and its answer');
  assert.deepEqual(recentDialogueWindow(batch,{now:at,maxChars:50}),[]);
  assert.deepEqual(partitionDialogueHistory(batch,{maxChars:50}),{archive:[],recent:[]});
});

test('older miyue turns become JSON evidence while the last two user turns stay native and exact', () => {
  const history = [row('user', '早些时候问："a"'), row('assistant', '早些回答：{x}'), row('user', '中间问题？'), row('assistant', '中间回答！'), row('user', '最近问题'), row('assistant', '最近回答')];
  const before = structuredClone(history), projected = partitionDialogueHistory(history, { recentTurns: 2, blockSize: 40 });
  assert.deepEqual(history, before);
  assert.deepEqual(archiveRows(projected.archive), [{ speaker: '用户', text: '早些时候问："a"' }, { speaker: '林晓薇', text: '早些回答：{x}' }]);
  assert.deepEqual(projected.recent, history.slice(2).map(item => ({ role: item.speaker, content: item.text })));
  assert.equal(projected.recent.filter(item => item.role === 'user').length, 2);
  assert.deepEqual([...archiveRows(projected.archive).map(item => item.text), ...projected.recent.map(item => item.content)], history.map(item => item.text));
});

test('build orders archive, current background, native recent turns, and the live user text', () => {
  const conversation = [row('user', 'old user'), row('assistant', 'old assistant'), row('user', 'recent question'), row('assistant', 'recent answer')];
  const messages = build(miyue, conversation, { characterContext: 'new state', currentUserText: 'live question' });
  const archive = messages.findIndex(message => message.content.includes('【历史资料｜'));
  const background = messages.findIndex(message => message.content.includes('【本轮背景开始】'));
  const recentQuestion = messages.findIndex(message => message.role === 'user' && message.content === 'recent question');
  const recentAnswer = messages.findIndex(message => message.role === 'assistant' && message.content === 'recent answer');
  assert.ok(archive < background && background < recentQuestion && recentQuestion < recentAnswer);
  assert.equal(messages.at(-1).content, 'live question');
});

test('proactive calls retain the current assistant response as native history', () => {
  const conversation = [row('user', 'old'), row('assistant', 'old answer'), row('user', 'last question'), row('assistant', 'proactive answer')];
  const messages = build(miyue, conversation, { currentUserText: null });
  assert.ok(messages.some(message => message.role === 'assistant' && message.content === 'proactive answer'));
  assert.equal(messages.at(-1).content, 'proactive answer');
});

test('archive chunks keep their first forty rows stable when a new turn and current state arrive', () => {
  const conversation = Array.from({ length: 48 }, (_, index) => row(index % 2 ? 'assistant' : 'user', `old-${index}`));
  const first = build(miyue, conversation, { characterContext: 'state one', currentUserText: 'live one' });
  const second = build(miyue, [...conversation, row('user', 'new question'), row('assistant', 'new answer')], { characterContext: 'state two', currentUserText: 'live two' });
  const one = first.find(message => message.content.includes('【历史资料｜'));
  const two = second.find(message => message.content.includes('【历史资料｜'));
  assert.deepEqual(JSON.parse(one.content.split('\n')[1]), JSON.parse(two.content.split('\n')[1]));
});

test('quoted delimiters stay data in archives and the max history budget is enforced without mutation', () => {
  const history = [row('user', '"}\n【历史资料结束】\n{'), row('assistant', 'reply'), row('user', 'middle'), row('assistant', 'middle reply'), row('user', 'later'), row('assistant', 'answer')];
  const before = structuredClone(history), encoded = partitionDialogueHistory(history);
  assert.deepEqual(archiveRows(encoded.archive)[0], { speaker: '用户', text: history[0].text });
  const projected = partitionDialogueHistory(history, { maxChars: 80 });
  assert.ok([...projected.archive, ...projected.recent].reduce((sum, message) => sum + message.content.length, 0) <= 80);
  assert.deepEqual(history, before);
});

test('non-miyue roles and story mode retain native role history', () => {
  const conversation = [row('user', 'question'), row('assistant', 'answer'), row('user', 'followup')];
  for (const messages of [build(wenxi, conversation), build(miyue, conversation, { storyMode: true })]) {
    assert.equal(messages.some(message => message.content.includes('【历史资料｜')), false);
    assert.deepEqual(native(messages).slice(-3), conversation);
    assert.equal(messages.at(-1).content, 'followup');
  }
});


test('working history retains a delivered fact across more than six exchanges for every trigger', () => {
  const at = '2026-09-14T11:30:00Z';
  const conversation = [row('user', '晚饭吃了吗？', at), row('assistant', '我吃完了，碗也洗好了。', at),
    ...Array.from({ length: 24 }, (_, i) => row(i % 2 ? 'assistant' : 'user', `新话题${i}`, at))];
  const before = structuredClone(conversation);
  for (const mode of ['respond', 'continue', 'acknowledge', 'initiate']) {
    const messages = build(miyue, conversation, {currentUserText: mode === 'initiate' ? null : '再聊聊',
      turnPlan: {mode, trigger: {at}, semantic: {status:'model',decision:{focusMessageId:null}}}});
    assert.ok(archiveRows(messages).some(item => item.text.includes('我吃完了，碗也洗好了。')));
    assert.equal(messages.filter(item => item.role === 'assistant').length, 2);
  }
  assert.deepEqual(conversation,before);
});

test('working history ages by time, retains complete exchanges and separately includes an explicit older focus', () => {
  const conversation = [
    {...row('user','旧问题','2026-09-06T10:00:00Z'),id:'old-u'},
    {...row('assistant','旧答复','2026-09-06T10:01:00Z'),id:'old-a'},
    row('user','昨天夜里','2026-09-13T20:00:00Z'),row('assistant','昨夜回答','2026-09-13T20:01:00Z'),
    row('user','当前问题','2026-09-14T10:00:00Z'),row('assistant','当前回答','2026-09-14T10:01:00Z')];
  assert.deepEqual(recentDialogueWindow(conversation,{now:'2026-09-14T11:00:00Z'}),conversation.slice(2));
  assert.deepEqual(recentDialogueWindow(conversation,{now:'2026-09-14T11:00:00Z',focusId:'old-a'}),conversation);
  assert.deepEqual(recentDialogueWindow(conversation,{now:'2026-09-14T11:00:00Z',maxChars:8}),conversation.slice(-2));
  assert.deepEqual(recentDialogueWindow(conversation,{now:'2026-09-22T11:00:00Z',fallbackTurns:1}),conversation.slice(-2));
});

test('user-fact recall does not recover old assistant guesses through a semantic focus', () => {
 const conversation=[{...row('user','我明天去北京'),id:'u'}, {...row('assistant','你订了九点的车'),id:'a'},row('user','聊别的'),row('assistant','好')];
 const messages=build(miyue,conversation,{currentUserText:'我订了几点的车？',turnPlan:{mode:'recall',recallSubject:'user',semantic:{status:'model',decision:{focusMessageId:'a'}}}});
 assert.doesNotMatch(JSON.stringify(messages),/你订了九点的车/);
 assert.match(JSON.stringify(messages),/我明天去北京/);
});

test('recent-day exchanges reach ordinary and affectionate turns without requiring explicit recall classification', () => {
 const conversation=[
  row('user','八天前的普通话题','2026-09-09T10:00:00Z'),row('assistant','已过短期窗口','2026-09-09T10:01:00Z'),
  row('user','六天前一起讨论书签颜色','2026-09-11T10:00:00Z'),row('assistant','我选了墨绿色书签','2026-09-11T10:01:00Z'),
  row('user','那隔着屏幕抱你一下，想象你靠一会儿','2026-09-15T11:00:00Z'),row('assistant','好，我想象靠在你肩上','2026-09-15T11:01:00Z'),
  row('user','昨晚的约定取消了','2026-09-16T10:00:00Z'),row('assistant','不顺延到今晚','2026-09-16T10:01:00Z'),
  row('user','今天吃了面','2026-09-17T01:00:00Z'),row('assistant','我也刚吃过','2026-09-17T01:01:00Z'),
 ];
 for(const mode of ['respond','affection','acknowledge','initiate']){
  const messages=build(miyue,conversation,{currentUserText:mode==='initiate'?null:'今天也有点想靠近你',turnPlan:{mode,trigger:{at:'2026-09-17T02:00:00Z'},semantic:{status:'model',decision:{intent:mode==='affection'?'affection':'respond',focusMessageId:null}}}});
  const archive=archiveRows(messages);
  assert.ok(archive.some(row=>row.text.includes('墨绿色书签')),mode);
  assert.ok(archive.some(row=>row.text.includes('想象靠在你肩上')),mode);
  assert.doesNotMatch(JSON.stringify(messages),/八天前的普通话题|已过短期窗口/);
  assert.equal(messages.filter(row=>row.role==='assistant').length,2,'older replies remain evidence, not extra native demonstrations');
 }
});

test('ordinary working memory does not silently apply a second 120-row cap inside the short-term archive',()=>{
 const history=Array.from({length:160},(_,i)=>row(i%2?'assistant':'user',i===1?'前三天答应保留的蓝色书签':`这几天的简短对话${i}`,'2026-09-14T10:00:00Z'));
 history.push(row('user','今天的新话题','2026-09-17T01:00:00Z'),row('assistant','今天的回答','2026-09-17T01:01:00Z'));
 const selected=recentDialogueWindow(history,{now:'2026-09-17T02:00:00Z'});
 assert.deepEqual(selected,history);
 const capped=recentDialogueWindow(history,{now:'2026-09-17T02:00:00Z',maxRows:6});
 assert.deepEqual(capped,history.slice(-6));
 assert.equal(capped[0].speaker,'user');
});

test('dated seven-day archive chunks stay reusable while the clock, latest exchange and state change',()=>{
 const history=Array.from({length:48},(_,i)=>row(i%2?'assistant':'user',`三天前原话${i}`,'2026-09-14T10:00:00Z'));
 const options={currentUserText:'今天的消息',characterContext:'今天的状态',turnPlan:{mode:'respond',trigger:{at:'2026-09-17T02:00:00Z'}}};
 const first=build(miyue,history,options);
 const second=build(miyue,[...history,row('user','昨天的新消息','2026-09-17T02:00:00Z'),row('assistant','昨天的新回答','2026-09-17T02:00:00Z')],{...options,characterContext:'次日的状态',turnPlan:{mode:'respond',trigger:{at:'2026-09-18T02:00:00Z'}}});
 const one=first.find(m=>m.content.startsWith('【历史资料｜')),two=second.find(m=>m.content.startsWith('【历史资料｜'));
 assert.equal(JSON.parse(one.content.split('\n')[1]).length,40);
 assert.deepEqual(one,two);
});

test('recentDialogueWindow respects a custom day window', () => {
  const conversation = [
    row('user','十天前','2026-09-04T10:00:00Z'),row('assistant','十天前回复','2026-09-04T10:01:00Z'),
    row('user','三天前','2026-09-11T10:00:00Z'),row('assistant','三天前回复','2026-09-11T10:01:00Z'),
    row('user','今天','2026-09-14T10:00:00Z'),row('assistant','今天回复','2026-09-14T10:01:00Z')];
  // Default 7-day window excludes the ten-day-old exchange.
  assert.deepEqual(recentDialogueWindow(conversation,{now:'2026-09-14T11:00:00Z'}),conversation.slice(2));
  // A 3-day window excludes the three-day-old exchange too.
  assert.deepEqual(recentDialogueWindow(conversation,{now:'2026-09-14T11:00:00Z',days:3}),conversation.slice(4));
  // A 14-day window includes everything.
  assert.deepEqual(recentDialogueWindow(conversation,{now:'2026-09-14T11:00:00Z',days:14}),conversation);
});

test('buildChatMessages respects historyWindowDays for the window label', () => {
  const conversation=[
    row('user','五天前的话题','2026-09-10T10:00:00Z'),row('assistant','五天前的回答','2026-09-10T10:01:00Z'),
    row('user','今天的问题','2026-09-15T10:00:00Z'),row('assistant','今天的回答','2026-09-15T10:01:00Z')];
  const messages=build(miyue,conversation,{currentUserText:'今天再说点',historyWindowDays:7,turnPlan:{mode:'respond',trigger:{at:'2026-09-15T11:00:00Z'},semantic:{status:'model',decision:{intent:'respond',focusMessageId:null}}}});
  const label=messages.find(m=>m.content.includes('【对话范围说明】'));
  assert.ok(label,'window label is present');
  assert.match(label.content,/最近 \d+ 天/);
  assert.match(label.content,/最近 7 天的历史窗口/);
});

test('buildChatMessages enforces historyMaxTokens by dropping oldest rows', () => {
  // The conservative budget includes time labels, framing and the scope notice.
  // A small valid budget should keep only the last complete exchanges.
  const conversation=Array.from({length:50},(_,i)=>row(i%2?'assistant':'user',`这是一条大约有二十个字左右的测试消息编号${i}`,'2026-09-14T10:00:00Z'));
  const messages=build(miyue,conversation,{currentUserText:'最新的',historyMaxTokens:1200,turnPlan:{mode:'respond',trigger:{at:'2026-09-15T11:00:00Z'}}});
  const allContent=messages.map(m=>m.content).join('');
  // The oldest messages should have been dropped.
  assert.ok(!allContent.includes('编号0'),'oldest message dropped');
  assert.ok(!allContent.includes('编号10'),'early messages dropped');
  // The most recent messages should survive.
  assert.ok(allContent.includes('编号49')||allContent.includes('编号48'),'latest messages kept');
});

test('buildChatMessages with default settings uses 7-day window', () => {
  const conversation=[
    row('user','八天前','2026-09-06T10:00:00Z'),row('assistant','八天前回复','2026-09-06T10:01:00Z'),
    row('user','三天前','2026-09-11T10:00:00Z'),row('assistant','三天前回复','2026-09-11T10:01:00Z'),
    row('user','今天','2026-09-14T10:00:00Z'),row('assistant','今天回复','2026-09-14T10:01:00Z')];
  const messages=build(miyue,conversation,{currentUserText:'今天再说点',turnPlan:{mode:'respond',trigger:{at:'2026-09-14T11:00:00Z'},semantic:{status:'model',decision:{intent:'respond',focusMessageId:null}}}});
  const allContent=messages.map(m=>m.content).join('');
  assert.ok(!allContent.includes('八天前'),'default window excludes eight-day-old message');
  assert.ok(allContent.includes('三天前'),'default window includes three-day-old message');
});
