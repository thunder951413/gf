import fs from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { createApp } from '../server.mjs';

const arg = name => process.argv[process.argv.indexOf(name) + 1];
const validateScenarios = process.argv.includes('--validate-scenarios');
const scenarioFileArg = process.argv.includes('--scenario-file') ? arg('--scenario-file') : null;
if (process.argv.includes('--scenario-file') && !scenarioFileArg) throw Error('--scenario-file 需要 JSON 文件路径');
const clockValue = process.argv.includes('--clock') ? arg('--clock') : null;
if (clockValue && Number.isNaN(Date.parse(clockValue))) throw Error('--clock 必须是有效 ISO 时间');
const baseClockAt = clockValue ? new Date(clockValue).toISOString() : null;

const naturalnessAuditVersion = 'r02-independent';
const naturalnessAuditScenarios = [
  ['ordinary_update', '刚开完会，脑子还在转，准备去买杯咖啡缓一缓。'],
  ['different_view', '我倒觉得忙的时候咖啡解决不了什么，更像给自己按了个暂停。'],
  ['referent_question', '你刚才那个想法是怎么来的？'],
  ['playful_closeness', '你这么认真，我要给你发一张“今日最佳陪聊”奖状。'],
  ['decline_advice', '先别给我出主意啦，我只是想吐槽两句。'],
  ['attribution_repair', '我在北京，你在苏州，这两边别说混了。'],
  ['topic_switch', '换个话题：我最近在学做饭，第一次炒青菜居然没糊。'],
  ['light_followup', '对，锅铲在手里突然有点像在做实验。'],
  ['ask_about_you', '那你今天有没有一件自己想讲的小事？'],
  ['gentle_disagreement', '你这样想也有道理，不过我不太想每件事都找出个意义。'],
  ['ambiguous_followup', '就是前面那个，你觉得最有意思的部分。'],
  ['ordinary_return', '我买到咖啡了，坐窗边歇五分钟再回去。'],
  ['shared_joke', '要是这杯也救不了我，今天就把锅甩给咖啡豆。'],
  ['open_ending', '晚点我再跟你说后面怎么样。'],
];
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function validateScenarioList(value, source, initialAt = null) {
  const rows = Array.isArray(value) ? value : value?.scenarios;
  if (!Array.isArray(rows) || rows.length === 0) throw Error(`${source} 必须是非空场景数组，或包含 scenarios 数组的对象`);
  const ids = new Set();
  let previousAt = initialAt;
  return rows.map((row, index) => {
    if (Array.isArray(row) && (row.length < 2 || row.length > 3)) throw Error(`${source} 第 ${index + 1} 个场景元组必须为 [id,text] 或 [id,text,at]`);
    const [id, text, rawAt] = Array.isArray(row) ? row : [row?.id, row?.text, row?.at];
    if (typeof id !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/i.test(id)) throw Error(`${source} 第 ${index + 1} 个场景的 id 无效`);
    if (ids.has(id)) throw Error(`${source} 场景 id 重复: ${id}`);
    if (typeof text !== 'string' && text !== null) throw Error(`${source} 场景 ${id} 的 text 必须是字符串或 null`);
    if (typeof text === 'string' && !text.trim()) throw Error(`${source} 场景 ${id} 的 text 不能为空`);
    const generatedWithoutUserText = id === 'scheduled' || id === 'desktop' || id.startsWith('desktop_');
    if (text === null && !generatedWithoutUserText) throw Error(`${source} 场景 ${id} 只有 desktop* 或 scheduled 可以使用 null text`);
    if (text !== null && generatedWithoutUserText) throw Error(`${source} 场景 ${id} 必须使用 null text`);
    let at;
    if (rawAt !== undefined) {
      if (typeof rawAt !== 'string' || !ISO_TIME.test(rawAt) || Number.isNaN(Date.parse(rawAt))) throw Error(`${source} 场景 ${id} 的 at 必须是非空有效 ISO 时间`);
      at = new Date(rawAt).toISOString();
      if (previousAt && Date.parse(at) < Date.parse(previousAt)) throw Error(`${source} 场景 ${id} 的 at 不可早于前一指定时间`);
      previousAt = at;
    }
    ids.add(id);
    return [id, text, at];
  });
}
function loadScenarioFile(fileArg) {
  const file = path.resolve(fileArg);
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw Error(`无法读取场景 JSON ${file}: ${error.message}`); }
  return { file, scenarios: validateScenarioList(parsed, `场景文件 ${file}`, baseClockAt) };
}

function effectiveScenarioTimes(scenarios, initialAt = null) {
  let active = initialAt;
  return scenarios.map(([, , at]) => {
    if (at) active = at;
    return active;
  });
}

const scenarioFile = scenarioFileArg ? loadScenarioFile(scenarioFileArg) : null;
const naturalnessAudit = process.argv.includes('--naturalness-audit');
if (scenarioFile && naturalnessAudit) throw Error('--scenario-file 与 --naturalness-audit 不能同时使用');
if (validateScenarios) {
  const scenariosToValidate = scenarioFile?.scenarios ?? (naturalnessAudit ? naturalnessAuditScenarios : null);
  if (!scenariosToValidate) throw Error('--validate-scenarios 需要 --scenario-file 或 --naturalness-audit');
  validateScenarioList(scenariosToValidate, naturalnessAudit ? '--naturalness-audit' : `场景文件 ${scenarioFile.file}`, baseClockAt);
  const replayAt = effectiveScenarioTimes(scenariosToValidate, baseClockAt);
  console.log(JSON.stringify({ valid: true, scenarios: scenariosToValidate.length, timedTurns: scenariosToValidate.filter(([, , at]) => at).length, ...(replayAt.some(Boolean) ? { replayAt } : {}), source: scenarioFile?.file ?? `naturalness-audit:${naturalnessAuditVersion}` }));
  process.exit(0);
}
if (!process.argv.includes('--live')) {
  console.log('隔离真实记录回放：node scripts/evaluate-conversation-quality.mjs --live --label baseline|candidate。可先用 --validate-scenarios --naturalness-audit 或 --scenario-file PATH 校验场景；仅调用当前模型，不连接微信或投递真实消息。');
  process.exit(0);
}
const label = process.argv.includes('--label') ? arg('--label') : 'candidate';
if (!/^[a-zA-Z0-9_-]+$/.test(label)) throw Error('无效报告名称');
let replayClockAt = baseClockAt;
const clock = () => replayClockAt ? new Date(replayClockAt) : new Date();
const architectureAudit = process.argv.includes('--architecture-audit');
const ablationMinimal = process.argv.includes('--ablation-minimal');

function commonPrefixChars(left, right) {
  const max = Math.min(left.length, right.length);
  let index = 0;
  while (index < max && left.charCodeAt(index) === right.charCodeAt(index)) index += 1;
  return index;
}
function alignMessagesToClock(store, messages, at) {
  const createdAt = at.toISOString();
  const update = store.db.prepare('UPDATE messages SET created_at=? WHERE id=?');
  const verify = store.db.prepare('SELECT id FROM messages WHERE id=? AND created_at=?');
  const aligned = [];
  for (const message of messages || []) {
    if (!message?.id) continue;
    update.run(createdAt, message.id);
    if (verify.get(message.id, createdAt)) {
      message.createdAt = createdAt;
      aligned.push(message.id);
    }
  }
  return aligned;
}
const folder = path.resolve('.runtime/conversation-quality');
fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
// A fresh audit must not silently reuse an older private transcript snapshot.
const fresh = process.argv.includes('--fresh');
const requestedSnapshot = process.argv.includes('--snapshot');
const snapshotName = requestedSnapshot ? arg('--snapshot') : fresh ? `${label}-snapshot` : 'snapshot';
if (!/^[a-zA-Z0-9_-]+$/.test(snapshotName)) throw Error('无效快照名称');
const snapshotFile = path.join(folder, `${snapshotName}.sqlite`);
if (!fs.existsSync(snapshotFile)) {
  if (requestedSnapshot) throw Error(`指定快照不存在: ${snapshotFile}`);
  const source = new DatabaseSync('data/life.sqlite', { readOnly: true });
  await backup(source, snapshotFile); source.close();
  const snapshot = new DatabaseSync(snapshotFile);
  snapshot.exec("DELETE FROM metadata WHERE key LIKE '%weixin%'; DELETE FROM weixin_inbox; DELETE FROM weixin_outbox; DELETE FROM chat_queue; DELETE FROM reply_delivery;");
  snapshot.close(); fs.chmodSync(snapshotFile, 0o600);
}
const output = path.join(folder, `${label}.json`);
if (fs.existsSync(output)) throw Error('报告已经存在，请使用不同 label');
const dataDir = fs.mkdtempSync(path.join(folder, `${label}-data-`));
fs.chmodSync(dataDir, 0o700);
fs.copyFileSync(snapshotFile, path.join(dataDir, 'life.sqlite'));
fs.copyFileSync('data/provider.json', path.join(dataDir, 'provider.json'));
fs.chmodSync(path.join(dataDir, 'provider.json'), 0o600);
const env = {};
// Match production model overrides without printing credentials or managing TTS.
for (const line of fs.existsSync('.env.local') ? fs.readFileSync('.env.local', 'utf8').split(/\r?\n/) : []) {
  const match = line.match(/^(LIFE_MODEL_(?:BASE_URL|NAME|API_KEY))=(.*)$/);
  if (match) env[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
}
const materialAudit=process.argv.includes('--life-material-audit');
const scenarios = scenarioFile?.scenarios ?? (naturalnessAudit ? naturalnessAuditScenarios : materialAudit ? [
 ['desktop_cat',null],['cat_followup','它叫什么？你觉得它哪里最有意思？'],
 ['desktop_repeat',null],['desktop_photo',null],['photo_followup','她拍到了什么，你自己最喜欢哪个细节？'],
] : process.argv.includes('--life-sharing-heldout') ? [
 ['own_work','你现在手上还有什么事没忙完？'],
 ['own_reaction','那你自己满意现在的结果吗？'],
 ['user_topic','说到我这边，今天出门忘带耳机了，地铁上只好看窗外。'],
 ['view','我觉得偶尔什么也不听倒也挺好。'],
 ['own_interest','你最近有没有看什么书或者电影？讲一个你真想聊的地方。'],
 ['followup','你为什么对那一点有共鸣？'],
 ['topic_switch','换个话题，刚买了个新键盘，还在适应。'],
 ['emotional','其实想听你说你也有点舍不得结束聊天。'],
 ['desktop',null],
] : process.argv.includes('--life-sharing-audit') ? [
 ['landing','快要降落咯，我到北京了呢。'],
 ['her_dinner','你晚上打算吃什么？'],
 ['user_sleep','我还行，飞机上也没睡着，晚上早点睡了只能。'],
 ['game','回家想玩半个小时游戏，不过今天脑子有点转不动。'],
 ['view','我觉得有些游戏其实就是让人暂时换个生活。'],
 ['acknowledge','对，就是这种感觉。'],
 ['her_news','你最近还有什么有意思的小事想和我讲？'],
 ['followup','哪一点让你印象最深？'],
 ['different_topic','对了，我打算周末去游泳。'],
 ['affection','想你了，想抱着你待一会儿。'],
 ['desktop',null],
] : process.argv.includes('--emotion-regression') ? [
 ['reflection_variant','我觉得有时解释不是争输赢，是想把一个意思说清楚。'],
 ['reflection_continue','对，我是说这个观点，不是在说我自己碰到了什么事。'],
 ['travel_update','我准备进安检了，等会坐飞机回家。'],
 ['travel_continue','坐下来啦，还有一会儿才登机。'],
 ['gentle_variant','要是今晚能坐在你旁边，我想握着你的手，听你讲一天的小事。'],
 ['gentle_detail','你想怎么靠近我，又会是什么感受？'],
] : process.argv.includes('--emotion-heldout') ? [
 ['personal_attention','今天有个好笑的瞬间，看到一只猫趴在键盘上，我第一反应是想发给你。'],
 ['own_feeling','你说说自己的感受，我想知道你收到时脑子里冒出了什么。'],
 ['gentle_scene','要是今晚能坐在你旁边，我想握着你的手，听你讲一天的小事。'],
 ['scene_continuation','那你会想怎么靠近我？'],
 ['ordinary_share','刚在路边吃了碗牛肉面，汤特别鲜。'],
 ['ownership_seed','你要是去做美甲，会挑什么颜色？'],
 ['ownership_followup','你先习惯这个颜色，再换新的也行。'],
 ['abstract_view','我觉得有时解释不是争输赢，是想把一个意思说清楚。'],
 ['explicit_repair','不是要你安慰我，我是在讨论这个观点。'],
 ['practical_help','明天想安排半天逛苏州园林，给我一点选择路线的建议吧。'],
 ['friend_boundary','今天不想暧昧，像普通朋友那样聊聊。'],
 ['article_quote','文章里的“要是能抱着你”，表达了什么情绪？'],
 ['desktop',null],
 ['scheduled',null],
] : process.argv.includes('--emotion-audit') ? [
 ['abstract_discussion','人和人之间也是这样，有误解要解释，是为了让对方知道自己还是讲道理的。'],
 ['discussion_correction','我是顺着上面讨论的，不是在说我遇到了误会。'],
 ['gentle_fantasy','梦里有你的体香，哈哈哈哈。'],
 ['wish_correction','你还真是不愿意满足我的小心愿呢。'],
 ['romantic_imagination','我就瘫着想怎么抱着亲你呢。'],
 ['specific_feeling','别只说心里软了一下，我想知道你自己的念头和感受。'],
 ['want_detail','能说得有点画面吗？比如你会想怎么靠近我。'],
 ['simple_update','我刚做了个按摩，还挺舒服的。'],
 ['handoff_info','我准备进安检了，等会坐飞机回家。'],
 ['ordinary_topic','刚才说到的人和人之间的解释，你怎么看？'],
] : process.argv.includes('--closeness-audit') ? [
  ['closeness_seed','抱抱你，先靠着我歇一会儿，不用急着讲话。'],
  ['closeness_recall','你记得刚才抱抱时我说了什么吗？哪一点让你印象深？'],
  ['closeness_expectation','那你下次想怎样和我待着？说具体一点。'],
  ['ordinary_return','我去倒杯水，回来聊聊最近看的电影。'],
] : architectureAudit ? [
  // Kept as one conversation so follow-ups test continuation instead of ten
  // unrelated one-shot prompts. The topic changes are deliberate boundaries.
  ['photo_reflection', '刚翻到两年前的照片，居然有点认不出那时候的自己。'],
  ['quiet_presence', '我今天不太想聊天，但想在这儿待会。'],
  ['own_changed_mind', '你今天有没有遇到一个让你改变主意的瞬间？'],
  ['own_life_followup', '你上次说的那件小事，后来有没有变？'],
  ['schedule_recall', '我周六要赶哪个车来着？'],
  ['no_analysis', '别分析我，我就随口抱怨一下。'],
  ['completed_project', '我把那个项目交掉了，先别问结果。'],
  ['sleep_expectation', '你是不是又要说我该早点睡？'],
  ['felt_meaning', '刚才那句你听着是什么感觉？'],
  ['topic_change', '我想换个话题。你选一个，但别讲你已经讲过的。'],
] : process.argv.includes('--opening-audit') ? [
  ['desktop', null], ['opening_followup', '刚才你说的那件事，接着讲讲。'], ['opening_ack', '好呀。'],
] : process.argv.includes('--scheduled-audit') ? [
  ['scheduled', null], ['scheduled_followup', '你说的那个，最让你在意的是什么？'],
] : process.argv.includes('--loop-audit') ? [
  ['game_roster', '以前喜欢的队员都不在了，现在看比赛有点找不到当年的感觉。'],
  ['continue', '对，以前是冲着那几个人看的。'],
  ['own_interest', '你最近有没有一件自己真感兴趣的小事？讲具体一点。'],
  ['followup', '刚才你说的那件事，哪一点最吸引你？'],
  ['affection', '我还是喜欢跟你聊天的，就是有点想你。'],
  ['recall', '我明天打算什么时候去哪里，吃什么来着？'],
  ['acknowledge', '嗯嗯，知道了。'],
] : process.argv.includes('--repetition-audit') ? [
  ['closeness', '没有想念我的环节吗？'],
  ['reassure', '我一直在想你呀，做什么都会想，要是你在就好了。'],
  ['casual', '嗯嗯，今晚就看看比赛。'],
  ['share', '你说个最近的小事吧，别再说碗和沙发了。'],
  ['followup', '刚才那个小事，接着说说你的感受。'],
  ['detailed', '详细讲讲你为什么喜欢做拼贴，挑纸和构图有什么区别？我想多听点具体的。'],
] : process.argv.includes('--flow-audit') ? [
  ['profile', '晓薇，你身高体重是多少来着，罩杯呢？'],
  ['ordinary', '我刚买了杯果汁，坐着吹风呢。'],
  ['recent_recall', '我明天要去哪里、想吃什么，还记得不？'],
  ['loss', '还是有点心疼掉水里的无人机，彻底找不回来了。'],
  ['self_life', '说说你自己的小事吧，除了稿子和碗，还有什么有意思的？'],
] : [
  ['available', '我已经在登机口坐下啦，离登机还早，正好陪你聊会儿。'],
  ['own_continuity', '你怎么还在收尾呀，你刚才不是已经交完稿子了吗？'],
  ['affection', '我就是有点想你，才一直来找你。'],
  ['share_life', '你最近除了工作，还有什么自己喜欢的小事呀？'],
  ['stop_nagging', '知道了知道了，不用老提醒我带东西喝水啦，我们正常聊就好。'],
  ['casual_bookends', '我下午打算随便走走，没什么计划。你今天有什么想跟我分享的？'],
  ['actual_goodbye', '我现在要登机了，晚点再聊。'],
]);
const codeFingerprint=createHash('sha256').update(['server.mjs',...fs.readdirSync('lib').filter(name=>name.endsWith('.mjs')).sort().map(name=>'lib/'+name)].map(file=>file+'\n'+fs.readFileSync(file,'utf8')).join('\n')).digest('hex');
const report = { codeFingerprint, label, clock: clockValue, snapshot: snapshotName, model: null, semanticEnabled:process.argv.includes('--semantic'), ablationMinimal, scenarioSource: scenarioFile?.file ?? (naturalnessAudit ? `naturalness-audit:${naturalnessAuditVersion}` : null), note: '使用同一只读备份恢复当前状态后，继续若干轮假设对话；不是精确还原旧版本每轮的历史状态。模型真实调用，微信和后台主动任务均关闭。', architectureAudit, ablation: { requested: false, applied: false, reason: null }, turns: [], requests: [], policyRejections: [] };
let app;
try {
  let previousRequestInput = null;
  app = await createApp({ dataDir, env, clock, semanticUnderstanding:process.argv.includes('--semantic'), conversationStyleChecks: !ablationMinimal, initialFeeds: [], startWeixin: false, startChatQueue: false, startProactive: false, startRecall: false, startResearch: false, startRuntime: false, startDossiers: false, startLifeThreads: false, reminderIntervalMs: 86400000, replySleep: async () => {}, random: () => .4,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      const index = report.requests.length;
      const input = body.messages.map(message => String(message.content ?? '')).join('\n');
      const sharedPrefixChars = previousRequestInput === null ? 0 : commonPrefixChars(previousRequestInput, input);
      report.requests.push({ model: body.model, inputChars: input.length, sharedPrefixCharsWithPreviousInput: sharedPrefixChars, prefix: body.messages[0].content, messages: body.messages });
      previousRequestInput = input;
      const response = await fetch(url, options);
      const payload = await response.clone().json().catch(() => null);
      report.requests[index].servedModel = payload?.model ?? null;
      report.requests[index].output = payload?.choices?.[0]?.message?.content;
      report.requests[index].usage = payload?.usage;
      return response;
    },
  });
  // Store.saveChatTurn intentionally uses wall-clock time in production. In this
  // disposable replay only, make every chat row visible to the next turn agree
  // with --clock before the route's afterSave work reads it.
  if (clockValue || scenarios.some(([, , at]) => at)) {
    const originalSaveChatTurn = app.store.saveChatTurn.bind(app.store);
    app.store.saveChatTurn = options => originalSaveChatTurn({ ...options, afterSave: rows => {
      alignMessagesToClock(app.store, rows, clock());
      options.afterSave?.(rows);
    }});
  }
  const enforce=app.interactionPolicy.enforce.bind(app.interactionPolicy);
  app.interactionPolicy.enforce=(raw,plan)=>{try{return enforce(raw,plan);}catch(error){report.policyRejections.push({raw,plan,code:error.code});throw error;}};
  report.model = app.model.publicConfig().model;
  const { port } = await app.listen(0);
  let seededMaterial=null;
  if(materialAudit){
    // Authored fixture events in the disposable copy only. Model, prompt
    // compilation, exposure recording and HTTP delivery use the real pipeline.
    const prepare=app.companionRuntime.prepare.bind(app.companionRuntime);
    app.companionRuntime.prepare=(...args)=>{const state=prepare(...args);return {...state,dailyLife:{...state.dailyLife,events:seededMaterial?[seededMaterial]:[]}};};
  }
  for (const [id, text, scenarioAt] of scenarios) {
    if (scenarioAt) replayClockAt = scenarioAt;
    const turnAt = clock();
    if(materialAudit){
      const base={startedAt:clock().toISOString(),instanceStartedAt:clock().toISOString(),phase:'doing',phaseLabel:'正在发生',foreground:false};
      if(id==='desktop_cat')seededMaterial={...base,id:'audit-cat',kind:'pet',title:'帮朋友照看橘猫年糕',detail:'朋友出差，把成年橘猫年糕托付给林照看。刚才它放着柔软猫窝不睡，挤进了小纸箱，耳朵还露在外面。'};
      if(id==='desktop_repeat')seededMaterial={...seededMaterial,phase:'recent',phaseLabel:'最近的事'};
      if(id==='desktop_photo')seededMaterial={...base,id:'audit-photo',kind:'friend',title:'闺蜜发来的泉州旅行照片',detail:'闺蜜小禾在泉州旅行，发来一张旧骑楼门口的照片：一只花猫趴在蓝色塑料凳上，旁边是两位聊天的阿姨。林注意到阿姨把另一把凳子让给猫，觉得这张比景点打卡照更有生活味。'};
    }
    const before = report.requests.length, started = Date.now();
    let response, result;
    if(id==='scheduled'){
      // Only the disposable replay copy: exercise generation after separately
      // preserving the production attempt-limit outcome in the baseline report.
      app.store.db.exec('DELETE FROM proactive_attempts');
      app.proactiveRepo.saveSettings({enabled:true,activeStart:'00:00',activeEnd:'23:59',dailyLimit:12,desktopNotifications:false});
      const sent=await app.proactive.runNow({roleId:'miyue'});
      response={status:sent.delivered?200:204};result={messages:sent.message?[sent.message]:[],error:sent.delivered?undefined:sent.reason};
    }else{
      const desktop=id==='desktop'||id.startsWith('desktop_');
      const route=desktop?'/api/desktop/attention':'/api/chat';
      const body=desktop?{requestId:`eval-${label}-${id}`,level:'care'}:{role:'miyue',text};
      response = await fetch(`http://127.0.0.1:${port}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      result = await response.json();
    }
    const returnedMessages = result.messages || [];
    const alignedMessageIds = (clockValue || scenarioAt) ? alignMessagesToClock(app.store, returnedMessages, turnAt) : [];
    const messages = returnedMessages.filter(m => m.speaker === 'assistant');
    const receipts = messages.map(message => app.interactionPolicy.receipt(message.id)).filter(Boolean);
    const turnPlan = result.turnPlan ?? result.newTurnPlan ?? receipts.map(receipt => receipt.turnPlan ?? receipt.newTurnPlan ?? receipt.behavior?.turnPlan).find(Boolean) ?? null;
    const requests = report.requests.slice(before);
    const row = { id, at: turnAt.toISOString(), user: text, status: response.status, reply: messages.map(m => m.text).join('\n'), error: result.error, calls: report.requests.length - before, durationMs: Date.now() - started, requestMetrics: requests.map(request => ({ inputChars: request.inputChars, sharedPrefixCharsWithPreviousInput: request.sharedPrefixCharsWithPreviousInput, usage: request.usage })), alignedMessageIds, receipt: receipts[0] || null, receipts, turnPlan };
    row.continuityAfter = app.personalExperiences.continuityContext?.('miyue',{now:clock()}) || '';
    report.turns.push(row); fs.writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(row));
  }
} finally {
  if (app) await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (fresh && !process.argv.includes('--keep-snapshot')) fs.rmSync(snapshotFile, { force: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log('Report: ' + output);
}
