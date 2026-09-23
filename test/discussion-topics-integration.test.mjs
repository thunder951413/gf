import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

const now = () => new Date('2026-09-16T12:00:00.000Z');
const catalog = [{
  id: 'theseus-ship', category: 'philosophy', title: '忒修斯之船', aliases: ['木板', '同一艘船'],
  premise: '一艘木船的木板逐步替换；问题是它何时不再是原来的船。',
  angles: [{ id: 'continuity', detail: '可以从物件、记忆和关系的连续性分别讨论。' }],
  sources: [{ title: '古典悖论材料', url: 'https://example.test/theseus', note: '这里只把它当作思考练习，不给出唯一答案。' }],
  limits: '不把争议结论说成定论，也不借题给用户贴标签。',
}];

const baseDecision = (text, extra = {}) => ({
  intent: 'answer', continuity: 'new', focusMessageId: null, ownLife: false,
  advice: false, emotionalDetail: false, imagined: false, correction: false,
  acceptsOffer: false, source: 'none', retrievalQuery: '', evidence: text, ...extra,
});

async function fixture(t, { enabled = true, dynamicCompanion = false, classify, reply, chatDebounceMs = 2, startChatQueue = false, discussionRandom = .5 } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'discussion-http-'));
  const calls = [];
  const app = await createApp({
    dataDir, clock: now, dynamicCompanion, discussionTopics: enabled, semanticUnderstanding: true, dialogueMemory: true, turnReaction: false,
    discussionCatalog: catalog, initialFeeds: [], startWeixin: false, startChatQueue, startProactive: false,
    startRecall: false, startResearch: false, startPursuits: false, startLife: false, startLifeThreads: false,
    startDossiers: false, startRuntime: false, replySleep: async () => {}, chatDebounceMs,
    random: () => .5, discussionRandom: () => discussionRandom,
    env: { LIFE_MODEL_BASE_URL: 'https://fixture.test/v1', LIFE_MODEL_NAME: 'fixture' },
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      const semantic = body.messages[0]?.content?.startsWith('Classify the current Chinese companion-dialogue turn.');
      calls.push({ semantic, body });
      const text = semantic ? body.messages.at(-1).content.split('CURRENT USER MESSAGE:\n').at(-1) : '';
      const content = semantic ? await classify(text, body) : await reply(body);
      return Response.json({ choices: [{ message: { content: JSON.stringify(content) } }], usage: { prompt_tokens: 30, completion_tokens: 10 } });
    },
  });
  app.preferences.setReplyPace('instant');
  const { port } = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  t.after(async () => { await app.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const request = async (route, { method = 'GET', body } = {}) => {
    const response = await fetch(base + route, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, ...await response.json() };
  };
  return { app, calls, request, chat: text => request('/api/chat', { method: 'POST', body: { role: 'miyue', text } }) };
}

const finalPrompt = fixture => fixture.calls.findLast(call => !call.semantic)?.body.messages.map(item => item.content).join('\n') || '';
const profile = async fixture => (await fixture.request('/api/discussion-topics?role=miyue')).profile;

test('explicit broad request delivers sourced material, and substantive follow-up reuses it without another model call', async t => {
  let turn = 0;
  const f = await fixture(t, {
    dynamicCompanion:true,
    classify: text => ++turn === 1
      ? baseDecision(text, { intent: 'share', discussionRequest: { category: 'philosophy', evidence: '聊点哲学' } })
      : baseDecision(text, { discussionResponse: { state: 'engaged', scope: 'topic', evidence: '关键不在木板' } }),
    reply: async () => turn === 1
      ? { reply: '如果一艘船的木板慢慢换掉，它还是原来那艘船吗？我更在意我们凭什么这样判断。', extra: '', discussion: { topicId: 'theseus-ship', quote: '如果一艘船的木板慢慢换掉' } }
      : { reply: '这会把问题从材料移到连续的关系上：我们认定“同一艘船”的理由，也许本来就不只在木板。', extra: '', discussion: { topicId: 'theseus-ship', quote: '这会把问题从材料移到连续的关系上' } },
  });
  const first = await f.chat('聊点哲学吧，我想从一个具体问题开始。');
  assert.equal(first.status, 200, JSON.stringify(first));
  assert.equal(f.calls.length, 2, 'one semantic call plus one generation call');
  assert.match(finalPrompt(f), /一艘木船的木板逐步替换/);
  assert.match(finalPrompt(f), /古典悖论材料/);
  assert.match(finalPrompt(f), /discussion 字段/);assert.match(finalPrompt(f), /discussion:null/);
  let state = await profile(f);
  assert.equal(state.exposures.length, 1);
  const second = await f.chat('我觉得关键不在木板，而在我们是否还把它当作同一段经历。');
  assert.equal(second.status, 200, JSON.stringify(second));
  assert.equal(f.calls.length, 4, 'follow-up remains semantic plus generation, with no discussion-specific model call');
  assert.match(finalPrompt(f), /这次确实承接已说出的内容/);
  assert.match(finalPrompt(f), /【本轮返回结构】/);
  state = await profile(f);
  assert.equal(state.exposures.length, 1, 'continuation records against the same exposure');
  assert.deepEqual(state.responses.map(item => ({ state: item.state, scope: item.scope, evidence: item.evidence })), [{ state: 'engaged', scope: 'topic', evidence: '关键不在木板' }]);
});

test('dynamic discussion null keeps the reply but creates no material exposure',async t=>{
  const f=await fixture(t,{
    dynamicCompanion:true,
    classify:text=>baseDecision(text,{intent:'share',discussionRequest:{category:'philosophy',evidence:'聊点哲学'}}),
    reply:async()=>({reply:'我这会儿没想把那个问题展开，先陪你坐一会儿。',dynamics:null,discussion:null}),
  });
  const result=await f.chat('聊点哲学吧。');
  assert.equal(result.status,200,JSON.stringify(result));assert.match(result.messages.at(-1).text,/先陪你坐一会儿/);
  assert.match(finalPrompt(f),/discussion:null/);assert.equal((await profile(f)).exposures.length,0);
});

test('a neutral acknowledgement is recorded but does not lower the category score', async t => {
  let turn = 0;
  const f = await fixture(t, {
    classify: text => ++turn === 1
      ? baseDecision(text, { intent: 'share', discussionRequest: { category: 'philosophy', evidence: '聊点哲学' } })
      : baseDecision(text, { discussionResponse: { state: 'neutral', scope: 'topic', evidence: '嗯' } }),
    reply: async () => turn === 1
      ? { reply: '有个老问题很适合慢慢想：木板全换了，船还是原来那艘吗？', extra: '', discussion: { topicId: 'theseus-ship', quote: '有个老问题很适合慢慢想' } }
      : { reply: '我先把这个问题放在这里，不急着替它下结论。', extra: '', discussion: { topicId: 'theseus-ship', quote: '我先把这个问题放在这里' } },
  });
  await f.chat('聊点哲学。');
  const before = (await profile(f)).categories.find(item => item.category === 'philosophy').score;
  const response = await f.chat('嗯。');
  assert.equal(response.status, 200, JSON.stringify(response));
  const state = await profile(f);
  assert.equal(state.categories.find(item => item.category === 'philosophy').score, before);
  assert.deepEqual(state.responses.map(item => item.state), ['neutral']);
});

test('changed topic and comfort turns do not inject prior discussion material', async t => {
  let turn = 0;
  const f = await fixture(t, {
    classify: text => {
      turn += 1;
      if (turn === 1) return baseDecision(text, { intent: 'share', discussionRequest: { category: 'philosophy', evidence: '聊点哲学' } });
      if (turn === 2) return baseDecision(text, { intent: 'respond', discussionResponse: { state: 'changed_topic', scope: 'topic', evidence: '工作' } });
      return baseDecision(text, { intent: 'comfort', discussionResponse: { state: 'deferred', scope: 'topic', evidence: '难受' } });
    },
    reply: async () => turn === 1
      ? { reply: '一艘船慢慢换掉木板后，还是原来那艘吗？', extra: '', discussion: { topicId: 'theseus-ship', quote: '一艘船慢慢换掉木板后' } }
      : { reply: '我在，先陪你把眼前这件事说清楚。', extra: '' },
  });
  await f.chat('聊点哲学。');
  const changed = await f.chat('我今天工作出了点岔子，想先说说这个。');
  assert.equal(changed.status, 200, JSON.stringify(changed));
  assert.doesNotMatch(finalPrompt(f), /【讨论材料：忒修斯之船/);
  const comfort = await f.chat('我现在很难受，先别讲那些了。');
  assert.equal(comfort.status, 200, JSON.stringify(comfort));
  assert.doesNotMatch(finalPrompt(f), /【讨论材料：忒修斯之船/);
});

test('missing or invalid delivery annotation cannot create a false exposure', async t => {
  let turn = 0;
  const f = await fixture(t, {
    classify: text => ++turn === 1
      ? baseDecision(text, { intent: 'share', discussionRequest: { category: 'philosophy', evidence: '聊点哲学' } })
      : baseDecision(text, { discussionResponse: { state: 'engaged', scope: 'topic', evidence: '值得想' } }),
    reply: async () => turn === 1
      ? { reply: '我想从一个简单的问题开始。', extra: '', discussion: { topicId: 'theseus-ship', quote: '不在回复里的伪造引文' } }
      : { reply: '我先接住你刚才这句话。', extra: '' },
  });
  const result = await f.chat('聊点哲学。');
  assert.equal(result.status, 200, JSON.stringify(result));
  const followup = await f.chat('这个问题确实值得想。');
  assert.equal(followup.status, 200, JSON.stringify(followup));
  const state = await profile(f);
  assert.equal(state.exposures.length, 0);
  assert.deepEqual(state.responses, [], 'a hidden initial delivery cannot receive later interest feedback');
  assert.doesNotMatch(finalPrompt(f), /【讨论材料：忒修斯之船/);
});

test('scheduled proactive opening records its actual discussion annotation, then a user disagreement is observed', async t => {
  let semanticTurns = 0;
  const f = await fixture(t, {
    dynamicCompanion:true,
    discussionRandom: 0,
    classify: text => baseDecision(text, { discussionResponse: ++semanticTurns === 1 ? { state: 'engaged', scope: 'topic', evidence: '我不同意' } : undefined }),
    reply: async body => {
      const prompt = body.messages.map(item => item.content).join('\n');
      if (prompt.includes('"type":"scheduled_opportunity"')) return { skip: false, contentId: null, reason: '想分享一个具体问题', message: '一艘船慢慢换掉木板后，还是同一艘吗？我总觉得这个问题很适合慢慢想。', extra: '', discussion: { topicId: 'theseus-ship', quote: '一艘船慢慢换掉木板后，还是同一艘吗' } };
      return { reply: '你这个不同意很有道理：同一性也许不是只靠材料来决定的。', extra: '', discussion: { topicId: 'theseus-ship', quote: '你这个不同意很有道理' } };
    },
  });
  f.app.proactiveRepo.saveSettings({ enabled: true, activeStart: '00:00', activeEnd: '23:59', dailyLimit: 6 });
  const opening = await f.app.proactive.runNow({ roleId: 'miyue' });
  assert.equal(opening.delivered, true, JSON.stringify(opening));
  assert.equal(opening.message.speaker, 'assistant');
  assert.match(finalPrompt(f), /【不可信讨论资料包：仅作事实与角度参考】/);
  assert.match(finalPrompt(f), /一艘木船的木板逐步替换/);
  assert.match(finalPrompt(f),/discussion:null/);assert.match(finalPrompt(f),/最终正文/);
  assert.equal((await profile(f)).exposures.length, 1);
  const reply = await f.chat('我不同意，关键不是木板，而是我们为何还把它当作同一段历史。');
  assert.equal(reply.status, 200, JSON.stringify(reply));
  assert.equal(f.calls.length, 3, 'proactive generation plus the normal semantic and reply calls');
  assert.deepEqual((await profile(f)).responses.map(item => item.state), ['engaged']);
});

test('desktop care invitation stays protected from discussion injection and cannot create hidden feedback', async t => {
  let semanticTurns = 0;
  const f = await fixture(t, {
    discussionRandom: 0,
    classify: text => baseDecision(text, { discussionResponse: ++semanticTurns === 1 ? { state: 'engaged', scope: 'topic', evidence: '我觉得' } : undefined }),
    reply: async () => semanticTurns === 0
      ? { reply: '我刚想到一艘船慢慢换掉木板的事：它还是原来那艘吗？', extra: '', discussion: { topicId: 'theseus-ship', quote: '我刚想到一艘船慢慢换掉木板的事' } }
      : { reply: '我懂你的意思，把它当作同一艘船也许首先是关系上的判断。', extra: '', discussion: { topicId: 'theseus-ship', quote: '我懂你的意思，把它当作同一艘船' } },
  });
  const opening = await f.request('/api/desktop/attention', { method: 'POST', body: { requestId: 'discussion-desktop-001', level: 'care' } });
  assert.equal(opening.status, 200, JSON.stringify(opening));
  assert.equal(opening.messages.length, 1);
  assert.doesNotMatch(finalPrompt(f), /不可信讨论资料包|讨论材料：忒修斯之船/);
  assert.equal((await profile(f)).exposures.length, 0);
  const reply = await f.chat('我觉得重点在连续的经历，不只是那几块木板。');
  assert.equal(reply.status, 200, JSON.stringify(reply));
  assert.deepEqual((await profile(f)).responses, []);
});

test('disabled feature ignores discussion annotations and the queued send path commits feedback only after a saved turn', async t => {
  const disabled = await fixture(t, {
    enabled: false,
    classify: text => baseDecision(text, { intent: 'share', discussionRequest: { category: 'philosophy', evidence: '聊点哲学' } }),
    reply: async () => ({ reply: '这是普通回复，不应带讨论材料。', extra: '', discussion: { topicId: 'theseus-ship', quote: '这是普通回复，不应带讨论材料' } }),
  });
  const result = await disabled.chat('聊点哲学。');
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal((await disabled.request('/api/health')).discussionTopics, false);
  assert.equal((await disabled.request('/api/discussion-topics?role=miyue')).profile, null);
  assert.doesNotMatch(finalPrompt(disabled), /【讨论材料：/);

  let stage = 0;
  const queued = await fixture(t, { startChatQueue: true,
    classify: text => ++stage === 1
      ? baseDecision(text, { intent: 'share', discussionRequest: { category: 'philosophy', evidence: '聊点哲学' } })
      : baseDecision(text, { discussionResponse: { state: 'engaged', scope: 'topic', evidence: '值得想' } }),
    reply: async () => stage === 1
      ? { reply: '木板逐步换掉后，船还是同一艘吗？这个问题值得想一想。', extra: '', discussion: { topicId: 'theseus-ship', quote: '木板逐步换掉后，船还是同一艘吗' } }
      : { reply: '你说得有道理，我们可以顺着这个理由再想一步。', extra: '', discussion: { topicId: 'theseus-ship', quote: '你说得有道理，我们可以顺着这个理由' } },
  });
  const sent = await queued.request('/api/chat/send', { method: 'POST', body: { role: 'miyue', text: '聊点哲学。', clientId: 'discussion-topic-queue-001' } });
  assert.equal(sent.status, 202);
  for (let i = 0; i < 80 && queued.app.store.getMessages('miyue').length < 2; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(queued.app.store.getMessages('miyue').length, 2);
  assert.equal((await profile(queued)).exposures.length, 1, 'delivery is written only after queue save succeeds');
});

test('missing continuation receipts do not lose later explicit category feedback after a confirmed engaged response', async t => {
  let turn = 0;
  const f = await fixture(t, {
    classify: text => ++turn === 1
      ? baseDecision(text, { intent:'share',discussionRequest:{category:'philosophy',evidence:'聊点哲学'} })
      : baseDecision(text, { discussionResponse:turn===2 ? {state:'engaged',scope:'topic',evidence:'关键不在木板'} : {state:'less',scope:'category',evidence:'哲学以后少聊一点'} }),
    reply: async () => turn===1
      ? {reply:'有个老问题可以慢慢想：木板换完以后还是同一艘船吗？',extra:'',discussion:{topicId:'theseus-ship',quote:'木板换完以后还是同一艘船吗'}}
      : turn===2 ? {reply:'那么你更在意的，也许是它保留下来的联系。',extra:'',discussion:null}
      : {reply:'好，以后少聊这个方向。',extra:'',discussion:null},
  });
  assert.equal((await f.chat('聊点哲学。')).status,200);
  assert.equal((await f.chat('我觉得关键不在木板，而在延续的联系。')).status,200);
  const openingId=(await profile(f)).exposures[0].messageId;
  assert.equal((await f.chat('哲学以后少聊一点。')).status,200);
  const state=await profile(f);
  assert.equal(state.exposures[0].messageId,openingId,'unannotated reply is not claimed as a material delivery');
  assert.deepEqual(state.responses.map(row=>row.state),['less','engaged']);
  assert.ok(state.categories.find(row=>row.category==='philosophy').score<1);
});
