import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const script = path.resolve('scripts/evaluate-conversation-quality.mjs');
function validate(file, ...args) {
  return spawnSync(process.execPath, [script, '--validate-scenarios', '--scenario-file', file, ...args], { encoding: 'utf8' });
}

test('scenario-file validation accepts reusable chat and desktop scenarios without starting a replay', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-quality-scenarios-'));
  const fixture = path.join(folder, 'scenarios.json');
  fs.writeFileSync(fixture, JSON.stringify({ scenarios: [
    { id: 'ordinary_update', text: '刚忙完一件事，想歇五分钟。' },
    { id: 'desktop_attention', text: null },
  ] }));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const result = validate(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { valid: true, scenarios: 2, timedTurns: 0, source: fixture });
});

test('scenario-file validation rejects null chat text before a live model replay', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-quality-scenarios-'));
  const fixture = path.join(folder, 'bad-scenarios.json');
  fs.writeFileSync(fixture, JSON.stringify([{ id: 'ordinary_update', text: null }]));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const result = validate(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /只有 desktop\* 或 scheduled 可以使用 null text/);
});

test('scenario-file validation accepts monotonic per-turn times in object and tuple forms', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-quality-scenarios-'));
  const fixture = path.join(folder, 'timed-scenarios.json');
  fs.writeFileSync(fixture, JSON.stringify({ scenarios: [
    { id: 'before_midnight', text: '今天先到这里。', at: '2026-09-14T15:50:00Z' },
    ['after_midnight', '第二天再接着聊。', '2026-09-14T16:10:00Z'],
  ] }));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const result = validate(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    valid: true,
    scenarios: 2,
    timedTurns: 2,
    replayAt: ['2026-09-14T15:50:00.000Z', '2026-09-14T16:10:00.000Z'],
    source: fixture,
  });
});

test('scenario-file validation holds the latest simulated time across omitted at values', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-quality-scenarios-'));
  const fixture = path.join(folder, 'mixed-times.json');
  fs.writeFileSync(fixture, JSON.stringify([
    { id: 'first', text: '第一轮。', at: '2026-09-14T15:50:00Z' },
    { id: 'same_time', text: '第二轮省略时间。' },
    ['advance', '第三轮推进时间。', '2026-09-14T16:10:00Z'],
    ['still_advanced', '第四轮继续省略时间。'],
  ]));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const result = validate(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).replayAt, [
    '2026-09-14T15:50:00.000Z',
    '2026-09-14T15:50:00.000Z',
    '2026-09-14T16:10:00.000Z',
    '2026-09-14T16:10:00.000Z',
  ]);
});

test('scenario-file validation rejects invalid or backward per-turn times before live replay', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-quality-scenarios-'));
  const fixture = path.join(folder, 'backward-scenarios.json');
  fs.writeFileSync(fixture, JSON.stringify([
    ['later', '第一轮。', '2026-09-15T00:10:00Z'],
    { id: 'earlier', text: '第二轮。', at: '2026-09-15T00:00:00Z' },
  ]));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const result = validate(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /at 不可早于前一指定时间/);
});

test('scenario-file validation rejects an at before the --clock baseline', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-quality-scenarios-'));
  const fixture = path.join(folder, 'before-clock.json');
  fs.writeFileSync(fixture, JSON.stringify([
    ['too_early', '第一轮。', '2026-09-14T15:50:00Z'],
  ]));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const result = validate(fixture, '--clock', '2026-09-14T16:00:00Z');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /at 不可早于前一指定时间/);
});
