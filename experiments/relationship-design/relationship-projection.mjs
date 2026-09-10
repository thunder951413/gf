const EVENT_TYPES = new Set([
  'preference',
  'boundary',
  'agreement',
  'agreement_update',
  'shared_reference',
  'ordinary_contact',
  'reset',
]);

const SEMANTIC_TYPES = new Set(['preference', 'boundary', 'agreement', 'shared_reference']);

function invalid(message) {
  throw new TypeError(message);
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) invalid('event must be an object');
  for (const field of ['sourceMessageId', 'subjectId', 'characterId', 'timestamp', 'type', 'key']) {
    if (typeof raw[field] !== 'string' || !raw[field].trim()) invalid(`${field} must be a non-empty string`);
  }
  if (!['user', 'character'].includes(raw.actor)) invalid('actor must be user or character');
  if (!EVENT_TYPES.has(raw.type)) invalid(`unsupported event type: ${raw.type}`);
  if (!Object.hasOwn(raw, 'value')) invalid('event must include value');
  const date = new Date(raw.timestamp);
  if (Number.isNaN(date.valueOf())) invalid(`invalid timestamp: ${raw.timestamp}`);
  return {
    sourceMessageId: raw.sourceMessageId.trim(),
    subjectId: raw.subjectId.trim(),
    characterId: raw.characterId.trim(),
    actor: raw.actor,
    timestamp: date.toISOString(),
    type: raw.type,
    key: raw.key.trim(),
    value: structuredClone(raw.value),
  };
}

function dayInZone(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function evidence(event) {
  return {
    sourceMessageId: event.sourceMessageId,
    actor: event.actor,
    timestamp: event.timestamp,
  };
}

function record(event, type = event.type) {
  return {
    type,
    key: event.key,
    value: structuredClone(event.value),
    evidence: evidence(event),
  };
}

function textOf(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text.trim();
  return stable(value);
}

function statusOf(value) {
  return value && typeof value === 'object' && typeof value.status === 'string' ? value.status : 'open';
}

function dueOf(value) {
  if (!value || typeof value !== 'object' || typeof value.dueAt !== 'string') return null;
  const date = new Date(value.dueAt);
  return Number.isNaN(date.valueOf()) ? null : date.toISOString();
}

function boundaryActive(entry, asOf) {
  if (!entry.value || typeof entry.value !== 'object' || entry.value.persistence !== 'temporary') return true;
  const until = new Date(entry.value.untilAt);
  return !Number.isNaN(until.valueOf()) && until > asOf;
}

function mapValues(map) {
  return [...map.values()].sort((left, right) => left.key.localeCompare(right.key));
}

function effectiveBoundaries(store, actor, asOf) {
  const selected = new Map();
  for (const entry of mapValues(store).filter((item) => item.evidence.actor === actor && boundaryActive(item, asOf))) {
    const temporary = entry.value?.persistence === 'temporary';
    if (temporary || !selected.has(entry.key)) selected.set(entry.key, entry);
  }
  return mapValues(selected);
}

function semanticKey(type, actor, key, slot = '') {
  return `${type}\u001f${actor}\u001f${key}\u001f${slot}`;
}

function storageKey(event) {
  const slot = event.type === 'boundary' && event.value?.persistence === 'temporary' ? 'temporary' : 'persistent';
  return semanticKey(event.type, event.actor, event.key, slot);
}

function appliesToReset(event, type, actor) {
  const config = event.value && typeof event.value === 'object' ? event.value : {};
  const types = Array.isArray(config.targetTypes) ? config.targetTypes : [...SEMANTIC_TYPES];
  const targetActor = config.targetActor || event.actor;
  return types.includes(type) && targetActor === actor;
}

/**
 * Projects already-normalized semantic events. This deliberately does no natural-language extraction.
 */
export function projectRelationship(rawEvents, {
  subjectId,
  characterId,
  asOf,
  timeZone = 'UTC',
} = {}) {
  if (typeof subjectId !== 'string' || !subjectId || typeof characterId !== 'string' || !characterId) {
    invalid('subjectId and characterId are required');
  }
  const asOfDate = new Date(asOf ?? Date.now());
  if (Number.isNaN(asOfDate.valueOf())) invalid('asOf must be a valid date');

  const normalized = rawEvents.map(normalizeEvent);
  const byMessage = new Map();
  for (const event of normalized) {
    const previous = byMessage.get(event.sourceMessageId);
    if (previous && stable(previous) !== stable(event)) invalid(`conflicting duplicate sourceMessageId: ${event.sourceMessageId}`);
    if (!previous) byMessage.set(event.sourceMessageId, event);
  }

  const events = [...byMessage.values()]
    .filter((event) => event.subjectId === subjectId && event.characterId === characterId)
    .filter((event) => new Date(event.timestamp) <= asOfDate)
    .sort((left, right) => left.timestamp.localeCompare(right.timestamp)
      || left.sourceMessageId.localeCompare(right.sourceMessageId));

  const stores = {
    preference: new Map(),
    boundary: new Map(),
    agreement: new Map(),
    shared_reference: new Map(),
  };
  const tombstones = new Map();
  const activeDays = new Set();

  for (const event of events) {
    if (event.type !== 'reset' && event.actor === 'user') activeDays.add(dayInZone(event.timestamp, timeZone));

    if (event.type === 'reset') {
      for (const [type, store] of Object.entries(stores)) {
        for (const actor of ['user', 'character']) {
          if (!appliesToReset(event, type, actor)) continue;
          for (const [storedKey, stored] of store) {
            if (stored.key === event.key && stored.evidence.actor === actor) store.delete(storedKey);
          }
          tombstones.set(semanticKey(type, actor, event.key), {
            type,
            key: event.key,
            actor,
            resetBy: evidence(event),
          });
        }
      }
      continue;
    }

    if (event.type === 'ordinary_contact') continue;

    if (event.type === 'agreement_update') {
      const target = stores.agreement.get(semanticKey('agreement', 'user', event.key, 'persistent'));
      if (!target) continue;
      const update = event.value && typeof event.value === 'object' ? event.value : { status: String(event.value) };
      const requestedStatus = statusOf(update);
      const completionProven = requestedStatus !== 'fulfilled' || event.actor === 'user';
      const { text: updateText, ...updateFields } = update;
      target.value = {
        ...(target.value && typeof target.value === 'object' ? target.value : { text: textOf(target.value) }),
        ...structuredClone(updateFields),
        status: completionProven ? requestedStatus : 'open',
      };
      target.latestUpdate = evidence(event);
      if (typeof updateText === 'string') target.latestUpdateNote = updateText;
      if (!completionProven) target.unverifiedCompletionClaim = evidence(event);
      continue;
    }

    if (!SEMANTIC_TYPES.has(event.type)) continue;
    // An agreement is shared product state only after user-side acceptance/statement.
    if (event.type === 'agreement' && event.actor !== 'user') continue;
    const key = storageKey(event);
    stores[event.type].set(key, record(event));
    tombstones.delete(key);
  }

  const agreements = mapValues(stores.agreement).map((entry) => {
    const dueAt = dueOf(entry.value);
    return {
      ...entry,
      status: statusOf(entry.value),
      dueAt,
      overdue: statusOf(entry.value) === 'open' && Boolean(dueAt) && new Date(dueAt) < asOfDate,
    };
  });

  return {
    scope: { subjectId, characterId },
    asOf: asOfDate.toISOString(),
    timeZone,
    familiarity: {
      distinctActiveDays: activeDays.size,
      activeDates: [...activeDays].sort(),
    },
    user: {
      preferences: mapValues(stores.preference).filter((entry) => entry.evidence.actor === 'user'),
      boundaries: effectiveBoundaries(stores.boundary, 'user', asOfDate),
    },
    character: {
      preferences: mapValues(stores.preference).filter((entry) => entry.evidence.actor === 'character'),
      boundaries: effectiveBoundaries(stores.boundary, 'character', asOfDate),
    },
    agreements,
    sharedReferences: mapValues(stores.shared_reference),
    tombstones: mapValues(tombstones),
    processedSourceMessageIds: events.map((event) => event.sourceMessageId),
  };
}

function factLines(label, entries) {
  if (!entries.length) return [];
  return [label, ...entries.map((entry) => `- ${textOf(entry.value)} [${entry.evidence.sourceMessageId}]`)];
}

export function relationshipContext(projection) {
  const lines = ['【Concrete relationship context; synthetic projection】'];
  lines.push(...factLines('Known user preferences:', projection.user.preferences));
  lines.push(...factLines('Current user boundaries:', projection.user.boundaries));
  const open = projection.agreements.filter((entry) => entry.status === 'open');
  if (open.length) {
    lines.push('Open agreements:');
    for (const entry of open) {
      lines.push(`- ${textOf(entry.value)}${entry.overdue ? ' (due date passed; still open, with no completion evidence)' : ''} [${entry.evidence.sourceMessageId}]`);
    }
  }
  lines.push(...factLines('Shared references:', projection.sharedReferences));
  if (projection.character.preferences.length || projection.character.boundaries.length) {
    lines.push('Character self-references (never user facts):');
    for (const entry of [...projection.character.preferences, ...projection.character.boundaries]) {
      lines.push(`- ${textOf(entry.value)} [${entry.evidence.sourceMessageId}]`);
    }
  }
  const dates = projection.familiarity.activeDates;
  lines.push(`User participation evidence: ${dates.length} distinct active date${dates.length === 1 ? '' : 's'}${dates.length ? ` (${dates.join(', ')})` : ''}.`);
  return lines.join('\n');
}
