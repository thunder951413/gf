#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { loadVisualCatalog, VISUAL_CATALOG_PATH } from '../lib/visual-assets.mjs';

const catalogPath = process.argv[2] ? path.resolve(process.argv[2]) : VISUAL_CATALOG_PATH;
const assetsRoot = path.dirname(catalogPath);
const errors = [];
const inspected = new Map();
const verifiedAssets = new Set();

function problem(kind, message, details = {}) { errors.push({ kind, message, ...details }); }

function safeAssetPath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || relativePath.includes('\0') || path.isAbsolute(relativePath)
      || path.win32.isAbsolute(relativePath) || relativePath.split(/[\\/]/u).includes('..')) return null;
  const candidate = path.resolve(assetsRoot, relativePath);
  const relative = path.relative(assetsRoot, candidate);
  return relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' ? candidate : null;
}

function readPngIHDR(file) {
  const handle = fs.openSync(file, 'r');
  try {
    const header = Buffer.alloc(33);
    const bytes = fs.readSync(handle, header, 0, header.length, 0);
    if (bytes < header.length || header.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || header.toString('ascii', 12, 16) !== 'IHDR') return null;
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20), colorType: header[25] };
  } finally { fs.closeSync(handle); }
}

function inspectPng(relativePath, { kind, requiresAlpha = false } = {}) {
  const key = `${kind}:${requiresAlpha}:${relativePath}`;
  if (inspected.has(key)) return inspected.get(key);
  const file = safeAssetPath(relativePath);
  if (!file) { problem('unsafe-path', `${kind} has an unsafe relative path`, { path: relativePath }); inspected.set(key, false); return false; }
  try {
    const realRoot = fs.realpathSync(assetsRoot);
    const realFile = fs.realpathSync(file);
    const rootRelative = path.relative(realRoot, realFile);
    if (!rootRelative || rootRelative.startsWith(`..${path.sep}`) || rootRelative === '..') {
      problem('unsafe-path', `${kind} resolves outside the visual asset root`, { path: relativePath }); inspected.set(key, false); return false;
    }
    if (!fs.statSync(realFile).isFile()) { problem('missing-file', `${kind} is not a file`, { path: relativePath }); inspected.set(key, false); return false; }
    const ihdr = readPngIHDR(realFile);
    if (!ihdr) { problem('invalid-png', `${kind} is not a PNG with an IHDR chunk`, { path: relativePath }); inspected.set(key, false); return false; }
    if (ihdr.width !== 1024 || ihdr.height !== 1536) problem('invalid-size', `${kind} must be 1024×1536`, { path: relativePath, width: ihdr.width, height: ihdr.height });
    if (requiresAlpha && ![4, 6].includes(ihdr.colorType)) problem('missing-alpha', `${kind} must use PNG grayscale+alpha or RGBA color type`, { path: relativePath, colorType: ihdr.colorType });
    const valid = ihdr.width === 1024 && ihdr.height === 1536 && (!requiresAlpha || [4, 6].includes(ihdr.colorType));
    inspected.set(key, valid); return valid;
  } catch (error) {
    problem('missing-file', `${kind} cannot be read`, { path: relativePath, detail: error.message }); inspected.set(key, false); return false;
  }
}

let catalog;
try { catalog = loadVisualCatalog(catalogPath); } catch (error) { problem('invalid-catalog', error.message, { path: catalogPath }); }

if (catalog) {
  const approved = catalog.assets.filter(asset => asset.status === 'approved');
  const readyScenes = catalog.scenes.filter(scene => scene.status === 'ready');
  for (const asset of approved) {
    if (inspectPng(asset.file, { kind: 'approved-photo', requiresAlpha: true })) verifiedAssets.add(asset.id);
    for (const mask of Array.isArray(asset.recolorMasks) ? asset.recolorMasks : Object.values(asset.recolorMasks ?? {})) inspectPng(mask, { kind: 'recolor-mask' });
  }
  for (const scene of readyScenes) {
    if (!scene.backgroundFile) problem('missing-background', 'ready scene requires a background file', { sceneId: scene.id });
    else inspectPng(scene.backgroundFile, { kind: 'ready-background' });
  }
  const axes = { hairstyles: 'hairstyleId', expressions: 'expressionId', palettes: 'paletteId', outfits: 'outfitId', poses: 'poseId' };
  for (const [axis, field] of Object.entries(axes)) for (const entry of catalog[axis].filter(item => item.status === 'ready')) {
    if (!approved.some(asset => asset[field] === entry.id && verifiedAssets.has(asset.id))) problem('unbacked-ready-entry', 'ready catalog entry has no verified approved photo', { axis, id: entry.id });
  }
  for (const scene of readyScenes) {
    if (!scene.compatibleOutfitIds.some(outfitId => approved.some(asset => asset.outfitId === outfitId && verifiedAssets.has(asset.id)))) problem('unbacked-ready-entry', 'ready scene has no compatible verified approved photo', { axis: 'scenes', id: scene.id });
  }
  const privateOutfits = new Set(catalog.outfits.filter(outfit => outfit.access === 'private').map(outfit => outfit.id));
  for (const scene of readyScenes) for (const outfitId of scene.compatibleOutfitIds) {
    if (privateOutfits.has(outfitId) && scene.privacy !== 'private') problem('private-scene-mismatch', 'private attire can only be compatible with a private scene', { sceneId: scene.id, outfitId });
  }
  console.log(JSON.stringify({
    ok: errors.length === 0,
    catalog: path.relative(process.cwd(), catalogPath) || path.basename(catalogPath),
    approvedOriginals: approved.filter(asset => asset.paletteId === 'original').length,
    approvedRecolors: approved.filter(asset => asset.paletteId !== 'original').length,
    readyScenes: readyScenes.length,
    readyBackgroundReferences: readyScenes.filter(scene => scene.backgroundFile).length,
    uniqueFilesChecked: new Set([...inspected.keys()].map(key => key.split(':').slice(2).join(':'))).size,
    errors,
  }, null, 2));
} else console.log(JSON.stringify({ ok: false, catalog: catalogPath, errors }, null, 2));

process.exitCode = errors.length ? 1 : 0;
