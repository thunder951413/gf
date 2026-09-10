import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {beijingLocalToIso, isoToBeijingLocal} from '../public/runtime.js';

test('runtime planner treats datetime-local input as Beijing time', () => {
  assert.equal(beijingLocalToIso('2026-09-09T20:30'),'2026-09-09T12:30:00.000Z');
  assert.equal(isoToBeijingLocal('2026-09-09T12:30:00.000Z'),'2026-09-09T20:30');
  assert.equal(beijingLocalToIso('2026-02-30T20:30'),null);
});

test('runtime planner exposes a dated outing with a character-only location field', () => {
  const html = fs.readFileSync(new URL('../public/runtime.html', import.meta.url), 'utf8');
  assert.match(html, /value="outing"[^>]*>出门活动/u);
  assert.match(html, /id="plan-location"/u);
  assert.match(html, /datetime-local/u);
});
