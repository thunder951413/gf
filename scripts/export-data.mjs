// Packs everything the service needs on another machine into one archive:
// a consistent copy of the database (VACUUM INTO, safe while the service runs),
// the scene images, small data files and .env.local (model keys, access token).
//
//   node scripts/export-data.mjs [--out 目录] [--no-images]
//
// On the server:  tar -xzf youjian-data-*.tar.gz -C <项目目录>  then  npm run service:install
// Only one copy of the service should be running at a time: both would poll
// WeChat and send proactive messages. Stop this Mac's service (./ctl stop)
// before starting the server, and export again right before the switch so no
// messages are lost.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const option = name => { const i = args.indexOf(name); return i < 0 ? null : args[i + 1]; };
const data = path.resolve(option('--data-dir') || path.join(root, 'data'));
const outDir = path.resolve(option('--out') || root);
const withImages = !args.includes('--no-images');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
const archive = path.join(outDir, `youjian-data-${stamp}.tar.gz`);

if (!fs.existsSync(path.join(data, 'life.sqlite'))) throw new Error(`没有找到数据库：${path.join(data, 'life.sqlite')}`);
const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'youjian-export-'));
try {
  const target = path.join(staging, 'data');
  fs.mkdirSync(target, { mode: 0o700 });
  const db = new DatabaseSync(path.join(data, 'life.sqlite'), { readOnly: true });
  try { db.exec(`VACUUM INTO '${path.join(target, 'life.sqlite').replace(/'/g, "''")}'`); } finally { db.close(); }
  const check = new DatabaseSync(path.join(target, 'life.sqlite'), { readOnly: true });
  try {
    const result = check.prepare('PRAGMA integrity_check').get();
    if (Object.values(result)[0] !== 'ok') throw new Error('导出的数据库没有通过完整性检查');
    var messages = check.prepare('SELECT count(*) AS n FROM messages').get().n;
  } finally { check.close(); }
  for (const name of fs.readdirSync(data)) {
    if (name.startsWith('.') || /^life\.sqlite/.test(name)) continue;
    if (name === 'scene-images' && !withImages) continue;
    fs.cpSync(path.join(data, name), path.join(target, name), { recursive: true });
  }
  const env = path.join(root, '.env.local');
  if (fs.existsSync(env)) fs.copyFileSync(env, path.join(staging, '.env.local'));
  fs.mkdirSync(outDir, { recursive: true });
  execFileSync('tar', ['-czf', archive, '-C', staging, '.'], { stdio: 'inherit' });
  fs.chmodSync(archive, 0o600);
  const size = (fs.statSync(archive).size / 1048576).toFixed(0);
  process.stdout.write(`已导出：${archive}（${size} MB，${messages} 条聊天${withImages ? '' : '，不含场景图片'}${fs.existsSync(env) ? '，含 .env.local 里的密钥，请妥善保管' : ''}）\n`
    + `在服务器上：tar -xzf ${path.basename(archive)} -C <项目目录> && npm run service:install\n`
    + '切换前先停掉这台 Mac 上的服务（./ctl stop），两边同时运行会重复回复微信和主动消息。\n');
} finally { fs.rmSync(staging, { recursive: true, force: true }); }
