import {resolveNeeds} from './companion-needs.mjs';
const TIMEZONE = 'Asia/Shanghai';
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const HOME = '苏州的家中';

const BODY_FIELDS = Object.freeze([
  'fatigue', 'hunger', 'vitality', 'stress', 'security',
  'affectionNeed', 'desire', 'playfulness', 'affection', 'mood',
]);

const TUNING_FIELDS = Object.freeze([
  'pleasing', 'warmth', 'sensitivity', 'optimism', 'playfulness',
  'coyness', 'flirtation', 'initiative', 'verbosity', 'independence',
]);

const ROUTINE = Object.freeze([
  { start: 0, end: 7, activity: '夜间休息' },
  { start: 7, end: 9, activity: '早餐与上午准备' },
  { start: 9, end: 12, activity: '处理日常工作' },
  { start: 12, end: 14, activity: '吃午饭并休息' },
  { start: 14, end: 18, activity: '处理日常工作' },
  { start: 18, end: 20, activity: '晚饭与晚间整理' },
  { start: 20, end: 23, activity: '自由活动' },
  { start: 23, end: 24, activity: '夜间休息' },
]);

function asDate(value) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError('now must be a valid date');
  return date;
}

function text(value, fallback = '', limit = 160) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, limit) : fallback;
}

function boundedNumber(value, fallback = 0) {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : fallback;
}

function timestamp(value) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function earliestFuture(now, values) {
  const future = values
    .map(timestamp)
    .filter((date) => date && date.getTime() > now.getTime())
    .sort((left, right) => left - right);
  return future[0]?.toISOString() || null;
}

function shanghaiHour(now) {
  return new Date(now.getTime() + SHANGHAI_OFFSET_MS).getUTCHours();
}

function nextRoutineBoundary(now) {
  const local = new Date(now.getTime() + SHANGHAI_OFFSET_MS);
  const hour = local.getUTCHours();
  const routine = ROUTINE.find((entry) => hour >= entry.start && hour < entry.end);
  const sleepingAcrossMidnight = hour >= 23;
  const boundaryHour = sleepingAcrossMidnight ? 7 : routine.end;
  const localBoundary = Date.UTC(
    local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + (sleepingAcrossMidnight ? 1 : 0),
    boundaryHour, 0, 0, 0,
  );
  return new Date(localBoundary - SHANGHAI_OFFSET_MS).toISOString();
}

function routineAt(now) {
  const hour = shanghaiHour(now);
  return ROUTINE.find((entry) => hour >= entry.start && hour < entry.end);
}

function scheduledPhases(event, startedAt) {
  if (!Array.isArray(event.phases)) return [];
  return event.phases
    .map((phase, index) => {
      const offsetHours = Number(phase?.offsetHours);
      if (!phase || typeof phase !== 'object' || !Number.isFinite(offsetHours) || offsetHours < 0) return null;
      return { phase, index, at: startedAt.getTime() + offsetHours * HOUR_MS };
    })
    .filter(Boolean)
    .sort((left, right) => left.at - right.at || left.index - right.index);
}

function activeEventAt(life, now) {
  const source = life?.active;
  if (!source || typeof source !== 'object') return null;
  const startedAt = timestamp(source.startedAt);
  const endsAt = timestamp(source.endsAt);
  if (!startedAt || !endsAt || startedAt > now || now >= endsAt) return null;

  const schedule = scheduledPhases(source, startedAt);
  const reachedByTime = schedule.findLastIndex((entry) => entry.at <= now.getTime());
  const storedIndex = Number.isInteger(source.phaseIndex)
    ? schedule.findIndex((entry) => entry.index === source.phaseIndex)
    : schedule.findIndex((entry) => entry.phase?.id === source.phase?.id);
  const currentIndex = Math.max(0, reachedByTime, storedIndex);
  const current = schedule[currentIndex];
  const phase = current?.phase || source.phase;
  if (!phase || typeof phase !== 'object') return null;

  const nextTransitionAt = earliestFuture(now, [
    ...schedule.slice(currentIndex + 1).map((entry) => entry.at),
    endsAt,
  ]);

  return {
    location: text(phase.location, '地点未记录'),
    activity: text(phase.activity, '进行当前事件'),
    event: {
      id: text(source.id, 'unknown-event', 120),
      type: text(source.type, 'ordinary', 40),
      title: text(source.title, '当前事件'),
      phase: {
        id: text(phase.id, 'current', 80),
        title: text(phase.title, '当前阶段'),
      },
      startedAt: startedAt.toISOString(),
      endsAt: endsAt.toISOString(),
      nextTransitionAt,
    },
    nextTransitionAt,
  };
}

function bodyFrom(inner) {
  return Object.fromEntries(BODY_FIELDS.map((field) => [field, boundedNumber(inner?.[field], field === 'affection' ? 55 : field === 'mood' ? 65 : 0)]));
}

function traitsFrom(tuning) {
  const source = tuning?.values && typeof tuning.values === 'object' ? tuning.values : tuning;
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};
  return Object.fromEntries(TUNING_FIELDS
    .filter((field) => Number.isFinite(source[field]))
    .map((field) => [field, boundedNumber(source[field])]));
}

function relationshipFrom(inner, character) {
  const interactions = inner?.interactions ?? character?.interactions;
  return {
    stage: text(inner?.relationshipStage ?? character?.relationshipStage, ''),
    interactions: Number.isFinite(interactions) ? Math.max(0, Math.floor(interactions)) : 0,
    intimacyBoundary: text(inner?.intimacyBoundary, ''),
  };
}

function feelingsFrom(inner, character) {
  return {
    feeling: text(inner?.feeling ?? character?.feeling, ''),
    wish: text(inner?.wish ?? character?.wish, ''),
  };
}

export function buildCompanionWorld({ now, life = {}, inner = {}, character = {}, tuning = {} }) {
  const at = asDate(now);
  const active = activeEventAt(life, at);
  const routine = routineAt(at);
  const routineTransitionAt = nextRoutineBoundary(at);
  const ownTransitionAt = active?.nextTransitionAt || routineTransitionAt;
  const nextTransitionAt = earliestFuture(at, [ownTransitionAt, life?.nextCheckAt]);

  return {
    schemaVersion: 1,
    at: at.toISOString(),
    timezone: TIMEZONE,
    person: {
      id: 'miyue', name: '林雨薇', age: 27, home: '江苏苏州',
    },
    location: active?.location || HOME,
    activity: active?.activity || routine.activity,
    event: active?.event || null,
    nextTransitionAt,
    body: bodyFrom(inner),
    needs: resolveNeeds(inner),
    traits: traitsFrom(tuning),
    relationship: relationshipFrom(inner, character),
    feelings: feelingsFrom(inner, character),
  };
}
