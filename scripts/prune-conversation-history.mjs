import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { HistoryEdits } from '../lib/history-edits.mjs';

// A reviewed extractive edit manifest contains source hashes and kept ranges.
// Default is a dry run in memory. Neither mode deletes chat transcripts.
const args = process.argv.slice(2);
const option = name => args.includes(name) ? args[args.indexOf(name) + 1] : null;
if (!option('--reviewed')) {
  console.log('node scripts/prune-conversation-history.mjs --reviewed /path/edits.json [--database data/life.sqlite] [--apply]');
  process.exit(0);
}
const edits = JSON.parse(fs.readFileSync(option('--reviewed'), 'utf8'));
const database = path.resolve(option('--database') || 'data/life.sqlite');
const applying = args.includes('--apply');
const db = new DatabaseSync(database, { readOnly: !applying });
const folder = path.resolve('.runtime/history-backups');
fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
const snapshot = path.join(folder, `${Date.now()}-${process.pid}.sqlite`);
try {
  await backup(db, snapshot); fs.chmodSync(snapshot, 0o600);
  // Validate against a private clone before changing the real database.
  const scratch = new DatabaseSync(snapshot);
  const storeFor = conn => ({ db: conn, transaction(fn) {
    conn.exec('BEGIN IMMEDIATE');
    try { const result = fn(); conn.exec('COMMIT'); return result; }
    catch (error) { conn.exec('ROLLBACK'); throw error; }
  } });
  try {
    const repo = new HistoryEdits(storeFor(scratch)); repo.set('miyue', edits);
    console.log(JSON.stringify({ mode: applying ? 'apply' : 'preview', ...repo.stats('miyue') }));
  } finally { scratch.close(); }
  if (applying) {
    // Replace the validation clone with the untouched pre-edit database backup.
    fs.rmSync(snapshot); await backup(db, snapshot); fs.chmodSync(snapshot, 0o600);
    const repo = new HistoryEdits(storeFor(db)); repo.set('miyue', edits);
    fs.writeFileSync(snapshot + '.edits.json', JSON.stringify(edits, null, 2), { mode: 0o600 });
    console.log('Original backup: ' + snapshot);
  }
} finally { db.close(); if (!applying) fs.rmSync(snapshot, { force: true }); }
