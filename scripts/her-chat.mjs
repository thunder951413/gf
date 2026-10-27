// Chatting with her from Claude Code instead of the model API: this reads her
// current state for whoever is playing her, and writes each turn back so the
// app (ledger, feelings, story, proactive timing, the web chat) carries on
// from it exactly as if she had answered in the app. No model is called.
//
//   node scripts/her-chat.mjs context [--text "他这句话"]   her persona and what is on her mind right now
//   node scripts/her-chat.mjs say --he "他说的" --she "她回的" [--appraisal '{"towardHer":"warm",...}'] [--info daily-info:id]
//   node scripts/her-chat.mjs history [--limit 30]           the last messages, as plain lines
// Options: --data-dir <dir> (default data/). Safe while the service is running:
// SQLite is in WAL mode and nothing here starts timers or listens on a port.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server.mjs';
import { buildSessionMessages } from '../lib/session-dialogue.mjs';
import { conversationTrigger } from '../lib/conversation-plan.mjs';
import { afterDisplayCut } from '../lib/chat-display.mjs';
import { validAppraisal } from '../lib/affect.mjs';
import { readPersona } from '../lib/persona-overrides.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...rest] = process.argv.slice(2);
const value = name => { const i = rest.indexOf(name); return i < 0 ? null : rest[i + 1]; };
const fail = message => { process.stderr.write(message + '\n'); process.exit(1); };
if (!['context', 'say', 'history'].includes(command)) fail('用法：context [--text …] | say --he … --she … [--appraisal JSON] [--info id] | history [--limit n]');

const ROLE = 'miyue';
const shanghai = at => new Date(+new Date(at) + 8 * 3600000).toISOString().slice(5, 16).replace('T', ' ');
const off = async () => { throw new Error('off'); };
const dataDir = path.resolve(value('--data-dir') || path.join(root, 'data'));
const app = await createApp({
  dataDir, initialFeeds: [], activeRoleIds: [ROLE], disableStory: true,
  dailyCompression: true, dynamicCompanion: true, sessionDialogue: true, materialPresentation: 'generated',
  startDiscovery: false, startWeixin: false, startChatQueue: false, startRuntime: false, startLife: false, startPursuits: false, startDossiers: false,
  startRecall: false, startProactive: false, startResearch: false, startDailyHappenings: false, startReminders: false, startCharacterGrowth: false,
  startDailyLife: false, startDailyInformation: false,
  integrations: { fetchFeed: off, fetchArticle: off, fetchSina: async () => ({ items: [] }), zhihuFetchImpl: off, desktopNotify: async () => ({ requested: false }),
    listSpeechVoices: async () => ({ voices: [] }), probeTts: async () => ({ available: false }) },
});
// Everything he can change in the settings page that changes who she is or
// how she talks. context remembers it; say compares, so a switch made while
// chatting here is noticed on the very next turn.
const statePath = path.join(dataDir, 'her-chat.json');
function settingsSignature() {
  const identity = app.companionIdentity.get(), context = app.prepareSessionContext(ROLE, { text: '' });
  return JSON.stringify({ identity: identity.mode, persona: readPersona(app.store.db).savedAt || null, tuning: context.sessionTuningRevision ?? null,
    settings: context.sessionSettingsRevision ?? null, policy: context.sessionPolicyRevision ?? null, relationship: context.relationshipRevision ?? null, display: app.store.db.prepare("SELECT value FROM metadata WHERE key='chat_display_since'").get()?.value || null });
}
const lines = rows => rows.map(row => `${shanghai(row.created_at || row.createdAt)} ${row.speaker === 'user' ? '他' : '她'}${row.kind === 'proactive' ? '（主动）' : ''}：${row.text}`).join('\n');
const recentRows = limit => afterDisplayCut(app.store.db, app.store.db.prepare("SELECT id,speaker,text,kind,created_at FROM messages WHERE role=? AND speaker IN ('user','assistant') AND kind<>'story' ORDER BY created_at DESC,rowid DESC LIMIT ?").all(ROLE, limit).reverse());

try {
  if (command === 'history') {
    process.stdout.write(lines(recentRows(Number(value('--limit')) || 30)) + '\n');
  } else if (command === 'context') {
    const text = value('--text') || '';
    const now = new Date();
    const context = app.prepareSessionContext(ROLE, { text, trigger: conversationTrigger({ type: 'user_message', userText: text || '（他来了）', at: now }) });
    const messages = buildSessionMessages({ role: app.roleMap.get(ROLE), ...context.sessionOptions, userText: text || null, memories: app.store.listMemories(ROLE) });
    // Her persona (first block) and this turn's background; the history is
    // shown as plain lines, and the app's JSON output protocol is left out.
    const persona = messages[0]?.content || '';
    const block = head => messages.find(message => message.role === 'system' && message.content.startsWith(head))?.content || '';
    const background = [block('【长期背景】'), block('【本轮背景证据】')].filter(Boolean).join('\n\n');
    try { fs.mkdirSync(path.dirname(statePath), { recursive: true }); fs.writeFileSync(statePath, JSON.stringify({ signature: settingsSignature(), at: now.toISOString() })); } catch {}
    process.stdout.write([
      `【现在】${shanghai(now)}（北京时间），她的身份：${app.companionIdentity.get().mode === 'ai' ? 'AI，住在他 Mac 里' : '真人设定'}`,
      '【她是谁】', persona,
      background,
      '【最近的聊天】', lines(recentRows(40)),
    ].filter(Boolean).join('\n\n') + '\n');
  } else {
    const he = value('--he'), she = value('--she');
    if (!he || !she) fail('say 需要 --he 和 --she');
    const appraisal = (() => { try { return value('--appraisal') ? validAppraisal(JSON.parse(value('--appraisal'))) : null; } catch { fail('--appraisal 不是合法 JSON'); } })();
    const rows = app.store.saveChatTurn({ role: ROLE, text: he, reply: she, replyChannel: 'desktop' });
    const user = rows.find(row => row.speaker === 'user'), assistant = rows.findLast(row => row.speaker === 'assistant');
    if (appraisal) app.affect.observe(ROLE, appraisal, { messageId: user.id });
    app.episodes.observe(ROLE, rows);
    app.followups.observe(ROLE, he, user.id);
    app.storyArcs.observe(ROLE, rows);
    const used = app.relationshipLedger.observe(ROLE, rows);
    const info = value('--info');
    if (info && app.dailyInformation.material(info)) app.dailyInformation.record(assistant, info);
    let last = null; try { last = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch {}
    const settingsChanged = Boolean(last?.signature && last.signature !== settingsSignature());
    process.stdout.write(JSON.stringify({ saved: [user.id, assistant.id], at: shanghai(assistant.createdAt), feeling: app.affect.context(ROLE), ledgerUsed: used.length,
      ...(settingsChanged ? { settingsChanged: '他在设置里改了她（身份、性格、相处参数或关系）。下一轮回复之前重新运行 context，按新的她说话。' } : {}) }) + '\n');
  }
} finally { await app.close(); }
