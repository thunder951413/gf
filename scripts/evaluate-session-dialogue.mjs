import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultFixture = path.join(root, 'scripts', 'fixtures', 'session-dialogue-scenarios.json');
const runtimeRoot = path.join(root, '.runtime', 'session-eval');
const variants = new Set(['session', 'legacy', 'both']);
const actionTypes = new Set(['chat', 'proactive', 'desktop']);
const integerOptions = new Set(['--max-calls', '--max-tokens', '--max-request-bytes', '--max-wire-bytes']);

export const DEFAULT_LIMITS = Object.freeze({
  maxCalls: 150,
  maxTokens: 10_000_000,
  maxRequestBytes: 350_000,
  maxWireBytes: 20_000_000,
});

const keyFor = name => ({
  '--max-calls': 'maxCalls',
  '--max-tokens': 'maxTokens',
  '--max-request-bytes': 'maxRequestBytes',
  '--max-wire-bytes': 'maxWireBytes',
})[name];

export function parseArgs(argv) {
  const options = { live: false, variant: 'both', scenario: null, model: null, label: null, help: false, limits: { ...DEFAULT_LIMITS } };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--live') options.live = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (['--variant', '--scenario', '--model', '--label'].includes(arg)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      options[arg.slice(2)] = value;
    } else if (integerOptions.has(arg)) {
      const value = Number(argv[++index]);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${arg} must be a positive integer`);
      options.limits[keyFor(arg)] = value;
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (!variants.has(options.variant)) throw new Error('--variant must be session, legacy, or both');
  if (options.label && !/^[a-z0-9][a-z0-9-]{0,39}$/u.test(options.label)) throw new Error('--label must be 1-40 lowercase letters, digits, or hyphens');
  if (options.live && !options.label) throw new Error('--live requires a unique --label');
  return options;
}

const nonEmptyStrings = (value, field) => {
  if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== 'string' || !item.trim())) throw new Error(`${field} must be a non-empty string array`);
};

export function validateSuite(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('scenario fixture must be an object');
  if (typeof value.suiteVersion !== 'string' || !value.suiteVersion.trim()) throw new Error('suiteVersion is required');
  if (!Array.isArray(value.scenarios) || value.scenarios.length < 8 || value.scenarios.length > 10) throw new Error('the suite must contain 8-10 scenarios');
  const ids = new Set();
  for (const scenario of value.scenarios) {
    if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) throw new Error('each scenario must be an object');
    if (!/^[a-z0-9][a-z0-9-]{1,63}$/u.test(scenario.id || '') || ids.has(scenario.id)) throw new Error(`invalid or duplicate scenario id: ${scenario.id || '<missing>'}`);
    ids.add(scenario.id);
    if (typeof scenario.title !== 'string' || !scenario.title.trim()) throw new Error(`${scenario.id}: title is required`);
    if (!Number.isFinite(Date.parse(scenario.startAt))) throw new Error(`${scenario.id}: startAt must be ISO-compatible`);
    nonEmptyStrings(scenario.reviewFocus, `${scenario.id}.reviewFocus`);
    if (!scenario.seed || !Array.isArray(scenario.seed.history) || !Array.isArray(scenario.seed.memories)) throw new Error(`${scenario.id}: seed history and memories are required arrays`);
    const seedIds = new Set();
    for (const row of scenario.seed.history) {
      if (!row?.id || seedIds.has(row.id) || !['user', 'assistant'].includes(row.speaker) || typeof row.text !== 'string' || !row.text.trim() || !Number.isFinite(Date.parse(row.createdAt))) throw new Error(`${scenario.id}: invalid seed history`);
      seedIds.add(row.id);
    }
    for (const row of scenario.seed.memories) {
      if (!row?.id || seedIds.has(row.id) || typeof row.scope !== 'string' || typeof row.text !== 'string' || !row.text.trim() || !Number.isFinite(Date.parse(row.createdAt))) throw new Error(`${scenario.id}: invalid seed memory`);
      seedIds.add(row.id);
    }
    if (!Array.isArray(scenario.actions) || !scenario.actions.length) throw new Error(`${scenario.id}: actions are required`);
    for (const [index, action] of scenario.actions.entries()) {
      if (!action || !actionTypes.has(action.type)) throw new Error(`${scenario.id}: invalid action ${index + 1}`);
      if (action.advanceMinutes !== undefined && (!Number.isSafeInteger(action.advanceMinutes) || action.advanceMinutes < 0 || action.advanceMinutes > 14 * 24 * 60)) throw new Error(`${scenario.id}: invalid advanceMinutes at action ${index + 1}`);
      if (action.type === 'chat' && (typeof action.text !== 'string' || !action.text.trim())) throw new Error(`${scenario.id}: chat action ${index + 1} needs text`);
      if (action.type === 'desktop' && !['care', 'affection'].includes(action.level)) throw new Error(`${scenario.id}: desktop action ${index + 1} needs care or affection`);
      if (action.type !== 'chat' && Object.hasOwn(action, 'text')) throw new Error(`${scenario.id}: only chat actions may contain canned user text`);
      if (action.expectReminder !== undefined && (action.type !== 'chat' || !['create', 'update', 'cancel'].includes(action.expectReminder))) throw new Error(`${scenario.id}: invalid reminder expectation at action ${index + 1}`);
    }
  }
  return value;
}

export function loadSuite(file = defaultFixture) {
  return validateSuite(JSON.parse(fs.readFileSync(file, 'utf8')));
}

const selectedVariants = value => value === 'both' ? ['session', 'legacy'] : [value];
// This is a planning estimate for the bundled scenarios. The transport budget
// remains the hard stop because repairs and bounded tool loops can vary.
const nominalCalls = action => action.type === 'chat' ? 3 : 2;

export function buildPlan(suite, options) {
  const picked = options.scenario ? suite.scenarios.filter(row => row.id === options.scenario) : suite.scenarios;
  if (!picked.length) throw new Error(`Unknown scenario: ${options.scenario}`);
  const runVariants = selectedVariants(options.variant);
  const calls = picked.reduce((sum, scenario) => sum + scenario.actions.reduce((count, action) => count + nominalCalls(action), 0), 0) * runVariants.length;
  const conservativeTokens = calls * 60_000;
  const conservativeWireBytes = calls * 100_000;
  if (options.limits.maxRequestBytes < 100_000) throw new Error(`planned request size 100000 exceeds --max-request-bytes ${options.limits.maxRequestBytes}`);
  if (calls > options.limits.maxCalls) throw new Error(`nominal call estimate ${calls} exceeds --max-calls ${options.limits.maxCalls}`);
  if (conservativeTokens > options.limits.maxTokens) throw new Error(`planned token reservation ${conservativeTokens} exceeds --max-tokens ${options.limits.maxTokens}`);
  if (conservativeWireBytes > options.limits.maxWireBytes) throw new Error(`planned request bytes ${conservativeWireBytes} exceed --max-wire-bytes ${options.limits.maxWireBytes}`);
  return { suiteVersion: suite.suiteVersion, scenarios: picked, variants: runVariants, planningEstimate: { nominalCalls: calls, conservativeTokenReservation: conservativeTokens, nominalRequestBytes: conservativeWireBytes }, limits: options.limits };
}

const writePrivateJson = (file, value) => {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
};

const writePrivateText = (file, value) => {
  fs.writeFileSync(file, value, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
};

const mkdirPrivate = directory => {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
};

// UTF-8 bytes are a deliberately conservative upper bound for the provider's
// text tokens. Reserving this before fetch keeps the configured ceiling hard
// even when a provider omits usage data from its response.
const conservativePromptTokens = payload => Buffer.byteLength(JSON.stringify(payload.messages || []), 'utf8');
const completionAllowance = payload => Number(payload.max_tokens || payload.max_completion_tokens || 4_000);

export class HardBudget {
  constructor(limits) {
    this.limits = { ...limits };
    this.calls = 0;
    this.wireBytes = 0;
    this.reservedTokens = 0;
    this.reportedInputTokens = 0;
    this.reportedOutputTokens = 0;
  }
  reserve(payload, bytes) {
    if (bytes > this.limits.maxRequestBytes) throw Object.assign(new Error(`request body ${bytes} bytes exceeds --max-request-bytes ${this.limits.maxRequestBytes}`), { code: 'SESSION_EVAL_REQUEST_BYTES' });
    const tokens = conservativePromptTokens(payload) + completionAllowance(payload);
    if (this.calls + 1 > this.limits.maxCalls) throw Object.assign(new Error('session evaluation call budget reached'), { code: 'SESSION_EVAL_CALL_BUDGET' });
    if (this.wireBytes + bytes > this.limits.maxWireBytes) throw Object.assign(new Error('session evaluation request-byte budget reached'), { code: 'SESSION_EVAL_WIRE_BUDGET' });
    if (this.reservedTokens + tokens > this.limits.maxTokens) throw Object.assign(new Error('session evaluation token budget reached'), { code: 'SESSION_EVAL_TOKEN_BUDGET' });
    this.calls += 1;
    this.wireBytes += bytes;
    this.reservedTokens += tokens;
    return { call: this.calls, bytes, reservedTokens: tokens };
  }
  observeUsage(usage = {}) {
    this.reportedInputTokens += Number(usage.prompt_tokens || usage.input_tokens || 0);
    this.reportedOutputTokens += Number(usage.completion_tokens || usage.output_tokens || 0);
  }
  snapshot() {
    return {
      calls: this.calls,
      requestBytes: this.wireBytes,
      reservedTokens: this.reservedTokens,
      reportedInputTokens: this.reportedInputTokens,
      reportedOutputTokens: this.reportedOutputTokens,
      limits: this.limits,
    };
  }
}

export function classifyModelCall(payload) {
  const text = (payload.messages || []).map(row => String(row.content || '')).join('\n');
  if (/Classify the current Chinese companion-dialogue turn\.|判断当前中文陪伴对话/u.test(text)) return 'semantic';
  if (/你整理林晓薇|MEMORY CANDIDATES/u.test(text)) return 'memory';
  if (/【(?:只读|外部)工具回执/u.test(text)) return 'tool-followup';
  if (/决定是否主动发起一次|本轮触发方式：主动联系|"type":"scheduled_opportunity"/u.test(text)) return 'proactive';
  if (/上一份草稿|唯一一次修复|上一稿/u.test(text)) return 'repair';
  return 'chat';
}

const parsedCompletion = row => {
  const body = row?.response?.body;
  const content = body?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return null;
  try { return JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/giu, '')); } catch { return null; }
};

export function modelRequestedSkip(callRows) {
  return [...(callRows || [])].reverse().some(row => parsedCompletion(row)?.skip === true);
}

export function compareReminderTransition(expected, before, after) {
  const prior = (before || []).filter(row => row.role === 'miyue' && row.status === 'pending');
  const next = (after || []).filter(row => row.role === 'miyue' && row.status === 'pending');
  const priorById = new Map(prior.map(row => [row.id, row]));
  const nextById = new Map(next.map(row => [row.id, row]));
  const created = next.filter(row => !priorById.has(row.id));
  const removed = prior.filter(row => !nextById.has(row.id));
  const updated = next.filter(row => {
    const old = priorById.get(row.id);
    return old && (old.text !== row.text || old.dueAt !== row.dueAt);
  });
  const pass = expected === 'create' ? created.length === 1 && removed.length === 0
    : expected === 'update' ? updated.length === 1 && created.length === 0 && removed.length === 0
      : expected === 'cancel' ? removed.length === 1 && created.length === 0
        : true;
  return { expected: expected || null, pass, created: created.map(row => row.id), updated: updated.map(row => row.id), removed: removed.map(row => row.id), before: prior, after: next };
}

const parseResponseBody = text => {
  try { return JSON.parse(text); } catch { return text; }
};

function providerConfig(modelOverride) {
  const file = path.join(root, 'data', 'provider.json');
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  const config = { baseUrl: value.baseUrl, model: modelOverride || value.model, ...(value.apiKey ? { apiKey: value.apiKey } : {}) };
  if (typeof config.baseUrl !== 'string' || !config.baseUrl || typeof config.model !== 'string' || !config.model) throw new Error('configured provider is incomplete');
  return config;
}

const providerMetadata = config => ({
  model: config.model,
  fingerprint: createHash('sha256').update(`${config.baseUrl}\n${config.model}`).digest('hex').slice(0, 16),
});

const seedEvidence = (app, scenario) => app.store.transaction(() => {
  const insertMessage = app.store.db.prepare('INSERT INTO messages(id,role,speaker,text,kind,created_at,reply_channel) VALUES(?,?,?,?,?,?,?)');
  for (const row of scenario.seed.history) insertMessage.run(row.id, 'miyue', row.speaker, row.text, 'chat', row.createdAt, 'desktop');
  const insertMemory = app.store.db.prepare('INSERT INTO memories(id,scope,text,created_at) VALUES(?,?,?,?)');
  for (const row of scenario.seed.memories) insertMemory.run(row.id, row.scope, row.text, row.createdAt);
});

const assistantText = body => (body?.messages || []).filter(row => row.speaker === 'assistant').map(row => row.text).join('\n');

const disabledIntegrations = Object.freeze({
  fetchFeed: async () => { throw new Error('network discovery disabled during session evaluation'); },
  fetchArticle: async () => { throw new Error('article fetch disabled during session evaluation'); },
  listSpeechVoices: async () => ({ voices: [] }),
  probeTts: async () => ({ available: false }),
  closeSpeech: async () => {},
});

async function inspectConversation(base) {
  const response = await fetch(`${base}/api/conversations/miyue`);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `conversation inspection failed (${response.status})`);
  return body.messages || [];
}

async function getJson(base, route) {
  const response = await fetch(`${base}${route}`);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `${route} failed (${response.status})`);
  return body;
}

async function postJson(base, route, body) {
  const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  return { status: response.status, value };
}

async function runVariantScenario({ scenario, variant, blindLabel, directory, config, budget }) {
  mkdirPrivate(directory);
  let now = new Date(scenario.startAt), app, wire = [], address, fatalBudgetError = null;
  const wireFile = path.join(directory, 'wire.json');
  const persistWire = () => writePrivateJson(wireFile, wire);
  const transport = async (_url, init) => {
    const rawRequest = String(init.body || '');
    const payload = JSON.parse(rawRequest);
    let reservation;
    try { reservation = budget.reserve(payload, Buffer.byteLength(rawRequest)); }
    catch (error) { fatalBudgetError = error; throw error; }
    const startedAt = new Date().toISOString(), started = performance.now();
    let response, rawResponse = '', transportError = null;
    try {
      response = await fetch(_url, init);
      rawResponse = await response.clone().text();
      const parsed = parseResponseBody(rawResponse);
      budget.observeUsage(parsed && typeof parsed === 'object' ? parsed.usage : null);
      wire.push({ ...reservation, kind: classifyModelCall(payload), startedAt, durationMs: Math.round(performance.now() - started), request: payload, response: { status: response.status, body: parsed } });
      persistWire();
      return response;
    } catch (error) {
      transportError = { name: error?.name || 'Error', code: error?.code || null, message: error?.message || 'provider request failed' };
      wire.push({ ...reservation, kind: classifyModelCall(payload), startedAt, durationMs: Math.round(performance.now() - started), request: payload, response: rawResponse ? { body: parseResponseBody(rawResponse) } : null, error: transportError });
      persistWire();
      throw error;
    }
  };
  const result = {
    scenarioId: scenario.id,
    title: scenario.title,
    blindLabel,
    reviewFocus: scenario.reviewFocus,
    review: { continuity: 'pending', factualGrounding: 'pending', naturalness: 'pending', notes: '' },
    actions: [],
  };
  const captureMechanisms = () => {
    if (!app) return { modelCalls: wire.length, callKinds: Object.fromEntries([...new Set(wire.map(row => row.kind))].map(kind => [kind, wire.filter(row => row.kind === kind).length])) };
    const traces = app.dialogueTraces.list({ roleId: 'miyue', limit: 100 });
    return {
      modelCalls: wire.length,
      callKinds: Object.fromEntries([...new Set(wire.map(row => row.kind))].map(kind => [kind, wire.filter(row => row.kind === kind).length])),
      nativeHistoryMessages: app.store.getMessages('miyue').length,
      finalHistory: app.store.getMessages('miyue'),
      finalReminders: app.store.listReminders().filter(row => row.role === 'miyue'),
      dialogueTraces: traces.length,
      dialogueTraceModes: Object.fromEntries([...new Set(traces.map(row => row.mode))].map(mode => [mode, traces.filter(row => row.mode === mode).length])),
    };
  };
  try {
    app = await createApp({
      dataDir: directory,
      initialFeeds: [],
      env: {},
      dynamicCompanion: true,
      sessionDialogue: variant === 'session',
      semanticUnderstanding: true,
      dialogueMemory: true,
      discussionTopics: true,
      sourceRelevance: false,
      materialPresentation: 'generated',
      startDiscovery: false,
      startWeixin: false,
      startChatQueue: false,
      startRuntime: false,
      startLife: false,
      startLifeThreads: false,
      startPursuits: false,
      startDossiers: false,
      startRecall: false,
      startProactive: false,
      startResearch: false,
      startReminders: false,
      replySleep: async () => {},
      clock: () => new Date(now),
      random: () => 0.42,
      lifeRandom: () => 0.42,
      integrations: disabledIntegrations,
      fetchSina: async () => ({ items: [] }),
      zhihuFetchImpl: async () => { throw new Error('Zhihu network disabled during session evaluation'); },
      desktopNotify: async () => ({ requested: false, reason: 'evaluation-disabled' }),
      fetchImpl: transport,
    });
    fs.chmodSync(path.join(directory, 'life.sqlite'), 0o600);
    app.model.save(config);
    app.preferences.setReplyPace('instant');
    app.proactiveRepo.saveSettings({ enabled: true, activeStart: '00:00', activeEnd: '23:59', dailyLimit: 4, desktopNotifications: false });
    seedEvidence(app, scenario);
    address = await app.listen(0);
    const base = `http://127.0.0.1:${address.port}`;
    const health = await getJson(base, '/api/health');
    if (Boolean(health.sessionDialogue) !== (variant === 'session')) throw new Error(`${scenario.id}: requested dialogue variant is not active`);
    result.health = health;
    for (const [index, action] of scenario.actions.entries()) {
      now = new Date(+now + Number(action.advanceMinutes || 0) * 60_000);
      const historyBefore = await inspectConversation(base);
      const remindersBefore = app.store.listReminders().filter(row => row.role === 'miyue');
      const callsBefore = wire.length, usageBefore = app.usage.snapshot().allTime.requests;
      const started = performance.now();
      let status = 200, body, reply = '';
      if (action.type === 'chat') {
        const response = await postJson(base, '/api/chat', { role: 'miyue', text: action.text });
        status = response.status; body = response.value; reply = assistantText(body);
      } else if (action.type === 'desktop') {
        const response = await postJson(base, '/api/desktop/attention', { requestId: `session-eval-${scenario.id}-${index}`.slice(0, 96), level: action.level });
        status = response.status; body = response.value; reply = assistantText(body);
      } else {
        body = await app.proactive.runNow({ roleId: 'miyue' });
        reply = body?.message?.text || '';
      }
      const historyAfter = await inspectConversation(base);
      const remindersAfter = app.store.listReminders().filter(row => row.role === 'miyue');
      const appended = historyAfter.slice(historyBefore.length);
      const callRows = wire.slice(callsBefore);
      const intentionalSkip = action.type === 'proactive' && !body?.delivered
        && (body?.code === 'model_skip' || body?.outcome === 'model_skip' || modelRequestedSkip(callRows));
      if (action.type === 'proactive' && !body?.delivered && !intentionalSkip) status = 409;
      const reminderState = action.expectReminder ? compareReminderTransition(action.expectReminder, remindersBefore, remindersAfter) : null;
      const actionResult = {
        index: index + 1,
        type: action.type,
        at: now.toISOString(),
        input: action.type === 'chat' ? action.text : action.type === 'desktop' ? { level: action.level } : null,
        status,
        outcome: intentionalSkip ? 'model_skip' : status === 200 ? 'delivered' : 'failed',
        reply,
        durationMs: Math.round(performance.now() - started),
        modelCalls: callRows.length,
        modelCallKinds: Object.fromEntries([...new Set(callRows.map(row => row.kind))].map(kind => [kind, callRows.filter(row => row.kind === kind).length])),
        usageRecords: app.usage.snapshot().recent.slice(0, Math.max(0, app.usage.snapshot().allTime.requests - usageBefore)),
        nativeHistory: { beforeCount: historyBefore.length, afterCount: historyAfter.length, appended },
        ...(reminderState ? { reminderState } : {}),
        error: status === 200 ? null : body?.error || body?.reason || 'action did not deliver',
        ...(intentionalSkip ? { skipReason: body?.reason || 'model_skip' } : {}),
      };
      result.actions.push(actionResult);
      writePrivateJson(path.join(directory, 'partial-result.json'), result);
      if (status !== 200 || (!reply && !intentionalSkip)) throw new Error(`${scenario.id} ${action.type} action ${index + 1} did not produce a reply or intentional skip`);
      if (intentionalSkip) continue;
      const storedAssistant = appended.filter(row => row.speaker === 'assistant').at(-1);
      if (!storedAssistant || storedAssistant.text !== reply) throw new Error(`${scenario.id} action ${index + 1} reply was not preserved in native history`);
    }
    result.mechanisms = captureMechanisms();
    return result;
  } catch (error) {
    result.failed = true;
    result.error = { name: error?.name || 'Error', code: error?.code || null, message: error?.message || 'scenario run failed' };
    result.mechanisms = captureMechanisms();
    writePrivateJson(path.join(directory, 'partial-result.json'), result);
    if (fatalBudgetError) {
      fatalBudgetError.partialResult = result;
      throw fatalBudgetError;
    }
    return result;
  } finally {
    if (app) await app.close();
    fs.rmSync(path.join(directory, 'provider.json'), { force: true });
    for (const file of ['life.sqlite', 'life.sqlite-wal', 'life.sqlite-shm', 'wire.json', 'partial-result.json']) {
      const full = path.join(directory, file);
      if (fs.existsSync(full)) fs.chmodSync(full, 0o600);
    }
  }
}

const shuffledVariantMap = (label, runVariants) => {
  if (runVariants.length === 1) return { A: runVariants[0] };
  return createHash('sha256').update(label).digest()[0] % 2 ? { A: 'session', B: 'legacy' } : { A: 'legacy', B: 'session' };
};

function markdownReport(report) {
  const lines = [
    '# Session dialogue paired review',
    '',
    `Suite: ${report.suiteVersion}`,
    `Model: ${report.provider.model}`,
    `Run label: ${report.label}`,
    '',
    'Variant names are intentionally kept in `variant-key.json`. All review fields below start pending; mechanism counts are observations, not naturalness scores.',
  ];
  for (const scenario of report.scenarios) {
    lines.push('', `## ${scenario.title}`, '', ...scenario.reviewFocus.map(item => `- Review focus: ${item}`));
    for (const run of scenario.runs.sort((a, b) => a.blindLabel.localeCompare(b.blindLabel))) {
      lines.push('', `### Variant ${run.blindLabel}`, '');
      if (run.failed) lines.push(`Run error: ${run.error?.code || run.error?.name || 'error'} — ${run.error?.message || 'scenario run failed'}`, '');
      for (const action of run.actions) {
        lines.push(`#### Turn ${action.index}: ${action.type}`, '');
        if (action.type === 'chat') lines.push(`User: ${action.input}`, '');
        else lines.push(`Trigger: ${action.type === 'proactive' ? 'manual proactive runNow' : `desktop ${action.input.level} invitation`}`, '');
        const companion = action.outcome === 'model_skip' ? `[model chose not to send: ${action.skipReason}]` : action.reply || `[no delivered reply: ${action.error || 'unknown'}]`;
        lines.push(`Companion: ${companion}`, '', `Mechanism: ${action.modelCalls} model call(s) (${Object.entries(action.modelCallKinds).map(([kind, count]) => `${kind}=${count}`).join(', ') || 'none'}); native history ${action.nativeHistory.beforeCount} → ${action.nativeHistory.afterCount}; ${action.durationMs} ms.`, '');
        if (action.reminderState) lines.push(`Reminder state (${action.reminderState.expected}): ${action.reminderState.pass ? 'observed' : 'not observed'}; pending ${action.reminderState.before.length} → ${action.reminderState.after.length}.`, '');
      }
      lines.push('Review slots:', '', '- Continuity: pending', '- Factual grounding and provenance: pending', '- Naturalness: pending', '- Notes:', '');
    }
  }
  lines.push('## Run budget observations', '', `Calls: ${report.budget.calls}/${report.budget.limits.maxCalls}`, `Request bytes: ${report.budget.requestBytes}/${report.budget.limits.maxWireBytes}`, `Conservative token reservation: ${report.budget.reservedTokens}/${report.budget.limits.maxTokens}`, `Provider-reported tokens: ${report.budget.reportedInputTokens + report.budget.reportedOutputTokens}`);
  return `${lines.join('\n')}\n`;
}

export async function runLive({ suite, plan, options, config }) {
  mkdirPrivate(runtimeRoot);
  const output = path.join(runtimeRoot, options.label);
  fs.mkdirSync(output, { recursive: false, mode: 0o700 });
  fs.chmodSync(output, 0o700);
  const marker = { label: options.label, startedAt: new Date().toISOString(), status: 'running' };
  writePrivateJson(path.join(output, 'attempt.json'), marker);
  const mapping = shuffledVariantMap(options.label, plan.variants);
  const budget = new HardBudget(options.limits);
  const report = {
    suiteVersion: suite.suiteVersion,
    label: options.label,
    startedAt: marker.startedAt,
    provider: providerMetadata(config),
    reviewStatus: 'pending-human-review',
    reviewPolicy: 'No regex or automated naturalness verdict is produced. Read the original turns and fill the pending review slots.',
    scenarios: [],
    budget: budget.snapshot(),
  };
  writePrivateJson(path.join(output, 'variant-key.json'), { labels: mapping });
  try {
    for (const scenario of plan.scenarios) {
      const scenarioResult = { id: scenario.id, title: scenario.title, reviewFocus: scenario.reviewFocus, runs: [] };
      report.scenarios.push(scenarioResult);
      for (const [blindLabel, variant] of Object.entries(mapping)) {
        if (!plan.variants.includes(variant)) continue;
        const directory = path.join(output, 'cases', scenario.id, blindLabel);
        try {
          const result = await runVariantScenario({ scenario, variant, blindLabel, directory, config, budget });
          scenarioResult.runs.push(result);
        } catch (error) {
          if (error?.partialResult) scenarioResult.runs.push(error.partialResult);
          report.budget = budget.snapshot();
          writePrivateJson(path.join(output, 'report.json'), report);
          throw error;
        }
        report.budget = budget.snapshot();
        writePrivateJson(path.join(output, 'report.json'), report);
      }
    }
    report.completedAt = new Date().toISOString();
    report.budget = budget.snapshot();
    report.runFailures = report.scenarios.flatMap(row => row.runs).filter(row => row.failed).length;
    marker.status = report.runFailures ? 'complete-with-run-errors' : 'complete'; marker.completedAt = report.completedAt;
    writePrivateJson(path.join(output, 'report.json'), report);
    writePrivateText(path.join(output, 'transcript.md'), markdownReport(report));
    writePrivateJson(path.join(output, 'attempt.json'), marker);
    return { output, report };
  } catch (error) {
    marker.status = 'failed'; marker.completedAt = new Date().toISOString(); marker.error = { name: error?.name || 'Error', code: error?.code || null, message: error?.message || 'evaluation failed' };
    report.failed = true; report.error = marker.error; report.completedAt = marker.completedAt; report.budget = budget.snapshot();
    writePrivateJson(path.join(output, 'attempt.json'), marker);
    writePrivateJson(path.join(output, 'report.json'), report);
    writePrivateText(path.join(output, 'transcript.md'), markdownReport(report));
    throw error;
  }
}

export const usage = `Session dialogue evaluation\n\nDry run (default; no config read and no network):\n  node scripts/evaluate-session-dialogue.mjs [--variant session|legacy|both] [--scenario id]\n\nLive run (paid, isolated, one attempt per label):\n  node scripts/evaluate-session-dialogue.mjs --live --label <unique-label> [--variant ...] [--scenario id] [--model name]\n\nBudgets:\n  --max-calls N --max-tokens N --max-request-bytes N --max-wire-bytes N`;

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { console.log(usage); return; }
  const suite = loadSuite(), plan = buildPlan(suite, options);
  if (!options.live) {
    console.log(JSON.stringify({ mode: 'dry-run', networkCalls: 0, providerConfigRead: false, suiteVersion: plan.suiteVersion, scenarios: plan.scenarios.map(row => row.id), variants: plan.variants, planningEstimate: plan.planningEstimate, limits: plan.limits }, null, 2));
    return;
  }
  const config = providerConfig(options.model);
  const result = await runLive({ suite, plan, options, config });
  console.log(JSON.stringify({ status: result.report.runFailures ? 'complete-with-run-errors' : 'complete', output: result.output, scenarios: result.report.scenarios.length, runFailures: result.report.runFailures, budget: result.report.budget }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error?.message || error); process.exitCode = 1; });
}
