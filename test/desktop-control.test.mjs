import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DesktopControl } from '../lib/desktop-control.mjs';

function fixtureApp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youjian-desktop-'));
  const appPath = path.join(root, '有间桌面.app');
  const executable = path.join(appPath, 'Contents', 'MacOS', 'YoujianDesktop');
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(executable, 'fixture');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return appPath;
}

function runner({ running = false, failOpen, failTerminate, holdOpen } = {}) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args, options });
    if (command === '/usr/bin/open') {
      if (holdOpen) await holdOpen();
      if (failOpen) throw new Error(failOpen);
      running = true;
      return { stdout: '' };
    }
    const script = args.at(-1);
    if (script.includes('application.terminate ||')) {
      if (failTerminate) throw new Error(failTerminate);
      running = false;
      return { stdout: '1\n' };
    }
    return { stdout: `${running ? '1' : '0'}\n` };
  };
  return { run, calls, setRunning: value => { running = value; } };
}

test('starts the fixed app path and reports the observed status', async t => {
  const appPath = fixtureApp(t); const fake = runner();
  const control = new DesktopControl({ platform: 'darwin', appPath, run: fake.run, pollMs: 0 });
  assert.deepEqual(await control.status(), { available: true, running: false });
  assert.deepEqual(await control.setEnabled(true), { available: true, running: true });
  assert.deepEqual(fake.calls.find(call => call.command === '/usr/bin/open'), { command: '/usr/bin/open', args: [appPath], options: { timeout: 5000 } });
});

test('alternating requests stay serialized and preserve the last requested state', async t => {
  const appPath = fixtureApp(t); const fake = runner();
  const control = new DesktopControl({ platform: 'darwin', appPath, run: fake.run, pollMs: 0 });
  assert.deepEqual(await Promise.all([control.setEnabled(true), control.setEnabled(false), control.setEnabled(true)]), [
    { available: true, running: true },
    { available: true, running: false },
    { available: true, running: true },
  ]);
  assert.equal(fake.calls.filter(call => call.command === '/usr/bin/open').length, 2);
});

test('concurrent starts share one open request and an external quit is reflected', async t => {
  const appPath = fixtureApp(t); let release;
  const gate = new Promise(resolve => { release = resolve; });
  const fake = runner({ holdOpen: () => gate });
  const control = new DesktopControl({ platform: 'darwin', appPath, run: fake.run, pollMs: 0 });
  const first = control.setEnabled(true);
  const second = control.setEnabled(true);
  await new Promise(resolve => setImmediate(resolve));
  release();
  await Promise.all([first, second]);
  assert.equal(fake.calls.filter(call => call.command === '/usr/bin/open').length, 1);
  fake.setRunning(false);
  assert.deepEqual(await control.status(), { available: true, running: false });
});

test('stops only the matched application through NSRunningApplication', async t => {
  const appPath = fixtureApp(t); const fake = runner({ running: true });
  const control = new DesktopControl({ platform: 'darwin', appPath, run: fake.run, pollMs: 0 });
  assert.deepEqual(await control.setEnabled(false), { available: true, running: false });
  const stop = fake.calls.find(call => call.args?.at(-1)?.includes('application.terminate ||'));
  assert.equal(stop.command, '/usr/bin/osascript');
  assert.match(stop.args.at(-1), /bundleURL/);
  assert.doesNotMatch(stop.args.at(-1), /application\.terminate\(/, 'JXA zero-argument method access must not call its boolean return value');
  assert.doesNotMatch(stop.args.at(-1), /System Events|pkill/);
});

test('returns actionable unavailable statuses and fails closed on status lookup failure', async t => {
  const appPath = fixtureApp(t);
  assert.deepEqual(await new DesktopControl({ platform: 'linux', appPath }).status(), { available: false, running: false, reason: '仅支持 macOS 桌面端控制。' });
  assert.deepEqual(await new DesktopControl({ platform: 'darwin', appPath: path.join(appPath, 'missing') }).status(), { available: false, running: false, reason: '未找到有间桌面应用，请先构建桌面端。' });
  const failed = new DesktopControl({ platform: 'darwin', appPath, run: async () => { throw new Error('JXA unavailable'); } });
  await assert.rejects(failed.status(), error => error.status === 503 && error.code === 'DESKTOP_CONTROL_FAILED' && /JXA unavailable/.test(error.message));
  await assert.rejects(new DesktopControl({ platform: 'linux', appPath }).setEnabled(true), error => error.status === 503 && /仅支持 macOS/.test(error.message));
});

test('rejects invalid status output and non-boolean toggle values', async t => {
  const appPath = fixtureApp(t);
  const control = new DesktopControl({ platform: 'darwin', appPath, run: async () => ({ stdout: 'unexpected' }) });
  await assert.rejects(control.status(), /状态查询返回了无效结果：unexpected/);
  await assert.rejects(control.setEnabled('true'), error => error.status === 400 && error.code === 'DESKTOP_CONTROL_INVALID_INPUT');
});

test('surfaces start and stop command failures', async t => {
  const appPath = fixtureApp(t);
  await assert.rejects(new DesktopControl({ platform: 'darwin', appPath, run: runner({ failOpen: 'open denied' }).run }).setEnabled(true), /启动桌面端失败：open denied/);
  await assert.rejects(new DesktopControl({ platform: 'darwin', appPath, run: runner({ running: true, failTerminate: 'terminate denied' }).run }).setEnabled(false), /关闭桌面端失败：terminate denied/);
});
