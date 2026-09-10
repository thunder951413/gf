import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const BUNDLE_ID = 'local.youjian.desktop';
const EXECUTABLE_NAME = 'YoujianDesktop';
const DEFAULT_APP_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../desktop/build/有间桌面.app');
const DEFAULT_TIMEOUT_MS = 5_000;

function desktopError(message, { status = 503, code = 'DESKTOP_CONTROL_FAILED' } = {}) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function jxaString(value) {
  return JSON.stringify(value);
}

function runningScript(appPath) {
  return `ObjC.import('AppKit');
const bundleId = ${jxaString(BUNDLE_ID)};
const expectedPath = ${jxaString(appPath)};
const applications = $.NSRunningApplication.runningApplicationsWithBundleIdentifier($(bundleId));
let running = false;
for (let index = 0; index < applications.count; index += 1) {
  const application = applications.objectAtIndex(index);
  const url = application.bundleURL;
  if (url && ObjC.unwrap(url.path) === expectedPath) { running = true; break; }
}
running ? '1' : '0';`;
}

function terminateScript(appPath) {
  return `ObjC.import('AppKit');
const bundleId = ${jxaString(BUNDLE_ID)};
const expectedPath = ${jxaString(appPath)};
const applications = $.NSRunningApplication.runningApplicationsWithBundleIdentifier($(bundleId));
let requested = false;
for (let index = 0; index < applications.count; index += 1) {
  const application = applications.objectAtIndex(index);
  const url = application.bundleURL;
  if (url && ObjC.unwrap(url.path) === expectedPath) {
    // JXA invokes zero-argument Objective-C methods through property access.
    requested = application.terminate || requested;
  }
}
requested ? '1' : '0';`;
}

function outputText(result) {
  if (typeof result === 'string' || Buffer.isBuffer(result)) return String(result);
  return String(result?.stdout ?? '');
}

function errorMessage(error) {
  return error?.stderr?.trim() || error?.message || String(error);
}

export class DesktopControl {
  constructor({
    platform = process.platform,
    appPath = DEFAULT_APP_PATH,
    run = promisify(execFile),
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pollMs = 100,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = {}) {
    this.platform = platform;
    this.appPath = path.resolve(appPath);
    this.run = run;
    this.timeoutMs = Math.min(Math.max(timeoutMs, 0), DEFAULT_TIMEOUT_MS);
    this.pollMs = Math.max(pollMs, 0);
    this.sleep = sleep;
    this.queue = Promise.resolve();
    this.lastQueuedOperation = null;
    this.lastQueuedTarget = null;
  }

  availability() {
    if (this.platform !== 'darwin') return { available: false, running: false, reason: '仅支持 macOS 桌面端控制。' };
    const executable = path.join(this.appPath, 'Contents', 'MacOS', EXECUTABLE_NAME);
    if (!fs.existsSync(executable)) return { available: false, running: false, reason: '未找到有间桌面应用，请先构建桌面端。' };
    return null;
  }

  async status() {
    const unavailable = this.availability();
    if (unavailable) return unavailable;
    try {
      const result = await this.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', runningScript(this.appPath)], { timeout: DEFAULT_TIMEOUT_MS });
      const output = outputText(result).trim();
      if (output !== '0' && output !== '1') throw new Error(`状态查询返回了无效结果：${output || '空输出'}`);
      return { available: true, running: output === '1' };
    } catch (error) {
      throw desktopError(`无法检查桌面端状态：${errorMessage(error)}`);
    }
  }

  async setEnabled(enabled) {
    if (typeof enabled !== 'boolean') throw desktopError('桌面端开关值必须为 true 或 false。', { status: 400, code: 'DESKTOP_CONTROL_INVALID_INPUT' });
    const target = enabled;
    if (this.lastQueuedOperation && this.lastQueuedTarget === target) return this.lastQueuedOperation;
    const operation = this.queue.then(() => this.setEnabledSerial(target));
    this.lastQueuedOperation = operation;
    this.lastQueuedTarget = target;
    this.queue = operation.catch(() => {});
    operation.finally(() => {
      if (this.lastQueuedOperation === operation) {
        this.lastQueuedOperation = null;
        this.lastQueuedTarget = null;
      }
    }).catch(() => {});
    return operation;
  }

  async setEnabledSerial(enabled) {
    const before = await this.status();
    if (!before.available) throw desktopError(before.reason);
    if (!enabled && !before.running) return before;
    try {
      if (enabled) await this.run('/usr/bin/open', [this.appPath], { timeout: DEFAULT_TIMEOUT_MS });
      else await this.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', terminateScript(this.appPath)], { timeout: DEFAULT_TIMEOUT_MS });
    } catch (error) {
      throw desktopError(`${enabled ? '启动' : '关闭'}桌面端失败：${errorMessage(error)}`);
    }
    return this.waitForState(enabled);
  }

  async waitForState(enabled) {
    const deadline = Date.now() + this.timeoutMs;
    let latest;
    do {
      latest = await this.status();
      if (latest.available && latest.running === enabled) return latest;
      if (Date.now() >= deadline) break;
      await this.sleep(this.pollMs);
    } while (Date.now() < deadline);
    const detail = latest?.reason ? `（${latest.reason}）` : '';
    throw desktopError(`${enabled ? '启动' : '关闭'}桌面端失败：5 秒内未确认状态变化${detail}`);
  }
}

export const desktopAppPath = DEFAULT_APP_PATH;
