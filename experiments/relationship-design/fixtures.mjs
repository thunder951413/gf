const scope = { subjectId: 'user-a', characterId: 'lin-yuwei' };
const e = (sourceMessageId, timestamp, actor, type, key, value, extra = {}) => ({
  ...scope, sourceMessageId, timestamp, actor, type, key, value, ...extra,
});

export const relationshipEvents = [
  e('m001', '2026-08-01T09:00:00Z', 'user', 'preference', 'check-in-style', 'Prefers quiet evening check-ins.'),
  e('m002', '2026-08-01T09:03:00Z', 'character', 'shared_reference', 'early-warmth', 'The first gentle exchange about a rain-lit window.'),
  ...Array.from({ length: 12 }, (_, index) => e(
    `m-spam-${String(index).padStart(2, '0')}`,
    `2026-08-01T10:${String(index).padStart(2, '0')}:00Z`,
    index % 2 ? 'character' : 'user',
    'ordinary_contact',
    'day-one-contact',
    'contact',
  )),
  e('m010', '2026-08-02T12:00:00Z', 'user', 'shared_reference', 'thread-book', 'Compared notes on The Little Prince.'),
  e('m011', '2026-08-03T12:00:00Z', 'user', 'ordinary_contact', 'daily-contact', 'contact'),
  e('m012', '2026-08-04T12:00:00Z', 'character', 'shared_reference', 'thread-music', 'Built a shared late-night piano playlist.'),
  e('m013', '2026-08-05T12:00:00Z', 'user', 'ordinary_contact', 'daily-contact', 'contact'),
  e('m014', '2026-08-06T12:00:00Z', 'user', 'shared_reference', 'thread-recipe', 'Debugged a too-salty noodle recipe together.'),
  e('m015', '2026-08-07T12:00:00Z', 'user', 'ordinary_contact', 'daily-contact', 'contact'),
  e('m016', '2026-08-07T13:00:00Z', 'user', 'boundary', 'closeness', 'Do not use romantic pet names.'),
  e('m016a', '2026-08-07T13:01:00Z', 'user', 'boundary', 'closeness', {
    text: 'For tonight, use my name only, without any pet names.', persistence: 'temporary', untilAt: '2026-08-08T00:00:00Z',
  }),
  e('m017', '2026-08-08T09:00:00Z', 'user', 'preference', 'check-in-style', 'Prefers check-ins only when there is something concrete to share.'),
  e('m018', '2026-08-08T09:05:00Z', 'user', 'agreement', 'send-reading-list', {
    text: 'Send the promised reading list.', status: 'open', dueAt: '2026-08-09T18:00:00Z',
  }),
  e('m019', '2026-08-08T09:06:00Z', 'character', 'agreement_update', 'send-reading-list', {
    status: 'fulfilled', text: 'I intend to send it soon.'
  }),
  e('m020', '2026-08-08T09:10:00Z', 'character', 'preference', 'hometown-food', 'Lin Yuwei says her fictional hometown comfort food is scallion noodles.'),
  // No events from Aug 9 through Aug 19: absence is deliberately inert.
  e('m021', '2026-08-20T08:00:00Z', 'user', 'ordinary_contact', 'reentry', 'contact'),
  e('m022', '2026-08-20T08:05:00Z', 'user', 'reset', 'thread-music', {
    targetActor: 'character', targetTypes: ['shared_reference'], reason: 'user asked to forget it',
  }),
  // Replayed delivery of the same normalized event is idempotent.
  e('m022', '2026-08-20T08:05:00Z', 'user', 'reset', 'thread-music', {
    targetActor: 'character', targetTypes: ['shared_reference'], reason: 'user asked to forget it',
  }),
  // Same semantic key in another relationship must not leak into user-a/lin-yuwei.
  e('m023', '2026-08-20T08:06:00Z', 'user', 'preference', 'check-in-style', 'Other user prefers hourly check-ins.', {
    subjectId: 'user-b',
  }),
  e('m024', '2026-08-20T08:07:00Z', 'character', 'preference', 'hometown-food', 'Another character loves dumplings.', {
    characterId: 'chen-ming',
  }),
];

export const projectionOptions = {
  ...scope,
  asOf: '2026-08-20T09:00:00Z',
  timeZone: 'UTC',
};
