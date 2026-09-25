import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './server.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const allowed = new Set(['LIFE_DISCUSSION_TOPICS', 'LIFE_SEMANTIC_UNDERSTANDING', 'LIFE_DIALOGUE_MEMORY', 'LIFE_MEMORY_REACTION', 'LIFE_LISTEN_HOST', 'LIFE_ALLOWED_HOSTS', 'LIFE_ZHIHU_ACCESS_SECRET', 'LIFE_ZHIHU_PROXY', 'LIFE_FEED_PROXY', 'LIFE_DYNAMIC_COMPANION', 'LIFE_SESSION_DIALOGUE', 'LIFE_MODEL_BASE_URL', 'LIFE_MODEL_NAME', 'LIFE_MODEL_API_KEY', 'LIFE_TTS_BASE_URL', 'QWEN_TTS_ACCESS_PASSWORD']);
const envFile = path.join(root, '.env.local');
if (fs.existsSync(envFile)) {
  for (const raw of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const line = raw.trim(); if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('='); if (index < 1) continue;
    const key = line.slice(0, index).trim(); let value = line.slice(index + 1).trim();
    if (!allowed.has(key) || process.env[key] !== undefined) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[key] = value;
  }
}
const args = process.argv.slice(2);
function option(name, fallback) { const i = args.indexOf(name); if (i < 0) return fallback; if (!args[i + 1]) throw new Error(`${name} 缺少参数`); return args[i + 1]; }
const port = Number(option('--port', '8765'));
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口无效');
const app = await createApp({ dataDir: path.resolve(option('--data-dir', path.join(root, 'data'))), activeRoleIds:['miyue'], disableStory:true, dynamicCompanion:process.env.LIFE_DYNAMIC_COMPANION!=='0', sessionDialogue:process.env.LIFE_SESSION_DIALOGUE!=='0', discussionTopics:process.env.LIFE_DISCUSSION_TOPICS!=='0', semanticUnderstanding:process.env.LIFE_SEMANTIC_UNDERSTANDING!=='0', dialogueMemory:process.env.LIFE_DIALOGUE_MEMORY!=='0', turnReaction:process.env.LIFE_MEMORY_REACTION==='1', sourceRelevance:process.env.LIFE_SOURCE_RELEVANCE!=='0', materialPresentation: 'generated', startPursuits: true });
try { await app.listen(port); }
catch (error) { await app.close(); process.stderr.write(error.code === 'EADDRINUSE' ? `端口 ${port} 已被占用，请检查已有服务或使用 --port 指定其他端口。\n` : '本地服务未能启动。\n'); process.exit(1); }
process.stdout.write(`有间已启动：http://127.0.0.1:${port}\n按 Ctrl+C 结束本次运行。\n`);
let stopping = false;
async function stop() { if (stopping) return; stopping = true; await app.close(); process.exit(0); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
