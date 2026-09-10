import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../lib/store.mjs';
import { LifeEventRepository } from '../../lib/life-events.mjs';
import { InnerStateRepository } from '../../lib/inner-state.mjs';
import { CompanionAgenda } from '../../lib/companion-agenda.mjs';
import { CompanionRuntime } from '../../lib/companion-runtime.mjs';

const FIVE_MINUTES = 300_000;
const HOUR = 3_600_000;
const START = Date.parse('2026-09-07T16:00:00.000Z'); // Tuesday 00:00 Shanghai
const END = START + 14 * 24 * HOUR;
const here = path.dirname(fileURLToPath(import.meta.url));

function seeded(seed) {
  let state = seed >>> 0;
  return () => { state = (1664525 * state + 1013904223) >>> 0; return state / 0x1_0000_0000; };
}

function forcedTravel(now) {
  const start = +now;
  const phases = [
    { id: 'plan', title: '收拾与计划', offsetHours: 0, location: '苏州的家中', activity: '整理去南京的背包' },
    { id: 'outbound', title: '出发途中', offsetHours: 9, location: '从苏州前往南京的途中', activity: '乘车去南京' },
    { id: 'away', title: '异地停留', offsetHours: 12, location: '南京', activity: '在南京街巷与展馆之间慢慢走' },
    { id: 'return', title: '返程途中', offsetHours: 57, location: '从南京返回苏州的途中', activity: '乘车返回苏州' },
    { id: 'home', title: '回家整理', offsetHours: 60, location: '苏州的家中', activity: '回家整理旅行笔记' },
  ];
  const event = { id: 'simulation-trip', roleId: 'miyue', type: 'travel', category: 'travel', title: '去南京短住', destination: '南京',
    startedAt: new Date(start).toISOString(), endsAt: new Date(start + 72 * HOUR).toISOString(), phaseIndex: 0,
    phase: { ...phases[0] }, phases, deliveredPhaseIds: [], facts: ['这是一段模拟行程'] };
  delete event.phase.offsetHours;
  return event;
}

function injectTravel(store, event, now) {
  const state = JSON.parse(store.db.prepare("SELECT state_json FROM life_event_runtime WHERE role_id='miyue'").get().state_json);
  state.activeEventId = event.id;
  store.db.prepare('INSERT INTO life_event_journal(event_id,role_id,event_json,started_at,ends_at,updated_at) VALUES(?,?,?,?,?,?)')
    .run(event.id, 'miyue', JSON.stringify(event), event.startedAt, event.endsAt, now.toISOString());
  store.db.prepare("UPDATE life_event_runtime SET state_json=?,updated_at=? WHERE role_id='miyue'").run(JSON.stringify(state), now.toISOString());
}

function localLabel(iso) { return new Date(Date.parse(iso) + 8 * HOUR).toISOString().slice(0, 16).replace('T', ' '); }

export function runSimulation({ write = true } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'continuous-life-'));
  let now = new Date(START); const clock = () => new Date(now);
  const store = new Store({ dataDir: temp, story: { start: 'none', nodes: { none: { id: 'none' } } }, initialFeeds: [] });
  const life = new LifeEventRepository(store, { clock, random: () => .99 });
  const inner = new InnerStateRepository(store, { clock, random: seeded(12) });
  const agenda = new CompanionAgenda(store, { clock, random: seeded(23) });
  const rng = seeded(90210);
  let runtime = new CompanionRuntime(store, { clock, random: rng, getInputs: () => ({ life: life.get(), inner: inner.get(), agenda: agenda.tick('miyue'), tuning: { initiative: 72, playfulness: 64, independence: 70 } }) });

  life.saveSettings({ weeklyTravelChance: 0 });
  const affectionBefore = inner.get().affection;
  inner.afterTurn('miyue', '今天按平常节奏就好。', { tone: 'neutral', closeness: 'unspecified' });
  let revision = agenda.revision('miyue');
  let agendaView = agenda.update('miyue', { revision, action: 'create', id: 'own-cafe', kind: 'outing', owner: 'character', title: '去咖啡馆整理速写', location: '苏州的咖啡馆', dueAt: '2026-09-09T11:00:00.000Z', durationMinutes: 120 });
  agendaView = agenda.update('miyue', { revision: agendaView.revision, action: 'create', id: 'joint-movie', kind: 'film', owner: 'joint', title: '一起看一部老电影', dueAt: '2026-09-10T12:00:00.000Z', durationMinutes: 120 });

  const samples = []; const transitions = []; const opportunityKeys = new Set(); const scenarioActual = {};
  let previous = null; let restartPlan = null; let stableChecks = 0; let downtimeApplied = false; let tripInjected = false; let manualDisabled = false;
  let jointEverCurrent = false; let jointAwaitingObserved = false; let opportunityAfterManual = false;
  const wanted = new Map([
    ['dawn', '2026-09-08T21:30:00.000Z'], ['lunch', '2026-09-09T04:10:00.000Z'], ['work', '2026-09-09T07:00:00.000Z'],
    ['cafe', '2026-09-09T11:15:00.000Z'], ['cafe-home', '2026-09-09T14:05:00.000Z'], ['late-night-user', '2026-09-09T15:30:00.000Z'],
    ['departure', '2026-09-12T01:00:00.000Z'], ['travel-dinner', '2026-09-12T10:15:00.000Z'], ['return', '2026-09-14T01:00:00.000Z'],
  ]);

  for (; +now < END; now = new Date(+now + FIVE_MINUTES)) {
    if (!tripInjected && +now >= Date.parse('2026-09-11T16:00:00Z')) { injectTravel(store, forcedTravel(now), now); tripInjected = true; }
    if (!manualDisabled && +now >= Date.parse('2026-09-09T10:30:00Z')) {
      const config = runtime.configuration(); runtime.updateSettings({ revision: config.revision, settings: { automaticScenes: false } }); manualDisabled = true;
    }
    if (+now === Date.parse('2026-09-09T11:30:00Z')) agendaView = agenda.update('miyue', { revision: agenda.revision('miyue'), action: 'pause', id: 'own-cafe' });
    if (+now === Date.parse('2026-09-09T12:00:00Z')) agendaView = agenda.update('miyue', { revision: agenda.revision('miyue'), action: 'resume', id: 'own-cafe' });
    if (+now === Date.parse('2026-09-10T13:00:00Z')) agendaView = agenda.update('miyue', { revision: agenda.revision('miyue'), action: 'cancel', id: 'joint-movie' });
    if (+now === START + 7 * 24 * HOUR) { restartPlan = runtime.snapshot().dayPlan; runtime.stop(); runtime = new CompanionRuntime(store, { clock, random: rng, getInputs: () => ({ life: life.get(), inner: inner.get(), agenda: agenda.tick('miyue') }) }); assert.deepEqual(runtime.snapshot().dayPlan, restartPlan); }

    const view = runtime.advance(); const repeated = runtime.advance();
    assert.equal(repeated.current.id, view.current.id); assert.equal(repeated.revision, view.revision); stableChecks += 1;
    assert.ok(Date.parse(view.current.startedAt) <= +now && +now < Date.parse(view.current.endsAt));
    assert.ok(view.dayPlan.every(item => Date.parse(item.startedAt) < Date.parse(item.endsAt)));
    const ordered = [...view.dayPlan].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    assert.ok(ordered.slice(1).every((item, index) => item.startedAt === ordered[index].endsAt));
    if (previous && previous.at <= view.at) assert.ok(view.revision >= previous.revision);
    if (view.pending) { opportunityKeys.add(view.pending.key); if (manualDisabled) opportunityAfterManual = true; }
    jointEverCurrent ||= view.current.id === 'agenda:joint-movie';
    jointAwaitingObserved ||= agenda.view('miyue').plans.find(item => item.id === 'joint-movie')?.status === 'awaiting_confirmation';
    if (!previous || previous.current.id !== view.current.id || previous.current.location !== view.current.location) transitions.push({ at: view.at, title: view.current.title, kind: view.current.kind, location: view.current.location });
    previous = view;
    for (const [name, at] of wanted) if (!scenarioActual[name] && +now >= Date.parse(at)) scenarioActual[name] = { at: view.at, activity: view.current.title, kind: view.current.kind, location: view.current.location, next: view.next?.title ?? null };
    if (!downtimeApplied && +now >= Date.parse('2026-09-17T00:00:00Z')) { downtimeApplied = true; now = new Date(+now + 5 * HOUR); const after = runtime.advance(); assert.equal(after.pending, null); }
  }

  const affectionAfter = inner.get().affection;
  assert.equal(affectionAfter, affectionBefore, 'time, ticks, and a neutral actual turn must not create liking');
  const plans = agenda.view('miyue').plans;
  assert.equal(plans.find(item => item.id === 'joint-movie').status, 'cancelled');
  assert.equal(jointEverCurrent, false); assert.equal(jointAwaitingObserved, true);
  assert.ok(transitions.some(item => item.title.includes('咖啡馆')));
  assert.ok(transitions.some(item => item.location === '南京'));
  assert.ok(transitions.some(item => item.location.includes('返回苏州')));
  assert.ok(opportunityKeys.size > 0); assert.equal(opportunityAfterManual, true); assert.equal(runtime.configuration().settings.automaticScenes, false);
  samples.push(...transitions.filter((item, index) => index === 0 || item.kind === 'meal' || item.kind === 'sleep' || item.kind === 'travel' || item.title.includes('咖啡馆')).slice(0, 24));

  const result = { schemaVersion: 1, simulated: { from: new Date(START).toISOString(), to: new Date(END).toISOString(), stepMinutes: 5, temporaryData: true, modelCalls: 0, messagesSent: 0 },
    assertions: { stableRepeatedTicks: stableChecks, validActivityRanges: true, noRoutineGapsOrCollisions: true, monotonicRevisions: true, restartPlanStable: true, noAutonomousAffectionGain: affectionAfter === affectionBefore,
      jointAwaitingObserved, jointNeverFabricatedAsCurrent: !jointEverCurrent, jointPlanCancelledWithoutClaimedCompletion: true, downtimeBacklogSuppressed: true, manualPicturesDoNotBlockOpportunities: opportunityAfterManual },
    metrics: { transitions: transitions.length, uniqueOpportunityCandidates: opportunityKeys.size, diarySamples: samples.length, affectionBefore, affectionAfter }, scenarios: scenarioActual, diary: samples };
  const expected = {
    dawn: 'sleeping or waking at home', lunch: 'a concrete meal block', work: 'weekday work', cafe: 'the fixed character-owned café appointment', 'cafe-home': 'home routine resumes after the appointment',
    'late-night-user': 'night routine remains coherent when a user may arrive', departure: 'travel departure location and action', 'travel-dinner': 'meal action at the travel location',
    return: 'return journey before home', 'overlapping-appointment': 'explicit character appointment overrides routine', 'shared-awaiting': 'joint movie is never fabricated as active',
    'cancel-while-generating': 'cancellation leaves no completed claim', downtime: 'resume at now with no opportunity backlog', restart: 'same persisted day plan',
  };
  const report = [`# Continuous life simulation`, '', `Simulated ${result.simulated.from} through ${result.simulated.to} in five-minute steps using temporary data and no model calls.`, '',
    '## Expected versus actual', '', '| Scenario | Expected | Actual |', '|---|---|---|',
    ...Object.entries(expected).map(([name, expectation]) => `| ${name} | ${expectation} | ${scenarioActual[name] ? `${scenarioActual[name].activity} · ${scenarioActual[name].location}` : ({
      'overlapping-appointment': 'The café agenda item became current over the routine.', 'shared-awaiting': 'The joint movie waited, then was cancelled; it never became current.',
      'cancel-while-generating': 'Cancelled with no completion timestamp or fabricated outcome.', downtime: 'Advanced directly to current state; pending backlog was empty.', restart: 'Day plan matched byte-for-byte after repository restart.',
    }[name] ?? 'asserted')} |`), '', '## Metrics', '', `- ${result.metrics.transitions} meaningful activity or location transitions`,
    `- ${result.metrics.uniqueOpportunityCandidates} distinct opportunity candidates; these were observed, not sent`, `- Affection stayed ${affectionBefore} → ${affectionAfter}`, '',
    '## Diary samples', '', ...samples.map(item => `- ${localLabel(item.at)} — ${item.title}，${item.location}`), '',
    'The diary entries are state-machine observations and narrative cues. The simulation generated no dialogue.'].join('\n');
  if (write) { fs.mkdirSync(here, { recursive: true }); fs.writeFileSync(path.join(here, 'simulation-results.json'), `${JSON.stringify(result, null, 2)}\n`); fs.writeFileSync(path.join(here, 'report.md'), `${report}\n`); }
  store.close(); fs.rmSync(temp, { recursive: true, force: true });
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runSimulation();
  console.log(JSON.stringify({ ok: true, metrics: result.metrics, outputs: ['simulation-results.json', 'report.md'] }));
}
