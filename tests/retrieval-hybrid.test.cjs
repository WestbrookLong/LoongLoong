const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PetDatabase, isoNow } = require("../electron/database.cjs");
const { PROFILE_ID, vectorToBlob } = require("../electron/embedding.cjs");
const { readDataset, seedDataset } = require("../electron/retrieval-eval.cjs");
const { retrieveMemoryEnhanced } = require("../electron/retrieval.cjs");

async function createDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pet-retrieval-hybrid-"));
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

test("hybrid RRF promotes a semantic paraphrase into the packed prompt", async (t) => {
  const db = await createDatabase(t);
  const dataset = readDataset(path.join(__dirname, "fixtures", "retrieval-baseline-v1.json"));
  seedDataset(db, dataset);
  putVector(db, "claim_reply_concise", [1, 0, 0, 0]);
  putVector(db, "claim_db_sqlite", [0, 1, 0, 0]);
  const result = await retrieveMemoryEnhanced(db, {
    query: "How verbose should your technical answers be?",
    sessionId: db.getActiveSession().id,
    mode: "text",
  }, {
    settings: { embeddingEnabled: "true", remoteEmbeddingConsent: "true", hybridRetrievalEnabled: "true" },
    apiKey: "test",
    embedder: async () => [Float32Array.from([1, 0, 0, 0])],
  });
  assert.equal(result.hybrid, true);
  assert.ok(result.selectedClaimIds.includes("claim_reply_concise"), JSON.stringify(result.fusedCandidates.slice(0, 14).map((item) => ({ key: item.key, score: item.fusionScore, channels: item.channels }))));
  assert.match(result.context, /concise engineering explanations/);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM retrieval_stage_logs WHERE retrieval_id = $id AND stage = 'hybrid_fusion'", { $id: result.id }).count, 1);
});

test("eligibility prevents a historical claim from leaking into a current query", async (t) => {
  const db = await createDatabase(t);
  const dataset = readDataset(path.join(__dirname, "fixtures", "retrieval-baseline-v1.json"));
  seedDataset(db, dataset);
  putVector(db, "claim_residence_beijing", [1, 0, 0, 0]);
  putVector(db, "claim_residence_shanghai", [0.8, 0.2, 0, 0]);
  const result = await retrieveMemoryEnhanced(db, {
    query: "Where does the user live now?", sessionId: db.getActiveSession().id, mode: "text",
  }, {
    settings: { embeddingEnabled: "true", remoteEmbeddingConsent: "true", hybridRetrievalEnabled: "true" },
    apiKey: "test", embedder: async () => [Float32Array.from([1, 0, 0, 0])],
  });
  assert.ok(result.selectedClaimIds.includes("claim_residence_shanghai"));
  assert.equal(result.selectedClaimIds.includes("claim_residence_beijing"), false);
  assert.doesNotMatch(result.context, /lived in Beijing/);
});

test("voice mode keeps deterministic retrieval and skips semantic API calls", async (t) => {
  const db = await createDatabase(t);
  let called = false;
  const result = await retrieveMemoryEnhanced(db, {
    query: "Tell me about memory", sessionId: db.getActiveSession().id, mode: "voice",
  }, {
    settings: { embeddingEnabled: "true", remoteEmbeddingConsent: "true", hybridRetrievalEnabled: "true" },
    apiKey: "test", embedder: async () => { called = true; return []; },
  });
  assert.equal(called, false);
  assert.equal(result.hybrid, undefined);
});
