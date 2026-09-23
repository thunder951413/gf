import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { RecallEngine, RecallRepository } from "../lib/recall.mjs";
import { collectConversationMemory } from "../lib/conversation-memory.mjs";

class Store {
  constructor() {
    this.db = new DatabaseSync(":memory:");
    this.db.exec(`
      CREATE TABLE messages(id TEXT PRIMARY KEY,role TEXT,speaker TEXT,text TEXT,kind TEXT,created_at TEXT,content_id TEXT);
      CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    `);
  }
  transaction(fn) {
    const depth = this.depth || 0;
    const savepoint = `memory_test_${depth}`;
    this.db.exec(depth ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
    this.depth = depth + 1;
    try {
      const result = fn();
      this.db.exec(depth ? `RELEASE SAVEPOINT ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      this.db.exec(depth ? `ROLLBACK TO SAVEPOINT ${savepoint}; RELEASE SAVEPOINT ${savepoint}` : "ROLLBACK");
      throw error;
    } finally {
      this.depth = depth;
    }
  }
}

test("corrected assistant text is consolidated and an obsolete ledger quote disappears from retrieval", async () => {
  const store = new Store();
  store.db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,NULL)").run(
    "a1",
    "miyue",
    "assistant",
    "错误原话：我去了上海展览。",
    "chat",
    "2026-09-01T00:00:00.000Z",
  );
  let replacement = "更正后：我只是计划去苏州展览。";
  const projectSource = (row) => row.speaker === "assistant" ? { ...row, text: replacement } : row;
  const repo = new RecallRepository(store, {
    clock: () => new Date("2026-09-20T00:00:00.000Z"),
    getHistoryWindow: () => ({ historyWindowDays: 7, historyMaxTokens: 6000 }),
    projectSource,
  });
  let requestText, repair;
  const model = {
    publicConfig: () => ({ configured: true, model: "fixture" }),
    complete: async (messages) => {
      if (messages.at(-1).content.startsWith("{")) requestText = messages.at(-1).content;
      else repair = messages.at(-1).content;
      return JSON.stringify({
        items: [{
          subject: "character",
          kind: "event",
          topic: "苏州展览计划",
          summary: "林晓薇更正为只是计划去苏州展览。",
          status: "ongoing",
          evidence: [{ messageId: "s1", quote: "我只是计划去苏州展览" }],
        }],
        ignored: [],
      });
    },
  };
  const engine = new RecallEngine({ repo, model, roles: ["miyue"], clock: () => new Date("2026-09-20T00:00:00.000Z") });
  const result = await engine.run("miyue", { force: true });
  assert.equal(result.status, "updated", JSON.stringify({ result, repair, audit: store.db.prepare("SELECT * FROM consolidated_memory_audit").all() }));
  const request = JSON.parse(requestText);
  assert.equal(request.conversation[0].text, replacement);
  assert.doesNotMatch(JSON.stringify(request), /错误原话|上海展览/u);
  assert.equal(store.db.prepare("SELECT text FROM messages WHERE id='a1'").get().text, "错误原话：我去了上海展览。");
  assert.equal(repo.consolidated.snapshot("miyue").items[0].evidence[0].quote, "我只是计划去苏州展览");

  replacement = "再次更正：我没有这项计划。";
  assert.equal(repo.consolidated.snapshot("miyue").items.length, 0, "old quote is no longer allowed by projected source");
  const historyEdits = { project: (_scope, rows) => rows.map((row) => row.speaker === "assistant" ? { ...row, text: replacement } : row) };
  const candidates = collectConversationMemory({
    store,
    recallRepo: repo,
    episodes: { suppressedSourceIds: () => [], list: () => [] },
    historyEdits,
    scope: "miyue",
    now: new Date("2026-09-20T00:00:00.000Z"),
  });
  assert.ok(candidates.some((item) => item.id === "raw:a1" && item.text === replacement));
  assert.ok(candidates.every((item) => !item.text.includes("上海展览") && !item.text.includes("只是计划")));
});

test("hidden assistant sources advance consolidation without reaching the model and user text is unchanged", async () => {
  const store = new Store();
  const insert = store.db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,NULL)");
  insert.run("u1", "miyue", "user", "用户原话保留", "chat", "2026-09-01T00:00:00.000Z");
  insert.run("a1", "miyue", "assistant", "应被隐藏的角色原话", "chat", "2026-09-01T00:01:00.000Z");
  const repo = new RecallRepository(store, {
    clock: () => new Date("2026-09-20T00:00:00.000Z"),
    getHistoryWindow: () => ({ historyWindowDays: 7, historyMaxTokens: 6000 }),
    projectSource: () => null,
  });
  let requestText, repair;
  const model = {
    publicConfig: () => ({ configured: true, model: "fixture" }),
    complete: async (messages) => {
      if (messages.at(-1).content.startsWith("{")) requestText = messages.at(-1).content;
      else repair = messages.at(-1).content;
      return JSON.stringify({ items: [], ignored: [{ messageId: "s1", reason: "filler" }] });
    },
  };
  const engine = new RecallEngine({ repo, model, roles: ["miyue"], clock: () => new Date("2026-09-20T00:00:00.000Z") });
  const result = await engine.run("miyue", { force: true });
  assert.equal(result.status, "updated", JSON.stringify({ result, repair, audit: store.db.prepare("SELECT * FROM consolidated_memory_audit").all() }));
  const request = JSON.parse(requestText);
  assert.deepEqual(request.conversation.map((row) => row.text), ["用户原话保留"]);
  assert.equal(repo.consolidated.snapshot("miyue").cursor.id, "a1");
});
