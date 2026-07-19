const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PetDatabase, isoNow } = require("../electron/database.cjs");
const { PROFILE_ID, vectorToBlob } = require("../electron/embedding.cjs");
const { readDataset, seedDataset } = require("../electron/retrieval-eval.cjs");
const { retrieveMemoryEnhanced } = require("../electron/retrieval.cjs");
const { rerankCandidates, shouldRerank, validateDecisions } = require("../electron/retrieval-reranker.cjs");

async function createDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pet-reranker-"));
  const db = await new PetDatabase(path.join(directory, "pet.db")).initialize();
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return db;
}

function putVector(db, id, values) {
  const now = isoNow();
  db.run(`INSERT INTO memory_embeddings
    (object_type, object_id, embedding_profile_id, content_schema_version, content_hash,
     model, dimension, vector_blob, status, created_at, updated_at)
    VALUES ('claim', $id, $profile, 'test', $hash, 'fake', $dimension, $blob, 'ready', $now, $now)`,
    { $id: id, $profile: PROFILE_ID, $hash: `hash-${id}`, $dimension: values.length, $blob: vectorToBlob(values), $now: now });
}

test("reranker trigger is conditional and disabled for voice", () => {
  const fused = [{ objectType: "claim", row: { status: "active" }, channels: { semantic: { rank: 1 } }, fusionScore: 0.02 }];
  assert.equal(shouldRerank({}, fused, "voice"), false);
  assert.equal(shouldRerank({}, fused, "text"), true);
  assert.equal(shouldRerank({}, fused, "deep"), true);
});

test("validates the closed reranker vocabulary and ignores invented IDs", () => {
  const result = validateDecisions({ decisions: [
    { id: "claim:a", decision: "include", relevance: 0.9, usage: "answer" },
    { id: "claim:invented", decision: "include", relevance: 1, usage: "answer" },
    { id: "claim:b", decision: "maybe", relevance: 1, usage: "answer" },
  ] }, new Set(["claim:a", "claim:b"]));
  assert.deepEqual(result, [{ id: "claim:a", decision: "include", relevance: 0.9, usage: "answer" }]);
});

test("applies structured reranking then passes through deterministic packing", async (t) => {
  const db = await createDatabase(t);
  const dataset = readDataset(path.join(__dirname, "fixtures", "retrieval-baseline-v1.json"));
  seedDataset(db, dataset);
  putVector(db, "claim_reply_concise", [1, 0, 0, 0]);
  putVector(db, "claim_db_sqlite", [0, 1, 0, 0]);
  const complete = async ({ messages }) => {
    const input = JSON.parse(messages[1].content);
    return { data: { decisions: input.candidates.map((candidate) => ({
      id: candidate.id,
      decision: candidate.id === "claim:claim_reply_concise" ? "include" : "uncertain",
      relevance: candidate.id === "claim:claim_reply_concise" ? 1 : 0.1,
      usage: "answer",
    })).concat({ id: "claim:invented", decision: "include", relevance: 1, usage: "answer" }) }, usage: { total_tokens: 42 } };
  };
  const result = await retrieveMemoryEnhanced(db, {
    query: "How verbose should your technical answers be?", sessionId: db.getActiveSession().id, mode: "text",
  }, {
    settings: { embeddingEnabled: "true", remoteEmbeddingConsent: "true", hybridRetrievalEnabled: "true",
      rerankerEnabled: "true", rerankerTimeoutMs: "5000" },
    apiKey: "test", embedder: async () => [Float32Array.from([1, 0, 0, 0])], rerankerComplete: complete,
  });
  assert.equal(result.reranked, true);
  assert.equal(result.selectedClaimIds[0], "claim_reply_concise");
  const stage = db.get("SELECT * FROM retrieval_stage_logs WHERE retrieval_id = $id AND stage = 'llm_reranker'", { $id: result.id });
  assert.equal(stage.status, "complete");
  assert.equal(JSON.parse(stage.payload_json).decisions.some((item) => item.id === "claim:invented"), false);
});

test("reranker failure preserves the hybrid fallback", async () => {
  const fused = [{ key: "claim:a", objectType: "claim", objectId: "a", text: "a", row: { status: "active" }, channels: {}, fusionScore: 0.2 }];
  await assert.rejects(() => rerankCandidates({ settings: { rerankerTimeoutMs: "500" }, apiKey: "test", query: "q",
    analysis: {}, fused, complete: async () => { throw new Error("offline"); } }), /offline/);
});
