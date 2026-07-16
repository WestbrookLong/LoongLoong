const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PetDatabase } = require("../electron/database.cjs");
const {
  captureUserTurn,
  consolidateDay,
  containsForbiddenSecret,
  retrieveMemory,
} = require("../electron/memory.cjs");

async function createTestDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pet-memory-test-"));
  const database = await new PetDatabase(path.join(directory, "pet.db")).initialize();
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return database;
}

test("filters secrets before memory capture", () => {
  assert.equal(containsForbiddenSecret("验证码是 482913"), true);
  assert.equal(containsForbiddenSecret("我们决定使用 SQLite"), false);
});

test("captures explicit memory with evidence and retrieves it", async (t) => {
  const db = await createTestDatabase(t);
  const session = db.getActiveSession();
  const message = db.addMessage({
    sessionId: session.id,
    role: "user",
    content: "请记住，我希望 AI 宠物项目使用 SQLite。",
  });
  captureUserTurn(db, {
    messageId: message.id,
    sessionId: session.id,
    text: message.content,
  });

  const event = db.get("SELECT * FROM events ORDER BY recorded_at DESC LIMIT 1");
  const claim = db.get("SELECT * FROM memory_claims ORDER BY created_at DESC LIMIT 1");
  const evidence = db.get("SELECT * FROM memory_evidence WHERE claim_id = $id", { $id: claim.id });
  assert.equal(event.activity_id, "pet");
  assert.equal(claim.status, "active");
  assert.equal(evidence.event_id, event.id);

  const retrieval = retrieveMemory(db, {
    query: "宠物项目数据库用什么？",
    sessionId: session.id,
    activityId: "pet",
    mode: "text",
  });
  assert.match(retrieval.context, /SQLite/);
  assert.ok(retrieval.tokenEstimate > 0);
});

test("daily consolidation is idempotent for an unchanged day", async (t) => {
  const db = await createTestDatabase(t);
  const session = db.getActiveSession();
  const message = db.addMessage({ sessionId: session.id, role: "user", content: "我决定 Pet 使用 SQLite。" });
  captureUserTurn(db, { messageId: message.id, sessionId: session.id, text: message.content });

  const first = consolidateDay(db);
  const second = consolidateDay(db);
  assert.equal(first.skipped, false);
  assert.equal(second.skipped, true);
  assert.equal(second.reason, "already_current");
});

