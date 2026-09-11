const MAX_LATE_MS = 2 * 60 * 60 * 1000;

const PRESETS = Object.freeze({
  'manicure:recent': { mood: 3, stress: -2 },
  'shopping:arrived': { mood: 3 },
  'pet:recent': { mood: 3, stress: -2 },
  'friend_chat:recent': { stress: -3, mood: 2 },
  'cooking:recent': { fatigue: 2, mood: 3 },
  'plants:recent': { stress: -2 },
  'outfit:recent': { mood: 2 },
  'music_exercise:recent': { fatigue: -3, stress: -2 },
});

const PHASE_ORDER = Object.freeze({ paused: 0, doing: 1, browsing: 1, waiting: 2, arrived: 3, recent: 4 });
const validText = (value, maximum) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const validDate = value => Number.isFinite(Date.parse(value));

export function dailyEffectFor(eventView) {
  if (!eventView || typeof eventView !== 'object') return null;
  const { id, kind, title, phase, startedAt } = eventView;
  if (!validText(String(id ?? ''), 160) || !validText(kind, 80) || !validText(title, 160) || !validText(phase, 80) || !validDate(startedAt)) return null;
  const changes = PRESETS[`${kind}:${phase}`];
  if (!changes) return null;
  return { id: `daily:${id}:${phase}`, title, phase, at: startedAt, changes: { ...changes } };
}

export class DailyLifeEffects {
  constructor(store, inner, { clock = () => new Date() } = {}) {
    if (!store?.db || typeof store.transaction !== 'function') throw new TypeError('DailyLifeEffects requires a Store');
    if (!inner || typeof inner.applyDailyEffect !== 'function') throw new TypeError('DailyLifeEffects requires InnerStateRepository');
    if (typeof clock !== 'function') throw new TypeError('clock must be a function');
    this.store = store;
    this.inner = inner;
    this.clock = clock;
    store.db.exec(`CREATE TABLE IF NOT EXISTS daily_life_effect_phases (
      event_id TEXT PRIMARY KEY, phase TEXT NOT NULL, observed_at TEXT NOT NULL
    )`);
  }

  #observed(eventId) {
    return this.store.db.prepare('SELECT phase FROM daily_life_effect_phases WHERE event_id=?').get(eventId)?.phase || null;
  }

  #record(eventId, phase, now) {
    this.store.db.prepare(`INSERT INTO daily_life_effect_phases(event_id,phase,observed_at) VALUES(?,?,?)
      ON CONFLICT(event_id) DO UPDATE SET phase=excluded.phase, observed_at=excluded.observed_at`).run(eventId, phase, now.toISOString());
  }

  advance(events) {
    const now = new Date(this.clock());
    if (Number.isNaN(now.getTime())) throw new TypeError('clock must return a valid date');
    if (!Array.isArray(events)) return [];
    return this.store.transaction(() => {
      const applied = [];
      for (const event of events) {
        if (!event || typeof event !== 'object' || !validText(String(event.id ?? ''), 160) || !validText(event.phase, 80)) continue;
        const id = String(event.id);
        const previous = this.#observed(id);
        const effect = dailyEffectFor(event);
        const transitioned = previous !== null && previous !== event.phase
          && (PHASE_ORDER[previous] ?? -1) < (PHASE_ORDER[event.phase] ?? -1);
        const timely = effect && Date.parse(effect.at) <= now.getTime() && now.getTime() - Date.parse(effect.at) <= MAX_LATE_MS;
        if (effect && transitioned && timely && this.inner.applyDailyEffect(effect)) applied.push(effect);
        // A first observation is a baseline. Persist a phase only when it has
        // changed, so steady polling does not churn the observation row.
        if (previous !== event.phase) this.#record(id, event.phase, now);
      }
      return applied;
    });
  }
}
