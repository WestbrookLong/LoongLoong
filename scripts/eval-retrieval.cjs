const path = require("node:path");
const { evaluateDataset, readDataset } = require("../electron/retrieval-eval.cjs");
const { PROFILE_ID, vectorToBlob } = require("../electron/embedding.cjs");
const { retrieveMemoryEnhanced } = require("../electron/retrieval.cjs");
const { isoNow } = require("../electron/database.cjs");

async function main() {
  const fixturePath = path.join(process.cwd(), "tests", "fixtures", "retrieval-baseline-v1.json");
  const hybrid = process.argv.includes("--hybrid");
  const report = await evaluateDataset(readDataset(fixturePath), hybrid ? {
    retrieve: retrieveMemoryEnhanced,
    settings: { embeddingEnabled: "true", remoteEmbeddingConsent: "true", hybridRetrievalEnabled: "true" },
    apiKey: "offline-eval",
    embedder: async ({ texts }) => texts.map((text) => /verbose|technical answers/i.test(text)
      ? Float32Array.from([1, 0, 0, 0]) : Float32Array.from([0, 1, 0, 0])),
    prepare: async (db, dataset) => {
      const now = isoNow();
      for (const claim of dataset.claims.filter((item) => !["superseded"].includes(item.status))) {
        const vector = claim.id === "claim_reply_concise" ? [1, 0, 0, 0] : [0, 1, 0, 0];
        db.run(`INSERT INTO memory_embeddings
          (object_type, object_id, embedding_profile_id, content_schema_version, content_hash,
           model, dimension, vector_blob, status, created_at, updated_at)
          VALUES ('claim', $id, $profile, 'offline-eval', $hash, 'offline-eval', 4, $blob, 'ready', $now, $now)`,
          { $id: claim.id, $profile: PROFILE_ID, $hash: `eval-${claim.id}`, $blob: vectorToBlob(vector), $now: now });
      }
    },
  } : {});
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
