// Weekly check on whether she feels alive (COMPANION-ALIVENESS.md P4): how
// much she repeats herself, how often something new happens, why she reached
// out, what became of promises and debates, and what he marked by hand.
import { motifCounts, repeatedPhrases } from './novelty-guard.mjs';

const DAY = 86400000;
const dayOf = at => new Date(+new Date(at) + 8 * 3600000).toISOString().slice(0, 10);

export function ensureFeedbackTable(db) {
  db.exec("CREATE TABLE IF NOT EXISTS message_feedback(message_id TEXT PRIMARY KEY,role TEXT NOT NULL,verdict TEXT NOT NULL,created_at TEXT NOT NULL)");
}

export function recordFeedback(db, { messageId, verdict, now = new Date() }) {
  ensureFeedbackTable(db);
  const message = db.prepare("SELECT id,role FROM messages WHERE id=? AND speaker='assistant'").get(String(messageId || ''));
  if (!message) throw Object.assign(new Error('找不到这条消息'), { status: 404, code: 'MESSAGE_NOT_FOUND' });
  if (verdict === null) { db.prepare('DELETE FROM message_feedback WHERE message_id=?').run(message.id); return { messageId: message.id, verdict: null }; }
  if (!['alive', 'repeat'].includes(verdict)) throw Object.assign(new Error('只能标记为有活人感或又重复了'), { status: 400, code: 'INVALID_FEEDBACK' });
  db.prepare('INSERT INTO message_feedback(message_id,role,verdict,created_at) VALUES(?,?,?,?) ON CONFLICT(message_id) DO UPDATE SET verdict=excluded.verdict,created_at=excluded.created_at')
    .run(message.id, message.role, verdict, new Date(now).toISOString());
  return { messageId: message.id, verdict };
}

const has = (db, table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));

export function weeklyReport(db, { roleId = 'miyue', now = new Date(), days = 7 } = {}) {
  ensureFeedbackTable(db);
  const until = new Date(now).toISOString(), since = new Date(+new Date(now) - days * DAY).toISOString();
  const rows = db.prepare("SELECT id,speaker,text,kind,created_at AS createdAt FROM messages WHERE role=? AND speaker IN ('user','assistant') AND created_at>=? AND created_at<? ORDER BY created_at").all(roleId, since, until);
  const hers = rows.filter(row => row.speaker === 'assistant'), his = rows.filter(row => row.speaker === 'user');
  const proactive = hers.filter(row => row.kind === 'proactive');
  const motifs = motifCounts(rows, { now, days }).map(({ key, label, count, perWeek }) => ({ key, label, count, perWeek, share: hers.length ? Math.round(count / hers.length * 100) : 0, over: count >= perWeek * days / 7 }));
  // Conversations he started: his first message after 2 h of quiet.
  let started = 0, last = 0;
  for (const row of rows) { const at = Date.parse(row.createdAt); if (row.speaker === 'user' && at - last >= 2 * 3600000) started += 1; last = at; }
  const reasons = {};
  if (has(db, 'proactive_material_deliveries')) for (const row of db.prepare('SELECT kind,COUNT(*) n FROM proactive_material_deliveries WHERE role_id=? AND created_at>=? AND created_at<? GROUP BY kind').all(roleId, since, until)) reasons[row.kind] = row.n;
  reasons.none = Math.max(0, proactive.length - Object.values(reasons).reduce((sum, n) => sum + n, 0));
  // Something new each day: a happening or story beat she told, or a new ledger entry.
  const fresh = new Map();
  const add = (at, what) => { const day = dayOf(at); fresh.set(day, [...(fresh.get(day) || []), what]); };
  if (has(db, 'daily_happening_shares')) for (const row of db.prepare('SELECT created_at,item_id FROM daily_happening_shares WHERE role_id=? AND created_at>=? AND created_at<?').all(roleId, since, until)) add(row.created_at, `小事 ${row.item_id}`);
  if (has(db, 'story_arc_shares')) for (const row of db.prepare('SELECT created_at,material_id FROM story_arc_shares WHERE role_id=? AND created_at>=? AND created_at<?').all(roleId, since, until)) add(row.created_at, `故事 ${row.material_id.split(':').slice(2).join(':')}`);
  const ledger = { promise: {}, debate: {}, joke: 0, view: 0 };
  if (has(db, 'relationship_ledger')) {
    for (const row of db.prepare('SELECT kind,status,created_at,updated_at FROM relationship_ledger WHERE role_id=? AND (created_at>=? OR updated_at>=?)').all(roleId, since, since)) {
      if (row.created_at >= since) add(row.created_at, `新${row.kind}`);
      if (row.kind === 'promise' || row.kind === 'debate') ledger[row.kind][row.status] = (ledger[row.kind][row.status] || 0) + 1;
      else if (row.created_at >= since) ledger[row.kind] += 1;
    }
  }
  const dayList = Array.from({ length: days }, (_, index) => dayOf(+new Date(now) - (days - 1 - index) * DAY));
  const feedback = db.prepare('SELECT verdict,COUNT(*) n FROM message_feedback WHERE role=? AND created_at>=? AND created_at<=? GROUP BY verdict').all(roleId, since, until);
  const repeated = db.prepare("SELECT m.text FROM message_feedback f JOIN messages m ON m.id=f.message_id WHERE f.role=? AND f.verdict='repeat' AND f.created_at>=? ORDER BY f.created_at DESC LIMIT 5").all(roleId, since).map(row => row.text.slice(0, 80));
  // Is she narrowing? Where her new things came from, whether her interests
  // grew, how often she gave way, how much her mood moved, and how much of
  // what she brought up was about the two of them.
  const breadth = { picks: 0, categories: 0, tastes: 0, ownTaste: 0, newTastes: [], stirred: {}, concessions: { her: 0, him: 0, both: 0 }, changed: { her: 0, him: 0 }, mood: null, sources: { hers: 0, us: 0, his: 0 }, worn: [] };
  if (has(db, 'her_picks')) {
    const picks = db.prepare("SELECT payload FROM her_picks WHERE role_id=? AND status='ready' AND day>=? AND day<=?").all(roleId, dayOf(since), dayOf(until)).flatMap(row => JSON.parse(row.payload).picks);
    Object.assign(breadth, { picks: picks.length, categories: new Set(picks.map(pick => pick.category)).size, tastes: new Set(picks.map(pick => pick.taste).filter(Boolean)).size, ownTaste: picks.filter(pick => !pick.shared).length });
    for (const pick of picks) if (pick.stir && pick.stir !== 'calm') breadth.stirred[pick.stir] = (breadth.stirred[pick.stir] || 0) + 1;
  }
  if (has(db, 'her_tastes')) breadth.newTastes = db.prepare('SELECT taste FROM her_tastes WHERE role_id=? AND seed=0 AND since>=?').all(roleId, since).map(row => row.taste);
  if (has(db, 'relationship_ledger')) for (const row of db.prepare("SELECT kind,status,payload FROM relationship_ledger WHERE role_id=? AND updated_at>=? AND kind IN ('debate','changed')").all(roleId, since)) {
    const payload = JSON.parse(row.payload);
    if (row.kind === 'debate' && row.status === 'settled' && breadth.concessions[payload.settled] !== undefined) breadth.concessions[payload.settled] += 1;
    if (row.kind === 'changed') breadth.changed[payload.who === 'him' ? 'him' : 'her'] += 1;
  }
  if (has(db, 'affect_events')) {
    const states = db.prepare('SELECT after FROM affect_events WHERE role_id=? AND at>=? AND at<?').all(roleId, since, until).map(row => JSON.parse(row.after));
    const range = key => states.length ? [Math.round(Math.min(...states.map(s => s[key]))), Math.round(Math.max(...states.map(s => s[key])))] : null;
    if (states.length) breadth.mood = { warmth: range('warmth'), security: range('security'), hurt: range('hurt') };
  }
  const US = new Set(['debate', 'moment', 'promise', 'changed', 'milestone', 'miss', 'intimacy', 'unease', 'invite']), HIS = new Set(['user_thread', 'followup']);
  for (const [kind, n] of Object.entries(reasons)) if (kind !== 'none') breadth.sources[US.has(kind) ? 'us' : HIS.has(kind) ? 'his' : 'hers'] += n;
  const longer = db.prepare("SELECT speaker,text,created_at AS createdAt FROM messages WHERE role=? AND speaker IN ('user','assistant') AND created_at>=? AND created_at<? ORDER BY created_at").all(roleId, new Date(+new Date(now) - 35 * DAY).toISOString(), until);
  breadth.worn = repeatedPhrases(longer, { now, days }).map(item => `${item.word}×${item.count}`);
  return {
    breadth,
    range: { since, until, days }, messages: { hers: hers.length, his: his.length, proactive: proactive.length, conversationsHeStarted: started },
    motifs, freshDays: dayList.map(day => ({ day, count: (fresh.get(day) || []).length, items: fresh.get(day) || [] })),
    daysWithoutNew: dayList.filter(day => !(fresh.get(day) || []).length && rows.some(row => dayOf(row.createdAt) === day)).length,
    proactiveReasons: reasons, ledger,
    feedback: Object.fromEntries(feedback.map(row => [row.verdict, row.n])), repeatedExamples: repeated,
  };
}

export function reportMarkdown(report) {
  const lines = [`# 每周活人感报告（${report.range.since.slice(0, 10)} → ${report.range.until.slice(0, 10)}）`, ''];
  const m = report.messages;
  lines.push(`- 她 ${m.hers} 条（主动 ${m.proactive}），他 ${m.his} 条，他开启对话 ${m.conversationsHeStarted} 次`);
  lines.push(`- 有聊天但没有新东西的天数：${report.daysWithoutNew}`);
  lines.push(`- 反馈：有活人感 ${report.feedback.alive || 0}，又重复了 ${report.feedback.repeat || 0}`, '', '## 母题', '');
  for (const motif of report.motifs) lines.push(`- ${motif.label}：${motif.count} 次（占她的 ${motif.share}%，每周上限 ${motif.perWeek}${motif.over ? '，超了' : ''}）`);
  lines.push('', '## 主动联系的理由', '');
  for (const [kind, n] of Object.entries(report.proactiveReasons)) lines.push(`- ${kind}：${n}`);
  lines.push('', '## 你们之间', '', `- 约定：${JSON.stringify(report.ledger.promise)}；分歧：${JSON.stringify(report.ledger.debate)}；新梗 ${report.ledger.joke}，新记下他的看法 ${report.ledger.view}`);
  const b = report.breadth;
  if (b) {
    lines.push('', '## 窄不窄', '');
    lines.push(`- 她挑的外面的东西：${b.picks} 条，${b.categories} 类，涉及 ${b.tastes} 个兴趣；其中 ${b.ownTaste} 条和你们的共同话题无关，纯是她自己的口味`);
    lines.push(`- 这周新长出的兴趣：${b.newTastes.length ? b.newTastes.join('、') : '没有'}`);
    lines.push(`- 读到的东西在她心里起的波澜：${Object.keys(b.stirred).length ? Object.entries(b.stirred).map(([k, n]) => `${k} ${n}`).join('，') : '没有'}`);
    lines.push(`- 分歧谈完：她让步 ${b.concessions.her}，你让步 ${b.concessions.him}，谈拢 ${b.concessions.both}；她因你变 ${b.changed.her}，你因她变 ${b.changed.him}`);
    lines.push(`- 心情起伏：${b.mood ? `被暖到 ${b.mood.warmth.join('–')}，安全感 ${b.mood.security.join('–')}，委屈 ${b.mood.hurt.join('–')}` : '没有记录'}`);
    lines.push(`- 她主动讲的：她自己的事 ${b.sources.hers}，你们之间的 ${b.sources.us}，问你的事 ${b.sources.his}`);
    lines.push(`- 她这周在磨的词：${b.worn.length ? b.worn.join('、') : '没有'}`);
  }
  lines.push('', '## 每天的新东西', '');
  for (const day of report.freshDays) lines.push(`- ${day.day}：${day.count}${day.items.length ? `（${day.items.slice(0, 4).join('、')}）` : ''}`);
  if (report.repeatedExamples.length) { lines.push('', '## 被标记为重复的', ''); for (const text of report.repeatedExamples) lines.push(`- ${text}`); }
  return lines.join('\n') + '\n';
}
