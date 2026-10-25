import { conversationTrigger } from './conversation-plan.mjs';
import { routineLabel } from './life-participation.mjs';
import { proactiveMaterialSlate } from './proactive-materials.mjs';
import { travelState } from './travel-state.mjs';
import { MAX_UNANSWERED_MESSAGES } from './store.mjs';
import { missingPulse, missMaterial } from './relationship-pulse.mjs';
import { noveltyContext } from './novelty-guard.mjs';
import { identityTurnNote } from './companion-identity.mjs';
import { workCalendar } from './work-calendar.mjs';
import { lengthBudget, exampleReplies } from './companion-voice.mjs';
import { mentionedSources, sourceMentionInternals } from './source-mentions.mjs';

const INFORMATION_KINDS = new Set(['article', 'daily_info']);
const OWN_LIFE_KINDS = new Set(['life_thread', 'daily_happening', 'reading', 'film', 'arc_beat', 'arc_choice']);
// “那篇”“那个游戏”“你刚说的” point back at something she shared.
const SOURCE_DEIXIS = /那篇|这篇|那条|那个(?:游戏|新闻|研究|报道|文章|消息|帖子|视频|东西)|那款|那部|那本|你(?:刚|刚刚|刚才|之前|上次|早上|昨天)(?:说|讲|提|发|分享)的|你说的那|书里|文章里|文中|原文|全文|摘要|那一?[节段章]|具体(?:怎么|是|说|讲|写)|怎么说的|(?:说|讲|写)(?:了|的)?(?:啥|什么)/u;
const { compact } = sourceMentionInternals;
function sharesTitleWords(text, title, run = 4) {
  const haystack = compact(text), needle = [...compact(title)];
  if (haystack.length < run) return false;
  for (let i = 0; i + run <= needle.length; i++) if (haystack.includes(needle.slice(i, i + run).join(''))) return true;
  return false;
}
// After an article or news clue was the last thing she shared unprompted,
// news is held back for one run whenever a step of her own life is on offer.
export function alternateMaterials(materials = [], recent = []) {
  const held = INFORMATION_KINDS.has(recent[0]?.kind) && materials.some(item => OWN_LIFE_KINDS.has(item.kind));
  return { held, materials: held ? materials.filter(item => !INFORMATION_KINDS.has(item.kind)) : materials };
}
// Shared-source details are only worth their prompt space when this turn is
// about them: he names the title (or shares a ≥4 character run of it), or
// points back at “that article / what you just said”. Otherwise the title and
// link are enough, and the sources tool can still read more.
// A pointer with no title picks the source whose text shares words with his
// message (“那个温泉旅馆的游戏”), or else the latest one.
export function sourcesToExpand(text, items = [], { body = () => '' } = {}) {
  const value = String(text || '');
  if (!value.trim() || !items.length) return new Set();
  const chosen = new Set(mentionedSources(value, items));
  for (const item of items) if (item?.title && sharesTitleWords(value, item.title)) chosen.add(item);
  if (!chosen.size && SOURCE_DEIXIS.test(value)) {
    const described = items.filter(item => sharesTitleWords(value, String(body(item) || '').slice(0, 1500)));
    const pool = described.length ? described : items;
    chosen.add(pool.reduce((a, b) => (Date.parse(b.at || '') || 0) > (Date.parse(a.at || '') || 0) ? b : a));
  }
  return chosen;
}

const stale = (message, code) => Object.assign(new Error(message), { status: 409, code });

// Prepare and validate the evidence shared by chat, desktop, and proactive turns.
// Transport, tool execution, and atomic delivery remain with their callers.
// He comes back after a long silence: say so plainly, so she can notice it
// instead of carrying on as if they had talked an hour ago.
const REUNION_HOURS = 20;
export function reunionFact(store, roleId, now) {
  const last = speaker => store.db.prepare('SELECT created_at FROM messages WHERE role=? AND speaker=? ORDER BY created_at DESC LIMIT 1').get(roleId, speaker)?.created_at;
  const hisLast = Date.parse(last('user') || '');
  if (!Number.isFinite(hisLast)) return null;
  const hours = Math.floor((+now - hisLast) / 3600000);
  if (hours < REUNION_HOURS) return null;
  const herLast = Date.parse(last('assistant') || '');
  const unanswered = Number.isFinite(herLast) && herLast > hisLast;
  return {
    hoursSinceHisLastMessage: hours,
    note: `他上一次说话是约${hours >= 48 ? `${Math.floor(hours / 24)}天` : `${hours}小时`}前${unanswered ? '，之后你发的消息他没回' : ''}。他现在回来了：先让他感到你注意到了、想他（正面地说想他，不说“等了一整天”“没动静”这类让他内疚的话），再顺着他这条话接；不知道他这段时间在干嘛就问，不替他编，不责怪。`,
  };
}

export function createSessionContext({
  store, roleMap, clock = () => new Date(), recallRepo, companionRuntime,
  episodes, historyEdits, companionRelationship, companionDynamics, companionAgenda,
  dueFollowup, eventMaterials, proactiveMaterials, pursuits, discussionTopics,
  companionTuning, interactionPolicy, life, sceneImages, appearance, preferences, characterGrowth, dailyMemory, dailyInformation,
  dailyHappenings = null, lifeThreads = null, interestTopics = () => '',
  relationshipLedger = null, storyArcs = null, companionIdentity = null,
}) {
  const memoryVersion = roleId => JSON.stringify(store.listMemories(roleId));
  const windowVersion = () => JSON.stringify({ ...preferences.getHistoryWindow(), dailyCompression:dailyMemory?.settings() });

  function prepare(roleId, settings = {}) {
    return dailyMemory?.withChunkCache ? dailyMemory.withChunkCache(() => prepareOnce(roleId, settings)) : prepareOnce(roleId, settings);
  }
  function prepareOnce(roleId, { text = '', initiating = false, opening = false, trigger: givenTrigger = null, candidates = [] } = {}) {
    const now = clock();
    const trigger = givenTrigger || conversationTrigger({
      type: opening ? 'desktop_invitation' : initiating ? 'scheduled_opportunity' : 'user_message',
      userText: initiating || opening ? null : text, at: now,
    });
    const compressed = dailyMemory?.settings().enabled;
    const history = compressed ? dailyMemory.history(roleId, {now,maxTokens:preferences.getHistoryWindow().historyMaxTokens}) : recallRepo.dialogueWindow(roleId, { now });
    const runtime = companionRuntime.prepare({ trigger: trigger.type, text: trigger.userText || '' });
    const suppressedSourceIds = episodes.suppressedSourceIds(roleId);
    const relationship = companionRelationship.context(roleId, { text, suppressedSourceIds });
    const settings = companionDynamics.settings();
    const dynamics = companionDynamics.get(roleId);
    const growth = characterGrowth?.get(roleId);
    const tuning = companionTuning.get();
    const policy = interactionPolicy.get(roleId);
    const agendaOpportunity = initiating ? companionAgenda.pending(roleId, { suppressedSourceIds }) : null;
    const followup = initiating && !agendaOpportunity ? dueFollowup(roleId) : null;
    const material = initiating || opening ? eventMaterials.select(runtime.dailyLife?.events || [])[0] || null : null;
    const recentMaterials = proactiveMaterials.recent(roleId);
    // Unprompted sharing follows the interest directions set under 主动陪伴;
    // in a reply to him every category stays available.
    // Today's small happenings and one thing of his to ask about: evidence in
    // a reply, slate entries (her own life) when she reaches out.
    const dailyOffer = dailyHappenings?.offer(roleId, { now }) || null;
    const informationCandidates=dailyInformation?.slate({role:roleId,query:text,activity:runtime.current,maxChars:initiating?4000:2000,...(initiating?{topics:interestTopics()}:{})})||[];
    // A written week of story replaces the template life thread.
    const weekStory = storyArcs?.active(roleId, { now }) || null;
    const hisLastAt = store.db.prepare("SELECT MAX(created_at) at FROM messages WHERE role=? AND speaker='user'").get(roleId)?.at || null;
    const pulse = initiating ? missingPulse({ hisLastAt, now, missing: tuning.values.missing }) : null;
    const lastMissAt = initiating ? store.db.prepare("SELECT MAX(created_at) at FROM proactive_material_deliveries WHERE role_id=? AND kind='miss'").get(roleId)?.at || null : null;
    const miss = missMaterial(pulse, { lastMissAt, now });
    let sessionMaterials = initiating && !agendaOpportunity && !followup ? [...(miss ? [miss] : []),...(storyArcs?.materials(roleId, { now }) || []),...(relationshipLedger?.materials(roleId, { now }) || []),...informationCandidates,...proactiveMaterialSlate({
      articles: candidates, pursuit: pursuits?.pending(roleId), discussion: discussionTopics?.choose({ roleId }), thread: weekStory ? null : lifeThreads?.pending(roleId, life.get(roleId)), recent: recentMaterials,
    }),...(dailyHappenings?.materials(dailyOffer) || [])] : [];
    // Unprompted shares alternate between her own life and things read
    // online: right after a shared article or news clue, when a step of her
    // own life is on offer, this run offers only that (and other non-news).
    const alternated = alternateMaterials(sessionMaterials, recentMaterials);
    const holdInformation = initiating && alternated.held;
    sessionMaterials = alternated.materials;
    const offeredInformation = holdInformation ? [] : informationCandidates;
    const reunion = trigger.type === 'user_message' ? reunionFact(store, roleId, now) : null;
    const identityState = companionIdentity?.get() || { mode: 'human' }, identity = identityState.mode;
    const context = {
      scope: roleId, trigger, conversation: history.rows, dialogueHistory: history, runtime,
      entries: [], episodeRevision: episodes.revision(roleId), historyEditsRevision: historyEdits.revision(roleId),
      relationshipRevision: companionRelationship.revision(roleId), agendaRevision: companionAgenda.revision(roleId),
      dynamicsRevision: dynamics.revision, growthRevision: growth?.revision || 0,
      sessionSettingsRevision: settings.revision, sessionMemoryRevision: recallRepo.get(roleId).revision,
      sessionManualMemoryVersion: memoryVersion(roleId), sessionWindowVersion: windowVersion(),
      sessionRuntimeRevision: runtime.revision, sessionTuningRevision: tuning.revision,
      sessionPolicyRevision: policy.revision, agendaOpportunity, followupId: followup?.id || null,
      dailyMemoryRevision:dailyMemory?.revision(roleId)||0,
      opportunity: agendaOpportunity ? { kind: 'agenda', value: agendaOpportunity }
        : followup ? { kind: 'followup', value: followup } : { kind: 'session' },
      informationCandidates: offeredInformation, ...(initiating ? { sessionMaterials, holdInformation } : {}), dailyOffer,
      lifeTopicKey: agendaOpportunity?.key || `session:${roleId}:${trigger.at}`,
      policyPlan: { tuningRevision: tuning.revision, anchor: '', behavior: { session: true } },
    };
    const pendingReminders = store.listReminders().filter(item => item.role === roleId && item.status === 'pending');
    const sourceId = store.db.prepare('SELECT content_id FROM messages WHERE id=?');
    const sourceReceipts = history.rows.filter(row => row.speaker === 'assistant').slice(-40)
      .map(row => ({ ...row, contentId: sourceId.get(row.id)?.content_id }))
      .filter(row => row.contentId).slice(-3).map(row => {
        const source = store.getContent(row.contentId);
        return source ? { messageId: row.id, at: row.createdAt, contentId: source.id, title: source.title, url: source.url, summary: source.summary } : null;
      }).filter(Boolean);
    const expandedReceipts = sourcesToExpand(trigger.userText, sourceReceipts, { body: receipt => receipt.summary });
    for (const receipt of sourceReceipts) {
      const { summary } = receipt; delete receipt.summary;
      if (expandedReceipts.has(receipt)) Object.assign(receipt, { scope: '订阅缓存摘录开头，不能据此声称读过全文；需要更多内容时用 sources 读取', excerpt: String(summary || '').slice(0, 500) });
      else receipt.scope = '她分享过的来源，只有标题；用户问到细节时用 sources 读取，不凭标题补内容';
    }
    const sharedMaterials = recentMaterials.filter(item => history.rows.some(row => row.id === item.messageId)).slice(0, 2)
      .map(item => ({ item, title: item.title, url: item.url || item.source?.url || item.sources?.[0]?.url, at: item.createdAt }));
    const expandedMaterials = sourcesToExpand(trigger.userText, sharedMaterials, { body: entry => `${entry.item.quote || ''} ${entry.item.detail || ''}` });
    context.sessionOptions = {
      history, trigger, compactHistory:compressed,
      preferences: { expression: settings.expressionPreferences, interaction: policy.preferences },
      // Personality is rendered as behaviour in the persona; verbosity also sets
      // this turn's length budget, which is checked after generation.
      voiceValues: tuning.values,
      lengthBudget: lengthBudget(tuning.values, { userText: trigger.userText, proactive: initiating || opening }),
      exampleFragments: exampleReplies(tuning.values, { at: trigger.at }),
      stableContext: compressed ? dailyMemory.context(roleId, { now, mode: 'stable' }) : '',
      facts: {
        at: trigger.at, travel: travelState(life.get(roleId), now),
        deliveryCadence: {
          unansweredMessages: trigger.type === 'user_message' ? 0 : store.unansweredAssistantCount(roleId),
          maxUnansweredMessages: MAX_UNANSWERED_MESSAGES,
        },
        character: { id: roleId, name: roleMap.get(roleId)?.name, location: runtime.world?.location, activity: runtime.current?.title || routineLabel(runtime.current),
          activityScope:'程序日程的当前安排，不是对话动作完成、共同场景结束或已经转场的回执',calendar:workCalendar(now) },
        ...(pendingReminders.length ? {
          reminders: pendingReminders.slice(-12).map(({ id, text, dueAt, status }) => ({ id, text, dueAt, status })),
          reminderCount: pendingReminders.length,
        } : {}),
        ...(sourceReceipts.length ? { sourceReceipts } : {}),
        ...(reunion ? { reunion } : {}),
        ...(pulse ? { missingHim: pulse } : {}),
      },
      // The day's mood replaces the long-frozen dynamics state when present.
      backgroundContext: [relationship, relationshipLedger?.stableContext(roleId, { stubborn: tuning.values.stubborn }), storyArcs?.stableContext(roleId, { now }), dailyHappenings?.stableContext(roleId, { now }) || companionDynamics.context(roleId, { includeExpression: false }), characterGrowth?.context(roleId), identity === 'ai' ? '' : sceneImages.context() || appearance.context()].filter(Boolean).join('\n'),
      identity,
      turnNotes: (() => { const recentRows = store.getMessages(roleId, 300); return [identityTurnNote(identityState), noveltyContext(recentRows, { now }), storyArcs?.dominance(roleId, recentRows, { now }), initiating ? '' : relationshipLedger?.turnHint(roleId, { now })].filter(Boolean).join('\n'); })(),
      recallContext: compressed ? dailyMemory.context(roleId,{query:text,now,mode:'query'}) : recallRepo.longTermContext(roleId, history.rows, { omitLegacy: episodes.hasOverrides(roleId), characterQuery: text, includeCharacter: true }),
      opportunity: initiating || opening ? { agenda: agendaOpportunity, followup, life: material } : null,
      ...(initiating ? {
        proactiveMaterials: sessionMaterials,
        recentMaterials: recentMaterials.slice(0, 6).map(({ kind, title, createdAt }) => ({ kind, title, createdAt })),
      } : {}),
      informationContext: [...sharedMaterials.map(entry => JSON.stringify(expandedMaterials.has(entry)
          ? { ...entry.item, scope: '已实际分享的材料及出处，用于后续追问；不意味着已经说过所有内容。' }
          : { messageId: entry.item.messageId, kind: entry.item.kind, title: entry.title, url: entry.url, at: entry.at,
            scope: '已实际分享的材料，只给标题；用户追问细节时用 sources 读取，不凭标题补内容。' })),
        ...(dailyInformation?.recent(roleId,3)||[]).map(item=>JSON.stringify({id:`daily-info:${item.item_id}`,title:item.title,url:item.url,at:item.created_at,scope:'已实际分享的日常线索，可用explore继续读详情，不要求重复聊。'}))].join('\n'),
      informationCandidates: offeredInformation, exploreEnabled:Boolean(dailyInformation),
      ...(dailyOffer ? initiating ? { ownContext: dailyHappenings.turnContext(dailyOffer, { toldOnly: true }) }
        : { ownContext: dailyHappenings.turnContext(dailyOffer), ownIds: [...dailyOffer.items.map(item => item.id), ...(dailyOffer.followUp ? [dailyOffer.followUp.id] : [])] } : {}),
    };
    return context;
  }

  function assertCurrent(context) {
    const roleId = context.scope;
    if(context.dailyMemoryRevision!==(dailyMemory?.revision(roleId)||0))throw stale('按日核心记录已更新，正在重新准备','STALE_SESSION_CONTEXT');
    if (context.historyEditsRevision !== historyEdits.revision(roleId) || context.episodeRevision !== episodes.revision(roleId)) {
      throw stale('对话依据已更正，正在重新准备', 'STALE_HISTORY_EDITS');
    }
    if (context.sessionSettingsRevision !== companionDynamics.settings().revision
      || context.sessionMemoryRevision !== recallRepo.get(roleId).revision
      || context.sessionManualMemoryVersion !== memoryVersion(roleId)
      || context.sessionWindowVersion !== windowVersion()
      || context.relationshipRevision !== companionRelationship.revision(roleId)
      || context.agendaRevision !== companionAgenda.revision(roleId)
      || context.dynamicsRevision !== companionDynamics.get(roleId).revision
      || context.growthRevision !== (characterGrowth?.get(roleId).revision || 0)) {
      throw stale('相处记录已更新，正在重新准备', 'STALE_SESSION_CONTEXT');
    }
    if (context.sessionTuningRevision !== companionTuning.get().revision) throw stale('相处参数已变化，请重新生成', 'STALE_COMPANION_TUNING');
    if (context.sessionPolicyRevision !== interactionPolicy.get(roleId).revision) throw stale('相处偏好已变化，请重新回复', 'STALE_DIALOGUE_POLICY');
    if (context.sessionRuntimeRevision !== companionRuntime.advance().revision) throw stale('当前生活安排已变化，正在重新准备', 'STALE_COMPANION_RUNTIME');
  }

  return { prepare, assertCurrent };
}
