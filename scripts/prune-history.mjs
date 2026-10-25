// Reversible pruning of distilled history so old routines, expired plans and
// one-scene rules stop steering what comes next (COMPANION-ALIVENESS.md).
// Raw messages stay untouched; pruned records are listed in history_prunes.
//
//   node scripts/prune-history.mjs                 # dry run: counts and samples
//   node scripts/prune-history.mjs --apply         # back up, then write prunes
//   node scripts/prune-history.mjs --restore       # remove every prune
//   node scripts/prune-history.mjs --regenerate-today  # drop today's unshared happenings so they are rebuilt
//   --db path/to/life.sqlite                       # default data/life.sqlite
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensurePruneTable, dailyItemRef } from '../lib/history-prunes.mjs';

const args = process.argv.slice(2);
const flag = name => args.includes(name);
const dbPath = args.includes('--db') ? args[args.indexOf('--db') + 1] : 'data/life.sqlite';
const ROLE = 'miyue';

const FOOD = /汤面|面条|面馆|泡面|吃面|粥|馄饨|早饭|早餐|午饭|晚饭|夜宵|吃饭|饭菜|点餐|外卖|小炒|炒菜|青菜|煎蛋|番茄蛋汤|热汤|喝汤|咖啡|奶茶|豆浆|饼干|零食|年糕|炸鸡|肥牛|红烧|鱼块/u;
const WORK = /改稿|稿子|初稿|配色|色卡|画图|画稿|开工|收工|交稿|客户/u;
const ROUTINE = /洗漱|刷牙|起床|睡醒|钻被窝|躺下|洗澡|泡澡|吹头|下班|上班路上|到家/u;
const HER_MEAL_HABIT = /角色.{0,12}(?:爱吃|吃了很多|汤面|面|粥)/u;
const DURABLE = /偏好|喜欢|以后|每次|总是|一直|习惯|专属/u;
const HIS_HABIT = /烘|咖啡豆|豆子|改良|拼配|杯|减肥|夜宵|不爱吃|不吃早饭|总是|一直|习惯/u;
const NEWS = /游戏|试玩|Steam|新品节|机核|米哈游|绝区零/u;
const ONE_OFF = /今晚|今天|明天|明晚|今早|当晚|当天|这就|马上|等下|待会|一会儿|20\d\d-\d\d-\d\d|20\d\d年\d{1,2}月\d{1,2}日/u;

// Reviewed by hand on 2026-10-25: the rules that still hold and the plans
// that are still theirs. Everything else in these two kinds is pruned.
const KEEP = new Set([
  // boundaries she has held every time, and what he asked of her
  '2dec3ea6-:0', '1cada568-:2', '1cada568-:5', '17e51574-:6', '449174d9-:3',
  // what he told her about himself, and what she needs when she vents
  'a78d6c1d-:7', '504824a1-:12',
  // long-running plans and promises
  'b8090baf-:2', '45c021a9-:3', '45865349-:6', '45865349-:7', '9131aa99-:3', '9131aa99-:7',
  'c9dfffc8-:8', 'f899d2dc-:5', 'dcefda96-:6', '17e51574-:19', '0243f5e7-:0',
]);
// Reviewed leftovers the rules miss: the business trip is over, and these
// were one evening's words.
const PRUNE = new Map([
  ['e43d07a9-:4', 'one-off'], ['77e770d5-:1', 'one-off'], ['77e770d5-:8', 'her-routine'], ['95677fd7-:6', 'one-off'], ['9eec350d-:2', 'one-off'],
]);
const keyOf = (chunkId, index) => `${chunkId.slice(0, 8)}-:${index}`;

// Growth notes that only restate her meals and work routine.
const GROWTH_PRUNE = ['habit-color-iterations', 'interest-coffee-for-warmth', 'interest-hot-sweet-soups', 'habit-talking-fragments', 'habit-sex-own-terms', 'view-walk-to-warm-up'];

const shanghaiDay = (at = new Date()) => new Date(+at + 8 * 3600000).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function classify(item, day, key, today) {
  if (KEEP.has(key)) return null;
  if (PRUNE.has(key)) return PRUNE.get(key);
  const { subject, kind, status, text } = item;
  if (kind === 'boundary') return 'boundary-one-scene';
  if (kind === 'agreement' && ['planned', 'ongoing'].includes(status)) return 'plan-expired';
  if (kind === 'correction') return null;
  // Her day-to-day (meals, the current draft, getting up) is what kept repeating;
  // facts about who she is stay unless they are pinned to one day.
  const routine = FOOD.test(text) || WORK.test(text) || ROUTINE.test(text);
  if (subject === 'character' && routine && (['event', 'topic', 'agreement', 'preference'].includes(kind) || kind === 'fact' && ONE_OFF.test(text))) return 'her-routine';
  // Shared records are their memories together; only dated logistics and her
  // own eating habits go.
  if (subject === 'shared' && routine && (['event', 'topic', 'fact'].includes(kind) && ONE_OFF.test(text) || kind === 'preference' && HER_MEAL_HABIT.test(text))) return 'her-routine';
  if (subject === 'character' && ['event', 'fact', 'topic'].includes(kind) && NEWS.test(text)) return 'news-share';
  // What he ate on a given day goes; his coffee roasting and food habits stay.
  if (subject === 'user' && ['event', 'fact', 'topic'].includes(kind) && FOOD.test(text) && (ONE_OFF.test(text) || /当时|等会|中午|晚饭|午饭|早饭/u.test(text)) && !HIS_HABIT.test(text)) return 'his-meal';
  if (['preference', 'agreement'].includes(kind) && ['current', 'planned', 'ongoing'].includes(status) && ONE_OFF.test(text) && !DURABLE.test(text) && day <= addDays(today, -3)) return 'one-off';
  return null;
}

const db = new DatabaseSync(dbPath);
ensurePruneTable(db);
const now = new Date(), today = shanghaiDay(now);

if (flag('--restore')) {
  const removed = db.prepare('DELETE FROM history_prunes WHERE role_id=?').run(ROLE).changes;
  console.log(`已恢复 ${removed} 条修剪。`);
  process.exit(0);
}

if (flag('--regenerate-today')) {
  const shared = db.prepare('SELECT COUNT(*) n FROM daily_happening_shares WHERE role_id=? AND day=?').get(ROLE, today).n;
  if (shared) { console.log(`今天已经讲过 ${shared} 件小事，不重新生成。`); process.exit(1); }
  const removed = db.prepare('DELETE FROM daily_happenings WHERE role_id=? AND day=?').run(ROLE, today).changes;
  console.log(removed ? `已删除 ${today} 的每日小事，服务会在一分钟内重新生成。` : `${today} 还没有每日小事。`);
  process.exit(0);
}

const chunks = db.prepare('SELECT id,day,payload FROM daily_dialogue_chunks WHERE role_id=? ORDER BY day,created_at,rowid').all(ROLE);
const plan = [];
let total = 0;
for (const { id, day, payload } of chunks) {
  JSON.parse(payload).items.forEach((item, index) => {
    total += 1;
    const reason = classify(item, day, keyOf(id, index), today);
    if (reason) plan.push({ target: 'daily_item', ref: dailyItemRef(id, index), reason, day, item });
  });
}
const growthIds = new Set(db.prepare('SELECT id FROM character_growth_items WHERE role_id=?').all(ROLE).map(row => row.id));
for (const id of GROWTH_PRUNE) if (growthIds.has(id)) plan.push({ target: 'growth', ref: id, reason: 'growth-routine' });

const byReason = Object.groupBy(plan, entry => entry.reason);
console.log(`按日核心记录 ${total} 条，计划修剪 ${plan.filter(p => p.target === 'daily_item').length} 条；成长笔记修剪 ${plan.filter(p => p.target === 'growth').length} 条。`);
for (const [reason, entries] of Object.entries(byReason)) {
  console.log(`\n== ${reason}：${entries.length}`);
  for (const entry of entries.slice(0, flag('--all') ? Infinity : 6)) console.log(`  ${entry.day || ''} ${entry.item ? `${entry.item.subject}/${entry.item.kind} ${entry.item.text.slice(0, 80)}` : entry.ref}`);
}

if (!flag('--apply')) { console.log('\n（预览，没有写入；加 --apply 执行）'); process.exit(0); }

const backupDir = path.join('.runtime', 'backups');
fs.mkdirSync(backupDir, { recursive: true });
const backup = path.join(backupDir, `life-before-prune-${now.toISOString().replace(/[:.]/g, '-')}.sqlite`);
db.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
const insert = db.prepare('INSERT OR IGNORE INTO history_prunes(role_id,target,ref,reason,created_at) VALUES(?,?,?,?,?)');
db.exec('BEGIN IMMEDIATE');
let written = 0;
for (const entry of plan) written += insert.run(ROLE, entry.target, entry.ref, entry.reason, now.toISOString()).changes;
const prunedRefs = new Set(plan.filter(p => p.target === 'daily_item').map(p => p.ref));
let expired = 0;
for (const thread of db.prepare("SELECT id,source_ref FROM user_threads WHERE role_id=? AND status='open'").all(ROLE)) {
  if (prunedRefs.has(thread.source_ref)) expired += db.prepare("UPDATE user_threads SET status='expired' WHERE id=?").run(thread.id).changes;
}
db.exec('COMMIT');
console.log(`\n已写入 ${written} 条修剪，关闭 ${expired} 条过时的回头问。备份：${backup}`);
