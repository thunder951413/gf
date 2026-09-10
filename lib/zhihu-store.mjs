import { randomUUID, createHash } from 'node:crypto';
import { localDayStart } from './proactive-store.mjs';

export const ZHIHU_FEED_ID = 'zhihu-research';
export const topicKey = title => createHash('sha256').update(String(title).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]/gu, '')).digest('hex');
const initial = { lastRunAt: null, nextRunAt: null, cooldownUntil: null, lastError: null, lastReason: '等待发现新话题', headlines: [], discoveredCount: 0 };
export class ZhihuRepository {
  constructor(store, { clock = () => new Date() } = {}) {
    this.store = store; this.db = store.db; this.clock = clock;
    this.db.exec(`CREATE TABLE IF NOT EXISTS zhihu_attempts(id TEXT PRIMARY KEY,kind TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS zhihu_attempts_time ON zhihu_attempts(created_at);
      CREATE TABLE IF NOT EXISTS zhihu_topics(topic_key TEXT PRIMARY KEY,title TEXT NOT NULL,source_url TEXT NOT NULL,status TEXT NOT NULL,updated_at TEXT NOT NULL,retry_at TEXT,content_id TEXT,error TEXT);`);
  }
  runtime() { try { return { ...initial, ...JSON.parse(this.db.prepare("SELECT value FROM metadata WHERE key='zhihu_runtime'").get()?.value || '{}') }; } catch { return { ...initial }; } }
  update(patch) { const result = { ...this.runtime(), ...patch }; this.db.prepare("INSERT INTO metadata(key,value) VALUES('zhihu_runtime',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(result)); return result; }
  usage() {
    const rows = this.db.prepare('SELECT kind,COUNT(*) AS n FROM zhihu_attempts WHERE created_at>=? GROUP BY kind').all(localDayStart(this.clock()));
    return { requestsToday: rows.reduce((n, r) => n + Number(r.n), 0), agentCallsToday: Number(rows.find(r => r.kind === 'agent')?.n || 0) };
  }
  reserve(config, kind) {
    return this.store.transaction(() => {
      const used = this.usage();
      if (used.requestsToday >= config.dailyRequestLimit || (kind === 'agent' && used.agentCallsToday >= config.dailyAgentLimit)) return false;
      this.db.prepare('INSERT INTO zhihu_attempts VALUES(?,?,?)').run(randomUUID(), kind, this.clock().toISOString()); return true;
    });
  }
  available(title, url) {
    if (url && this.db.prepare("SELECT 1 FROM zhihu_topics WHERE source_url=? AND status='complete'").get(url)) return false;
    const row = this.db.prepare('SELECT * FROM zhihu_topics WHERE topic_key=?').get(topicKey(title));
    return !row || (row.status !== 'complete' && (!row.retry_at || row.retry_at <= this.clock().toISOString()));
  }
  record(topic, status, error = null, retryMinutes = 60) {
    const now = this.clock();
    this.db.prepare(`INSERT INTO zhihu_topics(topic_key,title,source_url,status,updated_at,retry_at,error) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(topic_key) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,retry_at=excluded.retry_at,error=excluded.error`).run(topicKey(topic.title), topic.title, topic.url, status, now.toISOString(), new Date(+now + retryMinutes * 60000).toISOString(), error);
  }
  commit(topic, summary, research) {
    return this.store.transaction(() => {
      const existing = this.db.prepare('SELECT status FROM zhihu_topics WHERE topic_key=?').get(topicKey(topic.title));
      if (existing?.status === 'complete') return null;
      this.db.prepare('INSERT OR IGNORE INTO feeds(id,url,title) VALUES(?,?,?)').run(ZHIHU_FEED_ID, 'https://developer.zhihu.com/', '知乎热点研究');
      const id = randomUUID(), now = this.clock().toISOString();
      const result = this.db.prepare('INSERT OR IGNORE INTO content(id,feed_id,title,url,summary,published_at,source,created_at,research_json) VALUES(?,?,?,?,?,?,?,?,?)').run(id, ZHIHU_FEED_ID, topic.title + '｜知乎观点', topic.url, summary, now, research.generatedBy ? '知乎直答 · AI 资料整理' : '知乎 · 回答摘录', now, JSON.stringify(research));
      if (!result.changes) return null;
      this.db.prepare(`INSERT INTO zhihu_topics(topic_key,title,source_url,status,updated_at,content_id) VALUES(?,?,?,?,?,?)
        ON CONFLICT(topic_key) DO UPDATE SET status='complete',updated_at=excluded.updated_at,content_id=excluded.content_id,error=NULL,retry_at=NULL`).run(topicKey(topic.title), topic.title, topic.url, 'complete', now, id);
      return this.store.getContent(id);
    });
  }
  recent() { return this.db.prepare('SELECT * FROM zhihu_topics ORDER BY updated_at DESC,rowid DESC LIMIT 12').all().map(r => ({ id: r.topic_key, title: r.title, status: r.status, createdAt: r.updated_at, contentId: r.content_id, error: r.error })); }
}
