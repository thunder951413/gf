import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { UsageRepository } from '../lib/usage.mjs';

class TestStore {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  }
  close() { this.db.close(); }
}

test('cache rates use only valid paired observations across totals, groups, and recent rows', t => {
  const store = new TestStore();
  t.after(() => store.close());
  const clock = () => new Date('2026-09-06T08:00:00.000Z');
  const ledger = new UsageRepository(store, { clock });
  const insert = (id, payload) => store.db.prepare('INSERT INTO model_usage VALUES (?,?,?)').run(id, payload.createdAt, JSON.stringify({ id, status: 'success', ...payload }));
  const at = '2026-09-06T07:00:00.000Z';

  insert('known-hit', { createdAt: at, roleId: 'miyue', purpose: 'chat', inputTokens: 100, cachedTokens: 40, totalTokens: 120 });
  insert('unknown-cache', { createdAt: at, roleId: 'miyue', purpose: 'chat', inputTokens: 200, totalTokens: 220 });
  insert('zero-input', { createdAt: at, roleId: 'wenxi', purpose: 'memory', inputTokens: 0, cachedTokens: 0, totalTokens: 5 });
  insert('zero-cache', { createdAt: at, roleId: 'wenxi', purpose: 'memory', inputTokens: 50, cachedTokens: 0, totalTokens: 55 });
  insert('invalid-pair', { createdAt: at, roleId: 'wenxi', purpose: 'memory', inputTokens: 25, cachedTokens: 30, totalTokens: 30 });
  insert('legacy', { createdAt: at, roleId: null, purpose: 'research' });

  const snapshot = ledger.snapshot();
  assert.deepEqual({
    rate: snapshot.allTime.cacheHitRate,
    requests: snapshot.allTime.cacheObservedRequests,
    input: snapshot.allTime.cacheObservedInputTokens,
    hit: snapshot.allTime.cacheHitTokens,
    miss: snapshot.allTime.cacheMissTokens,
  }, { rate: 40 / 150, requests: 2, input: 150, hit: 40, miss: 110 });
  assert.equal(snapshot.allTime.inputTokens, 375);
  assert.equal(snapshot.allTime.cachedTokens, 70);
  assert.equal(snapshot.today.cacheHitRate, 40 / 150);

  const miyue = snapshot.byRole.find(row => row.roleId === 'miyue');
  assert.equal(miyue.cacheObservedRequests, 1);
  assert.equal(miyue.cacheHitRate, 0.4);
  const memory = snapshot.byPurpose.find(row => row.purpose === 'memory');
  assert.equal(memory.cacheObservedRequests, 1);
  assert.equal(memory.cacheHitRate, 0);
  assert.equal(memory.cacheMissTokens, 50);
  const legacy = snapshot.byPurpose.find(row => row.purpose === 'research');
  assert.equal(legacy.inputTokens, null);
  assert.equal(legacy.cachedTokens, null);
  assert.equal(legacy.cacheHitRate, null);
  assert.equal(legacy.cacheObservedRequests, 0);

  const recent = Object.fromEntries(snapshot.recent.map(row => [row.id, row]));
  assert.equal(recent['known-hit'].cacheHitRate, 0.4);
  assert.equal(recent['zero-cache'].cacheHitRate, 0);
  for (const id of ['unknown-cache', 'zero-input', 'invalid-pair', 'legacy']) {
    assert.equal(recent[id].cacheHitRate, null);
    assert.equal(recent[id].cacheObservedRequests, 0);
  }
  const storedLegacy = JSON.parse(store.db.prepare('SELECT payload FROM model_usage WHERE id=?').get('legacy').payload);
  assert.equal(Object.hasOwn(storedLegacy, 'cacheHitRate'), false);
});
