import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../lib/store.mjs';
import { WardrobeRepository } from '../lib/wardrobe.mjs';

function fixture(t, initial = '2026-09-06T00:00:00.000Z', samples = [0]) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'life-wardrobe-'));
  const store = new Store({ dataDir, story: { start: 'start', nodes: { start: {} } } });
  let now = new Date(initial);
  let calls = 0;
  const repo = () => new WardrobeRepository(store, {
    clock: () => new Date(now),
    random: () => samples[Math.min(calls++, samples.length - 1)] ?? 0,
  });
  t.after(() => { store.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return {
    store,
    repo,
    set(value) { now = new Date(value); },
    randomCalls() { return calls; },
  };
}

test('exposes the fixed three-outfit catalog and persists the initial choice across repository restarts', t => {
  const f = fixture(t);
  const first = f.repo().snapshot();
  const restarted = f.repo().snapshot();
  assert.deepEqual(first.catalog.map(({ id, name }) => ({ id, name })), [
    { id: 'everyday', name: '日常格纹' },
    { id: 'soft-knit', name: '温柔针织' },
    { id: 'homewear', name: '舒适居家' },
  ]);
  assert.deepEqual(restarted.current, first.current);
  assert.equal(restarted.revision, 0);
  assert.equal(f.randomCalls(), 1);
});

test('changes at 07:00 Asia/Shanghai rather than local midnight and never repeats the outfit', t => {
  const f = fixture(t, '2026-09-05T15:59:00.000Z', [0, 0]); // 23:59 Shanghai
  const repo = f.repo();
  const initial = repo.snapshot();
  f.set('2026-09-05T16:00:00.000Z'); // 00:00 Shanghai
  assert.equal(repo.snapshot().current.outfitId, initial.current.outfitId);
  f.set('2026-09-05T22:59:59.999Z'); // 06:59:59.999 Shanghai
  assert.equal(repo.snapshot().current.outfitId, initial.current.outfitId);
  f.set('2026-09-05T23:00:00.000Z'); // 07:00 Shanghai
  const changed = repo.snapshot();
  assert.equal(changed.current.outfitId, 'soft-knit');
  assert.equal(changed.current.reason, 'daily');
  assert.equal(changed.revision, 1);
  assert.equal(changed.nextChangeAt, '2026-09-06T23:00:00.000Z');
});

test('skips missed days with one choice at the current time', t => {
  const f = fixture(t, '2026-09-05T23:30:00.000Z', [0, 0]);
  const repo = f.repo();
  repo.snapshot();
  f.set('2026-09-12T04:00:00.000Z');
  const current = repo.snapshot();
  assert.equal(current.current.outfitId, 'soft-knit');
  assert.equal(current.current.changedAt, '2026-09-12T04:00:00.000Z');
  assert.equal(current.nextChangeAt, '2026-09-12T23:00:00.000Z');
  assert.equal(current.revision, 1);
  assert.equal(f.randomCalls(), 2);
});

test('manual choice remains until the next Shanghai 07:00 boundary', t => {
  const f = fixture(t, '2026-09-05T20:00:00.000Z', [0, 0]);
  const repo = f.repo();
  repo.snapshot();
  const manual = repo.update({ outfitId: 'homewear' });
  assert.equal(manual.current.reason, 'manual');
  assert.equal(manual.revision, 1);
  f.set('2026-09-05T22:59:59.999Z');
  assert.equal(repo.snapshot().current.outfitId, 'homewear');
  f.set('2026-09-05T23:00:00.000Z');
  const daily = repo.snapshot();
  assert.equal(daily.current.outfitId, 'everyday');
  assert.equal(daily.revision, 2);
});

test('automatic off and locking both hold the current choice across elapsed days', t => {
  const f = fixture(t, '2026-09-05T20:00:00.000Z', [0, 0, 0]);
  const repo = f.repo();
  repo.snapshot();
  const disabled = repo.update({ automatic: false });
  assert.equal(disabled.nextChangeAt, null);
  f.set('2026-09-10T12:00:00.000Z');
  assert.equal(repo.snapshot().current.outfitId, 'everyday');
  const enabled = repo.update({ automatic: true });
  assert.equal(enabled.current.outfitId, 'everyday');
  assert.equal(enabled.nextChangeAt, '2026-09-10T23:00:00.000Z');
  f.set('2026-09-10T23:00:00.000Z');
  assert.equal(repo.snapshot().current.outfitId, 'soft-knit');
  const locked = repo.update({ locked: true });
  f.set('2026-09-20T12:00:00.000Z');
  assert.equal(repo.snapshot().current.outfitId, locked.current.outfitId);
  assert.equal(repo.snapshot().nextChangeAt, null);
});

test('unlocking automatic mode schedules the next boundary without shuffling immediately', t => {
  const f = fixture(t, '2026-09-05T20:00:00.000Z', [0, 0]);
  const repo = f.repo();
  repo.snapshot();
  repo.update({ locked: true });
  f.set('2026-09-10T12:00:00.000Z');
  const unlocked = repo.update({ locked: false });
  assert.equal(unlocked.current.outfitId, 'everyday');
  assert.equal(unlocked.nextChangeAt, '2026-09-10T23:00:00.000Z');
  assert.equal(f.randomCalls(), 1);
  f.set('2026-09-10T23:00:00.000Z');
  assert.equal(repo.snapshot().current.outfitId, 'soft-knit');
});

test('a caller clock moving backward cannot reverse the selected outfit or schedule', t => {
  const f = fixture(t, '2026-09-05T20:00:00.000Z', [0, 0]);
  const repo = f.repo();
  repo.snapshot();
  f.set('2026-09-05T23:00:00.000Z');
  const advanced = repo.snapshot();
  f.set('2026-09-05T18:00:00.000Z');
  const backward = f.repo().snapshot();
  assert.deepEqual(backward.current, advanced.current);
  assert.equal(backward.nextChangeAt, advanced.nextChangeAt);
  assert.equal(backward.revision, advanced.revision);
  assert.equal(f.randomCalls(), 2);
});

test('strict validation rejects unknown fields and invalid types without mutating metadata', t => {
  const f = fixture(t);
  const repo = f.repo();
  repo.snapshot();
  const before = f.store.db.prepare("SELECT value FROM metadata WHERE key='wardrobe:miyue'").get().value;
  for (const patch of [null, [], { surprise: true }, { outfitId: 'formal' }, { automatic: 1 }, { locked: 'yes' }]) {
    assert.throws(() => repo.update(patch), error => error.status === 400 && error.code === 'INVALID_WARDROBE_UPDATE');
  }
  const after = f.store.db.prepare("SELECT value FROM metadata WHERE key='wardrobe:miyue'").get().value;
  assert.equal(after, before);
});

test('revision changes only for meaningful public state updates and nested transactions are safe', t => {
  const f = fixture(t);
  const repo = f.repo();
  const initial = repo.snapshot();
  assert.equal(repo.update({ outfitId: initial.current.outfitId }).revision, 0);
  assert.equal(repo.update({ automatic: true, locked: false }).revision, 0);
  const nested = f.store.transaction(() => repo.update({ locked: true }));
  assert.equal(nested.revision, 1);
  assert.equal(repo.update({ locked: true }).revision, 1);
});

test('model context is concise and identifies a desktop styling setting without physical claims', t => {
  const f = fixture(t);
  const repo=f.repo();
  for(const outfit of repo.snapshot().catalog){
    repo.update({outfitId:outfit.id});
    const text = repo.context();
    assert.ok(text.length <= 100, `${outfit.id}: ${text.length}`);
    assert.match(text, /林晓薇当前衣着/u);
    assert.doesNotMatch(text, /正在穿|换上|场景/u);
  }
});

test('explicitly reselecting the current outfit at a due boundary holds that choice for the new day',t=>{
  const f=fixture(t,'2026-09-05T20:00:00.000Z',[0,0]);
  const repo=f.repo();
  const initial=repo.snapshot();
  f.set('2026-09-05T23:00:00.000Z');
  const selected=repo.update({outfitId:initial.current.outfitId});
  assert.equal(selected.current.outfitId,initial.current.outfitId);
  assert.equal(selected.nextChangeAt,'2026-09-06T23:00:00.000Z');
  assert.equal(selected.current.reason,'manual');
  assert.equal(f.randomCalls(),1);
});
