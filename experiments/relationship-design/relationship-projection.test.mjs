import assert from 'node:assert/strict';
import test from 'node:test';
import { relationshipEvents, projectionOptions } from './fixtures.mjs';
import { projectRelationship, relationshipContext } from './relationship-projection.mjs';

test('projects corrected facts, current boundaries, open agreements, and scoped self facts', () => {
  const result = projectRelationship(relationshipEvents, projectionOptions);
  assert.deepEqual(result.user.preferences.map((entry) => entry.value), [
    'Prefers check-ins only when there is something concrete to share.',
  ]);
  assert.deepEqual(result.user.boundaries.map((entry) => entry.value), ['Do not use romantic pet names.']);
  assert.equal(result.agreements[0].status, 'open');
  assert.equal(result.agreements[0].overdue, true);
  assert.equal(result.agreements[0].value.text, 'Send the promised reading list.');
  assert.equal(result.agreements[0].latestUpdateNote, 'I intend to send it soon.');
  assert.equal(result.agreements[0].unverifiedCompletionClaim.sourceMessageId, 'm019');
  assert.deepEqual(result.character.preferences.map((entry) => entry.key), ['hometown-food']);
  assert.equal(relationshipContext(result).includes('Another character loves dumplings.'), false);
  assert.equal(relationshipContext(result).includes('Other user prefers hourly check-ins.'), false);
});

test('keeps persistent boundaries and expires only explicitly time-bounded ones', () => {
  const during = projectRelationship(relationshipEvents, { ...projectionOptions, asOf: '2026-08-07T20:00:00Z' });
  const atEnd = projectRelationship(relationshipEvents, { ...projectionOptions, asOf: '2026-08-08T00:00:00Z' });
  const after = projectRelationship(relationshipEvents, { ...projectionOptions, asOf: '2026-08-08T01:00:00Z' });
  assert.deepEqual(during.user.boundaries.map((entry) => entry.value), [
    { text: 'For tonight, use my name only, without any pet names.', persistence: 'temporary', untilAt: '2026-08-08T00:00:00Z' },
  ]);
  assert.deepEqual(atEnd.user.boundaries.map((entry) => entry.value), ['Do not use romantic pet names.']);
  assert.deepEqual(after.user.boundaries.map((entry) => entry.value), ['Do not use romantic pet names.']);
});

test('counts distinct active dates, caps same-day spam, and ignores elapsed empty days', () => {
  const early = projectRelationship(relationshipEvents, { ...projectionOptions, asOf: '2026-08-01T23:59:59Z' });
  const beforeReentry = projectRelationship(relationshipEvents, { ...projectionOptions, asOf: '2026-08-19T23:59:59Z' });
  const reentry = projectRelationship(relationshipEvents, projectionOptions);
  assert.equal(early.familiarity.distinctActiveDays, 1);
  assert.equal(beforeReentry.familiarity.distinctActiveDays, 7);
  assert.equal(reentry.familiarity.distinctActiveDays, 8);
  assert.equal(beforeReentry.familiarity.distinctActiveDays, projectRelationship(relationshipEvents, {
    ...projectionOptions, asOf: '2026-08-10T00:00:00Z',
  }).familiarity.distinctActiveDays);
});

test('character-only activity cannot grow user-participation familiarity', () => {
  const before = projectRelationship(relationshipEvents, { ...projectionOptions, asOf: '2026-08-03T23:59:59Z' });
  const afterCharacterOnlyDay = projectRelationship(relationshipEvents, { ...projectionOptions, asOf: '2026-08-04T23:59:59Z' });
  assert.equal(afterCharacterOnlyDay.familiarity.distinctActiveDays, before.familiarity.distinctActiveDays);
});

test('is idempotent by sourceMessageId and rejects conflicting reuse', () => {
  const result = projectRelationship(relationshipEvents, projectionOptions);
  assert.equal(result.processedSourceMessageIds.filter((id) => id === 'm022').length, 1);
  const conflict = relationshipEvents.map((event) => event.sourceMessageId === 'm001'
    ? { ...event, value: 'conflicting payload' }
    : event);
  assert.throws(() => projectRelationship([...relationshipEvents, ...conflict], projectionOptions), /conflicting duplicate/);
});

test('reset creates a deletion barrier and a later explicit fact may start fresh', () => {
  const forgotten = projectRelationship(relationshipEvents, projectionOptions);
  assert.equal(forgotten.sharedReferences.some((entry) => entry.key === 'thread-music'), false);
  assert.equal(forgotten.tombstones.some((entry) => entry.key === 'thread-music'), true);

  const later = projectRelationship([...relationshipEvents, {
    subjectId: 'user-a', characterId: 'lin-yuwei', sourceMessageId: 'm025', actor: 'user',
    timestamp: '2026-08-21T08:00:00Z', type: 'shared_reference', key: 'thread-music',
    value: 'User explicitly introduced a new piano-listening reference.',
  }], { ...projectionOptions, asOf: '2026-08-21T09:00:00Z' });
  assert.equal(later.sharedReferences.some((entry) => entry.key === 'thread-music'), true);
  assert.equal(later.tombstones.some((entry) => entry.key === 'thread-music'), true);
  assert.equal(later.sharedReferences.find((entry) => entry.key === 'thread-music').evidence.sourceMessageId, 'm025');
});

test('character intent and passing time do not fulfill an agreement', () => {
  const result = projectRelationship(relationshipEvents, { ...projectionOptions, asOf: '2026-09-30T00:00:00Z' });
  assert.equal(result.agreements[0].status, 'open');
  assert.equal(result.agreements[0].overdue, true);
});

test('participation dates use the companion local timezone at midnight', () => {
  const events = ['2026-09-01T15:59:00Z', '2026-09-01T16:01:00Z'].map((timestamp, index) => ({
    subjectId: 'user-a', characterId: 'lin-yuwei', sourceMessageId: `midnight-${index}`,
    actor: 'user', timestamp, type: 'ordinary_contact', key: 'hello', value: 'contact',
  }));
  const result = projectRelationship(events, { ...projectionOptions, asOf: '2026-09-02T00:00:00Z', timeZone: 'Asia/Shanghai' });
  assert.deepEqual(result.familiarity.activeDates, ['2026-09-01', '2026-09-02']);
});
