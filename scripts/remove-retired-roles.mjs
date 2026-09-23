import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const roles = JSON.parse(readFileSync(path.join(root, 'app-data/roles.json'), 'utf8'));
if (roles.length !== 1 || roles[0].id !== 'miyue' || roles[0].name !== '林晓薇') {
  throw new Error('Expected the single Lin Xiaowei role before retiring old data');
}
const databasePath = path.resolve(process.argv[2] || path.join(root, 'data/life.sqlite'));
const db = new DatabaseSync(databasePath);
db.exec('PRAGMA foreign_keys=ON; BEGIN IMMEDIATE');
try {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
  const retiredMessages = "SELECT id FROM messages WHERE role IN ('wenxi','zhixia') OR kind='story'";
  let deleted = 0;
  for (const table of tables) {
    if (table === 'messages') continue;
    const columns = db.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name);
    const linked = columns.filter(column => /(?:^|_)message_id$/.test(column));
    for (const column of linked) {
      deleted += db.prepare(`DELETE FROM "${table}" WHERE "${column}" IN (${retiredMessages})`).run().changes;
    }
  }
  for (const table of tables) {
    if (table === 'messages') continue;
    const columns = db.prepare(`PRAGMA table_info("${table}")`).all().map(row => row.name);
    const predicates = [];
    for (const column of ['role', 'role_id']) if (columns.includes(column)) predicates.push(`"${column}" IN ('wenxi','zhixia') OR "${column}" LIKE 'wenxi::%' OR "${column}" LIKE 'zhixia::%'`);
    if (columns.includes('scope')) predicates.push("scope IN ('wenxi','zhixia') OR scope LIKE 'wenxi::%' OR scope LIKE 'zhixia::%'");
    if (table === 'story_state' || table === 'story_history') predicates.push('1=1');
    if (table.startsWith('scenario_')) predicates.push('1=1');
    if (predicates.length) deleted += db.prepare(`DELETE FROM "${table}" WHERE ${predicates.map(value => `(${value})`).join(' OR ')}`).run().changes;
  }
  deleted += db.prepare("DELETE FROM messages WHERE role IN ('wenxi','zhixia') OR kind='story'").run().changes;
  const invalid = db.prepare('PRAGMA foreign_key_check').all();
  if (invalid.length) throw new Error(`Foreign key check failed: ${JSON.stringify(invalid.slice(0, 3))}`);
  db.exec('COMMIT');
  db.exec('VACUUM');
  console.log(JSON.stringify({ databasePath, deleted, roles: db.prepare('SELECT role,COUNT(*) count FROM messages GROUP BY role').all() }));
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
} finally {
  db.close();
}
