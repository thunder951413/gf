import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../server.mjs';

const noVoice = {
  fetchFeed: async () => ({ title: '订阅', items: [] }),
  probeTts: async () => ({ available: false, state: 'unavailable', stt: { available: false, state: 'unavailable' } }),
  startSpeech: async () => { throw Object.assign(new Error('语音服务未运行'), { status: 503 }); },
  readSpeechStatus: async () => ({ state: 'failed', error: '任务不存在' }),
  getSpeechAudio: async () => { throw new Error('任务不存在'); },
  closeSpeech: async () => ({ ok: true }),
  transcribeAudio: async () => { throw Object.assign(new Error('转写服务未运行'), { status: 503 }); },
};

const pursuitCatalog = {
  items: [{
    id: 'integration-reading',
    kind: 'reading',
    title: '集成验收用的慢读书',
    aliases: ['慢读书', '集成验收书'],
    source: {
      title: '集成验收来源',
      url: 'https://example.test/integration-reading',
      scope: '只用于服务接入测试',
    },
    stages: Array.from({ length: 4 }, (_, index) => ({
      label: `慢读阶段${index + 1}`,
      action: `【追求阶段动作${index + 1}】我只读到这里，暂时不往后跳。`,
      detail: `当前阶段的测试细节${index + 1}`,
    })),
  }],
};

const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function request(base, pathname, options) {
  const response = await fetch(`${base}${pathname}`, options);
  return { status: response.status, body: await response.json() };
}

function envelope(reply) {
  return JSON.stringify({ reply, extra: '', signals: { tone: 'neutral', closeness: 'unspecified', evidence: '' } });
}

async function fixture(t, { failure = false, catalog = pursuitCatalog, modelEnvelope = null, naturalMaterialDelivery = false, materialPresentation } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pursuit-integration-'));
  const calls = [];
  let app;
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (failure) return new Response('upstream unavailable', { status: 500 });
    if(modelEnvelope)return Response.json({choices:[{message:{content:JSON.stringify(typeof modelEnvelope==='function'?modelEnvelope(body):modelEnvelope)}}]});
    const userText = [...body.messages].reverse().find((message) => message.role === 'user')?.content || '';
    const isMiyue = body.response_format?.type === 'json_object';
    const isProactivePursuit = body.messages.some((message) => message.content === '计划类型：life。');
    if (isProactivePursuit) {
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        skip: false,
        contentId: null,
        reason: '分享正在进行的阅读',
        message: '我刚整理好手边的笔记，想把这一小段说给你听。',
        extra: '',
      }) } }] });
    }
    let reply;
    if (isMiyue && userText === '说说你的近况') reply = pursuitCatalog.items[0].stages[0].action;
    else if (userText === '这本书后来读到哪里了？') reply = '我还停在刚才那一段，想多看两眼细节再接着读。';
    else if (userText === '今天午饭吃什么？') reply = '我会挑一份热乎又简单的，吃完不会太困。';
    else if (userText === '抱抱我') reply = '过来，轻轻抱住你一会儿。';
    else if (userText === '嗯，我在听') reply = '好，我先接住你这句话。';
    else if (userText === '我还在听') reply = '嗯，我就陪你安静待一会儿。';
    else reply = '闻溪只回应眼前的话题。';
    return Response.json({ choices: [{ message: { content: isMiyue ? envelope(reply) : reply } }] });
  };
  app = await createApp({
    appDataDir: path.resolve('app-data'),
    dataDir,
    initialFeeds: [],
    integrations: noVoice,
    startPursuits: true,
    startProactive: false,
    startRecall: false,
    startLifeThreads: false,
    replySleep: async () => {},
    clock: () => new Date('2026-09-07T00:00:00.000Z'),
    random:()=>0,
    env: { LIFE_MODEL_BASE_URL: 'https://model.test/v1', LIFE_MODEL_NAME: 'fixture' },
    fetchImpl,
    pursuitCatalog: catalog,
    naturalMaterialDelivery,
    materialPresentation,
  });
  const { port } = await app.listen(0);
  t.after(async () => {
    await app.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return {
    app,
    calls,
    chat: (role, text) => request(`http://127.0.0.1:${port}`, '/api/chat', json({ role, text })),
  };
}

for (const presentation of [{ name: 'legacy natural material delivery', options: { naturalMaterialDelivery: true } }, { name: 'explicit generated presentation', options: { naturalMaterialDelivery: false, materialPresentation: 'generated' } }]) test(`${presentation.name} accepts an HTTP pursuit paraphrase and records the actual reply`, async (t) => {
  const paraphrase = '我把刚才那几页折角摊平了，想慢慢记住里面那个停顿。';
  const { app, chat } = await fixture(t, { ...presentation.options, modelEnvelope: { reply: paraphrase, extra: '' } });
  const before = app.pursuits.get('miyue'); const result = await chat('miyue', '说说你的近况');
  assert.equal(result.status, 200, JSON.stringify(result)); assert.equal(result.body.messages.at(-1).text, paraphrase);
  assert.doesNotMatch(result.body.messages.at(-1).text, new RegExp(before.stage.action));
  const receipt = app.pursuits.get('miyue').history[0];
  assert.equal(receipt.selectedAction, before.stage.action); assert.equal(receipt.actualReply, paraphrase);
});

test('Miyue handoff delivers and records one pursuit stage, then related talk keeps that stage without repeating its anchor', async (t) => {
  const { app, chat } = await fixture(t);
  const before = app.pursuits.get('miyue');
  const first = await chat('miyue', '说说你的近况');
  assert.equal(first.status, 200);
  assert.equal(first.body.messages.at(-1).speaker, 'assistant');
  assert.match(first.body.messages.at(-1).text, new RegExp(before.stage.action));

  const delivered = app.pursuits.get('miyue');
  assert.equal(delivered.stage.index, 0);
  assert.equal(delivered.version, before.version + 1);
  assert.equal(delivered.pendingKey, undefined);
  assert.equal(delivered.history.length, 1);
  assert.equal(delivered.history[0].action, before.stage.action);
  assert.equal(delivered.history[0].messageId, first.body.messages.at(-1).id);

  const followup = await chat('miyue', '这本书后来读到哪里了？');
  assert.equal(followup.status, 200);
  assert.doesNotMatch(followup.body.messages.at(-1).text, new RegExp(before.stage.action));
  assert.match(followup.body.messages.at(-1).text, /还停在刚才那一段/);
  const unchanged = app.pursuits.get('miyue');
  assert.equal(unchanged.stage.index, 0);
  assert.equal(unchanged.version, delivered.version);
  assert.equal(unchanged.history.length, 1);
});

test('unrelated talk and an explicit closeness request do not force an undelivered pursuit action', async (t) => {
  const { app, chat } = await fixture(t);
  const pursuit = app.pursuits.get('miyue');

  const unrelated = await chat('miyue', '今天午饭吃什么？');
  assert.equal(unrelated.status, 200);
  assert.doesNotMatch(unrelated.body.messages.at(-1).text, new RegExp(pursuit.stage.action));
  assert.equal(app.pursuits.get('miyue').history.length, 0);
  assert.equal(app.pursuits.get('miyue').pendingKey, pursuit.pendingKey);

  const affectionate = await chat('miyue', '抱抱我');
  assert.equal(affectionate.status, 200);
  assert.match(affectionate.body.messages.at(-1).text, /抱住你/);
  assert.doesNotMatch(affectionate.body.messages.at(-1).text, new RegExp(pursuit.stage.action));
  assert.equal(app.pursuits.get('miyue').history.length, 0);
  assert.equal(app.pursuits.get('miyue').pendingKey, pursuit.pendingKey);
});

test('a failed model call leaves the pursuit pending and stores no delivery', async (t) => {
  const { app, chat } = await fixture(t, { failure: true });
  const pursuit = app.pursuits.get('miyue');
  const failed = await chat('miyue', '说说你的近况');
  assert.equal(failed.status, 502);
  assert.equal(failed.body.code, 'MODEL_UNAVAILABLE');
  const after = app.pursuits.get('miyue');
  assert.equal(after.version, pursuit.version);
  assert.equal(after.pendingKey, pursuit.pendingKey);
  assert.deepEqual(after.history, []);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM companion_pursuit_deliveries').get().n, 0);
  assert.deepEqual(app.store.getMessages('miyue'), []);
});

test('other roles receive no pursuit title, action, or source metadata in their model prompt', async (t) => {
  const { app, calls, chat } = await fixture(t);
  const pursuit = app.pursuits.get('miyue');
  const response = await chat('wenxi', '说说你最近的近况');
  assert.equal(response.status, 200);
  assert.equal(response.body.messages.at(-1).text, '闻溪只回应眼前的话题。');
  const prompt = calls.at(-1).messages.map((message) => message.content).join('\n');
  assert.doesNotMatch(prompt, new RegExp(pursuit.title));
  assert.doesNotMatch(prompt, new RegExp(pursuit.stage.action));
  assert.doesNotMatch(prompt, new RegExp(pursuit.source.title));
  assert.equal(app.pursuits.get('miyue').history.length, 0);
});

test('manual proactive contact commits the authored pursuit action and delivery once', async (t) => {
  const { app } = await fixture(t);
  app.proactiveRepo.saveSettings({ activeStart: '00:00', activeEnd: '23:59', desktopNotifications: false });
  const before = app.pursuits.get('miyue');
  const result = await app.proactive.runNow();
  assert.equal(result.delivered, true);
  assert.ok(result.message.text.startsWith(before.stage.action));
  const after = app.pursuits.get('miyue');
  assert.equal(after.version, before.version + 1);
  assert.equal(after.history.length, 1);
  assert.equal(after.history[0].messageId, result.message.id);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM companion_pursuit_deliveries').get().n, 1);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM proactive_events WHERE message_id=?').get(result.message.id).n, 1);
  const receipt = app.interactionPolicy.receipt(result.message.id);
  assert.equal(receipt.hasAuthoredAnchor, true);

  assert.equal(app.pursuits.markDelivered(before.pendingKey, result.message.id, before.version), true);
  assert.equal(app.pursuits.get('miyue').version, after.version);
  assert.equal(app.pursuits.get('miyue').history.length, 1);
  assert.equal(app.store.db.prepare('SELECT COUNT(*) AS n FROM companion_pursuit_deliveries').get().n, 1);
});

test('emotional conversation alone does not manufacture a reason to change to a pursuit', async (t) => {
  const { app, chat } = await fixture(t);
  app.store.saveChatTurn({ role: 'miyue', text: '我记得你刚才说的话', reply: '这句话让我心里很暖。' });
  app.store.saveChatTurn({ role: 'miyue', text: '那就慢慢聊', reply: '我也把这份惦记放在心上。' });
  const before = app.pursuits.get('miyue');
  const response = await chat('miyue', '嗯，我在听');
  assert.equal(response.status, 200);
  assert.ok(!response.body.messages.at(-1).text.includes(before.stage.action));
  assert.equal(app.pursuits.get('miyue').version, before.version);
  assert.equal(app.pursuits.get('miyue').history.length, 0);
});

test('first delivered action includes its stored personal reason', async (t) => {
 const catalog=structuredClone(pursuitCatalog);catalog.items[0].origin='做设计时碰到一个表达问题，我想从这本书里换个角度看。';
 const {app,chat}=await fixture(t,{catalog});const result=await chat('miyue','说说你的近况');
 assert.equal(result.status,200);assert.ok(result.body.messages.at(-1).text.startsWith(catalog.items[0].origin));
 assert.ok(result.body.messages.at(-1).text.includes(catalog.items[0].stages[0].action));assert.equal(app.pursuits.get('miyue').history.length,1);
});
test('a spontaneous fictional reading experience is saved with the delivered reply and recalled next turn', async (t) => {
 const modelEnvelope={reply:'我以前读过《局外人》，那种克制当时让我很有共鸣。',extra:'',experience:{kind:'reading',title:'局外人',summary:'以前读过，对克制的表达有共鸣。',evidence:'我以前读过《局外人》'}};
 const {app,chat,calls}=await fixture(t,{modelEnvelope});
 const first=await chat('miyue','你读过《局外人》吗？');assert.equal(first.status,200);assert.match(first.body.messages.at(-1).text,/我以前读过/);
 const saved=app.personalExperiences.list('miyue');assert.equal(saved.length,1);assert.equal(saved[0].messageId,first.body.messages.at(-1).id);assert.equal(saved[0].source,'fictional_conversation');assert.equal(app.pursuits.get('miyue').history.length,0);
 const next=await chat('miyue','你说的那个共鸣，我想听听');assert.equal(next.status,200);
 assert.match(calls.at(-1).messages.map(m=>m.content).join('\n'),/共享经历/);assert.match(calls.at(-1).messages.map(m=>m.content).join('\n'),/以前读过，对克制的表达有共鸣/);assert.equal(app.roleContext('miyue',{initiating:false,text:'你说的那个共鸣，我想听听'}).sharedExperience.title,'局外人');
});
test('a random fresh-content share can arrive while her planned reading remains pending', async (t) => {
 const modelEnvelope=body=>{const prompt=body.messages.map(m=>m.content).join('\n'),id=prompt.match(/ID:([^\n]+)/)?.[1];return{skip:false,contentId:id,reason:'分享一个新看到的细节',message:'我看了《窗边的光》，里面那段观察让我想起画草图时忽略的小地方。',extra:'',experience:{kind:'reading',title:'窗边的光',summary:'读到窗边的光，对细节观察有共鸣。',evidence:'我看了《窗边的光》'}};};
 const {app}=await fixture(t,{modelEnvelope});app.companionTuning.set({pleasing:100,warmth:100,flirtation:100,coyness:100},0);const feed=app.store.addFeed('https://example.test/feed','设计随笔');app.store.addContent(feed,[{title:'窗边的光',url:'https://example.test/window',summary:'这段来源摘要讲作者如何观察窗边光线及物件的变化，记录不同时刻颜色与影子的差别，把日常观察与设计草图联系起来，并比较同一件物品在清晨和傍晚的不同色调。',publishedAt:'2026-09-07T00:00:00.000Z'}],'设计随笔');
 app.proactiveRepo.saveSettings({activeStart:'00:00',activeEnd:'23:59',desktopNotifications:false});
 const before=app.pursuits.get('miyue');const result=await app.proactive.runNow();assert.equal(result.delivered,true);
 assert.match(result.message.text,/窗边的光/);assert.equal(result.message.sourceUrl,'https://example.test/window');assert.ok(app.store.db.prepare('SELECT content_id FROM messages WHERE id=?').get(result.message.id).content_id);assert.equal(app.pursuits.get('miyue').pendingKey,before.pendingKey);assert.equal(app.pursuits.get('miyue').history.length,0);
 assert.equal(app.personalExperiences.list('miyue')[0].title,'窗边的光');
 const receipt=app.interactionPolicy.receipt(result.message.id);assert.equal(receipt.tuningRevision,1);assert.equal(receipt.behavior.style.warmth,'柔软体贴');assert.equal(receipt.behavior.style.stance,'偏爱迁就小偏好');
});

test('ordinary HTTP reply mentioning the active work also cools its scheduled invitation',async t=>{
 const {app,chat}=await fixture(t,{materialPresentation:'generated',modelEnvelope:{reply:'晚饭我准备煮面。顺便翻了翻慢读书，想把那一小段留到明天再看。',extra:''}});
 app.pursuits.get('miyue');
 assert.ok(app.pursuits.pending('miyue'));
 const result=await chat('miyue','晚饭准备吃什么？');
 assert.equal(result.status,200,JSON.stringify(result));
 assert.equal(app.pursuits.pending('miyue'),null);
 const raw=JSON.parse(app.store.db.prepare('select state_json from companion_pursuit_state where role_id=?').get('miyue').state_json);
 assert.ok(raw.lastMentionMessageId);assert.ok(raw.lastMentionedAt);
 assert.equal(app.pursuits.get('miyue').history.length,0,'mention is not a fabricated formal stage delivery');
});
