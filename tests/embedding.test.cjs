const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PetDatabase } = require("../electron/database.cjs");
const {
  blobToVector,
  cosineSimilarity,
  embedTexts,
  processEmbeddingJobs,
  reconcileEmbeddingIndex,
  vectorToBlob,
} = require("../electron/embedding.cjs");
const { readDataset, seedDataset } = require("../electron/retrieval-eval.cjs");

async function createTestDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pet-embedding-test-"));
  const database = await new PetDatabase(path.join(directory, "pet.db")).initialize();
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return database;
}

test("serializes normalized Float32 embeddings without losing cosine similarity", () => {
  const left = Float32Array.from([3, 4]);
  const restored = blobToVector(vectorToBlob(left));
  assert.equal(restored.length, 2);
  assert.ok(Math.abs(cosineSimilarity(restored, restored) - 1) < 0.00001);
});

test("uses the Alibaba DashScope native embedding contract", async () => {
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({ output: { embeddings: [{ text_index: 0, embedding: [1, 0, 0, 0] }] } }),
    };
  };
  const [vector] = await embedTexts({
    settings: {
      embeddingBaseUrl: "https://dashscope.aliyuncs.com/api/v1/",
      embeddingModel: "text-embedding-v4",
      embeddingDimension: "4",
      embeddingBatchSize: "10",
    },
    apiKey: "test-key",
    texts: ["query"],
    textType: "query",
    instruct: "Retrieve durable personal memory.",
    fetchImpl,
  });
  assert.match(request.url, /api\/v1\/services\/embeddings\/text-embedding\/text-embedding$/);
  assert.equal(request.body.parameters.text_type, "query");
  assert.equal(request.body.parameters.instruct, "Retrieve durable personal memory.");
  assert.equal(request.options.headers.Authorization, "Bearer test-key");
  assert.equal(vector.length, 4);
});

test("reconciles persistent jobs and stores versioned embeddings", async (t) => {
  const db = await createTestDatabase(t);
  const dataset = readDataset(path.join(__dirname, "fixtures", "retrieval-baseline-v1.json"));
  seedDataset(db, { ...dataset, distractor_count: 0 });
  const queued = reconcileEmbeddingIndex(db);
  assert.ok(queued >= dataset.claims.filter((item) => ["active", "disputed", undefined].includes(item.status)).length);
  const fakeEmbedder = async ({ texts }) => texts.map((text) => {
    const vector = new Float32Array(1024);
    vector[text.length % 1024] = 1;
    return vector;
  });
  const result = await processEmbeddingJobs({
    db,
    settings: { embeddingEnabled: "true", remoteEmbeddingConsent: "true" },
    apiKey: "test",
    limit: 100,
    embedder: fakeEmbedder,
  });
  assert.ok(result.processed > 0);
  const row = db.get("SELECT * FROM memory_embeddings WHERE status = 'ready' LIMIT 1");
  assert.equal(row.dimension, 1024);
  assert.equal(blobToVector(row.vector_blob).length, 1024);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM embedding_jobs WHERE status = 'failed'").count, 0);
});

test("remote embedding consent prevents background API calls", async (t) => {
  const db = await createTestDatabase(t);
  let called = false;
  const result = await processEmbeddingJobs({
    db,
    settings: { embeddingEnabled: "true", remoteEmbeddingConsent: "false" },
    apiKey: "test",
    embedder: async () => { called = true; return []; },
  });
  assert.deepEqual(result, { processed: 0, failed: 0 });
  assert.equal(called, false);
});
