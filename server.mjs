import {selectCompanionSources,companionSourceContext} from './lib/companion-sources.mjs';
import { networkConfig } from './lib/network-config.mjs';
import { mentionedSources } from './lib/source-mentions.mjs';
import { CompanionSourceHistory } from './lib/companion-source-history.mjs';
import { importCompanionRelationship } from './lib/companion-relationship-import.mjs';
import { recentEventDigest } from './lib/recent-events.mjs';
import { SharedExperiences } from './lib/shared-experiences.mjs';
import { importSharedExperiences } from './lib/shared-experience-import.mjs';
import { CompanionRelationship, explicitRomanceProposal } from './lib/companion-relationship.mjs';
import { CompanionAgenda } from './lib/companion-agenda.mjs';
import { parseCompanionshipUpdates, withCompanionshipProtocol, LIFE_UPDATE_INSTRUCTION } from './lib/companion-updates.mjs';
import { plannedShare, focusPolicy, shareContext } from './lib/companion-focus.mjs';
import {conversationThread} from './lib/conversation-thread.mjs';
import {plainSpeechIssues, continuationIssues, PLAIN_SPEECH_REVISION} from './lib/companion-style.mjs';
import { ContentInbox } from './lib/content-inbox.mjs';
import { newsBriefContext, composeNewsBrief } from './lib/news-brief.mjs';
import {lookupUserEvidence} from './lib/memory-lookup.mjs';
import {CompanionBehavior,companionIntent} from './lib/companion-behavior.mjs';
import {compactCompanionBackground} from './lib/companion-context.mjs';
import { CompanionTuningRepository, tuningPreview } from './lib/companion-tuning.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EpisodicMemoryRepository } from './lib/episodic-memory.mjs';
import { ConversationPolicyRepository } from './lib/conversation-policy.mjs';
import { LifeThreadRepository } from './lib/life-threads.mjs';
import { PersonalExperiences } from './lib/personal-experiences.mjs';
import { DesktopControl } from './lib/desktop-control.mjs';
import { DesktopAttention, desktopAttentionIssues } from './lib/desktop-attention.mjs';
import { DailyLife, dailyLifeContext } from './lib/daily-life.mjs';
import { DailyLifeEffects } from './lib/daily-life-effects.mjs';
import { focusLifeEvents, lifeEventTurnContext, lifeEventReplyIssues } from './lib/life-event-turn.mjs';
import { ClosenessMemory } from './lib/closeness-memory.mjs';
import { CompanionPursuits } from './lib/companion-pursuits.mjs';
import { routePursuit, articlePursuit, pursuitAnchor } from './lib/pursuit-routing.mjs';
import { SourceChangesRepository } from './lib/source-changes.mjs';
import { Store } from './lib/store.mjs';
import { ModelClient, buildChatMessages } from './lib/model.mjs';
import { ProactiveRepository } from './lib/proactive-store.mjs';
import { ZhihuClient } from './lib/zhihu-client.mjs';
import { ZhihuRepository, ZHIHU_FEED_ID } from './lib/zhihu-store.mjs';
import { ZhihuResearch } from './lib/zhihu-research.mjs';
import { ProactiveEngine } from './lib/proactive.mjs';
import { notifyDesktop, desktopNotificationsAvailable } from './lib/desktop-notify.mjs';
import { CharacterRepository, migrateOnlineFriend } from './lib/characters.mjs';
import { WardrobeRepository } from './lib/wardrobe.mjs';
import { AppearanceRepository } from './lib/appearance.mjs';
import { SceneImagesRepository } from './lib/scene-images.mjs';
import { ImageLibraryRepository } from './lib/image-library.mjs';
import { CompanionRuntime } from './lib/companion-runtime.mjs';
import { RuntimeScenes } from './lib/runtime-scenes.mjs';
import { runtimeContext } from './lib/runtime-context.mjs';
import { dialogueLimits } from './lib/dialogue-budget.mjs';
import { LifeEventRepository } from './lib/life-events.mjs';
import { LifeTopicRepository } from './lib/life-topics.mjs';
import { selectLifeContent } from './lib/life-content.mjs';
import { InnerStateRepository } from './lib/inner-state.mjs';
import { requestEmotionEnvelope, parseEmotionEnvelope, emotionExtra } from './lib/emotion-dialogue.mjs';
import { RecallRepository, RecallEngine } from './lib/recall.mjs';
import { UsageRepository } from './lib/usage.mjs';
import { ContentDossierRepository } from './lib/content-dossier.mjs';
import { ScenarioRepository } from './lib/scenarios.mjs';
import { GentleFeedbackRepository } from './lib/gentle-feedback.mjs';
import { PreferencesRepository } from './lib/preferences.mjs';
import { BackgroundRepository } from './lib/background.mjs';
import { MomentsRepository } from './lib/moments.mjs';
import { RoleVoiceRepository } from './lib/role-voices.mjs';
import { FollowupRepository } from './lib/followups.mjs';
import { TopicTrackingRepository } from './lib/topic-tracking.mjs';
import { ChatQueue, ReplyDelivery, splitReply } from './lib/chat-queue.mjs';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const jsonTypes = new Set(['application/json']);
const audioTypes = new Set(['audio/webm', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'application/ogg']);
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon' };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) {
    if (fallback !== undefined && error.code === 'ENOENT') return fallback;
    throw error;
  }
}
function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
}
function fail(status, message, code) { const error = new Error(message); error.status = status; error.code = code; return error; }
async function readBody(req, limit) {
  const parts = []; let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > limit) throw fail(413, '请求内容过大', 'BODY_TOO_LARGE');
    parts.push(part);
  }
  return Buffer.concat(parts);
}
async function readJsonBody(req, limit = 1_000_000) {
  const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
  if (!jsonTypes.has(contentType)) throw fail(415, '请求需要使用 application/json', 'CONTENT_TYPE_REQUIRED');
  const body = await readBody(req, limit);
  let parsed;
  try { parsed = body.length ? JSON.parse(body.toString('utf8')) : {}; } catch { throw fail(400, 'JSON 格式无效', 'INVALID_JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail(400, 'JSON 必须是对象', 'INVALID_JSON');
  return parsed;
}
function requiredText(value, field = 'text', max = 10_000) {
  if (typeof value !== 'string' || !value.trim()) throw fail(400, `${field} 不能为空`, 'INVALID_INPUT');
  const text = value.trim();
  if (text.length > max) throw fail(400, `${field} 过长`, 'INVALID_INPUT');
  return text;
}
function validHttpUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
function validProviderUrl(value) {
  try { const url = new URL(value); return typeof value === 'string' && !value.includes('?') && !value.includes('#') && validHttpUrl(value) && !url.search && !url.hash; } catch { return false; }
}
async function availableService(call, fallbackMessage) {
  try { return await call(); } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(fallbackMessage);
    if (!error.status) error.status = 503;
    if (!error.message) error.message = fallbackMessage;
    throw error;
  }
}
function validateAvatar(value) {
  if (typeof value !== 'string') throw fail(400, '头像必须是图片数据', 'INVALID_AVATAR');
  const match = value.match(/^data:(image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]*={0,2})$/);
  if (!match || match[2].length % 4 !== 0 || (match[2].includes('=') && !/=+$/.test(match[2]))) throw fail(400, '头像格式无效', 'INVALID_AVATAR');
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > 400 * 1024) throw fail(400, '头像文件过大或为空', 'INVALID_AVATAR');
  const validSignature = (match[1] === 'image/png' && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    || (match[1] === 'image/jpeg' && data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    || (match[1] === 'image/webp' && data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP');
  if (!validSignature) throw fail(400, '头像内容与图片类型不匹配', 'INVALID_AVATAR');
  return value;
}
function validateBackgroundImage(value) {
  if (value === null) return null;
  if (typeof value !== 'string') throw fail(400, '背景必须是图片数据', 'INVALID_BACKGROUND');
  const match = value.match(/^data:(image\/png|image\/jpeg|image\/webp);base64,([A-Za-z0-9+/]*={0,2})$/);
  if (!match || !match[2] || match[2].length % 4 !== 0 || (match[2].includes('=') && !/=+$/.test(match[2]))) throw fail(400, '背景图片格式无效', 'INVALID_BACKGROUND');
  const data = Buffer.from(match[2], 'base64');
  if (data.toString('base64') !== match[2] || data.length > 2 * 1024 * 1024) throw fail(400, '背景图片过大或无效', 'INVALID_BACKGROUND');
  const validSignature = (match[1] === 'image/png' && data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    || (match[1] === 'image/jpeg' && data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff)
    || (match[1] === 'image/webp' && data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP');
  if (!validSignature) throw fail(400, '背景内容与图片类型不匹配', 'INVALID_BACKGROUND');
  return value;
}
function validateBackground(value) {
  const required = ['image', 'mode', 'position', 'veil', 'blur'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== required.length || !required.every(key => Object.hasOwn(value, key))) throw fail(400, '背景设置无效', 'INVALID_BACKGROUND');
  if (!['cover', 'contain', 'stretch', 'tile'].includes(value.mode) || !['center', 'top', 'bottom'].includes(value.position) || !Number.isFinite(value.veil) || value.veil < 0 || value.veil > 0.9 || !Number.isFinite(value.blur) || value.blur < 0 || value.blur > 12) throw fail(400, '背景设置无效', 'INVALID_BACKGROUND');
  return { image: validateBackgroundImage(value.image), mode: value.mode, position: value.position, veil: value.veil, blur: value.blur };
}

export async function createApp(options = {}) {
  const network = networkConfig(options, options.env ?? process.env);
  const dataDir = path.resolve(options.dataDir || path.join(rootDir, 'data'));
  const appDataDir = path.resolve(options.appDataDir || path.join(rootDir, 'app-data'));
  const publicDir = path.resolve(options.publicDir || path.join(rootDir, 'public'));
  const roles = options.roles || readJson(path.join(appDataDir, 'roles.json'));
  const story = options.story || readJson(path.join(appDataDir, 'story.json'));
  const initialFeeds = options.initialFeeds || readJson(path.join(appDataDir, 'feeds.json'), []);
  const integrations = options.integrations || await import('./lib/integrations.mjs');
  const roleMap = new Map(roles.map((role) => [role.id, role]));
  const store = new Store({ dataDir, story, initialFeeds });
  const desktopControl = options.desktopControl || new DesktopControl();
  const wardrobe = new WardrobeRepository(store, { clock: options.clock, random: options.wardrobeRandom });
  const proactiveRepo = new ProactiveRepository(store, { feedCatalog: initialFeeds, clock: options.clock });
  const companionSourceHistory = new CompanionSourceHistory(store, {clock:options.clock});
  companionSourceHistory.backfill();
  proactiveRepo.addDefaultSourcesOnce(initialFeeds);
  const contentInbox = new ContentInbox(store, {clock: options.clock, feedCatalog: initialFeeds});
  const followups = new FollowupRepository(store,{clock:options.clock});
  const topicTracking = new TopicTrackingRepository(store,{clock:options.clock});
  const usage = new UsageRepository(store, { clock: options.clock });
  const life = new LifeEventRepository(store, { clock: options.clock, random: options.lifeRandom || options.random });
  const lifeTopics = new LifeTopicRepository(store, { clock: options.clock });
  const companionTuning = new CompanionTuningRepository(store);
  const companionBehavior = new CompanionBehavior(store,companionTuning);
  const companionRelationship=new CompanionRelationship(store,{clock:options.clock});
  const companionAgenda=new CompanionAgenda(store,{clock:options.clock,random:options.agendaRandom||options.random,getSuppressedSourceIds:roleId=>episodes.suppressedSourceIds(roleId)});
  const inner = new InnerStateRepository(store, { clock: options.clock, random: options.innerRandom || options.random, getTuning:()=>companionTuning.get().values,getRelationship:()=>companionRelationship.view('miyue',{suppressedSourceIds:episodes.suppressedSourceIds('miyue')}) });
  const closenessMemory=new ClosenessMemory(store,{clock:options.clock});
  const characters = new CharacterRepository(store, { clock: options.clock, random: options.random, lifeEvents: life, innerState: inner, getTuning:()=>companionTuning.get() });
  const appearance = new AppearanceRepository(store,{clock:options.clock,random:options.appearanceRandom,
    catalog:options.appearanceCatalog,catalogPath:options.appearanceCatalogPath,wardrobe,
    getState:()=>{const currentLife=life.get('miyue'),character=characters.get('miyue',{lifeSnapshot:currentLife});return {world:character.world,inner:character.inner};},
    isBusy:()=>activeRoles.has('miyue')||chatQueue.busy('miyue')||Boolean(replyDelivery.pending('miyue'))});
  const sceneImages = new SceneImagesRepository(store,{dataDir});
  const imageLibrary = new ImageLibraryRepository(store,{dataDir,sceneImages});
  const recallRepo = new RecallRepository(store, { clock: options.clock });
  const scenarioRole = roles.find(role => role.interaction?.mode === 'scenario');
  const scenarios = new ScenarioRepository(store, { roleId: scenarioRole?.id || 'zhixia', clock: options.clock });
  const dossiers = new ContentDossierRepository(store, { clock: options.clock });
  const episodes = new EpisodicMemoryRepository(store,{clock:options.clock});
  importCompanionRelationship(store,companionRelationship);
  const interactionPolicy = new ConversationPolicyRepository(store,{clock:options.clock});
  const lifeThreads = new LifeThreadRepository(store,{clock:options.clock,random:options.lifeThreadRandom||options.random});
  const sourceChanges = new SourceChangesRepository(store,dossiers);
  lifeThreads.get('miyue',life.get('miyue'));
  // Authored reading/film stages are paused by default, including persisted progress.
  // Keep the opt-in for isolated legacy tests; ordinary book chat uses shared history.
  const pursuits=options.startPursuits!==true?null:new CompanionPursuits(store,{clock:options.clock,random:options.pursuitRandom||options.random,catalog:options.pursuitCatalog,getWeight:item=>companionAgenda.itemWeight(item,'miyue',{suppressedSourceIds:episodes.suppressedSourceIds('miyue')}),pickArticle:({previous})=>articlePursuit(store.listContent(),previous,store.db.prepare("SELECT DISTINCT substr(pursuit_id,1,instr(pursuit_id,':')-1) AS id FROM companion_pursuit_deliveries WHERE role_id=?").all('miyue').map(row=>row.id))});
  pursuits?.get('miyue');
  const personalExperiences=new PersonalExperiences(store,{clock:options.clock});
  const sharedExperiences=new SharedExperiences(store,{clock:options.clock});
  importSharedExperiences(store,sharedExperiences,{pursuits,thread:lifeThreads.get('miyue')});
  const gentle = new GentleFeedbackRepository(store, { clock: options.clock });
  const preferences = new PreferencesRepository(store);
  const background = new BackgroundRepository(store);
  const moments = new MomentsRepository(store);
  const runtimeScenes = new RuntimeScenes(store,{sceneImages,imageLibrary});
  const dailyLife = options.startDailyLife===false?null:new DailyLife(store,{clock:options.clock,random:options.dailyLifeRandom||options.random,catalog:options.dailyLifeCatalog,getSources:()=>{const items=store.listContent(),excluded=new Set(companionSourceHistory.excludedIds(items));return items.filter(item=>!excluded.has(item.id));}});
  const dailyLifeEffects = new DailyLifeEffects(store,inner,{clock:options.clock});
  const companionRuntime = new CompanionRuntime(store,{
    dailyLife,
    prepareDailyLife:view=>{dailyLifeEffects.advance(view.events);return inner.get('miyue');},
    clock:options.clock,random:options.runtimeRandom||options.random,intervalMs:options.runtimeIntervalMs||30_000,
    getInputs:()=>{
      const currentLife=life.get('miyue');
      companionAgenda.tick('miyue');pursuits?.tick('miyue');
      return {life:currentLife,inner:inner.get('miyue',currentLife?.active),tuning:companionTuning.get(),agenda:companionAgenda.view('miyue',{suppressedSourceIds:episodes.suppressedSourceIds('miyue')}),pursuit:pursuits?.get('miyue')||null};
    },
    onAdvance:snapshot=>{runtimeScenes.sync(snapshot);},
  });
  characters.worldProvider=()=>companionRuntime.advance().world;
  const runtimeSnapshot=()=>({...companionRuntime.advance(),service:companionRuntime.status(),desktop:runtimeScenes.read()});
  const pinSceneImages=()=>{const state=companionRuntime.configuration();if(state.settings.automaticScenes)companionRuntime.updateSettings({revision:state.revision,settings:{automaticScenes:false}});};
  const replyNow = options.replyNow || (() => performance.now());
  const replyRandom = options.replyRandom || options.random || Math.random;
  const replySleep = options.replySleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const scenarioScope = id => `${scenarioRole?.id || 'zhixia'}::scenario:${id}`;
  const memoryRole = roleId => roleId === scenarioRole?.id ? scenarioScope(scenarios.get().current.id) : roleId;
  const tagScenarioMessages = (messages, scenarioId) => { for (const message of messages) store.db.prepare('INSERT OR IGNORE INTO scenario_message_scope(message_id,scope) VALUES(?,?)').run(message.id, scenarioScope(scenarioId)); };
  const decoratedContent = () => { const items = store.listContent(); return [...dossiers.decorate(items), ...items.slice(200)]; };
  const companionSourcePool = (items,opts={}) => selectCompanionSources(dossiers.decorate(items),{now:(options.clock||(()=>new Date()))(),...opts});
  const recentCompanionSourceIds = () => [...new Set([...companionSourceHistory.excludedIds(store.listContent()),...store.db.prepare("SELECT content_id FROM messages WHERE role='miyue' AND speaker='assistant' AND content_id IS NOT NULL ORDER BY rowid DESC LIMIT 80").all().map(row=>row.content_id)])];
  const infoCandidates = items => {
    const enriched = dossiers.decorate(contentInbox.unread(items)), seen = new Set();
    const used = new Set(enriched.filter(item => item.used).map(item => item.cluster.id));
    return enriched.filter(item => { if (!item.dossier.quality.useful || item.used || used.has(item.cluster.id) || seen.has(item.cluster.id)) return false; seen.add(item.cluster.id); return true; })
      .sort((a,b) => Number(b.dossier.extraction.extracted) - Number(a.dossier.extraction.extracted)).slice(0,3)
      .map(item => ({ ...item, dossierContext: newsBriefContext(item) }));
  };
  migrateOnlineFriend(store, recallRepo, roleMap.get('miyue'));
  for(const scope of [...roles.filter(r=>r.id!==scenarioRole?.id).map(r=>r.id),...scenarios.scenarios.map(s=>scenarioScope(s.id))]){
    if(store.db.prepare('SELECT value FROM metadata WHERE key=?').get('episodes_import_v09:'+scope))continue;
    store.transaction(()=>{const rows=store.db.prepare("SELECT id,speaker,text FROM recall_messages WHERE role=? AND kind<>'story' AND (speaker='user' OR rowid>COALESCE((SELECT CAST(value AS INTEGER) FROM metadata WHERE key='persona_cutoff:'||recall_messages.role),0)) ORDER BY rowid DESC LIMIT 100").all(scope).reverse();if(rows.length)episodes.observe(scope,rows);store.db.prepare('INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)').run('episodes_import_v09:'+scope,'1');});
  }
  const model = new ModelClient({ dataDir, env: options.env || process.env, fetchImpl: options.fetchImpl || globalThis.fetch, clock: options.clock, onUsage: entry => usage.record(entry) });
  const recallRoles = scenarioRole ? [...roles, ...scenarios.scenarios.map(scene => ({ id: scenarioScope(scene.id), name: `${scenarioRole.name} · ${scene.title}` }))] : roles;
  const recall = new RecallEngine({ repo: recallRepo, model, roles: recallRoles, clock: options.clock });
  const currentLifeTopic = (roleId, preparedRuntime=null) => {
    const snapshot = life.get(roleId);
    const now = (options.clock || (() => new Date()))();
    const runtime=roleId==='miyue'?(preparedRuntime||companionRuntime.advance()):null;
    const categories={cafe:'local_walk',bar:'local_walk',travel:'local_walk',sketching:'hobby',music:'hobby',rest:'emotional_need',waking:'emotional_need',preparation:'commute',home:'cooking'};
    const activity=runtime?.current;
    const event = roleId==='miyue' ? (snapshot?.active?.type==='travel'?snapshot.active:activity&&activity.kind!=='sleep'?{id:'runtime-topic:'+activity.id,type:'ordinary',category:categories[activity.kind]||activity.kind,title:activity.title}:null) : snapshot?.active || snapshot?.recent?.find(item => +now - Date.parse(item.endsAt) < 3 * 86400000);
    let topic = lifeTopics.get(event, roleId);
    // Repair the tiny crash window after message commit but before topic receipt.
    for (let i = 0; topic?.topicKey && i < 12; i++) {
      const delivered = store.db.prepare('SELECT message_id FROM proactive_events WHERE topic_key=?').get(topic.topicKey);
      if (!delivered || !lifeTopics.markDelivered(roleId, topic.topicKey, delivered.message_id)) break;
      topic = lifeTopics.get(event, roleId);
    }
    return { ...topic, travel: event?.type === 'travel' };
  };
  const dueFollowup = roleId => {
    for(const item of followups.due(roleId)) {
      const delivered=store.db.prepare('SELECT message_id FROM proactive_events WHERE topic_key=?').get(`followup:${item.id}`);
      if(delivered)followups.markDelivered(item.id,delivered.message_id);else return item;
    }
    return null;
  };
  const trackedCandidates = items => topicTracking.candidates(items.slice(0,500).filter(item=>item.id&&item.title&&item.title.length<=500&&/^https?:\/\//.test(item.url||'')));
  const comparedCandidates = items => trackedCandidates(items).map(item=>({...item,change:sourceChanges.analyze(topicTracking.list().find(t=>t.id===item.tracking.id),item)}));
  const preparedInfo = items => {
    const compared=comparedCandidates(items),repeatIds=new Set(compared.filter(item=>item.change.kind==='repeat').map(item=>item.id));
    const preferred=infoCandidates(compared.filter(item=>item.change.kind!=='repeat'));
    return preferred.length ? preferred.map(item=>({...item,dossierContext:item.dossierContext+'\n'+topicTracking.context(item)+'\n'+sourceChanges.context(item.change)})) : infoCandidates(items.filter(item=>!repeatIds.has(item.id)));
  };
  const topicSnapshot = () => {const candidates=comparedCandidates(store.listContent());return topicTracking.list().map(track=>({...track,change:candidates.find(item=>item.tracking.id===track.id)?.change||sourceChanges.lastReport(track.id)}));};
  function evidenceContext(roleId,text='') {
    const scope=memoryRole(roleId),suppressed=new Set(episodes.suppressedSourceIds(scope));
    const conversation=recallRepo.conversation(scope,roleId==='miyue'?dialogueLimits(roleId).history.count:30).filter(row=>!suppressed.has(row.id));
    const intent=roleId==='miyue'?companionIntent(text,conversation):null;
    const entries=intent&&!intent.recall&&(intent.affection||intent.invitation||intent.declined)?[]:episodes.retrieve(scope,text||conversation.filter(r=>r.speaker==='user').at(-1)?.text||'');
    const lookup=roleId==='miyue'?lookupUserEvidence(store,episodes,scope,text):{rows:[],context:''};
    return {scope,entries,conversation,lookup,recallContext:episodes.hasOverrides(scope)?'':recallRepo.context(scope),episodicContext:[episodes.context(entries,scope),lookup.context].filter(Boolean).join('\n'),episodeRevision:episodes.revision(scope)};
  }
  function recordSharedTurn(roleId, rows, context, candidate) {
    const personal = personalExperiences.observe(roleId,rows,candidate);
    if (roleId !== 'miyue') return;
    const assistant=rows.findLast(row=>row.speaker==='assistant');
    if (!assistant) return;
    companionSourceHistory.record({...assistant,role:roleId},store.listContent());
    const dailySource=context.runtime?.dailyLife?.events.find(event=>event.source&&mentionedSources(assistant.text,[event.source]).length);
    if(dailySource&&!context.sharePacket&&!context.discussionPacket&&!context.sharedExperience){
      const source=dailySource.source;
      sharedExperiences.record(roleId,assistant.id,{key:`daily-source:${dailySource.id}`,kind:'article',title:source.title,summary:assistant.text,detail:source.excerpt,source:{title:source.title,url:source.url,scope:'仅提供订阅摘录'},occurredAt:dailySource.instanceStartedAt||dailySource.startedAt});
      if(store.getContent(source.contentId))store.db.prepare('UPDATE messages SET content_id=? WHERE id=? AND content_id IS NULL').run(source.contentId,assistant.id);
      return;
    }
    if (context.sharePacket) {
      if (!sharedExperiences.record(roleId,assistant.id,context.sharePacket)) throw fail(409,'分享内容已变化，请重新生成','STALE_SHARED_EXPERIENCE');
    } else if (context.discussionPacket) {
      sharedExperiences.record(roleId,assistant.id,{...context.discussionPacket,summary:assistant.text});
    } else if (context.sharedExperience) {
      const user=rows.findLast(row=>row.speaker==='user');
      if (!user || !sharedExperiences.linkReply(roleId,user.id,assistant.id,context.sharedExperience.sourceMessageId)) throw fail(409,'这段对话的来源已变化，请重新生成','STALE_SHARED_EXPERIENCE');
    } else if (personal.length) {
      const entry=personal[0];
      sharedExperiences.record(roleId,assistant.id,{
        key:`conversation-experience:${assistant.id}`,kind:entry.kind,title:entry.title,
        summary:entry.evidence,detail:entry.summary,occurredAt:entry.createdAt,
      });
    }
  }
  function assertCompanionshipContext(context) {
    if(context.runtimeRevision!==undefined&&context.runtimeRevision!==companionRuntime.advance().revision)throw fail(409,'她的生活安排已经变化，正在按新状态重新准备回复','STALE_COMPANION_RUNTIME');
    if(context.innerRevision!==undefined&&context.innerRevision!==inner.revision('miyue'))throw fail(409,'她的状态已调整，请重新生成','STALE_INNER_STATE');
    if(context.relationshipRevision!==undefined&&context.relationshipRevision!==companionRelationship.revision('miyue'))throw fail(409,'相处记录已更新，请重新生成','STALE_RELATIONSHIP');
    if(context.agendaRevision!==undefined&&context.agendaRevision!==companionAgenda.revision('miyue'))throw fail(409,'约定或活动已更新，请重新生成','STALE_COMPANION_AGENDA');
  }
  function recordCompanionship(roleId,rows,updates,context) {
    if(roleId!=='miyue')return;
    companionRelationship.observe(roleId,rows,updates?.relationship||[]);
    companionAgenda.observe(roleId,rows,updates?.agenda||[]);
    if(context?.runtime?.dailyLife)dailyLife?.observe(rows,updates?.life||[],{expectedRevision:context.runtime.dailyLife.revision});
  }
  function replyLifeEvents(context,reply){
    const events=[...(context?.lifeEventFocus||[]),...focusLifeEvents(context?.runtime?.dailyLife,{text:reply})];
    return [...new Map(events.map(event=>[event.id,event])).values()];
  }
  const companionshipSnapshot=()=>{
    companionAgenda.tick('miyue');
    const suppressedSourceIds=episodes.suppressedSourceIds('miyue');
    characters.get('miyue');
    return {inner:inner.view('miyue'),relationship:companionRelationship.view('miyue',{suppressedSourceIds}),agenda:companionAgenda.view('miyue',{suppressedSourceIds})};
  };
  const companionshipInstruction=()=>companionRelationship.promptInstruction()+'\n'+companionAgenda.promptInstruction()+'\n'+LIFE_UPDATE_INSTRUCTION;
  const companionRequest=(messages,behavior)=>withCompanionshipProtocol(requestEmotionEnvelope(messages,behavior),companionshipInstruction());
  const roleContext = (roleId, { initiating = true, text='', usePursuits=true, preferContent=false, opening=false } = {}) => {
    const runtime=roleId==='miyue'?companionRuntime.prepare({trigger:initiating?'proactive':'user',text}):null;
    if (roleId === 'miyue') {pursuits?.tick(roleId);companionAgenda.tick(roleId);}
    const evidence=evidenceContext(roleId,text);let result;
    const currentLife=life.get(roleId);
    const currentCharacter=roleId==='miyue'?characters.get(roleId,{lifeSnapshot:currentLife}):null;
    const currentIntent=companionIntent(text,evidence.conversation);
    const agendaPlans=roleId==='miyue'?companionAgenda.view(roleId,{suppressedSourceIds:episodes.suppressedSourceIds(roleId)}).plans:[];
    const agendaPlan=agendaPlans.filter(p=>p.status!=='cancelled').findLast(p=>text.includes(p.title)||/(?:进度|进展|读到哪|看到哪|看完|读完|继续|暂停)/u.test(text)&&evidence.conversation.slice(-2).some(row=>row.text?.includes(p.title)));
    const relationshipInvitation=roleId==='miyue'&&explicitRomanceProposal(text)&&companionRelationship.view(roleId,{suppressedSourceIds:episodes.suppressedSourceIds(roleId)}).intimacyBoundary==='open';
    const activityRequest=roleId==='miyue'&&(relationshipInvitation||Boolean(agendaPlan)||/(?:一起(?:看|读|听|聊|待)|陪我(?:待|坐|安静)|推荐你|你可以试试|(?:暂停|取消|恢复|改到).{0,20}(?:约定|活动|计划)|(?:约定|活动|计划).{0,10}(?:暂停|取消|改到))/u.test(text));
    const activeThread=roleId==='miyue'&&!activityRequest&&!initiating&&!currentIntent.affection&&!currentIntent.invitation&&!currentIntent.weary&&!currentIntent.declined&&!currentIntent.recall?conversationThread(text,evidence.conversation):null;
    const careFirst=!initiating&&(currentIntent.affection||currentIntent.invitation||currentIntent.weary||currentIntent.declined);
    const matchedShare = roleId === 'miyue' && !initiating && !careFirst && !activityRequest && usePursuits
      ? sharedExperiences.resolve(roleId,{conversation:evidence.conversation,text,holdsTopic:Boolean(activeThread?.holdsTopic),suppressedSourceIds:episodes.suppressedSourceIds(evidence.scope)}) : null;
    const asksProgress=/(?:读到|看到)(?:哪|哪里|哪儿)|(?:读|看)完(?:了|没|了吗|没有)|(?:现在|后来|最近).{0,8}(?:进度|进展)/u.test(text);
    const shared=asksProgress&&matchedShare?.title===pursuits?.get(roleId)?.title?null:matchedShare;
    if (roleId === scenarioRole?.id) {
      const current=scenarios.get();
      result={...evidence,characterContext:scenarios.context({initiating}),scenario:current,scenarioContext:true,lifeTopicKey:initiating&&!current.state.paused&&!current.state.openerDelivered?current.state.pendingKey:null};
    } else {
      const followup=initiating?dueFollowup(roleId):null,thread=options.startLifeThreads!==false&&initiating&&!followup?lifeThreads.pending(roleId,currentLife):null;
      const topic=currentLifeTopic(roleId,runtime),innerInitiative=initiating&&!followup?inner.initiative(roleId,currentLife?.active):null;
      result={...evidence,characterContext:roleId==='miyue'?'':[characters.context(roleId),life.context(roleId)||'',lifeThreads.context(roleId,currentLife),followup?followups.context(followup):initiating&&!thread?topic.context||'':'用户当前话题优先，生活背景只在相关时自然参与。',innerInitiative?.context||''].join('\n'),followupId:followup?.id,thread,lifeTopicKey:thread?.pendingKey||innerInitiative?.key||topic.topicKey,sourceHints:topic.sourceHints||[],lifeTopic:thread?null:topic,innerInitiative};
    }
    if(roleId==='miyue'&&pursuits&&usePursuits&&!activityRequest){
      if(initiating&&preferContent&&!result.followupId){result.contentShare=true;result.thread=null;result.innerInitiative=null;result.lifeTopic=null;result.lifeTopicKey=null;}
      result.pursuitView=pursuits.get('miyue');result.pursuitRoute=initiating?{detailed:false,introduce:false,bridge:false}:routePursuit(result.pursuitView,text,evidence.conversation);
      if(activeThread?.acceptsOffer||shared)result.pursuitRoute={detailed:false,introduce:false,bridge:false};
      const share=initiating?!result.followupId&&!result.contentShare&&pursuits.pending('miyue'):result.pursuitRoute.introduce&&pursuits.pending('miyue');
      result.pursuit=share||null;
      if(share||result.pursuitRoute.detailed){result.thread=null;result.innerInitiative=null;result.lifeTopic=null;if(initiating)result.lifeTopicKey=share?.pendingKey||null;}
    }
    if(roleId==='miyue'&&initiating&&!result.followupId){
      const opportunity=companionAgenda.pending(roleId,{suppressedSourceIds:episodes.suppressedSourceIds(roleId)});
      if(opportunity){result.agendaOpportunity=opportunity;result.pursuit=null;result.pursuitRoute=null;result.thread=null;result.innerInitiative=null;result.lifeTopic=null;result.contentShare=false;result.lifeTopicKey=opportunity.key;}
    }
    if(runtime&&initiating&&!result.followupId&&!result.agendaOpportunity&&runtime.pending){
      result.runtimeOpportunity=runtime.pending;result.lifeTopicKey=runtime.pending.key;
      result.pursuit=null;result.pursuitRoute=null;result.thread=null;result.innerInitiative=null;result.contentShare=false;
    }
    // Due needs outrank optional reading/daily-life shares, but not an explicit appointment.
    if(roleId==='miyue'&&initiating&&!result.followupId&&!result.agendaOpportunity){
      const need=inner.initiative(roleId,currentLife?.active);
      if(need?.needChannel){result.innerInitiative=need;result.lifeTopicKey=need.key;result.runtimeOpportunity=null;result.pursuit=null;result.pursuitRoute=null;result.thread=null;result.lifeTopic=null;result.contentShare=false;}
    }
    const everydayOpening=Boolean(runtime?.dailyLife?.events.length&&(initiating||opening));
    if(everydayOpening&&initiating&&!result.followupId&&!result.agendaOpportunity&&!result.innerInitiative?.needChannel&&!preferContent){
      // Everyday experiences supply optional material, without an authored project anchor.
      result.thread=null;result.pursuit=null;result.pursuitRoute=null;result.lifeTopic=null;result.innerInitiative=null;
      result.lifeTopicKey=result.runtimeOpportunity?.key||`daily-life:${runtime.dailyLife.revision}`;
    }
    if(roleId==='miyue')result.characterContext=compactCompanionBackground({now:(options.clock||(()=>new Date()))(),world:runtime.world,character:currentCharacter,inner:currentCharacter.inner||inner.get(roleId,currentLife?.active),life:currentLife,thread:lifeThreads.get(roleId,currentLife),includeThread:!everydayOpening&&!result.runtimeOpportunity&&!result.agendaOpportunity&&!activityRequest&&!shared&&!careFirst&&!activeThread?.holdsTopic&&!result.pursuit&&!result.pursuitRoute?.detailed&&(initiating&&!result.contentShare||companionIntent(text,evidence.conversation).handoff||/配色|色卡|包装|手册|个人项目/.test(text)),episodicContext:evidence.episodicContext,followupContext:result.followupId?followups.context(dueFollowup(roleId)):'',initiativeContext:result.innerInitiative?.context||''});
    else result.characterContext+='\n'+evidence.episodicContext;
    if(roleId==='miyue'&&result.innerInitiative?.needChannel&&inner.get().intimacyBoundary!=='friendly'){
      result.closenessMoment=closenessMemory.select({suppressedSourceIds:episodes.suppressedSourceIds(roleId)});
      if(result.closenessMoment)result.characterContext+='\n'+result.closenessMoment.context;
    }
    if(roleId==='miyue'){
      result.runtimeRevision=runtime.revision;result.runtime=runtime;
      result.characterContext+='\n'+runtimeContext(runtime,{initiating});
      const excludedSources=new Set(recentCompanionSourceIds());
      const dialogueLife=(initiating||opening)&&runtime.dailyLife?{...runtime.dailyLife,events:runtime.dailyLife.events.filter(event=>!event.source||!excludedSources.has(event.source.contentId))}:runtime.dailyLife;
      result.eventContext=dailyLifeContext(dialogueLife);
      if(initiating||opening)result.characterContext+='\n本轮由你发起交流，可以从最近的生活、感受或心情自然说起；这些事件是素材，不必逐条说，也不要求一定采用某件事。分享一件有意思的小事和自己的感受就足够，无需接着汇报一整天，也不必绕回职业介绍、手工或想念。亲近感可以融入自己的分享。';
      if(runtime.dailyLife?.events.some(event=>event.foreground))result.characterContext+='\n当前这件生活小事仍在进行。只说已经到达的进展和现在的感受；结束、收货、离店、回家等后续尚未发生，不能在这一条消息里把时间推到活动之后。';
      result.relationship=companionRelationship.view(roleId,{suppressedSourceIds:episodes.suppressedSourceIds(roleId)});
      result.agendaRevision=companionAgenda.revision(roleId);
      result.relationshipRevision=companionRelationship.revision(roleId);
      result.innerRevision=inner.revision(roleId);
      result.characterContext+='\n'+companionRelationship.context(roleId,{text,suppressedSourceIds:episodes.suppressedSourceIds(roleId)})+'\n'+companionAgenda.context(roleId,{text,suppressedSourceIds:episodes.suppressedSourceIds(roleId)});
      result.characterContext+='\n'+(sceneImages.context()||appearance.context());
      result.activityRequest=activityRequest;result.relationshipInvitation=relationshipInvitation;
      result.quietRequest=/(?:安静.*(?:分钟|一会儿)|陪我(?:安静)?待)/u.test(text)||agendaPlan?.kind==='quiet'||agendaPlans.some(p=>p.kind==='quiet'&&p.status==='active')&&/^(?:好|现在开始|开始吧|继续|先暂停)/u.test(text);
      if(agendaPlan)result.characterContext+='\n本轮接着这项已经记录的安排聊：'+agendaPlan.title+'。依据计划的状态与实际进度，不改聊另一部作品；没有记录到的具体章节或引文不要编造。';
      result.updateInstruction=companionshipInstruction();
      result.lifeEventFocus=focusLifeEvents(dialogueLife,{text,conversation:evidence.conversation,opening:initiating||opening});
      result.lifeEventTurnContext=lifeEventTurnContext(result.lifeEventFocus);
    }
    result.sharedExperience=shared;
    result.sharePacket=roleId==='miyue'?plannedShare(result):null;
    if(roleId==='miyue'&&!shared&&!result.sharePacket&&result.pursuitRoute?.detailed){
      const view=result.pursuitView;
      // A user can start discussing an already shared stage without repeating
      // its authored opener. That reply still needs a durable material link.
      if(!result.pursuitRoute.historical)result.discussionPacket=plannedShare({pursuit:{...view,pendingKey:`companion-pursuit:${roleId}:${view.id}:${view.startedAt}:${view.stage.index}`}});
    }
    if(result.sharePacket)result.characterContext+='\n'+shareContext(result.sharePacket);
    if(shared)result.characterContext+='\n'+sharedExperiences.context(shared);
    if(result.pursuitView&&!result.sharePacket&&!shared&&result.pursuitRoute?.detailed)result.characterContext+='\n'+pursuits.context('miyue',{detailed:Boolean(result.pursuit||result.pursuitRoute.detailed),text});
    if(roleId==='miyue') {
      const experiences=personalExperiences.list(roleId);
      const digest=recentEventDigest({now:(options.clock||(()=>new Date()))(),life:currentLife,thread:lifeThreads.get(roleId,currentLife),pursuit:result.pursuitView||pursuits?.get(roleId),experiences,runtime});
      result.characterContext+='\n'+digest;
      // Explicit questions can still recover a named older experience outside
      // the recent digest, without adding the old section to every turn.
      if(experiences.some(item=>text.includes(item.title)&&!digest.includes(item.title)))result.characterContext+='\n'+personalExperiences.context(roleId,text);
    }
    if(activeThread){result.conversationThread=activeThread;result.characterContext+='\n'+activeThread.context+'\n身心状态和正在做的事情只是背景，不是另起生活话题的要求。';}
    if(initiating){
      result.policyPlan=interactionPolicy.plan(evidence.scope,'',{mode:roleMap.get(roleId)?.interaction?.mode,sources:[...evidence.conversation,...evidence.entries.flatMap(e=>e.corrected?[e.correction]:e.quotes.map(q=>q.text))],anchor:result.agendaOpportunity?.anchor||pursuitAnchor(result.pursuit)||result.thread?.beat.text||'',memoryIds:evidence.entries.map(e=>e.id)});
      result.policyPlan.maxChars=1200;
      if(roleId==='miyue'){
        const feeling=inner.get(roleId,currentLife?.active);
        result.policyPlan=companionTuning.apply(result.policyPlan,'',feeling,interactionPolicy.get('miyue').preferences);
        result.policyPlan=companionBehavior.plan(result.policyPlan,'',{conversation:evidence.conversation,inner:feeling,initiating:true});
        if(result.innerInitiative?.needChannel){result.policyPlan.suppressInitiatedAffection=false;result.policyPlan.behavior.extra=null;}
        result.policyPlan=focusPolicy(result.policyPlan,result.sharePacket);
        result.characterContext+='\n'+companionBehavior.context(result.policyPlan);
      }
      result.policyPlan.maxChars=Math.min(roleId==='miyue'?dialogueLimits(roleId).replyChars:1200,result.policyPlan.maxChars);result.characterContext+='\n'+interactionPolicy.context(result.policyPlan);
    }
    return result;
  };
  const contextVersion = roleId => { const runtimeVersion=roleId==='miyue'?companionRuntime.advance().revision:0; return [runtimeVersion,roleId==='miyue'?`${companionRelationship.revision(roleId)}:${companionAgenda.revision(roleId)}:${inner.revision(roleId)}`:'',roleId==='miyue'?pursuits?.get('miyue')?.version||0:0,roleId==='miyue'?companionTuning.get().revision:0,memoryRole(roleId),episodes.revision(memoryRole(roleId)),interactionPolicy.get(memoryRole(roleId)).revision,lifeThreads.get(roleId)?.version||0,roleId===scenarioRole?.id?`${scenarios.get().version}:${scenarios.get().state.pendingKey}:${recallRepo.get(memoryRole(roleId)).revision}`:`${JSON.stringify(dueFollowup(roleId)||null)}:${JSON.stringify(topicTracking.list().map(t=>[t.id,t.updatedAt]))}:${recallRepo.get(roleId).revision}:${inner.initiative(roleId,life.get(roleId)?.active)?.key||currentLifeTopic(roleId).topicKey||''}`].join('|'); };
  const publicLifeTopic = () => currentLifeTopic('miyue').publicQuery || '';
  const lifeSnapshot = () => {
    const discussion = currentLifeTopic('miyue');
    const sources = selectLifeContent(store.listContent(), discussion).map(({ id, title, url }) => ({ id, title, url }));
    const currentLife=life.get('miyue');
    return { ...currentLife, wardrobe:wardrobe.snapshot(), world:characters.get('miyue',{lifeSnapshot:currentLife}).world, pursuit:pursuits?.get('miyue')||null,personalExperiences:personalExperiences.list('miyue'), companionship:companionshipSnapshot(), thread:lifeThreads.get('miyue',currentLife), shares:store.getMessages('miyue',100).filter(m=>m.kind==='proactive'&&m.proactiveKind==='life').slice(-12).reverse(), discussion: { ...discussion, sources } };
  };
  const zhihuClient = new ZhihuClient({ dataDir, env: options.env || process.env, fetchImpl: options.zhihuFetchImpl, clock: options.clock, onUsage: entry => usage.record(entry) });
  const zhihuRepo = new ZhihuRepository(store, { clock: options.clock });
  const research = new ZhihuResearch({ repo: zhihuRepo, client: zhihuClient, proactiveRepo, clock: options.clock, random: options.random, tickIntervalMs: options.researchIntervalMs || 15000,
    fetchSina: options.fetchSina || integrations.fetchSinaHotTopics || (async () => ({ items: [] })), getContent: () => store.listContent(), getPublicLifeTopic: publicLifeTopic });
  let quotaPromise = null;
  const zhihuStatus = () => ({ config: zhihuClient.publicConfig(), runtime: { ...zhihuRepo.runtime(), ...zhihuRepo.usage(), ...research.status(), paused: !proactiveRepo.getSettings().enabled }, recent: zhihuRepo.recent() });
  const activeRoles = new Set();
  const replyDelivery=new ReplyDelivery(store,{random:options.replyRandom||Math.random,onDelivery:(message,scope)=>{personalExperiences.observe(message.role,store.getMessages(message.role,6));if(!closing&&options.startRecall!==false)recall.schedule(scope||memoryRole(message.role));}});
  const chatQueue=new ChatQueue(store,{execute:performChat,debounceMs:options.chatDebounceMs??1200,retryDelaysMs:options.chatRetryDelaysMs,onSubmit:role=>{replyDelivery.cancel(role);if(role==='miyue')desktopAttention.interrupt();}});
  const voiceJobs = new Set();
  const roleVoices = new RoleVoiceRepository(store);
  let voiceCatalogCache=null,voiceCatalogPending=null;
  async function getVoiceCatalog(force=false) {
    if(!force&&voiceCatalogCache&&Date.now()-voiceCatalogCache.at<60000)return voiceCatalogCache.value;
    if(voiceCatalogPending)return voiceCatalogPending;
    voiceCatalogPending=(async()=>{if(typeof integrations.listSpeechVoices!=='function')throw fail(503,'音色列表暂不可用','VOICE_UNAVAILABLE');const value=await integrations.listSpeechVoices();voiceCatalogCache={at:Date.now(),value};roleVoices.initialize(value.voices,roles.map(r=>r.id));return value;})().finally(()=>{voiceCatalogPending=null;});return voiceCatalogPending;
  }
  async function speechOptions(roleId,requestedId) {
    if(!roleVoices.get(roleId)&&typeof integrations.listSpeechVoices==='function')await getVoiceCatalog();
    const assigned=roleVoices.get(roleId);const id=requestedId===undefined?assigned?.voiceId:requestedId;
    if(!id)return {};
    const catalog=await getVoiceCatalog();const voice=catalog.voices.find(v=>v.id===id);
    if(!voice)throw fail(503,'所选音色已不可用，请在设置中重新选择','VOICE_UNAVAILABLE');
    return {voice,settings:catalog.settings};
  }
  let closing = false;
  let typingUntil = 0;
  let refreshPromise = null, dossierJob = null;
  function scheduleDossiers() {
    if (closing || options.startDossiers === false || typeof integrations.fetchArticle !== 'function' || dossierJob) return;
    dossierJob = dossiers.prepare(store.listContent(), { fetchArticle: integrations.fetchArticle, limit: 3 }).catch(() => {}).finally(() => { dossierJob = null; });
  }
  async function refreshContent() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      let added = 0, index = 0; const errors = [], feeds = store.listFeeds().filter(feed => feed.id !== ZHIHU_FEED_ID).slice(0, 20);
      const worker = async () => {
        for (;;) {
          const feed = feeds[index++]; if (!feed) return;
          try {
            const result = await integrations.fetchFeed(feed.url);
            if (!store.listFeeds().some(f => f.id === feed.id)) continue;
            if (result.title) store.updateFeedTitle(feed.id, result.title);
            added += store.addContent(feed, result.items, result.title || feed.title);
          } catch (error) { errors.push({ source: feed.title, error: error?.message || '订阅刷新失败' }); }
        }
      };
      await Promise.all([worker(), worker()]);
      scheduleDossiers();
      return { added, errors, items: decoratedContent(), feeds: store.listFeeds() };
    })();
    try { return await refreshPromise; } finally { refreshPromise = null; }
  }
  async function onDelivery(message) {
    if (message?.role === 'miyue') inner.noteReply(message.role, message.text);
    if (!closing && options.startRecall !== false && message?.role) recall.schedule(memoryRole(message.role));
    if (closing || store.getSettings().quiet || !proactiveRepo.getSettings().desktopNotifications) return;
    const result = await (options.desktopNotify || notifyDesktop)(message);
    if (result?.error) proactiveRepo.updateRuntime({ notificationError: result.error });
    else proactiveRepo.updateRuntime({ notificationError: null, lastNotificationAt: new Date().toISOString() });
  }
  const proactive = new ProactiveEngine({
    repo: proactiveRepo, roles, model, refreshContent, clock: options.clock, random: options.random,
    isBusy: ({ manual = false } = {}) => activeRoles.size > 0 || chatQueue.busy() || roles.some(r=>replyDelivery.pending(r.id)>0) || (!manual && Date.now() < typingUntil),
    onDelivery, tickIntervalMs: options.proactiveIntervalMs || 15000,
    getRoleContext: roleContext, getContextVersion: contextVersion,
    getWakeEvent:()=>companionAgenda.pending('miyue',{suppressedSourceIds:episodes.suppressedSourceIds('miyue')})||companionRuntime.pending(),
    getEligibleRoles: (candidates,{manual=false}={})=>candidates.filter(r=>r.id!=='miyue'||manual||!companionRuntime.advance().availability.sleeping).filter(r=>r.id!=='miyue'||!companionAgenda.view('miyue',{suppressedSourceIds:episodes.suppressedSourceIds('miyue')}).plans.some(p=>p.kind==='quiet'&&p.status==='active')).filter(r=>r.id!=='miyue'||manual&&companionTuning.get().values.initiative>0||companionTuning.canInitiate(proactiveRepo.recent(100).find(e=>e.role==='miyue')?.createdAt,(options.clock||(()=>new Date()))())).map(r=>r.id==='miyue'?{...r,proactiveWeight:.2+companionTuning.get().values.initiative/62.5}:r),
    prepareDelivery: ({role,roleContext:context,result,candidates}) => {
      const newsItem = role.interaction?.mode==='information' && result.contentId ? candidates.find(item=>item.id===result.contentId) : null;
      if(newsItem) result.message = composeNewsBrief(newsItem, result.brief);
      if(role.id==='miyue'&&!result.contentId){context.policyPlan.noArticleClaim=false;context.policyPlan.noWeatherClaim=true;}
      if(result.contentId&&comparedCandidates(store.listContent()).some(item=>item.id===result.contentId))context.policyPlan.unverifiedSourceChange=true;
      if(role.id==='miyue'&&companionBehavior.assess(result.message,result.extra,context.policyPlan).length)throw fail(422,'主动草稿不符合本轮行为，本次不发送','COMPANION_BEHAVIOR_REJECTED');
      const checked=interactionPolicy.enforce(role.id==='miyue'?companionBehavior.compose(result.message,result.extra,context.policyPlan):result.message,context.policyPlan);
      if(role.id==='miyue'&&companionSourceHistory.repeated(checked.reply).length)throw fail(409,'这篇资料已经分享过，本次不重复发送','REPEATED_COMPANION_SOURCE');
      if(role.id==='miyue'&&!result.contentId)result.contentId=mentionedSources(checked.reply,candidates)[0]?.id||null;
      if(role.id==='miyue'&&lifeEventReplyIssues(checked.reply,replyLifeEvents(context,checked.reply),{now:context.runtime?.at}).length)throw fail(422,'这次主动草稿与当前生活进展不符，本次不发送','LIFE_EVENT_CONFLICT');
      if(closenessMemory.issues(context.closenessMoment,checked.reply).length)throw fail(422,'本次草稿未接上选定的相处回忆，稍后重新准备','CLOSENESS_CALLBACK_MISSING');
      if(context.policyPlan.behavior?.extra&&!checked.reply.includes(result.extra))throw fail(422,'主动草稿缺少选定表达，本次不发送','COMPANION_BEHAVIOR_REJECTED');
      if(context.policyPlan.behavior)checked.behavior={...context.policyPlan.behavior,retries:0,extra:result.extra&&checked.reply.includes(result.extra)?context.policyPlan.behavior.extra:null};
      return {text:checked.reply,afterSave:message=>{
        assertCompanionshipContext(context);
        if(context.runtimeOpportunity&&!companionRuntime.markDelivered(context.runtimeOpportunity.key,message.id))throw fail(409,'生活交流机会已经变化','STALE_COMPANION_RUNTIME');
        if(context.agendaOpportunity&&!companionAgenda.markDelivered(role.id,context.agendaOpportunity.key,message.id,context.agendaOpportunity.version))throw fail(409,'这项约定已经变化','STALE_COMPANION_AGENDA');
        if(newsItem && !contentInbox.unread([newsItem]).length)throw fail(409,'这条资讯已读或过期，本次未发送','STALE_NEWS');
        if(episodes.revision(context.scope)!==context.episodeRevision)throw fail(409,'回忆已更正，本次草稿已取消','STALE_MEMORY');
        if(role.id===scenarioRole?.id)tagScenarioMessages([message],context.scenario.current.id);
        if(role.id==='miyue'&&context.policyPlan.tuningRevision!==companionTuning.get().revision)throw fail(409,'相处参数已变化，请重新生成','STALE_COMPANION_TUNING');
        interactionPolicy.commit(context.policyPlan,checked,message.id);
        if(context.innerInitiative&&!inner.markInitiated(role.id,context.innerInitiative.key,message.id))throw fail(409,'需求状态已变化，本次主动取消','STALE_INNER_STATE');
        if(role.id==='miyue')inner.noteReply(role.id,checked.reply);
        if(context.closenessMoment)closenessMemory.markRecalled(context.closenessMoment,checked.reply);
        recordSharedTurn(role.id,[message],context,result.experience||null);recordCompanionship(role.id,[message],parseCompanionshipUpdates(result),context);
        if(context.pursuit&&!pursuits.markDelivered(context.pursuit.pendingKey,message.id,context.pursuit.version))throw fail(409,'阅读观影进度已变化','STALE_PURSUIT');
        if(context.thread&&!lifeThreads.markDelivered(context.thread.pendingKey,message.id))throw fail(409,'生活片段已更新','STALE_LIFE_THREAD_PLAN');
        episodes.markUsed(context.entries.map(e=>e.id));
        if(result.contentId)for(const item of trackedCandidates(store.listContent()))if(item.id===result.contentId){sourceChanges.recordDelivery(topicTracking.list().find(t=>t.id===item.tracking.id),item);topicTracking.markDelivered(item.tracking.id,item.id);}
      }};
    },
    getPreparedCandidates: (items, roleId, {kind}={}) => {
      if(roleMap.get(roleId)?.interaction?.mode==='information')return preparedInfo(items);
      if(roleId!=='miyue')return items;
      const excludedIds=recentCompanionSourceIds(),excluded=new Set(excludedIds);
      // Regional context keeps its own relevance ranking and excerpt threshold,
      // while sharing the same delivered-source exclusions as news selection.
      const selected=kind==='life'?items.filter(item=>!excluded.has(item.id)):companionSourcePool(items,{mode:'proactive',conversation:store.getMessages(roleId,10),excludedIds,limit:3});
      return selected.map(item=>({...item,dossierContext:companionSourceContext([item],{now:(options.clock||(()=>new Date()))()})}));
    },
    getPriorityRole: () => dueFollowup()?.roleId || (companionRuntime.pending()?'miyue':null) || (companionAgenda.pending('miyue',{suppressedSourceIds:episodes.suppressedSourceIds('miyue')})?'miyue':null) || (preparedInfo(proactiveRepo.getCandidates()).some(item=>item.tracking)?'wenxi':null) || ((pursuits?.pending('miyue')?.pendingKey||(options.startLifeThreads!==false?lifeThreads.pending('miyue',life.get('miyue'))?.pendingKey:null)) || inner.initiative('miyue', life.get('miyue')?.active)?.key || currentLifeTopic('miyue').topicKey ? 'miyue' : null),
    onTopicDelivery: (roleId, key, messageId) => {
      if(key?.startsWith('runtime:')||key?.startsWith('companion-pursuit:')||key?.startsWith('agenda:'))return;
      if(key?.startsWith('followup:')){followups.markDelivered(key.slice(9),messageId);return;}
      if(roleId==='wenxi'&&key?.startsWith('content:')){const id=key.slice(8);for(const item of trackedCandidates(store.listContent()))if(item.id===id)topicTracking.markDelivered(item.tracking.id,id);}
      if (roleId === scenarioRole?.id) { const scene = scenarios.get(); tagScenarioMessages([{ id: messageId }], scene.current.id); if (key === scene.state.pendingKey) scenarios.markDelivered(key, scene.version); }
      else if (key?.startsWith('life-topic:')) lifeTopics.markDelivered(roleId, key, messageId);
      // Inner initiatives are committed atomically with their message in afterSave.
      else if(!key?.startsWith('inner:'))inner.markInitiated(roleId, key, messageId);
    },
  });
  function proactiveStatus() {
    return { settings: proactiveRepo.getSettings(), runtime: { ...proactiveRepo.getRuntime(), ...proactive.status(), modelConfigured: model.publicConfig().configured, quiet: store.getSettings().quiet, desktopNotificationsAvailable, managedService: process.env.LIFE_MANAGED_SERVICE === '1' }, recent: proactiveRepo.recent(), unreadByRole: proactiveRepo.unreadByRole() };
  }

  const validateRole = (id) => {
    if (typeof id !== 'string' || !roleMap.has(id)) throw fail(400, '角色不存在', 'INVALID_ROLE');
    return roleMap.get(id);
  };
  const currentPort = () => {
    const address = server.address();
    return address && typeof address === 'object' ? address.port : Number(options.port || 8765);
  };
  const requestGuard = (req) => {
    const host = String(req.headers.host || '').toLowerCase();
    const port = currentPort();
    if (![...network.allowedHosts].some(name=>host===`${name}:${port}`)) throw fail(403, '请求来源无效', 'INVALID_HOST');
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) throw fail(403, '请求来源无效', 'INVALID_ORIGIN');
  };

  async function waitForReply(ms,signal) {
    if(!signal)return replySleep(ms);
    if(signal.aborted)throw fail(409,'已有更新消息','MODEL_CANCELLED');
    let listener;try{await Promise.race([replySleep(ms),new Promise((_,reject)=>{listener=()=>reject(fail(409,'已有更新消息','MODEL_CANCELLED'));signal.addEventListener('abort',listener,{once:true});})]);}finally{signal.removeEventListener('abort',listener);}
  }
  const desktopAttention = new DesktopAttention(store, {
    execute: performChat,
    isBusy: () => activeRoles.has('miyue') || chatQueue.busy('miyue') || replyDelivery.pending('miyue') > 0 || proactive.thinking,
    getRevision: () => chatQueue.get('miyue').revision,
    isClosing: () => closing,
  });
  async function performChat(body,control={}) {
    for(let attempt=0;attempt<2;attempt++){
      try{return await performChatOnce(body,control);}
      catch(error){if(error.code!=='STALE_COMPANION_RUNTIME'||attempt||control.signal?.aborted)throw error;}
    }
  }
  async function performChatOnce(body,control={}) {
    const chatStartedAt=replyNow()-(control.startedAt?Math.max(0,Date.now()-control.startedAt):0);
 const role = validateRole(body.role);
      const attention = control.desktopAttention;
      const savedText = attention ? '' : requiredText(body.text, 'text');
      if (attention) body = { ...body, userTexts: [] };
      else if (Array.isArray(body.userTexts) && !body.userTexts.length) body = { ...body, userTexts: undefined };
      const text = attention?.intentText || savedText;
      if (body.storyMode !== undefined && typeof body.storyMode !== 'boolean') throw fail(400, '故事模式无效', 'INVALID_INPUT');
      if (activeRoles.has(role.id)) throw fail(409, '这个角色正在回复，请稍候', 'ROLE_BUSY');
      const explicitlySelectedContent = body.contentId ? store.getContent(String(body.contentId)) : null;
      if (body.contentId && !explicitlySelectedContent) throw fail(404, '内容不存在', 'CONTENT_NOT_FOUND');
      const sourceOptOut=/(?:不|别|不要|先不).{0,5}(?:新闻|资讯|热搜|换话题)|先听我说|还没说完|晚安|先不聊/u.test(text);
      const asksCurrentNews=role.id==='miyue'&&!body.storyMode&&!sourceOptOut&&/新闻|资讯|热点|热搜|时事/u.test(text)&&/(?:有没有|有什么|有哪些|来点|说说|聊聊|讲讲|给我|看看|想看|想听|分享)|^(?:最近|今天|实时|最新|今日).{0,10}(?:新闻|资讯|热点|热搜|时事)[？?。！!\s]*$/u.test(text);
      const asksSourceTopic=role.id==='miyue'&&!body.storyMode&&!sourceOptOut&&/(?:换个话题|你来(?:说|聊|起)|你说点|说点新鲜|有什么新鲜事)/u.test(text);
      const wantsNews = role.interaction?.mode === 'information' && /新闻|资讯|新鲜|最近.*(?:消息|事)|找个话题|你来挑|挑.*内容/.test(text);
      const followsSource=(role.id==='miyue'?/这篇|那篇|原文|出处|来源|作者|刚才的资料/:/文章|这篇|那篇|报道|原文|出处|来源|作者|刚才的资料/).test(text);
      const immediateSourceFollowup=role.id==='miyue'&&/你(?:刚才)?(?:说|提到)的/.test(text)?store.getRecentContent(role.id,1):null;
      let content = explicitlySelectedContent || immediateSourceFollowup || (wantsNews ? infoCandidates(proactiveRepo.getCandidates())[0] : role.id==='miyue'&&!followsSource?null:store.getRecentContent(role.id, 30));
      if (body.scenarioChoiceId !== undefined) {
        const scene = scenarios.get();
        if (role.id !== scenarioRole?.id || scene.version !== body.scenarioVersion || !scene.choices.some(choice => choice.id === body.scenarioChoiceId && choice.label === text)) throw fail(409,'这个选择已经变化，请重新打开情境','STALE_SCENARIO_CHOICE');
      }
      const replyPace = preferences.getReplyPace();
      activeRoles.add(role.id);
      try {
        const context = roleContext(role.id, { initiating: false, opening:Boolean(attention), text, usePursuits:!attention&&!body.storyMode&&!body.contentId&&!asksCurrentNews&&body.lifeChoiceId===undefined });
        if(context.pursuitRoute?.detailed||context.sharedExperience)content=null;
        if(role.id==='miyue'&&!content&&!context.sharedExperience&&context.conversationThread?.holdsTopic&&!context.pursuitRoute?.detailed){
          const recent=context.conversation.filter(m=>m.kind!=='story');
          for(let i=recent.length-1;i>=0&&recent[i].speaker==='assistant';i--){
            const id=store.db.prepare('SELECT content_id FROM messages WHERE id=?').get(recent[i].id)?.content_id;
            if(id){content=store.getContent(id);break;}
          }
        }
        const sourceIntent=companionIntent(text,context.conversation);
        const sourceAllowed=role.id==='miyue'&&!body.storyMode&&body.lifeChoiceId===undefined&&!sourceOptOut&&!context.activityRequest&&!context.conversationThread?.acceptsOffer&&!context.quietRequest&&!sourceIntent.affection&&!sourceIntent.invitation&&!sourceIntent.weary&&!sourceIntent.declined&&!sourceIntent.recall&&!/抱抱|亲亲|想你|爱你|安慰我|哄我/u.test(text);
        const sourceNow=(options.clock||(()=>new Date()))();
        let companionSources=[];
        if(sourceAllowed&&!context.sharedExperience&&!context.sharePacket&&!context.discussionPacket&&!context.pursuitRoute?.detailed){
          if(asksCurrentNews)content=explicitlySelectedContent||companionSourcePool(store.listContent(),{mode:'news',text,excludedIds:recentCompanionSourceIds(),limit:1})[0]||null;
          else if(!content&&asksSourceTopic)content=companionSourcePool(store.listContent(),{mode:'proactive',text,conversation:context.conversation,excludedIds:recentCompanionSourceIds(),limit:1})[0]||null;
          companionSources=content?dossiers.decorate([content]):asksCurrentNews?[]:companionSourcePool(store.listContent(),{mode:'reply',text,conversation:context.conversation,allowRecentTopic:!/(?:对了|换个|不聊|我(?:今天|刚才|刚刚)?(?:准备|打算|决定|遇到|发现|找到))/u.test(text),excludedIds:recentCompanionSourceIds(),limit:1});
        }
        if(companionSources.length){
          context.characterContext+='\n本轮有真实订阅资料可用。先接用户的话，资料只补充与当前话题有关的新信息；普通聊天可以完全不采用，不规定开头结尾，不为了展示材料换话题。采用时说一个具体发现及自己的想法，可有自然的好奇，不必把落点又变成夸用户或泛泛总结感情。引用事实保留所用来源链接，作者观点归属作者；不要把报道改编成自己刚在楼下亲眼见到。用户明确要新闻或追问文章时，先讲清资料中的人物、事件和两处具体细节，再补自己的一个看法；不要只复述标题，也不要绕回自己改稿、泡茶或夸用户。不编造引文，不把核聚变等来源术语换成别的概念；来源只说实验时不能宣称已商用。';
        }else if(asksCurrentNews){context.characterContext+='\n用户要近期新闻，但本次订阅库没有符合时间、主题和资料质量的未分享内容。直接说明暂时没有合适的新资料，不把旧消息说成实时新闻、不编造报道。';}
        const threadVersion=lifeThreads.get(role.id)?.version;
        if(body.lifeChoiceId!==undefined&&lifeThreads.get(role.id,life.get(role.id))?.status!=='active')throw fail(409,'这段生活暂时停在这里，请刷新后再聊','STALE_LIFE_THREAD_PLAN');
        const threadPlan=role.id==='miyue'&&!attention?(body.lifeChoiceId!==undefined?lifeThreads.planChoice(role.id,body.lifeChoiceId,body.lifeVersion):lifeThreads.planReply(role.id,text)):null;
        if(body.lifeChoiceId!==undefined&&(role.id!=='miyue'||!lifeThreads.get(role.id)?.choices.some(c=>c.id===body.lifeChoiceId&&c.label===text)))throw fail(409,'生活选择已变化，请刷新后重选','STALE_LIFE_THREAD_PLAN');
        const scenarioPlan = role.id === scenarioRole?.id ? scenarios.planTurn(text) : null;
        const feedback = gentle.plan(role.id,text);
        if (scenarioPlan) context.characterContext = scenarioPlan.context+'\n'+context.episodicContext;
        if (feedback.context) context.characterContext += `\n${feedback.context}`;
        let policyPlan=interactionPolicy.plan(context.scope,text,{mode:role.interaction?.mode,sources:[...context.conversation,...context.lookup.rows,...context.entries.flatMap(e=>e.corrected?[e.correction]:e.quotes.map(q=>q.text))],anchor:scenarioPlan?.replyAnchor||'',memoryIds:context.entries.map(e=>e.id)});
        const emotionalIntent=companionIntent(text,context.conversation);
        const sharedThread=!companionSources.length&&!asksCurrentNews&&!context.activityRequest&&!context.sharedExperience&&!context.conversationThread?.holdsTopic&&!emotionalIntent.affection&&!emotionalIntent.invitation&&!emotionalIntent.weary&&!emotionalIntent.declined&&role.id==='miyue'&&!context.pursuit&&!context.pursuitRoute?.detailed&&(policyPlan.intent==='share'||companionIntent(text,context.conversation).handoff)?lifeThreads.pending(role.id,life.get(role.id)):null;
        if(sharedThread){policyPlan={...policyPlan,anchor:sharedThread.beat.text};context.sharePacket=plannedShare({thread:sharedThread});context.characterContext+='\n'+shareContext(context.sharePacket);}
        if(context.pursuit)policyPlan={...policyPlan,anchor:pursuitAnchor(context.pursuit),...(context.pursuitRoute.bridge?{anchorPlacement:'after'}:{})};
        if(role.id==='miyue'){const currentInner=inner.get(role.id,life.get(role.id)?.active);policyPlan=companionTuning.apply(policyPlan,text,currentInner,interactionPolicy.get('miyue').preferences);policyPlan=companionBehavior.plan(policyPlan,text,{conversation:context.conversation,inner:currentInner});if(attention&&policyPlan.behavior){policyPlan.behavior.initiating=true;policyPlan.behavior.targetChars=220;}if(context.conversationThread?.acceptsOffer&&!policyPlan.behavior.explicit){policyPlan.behavior.extra=null;policyPlan.behavior.acceptedOffer=true;}policyPlan=focusPolicy(policyPlan,context.sharedExperience||context.sharePacket||context.discussionPacket,{continuation:Boolean(context.sharedExperience)});if(companionSources.length&&content){policyPlan=focusPolicy(policyPlan,{key:'source:'+content.id,kind:'article',title:content.title},{continuation:!asksCurrentNews&&!asksSourceTopic});policyPlan.maxChars=Math.min(policyPlan.maxChars,300);policyPlan.questionBudget=0;}if(companionSources.length&&!policyPlan.behavior.explicit)policyPlan.behavior.extra=null;context.characterContext+='\n'+companionBehavior.context(policyPlan);}
        if(role.id==='miyue'&&context.relationshipInvitation){
          policyPlan.anchor='愿意呀，我们在一起吧。';policyPlan.relationshipAcceptance=true;policyPlan.avoidWithdrawal=true;policyPlan.questionBudget=0;
          if(policyPlan.behavior)policyPlan.behavior.extra=null;
          context.characterContext+='\n这是用户明确提出发展为恋人的邀请，当前没有相反边界。程序会先呈现明确接受的话；正文只接一两句自己的感受或期待，不再次设考验或退回朋友身份。双方实际送达的表达才会成为关系记录。';
        }
        if(role.id==='miyue'&&context.quietRequest){policyPlan.maxChars=80;policyPlan.questionBudget=0;if(policyPlan.behavior&&!policyPlan.behavior.explicit)policyPlan.behavior.extra=null;context.characterContext+='\n本轮是共同安静或开始陪伴，只用一两句自然确认，不展开生活、比喻、叮嘱或追问。';}
        context.characterContext+='\n'+interactionPolicy.context(policyPlan);
        if(role.id==='miyue'&&!content&&!attention){policyPlan.noArticleClaim=false;policyPlan.noWeatherClaim=true;context.characterContext+='\n可以补充自己的虚构阅读经历；不能捏造真实作者的引文、网页链接或声称已经搜索核实。';}
        const trackedContent=content?comparedCandidates([content])[0]:null;
        if(trackedContent?.change||content&&sourceChanges.reportForContent(content.id)){policyPlan.unverifiedSourceChange=true;context.characterContext+='\n来源差异尚未核实：未宣布实施日期不等于尚未实施，只能说明材料没有提供可确认的实施日期。';}
        if(attention){
          policyPlan.maxChars=Math.min(dialogueLimits(role.id,companionTuning.get().values).replyChars,360);
          context.characterContext+='\n'+attention.context;
          if(inner.get().intimacyBoundary!=='friendly'){
            context.closenessMoment=closenessMemory.select({suppressedSourceIds:episodes.suppressedSourceIds(role.id)});
            if(context.closenessMoment)context.characterContext+='\n'+context.closenessMoment.context;
          }
        }
        if(context.lifeEventTurnContext)context.characterContext+='\n'+context.lifeEventTurnContext;
        const conversation = context.conversation;
        for(const value of (body.userTexts||[savedText]))conversation.push({ speaker: 'user', text:value });
        const messages = buildChatMessages({
          role, memories: store.listMemories(role.id), conversation, currentUserText: attention ? null : undefined, eventContext:context.eventContext,
          story: role.id === 'miyue' && body.storyMode === true ? store.getStory() : null, content:companionSources.length?null:content,
          characterContext: context.characterContext, recallContext: context.recallContext,
          informationContext: companionSources.length?companionSourceContext(companionSources.map(item=>({...item,...(!asksCurrentNews&&content?{articleExcerpt:dossiers.get(item.id)?.text}: {})})),{now:sourceNow,followup:!asksCurrentNews&&Boolean(content),query:text}):role.interaction?.mode === 'information' && content ? dossiers.context(content,store.listContent(),text) + '\n' + sourceChanges.context(trackedContent?.change||sourceChanges.reportForContent(content.id)) + '\n本轮资料使用要求：只声称读过以上明确给出的资料；其中提到的外链不代表另行核对，不编造其他转载或评论。作品标题不能当作已经知道的情节。直接回答当前问题，不复述回答步骤；不主动扩展无关奖项。' : '',
          relatedContent: attention||companionSources.length||asksCurrentNews||body.storyMode||context.sharedExperience||context.sharePacket||context.discussionPacket ? [] : selectLifeContent(store.listContent(), context.lifeTopic, { text, ...(role.id==='miyue'?{requireCurrentTopic:true,limit:1}:{}) }).filter(item => item.id !== content?.id),
          storyMode: role.id === 'miyue' && body.storyMode === true,
        });
        let raw = scenarioPlan?.authoredTransition ? '' : await model.complete(role.id === 'miyue' ? companionRequest(messages,policyPlan.behavior) : messages, { purpose: 'chat', roleId: role.id, signal:control.signal, jsonObject: role.id === 'miyue', ...(role.id==='miyue'?{nonThinking:true,maxTokens:dialogueLimits(role.id,companionTuning.get().values).maxOutputTokens}:{}), ...(['information','scenario'].includes(role.interaction?.mode) ? { nonThinking: true, maxTokens: 2000 } : {}) });
        let signals=null,checked,experienceCandidate=null,companionshipUpdates={relationship:[],agenda:[]};
        let retries=0;
        if(role.id==='miyue'){
          for(let attempt=0;attempt<2;attempt++){
            let parsed, protocolIssue=null;
            try { parsed=parseEmotionEnvelope(raw,savedText); } catch(error) { if(error.code!=='MODEL_REPLY_INVALID')throw error; protocolIssue='invalid_reply_envelope'; parsed={reply:'',signals:null}; }
            signals=parsed.signals;experienceCandidate=parsed.experience||null;companionshipUpdates=parseCompanionshipUpdates(raw);const extra=emotionExtra(raw);
            if(!protocolIssue&&policyPlan.behavior?.intent==='recall'&&(parsed.reply.match(/[^。！？!?\n]+[？?]/gu)||[]).every(question=>/^\s*(?:你(?:呢|想|要|觉得|现在|最近|当初)|要不要|有没有|想不想|这几天)/u.test(question))){try{parsed.reply=interactionPolicy.enforce(parsed.reply,{...policyPlan,anchor:'',questionBudget:0}).reply;}catch{/* No factual body remains: normal assessment and one repair still apply. */}}
            const issues=protocolIssue?[protocolIssue]:[...lifeEventReplyIssues(companionBehavior.compose(parsed.reply,extra,policyPlan),replyLifeEvents(context,parsed.reply),{now:context.runtime?.at}),...companionBehavior.assess(parsed.reply,extra,policyPlan),...closenessMemory.issues(context.closenessMoment,parsed.reply),...(attention?desktopAttentionIssues(companionBehavior.compose(parsed.reply,extra,policyPlan)):[])];
            const styleIssues=body.storyMode?[]:[...plainSpeechIssues(companionBehavior.compose(parsed.reply,extra,policyPlan),text,context.conversation.filter(m=>m.speaker==='assistant'&&m.kind!=='story').map(m=>m.text)),...continuationIssues(parsed.reply,context.conversationThread,text)];
            if(!protocolIssue&&attention&&companionSourceHistory.repeated(companionBehavior.compose(parsed.reply,extra,policyPlan)).length){
              issues.push('repeated_companion_source');
              if(attempt===0)messages.push({role:'user',content:'上一稿重复了已经分享过的文章。此次由你发起，请换成尚未分享的近况或想法，不再介绍那篇旧资料；用户没有追问旧文章。'});
            }
            if(attempt===0&&!issues.length)issues.push(...styleIssues);
            if(!issues.length){try{checked=interactionPolicy.enforce(companionBehavior.compose(parsed.reply,extra,policyPlan),policyPlan);if(policyPlan.behavior.extra&&!checked.reply.includes(extra))issues.push('required_extra_removed');}catch(error){if(error.code!=='DIALOGUE_POLICY_REJECTED')throw error;issues.push('no_valid_body');}}
            if(!issues.length){checked.behavior={...policyPlan.behavior,retries:attempt,extra:policyPlan.behavior.extra,styleWarnings:styleIssues,sourceMessageIds:context.lookup.rows.map(r=>r.id),threadSourceIds:context.conversationThread?.sourceMessageIds||[]};break;}
            if(attempt===1){if(protocolIssue)throw fail(502,'模型没有返回完整的对话正文，请稍后重试','MODEL_REPLY_INVALID');const fallback=companionBehavior.fallback(policyPlan,issues);if(fallback){checked=interactionPolicy.enforce(companionBehavior.compose(fallback.reply,fallback.extra,policyPlan),policyPlan);if(checked.reply.includes(fallback.extra)){signals=null;experienceCandidate=null;companionshipUpdates={relationship:[],agenda:[]};checked.behavior={...policyPlan.behavior,retries:1,authoredFallback:true,sourceMessageIds:context.lookup.rows.map(r=>r.id),threadSourceIds:context.conversationThread?.sourceMessageIds||[]};break;}}throw Object.assign(fail(422,'这次接话没有符合当前相处方式，消息已保留，可以重试','COMPANION_BEHAVIOR_REJECTED'),{issues:[...issues]});}
            raw=await model.complete([...companionRequest(messages,policyPlan.behavior),...(styleIssues.length?[{role:'assistant',content:raw}]:[]),{role:'user',content:(issues.some(issue=>issue.startsWith('shopping_'))?lifeEventTurnContext(replyLifeEvents(context,parsed.reply))+'\n上一稿与这些进度事实冲突。仍在挑选就不能说已付款或下完单；等送达就不能说尚未下单或已收货；已收到不能改成昨日收货或还在路上。只改正实际冲突，仍自然回应用户。\n':'')+(styleIssues.includes('too_many_decorative_comparisons')?PLAIN_SPEECH_REVISION+'\n':'')+(styleIssues.includes('premature_topic_closing')?'用户现在正在接着聊，没有说要离开。继续眼前话题，给一个具体想法、细节或自然的小问题，不把交流推迟到旅行回来、下次或以后。\n':'')+(issues.includes('invented_offline_presence')?'你们正在远程聊天。接住拥抱的心意，可以表达想抱抱，不安排用户到你身边坐下、到店里或喝你的饮料。\n':'')+'上一份草稿未通过本轮检查：'+issues.join(',')+'。重新回答刚才的用户消息，遵守本轮行为。主体先回应，extra只一句且不要重复主体、不要问句。输出相同JSON；这是唯一一次修复。'}],{purpose:'chat-repair',roleId:role.id,signal:control.signal,jsonObject:true,nonThinking:true,maxTokens:dialogueLimits(role.id,companionTuning.get().values).maxOutputTokens});retries=1;
          }
        }else checked=interactionPolicy.enforce(raw,policyPlan);
        const reply=checked.reply;
        if(role.id==='miyue'&&lifeEventReplyIssues(reply,replyLifeEvents(context,reply),{now:context.runtime?.at}).length)throw fail(422,'这次回复与当前生活进展不符，请重试','LIFE_EVENT_CONFLICT');
        if(attention&&desktopAttentionIssues(reply).length)throw fail(422,'这次开场不够自然，请再试一次','COMPANION_BEHAVIOR_REJECTED');
        const usedCompanionSource=companionSources.find(item=>reply.includes(item.url)||reply.includes(item.title));
        if(checked.behavior&&companionSources.length){checked.behavior.sourceContextIds=companionSources.map(item=>item.id);checked.behavior.usedSourceId=usedCompanionSource?.id||null;}
        if(control.signal?.aborted || (control.isCurrent && !control.isCurrent()))throw fail(409,'已有更新消息','MODEL_CANCELLED');
        control.markPhase?.('waiting');
        if (replyPace === 'natural') {
          const targetMs = 4_000 + Math.floor(Math.max(0, Math.min(0.999999, Number(replyRandom()) || 0)) * 5_001);
          const elapsedMs = Math.max(0, replyNow() - chatStartedAt);
          const remainingMs = Math.max(0, targetMs - elapsedMs);
          if (remainingMs) await waitForReply(remainingMs,control.signal);
        }
        if(control.signal?.aborted || (control.isCurrent && !control.isCurrent()))throw fail(409,'已有更新消息','MODEL_CANCELLED');
        const parts=control.segmented&&replyPace==='natural'&&!policyPlan.anchor&&!context.sharedExperience&&!context.discussionPacket&&!experienceCandidate&&!companionshipUpdates.relationship.length&&!companionshipUpdates.agenda.length&&!companionshipUpdates.life?.length?splitReply(reply,role.interaction?.mode):[reply];
        const saved = store.saveChatTurn({ role: role.id, text:savedText, userTexts:body.userTexts, reply:parts[0], contentId: content?.id||usedCompanionSource?.id, afterSave: rows => { assertCompanionshipContext(context);if(episodes.revision(context.scope)!==context.episodeRevision)throw fail(409,'回忆已更正，请重新回复','STALE_MEMORY');if(threadVersion!==lifeThreads.get(role.id)?.version)throw fail(409,'生活片段已更新，请重新回复','STALE_LIFE_THREAD_PLAN');const assistantId=rows.at(-1).id;if(role.id==='miyue'&&policyPlan.tuningRevision!==companionTuning.get().revision)throw fail(409,'相处参数已变化，请重新生成','STALE_COMPANION_TUNING');if(context.pursuitView&&!context.sharedExperience&&pursuits.get('miyue').version!==context.pursuitView.version)throw fail(409,'阅读观影进度已变化','STALE_PURSUIT');interactionPolicy.commit(policyPlan,checked,assistantId);if(context.pursuit&&!pursuits.markDelivered(context.pursuit.pendingKey,assistantId,context.pursuit.version))throw fail(409,'阅读观影进度已变化','STALE_PURSUIT');if(threadPlan)lifeThreads.commit(threadPlan,assistantId);if(sharedThread&&!lifeThreads.markDelivered(sharedThread.pendingKey,assistantId))throw fail(409,'生活片段已更新','STALE_LIFE_THREAD_PLAN');if(trackedContent){sourceChanges.recordDelivery(topicTracking.list().find(t=>t.id===trackedContent.tracking.id),trackedContent);topicTracking.markDelivered(trackedContent.tracking.id,trackedContent.id);}if (scenarioPlan) { tagScenarioMessages(rows, scenarioPlan.scenarioId); scenarios.commitTurn(scenarioPlan,rows.at(-1).id); } episodes.markUsed(context.entries.map(e=>e.id));episodes.observe(context.scope,rows);recordSharedTurn(role.id,rows,context,experienceCandidate);recordCompanionship(role.id,rows,companionshipUpdates,context);gentle.commit(feedback);if(!scenarioPlan){const source=rows.find(row=>row.speaker==='user');if(source)followups.observe(role.id,savedText,source.id);}if(parts.length>1)replyDelivery.enqueue(role.id,parts.slice(1),scenarioPlan?scenarioScope(scenarioPlan.scenarioId):null);control.afterSave?.(rows);if(!scenarioPlan)characters.afterTurn(role.id,savedText,signals,{previousAssistantId:context.conversation.filter(row=>row.speaker==='assistant').at(-1)?.id??null});if(role.id==='miyue'){inner.noteReply(role.id,reply,savedText);closenessMemory.observe(rows);closenessMemory.markRecalled(context.closenessMoment,reply);} } });
        if (role.id === 'miyue') companionRuntime.advance();
        if (!closing && options.startRecall !== false) recall.schedule(memoryRole(role.id));
        return { messages: saved.map(row=>store.getMessage(row.id)||row) };
      } finally { activeRoles.delete(role.id); }
  }

  async function api(req, res, url) {
    if(req.method==='GET'&&url.pathname==='/api/companion-runtime')return sendJson(res,200,runtimeSnapshot());
    if(req.method==='POST'&&url.pathname==='/api/companion-runtime/appearance/next'){
      await readJsonBody(req);
      store.transaction(()=>{
        const runtime=companionRuntime.advance();
        runtimeScenes.sync(runtime,{force:true});
        // A desktop quick switch always uses a reviewed transparent figure.
        if(runtime.settings.imageVariant!=='cutout')companionRuntime.updateSettings({revision:runtime.revision,settings:{imageVariant:'cutout'}});
      });
      return sendJson(res,200,sceneImages.snapshot());
    }
    if(req.method==='POST'&&url.pathname==='/api/companion-runtime/choice'){
      if(!dailyLife)throw fail(409,'生活事件未启用');
      const command=await readJsonBody(req);
      store.transaction(()=>{companionRuntime.advance();dailyLife.updateChoice(command);replyDelivery.cancel('miyue');});
      return sendJson(res,200,runtimeSnapshot());
    }
    if(req.method==='POST'&&url.pathname==='/api/companion-runtime/settings'){
      companionRuntime.updateSettings(await readJsonBody(req,16_000));
      return sendJson(res,200,runtimeSnapshot());
    }
    const pathname = url.pathname;
    if (pathname === '/api/desktop/attention' && req.method === 'POST') return sendJson(res, 200, await desktopAttention.request(await readJsonBody(req, 4096)));
    if (pathname === '/api/desktop' && req.method === 'GET') return sendJson(res, 200, await desktopControl.status());
    if (pathname === '/api/desktop' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (typeof body.enabled !== 'boolean') throw fail(400, '请指定是否开启桌面角色', 'INVALID_DESKTOP_STATE');
      return sendJson(res, 200, await desktopControl.setEnabled(body.enabled));
    }
    if(pathname==='/api/companionship'&&req.method==='GET')return sendJson(res,200,companionshipSnapshot());
    if(pathname==='/api/companionship/inner'&&req.method==='POST'){
      characters.get('miyue');
      const command=await readJsonBody(req);
      store.transaction(()=>{inner.update('miyue',command);replyDelivery.cancel('miyue');});
      return sendJson(res,200,companionshipSnapshot());
    }
    if(pathname==='/api/companionship/relationship'&&req.method==='POST'){
      companionRelationship.update('miyue',await readJsonBody(req));
      return sendJson(res,200,companionshipSnapshot());
    }
    if(pathname==='/api/companionship/agenda'&&req.method==='POST'){
      companionAgenda.update('miyue',await readJsonBody(req));
      return sendJson(res,200,companionshipSnapshot());
    }
    if (req.method === 'GET' && pathname === '/api/health') return sendJson(res, 200, { ok: true, modelConfigured: model.publicConfig().configured });
    if (req.method === 'GET' && pathname === '/api/bootstrap') return sendJson(res, 200, {
      roles, settings: store.getSettings(), provider: model.publicConfig(), feeds: store.listFeeds(), story: store.getStory(), memories: store.listMemories(),
      proactive: proactiveStatus(),
    });
    if(pathname==='/api/companion-tuning'&&req.method==='GET')return sendJson(res,200,companionTuning.get());
    if(pathname==='/api/companion-tuning'&&req.method==='POST'){const body=await readJsonBody(req);return sendJson(res,200,companionTuning.set(body.values,body.revision));}
    if(pathname==='/api/companion-tuning/preview'&&req.method==='POST'){const body=await readJsonBody(req);return sendJson(res,200,tuningPreview(body.values));}
    if (req.method === 'GET' && pathname === '/api/preferences') return sendJson(res, 200, preferences.get());
    if (req.method === 'POST' && pathname === '/api/preferences') {
      const body = await readJsonBody(req);
      const keys = Object.keys(body);
      if (keys.length === 1 && keys[0] === 'replyPace') {
        if (!['natural', 'instant'].includes(body.replyPace)) throw fail(400, '回复节奏无效', 'INVALID_REPLY_PACE');
        return sendJson(res, 200, preferences.setReplyPace(body.replyPace));
      }
      if (keys.length === 2 && keys.includes('roleId') && keys.includes('avatar')) {
        const role = validateRole(body.roleId);
        const avatar = body.avatar === null ? null : validateAvatar(body.avatar);
        return sendJson(res, 200, preferences.setAvatar(role.id, avatar));
      }
      throw fail(400, '偏好设置无效', 'INVALID_PREFERENCES');
    }
    if (req.method === 'GET' && pathname === '/api/background') return sendJson(res, 200, background.get());
    if (req.method === 'POST' && pathname === '/api/background') return sendJson(res, 200, background.set(validateBackground(await readJsonBody(req, 3 * 1024 * 1024))));

    if (pathname === '/api/scenarios' && req.method === 'GET') return sendJson(res,200,{...scenarios.get(),roleId:scenarioRole?.id || null});
    if (pathname === '/api/scenarios' && req.method === 'POST') {
      if (!scenarioRole) throw fail(400,'当前未配置情境角色','SCENARIO_UNAVAILABLE');
      if (activeRoles.has(scenarioRole.id) || chatQueue.busy(scenarioRole.id)) throw fail(409,'她正在回复，等这句话结束再换场景','ROLE_BUSY');
      const body = await readJsonBody(req);
      if (!Number.isSafeInteger(body.version) || body.version !== scenarios.get().version) throw fail(409,'情境已更新，请刷新后再操作','STALE_SCENARIO');
      const result = body.action === 'select' ? scenarios.select(requiredText(body.id,'id',100),body.version) : body.action === 'pause' && typeof body.paused === 'boolean' ? scenarios.pause(body.paused) : body.action === 'choose' ? scenarios.choose(requiredText(body.choiceId,'choiceId',100),body.version) : null;
      if (!result) throw fail(400,'情境操作无效','INVALID_SCENARIO_ACTION');
      replyDelivery.cancel(scenarioRole.id);
      return sendJson(res,200,{...result,roleId:scenarioRole.id});
    }
    if(pathname==='/api/moments'&&req.method==='GET')return sendJson(res,200,{items:moments.list()});
    if(pathname==='/api/moments'&&req.method==='POST'){
      const body=await readJsonBody(req),id=requiredText(body.messageId,'messageId',200);
      if(body.action==='remove')return sendJson(res,200,{removed:moments.remove(id)});
      const message=store.getMessage(id);if(!message)throw fail(404,'原消息不存在');
      if(body.action!=='save'&&body.action!=='update')throw fail(400,'片段操作无效');
      const patch={...(body.caption!==undefined?{caption:body.caption}:{}),...(body.image!==undefined?{image:body.image===null?null:validateAvatar(body.image)}:{})};
      const item=body.action==='save'?moments.save(message,patch):moments.update(id,patch);if(!item)throw fail(404,'收藏片段不存在');
      return sendJson(res,200,{item});
    }
    if(pathname==='/api/followups'&&req.method==='GET')return sendJson(res,200,{items:followups.list()});
    if(pathname==='/api/followups'&&req.method==='POST'){
      const body=await readJsonBody(req);
      if(body.id){const item=followups.update(requiredText(body.id,'id',200),{...(body.status!==undefined?{status:body.status}:{}),...(body.dueAt!==undefined?{dueAt:body.dueAt}:{}),...(body.topic!==undefined?{topic:body.topic}:{})});if(!item)throw fail(404,'事项不存在');}
      else{validateRole(body.roleId);followups.create({roleId:body.roleId,topic:body.topic,dueAt:body.dueAt});}
      return sendJson(res,200,{items:followups.list()});
    }
    if(pathname==='/api/episodes'&&req.method==='GET'){
      const role=validateRole(url.searchParams.get('roleId')),scope=memoryRole(role.id);
      return sendJson(res,200,{items:episodes.list(scope,{status:'active'}),preferences:interactionPolicy.get(scope)});
    }
    if(pathname==='/api/episodes'&&req.method==='POST'){
      const body=await readJsonBody(req),role=validateRole(body.roleId),scope=memoryRole(role.id);
      if(body.action==='remember')episodes.remember(scope,body.messageIds,body.label);
      else if(body.action==='correct')episodes.correct(scope,body.id,body.note);
      else if(body.action==='remove')episodes.remove(scope,body.id);
      else throw fail(400,'回忆操作无效');
      return sendJson(res,200,{items:episodes.list(scope,{status:'active'}),preferences:interactionPolicy.get(scope)});
    }
    if(pathname==='/api/interaction-preferences'&&req.method==='POST'){
      const body=await readJsonBody(req),role=validateRole(body.roleId);
      return sendJson(res,200,interactionPolicy.set(memoryRole(role.id),body.preferences));
    }
    if(pathname==='/api/topics'&&req.method==='GET')return sendJson(res,200,{items:topicSnapshot()});
    if(pathname==='/api/topics'&&req.method==='POST'){
      const body=await readJsonBody(req);
      if(body.action==='unfollow')topicTracking.unfollow(requiredText(body.id,'id',200));
      else if(body.action==='follow'){const item=store.getContent(requiredText(body.contentId,'contentId',200));if(!item)throw fail(404,'内容不存在');const track=topicTracking.follow({...item,...(body.terms?{terms:body.terms}:{}),...(body.topic?{topic:body.topic}:{})});sourceChanges.capture(track.id,item);}
      else throw fail(400,'话题操作无效');
      return sendJson(res,200,{items:topicSnapshot()});
    }
    if (req.method === 'GET' && pathname === '/api/usage') return sendJson(res, 200, usage.snapshot());
    if (req.method === 'GET' && pathname === '/api/life') return sendJson(res, 200, lifeSnapshot());
    if (req.method === 'GET' && pathname === '/api/wardrobe') return sendJson(res, 200, wardrobe.snapshot());
    if (req.method === 'GET' && pathname === '/api/appearance') return sendJson(res, 200, appearance.snapshot());
    if(req.method==='GET'&&pathname==='/api/scene-images')return sendJson(res,200,sceneImages.snapshot());
    if(req.method==='GET'&&pathname==='/api/image-library')return sendJson(res,200,imageLibrary.snapshot());
    const libraryActions = {upload:'upload',metadata:'metadata',derivative:'derivative',apply:'apply'};
    const libraryAction = pathname.match(/^\/api\/image-library\/(upload|metadata|derivative|apply)$/);
    if(req.method==='POST'&&libraryAction){
      const action=libraryActions[libraryAction[1]],limit=['upload','derivative'].includes(action)?17*1024*1024:32*1024;
      const result=imageLibrary[action](await readJsonBody(req,limit));if(action==='apply')pinSceneImages();
      return sendJson(res,200,result);
    }
    const libraryFile=pathname.match(/^\/api\/image-library\/files\/([^/]+)$/);
    if(req.method==='GET'&&libraryFile){const asset=imageLibrary.file(libraryFile[1]);if(!asset)throw fail(404,'素材图片不存在','NOT_FOUND');res.writeHead(200,{'content-type':asset.type,'content-length':asset.stat.size,'cache-control':'public, max-age=31536000, immutable','x-content-type-options':'nosniff'});return fs.createReadStream(asset.file).pipe(res);}
    if(req.method==='POST'&&pathname==='/api/scene-images'){const patch=await readJsonBody(req,17*1024*1024),result=sceneImages.update(patch);if('activeSceneId'in patch||'enabled'in patch)pinSceneImages();return sendJson(res,200,result);}
    const sceneImageFile=pathname.match(/^\/api\/scene-images\/files\/([^/]+)$/);
    if(req.method==='GET'&&sceneImageFile){const asset=sceneImages.file(sceneImageFile[1]);if(!asset)throw fail(404,'场景图片不存在','NOT_FOUND');res.writeHead(200,{'content-type':asset.type,'content-length':asset.stat.size,'cache-control':'public, max-age=31536000, immutable','x-content-type-options':'nosniff'});return fs.createReadStream(asset.file).pipe(res);}
    if (req.method === 'POST' && pathname === '/api/appearance') {
      const patch=await readJsonBody(req);
      if(activeRoles.has('miyue')||chatQueue.busy('miyue')||replyDelivery.pending('miyue'))throw fail(409,'林雨薇正在回复，请等这一轮结束后再更改形象');
      return sendJson(res,200,appearance.update(patch));
    }
    if (req.method === 'POST' && pathname === '/api/wardrobe') {
      const patch = await readJsonBody(req);
      if (activeRoles.has('miyue') || chatQueue.busy('miyue') || replyDelivery.pending('miyue')) throw fail(409, '林雨薇正在回复，请等这一轮结束后再换装');
      const saved=store.transaction(()=>{
        const result=wardrobe.update(patch);
        if(patch.outfitId)appearance.selectLegacyOutfit(result.current.outfitId);
        if('automatic'in patch||'locked'in patch)appearance.update(Object.fromEntries(['automatic','locked'].filter(k=>k in patch).map(k=>[k,patch[k]])));
        return result;
      });
      return sendJson(res, 200, saved);
    }
    if (req.method === 'POST' && pathname === '/api/life/settings') {
      const body = await readJsonBody(req);
      life.saveSettings(body);
      return sendJson(res, 200, { life: lifeSnapshot() });
    }
    const characterMatch = pathname.match(/^\/api\/characters\/([^/]+)$/);
    if (req.method === 'GET' && characterMatch) {
      const role = validateRole(decodeURIComponent(characterMatch[1]));
      return sendJson(res, 200, { profile: role.profile || null, state: role.id === scenarioRole?.id ? { activity: scenarios.get().scene.title, feeling: scenarios.get().scene.emotionalMotive, wish: scenarios.get().scene.externalObjective, relationshipStage: '当前情境中的相处', scenario: scenarios.get() } : characters.get(role.id), recall: recallRepo.get(memoryRole(role.id)), life: role.id === 'miyue' ? lifeSnapshot() : null });
    }
    const recallMatch = pathname.match(/^\/api\/recall\/([^/]+)(\/refresh)?$/);
    if (recallMatch && ['PATCH', 'POST'].includes(req.method)) {
      const role = validateRole(decodeURIComponent(recallMatch[1]));
      const body = await readJsonBody(req);
      if (activeRoles.has(role.id)) throw fail(409, '她正在回复，等这句话说完再调整回忆', 'ROLE_BUSY');
      if (req.method === 'PATCH' && !recallMatch[2]) return sendJson(res, 200, { recall: recallRepo.replace(memoryRole(role.id), body.summary) });
      if (req.method === 'POST' && recallMatch[2]) {
        const result = await recall.run(memoryRole(role.id), { force: true });
        return sendJson(res, 200, { ...result, recall: recallRepo.get(memoryRole(role.id)) });
      }
    }

    if (req.method === 'GET' && pathname === '/api/zhihu') return sendJson(res, 200, zhihuStatus());
    if (req.method === 'POST' && pathname === '/api/zhihu/config') {
      zhihuClient.save(await readJsonBody(req));
      zhihuRepo.update({ nextRunAt: (options.clock?.() || new Date()).toISOString(), quota: null, quotaCheckedAt: null });
      return sendJson(res, 200, zhihuStatus());
    }
    if (req.method === 'POST' && pathname === '/api/zhihu/test') {
      await readJsonBody(req);
      const at = options.clock?.() || new Date(), runtime = zhihuRepo.runtime();
      if (!quotaPromise && runtime.quotaAttemptAt && +at - +new Date(runtime.quotaAttemptAt) < 60000) {
        if (runtime.quota && runtime.quotaRevision === zhihuClient.publicConfig().revision) return sendJson(res, 200, { ok: true, quota: runtime.quota });
        throw fail(429, '额度查询间隔为一分钟，请稍后重试', 'ZHIHU_QUOTA_COOLDOWN');
      }
      if (!quotaPromise) {
        const revision = zhihuClient.publicConfig().revision;
        zhihuRepo.update({ quotaAttemptAt: at.toISOString() });
        quotaPromise = zhihuClient.quota().then(quota => {
          if (zhihuClient.publicConfig().revision !== revision) throw fail(409, '研究配置已变更，请稍后重新查询额度', 'ZHIHU_CHANGED');
          zhihuRepo.update({ quota, quotaCheckedAt: at.toISOString(), quotaRevision: revision }); return quota;
        }).finally(() => { quotaPromise = null; });
      }
      return sendJson(res, 200, { ok: true, quota: await quotaPromise });
    }
    if (req.method === 'POST' && pathname === '/api/zhihu/refresh') {
      await readJsonBody(req); const result = await research.runNow(); return sendJson(res, 200, { ...result, ...zhihuStatus() });
    }

    if (req.method === 'GET' && pathname === '/api/proactive') return sendJson(res, 200, proactiveStatus());
    if (req.method === 'POST' && pathname === '/api/proactive/settings') {
      proactiveRepo.saveSettings(await readJsonBody(req));
      return sendJson(res, 200, proactiveStatus());
    }
    if (req.method === 'POST' && pathname === '/api/news/brief') {
      await readJsonBody(req); return sendJson(res, 200, await proactive.runNow({roleId:'wenxi', newsOnly:true}));
    }
    if (req.method === 'POST' && pathname === '/api/proactive/run') {
      await readJsonBody(req); return sendJson(res, 200, await proactive.runNow());
    }
    if (req.method === 'POST' && pathname === '/api/proactive/feedback') {
      const body = await readJsonBody(req);
      if (!proactiveRepo.feedback(String(body.messageId || ''), body.value)) throw fail(404, '这条主动消息不存在', 'NOT_FOUND');
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/api/activity') {
      const body = await readJsonBody(req);
      if (typeof body.typing !== 'boolean') throw fail(400, '活动状态无效', 'INVALID_INPUT');
      if (body.typing) typingUntil = Date.now() + 45000;
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && pathname === '/api/inbox') return sendJson(res, 200, proactiveRepo.inbox());
    const readMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/read$/);
    if (req.method === 'POST' && readMatch) {
      const role = decodeURIComponent(readMatch[1]); validateRole(role); const body = await readJsonBody(req);
      store.transaction(()=>{
        const id=String(body.messageId || '');
        if(!store.db.prepare('SELECT id FROM messages WHERE role=? AND id=?').get(role,id))throw fail(404,'已读位置不存在','NOT_FOUND');
        contentInbox.markConversationRead(role,id);
        proactiveRepo.markRead(role,id);
      });
      return sendJson(res, 200, { ok: true });
    }

    let match = pathname.match(/^\/api\/conversations\/([^/]+)$/);
    if (req.method === 'GET' && match) {
      const role = decodeURIComponent(match[1]); validateRole(role);
      return sendJson(res, 200, { messages: store.getMessages(role).map(row=>({...row,receipt:interactionPolicy.receipt(row.id)})),pending:{...chatQueue.get(role),remainingChunks:replyDelivery.pending(role)} });
    }
    if(req.method==='GET'&&pathname==='/api/chat/pending')return sendJson(res,200,{roles:Object.fromEntries(roles.map(role=>[role.id,{...chatQueue.get(role.id),remainingChunks:replyDelivery.pending(role.id)}]))});
    if(req.method==='POST'&&pathname==='/api/chat/send'){
      const body=await readJsonBody(req);const role=validateRole(body.role),text=requiredText(body.text);
      if(body.storyMode!==undefined&&typeof body.storyMode!=='boolean')throw fail(400,'故事模式无效','INVALID_INPUT');
      const options={storyMode:Boolean(body.storyMode),...(body.contentId?{contentId:String(body.contentId)}:{}),...(body.scenarioChoiceId?{scenarioChoiceId:body.scenarioChoiceId,scenarioVersion:body.scenarioVersion}:{}),...(body.lifeChoiceId?{lifeChoiceId:body.lifeChoiceId,lifeVersion:body.lifeVersion}:{})};
      return sendJson(res,202,{pending:chatQueue.submit(role.id,text,body.clientId,options)});
    }
    if(req.method==='POST'&&['/api/chat/retry','/api/chat/cancel'].includes(pathname)){
      const body=await readJsonBody(req);const role=validateRole(body.role);if(pathname.endsWith('cancel'))replyDelivery.cancel(role.id);
      return sendJson(res,200,{pending:pathname.endsWith('retry')?chatQueue.retry(role.id):chatQueue.cancel(role.id)});
    }
    if (req.method === 'POST' && pathname === '/api/chat') {
      const body=await readJsonBody(req);if(chatQueue.busy(body.role))throw fail(409,'这个角色正在回复，请稍候','ROLE_BUSY');
      validateRole(body.role);replyDelivery.cancel(body.role);return sendJson(res,200,await performChat(body));
    }

    if (req.method === 'GET' && pathname === '/api/memories') {
      const role = url.searchParams.get('role'); if (role) validateRole(role);
      return sendJson(res, 200, { memories: store.listMemories(role) });
    }
    if (req.method === 'POST' && pathname === '/api/memories') {
      const body = await readJsonBody(req); const scope = String(body.scope || '');
      if (scope !== 'shared') validateRole(scope);
      return sendJson(res, 201, { memory: store.addMemory(scope, requiredText(body.text, 'text', 4000)) });
    }
    match = pathname.match(/^\/api\/memories\/([^/]+)$/);
    if (req.method === 'PATCH' && match) {
      const body = await readJsonBody(req);
      if (body.scope !== undefined && body.scope !== 'shared') validateRole(body.scope);
      if (body.text !== undefined) body.text = requiredText(body.text, 'text', 4000);
      if (body.text === undefined && body.scope === undefined) throw fail(400, '没有可更新的字段', 'INVALID_INPUT');
      const memory = store.updateMemory(decodeURIComponent(match[1]), body);
      if (!memory) throw fail(404, '记忆不存在', 'NOT_FOUND');
      return sendJson(res, 200, { memory });
    }
    if (req.method === 'DELETE' && match) {
      if (!store.deleteMemory(decodeURIComponent(match[1]))) throw fail(404, '记忆不存在', 'NOT_FOUND');
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'GET' && pathname === '/api/story') return sendJson(res, 200, store.getStory());
    if (req.method === 'POST' && pathname === '/api/story/choose') {
      const body = await readJsonBody(req);
      return sendJson(res, 200, store.chooseStory(requiredText(body.choiceId, 'choiceId', 200), requiredText(body.expectedNodeId, 'expectedNodeId', 200)));
    }
    if (req.method === 'POST' && pathname === '/api/story/reset') {
      await readJsonBody(req);
      if (activeRoles.has('miyue')) throw fail(409, '弥月正在回复，请稍候再重置故事', 'ROLE_BUSY');
      return sendJson(res, 200, store.resetStory());
    }

    if (req.method === 'POST' && pathname === '/api/settings') {
      const body = await readJsonBody(req);
      if (body.quiet !== undefined && typeof body.quiet !== 'boolean') throw fail(400, 'quiet 必须是布尔值', 'INVALID_INPUT');
      const settings = store.setSettings(body);
      if (!settings.quiet && store.deliverDueReminders().length) void onDelivery().catch(() => {});
      return sendJson(res, 200, { settings });
    }
    if (req.method === 'GET' && pathname === '/api/reminders') return sendJson(res, 200, { reminders: store.listReminders() });
    if (req.method === 'POST' && pathname === '/api/reminders') {
      const body = await readJsonBody(req); validateRole(body.role);
      const dueAt = new Date(body.dueAt);
      if (typeof body.dueAt !== 'string' || Number.isNaN(dueAt.valueOf())) throw fail(400, 'dueAt 必须是有效时间', 'INVALID_INPUT');
      return sendJson(res, 201, { reminder: store.addReminder(body.role, requiredText(body.text, 'text', 4000), dueAt.toISOString()) });
    }
    match = pathname.match(/^\/api\/reminders\/([^/]+)$/);
    if (req.method === 'DELETE' && match) {
      if (!store.deleteReminder(decodeURIComponent(match[1]))) throw fail(404, '提醒不存在', 'NOT_FOUND');
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === 'POST' && pathname === '/api/provider') {
      const body = await readJsonBody(req);
      if (body.baseUrl !== undefined && body.baseUrl !== '' && !validProviderUrl(body.baseUrl)) throw fail(400, '模型接口地址无效', 'INVALID_URL');
      if (body.model !== undefined && typeof body.model !== 'string') throw fail(400, 'model 必须是字符串', 'INVALID_INPUT');
      if (body.apiKey !== undefined && typeof body.apiKey !== 'string') throw fail(400, 'apiKey 必须是字符串', 'INVALID_INPUT');
      const wasConfigured = model.publicConfig().configured;
      const provider = model.save(body);
      if (!wasConfigured && provider.configured) proactiveRepo.updateRuntime({ nextContactAt: new Date((options.clock?.() || new Date()).valueOf() + 60_000).toISOString(), lastReason: '模型已连接，稍后准备第一个话题' });
      return sendJson(res, 200, { provider });
    }
    if (req.method === 'POST' && pathname === '/api/provider/test') { await readJsonBody(req); return sendJson(res, 200, { ok: true, reply: await model.test() }); }

    if (req.method === 'GET' && pathname === '/api/content') {
      const page=contentInbox.list(Object.fromEntries(url.searchParams));
      const all=store.listContent(), selected=new Set(page.items.map(item=>item.id)), byId=new Map(all.map(item=>[item.id,item]));
      const items=dossiers.decorate([...page.items,...all.filter(item=>!selected.has(item.id))]).slice(0,page.items.length)
        .map(item=>({...item,relatedItems:item.dossier.relatedIds.slice(0,3).map(id=>byId.get(id)).filter(Boolean).map(({id,title,url,source,summary})=>({id,title,url,source,summary:summary?.slice(0,400)}))}));
      return sendJson(res,200,{...page,items,feeds:store.listFeeds()});
    }
    if (req.method === 'POST' && pathname === '/api/content/state') {
      const body=await readJsonBody(req);contentInbox.update(body.ids,body.action);return sendJson(res,200,{ok:true});
    }
    if (req.method === 'POST' && pathname === '/api/feeds') {
      const body = await readJsonBody(req); const feedUrl = requiredText(body.url, 'url', 2000);
      if (!validHttpUrl(feedUrl)) throw fail(400, '订阅地址无效', 'INVALID_URL');
      try { return sendJson(res, 201, { feed: store.addFeed(feedUrl, body.title ? requiredText(body.title, 'title', 300) : undefined) }); }
      catch { throw fail(409, '这个订阅已经存在', 'FEED_EXISTS'); }
    }
    match = pathname.match(/^\/api\/feeds\/([^/]+)$/);
    if (req.method === 'DELETE' && match) {
      if (decodeURIComponent(match[1]) === ZHIHU_FEED_ID) zhihuClient.save({ enabled: false });
      if (!store.deleteFeed(decodeURIComponent(match[1]))) throw fail(404, '订阅不存在', 'NOT_FOUND');
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'POST' && pathname === '/api/content/refresh') {
      await readJsonBody(req); return sendJson(res, 200, await refreshContent());
    }

    if(req.method==='GET'&&pathname==='/api/voice/catalog') {
      try{const catalog=await getVoiceCatalog(url.searchParams.get('refresh')==='1');return sendJson(res,200,{available:true,voices:catalog.voices.map(({id,name,description,language})=>({id,name,description,language})),assignments:roleVoices.list()});}
      catch{return sendJson(res,200,{available:false,voices:[],assignments:roleVoices.list(),error:'本地TTS暂不可用，已保存的音色仍保留。'});}
    }
    if(req.method==='POST'&&pathname==='/api/voice/roles') {
      const body=await readJsonBody(req);const role=validateRole(body.roleId);let voice=null;
      if(body.voiceId!==null){if(typeof body.voiceId!=='string')throw fail(400,'音色无效','INVALID_VOICE');const catalog=await getVoiceCatalog();voice=catalog.voices.find(v=>v.id===body.voiceId);if(!voice)throw fail(400,'音色不存在','INVALID_VOICE');}
      return sendJson(res,200,{assignments:roleVoices.set(role.id,voice)});
    }
    if(req.method==='POST'&&pathname==='/api/voice/preview') {
      const body=await readJsonBody(req),role=validateRole(body.roleId);const options=await speechOptions(role.id,body.voiceId);
      const result=await availableService(()=>integrations.startSpeech(`你好，我是${role.name}。今天也有一点想说给你听。`,options),'语音服务暂时不可用');voiceJobs.add(result.jobId);return sendJson(res,200,result);
    }
    if (req.method === 'GET' && pathname === '/api/voice/health') return sendJson(res, 200, await integrations.probeTts());
    if (req.method === 'POST' && pathname === '/api/voice/start') {
      const body = await readJsonBody(req); const message = store.getMessage(String(body.messageId || ''));
      if (!message || message.speaker !== 'assistant') throw fail(404, '可朗读的消息不存在', 'MESSAGE_NOT_FOUND');
      if (message.text.length > 5000) throw fail(400, '消息太长，暂时无法朗读', 'VOICE_TEXT_TOO_LONG');
      const awaitSpeechOptions = await speechOptions(message.role);
      const result = await availableService(() => integrations.startSpeech(message.text, awaitSpeechOptions), '语音服务暂时不可用'); voiceJobs.add(result.jobId);
      return sendJson(res, 200, { jobId: result.jobId });
    }
    match = pathname.match(/^\/api\/voice\/([^/]+)\/(status|audio|close)$/);
    if (match) {
      const jobId = decodeURIComponent(match[1]); const action = match[2];
      if (!voiceJobs.has(jobId)) throw fail(404, '语音任务不存在', 'VOICE_JOB_NOT_FOUND');
      if (req.method === 'GET' && action === 'status') return sendJson(res, 200, await availableService(() => integrations.readSpeechStatus(jobId), '语音服务暂时不可用'));
      if (req.method === 'GET' && action === 'audio') {
        const result = await availableService(() => integrations.getSpeechAudio(jobId), '语音服务暂时不可用');
        res.writeHead(200, { 'content-type': result.contentType, 'content-length': result.body.length, 'cache-control': 'no-store' }); return res.end(result.body);
      }
      if (req.method === 'POST' && action === 'close') {
        await readJsonBody(req); const result = await availableService(() => integrations.closeSpeech(jobId), '语音服务暂时不可用'); voiceJobs.delete(jobId); return sendJson(res, 200, result);
      }
    }
    if (req.method === 'POST' && pathname === '/api/transcribe') {
      const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
      if (!audioTypes.has(contentType)) throw fail(415, '不支持这种录音格式', 'UNSUPPORTED_AUDIO');
      const recording = await readBody(req, 20 * 1024 * 1024);
      return sendJson(res, 200, await availableService(() => integrations.transcribeAudio(recording, contentType), '转写服务暂时不可用'));
    }
    throw fail(404, '接口不存在', 'NOT_FOUND');
  }

  function serveStatic(req, res, url) {
    if (!['GET', 'HEAD'].includes(req.method)) throw fail(404, '页面不存在', 'NOT_FOUND');
    let decoded;
    try { decoded = decodeURIComponent(url.pathname); } catch { throw fail(400, '路径无效', 'INVALID_PATH'); }
    if (decoded.includes('\0') || decoded.split('/').some((part) => part === '..' || part.startsWith('.'))) throw fail(404, '页面不存在', 'NOT_FOUND');
    const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
    const file = path.resolve(publicDir, relative);
    if (file !== publicDir && !file.startsWith(`${publicDir}${path.sep}`)) throw fail(404, '页面不存在', 'NOT_FOUND');
    let stat; try { stat = fs.statSync(file); } catch { throw fail(404, '页面不存在', 'NOT_FOUND'); }
    if (!stat.isFile()) throw fail(404, '页面不存在', 'NOT_FOUND');
    const realPublic = fs.realpathSync(publicDir); const realFile = fs.realpathSync(file);
    if (!realFile.startsWith(`${realPublic}${path.sep}`)) throw fail(404, '页面不存在', 'NOT_FOUND');
    res.writeHead(200, { 'content-type': mimeTypes[path.extname(realFile).toLowerCase()] || 'application/octet-stream', 'content-length': stat.size, 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(realFile).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      requestGuard(req);
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname.startsWith('/api/') && ['POST', 'PATCH', 'DELETE'].includes(req.method) && url.pathname !== '/api/transcribe') {
        const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase();
        if (contentType !== 'application/json') throw fail(415, '请求需要使用 application/json', 'CONTENT_TYPE_REQUIRED');
      }
      if (url.pathname.startsWith('/api/')) await api(req, res, url); else serveStatic(req, res, url);
    } catch (error) {
      if (res.headersSent) return res.destroy();
      sendJson(res, Number(error?.status) || 500, { error: Number(error?.status) ? error.message : '服务暂时出现问题', ...(error?.code ? { code: error.code } : {}) });
    }
  });
  const reminderTimer = setInterval(() => { try { const delivered = store.deliverDueReminders(); if (delivered.length) onDelivery().catch(() => {}); } catch {} }, options.reminderIntervalMs || 10_000);
  reminderTimer.unref();
  let lifeThreadTimer=null;
  const tickLifeThreads=()=>{if(!closing&&!activeRoles.has('miyue')&&!chatQueue.busy('miyue')&&!replyDelivery.pending('miyue')){if(options.startLifeThreads!==false)lifeThreads.tick('miyue',life.get('miyue'));pursuits?.tick('miyue');companionAgenda.tick('miyue');}};

  return {
    server, store, model, proactive, proactiveRepo, refreshContent, zhihuClient, zhihuRepo, research, characters, recall, recallRepo, usage, life, lifeTopics, inner, scenarios, dossiers, gentle, preferences, background, roleVoices, chatQueue, replyDelivery, followups, topicTracking, moments, episodes, interactionPolicy, lifeThreads, pursuits, personalExperiences, sourceChanges, companionTuning, companionBehavior, contentInbox, sharedExperiences, companionRelationship, companionAgenda, wardrobe, appearance, sceneImages, imageLibrary, companionRuntime, runtimeScenes, roleContext,
    listen(port = options.port ?? 8765) {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, network.listenHost, () => { if(options.startRuntime!==false)companionRuntime.start(); if(options.startChatQueue!==false){chatQueue.start();replyDelivery.start();} server.off('error', reject); if (options.startLife !== false && options.startProactive !== false) life.start(); if (options.startRecall !== false && options.startProactive !== false) recall.start(); if (options.startProactive !== false) { tickLifeThreads();lifeThreadTimer=setInterval(tickLifeThreads,options.proactiveIntervalMs||15000);lifeThreadTimer.unref();proactive.start(); scheduleDossiers(); } if (options.startResearch !== false && options.startProactive !== false) research.start(); resolve(server.address()); });
      });
    },
    async close() {
      if (closing) return Promise.resolve(); closing = true; clearInterval(reminderTimer);clearInterval(lifeThreadTimer);
      desktopAttention.interrupt();companionRuntime.stop();life.stop();replyDelivery.stop();await chatQueue.stop();
      await Promise.all([proactive.stop(), research.stop(), recall.stop(), quotaPromise?.catch(() => {})]); if (refreshPromise) await refreshPromise; if (dossierJob) await dossierJob;
      await new Promise(resolve=>server.close(resolve));
      if(typeof integrations.closeSpeech==='function')await Promise.allSettled([...voiceJobs].map(id=>integrations.closeSpeech(id)));voiceJobs.clear();
      store.close();
    },
  };
}

function cliArgs(argv) {
  const result = { port: 8765, dataDir: path.join(rootDir, 'data') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port') result.port = Number(argv[++i]);
    else if (argv[i] === '--data-dir') result.dataDir = path.resolve(argv[++i]);
  }
  if (!Number.isInteger(result.port) || result.port < 1 || result.port > 65535) throw new Error('端口无效');
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = cliArgs(process.argv.slice(2));
  const app = await createApp(options);
  await app.listen(options.port);
  process.stdout.write(`有间已启动：http://127.0.0.1:${options.port}\n`);
  const shutdown = async () => { await app.close(); process.exit(0); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
