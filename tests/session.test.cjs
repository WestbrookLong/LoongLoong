const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { PetDatabase, isoNow } = require("../electron/database.cjs");

test("lists historical sessions and reactivates one with its messages", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pet-session-test-"));
  const db = await new PetDatabase(path.join(directory, "pet.db")).initialize();
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const first = db.getActiveSession();
  db.addMessage({ sessionId: first.id, role: "user", content: "第一段会话的问题" });
  db.run("UPDATE sessions SET ended_at = $now WHERE id = $id", { $id: first.id, $now: isoNow() });

  const secondId = crypto.randomUUID();
  db.run(
    "INSERT INTO sessions (id, title, started_at) VALUES ($id, $title, $startedAt)",
    { $id: secondId, $title: "第二段会话", $startedAt: isoNow() },
  );
  db.addMessage({ sessionId: secondId, role: "assistant", content: "第二段会话的最后消息" });

  const sessions = db.listSessions();
  assert.equal(sessions.length, 2);
  assert.equal(sessions.find((session) => session.id === first.id).preview, "第一段会话的问题");
  assert.equal(sessions.find((session) => session.id === secondId).message_count, 1);

  const activated = db.activateSession(first.id);
  assert.equal(activated.id, first.id);
  assert.equal(db.getActiveSession().id, first.id);
  assert.ok(db.get("SELECT ended_at FROM sessions WHERE id = $id", { $id: secondId }).ended_at);
  assert.equal(db.messagesForSession(first.id).at(-1).content, "第一段会话的问题");
  assert.throws(() => db.activateSession("missing"), /会话不存在/);
});
