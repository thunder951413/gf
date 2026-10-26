import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Affect, validAppraisal } from '../lib/affect.mjs';
import { RelationshipLedger } from '../lib/relationship-ledger.mjs';
import { prepareSessionGuidance } from '../lib/session-guidance.mjs';
import { buildSessionMessages } from '../lib/session-dialogue.mjs';

function memoryStore() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE messages(id TEXT PRIMARY KEY,role TEXT NOT NULL,speaker TEXT NOT NULL,text TEXT NOT NULL,kind TEXT NOT NULL DEFAULT 'chat',content_id TEXT,created_at TEXT NOT NULL);
    CREATE TABLE proactive_material_deliveries(message_id TEXT PRIMARY KEY,role_id TEXT,material_id TEXT,kind TEXT,quote TEXT,material_json TEXT,created_at TEXT)`);
  return { db, transaction(fn) { db.exec('BEGIN IMMEDIATE'); try { const out = fn(); db.exec('COMMIT'); return out; } catch (error) { db.exec('ROLLBACK'); throw error; } } };
}
const H = 3600000, NOW = new Date('2026-10-26T12:30:00Z'); // 20:30 Shanghai
const fakeModel = answer => ({ calls: [], publicConfig: () => ({ configured: true }), complete: async function (messages, options) { this.calls.push({ messages, options }); return JSON.stringify(answer); } });

test('appraisals move her feelings, and how fast hurt fades follows 消气速度', () => {
  assert.equal(validAppraisal({ towardHer: 'sneering' }).towardHer, 'neutral');
  assert.equal(validAppraisal(null), null);
  const run = recovery => {
    const store = memoryStore(); let now = NOW;
    const affect = new Affect(store, { clock: () => now, tuning: () => ({ recovery, sensitivity: 60, temper: 40 }) });
    affect.observe('miyue', { towardHer: 'dismissive', need: 'none', intimacy: 'none', moment: 0, why: '他连着回了三个嗯' });
    const hurt = affect.current('miyue').hurt;
    now = new Date(+NOW + 4 * H);
    return { hurt, later: affect.current('miyue').hurt, context: affect.context('miyue', { now: NOW }) };
  };
  const quick = run(10), slow = run(90);
  assert.ok(quick.hurt > 10); assert.equal(Math.round(quick.hurt), Math.round(slow.hurt));
  assert.ok(quick.later < slow.later / 2, `quick ${quick.later} vs slow ${slow.later}`);
});

test('a tender moment warms her, an apology heals hurt, and her feelings are described with their cause', () => {
  const store = memoryStore(); let now = NOW;
  const affect = new Affect(store, { clock: () => now, tuning: () => ({}) });
  affect.observe('miyue', { towardHer: 'hurtful', moment: 1, why: '他说她烦' });
  assert.match(affect.context('miyue'), /委屈（他说她烦）.*不冷战、不翻旧账/);
  now = new Date(+NOW + 0.2 * H);
  affect.observe('miyue', { towardHer: 'apologetic', moment: 1, why: '他认真道歉了' });
  affect.observe('miyue', { towardHer: 'tender', moment: 2, why: '他说她是他最重要的人' });
  const state = affect.current('miyue');
  assert.ok(state.hurt < 20, String(state.hurt)); assert.ok(state.warmth >= 70, String(state.warmth));
  assert.match(affect.context('miyue'), /被他暖到了（他说她是他最重要的人）/);
  assert.doesNotMatch(affect.context('miyue'), /\d{2,}/, 'no numbers in what she reads');
});

test('desire builds while apart, is spent in closeness, and she may start something on an evening', () => {
  const store = memoryStore(); let now = new Date('2026-10-25T12:30:00Z');
  const affect = new Affect(store, { clock: () => now, tuning: () => ({ flirtation: 90 }) });
  affect.observe('miyue', { towardHer: 'flirty', intimacy: 'accepts', moment: 1, why: '他们亲热了一阵' });
  assert.ok(affect.current('miyue').desire <= 25);
  assert.match(affect.context('miyue'), /更想要温存/);
  assert.deepEqual(affect.materials('miyue', { flirtation: 90 }), [], 'not right after');
  now = NOW; // a day later, 20:30
  assert.ok(affect.current('miyue').desire >= 70, String(affect.current('miyue').desire));
  assert.deepEqual(affect.materials('miyue', { flirtation: 90 }).map(item => item.kind), ['intimacy']);
  assert.deepEqual(affect.materials('miyue', { flirtation: 20 }), [], '不主动暧昧 means she never starts');
  assert.deepEqual(affect.materials('miyue', { now: new Date('2026-10-26T04:00:00Z'), flirtation: 90 }), [], 'not at noon');
  affect.observe('miyue', { towardHer: 'hurtful', moment: 2, why: '他凶她' });
  assert.deepEqual(affect.materials('miyue', { flirtation: 90 }), [], 'not while she is hurt');
});

test('the preparer appraises his message for the feelings system', async () => {
  const model = fakeModel({ reviewEffort: 'fast', catch: false, appraisal: { towardHer: 'tender', need: 'intimacy', intimacy: 'invites', moment: 2, why: '他说想抱着她睡' }, turn: { focus: null, claims: [] }, guidance: [] });
  const messages = buildSessionMessages({ role: { id: 'miyue', name: '林晓薇', profile: {} }, history: { rows: [] }, userText: '好想抱着你睡', trigger: { type: 'user_message', at: NOW.toISOString() } });
  const result = await prepareSessionGuidance({ model, messages, roleId: 'miyue' });
  assert.deepEqual(result.appraisal, { towardHer: 'tender', need: 'intimacy', intimacy: 'invites', moment: 2, why: '他说想抱着她睡' });
  assert.match(model.calls[0].messages.map(m => m.content).join('\n'), /appraisal 是你对他这条消息的感受判断/);
});

test('moments and rituals are remembered; the morning after she comes back to it; days together are counted', () => {
  const store = memoryStore();
  store.db.prepare("INSERT INTO messages(id,role,speaker,text,created_at) VALUES('u1','miyue','user','今晚抱着你睡','2026-10-25T14:00:00Z')").run();
  const ledger = new RelationshipLedger(store, { model: fakeModel({}), clock: () => NOW, enabled: true, togetherSince: () => '2026-09-08T07:26:28Z' });
  ledger.apply('miyue', { moments: [{ kind: 'intimate', text: '深夜他说想抱着她睡，两人在想象里贴着说了很久的话', evidence: ['m1'] }],
    rituals: [{ op: 'add', text: '睡前他想听她说想他', evidence: ['m1'] }] }, new Map([['m1', 'u1']]), { now: NOW });
  const block = ledger.stableContext('miyue');
  assert.match(block, /在一起第 49 天（从 2026-09-08 算）/); assert.match(block, /睡前他想听她说想他/); assert.match(block, /10-25 深夜他说想抱着她睡/);
  const materials = ledger.materials('miyue');
  assert.equal(materials[0].kind, 'moment'); assert.match(materials[0].scope, /还在回味/);
  ledger.markUsed(materials[0].id, 'r1');
  assert.ok(!ledger.materials('miyue').some(item => item.kind === 'moment'), 'once');
  const day50 = new Date('2026-10-27T01:00:00Z');
  assert.equal(ledger.together({ now: day50 }).milestone, true);
  assert.equal(ledger.materials('miyue', { now: day50 })[0].kind, 'milestone');
  store.db.prepare("INSERT INTO proactive_material_deliveries VALUES('r2','miyue','milestone:50','milestone','q','{}',?)").run(day50.toISOString());
  assert.ok(!ledger.materials('miyue', { now: day50 }).some(item => item.kind === 'milestone'), 'marked once');
});
