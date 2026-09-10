import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VISUAL_CATALOG_PATH = fileURLToPath(new URL('../desktop/assets/visual-catalog.json', import.meta.url));

export class VisualCatalogError extends Error {
  constructor(message, code = 'INVALID_VISUAL_CATALOG') {
    super(message);
    this.name = 'VisualCatalogError';
    this.code = code;
  }
}

const ENTITY_ARRAYS = ['hairstyles', 'expressions', 'palettes', 'outfits', 'scenes', 'poses'];
const VALID_ENTITY_STATUS = new Set(['planned', 'ready']);
const VALID_ASSET_STATUS = new Set(['approved', 'draft']);
const ASSET_KEY_FIELDS = ['identityId', 'hairstyleId', 'outfitId', 'poseId', 'expressionId', 'paletteId'];

function assertCatalog(condition, message) {
  if (!condition) throw new VisualCatalogError(message);
}

function assertRequest(condition, message) {
  if (!condition) throw new VisualCatalogError(message, 'INVALID_VISUAL_REQUEST');
}

function byId(items) {
  return new Map(items.map(item => [item.id, item]));
}

function isSafeRelativePath(file) {
  return typeof file === 'string'
    && file.length > 0 && !file.includes('\0')
    && !path.isAbsolute(file)
    && !path.win32.isAbsolute(file)
    && !file.split(/[\\/]/u).includes('..');
}

function normalizedRequest(request, catalog) {
  assertRequest(request && typeof request === 'object' && !Array.isArray(request), 'visual request must be an object');
  const identityId = request.identityId ?? catalog.identity.id;
  const { hairstyleId, outfitId, poseId, sceneId } = request;
  const indexes = catalogIndexes(catalog);
  assertRequest(identityId === catalog.identity.id, `unknown identityId: ${identityId}`);
  assertRequest(typeof hairstyleId === 'string' && indexes.hairstyles.has(hairstyleId), `unknown hairstyleId: ${hairstyleId}`);
  assertRequest(typeof outfitId === 'string' && indexes.outfits.has(outfitId), `unknown outfitId: ${outfitId}`);
  assertRequest(typeof poseId === 'string' && indexes.poses.has(poseId), `unknown poseId: ${poseId}`);
  const expressionId = request.expressionId ?? indexes.poses.get(poseId).defaultExpressionId;
  assertRequest(typeof expressionId === 'string' && indexes.expressions.has(expressionId), `unknown expressionId: ${expressionId}`);
  const paletteId = request.paletteId ?? 'original';
  assertRequest(typeof paletteId === 'string' && indexes.palettes.has(paletteId), `unknown paletteId: ${paletteId}`);
  if(request.color !== undefined) {
    const color=indexes.palettes.get(paletteId).colorHex;
    assertRequest(typeof request.color==='string' && /^#[0-9a-f]{6}$/iu.test(request.color) && color?.toLowerCase()===request.color.toLowerCase(), 'color must match its declared palette');
  }
  if (sceneId !== undefined) {
    assertRequest(typeof sceneId === 'string' && indexes.scenes.has(sceneId), `unknown sceneId: ${sceneId}`);
    assertRequest(indexes.scenes.get(sceneId).compatibleOutfitIds.includes(outfitId), `outfit ${outfitId} is incompatible with scene ${sceneId}`);
  }
  return { identityId, hairstyleId, outfitId, poseId, expressionId, paletteId, ...(sceneId === undefined ? {} : { sceneId }), ...(request.color === undefined ? {} : { color: request.color }) };
}

function catalogIndexes(catalog) {
  return {
    hairstyles: byId(catalog.hairstyles),
    expressions: byId(catalog.expressions),
    palettes: byId(catalog.palettes),
    outfits: byId(catalog.outfits),
    scenes: byId(catalog.scenes),
    poses: byId(catalog.poses),
  };
}

function exactAsset(request, catalog) {
  return catalog.assets.find(asset => asset.status === 'approved'
    && ASSET_KEY_FIELDS.every(field => asset[field] === request[field])) || null;
}

function fallbackAsset(request, catalog) {
  // Preserve identity, hairstyle, and pose. Changing either hair or pose would falsely label a photo.
  const candidates = catalog.assets.filter(asset => asset.status === 'approved'
    && asset.identityId === request.identityId
    && asset.hairstyleId === request.hairstyleId
    && asset.poseId === request.poseId
    && (request.sceneId === undefined || catalog.scenes.find(scene => scene.id === request.sceneId).compatibleOutfitIds.includes(asset.outfitId)));
  return candidates.find(asset => asset.outfitId === request.outfitId && asset.expressionId === request.expressionId)
    || candidates.find(asset => asset.outfitId === request.outfitId)
    || candidates.find(asset => asset.expressionId === request.expressionId)
    || candidates[0]
    || null;
}

function assetSupportsColor(asset, color) {
  if (!color || !asset.recolorMasks) return false;
  if (Array.isArray(asset.recolorMasks)) return asset.recolorMasks.length > 0;
  return typeof asset.recolorMasks === 'object' && Object.keys(asset.recolorMasks).length > 0;
}

export function loadVisualCatalog(file = VISUAL_CATALOG_PATH) {
  let catalog;
  try {
    catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new VisualCatalogError(`could not load visual catalog: ${error.message}`);
  }
  return validateVisualCatalog(catalog);
}

export function validateVisualCatalog(catalog) {
  assertCatalog(catalog && typeof catalog === 'object' && !Array.isArray(catalog), 'catalog must be an object');
  assertCatalog(catalog.version === 1, 'catalog version must be 1');
  assertCatalog(catalog.identity && typeof catalog.identity === 'object', 'catalog identity is required');
  assertCatalog(typeof catalog.identity.id === 'string' && catalog.identity.id.length > 0, 'identity id is required');
  assertCatalog(typeof catalog.identity.name === 'string' && catalog.identity.name.length > 0, 'identity name is required');
  assertCatalog(Number.isInteger(catalog.identity.age) && catalog.identity.age >= 18, 'identity age must be an adult integer');

  for (const field of ENTITY_ARRAYS) {
    const entities = catalog[field];
    assertCatalog(Array.isArray(entities) && entities.length > 0, `${field} must be a non-empty array`);
    const ids = new Set();
    for (const entity of entities) {
      assertCatalog(entity && typeof entity === 'object', `${field} contains an invalid entity`);
      assertCatalog(typeof entity.id === 'string' && entity.id.length > 0 && !ids.has(entity.id), `${field} ids must be unique`);
      ids.add(entity.id);
      assertCatalog(typeof entity.name === 'string' && entity.name.length > 0, `${field}/${entity.id} needs a name`);
      assertCatalog(VALID_ENTITY_STATUS.has(entity.status), `${field}/${entity.id} has invalid status`);
    }
  }

  const indexes = catalogIndexes(catalog);
  for (const scene of catalog.scenes) {
    assertCatalog(Array.isArray(scene.compatibleOutfitIds) && scene.compatibleOutfitIds.length > 0, `scene ${scene.id} needs compatible outfits`);
    for (const outfitId of scene.compatibleOutfitIds) assertCatalog(indexes.outfits.has(outfitId), `scene ${scene.id} references unknown outfit ${outfitId}`);
    if (scene.backgroundFile !== undefined) assertCatalog(isSafeRelativePath(scene.backgroundFile), `scene ${scene.id} has an unsafe background file`);
    if (scene.placement !== undefined) {
      const { origin, x, y, width, height } = scene.placement;
      assertCatalog(origin === 'top-left', `scene ${scene.id} placement origin must be top-left`);
      for (const [name, value] of Object.entries({ x, y, width, height })) {
        assertCatalog(Number.isFinite(value) && value >= 0 && value <= 1, `scene ${scene.id} placement ${name} must be normalized`);
      }
    }
    if (scene.atmosphere !== undefined) assertCatalog(['none', 'rain', 'snow'].includes(scene.atmosphere), `scene ${scene.id} has invalid atmosphere`);
    for (const field of ['placement','weatherRegion']) if (scene[field] !== undefined) {
      const r=scene[field];
      assertCatalog(r && [r.x,r.y,r.width,r.height].every(Number.isFinite) && r.x>=0 && r.y>=0 && r.width>0 && r.height>0 && r.x+r.width<=1.0001 && r.y+r.height<=1.0001, `scene ${scene.id} ${field} must be a normalized rectangle`);
    }
  }
  for (const pose of catalog.poses) {
    assertCatalog(typeof pose.defaultExpressionId === 'string' && indexes.expressions.has(pose.defaultExpressionId), `pose ${pose.id} needs a known default expression`);
  }

  assertCatalog(Array.isArray(catalog.assets), 'assets must be an array');
  const seenAssetKeys = new Set();
  const assetIds = new Set();
  for (const asset of catalog.assets) {
    assertCatalog(asset && typeof asset === 'object', 'assets contains an invalid entry');
    assertCatalog(typeof asset.id === 'string' && asset.id.length > 0 && !assetIds.has(asset.id), 'asset ids must be unique and stable');
    assetIds.add(asset.id);
    assertCatalog(VALID_ASSET_STATUS.has(asset.status), 'asset has invalid status');
    assertCatalog(asset.identityId === catalog.identity.id, 'asset identity must match catalog identity');
    assertCatalog(indexes.hairstyles.has(asset.hairstyleId), `asset references unknown hairstyle ${asset.hairstyleId}`);
    assertCatalog(indexes.outfits.has(asset.outfitId), `asset references unknown outfit ${asset.outfitId}`);
    assertCatalog(indexes.poses.has(asset.poseId), `asset references unknown pose ${asset.poseId}`);
    assertCatalog(indexes.expressions.has(asset.expressionId), `asset references unknown expression ${asset.expressionId}`);
    assertCatalog(indexes.palettes.has(asset.paletteId), `asset references unknown palette ${asset.paletteId}`);
    const key = ASSET_KEY_FIELDS.map(field => asset[field]).join('/');
    assertCatalog(!seenAssetKeys.has(key), `duplicate visual asset: ${key}`);
    seenAssetKeys.add(key);
    if (asset.file !== undefined) assertCatalog(isSafeRelativePath(asset.file), `asset file must be a safe relative path: ${asset.file}`);
    if (asset.status === 'approved') {
      assertCatalog(typeof asset.file === 'string' && isSafeRelativePath(asset.file), 'approved asset requires a safe file');
      assertCatalog(Number.isInteger(asset.width) && asset.width > 0, 'approved asset requires a positive width');
      assertCatalog(Number.isInteger(asset.height) && asset.height > 0, 'approved asset requires a positive height');
    }
    if (asset.recolorMasks !== undefined) {
      assertCatalog(Array.isArray(asset.recolorMasks) || (asset.recolorMasks && typeof asset.recolorMasks === 'object'), 'recolorMasks must be an array or object');
      for (const mask of Array.isArray(asset.recolorMasks) ? asset.recolorMasks : Object.values(asset.recolorMasks)) {
        assertCatalog(isSafeRelativePath(mask), `recolor mask must be a safe relative path: ${mask}`);
      }
    }
  }
  return catalog;
}

export function resolveVisualAsset(request, catalog = loadVisualCatalog()) {
  validateVisualCatalog(catalog);
  const requested = normalizedRequest(request, catalog);
  const exact = exactAsset(requested, catalog);
  if (exact) return { requested, rendered: { ...requested }, asset: exact, reason: 'exact-approved' };

  const fallback = fallbackAsset(requested, catalog);
  if (fallback) {
    const paletteReuse = fallback.outfitId === requested.outfitId
      && fallback.expressionId === requested.expressionId
      && fallback.paletteId !== requested.paletteId
      && assetSupportsColor(fallback, requested.color ?? requested.paletteId);
    const rendered = {
      ...requested,
      outfitId: fallback.outfitId,
      expressionId: fallback.expressionId,
      paletteId: fallback.paletteId,
      color: undefined,
    };
    delete rendered.color;
    return {
      requested,
      rendered,
      asset: fallback,
      reason: paletteReuse ? 'recolor-required' : 'fallback-approved',
      ...(paletteReuse ? {transform: {kind:'masked-recolor', paletteId:requested.paletteId, color:requested.color, masks:fallback.recolorMasks}} : {}),
    };
  }
  return { requested, rendered: null, asset: null, reason: 'no-approved-asset' };
}

export function planMissingAssets(requests, catalog = loadVisualCatalog()) {
  validateVisualCatalog(catalog);
  assertRequest(Array.isArray(requests), 'visual requests must be an array');
  const jobs = new Map();
  for (const request of requests) {
    const requested = normalizedRequest(request, catalog);
    if (exactAsset(requested, catalog)) continue;
    const reusable = fallbackAsset(requested, catalog);
    const paletteReuse = reusable
      && reusable.outfitId === requested.outfitId
      && reusable.expressionId === requested.expressionId
      && reusable.paletteId !== requested.paletteId
      && assetSupportsColor(reusable, requested.color ?? requested.paletteId);

    const key = ASSET_KEY_FIELDS.map(field => requested[field]).join('/');
    if (!jobs.has(key)) {
      jobs.set(key, {
        identityId: requested.identityId,
        hairstyleId: requested.hairstyleId,
        outfitId: requested.outfitId,
        poseId: requested.poseId,
        expressionId: requested.expressionId,
        paletteId: requested.paletteId,
        status: 'planned',
        requiresGeneration: !paletteReuse,
        ...(paletteReuse ? {operation:'masked-recolor',sourceAssetId:reusable.id} : {}),
      });
    }
  }
  return [...jobs.values()];
}
