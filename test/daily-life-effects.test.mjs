import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { InnerStateRepository } from '../lib/inner-state.mjs';
import { DailyLifeEffects, dailyEffectFor } from '../lib/daily-life-effects.mjs';

class Store {
  constructor(filename = ':memory:') { this.db = new DatabaseSync(filename); this.depth = 0; }
  transaction(fn) { const nested = this.depth++; this.db.exec(nested ? `SAVEPOINT effects_${nested}` : 'BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec(nested ? `RELEASE SAVEPOINT effects_${nested}` : 'COMMIT'); return value; } catch (error) { this.db.exec(nested ? `ROLLBACK TO SAVEPOINT effects_${nested}; RELEASE SAVEPOINT effects_${nested}` : 'ROLLBACK'); throw error; } finally { this.depth--; } }
  close() { this.db.close(); }
}
function clockAt(value) { let now = new Date(value); const clock = () => new Date(now); clock.set = value => { now = new Date(value); }; return clock; }
function event(phase, startedAt = '2026-09-06T02:00:00.000Z') { return { id: 'nails-1', kind: 'manicure', title: '换指甲', phase, startedAt }; }

test('daily effect presets are explicit, small, and never include relationship metrics', () => {
  assert.deepEqual(dailyEffectFor(event('recent')).changes, { mood: 3, stress: -2 });
  assert.equal(dailyEffectFor({ ...event('recent'), kind: 'article' }), null);
  for (const preset of ['manicure', 'shopping', 'pet', 'friend_chat', 'cooking', 'plants', 'outfit', 'music_exercise']) {
    const found = dailyEffectFor({ ...event(preset === 'shopping' ? 'arrived' : 'recent'), kind: preset });
    assert.ok(found);
    for (const [key, value] of Object.entries(found.changes)) {
      assert.ok(['fatigue', 'stress', 'mood', 'vitality', 'playfulness'].includes(key));
      assert.ok(Math.abs(value) <= 4);
    }
  }
});

test('effects apply once on a timely phase transition and survive restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-effects-')); const filename = path.join(dir, 'life.sqlite'); const clock = clockAt('2026-09-06T02:00:00.000Z');
  let store = new Store(filename), inner = new InnerStateRepository(store, { clock, random: () => .5 }), effects = new DailyLifeEffects(store, inner, { clock });
  const baseline = inner.view(); effects.advance([event('doing')]); clock.set('2026-09-06T02:30:00.000Z');
  assert.equal(effects.advance([event('recent')]).length, 1); const changed = inner.view();
  assert.equal(changed.values.mood, baseline.values.mood + 3); assert.equal(changed.values.stress, baseline.values.stress - 2); assert.equal(changed.revision, baseline.revision + 1);
  assert.equal(effects.advance([event('recent')]).length, 0); store.close();
  store = new Store(filename); inner = new InnerStateRepository(store, { clock, random: () => .5 }); effects = new DailyLifeEffects(store, inner, { clock });
  assert.equal(effects.advance([event('recent')]).length, 0); assert.equal(inner.view().values.mood, changed.values.mood); store.close(); fs.rmSync(dir, { recursive: true });
});

test('first past observation and offline transitions never backfill effects', () => {
  const clock = clockAt('2026-09-06T06:00:01.000Z'); const store = new Store(); const inner = new InnerStateRepository(store, { clock, random: () => .5 }); const effects = new DailyLifeEffects(store, inner, { clock });
  const before = inner.view(); assert.equal(effects.advance([event('recent', '2026-09-06T02:00:00.000Z')]).length, 0);
  assert.equal(inner.view().values.mood, before.values.mood);
  effects.advance([event('doing', '2026-09-06T06:00:01.000Z')]); clock.set('2026-09-06T09:00:02.000Z');
  assert.equal(effects.advance([event('recent', '2026-09-06T06:00:01.000Z')]).length, 0); store.close();
});

test('paused/resumed and changed choices in the same phase do not create duplicate effects or polling writes', () => {
  const clock = clockAt('2026-09-06T02:00:00.000Z'); const store = new Store(); const inner = new InnerStateRepository(store, { clock, random: () => .5 }); const effects = new DailyLifeEffects(store, inner, { clock });
  effects.advance([event('doing')]); effects.advance([event('paused')]); effects.advance([event('doing')]);
  clock.set('2026-09-06T02:20:00.000Z'); assert.equal(effects.advance([event('recent')]).length, 1);
  const observed = store.db.prepare("SELECT observed_at FROM daily_life_effect_phases WHERE event_id='nails-1'").get().observed_at;
  clock.set('2026-09-06T02:30:00.000Z');
  assert.equal(effects.advance([{ ...event('recent'), choice: { selected: '樱桃红' } }]).length, 0);
  assert.equal(store.db.prepare("SELECT observed_at FROM daily_life_effect_phases WHERE event_id='nails-1'").get().observed_at, observed);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM inner_state_events WHERE event_id='daily:nails-1:recent'").get().count, 1);
  store.close();
});

test('a daily receipt rolls back with rejected state work and cannot change relationship fields', () => {
  const clock = clockAt('2026-09-06T02:00:00.000Z'); const store = new Store(); const inner = new InnerStateRepository(store, { clock, random: () => .5 }); const effects = new DailyLifeEffects(store, inner, { clock });
  const before = inner.get(); assert.throws(() => inner.applyDailyEffect({ id: 'daily:bad:recent', title: '坏数据', phase: 'recent', changes: { affection: 3 } }));
  assert.equal(store.db.prepare('SELECT count(*) AS count FROM inner_state_events').get().count, 0);
  effects.advance([{ ...event('doing'), id: 'pet-1', kind: 'pet' }]); assert.equal(effects.advance([{ ...event('recent'), id: 'pet-1', kind: 'pet' }]).length, 1);
  const after = inner.get(); assert.equal(after.affection, before.affection); assert.equal(after.security, before.security); assert.equal(after.desire, before.desire); assert.equal(after.affectionNeed, before.affectionNeed); store.close();
});

test('phase-record failure rolls back the inner change and receipt, then a retry applies once', () => {
  const clock = clockAt('2026-09-06T02:00:00.000Z'); const store = new Store(); const inner = new InnerStateRepository(store, { clock, random: () => .5 }); const effects = new DailyLifeEffects(store, inner, { clock });
  const before = inner.get(); effects.advance([event('doing')]); clock.set('2026-09-06T02:20:00.000Z');
  store.db.exec("CREATE TRIGGER fail_phase_update BEFORE UPDATE ON daily_life_effect_phases BEGIN SELECT RAISE(ABORT, 'phase write failed'); END");
  assert.throws(() => effects.advance([event('recent')]));
  const afterFailure = inner.get();
  assert.equal(afterFailure.mood, before.mood); assert.equal(afterFailure.stress, before.stress);
  assert.equal(store.db.prepare("SELECT count(*) AS count FROM inner_state_events WHERE event_id='daily:nails-1:recent'").get().count, 0);
  assert.equal(store.db.prepare("SELECT phase FROM daily_life_effect_phases WHERE event_id='nails-1'").get().phase, 'doing');
  store.db.exec('DROP TRIGGER fail_phase_update');
  assert.equal(effects.advance([event('recent')]).length, 1);
  assert.equal(effects.advance([event('recent')]).length, 0);
  store.close();
});
