import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { reunionFact } from '../lib/session-context.mjs';
import { workCalendar } from '../lib/work-calendar.mjs';

function storeWith(rows) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE messages(id TEXT PRIMARY KEY,role TEXT,speaker TEXT,text TEXT,created_at TEXT)');
  rows.forEach(([speaker, at], i) => db.prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(`m${i}`, 'miyue', speaker, '…', at));
  return { db };
}

test('coming back after four days tells her how long he was gone and that her last messages went unanswered', () => {
  const store = storeWith([['user', '2026-10-21T11:32:13Z'], ['assistant', '2026-10-21T12:07:56Z']]);
  const fact = reunionFact(store, 'miyue', new Date('2026-10-25T00:39:42Z'));
  assert.equal(fact.hoursSinceHisLastMessage, 85);
  assert.match(fact.note, /约3天前，之后你发的消息他没回/);
});

test('an ordinary night between messages is not treated as a reunion', () => {
  const store = storeWith([['user', '2026-10-20T09:43:44Z'], ['assistant', '2026-10-20T10:44:18Z']]);
  assert.equal(reunionFact(store, 'miyue', new Date('2026-10-20T23:49:55Z')), null);
  assert.equal(reunionFact(storeWith([]), 'miyue', new Date()), null);
});

test('the calendar fact names the weekday so she does not guess it', () => {
  assert.equal(workCalendar('2026-10-14T03:00:00Z').weekday, '周三');
  assert.equal(workCalendar('2026-10-18T16:30:00Z').weekday, '周一', 'Shanghai time decides the day');
});
