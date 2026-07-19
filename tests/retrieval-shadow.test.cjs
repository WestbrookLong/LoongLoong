const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PetDatabase, isoNow } = require("../electron/database.cjs");
const { PROFILE_ID, vectorToBlob } = require("../electron/embedding.cjs");
const { readDataset, seedDataset } = require("../electron/retrieval-eval.cjs");
const { analyzeQuery, retrieveMemoryEnhanced } = require("../electron/retrieval.cjs");

async function createDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pet-retrieval-shadow-"));
  const db = await new PetDatabase(path.join(directory, "pet.db")).initialize();
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return db;
}

function putVector(db, objectId, values) {
  const now = isoNow();
  db.run(
    `INSERT INTO memory_embeddings
     (object_type, object_id, embedding_profile_id, content_schema_version, content_hash,
      model, dimension, vector_blob, status, created_at, updated_at)
     VALUES ('claim', $id, $profile, 'test', $hash, 'fake', $dimension, $blob, 'ready', $now, $now)`,
    { $id: objectId, $profile: PROFILE_ID, $hash: `hash-${objectId}`, $dimension: values.length,
      $blob: vectorToBlob(values), $now: now },
  );
}

test("analyzes temporal, explanation, and low-information query intent", () => {
  assert.equal(analyzeQuery("Where did I live previously?", "text").temporalIntent, true);
  assert.equal(analyzeQuery("Why did transcription fail?", "deep").explanationIntent, true);
  assert.equal(analyzeQuery("继续", "text").semanticEligible, false);
  assert.equal(analyzeQuery("verification code 482913", "text").semanticEligible, false);
});

test("runs semantic recall in shadow without changing selected prompt memory", async (t) => {
  const db = await createDatabase(t);
  const dataset = readDataset(path.join(__dirname, "fixtures", "retrieval-baseline-v1.json"));
  seedDataset(db, dataset);
  putVector(db, "claim_reply_concise", [1, 0, 0, 0]);
  putVector(db, "claim_db_sqlite", [0, 1, 0, 0]);
  const session = db.getActiveSession();
  const result = await retrieveMemoryEnhanced(db, {
    query: "How verbose should your technical answers be?",
    sessionId: session.id,
    mode: "text",
  }, {
    settings: { embeddingEnabled: "true", remoteEmbeddingConsent: "true" },
    apiKey: "test",
    embedder: async () => [Float32Array.from([1, 0, 0, 0])],
  });
  assert.equal(result.selectedClaimIds.includes("claim_reply_concise"), false);
  assert.equal(result.shadowSemantic[0].objectId, "claim_reply_concise");
  const stage = db.get("SELECT * FROM retrieval_stage_logs WHERE retrieval_id = $id", { $id: result.id });
  assert.equal(stage.status, "complete");
  const payload = JSON.parse(stage.payload_json);
  assert.ok(payload.shadow_only.includes("claim:claim_reply_concise"));
});

test("records a deterministic shadow skip when the index is unavailable", async (t) => {
  const db = await createDatabase(t);
  const session = db.getActiveSession();
  const result = await retrieveMemoryEnhanced(db, { query: "What should I remember?", sessionId: session.id, mode: "text" }, {
    settings: { embeddingEnabled: "true", remoteEmbeddingConsent: "true" }, apiKey: "test",
  });
  assert.deepEqual(result.shadowSemantic, []);
  assert.equal(db.get("SELECT status FROM retrieval_stage_logs WHERE retrieval_id = $id", { $id: result.id }).status, "skipped");
});
