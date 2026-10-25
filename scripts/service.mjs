import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const label = 'local.youjian.companion';
const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const runtime = path.join(root, '.runtime');
const domain = `gui/${process.getuid?.()}`;
const target = `${domain}/${label}`;
const xml = value => String(value).replace(/[<>&"']/g, c => ({ '<':'&lt;', '>':'&gt;', '&':'&amp;', '"':'&quot;', "'":'&apos;' }[c]));

// Homebrew replaces versioned Cellar directories on upgrades. Keep launchd on
// its stable symlink when it resolves to the same runtime we are installing with.
function installedNodePath() {
  for (const candidate of ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
    try { if (fs.realpathSync(candidate) === fs.realpathSync(process.execPath)) return candidate; } catch {}
  }
  return process.execPath;
}

export function serviceDefinition(appRoot, nodePath, logDir) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(path.join(appRoot, 'start.mjs'))}</string></array>
<key>WorkingDirectory</key><string>${xml(appRoot)}</string>
<key>EnvironmentVariables</key><dict><key>LIFE_MANAGED_SERVICE</key><string>1</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer>
<key>ExitTimeOut</key><integer>90</integer>
<key>StandardOutPath</key><string>${xml(path.join(logDir, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logDir, 'service-error.log'))}</string>
</dict></plist>
`;
}
// Linux (e.g. an ARM home server): a systemd user unit. `loginctl enable-linger`
// keeps it running without an open login session and starts it at boot.
const unitName = 'youjian.service';
const unitFile = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user', unitName);
const quote = value => `"${String(value).replace(/(["\\])/g, '\\$1')}"`;
export function systemdDefinition(appRoot, nodePath, logDir) {
  return `[Unit]
Description=有间 companion service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${appRoot}
ExecStart=${quote(nodePath)} ${quote(path.join(appRoot, 'start.mjs'))}
Environment=LIFE_MANAGED_SERVICE=1
Restart=always
RestartSec=10
TimeoutStopSec=90
StandardOutput=append:${path.join(logDir, 'service.log')}
StandardError=append:${path.join(logDir, 'service-error.log')}

[Install]
WantedBy=default.target
`;
}
function systemctl(args) { return execFileSync('systemctl', ['--user', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
async function linux(command) {
  if (command === 'status') {
    let state = 'inactive'; try { state = systemctl(['is-active', unitName]).trim(); } catch (error) { state = String(error.stdout || 'inactive').trim(); }
    process.stdout.write(fs.existsSync(unitFile) ? `有间后台服务：${state}\n` : '有间后台服务未安装。可用 npm run service:install 安装。\n'); return;
  }
  if (!['install', 'remove'].includes(command)) throw new Error('用法：node scripts/service.mjs install|status|remove');
  if (fs.existsSync(unitFile) && !fs.readFileSync(unitFile, 'utf8').includes(path.join(root, 'start.mjs'))) throw new Error('同名后台服务属于其他目录，请先检查，未做修改。');
  if (command === 'remove') {
    try { systemctl(['disable', '--now', unitName]); } catch {}
    if (fs.existsSync(unitFile)) fs.unlinkSync(unitFile);
    try { systemctl(['daemon-reload']); } catch {}
    process.stdout.write('已移除有间后台服务；会话、配置和内容均保留。\n'); return;
  }
  let active = false; try { active = systemctl(['is-active', unitName]).trim() === 'active'; } catch {}
  if (!active && await portUsed()) throw new Error('8765 端口正在使用。请先停止原有 npm start 进程，再安装后台服务。');
  fs.mkdirSync(path.dirname(unitFile), { recursive: true }); fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  fs.writeFileSync(unitFile, systemdDefinition(root, process.execPath, runtime), { mode: 0o644 });
  systemctl(['daemon-reload']); systemctl(['enable', unitName]); systemctl(['restart', unitName]);
  let linger = false;
  try { linger = execFileSync('loginctl', ['show-user', os.userInfo().username, '-p', 'Linger'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() === 'Linger=yes'; } catch {}
  if (!linger) { try { execFileSync('loginctl', ['enable-linger', os.userInfo().username], { stdio: 'ignore' }); linger = true; } catch {} }
  process.stdout.write(`有间已安装为后台服务并启动。\n日志：${path.join(runtime, 'service.log')}；卸载：npm run service:remove。\n${linger ? '' : `还需要让它在开机后、未登录时也运行：sudo loginctl enable-linger ${os.userInfo().username}\n`}`);
}
function launch(args) { return execFileSync('/bin/launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function loaded() { try { return launch(['print', target]); } catch { return null; } }
function owned() {
  if (!fs.existsSync(plist)) return false;
  const value = fs.readFileSync(plist, 'utf8');
  if (!value.includes(`<string>${xml(path.join(root, 'start.mjs'))}</string>`)) throw new Error('同名后台服务属于其他目录，请先检查，未做修改。');
  return true;
}
async function portUsed() {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port: 8765 });
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(1500, () => finish(true));
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
  });
}
async function main(command) {
  if (process.platform === 'linux') return linux(command);
  if (process.platform !== 'darwin') throw new Error('后台服务目前支持 macOS 和 Linux；其他系统可用 npm start。');
  if (command === 'status') {
    const info = loaded();
    process.stdout.write(info ? `有间后台服务已加载。\n${info.split('\n').filter(line => /^\s*(state|pid|last exit code) =/.test(line)).join('\n')}\n` : '有间后台服务未加载。可用 npm run service:install 安装登录自启。\n');
    return;
  }
  if (!['install', 'remove'].includes(command)) throw new Error('用法：node scripts/service.mjs install|status|remove');
  const own = owned(), info = loaded();
  if (info && !own) throw new Error('存在未识别的同名后台服务，未做修改。');
  if (command === 'remove') {
    if (info) launch(['bootout', target]);
    if (own) fs.unlinkSync(plist);
    process.stdout.write('已移除有间登录自启；会话、配置和内容均保留。\n'); return;
  }
  if (!info && await portUsed()) throw new Error('8765 端口正在使用。请先停止原有 npm start 进程，再安装后台服务。');
  fs.mkdirSync(path.dirname(plist), { recursive: true }); fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  if (info) launch(['bootout', target]);
  const temp = `${plist}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, serviceDefinition(root, installedNodePath(), runtime), { mode: 0o600 });
    execFileSync('/usr/bin/plutil', ['-lint', temp], { stdio: 'pipe' });
    fs.renameSync(temp, plist); launch(['enable', target]); launch(['bootstrap', domain, plist]);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  process.stdout.write('有间已设为登录后自动运行，关闭网页仍会采集和准备消息。\n打开 http://127.0.0.1:8765/；卸载自启：npm run service:remove。\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2] || 'status').catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
