import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../lib/store.mjs';
import { sessionReminderActions } from '../lib/session-reminders.mjs';
import { ProactiveRepository } from '../lib/proactive-store.mjs';

const story = { start: 'start', nodes: { start: { body: '', choices: [] } } };

function fixture(t, now = '2026-09-25T00:00:00.000Z') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-session-reminder-'));
  const store = new Store({ dataDir, story, clock: () => new Date(now) });
  t.after(() => { store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { store, dataDir };
}

function createCommitment(store, { channel = 'desktop', text = '吃药', dueAt = '2026-09-26T01:00:00.000Z' } = {}) {
  const userText = `提醒我${text}`;
  const actions = sessionReminderActions({ store, roleId: 'miyue', userText, replyChannel: channel, clock: () => new Date('2026-09-25T00:00:00.000Z') });
  const prepared = actions.prepare({ action: 'create', text, dueAt, evidence: userText });
  actions.commit();
  return prepared;
}

test('session commitments survive restart, honor quiet, bypass optional quota, and deliver exactly once to their origin channel', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-session-reminder-restart-'));
  let store = new Store({ dataDir, story, clock: () => new Date('2026-09-25T00:00:00.000Z') });
  const created = createCommitment(store, { channel: 'weixin', dueAt: '2026-09-25T01:00:00.000Z' });
  store.addReminder('miyue', '旧版可选提醒', '2026-09-25T01:00:00.000Z');
  store.setSettings({ quiet: true });
  store.close();

  store = new Store({ dataDir, story, clock: () => new Date('2026-09-25T02:00:00.000Z') });
  t.after(() => { store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const proactive = new ProactiveRepository(store, { clock: () => new Date('2026-09-25T02:00:00.000Z') });
  proactive.saveSettings({ dailyLimit: 1 });
  const quotaMessage = store.addAssistantMessage('miyue', '今天已有一条可选主动消息');
  store.db.prepare("UPDATE messages SET kind='proactive' WHERE id=?").run(quotaMessage.id);
  assert.equal(proactive.countContactsSince('2026-09-25T00:00:00.000Z'), 1);
  assert.deepEqual(store.deliverDueReminders(new Date('2026-09-25T02:00:00.000Z')), []);
  assert.equal(store.listReminders().find(row => row.id === created.id).status, 'pending');

  store.setSettings({ quiet: false });
  const delivered = store.deliverDueReminders(new Date('2026-09-25T02:00:00.000Z'));
  assert.deepEqual(delivered.map(row => row.id), [created.id]);
  assert.deepEqual(delivered[0].message, {
    id: delivered[0].message.id, role: 'miyue', speaker: 'assistant', text: '提醒你：\n吃药',
    kind: 'session_reminder', createdAt: '2026-09-25T02:00:00.000Z', replyChannel: 'weixin',
  });
  assert.equal(store.listReminders().find(row => row.text === '旧版可选提醒').status, 'pending');
  const message = store.getMessages('miyue').find(row => row.kind === 'session_reminder');
  assert.equal(message.kind, 'session_reminder');
  assert.equal(store.db.prepare('SELECT reply_channel FROM messages WHERE id=?').get(message.id).reply_channel, 'weixin');
  assert.equal(message.text, '提醒你：\n吃药');
  assert.equal(proactive.countContactsSince('2026-09-25T00:00:00.000Z'), 1, 'a requested commitment does not consume optional proactive quota');
  assert.equal(proactive.inbox().items.find(row => row.messageId === message.id)?.kind, 'session_reminder');
  assert.deepEqual(store.deliverDueReminders(new Date('2026-09-25T02:01:00.000Z')), []);
  assert.equal(store.getMessages('miyue').filter(row => row.kind === 'session_reminder').length, 1);
});

test('updates keep the durable commitment marker and original channel', t => {
  const { store } = fixture(t);
  const created = createCommitment(store, { channel: 'weixin' });
  const row = store.listReminders().find(item => item.id === created.id);
  assert.equal(row.deliveryKind, 'commitment');
  assert.equal(row.originChannel, 'weixin');
  const userText = '把吃药提醒改到上午十点';
  const actions = sessionReminderActions({ store, roleId: 'miyue', userText, replyChannel: 'desktop', clock: () => new Date('2026-09-25T00:00:00.000Z') });
  actions.prepare({ action: 'update', id: row.id, text: row.text, dueAt: '2026-09-26T02:00:00.000Z', evidence: userText });
  actions.commit();
  const updated = store.listReminders().find(item => item.id === row.id);
  assert.equal(updated.deliveryKind, 'commitment');
  assert.equal(updated.originChannel, 'weixin');
});

test('old reminder databases migrate to the legacy policy without changing delivery wording', t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-reminder-migration-'));
  const db = new DatabaseSync(path.join(dataDir, 'life.sqlite'));
  db.exec(`CREATE TABLE reminders(id TEXT PRIMARY KEY,role TEXT NOT NULL,text TEXT NOT NULL,due_at TEXT NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL,delivered_at TEXT);
    INSERT INTO reminders VALUES('legacy','miyue','旧提醒','2026-09-24T00:00:00.000Z','pending','2026-09-20T00:00:00.000Z',NULL);`);
  db.close();
  const store = new Store({ dataDir, story, clock: () => new Date('2026-09-25T00:00:00.000Z') });
  t.after(() => { store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const reminder = store.listReminders()[0];
  assert.equal(reminder.deliveryKind, 'legacy');
  assert.equal(reminder.originChannel, 'desktop');
  assert.equal(store.deliverDueReminders(new Date('2026-09-25T00:00:00.000Z')).length, 1);
  const message = store.getMessages('miyue')[0];
  assert.equal(message.kind, 'reminder');
  assert.match(message.text, /想现在接着聊吗/);
});
