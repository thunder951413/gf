// Prints the weekly aliveness report (read-only).
//   node scripts/weekly-report.mjs [--db data/life.sqlite] [--days 7] [--json]
import { DatabaseSync } from 'node:sqlite';
import { weeklyReport, reportMarkdown } from '../lib/weekly-report.mjs';

const args = process.argv.slice(2), value = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const db = new DatabaseSync(value('--db') || 'data/life.sqlite', { readOnly: !args.includes('--writable') });
let report;
try { report = weeklyReport(db, { days: Number(value('--days')) || 7 }); }
catch (error) {
  // A read-only database cannot create the feedback table on first use.
  if (!/readonly|no such table/i.test(String(error.message))) throw error;
  db.close();
  const writable = new DatabaseSync(value('--db') || 'data/life.sqlite');
  report = weeklyReport(writable, { days: Number(value('--days')) || 7 });
  writable.close();
}
process.stdout.write(args.includes('--json') ? JSON.stringify(report, null, 2) + '\n' : reportMarkdown(report));
