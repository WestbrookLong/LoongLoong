const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { PetDatabase, isoNow } = require("../electron/database.cjs");
const { captureUserTurn } = require("../electron/memory.cjs");

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

test("renames and deletes a session while preserving materialized memory", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pet-session-delete-test-"));
  const db = await new PetDatabase(path.join(directory, "pet.db")).initialize();
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const session = db.getActiveSession();
  const renamed = db.renameSession(session.id, "  Personal notes   review  ");
  assert.equal(renamed.title, "Personal notes review");
  assert.throws(() => db.renameSession(session.id, " "), /不能为空/);

  const message = db.addMessage({
    sessionId: session.id,
    role: "user",
    content: "durable memory evidence",
  });
  const [eventId] = captureUserTurn(db, {
    messageId: message.id,
    sessionId: session.id,
    text: message.content,
  });
  const claimId = crypto.randomUUID();
  const now = isoNow();
  db.run(
    `INSERT INTO memory_claims
     (id, namespace, claim_type, subject, predicate, object_json, canonical_text,
      scope_type, claim_key, value_hash, cardinality, status, confidence, importance,
      stability, sensitivity, created_at, updated_at)
     VALUES ($id, 'user', 'fact', 'user', 'test_preference', '{}', 'Preserved memory',
      'global', $claimKey, $valueHash, 'single', 'active', 1, 1, 1, 'private', $now, $now)`,
    { $id: claimId, $claimKey: `test:${claimId}`, $valueHash: claimId, $now: now },
  );
  db.run(
    `INSERT INTO memory_evidence (claim_id, event_id, relation, weight, created_at)
     VALUES ($claimId, $eventId, 'supports', 1, $now)`,
    { $claimId: claimId, $eventId: eventId, $now: now },
  );
  const claimCount = Number(db.get("SELECT COUNT(*) AS count FROM memory_claims").count);
  assert.ok(claimCount > 0);
  assert.ok(db.get("SELECT * FROM memory_evidence WHERE event_id = $id", { $id: eventId }));

  db.deleteSession(session.id);

  assert.equal(db.get("SELECT * FROM sessions WHERE id = $id", { $id: session.id }), null);
  assert.equal(db.get("SELECT * FROM messages WHERE session_id = $id", { $id: session.id }), null);
  assert.equal(Number(db.get("SELECT COUNT(*) AS count FROM memory_claims").count), claimCount);
  assert.ok(db.get("SELECT * FROM memory_evidence WHERE event_id = $id", { $id: eventId }));
  const preservedEvent = db.get("SELECT * FROM events WHERE id = $id", { $id: eventId });
  assert.equal(preservedEvent.source_kind, "deleted_session");
  assert.equal(preservedEvent.source_id, null);
});
