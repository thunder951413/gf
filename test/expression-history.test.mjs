import test from 'node:test';
import assert from 'node:assert/strict';
import { expressionHistory } from '../lib/expression-history.mjs';

const assistant = (text, extras = {}) => ({ speaker: 'assistant', text, ...extras });
const user = text => ({ speaker: 'user', text });

test('finds normalized emotional wording across distinct assistant turns', () => {
  const conversation = [
    assistant('你这么说，我心里软了一下。', { createdAt: '2026-09-10T09:00:00Z' }),
    user('我今天也想你。'),
    assistant('隔着屏幕听见这句，心里还是软了一下。', { createdAt: '2026-09-12T09:00:00Z' }),
  ];
  const result = expressionHistory(conversation);
  assert.deepEqual(result.phrases, [{ phrase: '心里软', count: 2 }]);
  assert.match(result.context, /不同回复/);
  assert.match(result.context, /具体缘由、念头或细节/);
  assert.match(result.context, /不硬性禁用/);
});

test('merges light filler variants of the same short emotional formulation', () => {
  const conversation = [
    assistant('你还记得这件事，我心里有点软。'),
    user('那天我一直放在心上。'),
    assistant('听到这里，心里还是软了一下。'),
  ];
  assert.deepEqual(expressionHistory(conversation).phrases, [{ phrase: '心里软', count: 2 }]);
});

test('merges repeated ear and face heat reactions without treating literal heat as emotion', () => {
  const conversation = [
    assistant('你忽然这么夸我，耳朵有点热。'),
    user('我说的是实话。'),
    assistant('还盯着屏幕看你的消息，耳朵发热了，脸烫。'),
    user('别躲。'),
    assistant('耳朵热了，脸颊有点烫。'),
    user('今天真热。'),
    assistant('今天天气很热，茶也烫，等凉一点再喝。'),
    user('你刚才说“耳朵发热”，我记住了。'),
    assistant('你说“耳朵发热”时，我只是在复述你的话。'),
  ];
  const result = expressionHistory(conversation);
  assert.deepEqual(result.phrases, [
    { phrase: '耳朵热', count: 3 },
    { phrase: '脸烫', count: 2 },
  ]);
  assert.doesNotMatch(result.context, /天气很热|茶也烫/);
});

test('does not count quoted user copy, acknowledgements, story rows, or concrete facts', () => {
  const conversation = [
    assistant('你刚才说“心里软了一下”，我记住了。'),
    user('好。'),
    assistant('好呀。'),
    user('继续。'),
    assistant('我觉得九点见更稳妥。'),
    user('嗯。'),
    assistant('故事里她心里软了一下。', { kind: 'story' }),
  ];
  assert.deepEqual(expressionHistory(conversation).phrases, []);
});

test('counts a phrase once within one assistant bubble and needs two groups', () => {
  const conversation = [
    assistant('心里软了一下。心里软了一下。'),
    assistant('我又心里还是软了一下。'),
  ];
  assert.deepEqual(expressionHistory(conversation).phrases, []);
});

test('returns an empty hint for empty or one-off conversation and preserves its input', () => {
  const conversation = [assistant('我觉得很安心。')];
  const before = structuredClone(conversation);
  assert.deepEqual(expressionHistory([]), { phrases: [], context: '' });
  assert.deepEqual(expressionHistory(conversation), { phrases: [], context: '' });
  expressionHistory(conversation);
  assert.deepEqual(conversation, before);
});

test('keeps the hint bounded and retains only the five most repeated formulations', () => {
  const phrases = ['心里软了一下', '觉得很安心', '有点想哭', '心口发紧', '觉得很温暖', '觉得很开心'];
  const conversation = phrases.flatMap((phrase, index) => [assistant(phrase), user(`事件${index}`), assistant(`这次${phrase}`), user(`日期${index}`)]);
  const result = expressionHistory(conversation, { maxChars: 72 });
  assert.equal(result.phrases.length, 5);
  assert.ok(result.context.length <= 72);
});


test('groups repeated settling reactions across wording variants without rewriting history', () => {
 const rows=[assistant('看见你的消息，整个人先松下来了。'),user('嗯。'),assistant('听你说这些，我也跟着松了一下。'),user('继续。'),assistant('人一下就软下来。')];
 const before=structuredClone(rows);
 assert.deepEqual(expressionHistory(rows).phrases,[{phrase:'用身体松软来表达情绪',count:3}]);
 assert.match(expressionHistory(rows).context,/不必换一个身体部位/);
 assert.deepEqual(rows,before);
});

test('a single relaxation, quoted phrase, physical exercise and story do not make a repetition hint', () => {
 const rows=[assistant('整个人松下来。'),user('你又说整个人松下来'),assistant('你说“整个人松下来”，我知道你的意思。'),user('运动呢'),assistant('按摩以后肩膀终于松下来了。'),user('继续'),assistant('她整个人软下来。',{kind:'story'})];
 assert.deepEqual(expressionHistory(rows).phrases,[]);
});

test('chat and proactive prompts derive the repetition hint from the supplied evidence history', async () => {
 const {buildChatMessages}=await import('../lib/model.mjs');
 const {buildProactiveMessages}=await import('../lib/proactive.mjs');
 const {createConversationPlan,conversationTrigger}=await import('../lib/conversation-plan.mjs');
 const {readFileSync}=await import('node:fs');
 const role=JSON.parse(readFileSync('app-data/roles.json','utf8')).find(r=>r.id==='miyue');
 const conversation=[assistant('整个人先松下来了。'),user('我也是'),assistant('人一下就软下来。')];
 const at='2026-09-18T01:00:00Z';
 for(const type of ['user_message','desktop_invitation','scheduled_opportunity']) {
  const trigger=conversationTrigger({type,userText:type==='user_message'?'早上好':null,at});
  const turnPlan=createConversationPlan({trigger});
  const args={role,memories:[],conversation,characterContext:'只有当前活动，不含旧的反应',turnPlan};
  const messages=type==='user_message'?buildChatMessages({...args,currentUserText:'早上好'}):buildProactiveMessages({...args,kind:'life'});
  const hints=messages.filter(m=>m.content.startsWith('【近期表达记忆】'));
  assert.equal(hints.length,1,type);
  assert.match(hints[0].content,/用身体松软来表达情绪（2次）/);
  assert.ok(messages.indexOf(hints[0])>messages.findIndex(m=>m.role==='assistant'));
  assert.doesNotMatch(messages[0].content,/用身体松软来表达情绪（2次）/);
 }
});


test('settling variants across the recent window are aggregated and eventually expire', () => {
 const rows=[assistant('我整个人顺势软下来。'),user('嗯'),assistant('整个人就能松下来。'),user('嗯'),assistant('整个人慢慢往你怀里软下去。')];
 for(let i=0;i<20;i++)rows.push(user('另一件事'),assistant('聊点别的内容。'));
 assert.deepEqual(expressionHistory(rows).phrases,[{phrase:'用身体松软来表达情绪',count:3}]);
 for(let i=0;i<64;i++)rows.push(user('新的事情'),assistant('今天有不同的内容。'));
 assert.deepEqual(expressionHistory(rows).phrases,[]);
});
