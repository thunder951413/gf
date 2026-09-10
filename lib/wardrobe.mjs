const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_SEVEN_OFFSET_MS = 60 * 60 * 1000;
const STATE_KEY = 'wardrobe:miyue';

export const WARDROBE_CATALOG = Object.freeze([
  Object.freeze({
    id: 'everyday',
    name: '日常格纹',
    description: '棕色与炭灰格纹衬衫外套，内搭象牙白 T 恤，蓝色牛仔裤和白色运动鞋。',
  }),
  Object.freeze({
    id: 'soft-knit',
    name: '温柔针织',
    description: '燕麦色针织开衫，象牙白上衣，灰蓝色中长裙和奶油色平底鞋。',
  }),
  Object.freeze({
    id: 'homewear',
    name: '舒适居家',
    description: '柔和暗玫瑰色宽松棉质长袖居家上衣，奶油色全长居家长裤和米色拖鞋。',
  }),
]);

const CATALOG_BY_ID = new Map(WARDROBE_CATALOG.map(outfit => [outfit.id, outfit]));

function requestError(message) {
  return Object.assign(new Error(message), { status: 400, code: 'INVALID_WARDROBE_UPDATE' });
}

function boundaryPeriod(atMs) {
  // Shanghai is UTC+8. Its 07:00 boundary is 23:00 UTC on the previous day.
  return Math.floor((atMs + SHANGHAI_SEVEN_OFFSET_MS) / DAY_MS);
}

function nextBoundary(atMs) {
  return new Date((boundaryPeriod(atMs) + 1) * DAY_MS - SHANGHAI_SEVEN_OFFSET_MS).toISOString();
}

function validatePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw requestError('衣着设置必须是对象');
  const allowed = new Set(['outfitId', 'automatic', 'locked']);
  if (Object.keys(patch).some(key => !allowed.has(key))) throw requestError('包含未知的衣着设置字段');
  if ('outfitId' in patch && (typeof patch.outfitId !== 'string' || !CATALOG_BY_ID.has(patch.outfitId))) {
    throw requestError('衣着选项无效');
  }
  if ('automatic' in patch && typeof patch.automatic !== 'boolean') throw requestError('自动更换设置无效');
  if ('locked' in patch && typeof patch.locked !== 'boolean') throw requestError('锁定设置无效');
  return patch;
}

function cloneCatalog() {
  return WARDROBE_CATALOG.map(outfit => ({ ...outfit }));
}

export class WardrobeRepository {
  constructor(store, { clock = () => new Date(), random = Math.random } = {}) {
    this.store = store;
    this.clock = clock;
    this.random = random;
  }

  #clockMs() {
    const value = this.clock();
    const at = value instanceof Date ? value : new Date(value);
    if (!Number.isFinite(at.getTime())) throw new TypeError('wardrobe clock must return a valid date');
    return at.getTime();
  }

  #read() {
    const row = this.store.db.prepare('SELECT value FROM metadata WHERE key=?').get(STATE_KEY);
    if (!row) return null;
    try { return JSON.parse(row.value); } catch { return null; }
  }

  #write(state) {
    this.store.db.prepare(`
      INSERT INTO metadata(key,value) VALUES(?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value
    `).run(STATE_KEY, JSON.stringify(state));
  }

  #pick(excludedId = null) {
    const candidates = WARDROBE_CATALOG.filter(outfit => outfit.id !== excludedId);
    const sample = Number(this.random());
    const normalized = Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 0.9999999999999999) : 0;
    return candidates[Math.floor(normalized * candidates.length)] || candidates[0];
  }

  #effectiveNow(state) {
    return Math.max(this.#clockMs(), Date.parse(state?.observedAt || '') || -Infinity);
  }

  #newState(nowMs) {
    const outfit = this.#pick();
    const timestamp = new Date(nowMs).toISOString();
    return {
      automatic: true,
      locked: false,
      outfitId: outfit.id,
      changedAt: timestamp,
      reason: 'initial',
      nextChangeAt: nextBoundary(nowMs),
      revision: 0,
      observedAt: timestamp,
    };
  }

  #loadAtNow() {
    let state = this.#read();
    const nowMs = this.#effectiveNow(state);
    if (!state || !CATALOG_BY_ID.has(state.outfitId)) return { state: this.#newState(nowMs), nowMs, dirty: true };
    const observedAt = new Date(nowMs).toISOString();
    const dirty = state.observedAt !== observedAt;
    if (dirty) state = { ...state, observedAt };
    return { state, nowMs, dirty };
  }

  #advanceDue(state, nowMs) {
    if (!state.automatic || state.locked || !state.nextChangeAt || nowMs < Date.parse(state.nextChangeAt)) return false;
    const outfit = this.#pick(state.outfitId);
    const timestamp = new Date(nowMs).toISOString();
    state.outfitId = outfit.id;
    state.changedAt = timestamp;
    state.reason = 'daily';
    state.nextChangeAt = nextBoundary(nowMs);
    state.revision += 1;
    state.observedAt = timestamp;
    return true;
  }

  #view(state) {
    const outfit = CATALOG_BY_ID.get(state.outfitId);
    return {
      roleId: 'miyue',
      catalog: cloneCatalog(),
      settings: { automatic: state.automatic, locked: state.locked },
      current: {
        outfitId: outfit.id,
        name: outfit.name,
        description: outfit.description,
        changedAt: state.changedAt,
        reason: state.reason,
      },
      nextChangeAt: state.nextChangeAt,
      revision: state.revision,
    };
  }

  snapshot() {
    return this.store.transaction(() => {
      const loaded = this.#loadAtNow();
      if (this.#advanceDue(loaded.state, loaded.nowMs) || loaded.dirty) this.#write(loaded.state);
      return this.#view(loaded.state);
    });
  }

  update(patch) {
    validatePatch(patch);
    return this.store.transaction(() => {
      const loaded = this.#loadAtNow();
      const state = loaded.state;
      const previous = {
        outfitId: state.outfitId,
        automatic: state.automatic,
        locked: state.locked,
      };

      if ('outfitId' in patch) state.outfitId = patch.outfitId;
      if ('automatic' in patch) state.automatic = patch.automatic;
      if ('locked' in patch) state.locked = patch.locked;

      const outfitChanged = state.outfitId !== previous.outfitId;
      const settingsChanged = state.automatic !== previous.automatic || state.locked !== previous.locked;
      const reselectedDue = 'outfitId' in patch && state.nextChangeAt && loaded.nowMs >= Date.parse(state.nextChangeAt);
      if (outfitChanged || settingsChanged || reselectedDue) {
        const timestamp = new Date(loaded.nowMs).toISOString();
        if (outfitChanged || reselectedDue) {
          state.changedAt = timestamp;
          state.reason = 'manual';
        }
        state.nextChangeAt = state.automatic && !state.locked ? nextBoundary(loaded.nowMs) : null;
        state.observedAt = timestamp;
        state.revision += 1;
        this.#write(state);
      } else {
        const advanced = this.#advanceDue(state, loaded.nowMs);
        if (advanced || loaded.dirty) this.#write(state);
      }
      return this.#view(state);
    });
  }

  context() {
    const current = this.snapshot().current;
    return `林雨薇当前衣着：${current.name}（${current.description.replace(/。$/u, '')}）。仅在衣着相关话题中自然参考，不由穿搭推断地点或活动。`;
  }
}
