import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CompanionPursuits } from '../lib/companion-pursuits.mjs';

class TestStore {
  constructor(filename = ':memory:') {
    this.db = new DatabaseSync(filename);
    this.db.exec(`
      PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, role TEXT NOT NULL, speaker TEXT NOT NULL,
        text TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
  }
  transaction(fn) {
    const nested = Boolean(this.depth);
    this.db.exec(nested ? 'SAVEPOINT pursuit_test' : 'BEGIN IMMEDIATE');
    this.depth = (this.depth || 0) + 1;
    try {
      const result = fn();
      this.db.exec(nested ? 'RELEASE pursuit_test' : 'COMMIT');
      return result;
    } catch (error) {
      this.db.exec(nested ? 'ROLLBACK TO pursuit_test; RELEASE pursuit_test' : 'ROLLBACK');
      throw error;
    } finally { this.depth -= 1; }
  }
  getMessage(id) { return this.db.prepare('SELECT * FROM messages WHERE id=?').get(id) || null; }
  message(id, text, { role = 'miyue', speaker = 'assistant' } = {}) {
    this.db.prepare('INSERT INTO messages(id,role,speaker,text,created_at) VALUES(?,?,?,?,?)')
      .run(id, role, speaker, text, new Date().toISOString());
  }
  close() { this.db.close(); }
}

function item(id, kind, title, metadata = {}) {
  return {
    id, kind, title, aliases: [`${title}别名`],
    source: { title: `${title}来源`, url: `https://example.test/${id}`, scope: `${title}指定范围` },
    stages: Array.from({ length: 4 }, (_, index) => ({
      label: `${title}阶段${index + 1}`,
      action: `${title}实际动作${index + 1}`,
      detail: index === 3 ? `${title}未来秘密` : `${title}细节${index + 1}`,
    })),
    ...metadata,
  };
}

const catalog = { items: [
  item('book-one', 'reading', '第一本书'),
  item('film-two', 'film', '第二部电影'),
  item('article-three', 'article', '第三篇文章'),
] };

function fixture(selectedCatalog = catalog, pickArticle, random) {
  let time = new Date('2026-09-07T00:00:00.000Z');
  const store = new TestStore();
  const repo = new CompanionPursuits(store, {
    clock: () => new Date(time), catalog: selectedCatalog, pickArticle,
    ...(random === undefined ? {} : { random }),
  });
  return {
    store, repo,
    advance(hours) { time = new Date(time.getTime() + hours * 60 * 60 * 1000); },
    deliver(view, id = `message-${view.version}`) {
      store.message(id, `前言 ${view.stage.action} 后记`);
      return repo.markDelivered(view.pendingKey, id, view.version);
    },
  };
}

function completeCurrent(f, prefix) {
  for (let index = 0; index < 4; index += 1) {
    const view = f.repo.get('miyue');
    assert.equal(f.deliver(view, `${prefix}-${index}`), true);
    if (index < 3) { f.advance(36); f.repo.tick('miyue'); }
  }
  return f.repo.get('miyue');
}

test('get initializes once and restart preserves the exact current snapshot', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-pursuits-'));
  const filename = path.join(directory, 'state.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let time = new Date('2026-09-07T00:00:00Z');
  const firstStore = new TestStore(filename);
  const firstRepo = new CompanionPursuits(firstStore, { clock: () => time, catalog });
  const first = firstRepo.get('miyue');
  assert.equal(first.title, '第一本书');
  assert.equal(first.stage.index, 0);
  assert.equal(first.version, 1);
  assert.equal(firstRepo.get('miyue').version, 1, 'refresh does not advance or restart');
  firstStore.close();

  time = new Date('2026-10-01T00:00:00Z');
  const changed = { items: [{ ...item('replacement', 'film', '替换目录'), id: 'book-one' }] };
  const secondStore = new TestStore(filename);
  t.after(() => secondStore.close());
  const restarted = new CompanionPursuits(secondStore, { clock: () => time, catalog: changed }).get('miyue');
  assert.equal(restarted.title, '第一本书');
  assert.equal(restarted.startedAt, first.startedAt);
  assert.deepEqual(restarted.stage, first.stage);
});

test('catch-up is persisted and idempotent across restart', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-catchup-'));
  const filename = path.join(directory, 'state.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let time = new Date('2026-09-07T00:00:00Z');
  let store = new TestStore(filename);
  let repo = new CompanionPursuits(store, { clock: () => new Date(time), catalog });
  repo.get('miyue');
  time = new Date('2026-09-11T12:00:00Z');
  const caughtUp = repo.tick('miyue');
  assert.equal(caughtUp.status, 'resting');
  store.close();

  store = new TestStore(filename);
  t.after(() => store.close());
  repo = new CompanionPursuits(store, { clock: () => new Date(time), catalog });
  const restarted = repo.get('miyue');
  assert.deepEqual(restarted, caughtUp);
  assert.deepEqual(repo.tick('miyue'), caughtUp);
});

test('legacy active state migration uses updated_at when nextAt is missing and preserves receipts', () => {
  let time = new Date('2026-09-07T00:00:00Z');
  const store = new TestStore();
  let repo = new CompanionPursuits(store, { clock: () => new Date(time), catalog });
  const first = repo.get('miyue');
  store.message('legacy-receipt', first.stage.action);
  assert.equal(repo.markDelivered(first.pendingKey, 'legacy-receipt', first.version), true);
  const row = store.db.prepare('SELECT state_json,revision FROM companion_pursuit_state WHERE role_id=?').get('miyue');
  const legacy = JSON.parse(row.state_json);
  delete legacy.schemaVersion;
  delete legacy.stageStartedAt;
  delete legacy.nextAt;
  store.db.prepare('UPDATE companion_pursuit_state SET state_json=?,updated_at=? WHERE role_id=?')
    .run(JSON.stringify(legacy), '2026-09-10T06:00:00.000Z', 'miyue');
  time = new Date('2026-09-10T07:00:00Z');
  repo = new CompanionPursuits(store, { clock: () => new Date(time), catalog });
  const migrated = repo.get('miyue');
  assert.equal(migrated.version, row.revision + 1);
  assert.equal(migrated.stageStartedAt, '2026-09-10T06:00:00.000Z');
  assert.equal(migrated.nextAt, '2026-09-11T18:00:00.000Z');
  assert.equal(migrated.history.length, 1);
  assert.equal(migrated.pendingKey, undefined);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM companion_pursuit_deliveries').get().n, 1);
  assert.equal(repo.get('miyue').version, migrated.version, 'migration runs once');
  store.close();
});

test('legacy undelivered final stage migrates to a timed completed occurrence without overflowing', () => {
  const store = new TestStore();
  let time = new Date('2026-09-07T00:00:00Z');
  let repo = new CompanionPursuits(store, { clock: () => new Date(time), catalog });
  repo.get('miyue');
  const row = store.db.prepare('SELECT state_json FROM companion_pursuit_state WHERE role_id=?').get('miyue');
  const legacy = JSON.parse(row.state_json);
  delete legacy.schemaVersion;
  delete legacy.stageStartedAt;
  delete legacy.nextAt;
  legacy.stageIndex = 3;
  legacy.stageDelivered = false;
  legacy.status = 'active';
  legacy.completed = [{
    id: 'book-one', kind: 'reading', title: '第一本书', aliases: [], origin: '', residue: '',
    source: legacy.item.source, completedAt: '2026-08-01T00:00:00.000Z', lastAction: legacy.item.stages[3].action,
  }];
  store.db.prepare('UPDATE companion_pursuit_state SET state_json=?,updated_at=? WHERE role_id=?')
    .run(JSON.stringify(legacy), '2026-09-11T12:00:00.000Z', 'miyue');
  time = new Date('2026-09-11T13:00:00Z');
  repo = new CompanionPursuits(store, { clock: () => new Date(time), catalog });
  const migrated = repo.tick('miyue');
  assert.equal(migrated.stage.index, 3);
  assert.equal(migrated.status, 'resting');
  assert.equal(migrated.stageStartedAt, '2026-09-11T12:00:00.000Z');
  assert.equal(migrated.nextAt, '2026-09-13T12:00:00.000Z');
  assert.equal(migrated.completed.at(-1).completedAt, migrated.stageStartedAt, 'an earlier same-id cycle is not reused');
  assert.ok(migrated.pendingKey);
  store.close();
});

test('the persisted clock advances silent stages and reaches completion at 108 hours', () => {
  const f = fixture();
  const first = f.repo.get('miyue');
  assert.equal(first.status, 'active');
  assert.equal(first.stageStartedAt, '2026-09-07T00:00:00.000Z');
  assert.equal(first.nextAt, '2026-09-08T12:00:00.000Z');
  f.advance(35.99);
  assert.equal(f.repo.tick('miyue').stage.index, 0);
  f.advance(0.01);
  const second = f.repo.tick('miyue');
  assert.equal(second.stage.index, 1);
  assert.equal(second.stageStartedAt, first.nextAt);
  assert.ok(second.pendingKey);
  assert.equal(second.history.length, 0);
  f.advance(72);
  const completed = f.repo.tick('miyue');
  assert.equal(completed.stage.index, 3);
  assert.equal(completed.status, 'resting');
  assert.equal(completed.stageStartedAt, '2026-09-11T12:00:00.000Z');
  assert.equal(completed.nextAt, '2026-09-13T12:00:00.000Z');
  assert.ok(completed.pendingKey, 'the reached final stage can still be shared during rest');
  assert.equal(completed.history.length, 0, 'silent progress does not invent receipts');
  assert.equal(completed.completed[0].completedAt, completed.stageStartedAt);
  assert.equal(completed.completed[0].completion.detail, '第一本书未来秘密');
  f.store.close();
});

test('a late receipt ticks first and rejects the expired stage packet with the current version', () => {
  const f = fixture();
  const first = f.repo.get('miyue');
  f.store.message('late-stage-zero', first.stage.action);
  f.advance(36);
  assert.equal(f.repo.markDelivered(first.pendingKey, 'late-stage-zero', first.version), false);
  const current = f.repo.get('miyue');
  assert.equal(current.stage.index, 1);
  assert.equal(current.version, first.version + 1);
  assert.equal(current.history.length, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM companion_pursuit_deliveries').get().n, 0);
  f.store.close();
});

test('long downtime completes the old item and starts at most one fresh activity at now', () => {
  const f = fixture();
  f.repo.get('miyue');
  f.advance(24 * 30);
  const next = f.repo.tick('miyue');
  assert.equal(next.id, 'film-two');
  assert.equal(next.stage.index, 0);
  assert.equal(next.status, 'active');
  assert.equal(next.startedAt, '2026-10-07T00:00:00.000Z');
  assert.equal(next.stageStartedAt, next.startedAt);
  assert.equal(next.nextAt, '2026-10-08T12:00:00.000Z');
  assert.deepEqual(next.completed.map((entry) => entry.id), ['book-one']);
  assert.equal(next.history.length, 0);
  f.store.close();
});

test('the final delivery holds 48 hours before deterministic round-robin selection', () => {
  const f = fixture();
  for (let index = 0; index < 4; index += 1) {
    const view = f.repo.get('miyue');
    assert.equal(view.stage.index, index);
    assert.equal(f.deliver(view, `stage-${index}`), true);
    if (index < 3) { f.advance(36); f.repo.tick('miyue'); }
  }
  const completed = f.repo.get('miyue');
  assert.equal(completed.pendingKey, undefined);
  f.advance(47.99);
  assert.equal(f.repo.tick('miyue').title, '第一本书');
  f.advance(0.01);
  const next = f.repo.tick('miyue');
  assert.equal(next.title, '第二部电影');
  assert.equal(next.stage.index, 0);
  assert.ok(next.pendingKey);
  f.store.close();
});

test('the final stage accepts one late-in-rest share and lifecycle dates never move', () => {
  const f = fixture();
  f.repo.get('miyue');
  f.advance(108);
  const final = f.repo.tick('miyue');
  const lifecycle = { stageStartedAt: final.stageStartedAt, nextAt: final.nextAt, completedAt: final.completed[0].completedAt };
  f.advance(47.99);
  assert.equal(f.deliver(final, 'late-final-share'), true);
  const shared = f.repo.get('miyue');
  assert.equal(shared.pendingKey, undefined);
  assert.deepEqual(
    { stageStartedAt: shared.stageStartedAt, nextAt: shared.nextAt, completedAt: shared.completed[0].completedAt },
    lifecycle,
  );
  assert.equal(shared.history.length, 1);
  assert.equal(shared.history[0].deliveredAt, '2026-09-13T11:59:24.000Z');
  f.store.close();
});

test('an unshared final packet expires exactly when the next item starts', () => {
  const f = fixture();
  f.repo.get('miyue');
  f.advance(108);
  const final = f.repo.tick('miyue');
  f.store.message('expired-final', final.stage.action);
  f.advance(48);
  assert.equal(f.repo.markDelivered(final.pendingKey, 'expired-final', final.version), false);
  const next = f.repo.get('miyue');
  assert.equal(next.id, 'film-two');
  assert.equal(next.stage.index, 0);
  assert.equal(next.history.length, 0);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM companion_pursuit_deliveries').get().n, 0);
  f.store.close();
});

test('delivery validates key, version, role, speaker, and the complete authored action', () => {
  const f = fixture();
  const view = f.repo.get('miyue');
  const unchanged = () => ({
    version: f.repo.get('miyue').version,
    deliveries: f.store.db.prepare('SELECT COUNT(*) AS n FROM companion_pursuit_deliveries').get().n,
  });
  const before = unchanged();
  f.store.message('wrong-role', view.stage.action, { role: 'wenxi' });
  f.store.message('wrong-speaker', view.stage.action, { speaker: 'user' });
  f.store.message('partial', view.stage.action.slice(0, -1));
  assert.equal(f.repo.markDelivered('wrong', 'wrong-role', view.version), false);
  assert.equal(f.repo.markDelivered(view.pendingKey, 'wrong-role', view.version), false);
  assert.equal(f.repo.markDelivered(view.pendingKey, 'wrong-speaker', view.version), false);
  assert.equal(f.repo.markDelivered(view.pendingKey, 'partial', view.version), false);
  assert.equal(f.repo.markDelivered(view.pendingKey, 'partial', view.version + 1), false);
  assert.deepEqual(unchanged(), before);

  f.store.message('valid', `完整：${view.stage.action}`);
  assert.equal(f.repo.markDelivered(view.pendingKey, 'valid', view.version), true);
  const after = f.repo.get('miyue');
  assert.equal(after.history.length, 1);
  assert.equal(f.repo.markDelivered(view.pendingKey, 'valid', view.version), true, 'same delivery is idempotent');
  assert.equal(f.repo.get('miyue').version, after.version);
  assert.equal(f.repo.markDelivered(view.pendingKey, 'valid', after.version), false, 'a changed version is not the same operation');
  f.advance(36);
  const next = f.repo.tick('miyue');
  assert.equal(f.repo.markDelivered(next.pendingKey, 'valid', next.version), false, 'a message for an earlier stage is stale');
  assert.equal(f.repo.get('miyue').version, next.version);
  f.store.close();
});

test('delivery insert and state revision roll back together', () => {
  const f = fixture();
  const view = f.repo.get('miyue');
  f.store.message('rollback-message', view.stage.action);
  f.store.db.exec(`
    CREATE TRIGGER reject_pursuit_update BEFORE UPDATE ON companion_pursuit_state
    BEGIN SELECT RAISE(ABORT, 'forced state failure'); END;
  `);
  assert.throws(() => f.repo.markDelivered(view.pendingKey, 'rollback-message', view.version), /forced state failure/);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM companion_pursuit_deliveries').get().n, 0);
  assert.equal(f.repo.get('miyue').version, view.version);
  assert.ok(f.repo.pending('miyue'));
  f.store.close();
});

test('timeline catch-up and completion snapshot roll back together when persistence fails', () => {
  const f = fixture();
  const initial = f.repo.get('miyue');
  f.store.db.exec(`
    CREATE TRIGGER reject_pursuit_tick BEFORE UPDATE ON companion_pursuit_state
    BEGIN SELECT RAISE(ABORT, 'forced tick failure'); END;
  `);
  f.advance(108);
  assert.throws(() => f.repo.tick('miyue'), /forced tick failure/);
  f.store.db.exec('DROP TRIGGER reject_pursuit_tick');
  const persisted = f.repo.get('miyue');
  assert.equal(persisted.version, initial.version);
  assert.equal(persisted.stage.index, 0);
  assert.equal(persisted.completed.length, 0);
  f.store.close();
});

test('context exposes the current stage and delivered labels without future facts', () => {
  const f = fixture();
  let view = f.repo.get('miyue');
  const brief = f.repo.context('miyue');
  assert.ok(brief.length <= 160);
  assert.match(brief, /第一本书.*阶段1/);
  const detailed = f.repo.context('miyue', { detailed: true });
  assert.ok(detailed.length <= 1200);
  assert.match(detailed, new RegExp(view.stage.action));
  assert.match(detailed, /第一本书来源/);
  assert.match(detailed, /https:\/\/example\.test\/book-one/);
  assert.match(detailed, /第一本书指定范围/);
  assert.doesNotMatch(detailed, /未来秘密|实际动作2|阶段2/);
  assert.doesNotMatch(detailed, /用户.*读过|用户.*看过/);
  assert.equal(f.repo.context('wenxi'), '');

  f.deliver(view, 'history-one'); f.advance(36); view = f.repo.tick('miyue');
  f.deliver(view, 'history-two'); f.advance(36); view = f.repo.tick('miyue');
  const withHistory = f.repo.context('miyue', { detailed: true });
  assert.match(withHistory, /阶段1、第一本书阶段2/);
  assert.doesNotMatch(withHistory, /第一本书细节1|第一本书实际动作1/);
  f.store.close();
});

test('matches recognizes current names and conservative progress questions', () => {
  const f = fixture();
  assert.equal(f.repo.matches('第一本书后来怎么样了？'), false, 'matches does not initialize hidden state');
  f.repo.get('miyue');
  assert.equal(f.repo.matches('第一本书后来怎么样了？'), true);
  assert.equal(f.repo.matches('第一本书别名读到哪了'), true);
  assert.equal(f.repo.matches('你最近在读什么？'), true);
  assert.equal(f.repo.matches('后来呢'), true);
  assert.equal(f.repo.matches('给我推荐一篇文章'), false);
  assert.equal(f.repo.matches('今天吃什么'), false);
  f.store.close();
});

test('an article picker runs only when its catalog turn starts and its result is snapshotted', () => {
  let time = new Date('2026-09-07T00:00:00Z');
  const store = new TestStore();
  let calls = 0;
  const picks = [item('live-article-a', 'article', '现场文章甲'), item('live-article-b', 'article', '现场文章乙')];
  const articleCatalog = { items: [item('first-book', 'reading', '先读一本'), item('article-slot', 'article', '文章占位')] };
  const repo = new CompanionPursuits(store, {
    clock: () => new Date(time), catalog: articleCatalog,
    pickArticle: ({ template, previous }) => {
      assert.equal(template.id, 'article-slot');
      assert.equal(previous.id, 'first-book');
      return picks[Math.min(calls++, picks.length - 1)];
    },
  });
  let view = repo.get('miyue');
  assert.equal(calls, 0);
  for (let index = 0; index < 4; index += 1) {
    store.message(`book-${index}`, view.stage.action);
    assert.equal(repo.markDelivered(view.pendingKey, `book-${index}`, view.version), true);
    time = new Date(time.getTime() + (index === 3 ? 48 : 36) * 60 * 60 * 1000);
    view = repo.tick('miyue');
  }
  assert.equal(view.title, '现场文章甲');
  assert.equal(calls, 1);
  assert.equal(repo.get('miyue').title, '现场文章甲');
  repo.tick('miyue');
  assert.equal(repo.get('miyue').title, '现场文章甲');
  assert.equal(calls, 1, 'refresh and ticks do not repoll an underway article');
  store.close();
});

test('a null article pick falls back to the catalog article without interrupting initialization', () => {
  const store = new TestStore();
  const fallback = item('default-article', 'article', '目录里的默认文章');
  let calls = 0;
  const repo = new CompanionPursuits(store, {
    catalog: { items: [fallback] },
    pickArticle: ({ template, previous }) => {
      calls += 1;
      assert.equal(template.id, fallback.id);
      assert.equal(previous, null);
      return null;
    },
  });
  const view = repo.get('miyue');
  assert.equal(calls, 1);
  assert.equal(view.id, fallback.id);
  assert.equal(view.title, fallback.title);
  assert.equal(view.stage.action, fallback.stages[0].action);
  assert.ok(view.pendingKey);
  assert.equal(repo.get('miyue').version, view.version);
  assert.equal(calls, 1, 'the persisted fallback is not selected again on refresh');
  store.close();
});

test('catalog validation enforces four bounded stages and safe source URLs', () => {
  const store = new TestStore();
  assert.throws(() => new CompanionPursuits(store, { catalog: { items: [{ ...item('bad', 'reading', '坏条目'), stages: [] }] } }), /exactly four/);
  assert.throws(() => new CompanionPursuits(store, { catalog: { items: [{ ...item('bad-url', 'article', '坏网址'), source: { title: 'x', url: 'file:///tmp/x', scope: 'x' } }] } }), /HTTP or HTTPS/);
  assert.throws(() => new CompanionPursuits(store, { catalog: { items: [{ ...item('large', 'film', '过长'), stages: item('x', 'film', 'x').stages.map((stage) => ({ ...stage, detail: '中'.repeat(700) })) }] } }), /2KB/);
  store.close();
});

test('a completed pursuit follows its first uncompleted causal link and snapshots the edge reason', () => {
  const linkedCatalog = { items: [
    item('start', 'reading', '起点', {
      origin: '因为旧问题尚未解决', residue: '留下一个待验证的问题',
      follows: [{ id: 'causal-next', reason: '上一本留下的问题需要从这部电影继续看' }],
    }),
    item('index-next', 'film', '目录顺位'),
    item('causal-next', 'film', '因果后续', { origin: '目录默认起因' }),
  ] };
  const f = fixture(linkedCatalog);
  completeCurrent(f, 'linked-start');
  f.advance(48);
  const next = f.repo.tick('miyue');
  assert.equal(next.id, 'causal-next');
  assert.equal(next.origin, '上一本留下的问题需要从这部电影继续看');
  assert.equal(next.completed.length, 1);
  assert.equal(next.completed[0].id, 'start');
  f.store.close();
});

test('exhausted links never round-robin or repeat a completed picker result', () => {
  const exhaustedCatalog = { items: [
    item('only', 'article', '唯一文章', {
      interests: ['地方史', '植物'], residue: '以后查证原始材料', follows: [],
    }),
    item('blind-repeat', 'film', '不应轮到'),
  ] };
  let calls = 0;
  const f = fixture(exhaustedCatalog, ({ template, previous }) => {
    calls += 1;
    assert.equal(template.id, 'only');
    if (previous) {
      assert.deepEqual(previous.interests, ['地方史', '植物']);
      return { ...previous };
    }
    return null;
  });
  completeCurrent(f, 'exhausted');
  const before = f.repo.get('miyue');
  f.advance(48);
  const held = f.repo.tick('miyue');
  assert.equal(held.id, 'only');
  assert.equal(held.pendingKey, undefined);
  assert.equal(f.repo.pending('miyue'), null);
  assert.equal(Date.parse(held.nextAt) - Date.parse(before.nextAt), 24 * 60 * 60 * 1000);
  assert.equal(calls, 2, 'one initialization attempt and one post-completion attempt');
  f.store.close();
});

test('residue and completion evidence appear when the final stage occurs, before delivery', () => {
  const secret = '完成以后才形成的长期问题';
  const f = fixture({ items: [item('bounded', 'reading', '边界书', {
    origin: '朋友提到一个具体争议', residue: secret, follows: [],
  })] });
  let view = f.repo.get('miyue');
  assert.equal(view.residue, undefined);
  assert.doesNotMatch(f.repo.context('miyue', { detailed: true }), new RegExp(secret));
  assert.equal(f.deliver(view, 'bounded-first'), true);
  const firstReceipt = JSON.parse(f.store.db.prepare('SELECT payload_json FROM companion_pursuit_deliveries WHERE stage_index=0').get().payload_json);
  assert.equal(firstReceipt.residue, undefined);
  for (let index = 1; index < 4; index += 1) {
    f.advance(36); view = f.repo.tick('miyue');
    if (index === 3) {
      assert.equal(view.residue, secret);
      assert.equal(view.completed[0].completion.detail, '边界书未来秘密');
      assert.match(f.repo.context('miyue', { detailed: true, text: '边界书后来怎样了' }), /尚未实际讲过/);
    }
    assert.equal(f.deliver(view, `bounded-${index}`), true);
  }
  const completed = f.repo.get('miyue');
  assert.equal(completed.residue, secret);
  assert.equal(completed.completed[0].residue, secret);
  const finalReceipt = JSON.parse(f.store.db.prepare('SELECT payload_json FROM companion_pursuit_deliveries WHERE stage_index=3').get().payload_json);
  assert.equal(finalReceipt.title, '边界书');
  assert.deepEqual(finalReceipt.aliases, ['边界书别名']);
  assert.equal(finalReceipt.origin, '朋友提到一个具体争议');
  assert.equal(finalReceipt.residue, secret);
  f.store.close();
});

test('an old snapshot gains same-id trajectory metadata once without replacing authored facts', () => {
  const store = new TestStore();
  const oldItem = item('baicao-reread', 'reading', '重读百草园');
  const oldRepo = new CompanionPursuits(store, { catalog: { items: [oldItem] } });
  const oldView = oldRepo.get('miyue');
  const upgradedCatalog = { items: [item('baicao-reread', 'reading', '改过的目录标题', {
    origin: '想核对记忆里的童年空间', residue: '留意记忆怎样改写地点', interests: ['记忆'], follows: [],
  })] };
  const upgradedRepo = new CompanionPursuits(store, { catalog: upgradedCatalog });
  const upgraded = upgradedRepo.get('miyue');
  assert.equal(upgraded.version, oldView.version + 1);
  assert.equal(upgraded.pendingKey, oldView.pendingKey);
  assert.equal(upgraded.title, oldView.title);
  assert.deepEqual(upgraded.source, oldView.source);
  assert.deepEqual(upgraded.stage, oldView.stage);
  assert.equal(upgraded.origin, '想核对记忆里的童年空间');
  assert.deepEqual(upgraded.interests, ['记忆']);
  assert.equal(upgraded.residue, undefined, 'an unfinished current item does not expose its future residue');
  assert.equal(upgradedRepo.get('miyue').version, upgraded.version, 'metadata migration is not repeated');
  store.close();
});

test('completion trail survives restart and an explicit old alias reveals only that bounded history', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-trail-'));
  const filename = path.join(directory, 'state.sqlite');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let time = new Date('2026-09-07T00:00:00Z');
  const historyCatalog = { items: [
    item('history-a', 'reading', '旧书甲', { residue: '甲留下的问题', follows: [{ id: 'history-b', reason: '甲引到乙' }] }),
    item('history-b', 'film', '旧片乙', { residue: '乙留下的问题', follows: [{ id: 'current-c', reason: '乙引到丙' }] }),
    item('current-c', 'reading', '当前丙', { origin: '目录起因', follows: [] }),
  ] };
  let store = new TestStore(filename);
  let repo = new CompanionPursuits(store, { clock: () => new Date(time), catalog: historyCatalog });
  const advance = (hours) => { time = new Date(time.getTime() + hours * 60 * 60 * 1000); };
  const complete = (prefix) => {
    for (let index = 0; index < 4; index += 1) {
      const view = repo.get('miyue');
      store.message(`${prefix}-${index}`, view.stage.action);
      assert.equal(repo.markDelivered(view.pendingKey, `${prefix}-${index}`, view.version), true);
      if (index < 3) { advance(36); repo.tick('miyue'); }
    }
  };
  complete('a'); advance(48); repo.tick('miyue');
  complete('b'); advance(48); repo.tick('miyue');
  store.close();

  store = new TestStore(filename);
  t.after(() => store.close());
  repo = new CompanionPursuits(store, { clock: () => new Date(time), catalog: historyCatalog });
  const view = repo.get('miyue');
  assert.deepEqual(view.completed.map((entry) => [entry.id, entry.kind]), [['history-a', 'reading'], ['history-b', 'film']]);
  const unrelated = repo.context('miyue', { detailed: true, text: '今天散步了吗' });
  assert.doesNotMatch(unrelated, /甲留下的问题/);
  assert.match(unrelated, /乙留下的问题/, 'normal detailed context includes only the latest completed residue');
  const recalled = repo.context('miyue', { detailed: true, text: '旧书甲别名后来怎样了' });
  assert.ok(recalled.length <= 1400);
  assert.match(recalled, /旧书甲来源/);
  assert.match(recalled, /旧书甲实际动作4/);
  assert.match(recalled, /旧书甲未来秘密/, 'a matched completed item may expose its delivered final detail');
  assert.match(recalled, /甲留下的问题/);
  assert.doesNotMatch(recalled, /乙留下的问题/);
  const brief = repo.context('miyue', { text: '旧书甲别名呢' });
  assert.ok(brief.length <= 240);
  assert.match(brief, /甲留下的问题/);
  assert.match(brief, /乙引到丙/);
});

test('trajectory metadata validation enforces its optional bounds and links', () => {
  const store = new TestStore();
  assert.throws(() => new CompanionPursuits(store, { catalog: { items: [item('long-origin', 'reading', '长起因', { origin: '因'.repeat(301) })] } }), /origin/);
  assert.throws(() => new CompanionPursuits(store, { catalog: { items: [item('many-interests', 'reading', '多兴趣', { interests: Array(11).fill('兴趣') })] } }), /at most 10/);
  assert.throws(() => new CompanionPursuits(store, { catalog: { items: [item('missing-link', 'reading', '坏链接', { follows: [{ id: 'absent', reason: '去不存在的项目' }] })] } }), /unknown pursuit id/);
  assert.throws(() => new CompanionPursuits(store, { catalog: { lifePlanning: 'yes', items: [item('bad-mode', 'reading', '坏模式')] } }), /lifePlanning/);
  assert.throws(() => new CompanionPursuits(store, { catalog: { items: [item('bad-weight', 'reading', '坏权重', { weight: 11 })] } }), /weight/);
  store.close();
});

test('life planning makes one weighted draw after rest and snapshots either selected life', () => {
  const planningCatalog = { lifePlanning: true, items: [
    item('started', 'reading', '已经开始', { weight: 10, residue: '读完后的余味' }),
    item('quiet-walk', 'film', '安静散步', { weight: 1, origin: '今天想独自走一段路' }),
    item('cook-soup', 'reading', '慢慢煮汤', { weight: 3, origin: '忽然想认真做一顿晚饭' }),
  ] };
  const run = (draw, expected) => {
    let calls = 0;
    const f = fixture(planningCatalog, undefined, () => { calls += 1; return draw; });
    completeCurrent(f, `planning-${expected}`);
    assert.equal(calls, 0, 'initialization, delivery, and ordinary refresh do not draw');
    f.repo.get('miyue');
    f.repo.context('miyue', { detailed: true });
    assert.equal(calls, 0);
    f.advance(48);
    const selected = f.repo.tick('miyue');
    assert.equal(selected.id, expected);
    assert.notEqual(selected.id, 'started', 'the completed item is excluded even with the highest weight');
    assert.equal(calls, 1);
    assert.equal(f.repo.get('miyue').id, expected);
    assert.equal(f.repo.pending('miyue').id, expected);
    assert.equal(f.repo.tick('miyue').id, expected);
    assert.equal(calls, 1, 'interaction and refresh retain the persisted selection');
    f.store.close();
  };
  run(0, 'quiet-walk');
  run(2, 'cook-soup');
});

test('life planning rests for 24 hours when every catalog life is completed', () => {
  const f = fixture({ lifePlanning: true, items: [
    item('single-life', 'reading', '唯一生活', { weight: 4, residue: '先放一放' }),
  ] });
  completeCurrent(f, 'single-life');
  const completed = f.repo.get('miyue');
  f.advance(48);
  const resting = f.repo.tick('miyue');
  assert.equal(resting.id, 'single-life');
  assert.equal(resting.pendingKey, undefined);
  assert.equal(f.repo.pending('miyue'), null);
  assert.equal(Date.parse(resting.nextAt) - Date.parse(completed.nextAt), 24 * 60 * 60 * 1000);
  f.store.close();
});

test('life planning retains silent completion IDs after the bounded snapshot trail rolls over', () => {
  const many = { lifePlanning: true, items: Array.from({ length: 14 }, (_, index) => (
    item(`life-${index}`, index % 2 ? 'film' : 'reading', `生活${index}`, { weight: 1 })
  )) };
  const f = fixture(many, undefined, () => 0);
  f.repo.get('miyue');
  let view;
  for (let index = 0; index < many.items.length; index += 1) {
    f.advance(156);
    view = f.repo.tick('miyue');
  }
  assert.equal(view.id, 'life-13');
  assert.equal(view.status, 'resting');
  assert.equal(view.completed.length, 12);
  assert.equal(view.completed.some((entry) => entry.id === 'life-0'), false);
  const persisted = JSON.parse(f.store.db.prepare('SELECT state_json FROM companion_pursuit_state WHERE role_id=?').get('miyue').state_json);
  assert.equal(persisted.completedItemIds.length, 14);
  assert.equal(new Set(persisted.completedItemIds).size, 14);
  f.store.close();
});

test('unsent final notification expires even when no fresh activity is available',()=>{
  const f=fixture({lifePlanning:true,items:[item('only','reading','唯一一本')]});
  f.repo.get('miyue');f.advance(108);
  const final=f.repo.tick('miyue');assert.ok(final.pendingKey);
  f.advance(48);const expired=f.repo.tick('miyue');
  assert.equal(expired.status,'resting');assert.equal(expired.pendingKey,undefined);
  assert.deepEqual(expired.history,[]);assert.equal(expired.completed.length,1);
  f.advance(24);assert.equal(f.repo.tick('miyue').pendingKey,undefined);
  const reopened=new CompanionPursuits(f.store,{catalog:{lifePlanning:true,items:[item('only','reading','唯一一本')]}});
  assert.equal(reopened.pending('miyue'),null);
  f.store.close();
});
