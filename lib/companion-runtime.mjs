import { createHash } from 'node:crypto';
import { buildCompanionWorld } from './companion-world.mjs';
import { innerEventViews } from './companion-events.mjs';
import { travelState } from './travel-state.mjs';
import { workCalendar } from './work-calendar.mjs';

const KEY = 'companion_runtime:miyue';
const TZ_OFFSET = 8 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const MAX_TRANSITIONS = 12;
const DEFAULT_SETTINGS = Object.freeze({ enabled: true, automaticScenes: true, imageRotationMinutes:30, imageSeason:'auto', imageEnvironment:'auto', imageVariant:'cutout' });

const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const clean = (value, fallback = '') => typeof value === 'string' && value.trim() ? value.trim() : fallback;

function asDate(value) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('CompanionRuntime clock returned an invalid date');
  return date;
}

function localParts(now) {
  const local = new Date(now.getTime() + TZ_OFFSET);
  return {
    year: local.getUTCFullYear(), month: local.getUTCMonth(), date: local.getUTCDate(),
    hour: local.getUTCHours(), minute: local.getUTCMinutes(), weekday: local.getUTCDay(),
  };
}

function dayKey(now) {
  const p = localParts(now);
  return `${p.year}-${String(p.month + 1).padStart(2, '0')}-${String(p.date).padStart(2, '0')}`;
}

function localTime(day, hour, minute = 0) {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date, hour - 8, minute, 0, 0)).toISOString();
}

function weighted(random, entries) {
  const total = entries.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
  let cursor = clamp(Number(random()) || 0, 0, .999999999) * total;
  for (const entry of entries) {
    cursor -= Math.max(0, entry.weight);
    if (cursor < 0) return entry.value;
  }
  return entries.at(-1).value;
}

function trait(inputs, name, fallback = 50) {
  const source = inputs?.tuning?.values ?? inputs?.tuning ?? {};
  return Number.isFinite(source[name]) ? clamp(source[name], 0, 100) : fallback;
}

function makeActivity(day, id, kind, title, location, startHour, startMinute, endHour, endMinute, extra = {}) {
  const endsNextDay = endHour < startHour || (endHour === startHour && endMinute <= startMinute);
  const start = localTime(day, startHour, startMinute);
  const endBase = localTime(day, endHour, endMinute);
  const end = endsNextDay ? new Date(Date.parse(endBase) + 24 * HOUR).toISOString() : endBase;
  return { id: `${day}:${id}`, kind, title, location, startedAt: start, endsAt: end, sceneId: sceneFor(kind, location), ...extra };
}

export function sceneFor(kind, location = '') {
  if (kind === 'sleep') return 'private-bedroom';
  if (['work', 'reading', 'sketching'].includes(kind)) return 'study';
  if (kind === 'cafe') return 'autumn-cafe';
  if (kind === 'bar') return 'autumn-cafe';
  if (kind === 'walk') return 'spring-study';
  if (['home', 'meal', 'rest', 'waking', 'preparation', 'music','watching'].includes(kind)) return 'winter-home';
  if (kind === 'travel') return /海|海岸|海边|coast|beach/iu.test(location) ? 'summer-coast' : 'spring-study';
  return 'winter-home';
}

function sharingSeed(kind) {
  if (kind === 'waking') return '从刚醒来的光线、天气或昨夜留下的感觉中选一个真实细节，自然说起。';
  if (kind === 'meal') return '从味道、食材、店里见到的小事或此刻胃口中选一个具体细节，自然分享。';
  if (kind === 'rest') return '从短暂放空时注意到的声音、身体感受或念头中选一个细节，自然说起。';
  return '从此刻的环境、手边正在做的事或刚冒出的感受中选一个具体细节，自然分享；不必套用固定句式。';
}

function dailyPlan(day, inputs, random) {
  const independence = trait(inputs, 'independence');
  const playfulness = trait(inputs, 'playfulness');
  const initiative = trait(inputs, 'initiative');
  const evening = weighted(random, [
    { value: ['cafe', '在咖啡馆坐坐，翻翻最近感兴趣的资料', '苏州的咖啡馆'], weight: 1 + initiative / 70 },
    { value: ['bar', '去安静的小酒馆坐坐', '苏州的小酒馆'], weight: .35 + playfulness / 90 },
    { value: ['home', '回家做饭和整理房间', '苏州的家中'], weight: .9 + independence / 80 },
    { value: ['reading', '在家读书', '苏州的家中'], weight: 1.1 + independence / 65 },
    { value: ['watching', '在家挑一部剧或电影看看', '苏州的家中'], weight: 1.6 + playfulness / 70 },
    { value: ['walk', '饭后在附近散散步', '苏州街巷'], weight: 1.1 },
  ]);
  const hobby = weighted(random, [
    { value: ['reading', '读一会儿书'], weight: 1.3 + independence / 80 },
    { value: ['music', '整理歌单听音乐'], weight: .8 + playfulness / 80 },
    { value: ['watching', '看看最近的剧集、电影或有意思的视频'], weight: 1.5 + playfulness / 80 },
    { value: ['home', '琢磨明天想吃的菜和厨房里还有什么'], weight: 1.1 },
  ]);
  const jitter = () => Math.floor(clamp(Number(random()) || 0, 0, .999999) * 3) * 10;
  const breakfastMinute = jitter();
  const shareWake = Number(random()) < (.04 + initiative / 1000);
  const shareBreakfast = Number(random()) < (.05 + playfulness / 1200);
  const shareLunch = Number(random()) < (.04 + initiative / 1400);
  const shareRest = Number(random()) < (.035 + independence / 1600);
  const shareEvening = Number(random()) < (.16 + initiative / 500);
  const shareHobby = Number(random()) < (.10 + playfulness / 600);
  const commonStart = [
    makeActivity(day, 'sleep-late', 'sleep', '睡觉', '苏州的家中', 0, 0, 7, 20),
    makeActivity(day, 'wake', 'waking', '起床洗漱', '苏州的家中', 7, 20, 8, breakfastMinute, { share: shareWake }),
    makeActivity(day, 'breakfast', 'meal', '吃早餐，看看今天想吃点什么', '苏州的家中', 8, breakfastMinute, 8, breakfastMinute + 30, { share: shareBreakfast }),
    makeActivity(day, 'morning-ready', 'preparation', '收拾东西准备出门', '苏州的家中', 8, breakfastMinute + 30, 9, 0),
  ];
  const weekdayMiddle = [
    makeActivity(day, 'work-am', 'work', '处理上午的工作', '苏州的工作室', 9, 0, 12, 0),
    makeActivity(day, 'lunch', 'meal', '挑午饭，吃点喜欢的东西', '工作室附近', 12, 0, 12, 45, { share: shareLunch }),
    makeActivity(day, 'rest', 'rest', '午后休息', '苏州的工作室', 12, 45, 13, 20, { share: shareRest }),
    ...[
      makeActivity(day, 'work-pm', 'work', '处理下午的工作', '苏州的工作室', 13, 20, 15, 0),
      makeActivity(day, 'afternoon-reading', 'rest', '忙完一段，看看新见闻、剧集预告或计划去哪走走', '苏州的工作室', 15, 0, 16, 30),
      makeActivity(day, 'work-resume', 'work', '接着处理手头的工作', '苏州的工作室', 16, 30, 18, 0),
    ],
  ];
  const weekendMiddle = [
    makeActivity(day, 'weekend-morning', 'home', '慢慢收拾房间，听音乐或看看最近有什么好玩的', '苏州的家中', 9, 0, 11, 0),
    makeActivity(day, 'weekend-outing', 'travel', '去城里散步看展', '苏州街巷', 11, 0, 12, 30),
    makeActivity(day, 'lunch', 'meal', '在外面吃午饭', '苏州街巷', 12, 30, 13, 30, { share: shareLunch }),
    makeActivity(day, 'rest', 'rest', '找个安静地方歇一会儿', '苏州的咖啡馆', 13, 30, 14, 15, { share: shareRest }),
    makeActivity(day, 'weekend-reading', 'reading', '找个地方坐着，读最近在看的内容', '苏州的咖啡馆', 14, 15, 15, 45),
    makeActivity(day, 'weekend-free', 'walk', '在城里随意走走', '苏州街巷', 15, 45, 18, 0),
  ];
  return [...commonStart, ...(workCalendar(localTime(day,12)).restDay ? weekendMiddle : weekdayMiddle),
    makeActivity(day, 'dinner', 'meal', '想想晚饭吃什么，慢慢吃一顿', evening[2], 18, 0, 19, 0, { share: Number(random()) < .05 }),
    makeActivity(day, 'afterwork', evening[0], evening[1], evening[2], 19, 0, 21, 0, { share: shareEvening }),
    makeActivity(day, 'hobby', hobby[0], hobby[1], '苏州的家中', 21, 0, 22, 40, { share: shareHobby }),
    makeActivity(day, 'wind-down', 'rest', '洗漱并准备休息', '苏州的家中', 22, 40, 23, 20),
    makeActivity(day, 'sleep-early', 'sleep', '睡觉', '苏州的家中', 23, 20, 7, 20),
  ];
}

function initialState(now) {
  return {
    schema: 1, revision: 0, settings: { ...DEFAULT_SETTINGS }, days: {}, currentKey: null,
    currentSemantic: null, currentRecord: null, transitions: [], pending: null, delivered: {}, initializedAt: now.toISOString(), updatedAt: now.toISOString(), lastAdvancedAt: null,
  };
}

function publicActivity(activity) {
  if (!activity) return null;
  const { share, ...result } = activity;
  return result;
}

function activeTravel(inputs, now) {
  const active = inputs?.life?.active;
  if (active?.legacyBoundaryRuntime && ['plan', 'home'].includes(active.phase?.id)
      && Date.parse(active.startedAt) <= +now && +now < Date.parse(active.endsAt)) {
    return { active, phase: active.phase, legacy: true };
  }
  const state = travelState(active, now);
  if (state) return !['planned', 'returned'].includes(state.status) ? { active, state } : null;
  if (!active || active.type !== 'travel' || Date.parse(active.startedAt) > +now || +now >= Date.parse(active.endsAt) || !active.phase) return null;
  return { active, phase: active.phase, legacy: true };
}

function travelActivity(activity, travel) {
  if (travel.legacy) {
    const routineWins = ['sleep', 'meal', 'rest', 'waking'].includes(activity.kind);
    const location = clean(travel.phase.location, activity.location);
    const travelTitle = clean(travel.phase.activity, `在${location}附近走走`);
    return { ...activity, location, ...(routineWins ? { sceneId: sceneFor(activity.kind, location) } : { title: travelTitle, kind: 'travel', sceneId: sceneFor('travel', location) }) };
  }
  const state = travel.state;
  const boundary = Date.parse(state.nextTransitionAt);
  const endsAt = Number.isFinite(boundary) && boundary < Date.parse(activity.endsAt) ? state.nextTransitionAt : activity.endsAt;
  if (state.status !== 'staying') {
    const title = state.status === 'returning' ? `在返回${state.homeCity}的路上` : `在前往${state.nextCity}的路上`;
    return { ...activity, kind: 'travel', title, location: state.location, endsAt, sceneId: sceneFor('travel', state.location) };
  }

  const city = state.currentCity;
  const lodging = state.lodging || `${city}的住处`;
  const base = { ...activity, endsAt };
  if (activity.kind === 'work') {
    const morning = activity.id.includes('work-am');
    const kind = morning ? 'reading' : 'walk';
    const title = morning ? '在住处读书，整理一点随手笔记' : `在${city}附近慢慢走一段`;
    const location = morning ? lodging : `${city}街区`;
    return { ...base, kind, title, location, sceneId: sceneFor(kind, location) };
  }
  if (activity.kind === 'travel') {
    const location = `${city}街区`;
    return { ...base, kind: 'walk', title: `在${city}附近随意走走`, location, sceneId: sceneFor('walk', location) };
  }
  let location;
  if (activity.kind === 'meal') location = `${city}的住处或附近`;
  else if (['walk', 'cafe', 'bar'].includes(activity.kind)) location = `${city}附近`;
  else location = lodging;
  return { ...base, location, sceneId: sceneFor(activity.kind, location) };
}

function agendaActivities(inputs, now) {
  const source = typeof inputs?.agenda?.view === 'function' ? inputs.agenda.view('miyue') : inputs?.agenda;
  return (source?.plans ?? []).filter(plan => {
    if (plan.owner !== 'character') return plan.owner === 'joint' && plan.status === 'active';
    if (plan.status === 'active') return true;
    return plan.status === 'planned' && plan.dueAt && Date.parse(plan.dueAt) <= +now;
  });
}

export class CompanionRuntime {
  constructor(store, { clock = () => new Date(), random = Math.random, getInputs = () => ({}), intervalMs = 60_000, onAdvance = null, dailyLife = null, prepareDailyLife = null, pursuits = null } = {}) {
    if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('CompanionRuntime requires a transactional store');
    this.store = store; this.clock = clock; this.random = random; this.getInputs = getInputs;
    this.intervalMs = Math.max(10, Number(intervalMs) || 60_000); this.timer = null; this.onAdvance = onAdvance;
    this.lastTickAt = null; this.lastError = null;
    this.dailyLife = dailyLife; this.pursuits = pursuits;
    this.prepareDailyLife = prepareDailyLife;
  }

  #now() { return asDate(this.clock()); }
  #load(now) {
    const raw = this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(KEY)?.value;
    if (!raw) return initialState(now);
    try { const saved=JSON.parse(raw);return { ...initialState(now), ...saved, settings:{...DEFAULT_SETTINGS,...saved.settings} }; } catch { return initialState(now); }
  }
  #save(state) {
    this.store.db.prepare('INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(KEY, JSON.stringify(state));
  }

  #advance() {
    const now = this.#now();
    return this.store.transaction(() => {
      const state = this.#load(now); const inputs = this.getInputs() ?? {}; const day = dayKey(now);
      const longAbsence = state.lastAdvancedAt && +now - Date.parse(state.lastAdvancedAt) > 2 * HOUR;
      let changed = false; let planChanged = false;
      if (!state.days[day]) { state.days[day] = dailyPlan(day, inputs, this.random); state.planVersion=2;changed = planChanged = true; }
      else if(state.planVersion!==2){
        // Preserve elapsed and ongoing activities; only revise the remaining
        // day, so upgrading a routine never rewrites where she already was.
        const previous=state.days[day],ongoing=previous.find(i=>Date.parse(i.startedAt)<=+now&&+now<Date.parse(i.endsAt));
        const cut=ongoing?Date.parse(ongoing.endsAt):+now,fresh=dailyPlan(day,inputs,this.random);
        state.days[day]=[...previous.filter(i=>Date.parse(i.startedAt)<cut),...fresh.filter(i=>Date.parse(i.endsAt)>cut).map(i=>({...i,startedAt:new Date(Math.max(Date.parse(i.startedAt),cut)).toISOString()}))];
        state.planVersion=2;changed=planChanged=true;
      }
      for (const key of Object.keys(state.days)) if (key !== day && Math.abs(+now - Date.parse(`${key}T00:00:00+08:00`)) > 3 * 24 * HOUR) delete state.days[key];
      const plan = state.days[day];
      let current = plan.find(item => Date.parse(item.startedAt) <= +now && +now < Date.parse(item.endsAt));
      const previousSleep = Object.entries(state.days).filter(([key]) => key < day).sort(([a], [b]) => b.localeCompare(a))[0]?.[1]
        ?.find(item => item.id.endsWith(':sleep-early') && Date.parse(item.startedAt) <= +now && +now < Date.parse(item.endsAt));
      if (previousSleep) current = previousSleep;
      if (!current) current = plan.find(item => Date.parse(item.startedAt) > +now) ?? plan.at(-1);
      let next = plan.find(item => Date.parse(item.startedAt) >= Date.parse(current.endsAt)) ?? null;
      if (!next && current.id.endsWith(':sleep-early')) {
        const waking = plan.find(item => item.kind === 'waking');
        next = { ...waking, id: `${day}:next-wake`, startedAt: new Date(Date.parse(waking.startedAt) + 24 * HOUR).toISOString(), endsAt: new Date(Date.parse(waking.endsAt) + 24 * HOUR).toISOString() };
      }
      const travel = activeTravel(inputs, now);
      if (travel) current = travelActivity(current, travel);
      const scheduled = agendaActivities(inputs, now).sort((a, b) => Date.parse(b.startedAt ?? b.dueAt ?? 0) - Date.parse(a.startedAt ?? a.dueAt ?? 0))[0];
      if (scheduled) {
        const interrupted = current;
        const start = scheduled.startedAt ?? scheduled.dueAt ?? now.toISOString();
        const end = scheduled.endAt ?? scheduled.endsAt ?? new Date(Date.parse(start) + HOUR).toISOString();
        const location = scheduled.location ?? scheduled.metadata?.location ?? current.location;
        current = { id: `agenda:${scheduled.id}`, kind: scheduled.kind ?? 'agenda', title: scheduled.title, location, startedAt: start, endsAt: end, sceneId: sceneFor(scheduled.kind, location), agendaId: scheduled.id };
        next = Date.parse(interrupted.endsAt) > Date.parse(end)
          ? { ...interrupted, id: `${interrupted.id}:resume`, startedAt: end }
          : plan.find(item => Date.parse(item.startedAt) >= Date.parse(current.endsAt)) ?? null;
      }
      const nextTravel = next ? activeTravel(inputs, new Date(next.startedAt)) : null;
      if (next && nextTravel) next = travelActivity(next, nextTravel);
      const dailyLife = this.dailyLife?.advance({current,travel:Boolean(travel),scheduled:Boolean(scheduled)||this.pursuits?.get('miyue')?.session?.status==='active',enabled:state.settings.enabled,traits:inputs.tuning?.values}) ?? null;
      if (dailyLife && this.prepareDailyLife) inputs.inner = this.prepareDailyLife(dailyLife) ?? inputs.inner;
      const dailyChanges=(dailyLife?.events||[]).filter(event=>state.dailyLifePhases?.[event.id]!==event.phase);
      state.dailyLifePhases=Object.fromEntries((dailyLife?.events||[]).map(event=>[event.id,event.phase]));
      if(dailyLife && state.dailyLifeRevision !== dailyLife.revision){state.dailyLifeRevision=dailyLife.revision;changed=true;}
      const foreground = dailyLife?.events.find(event=>event.foreground);
      if(foreground){
        const routine=current;
        current={...current,id:`daily:${foreground.id}`,title:foreground.title,location:foreground.location||current.location,startedAt:foreground.startedAt,endsAt:foreground.endsAt,share:false};
        if(Date.parse(routine.endsAt)>Date.parse(current.endsAt))next={...routine,id:`${routine.id}:resume`,startedAt:current.endsAt};
      }
      const pursuit = this.pursuits?.prepareSession({current, travel:Boolean(travel), scheduled:Boolean(scheduled)||Boolean(foreground), enabled:state.settings.enabled}) ?? null;
      if (pursuit?.session?.status === 'active' && !travel && !scheduled && !foreground) {
        const routine = current, session = pursuit.session;
        current = {...routine, id:`pursuit:${pursuit.id}:${session.startedAt}`, kind:'reading', title:`${pursuit.title} · ${pursuit.stage.label}`, startedAt:session.startedAt, endsAt:session.endsAt, sceneId:sceneFor('reading'), share:false, pursuitId:pursuit.id};
        if (Date.parse(routine.endsAt)>Date.parse(session.endsAt)) next={...routine,id:`${routine.id}:resume`,startedAt:session.endsAt};
      }
      const semantic = JSON.stringify([current.id, current.kind, current.title, current.location, current.startedAt, current.endsAt, next?.id]);
      const firstBoot = !state.currentSemantic;
      if (semantic !== state.currentSemantic) {
        if (!firstBoot) state.transitions.push({ from: state.currentKey, fromTitle: state.currentRecord?.title ?? null, to: current.id, toTitle: current.title, title: current.title, location: current.location, at: now.toISOString() });
        state.transitions = state.transitions.slice(-MAX_TRANSITIONS);
        state.currentKey = current.id; state.currentSemantic = semantic; state.currentRecord = publicActivity(current); changed = true;
        state.pending = null;
        if (!firstBoot && !longAbsence && state.settings.enabled && current.share && current.kind !== 'sleep') {
          const occurrence = `runtime:${current.id}:${current.startedAt}`;
          if (!state.delivered[occurrence]) {
            const expiresAt = new Date(Math.min(Date.parse(current.endsAt), +now + 2 * HOUR)).toISOString();
            if (Date.parse(expiresAt) > +now) state.pending = {
              key: occurrence, version: 1, type: 'activity-transition', title: current.title, kind: current.kind,
              currentId: current.id, createdAt: now.toISOString(), expiresAt,
              context: { activity: current.title, kind: current.kind, location: current.location, startedAt: current.startedAt, endsAt: current.endsAt,
                seed: sharingSeed(current.kind) },
            };
          }
        }
      }
      if (state.pending && (Date.parse(state.pending.expiresAt) <= +now || state.pending.type==='activity-transition' && state.pending.key !== `runtime:${current.id}:${current.startedAt}`)) { state.pending = null; changed = true; }
      if(state.pending?.type==='daily-life-transition' && !(dailyLife?.events||[]).some(event=>state.pending.key===`daily-life:${event.id}:${event.phase}`)){state.pending=null;changed=true;}
      const dailyChange=dailyChanges.findLast(event=>event.phase!=='paused');
      if(dailyChange&&!firstBoot&&!longAbsence&&state.settings.enabled&&current.kind!=='sleep'){
        const key=`daily-life:${dailyChange.id}:${dailyChange.phase}`;
        if(!state.delivered[key]){
          state.pending={key,version:1,type:'daily-life-transition',kind:'daily-life',title:dailyChange.title,createdAt:now.toISOString(),expiresAt:new Date(Math.min(+now+2*HOUR,Date.parse(dailyChange.expiresAt))).toISOString(),context:{activity:dailyChange.title,location:dailyChange.location,seed:'最近的生活有一点变化，可以分享自己的感受，也可以聊其他近况，不必逐项播报。'}};
          changed=true;
        }
      }
      if (planChanged || changed) { state.revision += 1; state.updatedAt = now.toISOString(); }
      state.lastAdvancedAt = now.toISOString(); this.#save(state);
      return this.#view(state, inputs, now, current, next, plan, dailyLife);
    });
  }

  #view(state, inputs, now, current, next, plan, dailyLife) {
    const life = inputs.life?.active?.type === 'travel' ? inputs.life : { ...(inputs.life ?? {}), active: null };
    const base = buildCompanionWorld({ now, life, inner: inputs.inner, character: inputs.character, tuning: inputs.tuning });
    const transitionTimes = [current.endsAt, base.nextTransitionAt].filter(value => Number.isFinite(Date.parse(value)) && Date.parse(value) > +now);
    const world = { ...base, location: current.location, activity: current.title, nextTransitionAt: transitionTimes.sort((a, b) => Date.parse(a) - Date.parse(b))[0] || null };
    const availability = { sleeping: current.kind === 'sleep', busy: ['work', 'agenda', 'travel'].includes(current.kind), available: !['sleep', 'work', 'agenda', 'travel'].includes(current.kind) };
    return { schemaVersion: 1, at: now.toISOString(), revision: state.revision, settings: clone(state.settings), world,
      current: publicActivity(current), next: publicActivity(next), dayPlan: plan.map(publicActivity), transitions: clone(state.transitions),
      recentTransitions: clone(state.transitions), pending: state.pending ? clone(state.pending) : null, availability, dailyLife, pursuit:this.pursuits?.get('miyue')??null,
      events:[...(dailyLife?.events||[]).map(event=>({type:'phased',...event})),...innerEventViews(inputs.inner,now)] };
  }

  advance() {
    try {
      const view = this.#advance(); this.lastTickAt = view.at; this.lastError = null;
      if (typeof this.onAdvance === 'function') { try { this.onAdvance(clone(view)); } catch (error) { this.lastError = clean(error?.message, String(error)); } }
      return view;
    } catch (error) { this.lastTickAt = this.#now().toISOString(); this.lastError = clean(error?.message, String(error)); throw error; }
  }
  snapshot() { return this.advance(); }
  prepare({ trigger = 'user', text = '' } = {}) {
    if (!['user', 'proactive', 'user_message', 'desktop_invitation', 'scheduled_opportunity'].includes(trigger)) throw Object.assign(new Error('trigger must be user or proactive'), { status: 400, code: 'INVALID_RUNTIME_TRIGGER' });
    const view = this.advance();
    return { ...view, trigger, text: String(text ?? '') };
  }
  pending() { return this.advance().pending; }
  configuration() {
    const state = this.#load(this.#now());
    return { revision: state.revision, settings: clone(state.settings) };
  }

  markDelivered(key, messageId) {
    if (!clean(key) || !clean(messageId)) return false;
    const now = this.#now();
    return this.store.transaction(() => {
      const state = this.#load(now);
      if (state.delivered[key]?.messageId === messageId) return true;
      if (!state.pending || state.pending.key !== key || Date.parse(state.pending.expiresAt) <= +now) return false;
      const row = this.store.db.prepare('SELECT id,role,speaker FROM messages WHERE id=?').get(messageId);
      if (!row || row.role !== 'miyue' || row.speaker !== 'assistant') return false;
      state.delivered[key] = { messageId, deliveredAt: now.toISOString() }; state.pending = null;
      state.revision += 1; state.updatedAt = now.toISOString(); this.#save(state); return true;
    });
  }

  updateSettings({ revision, settings } = {}) {
    const now = this.#now();
    this.store.transaction(() => {
      const state = this.#load(now);
      if (revision !== state.revision) throw Object.assign(new Error('runtime revision is stale'), { status: 409, code: 'STALE_COMPANION_RUNTIME' });
      if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw Object.assign(new Error('settings must be an object'), { status: 400, code: 'INVALID_RUNTIME_SETTINGS' });
      const validators={enabled:v=>typeof v==='boolean',automaticScenes:v=>typeof v==='boolean',imageRotationMinutes:v=>Number.isInteger(v)&&v>=0&&v<=1440,imageSeason:v=>['auto','spring','summer','autumn','winter'].includes(v),imageEnvironment:v=>['auto','indoor','outdoor'].includes(v),imageVariant:v=>['cutout','original'].includes(v)};
      if (Object.entries(settings).some(([key,value]) => !validators[key]||!validators[key](value))) throw Object.assign(new Error('invalid runtime settings'), { status: 400, code: 'INVALID_RUNTIME_SETTINGS' });
      const next = { ...state.settings, ...settings };
      if (JSON.stringify(next) !== JSON.stringify(state.settings)) { state.settings = next; if (!next.enabled) state.pending = null; state.revision += 1; state.updatedAt = now.toISOString(); this.#save(state); }
      return null;
    });
    return this.advance();
  }

  start() {
    if (this.timer) return this;
    try { this.advance(); } catch {}
    this.timer = setInterval(() => { try { this.advance(); } catch {} }, this.intervalMs);
    this.timer.unref?.(); return this;
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; return this; }
  status() { return { running: Boolean(this.timer), lastTickAt: this.lastTickAt, lastError: this.lastError }; }
}
