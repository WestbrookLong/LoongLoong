const crypto = require("node:crypto");
const { isoNow } = require("./database.cjs");
const { containsForbiddenSecret } = require("./memory.cjs");

const PROFILE_ID = "aliyun-text-embedding-v4-1024-v1";
const DOCUMENT_SCHEMA_VERSION = "pet-memory-document-v1";
const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const normalizeBase = (value) => String(value || "https://dashscope.aliyuncs.com/api/v1").replace(/\/+$/, "");

function vectorToBlob(vector) {
  const normalized = normalizeVector(vector);
  return new Uint8Array(normalized.buffer.slice(normalized.byteOffset, normalized.byteOffset + normalized.byteLength));
}

function blobToVector(blob) {
  if (!blob) return new Float32Array();
  const bytes = blob instanceof Uint8Array ? blob : new Uint8Array(blob);
  const copy = bytes.slice();
  return new Float32Array(copy.buffer);
}

function normalizeVector(vector) {
  const values = Float32Array.from(vector || []);
  let squareSum = 0;
  for (const value of values) squareSum += value * value;
  const magnitude = Math.sqrt(squareSum);
  if (!magnitude) throw new Error("Embedding API returned an empty vector.");
  for (let index = 0; index < values.length; index += 1) values[index] /= magnitude;
  return values;
}

function cosineSimilarity(left, right) {
  if (!left.length || left.length !== right.length) return -1;
  let score = 0;
  for (let index = 0; index < left.length; index += 1) score += left[index] * right[index];
  return score;
}

async function embedTexts({ settings, apiKey, texts, textType = "document", instruct = "", fetchImpl = fetch, signal }) {
  if (!apiKey) throw new Error("Embedding requires an API Key.");
  const dimension = Number(settings.embeddingDimension || 1024);
  const batchSize = Math.min(10, Math.max(1, Number(settings.embeddingBatchSize || 10)));
  const output = [];
  for (let offset = 0; offset < texts.length; offset += batchSize) {
    const batch = texts.slice(offset, offset + batchSize);
    const parameters = { dimension, output_type: "dense", text_type: textType };
    if (instruct) parameters.instruct = instruct;
    const response = await fetchImpl(`${normalizeBase(settings.embeddingBaseUrl)}/services/embeddings/text-embedding/text-embedding`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.embeddingModel || "text-embedding-v4",
        input: { texts: batch },
        parameters,
      }),
      signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.message || body?.code || `Embedding request failed (${response.status}).`);
    const rows = body?.output?.embeddings;
    if (!Array.isArray(rows) || rows.length !== batch.length) throw new Error("Embedding API returned an invalid batch.");
    rows.sort((a, b) => Number(a.text_index || 0) - Number(b.text_index || 0));
    for (const row of rows) {
      if (!Array.isArray(row.embedding) || row.embedding.length !== dimension) {
        throw new Error(`Embedding dimension mismatch: expected ${dimension}, received ${row.embedding?.length || 0}.`);
      }
      output.push(normalizeVector(row.embedding));
    }
  }
  return output;
}

function claimDocument(row) {
  return [
    "type: claim",
    `subject: ${row.subject}`,
    `predicate: ${row.predicate}`,
    `scope: ${row.scope_type}${row.scope_id ? `/${row.scope_id}` : ""}`,
    `state: ${row.status}/${row.temporal_state}`,
    `content: ${row.canonical_text}`,
  ].join("\n");
}

function topicDocument(row) {
  return ["type: topic", `title: ${row.title}`, `overview: ${row.overview || ""}`, `current position: ${row.current_position || ""}`].join("\n");
}

function openLoopDocument(row) {
  return ["type: open loop", `topic: ${row.topic_title || ""}`, `owner: ${row.owner}`, `status: ${row.status}`, `content: ${row.description}`].join("\n");
}

function eventDocument(row) {
  return ["type: event", `event: ${row.event_type}`, `occurred: ${row.occurred_at}`, `content: ${row.content}`].join("\n");
}

function getMemoryDocument(db, objectType, objectId) {
  let row;
  let text;
  if (objectType === "claim") {
    row = db.get("SELECT * FROM memory_claims WHERE id = $id", { $id: objectId });
    text = row && claimDocument(row);
  } else if (objectType === "topic") {
    row = db.get("SELECT * FROM topic_threads WHERE id = $id", { $id: objectId });
    text = row && topicDocument(row);
  } else if (objectType === "open_loop") {
    row = db.get(`SELECT ol.*, t.title AS topic_title FROM open_loops ol LEFT JOIN topic_threads t ON t.id = ol.topic_id WHERE ol.id = $id`, { $id: objectId });
    text = row && openLoopDocument(row);
  } else if (objectType === "event") {
    row = db.get("SELECT * FROM events WHERE id = $id", { $id: objectId });
    text = row && eventDocument(row);
  }
  if (!row || !text || containsForbiddenSecret(text)) return null;
  const policy = db.get("SELECT * FROM memory_object_policies WHERE object_type = $type AND object_id = $id", { $type: objectType, $id: objectId });
  if (["local_only", "do_not_embed"].includes(policy?.embedding_policy)) return null;
  return {
    objectType,
    objectId,
    text,
    contentHash: hash(`${DOCUMENT_SCHEMA_VERSION}\n${text}`),
    sourceUpdatedAt: row.updated_at || row.last_touched_at || row.recorded_at || row.occurred_at || null,
  };
}

function eligibleMemoryObjects(db) {
  const objects = [];
  for (const row of db.all("SELECT id FROM memory_claims WHERE status IN ('active', 'disputed')")) objects.push(["claim", row.id]);
  for (const row of db.all("SELECT id FROM topic_threads WHERE status NOT IN ('merged', 'archived')")) objects.push(["topic", row.id]);
  for (const row of db.all("SELECT id FROM open_loops WHERE status = 'open'")) objects.push(["open_loop", row.id]);
  for (const row of db.all("SELECT id FROM events WHERE sensitivity != 'forbidden' AND (retention_class = 'durable' OR continuity_value >= 0.7)")) objects.push(["event", row.id]);
  return objects;
}

function enqueueEmbeddingJob(db, document, profileId = PROFILE_ID) {
  const now = isoNow();
  db.db.run(
    `INSERT OR IGNORE INTO embedding_jobs
     (id, object_type, object_id, embedding_profile_id, expected_content_hash,
      status, attempts, available_at, created_at, updated_at)
     VALUES ($id, $type, $objectId, $profileId, $hash, 'pending', 0, $now, $now, $now)`,
    {
      $id: crypto.randomUUID(), $type: document.objectType, $objectId: document.objectId,
      $profileId: profileId, $hash: document.contentHash, $now: now,
    },
  );
}

function reconcileEmbeddingIndex(db, profileId = PROFILE_ID) {
  let queued = 0;
  for (const [objectType, objectId] of eligibleMemoryObjects(db)) {
    const document = getMemoryDocument(db, objectType, objectId);
    if (!document) continue;
    const current = db.get(
      "SELECT content_hash, status FROM memory_embeddings WHERE object_type = $type AND object_id = $id AND embedding_profile_id = $profileId",
      { $type: objectType, $id: objectId, $profileId: profileId },
    );
    if (!current || current.content_hash !== document.contentHash || current.status !== "ready") {
      enqueueEmbeddingJob(db, document, profileId);
      queued += 1;
    }
  }
  db.persist();
  return queued;
}

async function processEmbeddingJobs({ db, settings, apiKey, limit = 20, embedder = embedTexts }) {
  if (String(settings.embeddingEnabled) !== "true" || String(settings.remoteEmbeddingConsent) !== "true") return { processed: 0, failed: 0 };
  const jobs = db.all(
    `SELECT * FROM embedding_jobs WHERE status IN ('pending', 'failed') AND available_at <= $now
     ORDER BY created_at LIMIT $limit`,
    { $now: isoNow(), $limit: Math.max(1, Number(limit || 20)) },
  );
  let processed = 0;
  let failed = 0;
  for (const job of jobs) {
    const startedAt = isoNow();
    db.run("UPDATE embedding_jobs SET status = 'running', attempts = attempts + 1, lease_until = $lease, updated_at = $now WHERE id = $id", {
      $id: job.id, $lease: new Date(Date.now() + 60_000).toISOString(), $now: startedAt,
    });
    try {
      const document = getMemoryDocument(db, job.object_type, job.object_id);
      if (!document || document.contentHash !== job.expected_content_hash) {
        db.run("UPDATE embedding_jobs SET status = 'stale', lease_until = NULL, updated_at = $now WHERE id = $id", { $id: job.id, $now: isoNow() });
        continue;
      }
      const [vector] = await embedder({ settings, apiKey, texts: [document.text], textType: "document" });
      const profile = db.get("SELECT * FROM embedding_profiles WHERE id = $id", { $id: job.embedding_profile_id });
      if (!profile || vector.length !== Number(profile.dimension)) throw new Error("Embedding profile dimension mismatch.");
      const latest = getMemoryDocument(db, job.object_type, job.object_id);
      if (!latest || latest.contentHash !== document.contentHash) throw new Error("Memory changed while embedding; retry required.");
      const now = isoNow();
      db.transaction(() => {
        db.db.run(
          `INSERT INTO memory_embeddings
           (object_type, object_id, embedding_profile_id, content_schema_version,
            content_hash, model, dimension, vector_blob, status, source_updated_at,
            created_at, updated_at)
           VALUES ($type, $objectId, $profileId, $schema, $hash, $model, $dimension,
            $blob, 'ready', $sourceUpdatedAt, $now, $now)
           ON CONFLICT(object_type, object_id, embedding_profile_id) DO UPDATE SET
            content_schema_version = excluded.content_schema_version,
            content_hash = excluded.content_hash, model = excluded.model,
            dimension = excluded.dimension, vector_blob = excluded.vector_blob,
            status = 'ready', source_updated_at = excluded.source_updated_at,
            error = NULL, updated_at = excluded.updated_at`,
          {
            $type: job.object_type, $objectId: job.object_id, $profileId: job.embedding_profile_id,
            $schema: DOCUMENT_SCHEMA_VERSION, $hash: document.contentHash, $model: profile.model,
            $dimension: vector.length, $blob: vectorToBlob(vector), $sourceUpdatedAt: document.sourceUpdatedAt, $now: now,
          },
        );
        db.db.run("UPDATE embedding_jobs SET status = 'complete', lease_until = NULL, error = NULL, updated_at = $now WHERE id = $id", { $id: job.id, $now: now });
      });
      processed += 1;
    } catch (error) {
      const attempts = Number(job.attempts || 0) + 1;
      const available = new Date(Date.now() + Math.min(3_600_000, 10_000 * (2 ** Math.min(8, attempts)))).toISOString();
      db.run("UPDATE embedding_jobs SET status = 'failed', lease_until = NULL, error = $error, available_at = $available, updated_at = $now WHERE id = $id", {
        $id: job.id, $error: String(error.message || error).slice(0, 1000), $available: available, $now: isoNow(),
      });
      failed += 1;
    }
  }
  return { processed, failed };
}

module.exports = {
  DOCUMENT_SCHEMA_VERSION,
  PROFILE_ID,
  blobToVector,
  cosineSimilarity,
  embedTexts,
  eligibleMemoryObjects,
  getMemoryDocument,
  normalizeVector,
  processEmbeddingJobs,
  reconcileEmbeddingIndex,
  vectorToBlob,
};
