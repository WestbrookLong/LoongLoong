const crypto = require("node:crypto");
const { isoNow } = require("./database.cjs");
const { PROFILE_ID, blobToVector, cosineSimilarity } = require("./embedding.cjs");
const { structuredCompletion } = require("./model.cjs");
const { applyClaimNeighborAdjudication } = require("./claim-governance.cjs");

const PROMPT_VERSION = "claim-neighbor-adjudicator-v1";
const DISCOVERY_VERSION = "claim-neighbor-discovery-v1";
const RELATIONS = new Set(["same_value", "coexist", "temporal_update", "correction", "refinement", "unresolved_conflict", "unrelated"]);
const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

function compatibleNamespace(left, right) {
  return left.namespace === right.namespace && left.subject === right.subject
    && left.scope_type === right.scope_type && String(left.scope_id || "") === String(right.scope_id || "");
}

function claimEvidence(db, claimId) {
  return db.all(
    `SELECT e.* FROM memory_evidence me JOIN events e ON e.id = me.event_id
     WHERE me.claim_id = $id ORDER BY e.occurred_at DESC LIMIT 12`,
    { $id: claimId },
  );
}

function discoverClaimNeighbors(db, { claimIds = [], threshold = 0.8, maxPerClaim = 5 } = {}) {
  const rows = db.all(
    `SELECT c.*, e.vector_blob, e.content_hash FROM memory_claims c
     JOIN memory_embeddings e ON e.object_type = 'claim' AND e.object_id = c.id
     WHERE e.embedding_profile_id = $profile AND e.status = 'ready'
       AND c.status IN ('active', 'disputed', 'candidate')`,
    { $profile: PROFILE_ID },
  ).map((row) => ({ ...row, vector: blobToVector(row.vector_blob) }));
  const requested = new Set((claimIds || []).map(String));
  const sources = requested.size ? rows.filter((row) => requested.has(row.id)) : rows;
  const discovered = [];
  for (const source of sources) {
    const ranked = rows.filter((target) => target.id !== source.id && compatibleNamespace(source, target))
      .map((target) => ({ target, similarity: cosineSimilarity(source.vector, target.vector) }))
      .filter((item) => item.similarity >= threshold)
      .sort((left, right) => right.similarity - left.similarity).slice(0, Math.max(1, Number(maxPerClaim || 5)));
    for (const { target, similarity } of ranked) {
      const [left, right] = [source, target].sort((a, b) => a.id.localeCompare(b.id));
      const sourceHash = hash(`${left.id}:${left.version}:${left.content_hash}|${right.id}:${right.version}:${right.content_hash}`);
      const pairKey = hash(`${left.id}:${right.id}:${sourceHash}`);
      if (db.get("SELECT id FROM claim_neighbor_candidates WHERE pair_key = $key", { $key: pairKey })) continue;
      const id = crypto.randomUUID();
      const now = isoNow();
      db.db.run(
        `INSERT INTO claim_neighbor_candidates
         (id, pair_key, claim_a_id, claim_b_id, claim_a_version, claim_b_version,
          embedding_profile_id, similarity, status, source_hash, created_at, updated_at)
         VALUES ($id, $pairKey, $left, $right, $leftVersion, $rightVersion,
          $profile, $similarity, 'pending_model', $sourceHash, $now, $now)`,
        { $id: id, $pairKey: pairKey, $left: left.id, $right: right.id, $leftVersion: left.version,
          $rightVersion: right.version, $profile: PROFILE_ID, $similarity: similarity, $sourceHash: sourceHash, $now: now },
      );
      for (const [side, claim] of [["a", left], ["b", right]]) {
        for (const event of claimEvidence(db, claim.id)) {
          db.db.run("INSERT OR IGNORE INTO claim_neighbor_evidence (candidate_id, claim_side, event_id, created_at) VALUES ($candidate, $side, $event, $now)",
            { $candidate: id, $side: side, $event: event.id, $now: now });
        }
      }
      discovered.push(id);
    }
  }
  db.persist();
  return discovered;
}

function presentClaim(claim, evidence) {
  return {
    id: claim.id, slot_id: claim.slot_id, predicate: claim.predicate, canonical_text: claim.canonical_text,
    status: claim.status, temporal_state: claim.temporal_state, epistemic_basis: claim.epistemic_basis,
    asserted_at: claim.asserted_at, valid_from: claim.valid_from, valid_to: claim.valid_to,
    evidence: evidence.map((event) => ({ id: event.id, type: event.event_type, occurred_at: event.occurred_at, content: event.content })),
  };
}

async function adjudicateClaimNeighbor({ db, settings, apiKey, candidateId, complete = structuredCompletion }) {
  const candidate = db.get("SELECT * FROM claim_neighbor_candidates WHERE id = $id", { $id: candidateId });
  if (!candidate || candidate.status !== "pending_model") return { skipped: true, reason: "not_pending" };
  const left = db.get("SELECT * FROM memory_claims WHERE id = $id", { $id: candidate.claim_a_id });
  const right = db.get("SELECT * FROM memory_claims WHERE id = $id", { $id: candidate.claim_b_id });
  if (!left || !right || Number(left.version) !== Number(candidate.claim_a_version) || Number(right.version) !== Number(candidate.claim_b_version)) {
    db.run("UPDATE claim_neighbor_candidates SET status = 'stale', updated_at = $now WHERE id = $id", { $id: candidateId, $now: isoNow() });
    return { skipped: true, reason: "stale" };
  }
  const leftEvidence = claimEvidence(db, left.id);
  const rightEvidence = claimEvidence(db, right.id);
  try {
    const response = await complete({ settings, apiKey, model: settings.memoryModel || settings.chatModel, temperature: 0,
      messages: [
        { role: "system", content: [
          "Classify the semantic relation between two existing memory claims. Similarity is discovery evidence only.",
          "Return JSON {claim_relation:{relation,confidence,rationale,supporting_event_ids}}.",
          "relation must be same_value, coexist, temporal_update, correction, refinement, unresolved_conflict, or unrelated.",
          "Use temporal_update only with explicit effective time. Use correction only with correction evidence. Never invent evidence IDs.",
        ].join("\n") },
        { role: "user", content: JSON.stringify({ similarity: candidate.similarity,
          claim_a: presentClaim(left, leftEvidence), claim_b: presentClaim(right, rightEvidence) }) },
      ] });
    const proposal = response.data?.claim_relation || {};
    const relation = String(proposal.relation || "");
    const confidence = Math.max(0, Math.min(1, Number(proposal.confidence || 0)));
    if (!RELATIONS.has(relation)) throw new Error("Claim adjudicator returned an invalid relation.");
    const allowedLeft = new Set(leftEvidence.map((event) => event.id));
    const allowedRight = new Set(rightEvidence.map((event) => event.id));
    const evidenceIds = [...new Set((proposal.supporting_event_ids || []).map(String))]
      .filter((id) => allowedLeft.has(id) || allowedRight.has(id));
    const coversBoth = evidenceIds.some((id) => allowedLeft.has(id)) && evidenceIds.some((id) => allowedRight.has(id));
    const result = coversBoth ? applyClaimNeighborAdjudication(db, { claimAId: left.id, claimBId: right.id,
      relation, confidence, evidenceEventIds: evidenceIds, runId: candidate.id }) : { applied: false, reason: "evidence_must_cover_both_claims" };
    const status = relation === "unrelated" ? "distinct" : result.applied ? "applied" : "pending_review";
    const now = isoNow();
    db.run(
      `UPDATE claim_neighbor_candidates SET status = $status, relation = $relation,
       model_confidence = $confidence, rationale = $rationale, evidence_event_ids_json = $evidence,
       model_version = $model, prompt_version = $prompt, raw_output_json = $raw,
       adjudicated_at = $now, applied_at = $appliedAt, updated_at = $now WHERE id = $id`,
      { $id: candidate.id, $status: status, $relation: relation, $confidence: confidence,
        $rationale: String(proposal.rationale || "").slice(0, 2000), $evidence: JSON.stringify(evidenceIds),
        $model: settings.memoryModel || settings.chatModel || "unknown", $prompt: PROMPT_VERSION,
        $raw: JSON.stringify(response.data || {}), $now: now, $appliedAt: result.applied ? now : null },
    );
    return { candidateId: candidate.id, status, relation, result };
  } catch (error) {
    db.run("UPDATE claim_neighbor_candidates SET status = 'failed', error = $error, updated_at = $now WHERE id = $id",
      { $id: candidate.id, $error: String(error.message || error).slice(0, 1000), $now: isoNow() });
    return { candidateId: candidate.id, status: "failed", error: String(error.message || error) };
  }
}

async function processClaimNeighborCandidates({ db, settings, apiKey, limit = 2, complete = structuredCompletion }) {
  const rows = db.all("SELECT id FROM claim_neighbor_candidates WHERE status = 'pending_model' ORDER BY created_at LIMIT $limit",
    { $limit: Math.max(1, Number(limit || 2)) });
  const results = [];
  for (const row of rows) results.push(await adjudicateClaimNeighbor({ db, settings, apiKey, candidateId: row.id, complete }));
  return results;
}

module.exports = { DISCOVERY_VERSION, PROMPT_VERSION, adjudicateClaimNeighbor, compatibleNamespace,
  discoverClaimNeighbors, processClaimNeighborCandidates };
