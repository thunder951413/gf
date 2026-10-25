// These rows represent transcripts written before the delivery cap existed.
// Keep the counter trigger active, then restore the guard for new deliveries.
export function importHistoricalMessages(store, seed) {
  return store.transaction(() => {
    const guard = store.db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='messages_unanswered_limit'").get();
    store.db.exec('DROP TRIGGER IF EXISTS messages_unanswered_limit');
    try { return seed(); }
    finally { if (guard) store.db.exec(guard.sql); }
  });
}
