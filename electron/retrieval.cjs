const crypto = require("node:crypto");
const { isoNow } = require("./database.cjs");
const { containsForbiddenSecret, retrieveMemory } = require("./memory.cjs");
const { PROFILE_ID, blobToVector, cosineSimilarity, embedTexts } = require("./embedding.cjs");

function queryTerms(text) {
  const normalized = String(text || "").toLowerCase();
  const words = normalized.match(/[a-z0-9_]{2,}|[\u3400-\u9fff]{2,}/g) || [];
  const terms = new Set(words);
  for (const word of words) {
    if (/^[\u3400-\u9fff]+$/.test(word)) {
      for (let index = 0; index < word.length - 1; index += 1) terms.add(word.slice(index, index + 2));
    }
  }
  return [...terms].slice(0, 40);
}

function analyzeQuery(query, mode = "text") {
  const text = String(query || "").trim();
  const terms = queryTerms(text);
  const temporalIntent = /(?:以前|之前|过去|曾经|当时|去年|上个月|什么时候|哪一年|搬到|住过|历史|变化|before|previously|used to|when|history|timeline)/i.test(text);
  const explanationIntent = /(?:为什么|原因|怎么回事|why|reason|explain)/i.test(text);
  const experienceIntent = /(?:发生|经历|那次|事件|happened|experience)/i.test(text);
  const lowInformation = terms.length <= 1 || /^(?:继续|接着|然后呢|这个呢|刚才那个|continue|go on)[？?。.!\s]*$/i.test(text);
  return { text, terms, mode, temporalIntent, explanationIntent, experienceIntent, lowInformation,
    semanticEligible: !lowInformation && !containsForbiddenSecret(text) && mode !== "voice" };
}

function eligibleSemanticRows(db, profileId = PROFILE_ID) {
  return db.all(
    `SELECT e.* FROM memory_embeddings e
     LEFT JOIN memory_object_policies p ON p.object_type = e.object_type AND p.object_id = e.object_id
     WHERE e.embedding_profile_id = $profileId AND e.status = 'ready'
       AND COALESCE(p.surface_policy, 'normal') != 'do_not_surface'`,
    { $profileId: profileId },
  );
}

function semanticRecall(rows, queryVector, limit = 24) {
  return rows.map((row) => ({ objectType: row.object_type, objectId: row.object_id,
    similarity: cosineSimilarity(queryVector, blobToVector(row.vector_blob)) }))
    .filter((item) => Number.isFinite(item.similarity))
    .sort((left, right) => right.similarity - left.similarity).slice(0, limit);
}

function logStage(db, retrievalId, stage, status, startedAt, inputCount, outputCount, payload = {}, error = null) {
  db.run(
    `INSERT INTO retrieval_stage_logs
     (id, retrieval_id, stage, status, duration_ms, input_count, output_count, payload_json, error, created_at)
     VALUES ($id, $retrievalId, $stage, $status, $duration, $inputCount, $outputCount, $payload, $error, $createdAt)`,
    { $id: crypto.randomUUID(), $retrievalId: retrievalId, $stage: stage, $status: status,
      $duration: Date.now() - startedAt, $inputCount: inputCount, $outputCount: outputCount,
      $payload: JSON.stringify(payload), $error: error, $createdAt: isoNow() },
  );
}

async function retrieveMemoryEnhanced(db, args, options = {}) {
  const baseline = retrieveMemory(db, args);
  const analysis = analyzeQuery(args.query, args.mode);
  const settings = options.settings || db.getSettings();
  const enabled = String(settings.embeddingEnabled) === "true" && String(settings.remoteEmbeddingConsent) === "true";
  const startedAt = Date.now();
  if (!enabled || !analysis.semanticEligible) {
    logStage(db, baseline.id, "semantic_shadow", "skipped", startedAt, 0, 0,
      { reason: !enabled ? "disabled_or_no_consent" : "query_not_eligible", analysis });
    return { ...baseline, queryAnalysis: analysis, shadowSemantic: [] };
  }
  const rows = eligibleSemanticRows(db);
  if (!rows.length) {
    logStage(db, baseline.id, "semantic_shadow", "skipped", startedAt, 0, 0, { reason: "index_empty", analysis });
    return { ...baseline, queryAnalysis: analysis, shadowSemantic: [] };
  }
  try {
    const embedder = options.embedder || embedTexts;
    const [queryVector] = await embedder({ settings, apiKey: options.apiKey || "", texts: [analysis.text],
      textType: "query", instruct: "Retrieve durable personal memory that helps answer the user's current request." });
    const candidates = semanticRecall(rows, queryVector, options.semanticLimit || 24);
    const baselineKeys = new Set([...baseline.selectedClaimIds.map((id) => `claim:${id}`), ...baseline.selectedEventIds.map((id) => `event:${id}`)]);
    logStage(db, baseline.id, "semantic_shadow", "complete", startedAt, rows.length, candidates.length, {
      analysis, candidates,
      shadow_only: candidates.filter((item) => !baselineKeys.has(`${item.objectType}:${item.objectId}`)).map((item) => `${item.objectType}:${item.objectId}`),
    });
    return { ...baseline, queryAnalysis: analysis, shadowSemantic: candidates };
  } catch (error) {
    logStage(db, baseline.id, "semantic_shadow", "degraded", startedAt, rows.length, 0, { analysis }, String(error.message || error));
    return { ...baseline, queryAnalysis: analysis, shadowSemantic: [] };
  }
}

module.exports = { analyzeQuery, eligibleSemanticRows, queryTerms, retrieveMemoryEnhanced, semanticRecall };
