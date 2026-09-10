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
  if (process.platform !== 'darwin') throw new Error('登录自启目前支持 macOS；其他系统可用 npm start。');
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
    fs.writeFileSync(temp, serviceDefinition(root, process.execPath, runtime), { mode: 0o600 });
    execFileSync('/usr/bin/plutil', ['-lint', temp], { stdio: 'pipe' });
    fs.renameSync(temp, plist); launch(['enable', target]); launch(['bootstrap', domain, plist]);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  process.stdout.write('有间已设为登录后自动运行，关闭网页仍会采集和准备消息。\n打开 http://127.0.0.1:8765/；卸载自启：npm run service:remove。\n');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv[2] || 'status').catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
