import test from 'node:test';
import assert from 'node:assert/strict';
import { RuntimeScenes, imageSeason, imageEnvironment } from '../lib/runtime-scenes.mjs';

function fixture(items) {
  let saved = '{}';
  const images = { enabled: true, activeSceneId: 'study', scenes: [{ id: 'study', imageUrl: '/api/scene-images/files/old.png', fit: 'cover' }] };
  const applied = [];
  const store = { db: { prepare: () => ({ get: () => ({ value: saved }), run: (_key, value) => { saved = value; } }) } };
  const sceneImages = { snapshot: () => structuredClone(images), update: patch => Object.assign(images, patch) };
  const imageLibrary = {
    snapshot: () => ({ items }),
    apply: patch => {
      applied.push(patch);
      const item = items.find(item => item.id === patch.id);
      images.enabled = true; images.activeSceneId = patch.sceneId;
      images.scenes = [{ id: patch.sceneId, imageUrl: (item.cutoutUrl || item.originalUrl).replace('/api/image-library/', '/api/scene-images/'), fit: patch.fit }];
    },
  };
  return { scenes: new RuntimeScenes(store, { sceneImages, imageLibrary }), images, applied };
}
const runtime = (kind = 'work', sceneId = 'study') => ({at:'2026-09-10T02:00:00.000Z', settings: { enabled: true, automaticScenes: true }, current: { id: `day:${kind}`, kind, title: kind, sceneId } });
const item = (extra = {}) => ({ id: 'figure', name: '工作人物', sceneIds: ['study'], activity: 'work', tags: [], background: 'keep', cutoutUrl: '/api/image-library/files/figure.png', ...extra });

test('old unreviewed cutouts cannot enter automatic desktop selection', () => {
  const f = fixture([item()]);
  assert.equal(f.scenes.sync(runtime()).avatarMode, 'fallback');
  assert.equal(f.images.enabled, false);
  assert.equal(f.applied.length, 0);
});

test('eligible matching assets use contain, stay stable, and stop displaying after eligibility is removed', () => {
  const figure = item({ desktopEligible: true });
  const f = fixture([figure]);
  const selected = f.scenes.sync(runtime());
  assert.equal(selected.itemId, figure.id);
  assert.equal(f.applied[0].fit, 'contain');
  assert.deepEqual(f.scenes.sync(runtime()), selected);
  assert.equal(f.applied.length, 1);
  figure.desktopEligible = false;
  assert.equal(f.scenes.sync(runtime()).avatarMode, 'fallback');
  assert.equal(f.images.enabled, false);
});

test('a sleep-only picture is never used for work just because it shares the scene', () => {
  const f = fixture([item({ activity: 'sleep', desktopEligible: true })]);
  assert.equal(f.scenes.sync(runtime()).avatarMode, 'fallback');
  assert.equal(f.applied.length, 0);
  assert.equal(f.scenes.sync(runtime('sleep')).avatarMode, 'cutout');
});

test('an automatic activity without a mapped scene clears an obsolete uploaded image', () => {
  const f = fixture([]);
  assert.equal(f.scenes.sync(runtime('travel', null)).avatarMode, 'fallback');
  assert.equal(f.images.enabled, false);
});

test('manual image choices remain untouched by automatic eligibility', () => {
  const f = fixture([]);
  const value = runtime(); value.settings.automaticScenes = false;
  assert.equal(f.scenes.sync(value).mode, 'manual');
  assert.equal(f.images.enabled, true);
  assert.equal(f.applied.length, 0);
});

test('rotation waits for the interval, consumes all candidates before repeating and persists across restart',()=>{
 const items=['a','b','c'].map(id=>item({id,name:id,desktopEligible:true,cutoutUrl:`/api/image-library/files/${id}.png`}));
 const f=fixture(items),r=runtime();r.settings.imageRotationMinutes=20;
 const seen=[f.scenes.sync(r).itemId];
 r.at='2026-09-10T02:19:59.000Z';assert.equal(f.scenes.sync(r).itemId,seen[0]);assert.equal(f.applied.length,1);
 const reopened=new RuntimeScenes(f.scenes.store,{sceneImages:f.scenes.sceneImages,imageLibrary:f.scenes.imageLibrary});
 assert.equal(reopened.sync(r).itemId,seen[0]);
 r.at='2026-09-10T02:20:00.000Z';seen.push(reopened.sync(r).itemId);
 r.at='2026-09-10T02:40:00.000Z';seen.push(reopened.sync(r).itemId);assert.equal(new Set(seen).size,3);
 r.at='2026-09-10T03:00:00.000Z';assert.notEqual(reopened.sync(r).itemId,seen.at(-1));
});

test('season and environment overrides filter photos and do not modify actual runtime state',()=>{
 const photos=[['fall-in','autumn','indoor'],['winter-out','winter','outdoor'],['winter-in','winter','indoor']].map(([id,season,environment])=>item({id,name:id,seasons:[season],environment,originalUrl:`/api/image-library/files/${id}.png`,cutoutUrl:null,desktopEligible:false}));
 const f=fixture(photos),r=runtime();r.settings.imageVariant='original';
 assert.equal(f.scenes.sync(r).itemId,'fall-in');
 r.settings.imageSeason='winter';r.settings.imageEnvironment='outdoor';const before=structuredClone(r);
 assert.equal(f.scenes.sync(r).itemId,'winter-out');assert.deepEqual(r,before);
 r.settings.imageVariant='cutout';assert.equal(f.scenes.sync(r).avatarMode,'fallback','unapproved originals are not silently used in cutout mode');
});

test('single candidate stays stable, long absence switches only once, removal switches immediately',()=>{
 const items=[item({desktopEligible:true})],f=fixture(items),r=runtime();const first=f.scenes.sync(r);
 r.at='2026-10-10T02:00:00.000Z';const next=f.scenes.sync(r);assert.equal(next.itemId,first.itemId);assert.equal(f.applied.length,1);assert.equal(next.candidateCount,1);
 items.push(item({id:'new',desktopEligible:true,cutoutUrl:'/api/image-library/files/new.png'}));items[0].desktopEligible=false;
 assert.equal(f.scenes.sync(r).itemId,'new');assert.equal(f.applied.length,2);
});

test('zero interval pins within matching conditions and original transparent assets use the original file',()=>{
 const original=item({desktopEligible:true,background:'transparent',cutoutUrl:null,originalUrl:'/api/image-library/files/transparent.png'});
 const f=fixture([original]),r=runtime();r.settings.imageRotationMinutes=0;
 const first=f.scenes.sync(r);assert.equal(first.variant,'original');assert.equal(first.avatarMode,'cutout');assert.equal(first.nextRotationAt,null);
 r.at='2026-09-11T02:00:00.000Z';assert.equal(f.scenes.sync(r).selectedAt,first.selectedAt);assert.equal(f.applied.length,1);
});

test('automatic season uses Shanghai date boundaries and indoor travel stays indoors',()=>{
 assert.equal(imageSeason('2026-02-28T15:59:59Z'),'winter');
 assert.equal(imageSeason('2026-02-28T16:00:00Z'),'spring');
 assert.equal(imageSeason('2026-05-31T16:00:00Z'),'summer');
 assert.equal(imageEnvironment({current:{kind:'sleep',location:'海边酒店'}}),'indoor');
 assert.equal(imageEnvironment({current:{kind:'rest',location:'海边酒店的露台'}}),'outdoor');
 assert.equal(imageEnvironment({current:{kind:'work',location:'咖啡馆'}}),'indoor');
});
