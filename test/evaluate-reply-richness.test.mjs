import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const script = path.resolve('scripts/evaluate-reply-richness.mjs');

test('reply-richness replay is opt-in and documents bounded invocation', () => {
  const normal = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(normal.status, 0);
  assert.match(normal.stdout, /Use --run --label <label>/);
  const help = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--cases affection,lunch,open-chat/);
  assert.match(help.stdout, /never\nwrites data\/life\.sqlite/);
});
