const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PetDatabase } = require("../electron/database.cjs");
const {
  applyMemoryOutput,
  cleanMemoryQuality,
  compactSessionContext,
  consolidateDayIntelligently,
  runMemoryExtraction,
} = require("../electron/memory-intelligence.cjs");
const { captureUserTurn } = require("../electron/memory.cjs");

async function createTestDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pet-intelligence-test-"));
  const database = await new PetDatabase(path.join(directory, "pet.db")).initialize();
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return database;
}

test("accepts grounded memory and rejects fabricated evidence", async (t) => {
  const db = await createTestDatabase(t);
  const session = db.getActiveSession();
  const message = db.addMessage({
    sessionId: session.id,
    role: "user",
    content: "我决定让 Pet 使用大模型进行智能记忆压缩。",
  });
  const valid = applyMemoryOutput(
    db,
    {
      events: [{
        event_type: "project_decision",
        summary: "用户决定采用智能记忆压缩。",
        evidence: [{ message_id: message.id, quote: "使用大模型进行智能记忆压缩" }],
      }],
      claim_candidates: [{
        namespace: "project",
        claim_type: "decision",
        subject: "pet.memory",
        predicate: "compression_strategy",
        value: "llm",
        canonical_text: "Pet 使用大模型进行智能记忆压缩。",
        confidence: 0.96,
        importance: 0.9,
        stability: 0.85,
        explicit: true,
        evidence: [{ message_id: message.id, quote: "使用大模型进行智能记忆压缩" }],
      }],
    },
    { sourceMessages: [message], runId: "run-valid" },
  );
  assert.equal(valid.eventIds.length, 1);
  assert.equal(valid.claimIds.length, 1);
  assert.equal(db.get("SELECT status FROM memory_claims WHERE id = $id", { $id: valid.claimIds[0] }).status, "active");
  assert.ok(db.get("SELECT * FROM memory_evidence WHERE claim_id = $id", { $id: valid.claimIds[0] }));

  const invalid = applyMemoryOutput(
    db,
    {
      claim_candidates: [{
        canonical_text: "用户住在火星。",
        evidence: [{ message_id: message.id, quote: "用户住在火星" }],
      }],
    },
    { sourceMessages: [message], runId: "run-invalid" },
  );
  assert.equal(invalid.claimIds.length, 0);
});

test("LLM extraction records an auditable run", async (t) => {
  const db = await createTestDatabase(t);
  const session = db.getActiveSession();
  const message = db.addMessage({ sessionId: session.id, role: "user", content: "请记住，我偏好简洁回复。" });
  const complete = async () => ({
    data: {
      events: [],
      claim_candidates: [{
        namespace: "user",
        claim_type: "preference",
        subject: "user",
        predicate: "response_style",
        value: "concise",
        canonical_text: "用户偏好简洁回复。",
        confidence: 0.98,
        importance: 0.8,
        stability: 0.9,
        explicit: true,
        evidence: [{ message_id: message.id, quote: "我偏好简洁回复" }],
      }],
    },
    raw: "{}",
    usage: {},
  });
  const result = await runMemoryExtraction({
    db,
    settings: { chatBaseUrl: "http://localhost:1234/v1", memoryModel: "test", memoryBatchSize: "2" },
    apiKey: "",
    sessionId: session.id,
    trigger: "explicit",
    sourceMessageIds: [message.id],
    force: true,
    complete,
  });
  assert.equal(result.skipped, false);
  assert.equal(db.get("SELECT status FROM memory_extraction_runs WHERE id = $id", { $id: result.runId }).status, "complete");
  assert.ok(db.get("SELECT memory_processed_at FROM messages WHERE id = $id", { $id: message.id }).memory_processed_at);
});

test("context compaction creates a snapshot and preserves a raw tail", async (t) => {
  const db = await createTestDatabase(t);
  const session = db.getActiveSession();
  for (let index = 0; index < 12; index += 1) {
    db.addMessage({
      sessionId: session.id,
      role: index % 2 ? "assistant" : "user",
      content: `消息 ${index} ${"上下文内容".repeat(80)}`,
    });
  }
  const complete = async () => ({
    data: {
      session_state: {
        goal: ["验证上下文压缩"],
        current_state: ["保留最近消息"],
        constraints: [],
        decisions: [],
        open_loops: [],
        commitments: [],
        relevant_artifacts: [],
        interaction_state: "",
      },
      summary_text: "用户正在验证上下文压缩，最近消息需要保留。",
      memory_output: { events: [], claim_candidates: [] },
    },
    raw: "{}",
    usage: {},
  });
  const result = await compactSessionContext({
    db,
    settings: {
      chatBaseUrl: "http://localhost:1234/v1",
      compressionModel: "test",
      contextWindowTokens: "4096",
      reservedOutputTokens: "512",
      contextSoftThreshold: "0.5",
      contextTargetRatio: "0.45",
    },
    apiKey: "",
    sessionId: session.id,
    systemPrompt: "system",
    memoryContext: "memory",
    force: true,
    complete,
  });
  assert.equal(result.compacted, true);
  assert.ok(result.snapshot.id);
  assert.equal(typeof JSON.parse(result.snapshot.continuity_refs_json).continuity_state_version, "number");
  assert.ok(result.messages.length >= 3);
  assert.ok(result.messages.length < 13);
  assert.equal(db.get("SELECT status FROM context_compaction_runs WHERE id = $id", { $id: result.runId }).status, "complete");
});

test("daily intelligent consolidation writes a narrative and promotes grounded claims", async (t) => {
  const db = await createTestDatabase(t);
  const session = db.getActiveSession();
  const message = db.addMessage({ sessionId: session.id, role: "user", content: "Pet 的记忆必须保留原始证据。" });
  captureUserTurn(db, {
    messageId: message.id,
    sessionId: session.id,
    text: message.content,
    useDeterministicClaims: false,
  });
  const event = db.get("SELECT * FROM events WHERE source_id = $id", { $id: message.id });
  const complete = async () => ({
    data: {
      daily_narrative: "今天确定了记忆系统必须保留原始证据。",
      memory_output: {
        claim_candidates: [{
          namespace: "project",
          claim_type: "decision",
          subject: "pet.memory",
          predicate: "evidence_policy",
          value: "preserve_raw_evidence",
          canonical_text: "Pet 的记忆系统必须保留原始证据。",
          confidence: 0.96,
          importance: 0.9,
          stability: 0.9,
          source_event_ids: [event.id],
        }],
      },
    },
    raw: "{}",
    usage: {},
  });
  const result = await consolidateDayIntelligently({
    db,
    settings: { chatBaseUrl: "http://localhost:1234/v1", compressionModel: "test" },
    apiKey: "",
    dateText: db.ensureJournalDay().local_date,
    complete,
  });
  assert.equal(result.skipped, false);
  assert.match(db.get("SELECT summary FROM journal_days WHERE id = $id", { $id: event.journal_day_id }).summary, /原始证据/);
  assert.equal(db.get("SELECT status FROM memory_claims WHERE id = $id", { $id: result.claimIds[0] }).status, "active");
});

test("rejects transient operational state instead of turning it into long-term memory", async (t) => {
  const db = await createTestDatabase(t);
  const session = db.getActiveSession();
  const message = db.addMessage({
    sessionId: session.id,
    role: "assistant",
    content: "The model API is not yet configured, so Pet is currently using offline mode.",
  });
  const result = applyMemoryOutput(
    db,
    {
      claim_candidates: [{
        namespace: "system",
        claim_type: "state",
        subject: "pet.model",
        predicate: "configuration",
        value: "missing",
        canonical_text: "The model API is not yet configured.",
        confidence: 0.99,
        importance: 0.9,
        stability: 0.8,
        evidence: [{ message_id: message.id, quote: "model API is not yet configured" }],
      }],
    },
    { sourceMessages: [message], runId: "run-transient" },
  );
  assert.deepEqual(result.claimIds, []);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM memory_claims").count, 0);
});

test("deduplicates the same fact even when the LLM changes its claim schema", async (t) => {
  const db = await createTestDatabase(t);
  const session = db.getActiveSession();
  const message = db.addMessage({
    sessionId: session.id,
    role: "user",
    content: "Please remember that the assistant's name is Little Step.",
  });
  const common = {
    canonical_text: "The assistant's name is Little Step.",
    confidence: 0.98,
    importance: 0.8,
    stability: 0.95,
    explicit: true,
    evidence: [{ message_id: message.id, quote: "assistant's name is Little Step" }],
  };
  const first = applyMemoryOutput(
    db,
    { claim_candidates: [{ ...common, namespace: "pet", claim_type: "identity", subject: "pet", predicate: "name", value: "Little Step" }] },
    { sourceMessages: [message], runId: "run-dedup-1" },
  );
  const second = applyMemoryOutput(
    db,
    { claim_candidates: [{ ...common, namespace: "relationship", claim_type: "fact", subject: "assistant", predicate: "display_name", value: "Little Step" }] },
    { sourceMessages: [message], runId: "run-dedup-2" },
  );
  assert.equal(first.claimIds[0], second.claimIds[0]);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM memory_claims WHERE status IN ('candidate', 'active')").count, 1);

  db.db.run(
    `INSERT INTO memory_claims (
       id, namespace, claim_type, subject, predicate, object_json, value_hash,
       canonical_text, claim_key, cardinality, status, confidence, importance,
       stability, promotion_score, sensitivity, scope_type, created_at, updated_at
     ) VALUES (
       'duplicate-claim', 'other', 'fact', 'assistant', 'alias', '{"value":"Little Step"}',
       'duplicate-hash', $text, 'other:assistant:alias', 'single', 'candidate', 0.8,
       0.7, 0.7, 0.8, 'private', 'global', $createdAt, $createdAt
     )`,
    { $text: common.canonical_text, $createdAt: new Date(Date.now() + 1000).toISOString() },
  );
  cleanMemoryQuality(db);
  assert.equal(db.get("SELECT status FROM memory_claims WHERE id = 'duplicate-claim'").status, "superseded");
  assert.ok(db.get("SELECT * FROM claim_relations WHERE source_claim_id = 'duplicate-claim' AND relation = 'same_as'"));
});
