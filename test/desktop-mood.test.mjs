import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { desktopMood, pickForMood } from '../lib/desktop-mood.mjs';
import { AppearanceRepository } from '../lib/appearance.mjs';

const asset = (hairstyleId, outfitId, poseId, expressionId, paletteId = 'original') => ({ id: `${hairstyleId}-${outfitId}-${poseId}-${expressionId}`, hairstyleId, outfitId, poseId, expressionId, paletteId, status: 'approved', file: 'x.png' });
const ASSETS = [
  asset('original-long', 'everyday', 'idle', 'soft-smile'), asset('original-long', 'everyday', 'reading', 'neutral'),
  asset('original-long', 'homewear', 'idle', 'soft-smile'), asset('original-long', 'homewear', 'cup', 'concerned'), asset('original-long', 'homewear', 'stretch', 'pout'), asset('original-long', 'homewear', 'sleeping', 'tired'),
  asset('bob', 'soft-knit', 'wave', 'happy'), asset('bob', 'soft-knit', 'idle', 'soft-smile'),
  asset('original-long', 'lingerie', 'idle', 'soft-smile'),
];
const NOON = new Date('2026-10-27T04:00:00Z'), NIGHT = new Date('2026-10-27T13:00:00Z'); // 12:00 / 21:00 Shanghai

test('her strongest feeling becomes the desktop mood', () => {
  assert.equal(desktopMood({ now: new Date('2026-10-27T20:00:00Z') }).id, 'sleepy');
  assert.equal(desktopMood({ affect: { hurt: 60, warmth: 80, causes: [{ towardHer: 'dismissive', why: '他回了三个嗯' }] }, now: NOON }).id, 'hurt');
  assert.equal(desktopMood({ affect: { hurt: 0, desire: 80, warmth: 50 }, now: NIGHT }).id, 'longing');
  assert.equal(desktopMood({ affect: { hurt: 0, desire: 80, warmth: 50 }, now: NOON }).id, 'calm', 'longing is an evening thing');
  assert.equal(desktopMood({ affect: { hurt: 0, desire: 20, warmth: 50 }, pulse: { level: 70, hoursSinceHim: 12 }, now: NOON }).why, '他约12小时没说话');
  assert.equal(desktopMood({ affect: { hurt: 0, desire: 20, warmth: 85, causes: [{ towardHer: 'tender', why: '他说她最重要' }] }, now: NOON }).id, 'happy');
});

test('a mood picks a real photo, keeping her hairstyle and only changing outfit when it is worth it', () => {
  const current = ASSETS[0];
  assert.equal(pickForMood(ASSETS, { mood: { id: 'missing', intensity: 0.4 }, current, hour: 12 }).id, 'original-long-everyday-reading-neutral', 'weak mood at noon stays in today\'s look');
  assert.equal(pickForMood(ASSETS, { mood: { id: 'missing', intensity: 0.8 }, current, hour: 12 }).id, 'original-long-homewear-cup-concerned', 'strong mood may change outfit');
  assert.equal(pickForMood(ASSETS, { mood: { id: 'hurt', intensity: 0.4 }, current, hour: 21 }).id, 'original-long-homewear-stretch-pout', 'evening at home');
  assert.equal(pickForMood(ASSETS, { mood: { id: 'happy', intensity: 0.9 }, current, hour: 12 }).id, 'original-long-everyday-idle-soft-smile', 'the waving photo has another hairstyle, so she keeps smiling in her own look');
  assert.equal(pickForMood(ASSETS, { mood: { id: 'calm', intensity: 0 }, current }), null);
});

test('the desktop follows her feelings, returns to today\'s look when calm, and never overrides a lock', () => {
  const db = new DatabaseSync(':memory:'); db.exec('CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  const store = { db, transaction: fn => fn() };
  const catalog = { assets: ASSETS, outfits: [{ id: 'everyday' }, { id: 'homewear' }, { id: 'soft-knit' }, { id: 'lingerie', access: 'private' }], scenes: [], hairstyles: [{ id: 'original-long', name: '长发' }], palettes: [{ id: 'original', name: '原色' }] };
  let now = NIGHT, state = { affect: { hurt: 70, warmth: 40, desire: 30, causes: [{ towardHer: 'dismissive', why: '他说你烦不烦' }] }, pulse: { level: 10, hoursSinceHim: 0 } };
  const repo = new AppearanceRepository(store, { clock: () => now, catalog, getState: () => state });
  let snap = repo.snapshot();
  now = new Date(+now + 4 * 60000); snap = repo.snapshot();
  assert.equal(snap.current.assetId, 'original-long-homewear-stretch-pout'); assert.equal(snap.mood.id, 'hurt'); assert.equal(snap.mood.why, '他说你烦不烦');
  now = new Date(+now + 60000); state = { affect: { hurt: 5, warmth: 50, desire: 30 }, pulse: { level: 10 } };
  assert.equal(repo.snapshot().current.assetId, 'original-long-homewear-stretch-pout', 'holds at least three minutes');
  now = new Date(+now + 4 * 60000);
  assert.equal(repo.snapshot().current.outfitId, 'everyday', 'calm again: back to the look of the day');
  repo.update({ locked: true });
  state = { affect: { hurt: 90, warmth: 10, desire: 10 }, pulse: { level: 0 } }; now = new Date(+now + 10 * 60000);
  assert.equal(repo.snapshot().current.outfitId, 'everyday', 'a locked look never changes');
  assert.ok(!repo.snapshot().current.assetId.includes('lingerie'));
});
