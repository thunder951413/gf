import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { FollowupRepository } from '../lib/followups.mjs';
import { Store } from '../lib/store.mjs';

const story = { start: 'start', nodes: { start: { id: 'start', body: '', choices: [] } } };
function fixture(t, initial = '2026-09-07T00:00:00.000Z') {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-followups-'));
  let value = new Date(initial);
  const clock = () => new Date(value);
  clock.set = (next) => { value = new Date(next); };
  const store = new Store({ dataDir, story, initialFeeds: [] });
  const repo = new FollowupRepository(store, { clock });
  t.after(() => { try { store.close(); } catch {} fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { dataDir, store, repo, clock };
}

test('observe records only explicit upcoming first-person events and deduplicates aliases', t => {
  const { repo } = fixture(t);
  const item = repo.observe('zhixia', '我明天上午要参加产品面试。', 'message-1');
  assert.equal(item.roleId, 'zhixia');
  assert.equal(item.status, 'pending');
  assert.equal(item.source.messageId, 'message-1');
  assert.equal(item.dueAt, '2026-09-08T03:00:00.000Z');
  assert.equal(repo.observe('zhixia', '明天面试，希望顺利。', 'message-2').id, item.id);
  assert.equal(repo.observe('zhixia', '我明天上午要参加产品面试。', 'message-1').id, item.id);
  assert.equal(repo.list({ roleId: 'zhixia' }).length, 1);
});

test('automatic due times are after the event and ambiguous bare next week is ignored', t => {
  const { repo } = fixture(t);
  assert.equal(repo.observe('zhixia', '我明天10点要做演示。', 'timed').dueAt, '2026-09-08T04:00:00.000Z');
  assert.equal(repo.observe('zhixia', '后天要去体检。', 'unspecified').dueAt, '2026-09-09T11:30:00.000Z');
  assert.equal(repo.observe('zhixia', '今晚要交稿。', 'tonight').dueAt, '2026-09-08T01:30:00.000Z');
  assert.equal(repo.observe('zhixia', '下周要出差。', 'ambiguous-week'), null);
  assert.equal(repo.observe('zhixia', '下周三要出差。', 'specific-week').dueAt, '2026-09-16T11:30:00.000Z');
});

test('Chinese clock hours and the latest corrected time schedule the check-in two hours later', t => {
  const { repo } = fixture(t);
  const corrected = repo.observe('zhixia', '我准备明天去面试\n补充一下，改到下午两点了', 'chinese-two');
  assert.equal(corrected.dueAt, '2026-09-08T08:00:00.000Z');
  assert.match(corrected.source.text, /准备明天去面试.*改到下午两点了/u);
  assert.equal(repo.observe('zhixia', '后天上午九点面试，改到下午两点半。', 'latest-correction').dueAt, '2026-09-09T08:30:00.000Z');
  assert.equal(repo.observe('zhixia', '下周五晚上二十三点交稿。', 'chinese-twenty-three').dueAt, '2026-09-18T17:00:00.000Z');
});

test('observe excludes quotes, reports, hypotheticals, negation, and third-person events', t => {
  const { repo } = fixture(t);
  const messages = [
    '“我明天要面试。”',
    '她说明天要面试。',
    '如果明天面试，我该穿什么？',
    '我明天不参加面试。',
    '我同事后天要去看医生。',
    '听说明晚有一场考试。',
  ];
  messages.forEach((text, index) => assert.equal(repo.observe('zhixia', text, `ignored-${index}`), null));
  assert.deepEqual(repo.list(), []);
});

test('due returns only fresh scoped items and delivery is idempotent', t => {
  const { repo, clock } = fixture(t);
  const a = repo.create({ roleId: 'zhixia', topic: '作品演示', dueAt: '2026-09-07T01:00:00.000Z' });
  repo.create({ roleId: 'wenxi', topic: '体检', dueAt: '2026-09-07T01:00:00.000Z' });
  clock.set('2026-09-07T02:00:00.000Z');
  assert.deepEqual(repo.due('zhixia').map(item => item.id), [a.id]);
  assert.equal(repo.markDelivered(a.id, 'callback-message'), true);
  assert.equal(repo.markDelivered(a.id, 'second-message'), false);
  assert.deepEqual(repo.due('zhixia'), []);
  assert.equal(repo.list({ roleId: 'wenxi' }).length, 1);

  const stale = repo.create({ roleId: 'zhixia', topic: '下周交稿', dueAt: '2026-09-08T02:00:00.000Z' });
  clock.set('2026-09-11T02:00:00.001Z');
  assert.deepEqual(repo.due('zhixia'), []);
  assert.equal(repo.list().find(item => item.id === stale.id).status, 'expired');
});

test('explicit event completion and cancellation are scoped; generic completion is ignored', t => {
  const { repo } = fixture(t);
  const interview = repo.observe('zhixia', '明天有面试。', 'i-create');
  const exam = repo.observe('zhixia', '后天上午考试。', 'e-create');
  assert.equal(repo.observe('zhixia', '都忙完了。', 'generic'), null);
  assert.equal(repo.observe('wenxi', '面试结束了。', 'other-role'), null);
  assert.equal(repo.observe('zhixia', '面试已经结束了。', 'i-done').status, 'done');
  assert.equal(repo.observe('zhixia', '后天的考试取消了。', 'e-cancel').status, 'cancelled');
  assert.equal(repo.list().find(item => item.id === interview.id).status, 'done');
  assert.equal(repo.list().find(item => item.id === exam.id).status, 'cancelled');
});

test('an explicit negated event cancels its match but future completion wording does not', t => {
  const { repo } = fixture(t);
  const interview = repo.observe('zhixia', '明天有面试。', 'i-create-negated');
  assert.equal(repo.observe('zhixia', '我明天不面试了。', 'i-cancel-negated').status, 'cancelled');
  assert.equal(repo.list().find(item => item.id === interview.id).status, 'cancelled');
  const next = repo.observe('zhixia', '后天有面试，面试结束后去吃饭。', 'future-completion');
  assert.equal(next.status, 'pending');
});

test('merged cancelled plans and oversized saved chats fail closed without creating callbacks', t => {
  const { repo } = fixture(t);
  assert.equal(repo.observe('zhixia', '我明天面试\n我决定不去了', 'merged-cancel'), null);
  assert.equal(repo.observe('zhixia', `前情${'很长的已保存聊天。'.repeat(1000)}明天面试`, 'long-saved'), null);
  assert.deepEqual(repo.list(), []);
});

test('repository persists across restart and validates public API patches', t => {
  const f = fixture(t);
  const created = f.repo.create({ roleId: 'zhixia', topic: '看医生', dueAt: '2026-09-08T02:00:00.000Z', sourceMessageId: 'manual-source' });
  f.store.close();
  const reopened = new Store({ dataDir: f.dataDir, story, initialFeeds: [] });
  t.after(() => { try { reopened.close(); } catch {} });
  const restarted = new FollowupRepository(reopened, { clock: f.repo.clock });
  assert.equal(restarted.list({ roleId: 'zhixia' })[0].id, created.id);
  assert.equal(restarted.context(created).length <= 2000, true);
  assert.match(restarted.context(created), /不要预设结果|没有回应义务/);
  assert.throws(() => restarted.update(created.id, { arbitrary: true }), error => error.status === 400 && error.code === 'INVALID_FOLLOWUP');
  assert.throws(() => restarted.update(created.id, { status: 'pending' }), error => error.status === 400);
  assert.throws(() => restarted.update(created.id, { dueAt: null }), error => error.status === 400);
  assert.equal(restarted.update(created.id, { status: 'done', topic: '复诊已经完成' }).status, 'done');
});

test('explicit rescheduling replaces the earlier pending callback instead of asking twice',t=>{const {repo}=fixture(t);const old=repo.observe('miyue','我明天上午九点面试','plan-one');const updated=repo.observe('miyue','明天的面试改到下午两点了','plan-two');assert.equal(repo.list().find(i=>i.id===old.id).status,'cancelled');assert.equal(new Date(updated.dueAt).getHours(),16);const next=repo.observe('miyue','面试改到后天下午三点','plan-three');assert.equal(repo.list().filter(i=>i.status==='pending').length,1);assert.equal(new Date(next.dueAt).getDate(),9);assert.equal(new Date(next.dueAt).getHours(),17);assert.equal(repo.observe('miyue','```明天上午面试```','quoted-code'),null);});
