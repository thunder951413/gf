import test from 'node:test';
import assert from 'node:assert/strict';
import { loadVisualCatalog, planMissingAssets, resolveVisualAsset, validateVisualCatalog } from '../lib/visual-assets.mjs';

const catalog = loadVisualCatalog();
// Stable legacy fixture makes missing-combination tests independent of newly approved photos.
catalog.assets=catalog.assets.filter(a=>a.file.startsWith('wardrobe-v1/'));

const originalRequest = {
  identityId: 'lin-yuwei-v1',
  hairstyleId: 'original-long',
  outfitId: 'everyday',
  poseId: 'idle',
  expressionId: 'soft-smile',
  paletteId: 'original',
};

test('legacy fixture has six accepted photos without implying a cartesian product', () => {
  assert.equal(catalog.assets.filter(asset => asset.status === 'approved').length, 6);
  assert.equal(new Set(catalog.assets.map(a=>a.hairstyleId)).size,1);
  assert.equal(catalog.assets.some(asset => asset.outfitId === 'lingerie'), false);
});

test('private clothing is only compatible with the private bedroom scene', () => {
  const lingerieScenes = catalog.scenes
    .filter(scene => scene.compatibleOutfitIds.includes('lingerie'))
    .map(scene => scene.id);
  assert.deepEqual(lingerieScenes, ['private-bedroom']);
  assert.throws(() => resolveVisualAsset({ ...originalRequest, outfitId: 'lingerie', sceneId: 'study' }, catalog), /incompatible/u);
});

test('an approved exact request keeps its original requested and rendered identifiers', () => {
  const result = resolveVisualAsset(originalRequest, catalog);
  assert.equal(result.reason, 'exact-approved');
  assert.deepEqual(result.requested, originalRequest);
  assert.deepEqual(result.rendered, originalRequest);
  assert.equal(result.asset.file, 'wardrobe-v1/cutouts/everyday-idle.png');
});

test('fallback never mislabels a missing hairstyle or pose', () => {
  const hair = resolveVisualAsset({ ...originalRequest, hairstyleId: 'bob' }, catalog);
  const pose = resolveVisualAsset({ ...originalRequest, poseId: 'wave' }, catalog);
  assert.equal(hair.asset, null);
  assert.equal(hair.rendered, null);
  assert.equal(pose.asset, null);
  assert.equal(pose.rendered, null);
});

test('an omitted expression uses the pose default and an expression fallback states what will render', () => {
  const defaulted = resolveVisualAsset({ ...originalRequest, expressionId: undefined }, catalog);
  assert.equal(defaulted.requested.expressionId, 'soft-smile');
  const requested = { ...originalRequest, expressionId: 'happy' };
  const fallback = resolveVisualAsset(requested, catalog);
  assert.equal(fallback.requested.expressionId, 'happy');
  assert.equal(fallback.rendered.expressionId, 'soft-smile');
  assert.equal(fallback.reason, 'fallback-approved');
});

test('a recolor mask can satisfy a color-only request without scheduling generation', () => {
  const masked = structuredClone(catalog);
  masked.assets[0].recolorMasks = { shirt: 'wardrobe-v1/masks/everyday-shirt.png' };
  const requested = { ...originalRequest, paletteId: 'dusty-blue', color: '#93A6C3' };
  const result = resolveVisualAsset(requested, masked);
  assert.equal(result.reason, 'recolor-required');
  assert.equal(result.asset.outfitId, 'everyday');
  assert.equal(result.rendered.outfitId, 'everyday');
  assert.equal(result.rendered.paletteId, 'original');
  assert.equal(result.transform.paletteId,'dusty-blue');
  const jobs=planMissingAssets([requested,requested],masked);
  assert.equal(jobs.length,1); assert.equal(jobs[0].requiresGeneration,false); assert.equal(jobs[0].operation,'masked-recolor');
});

test('planning is deduplicated and independent of scenes', () => {
  const requested = { ...originalRequest, outfitId: 'academic', sceneId: 'study' };
  const elsewhere = { ...requested, sceneId: 'autumn-cafe' };
  assert.deepEqual(planMissingAssets([requested, elsewhere], catalog), [{
    identityId: 'lin-yuwei-v1',
    hairstyleId: 'original-long',
    outfitId: 'academic',
    poseId: 'idle',
    expressionId: 'soft-smile',
    paletteId: 'original',
    status: 'planned',
    requiresGeneration: true,
  }]);
});

test('generation planning keeps missing expressions as separate jobs', () => {
  const happy = { ...originalRequest, outfitId: 'academic', expressionId: 'happy' };
  const shy = { ...happy, expressionId: 'shy' };
  assert.equal(planMissingAssets([happy, shy], catalog).length, 2);
});

test('asset ids are stable and a parent can add normalized scene presentation fields', () => {
  assert.match(catalog.assets[2].id, /^original-long-soft-knit-idle-soft-smile-original$/u);
  const withBackground = structuredClone(catalog);
  withBackground.scenes[0].backgroundFile = 'scenes/study.png';
  withBackground.scenes[0].placement = { origin: 'top-left', x: 0.25, y: 0.1, width: 0.5, height: 0.8 };
  withBackground.scenes[0].atmosphere = 'none';
  withBackground.scenes[0].weatherRegion = {x:0,y:0,width:.2,height:.5};
  assert.equal(validateVisualCatalog(withBackground), withBackground);
});

test('unknown identifiers and unsafe or incomplete approved assets are rejected', () => {
  assert.throws(() => resolveVisualAsset({ ...originalRequest, outfitId: 'unknown' }, catalog), /unknown outfitId/u);
  const traversal = structuredClone(catalog);
  traversal.assets[0].file = '../outside.png';
  assert.throws(() => validateVisualCatalog(traversal), /safe relative path/u);
  const noDimensions = structuredClone(catalog);
  delete noDimensions.assets[0].width;
  assert.throws(() => validateVisualCatalog(noDimensions), /positive width/u);
});

test('every approved photo declares its checked dimensions', () => {
  for (const asset of catalog.assets.filter(asset => asset.status === 'approved')) {
    assert.equal(asset.width, 1024);
    assert.equal(asset.height, 1536);
  }
});

test('fallback is scene compatible and invalid weather geometry is rejected',()=>{
 const c=structuredClone(catalog);c.scenes[0].compatibleOutfitIds=['academic'];
 assert.equal(resolveVisualAsset({...originalRequest,outfitId:'academic',sceneId:'study'},c).asset,null);
 c.scenes[0].weatherRegion={x:.9,y:0,width:.3,height:1};
 assert.throws(()=>validateVisualCatalog(c),/normalized rectangle/);
});

test('a freeform color cannot mislabel an existing photograph',()=>{
 assert.throws(()=>resolveVisualAsset({...originalRequest,color:'#ff0000'},catalog),/declared palette/);
});
