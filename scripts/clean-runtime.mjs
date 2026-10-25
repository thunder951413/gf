// Evaluation and deployment runs copy the whole database (and sometimes the
// scene images) into .runtime/. Those copies are not needed afterwards; the
// reports and logs next to them are small and referenced by the docs.
//
//   node scripts/clean-runtime.mjs          # show what would be deleted
//   node scripts/clean-runtime.mjs --apply  # delete
//
// Kept: text reports and logs, .runtime/backups/, the naturalness template used
// by 应用新版并重启.command, and the newest production backup database.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const runtime = path.join(root, '.runtime');
const apply = process.argv.includes('--apply');
const heavy = /\.(sqlite(-wal|-shm)?|db|png|jpe?g|webp|heic|wav|mp3)$/iu;
const keepDirs = [path.join(runtime, 'backups'), path.join(runtime, 'naturalness', 'template-v2')];

if (!fs.existsSync(runtime)) { process.stdout.write('没有 .runtime 目录，无需清理。\n'); process.exit(0); }
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (keepDirs.some(keep => full === keep)) continue;
    if (entry.isDirectory()) { if (entry.name.endsWith('.app')) files.push({ full, dir: true, size: 0 }); else walk(full); }
    else if (entry.isFile() && heavy.test(entry.name)) { const stat = fs.statSync(full); files.push({ full, size: stat.size, mtime: stat.mtimeMs }); }
  }
})(runtime);

const backups = files.filter(f => !f.dir && /\.sqlite$/u.test(f.full) && /production|before|backup/u.test(f.full)).sort((a, b) => b.mtime - a.mtime);
const keep = new Set(backups.slice(0, 1).map(f => f.full));
const remove = files.filter(f => !keep.has(f.full));
const total = remove.reduce((sum, f) => sum + f.size, 0);
for (const f of remove) {
  if (!apply) continue;
  fs.rmSync(f.full, { recursive: true, force: true });
}
if (apply) (function prune(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) prune(path.join(dir, entry.name));
  if (dir !== runtime && !fs.readdirSync(dir).length) fs.rmdirSync(dir);
})(runtime);
process.stdout.write(`${apply ? '已删除' : '可删除'} ${remove.length} 个文件，共 ${(total / 1048576).toFixed(0)} MB。${keep.size ? `保留最新正式库备份：${path.relative(root, [...keep][0])}` : ''}${apply ? '' : '\n加 --apply 执行。'}\n`);
