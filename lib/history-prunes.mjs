// Reversible pruning of distilled history (COMPANION-ALIVENESS.md P0 follow-up).
// Raw messages are never touched: a prune only hides one distilled record
// (a daily core-record item or a growth note) from everything built on top of
// it. Deleting the row restores it.
export const PRUNE_TARGETS = Object.freeze(['daily_item', 'growth']);

export function ensurePruneTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS history_prunes(
    role_id TEXT NOT NULL, target TEXT NOT NULL, ref TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY(role_id,target,ref))`);
}

export function prunedRefs(db, roleId, target) {
  ensurePruneTable(db);
  return new Set(db.prepare('SELECT ref FROM history_prunes WHERE role_id=? AND target=?').all(roleId, target).map(row => row.ref));
}

export const dailyItemRef = (chunkId, index) => `${chunkId}:${index}`;
