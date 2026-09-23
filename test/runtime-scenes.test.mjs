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

test('manual quick switch bypasses interval, excludes the shown image and retains matching cutout rules',()=>{
 const f=fixture(['a','b','c'].map(id=>item({id,desktopEligible:true,cutoutUrl:`/api/image-library/files/${id}.png`})));
 const r=runtime();r.settings.imageRotationMinutes=0;
 const first=f.scenes.sync(r);const second=f.scenes.sync(r,{force:true});
 assert.notEqual(second.itemId,first.itemId);
 assert.equal(f.scenes.sync(r).itemId,second.itemId,'following automatic poll retains the manual switch');
 r.settings.automaticScenes=false;r.settings.imageVariant='original';
 f.scenes.sync(r);
 const third=f.scenes.sync(r,{force:true});assert.notEqual(third.itemId,second.itemId);assert.equal(third.avatarMode,'cutout');
 assert.equal(r.settings.automaticScenes,false,'quick switch does not enable automatic rotation');
});

test('manual switch with no alternative preserves the current image and metadata',()=>{
 const f=fixture([item({desktopEligible:true})]);const r=runtime();f.scenes.sync(r);
 const before=structuredClone(f.images),state=f.scenes.read();
 assert.throws(()=>f.scenes.sync(r,{force:true}),{status:409});
 assert.deepEqual(f.images,before);assert.deepEqual(f.scenes.read(),state);
 const empty=fixture([item({desktopEligible:false})]);const old=structuredClone(empty.images);
 assert.throws(()=>empty.scenes.sync(r,{force:true}),{status:409});assert.deepEqual(empty.images,old);
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

test('five activity-matched cutouts rotate uniquely before any repeat',()=>{
 const items=['a','b','c','d','e'].map(id=>item({id,name:id,activities:['work'],desktopEligible:true,cutoutUrl:`/api/image-library/files/${id}.png`}));
 const f=fixture(items),r=runtime();r.settings.imageRotationMinutes=1;const seen=[];
 for(let minute=0;minute<5;minute++){r.at=`2026-09-10T02:0${minute}:00.000Z`;seen.push(f.scenes.sync(r).itemId);}
 assert.equal(new Set(seen).size,5);assert.equal(f.scenes.read().fallbackUsed,false);
});

test('multi-activity tags select an exact activity before the awake fallback',()=>{
 const specific=item({id:'reader',name:'读书的人',activities:['reading','work'],desktopEligible:true,cutoutUrl:'/api/image-library/files/reader.png'});
 const generic=item({id:'generic',name:'人物',activities:['idle'],environment:'any',desktopEligible:true,cutoutUrl:'/api/image-library/files/generic.png'});
 const f=fixture([specific,generic]),r=runtime('reading');
 assert.equal(f.scenes.sync(r).itemId,'reader');assert.equal(f.scenes.read().fallbackUsed,false);
 const walking=runtime('walk');assert.equal(f.scenes.sync(walking).itemId,'generic');assert.equal(f.scenes.read().fallbackUsed,true);
});

test('the canonical runtime kind wins over incidental title keywords',()=>{
 const cafe=item({id:'cafe',activities:['cafe'],desktopEligible:true,cutoutUrl:'/api/image-library/files/cafe.png'});
 const reader=item({id:'reader',activities:['reading'],desktopEligible:true,cutoutUrl:'/api/image-library/files/reader.png'});
 const f=fixture([cafe,reader]),r=runtime('cafe');r.current.title='咖啡馆读书';
 assert.equal(f.scenes.sync(r).itemId,'cafe');assert.equal(f.scenes.read().activityGroup,'cafe');
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

test('automatic selection passes the actual current location to scoped outfits',()=>{
 const homeFigure=item({id:'private',desktopEligible:true,locationScope:'home'});
 const generic=item({id:'generic',desktopEligible:true});
 const f=fixture([homeFigure,generic]),r=runtime();r.current.location='咖啡馆';
 assert.equal(f.scenes.sync(r).itemId,'generic');
 r.current.location='家里卧室';
 assert.equal(f.scenes.sync(r).itemId,'private');
 const swim=fixture([item({id:'swim',desktopEligible:true,locationScope:'waterfront',environment:'outdoor'})]),outside=runtime('travel');
 outside.current.location='城市旅行中';assert.equal(swim.scenes.sync(outside).avatarMode,'fallback');
 outside.current.location='海边沙滩';assert.equal(swim.scenes.sync(outside).itemId,'swim');
});
