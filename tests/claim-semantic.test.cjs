const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PetDatabase, isoNow } = require("../electron/database.cjs");
const { applyClaimNeighborAdjudication, applyClaimProposal } = require("../electron/claim-governance.cjs");
const { adjudicateClaimNeighbor, discoverClaimNeighbors } = require("../electron/claim-semantic.cjs");
const { PROFILE_ID, vectorToBlob } = require("../electron/embedding.cjs");
const { captureUserTurn } = require("../electron/memory.cjs");

async function createDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pet-claim-semantic-"));
  const db = await new PetDatabase(path.join(directory, "pet.db")).initialize();
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return db;
}

function evidenceEvent(db, content) {
  const session = db.getActiveSession();
  const message = db.addMessage({ sessionId: session.id, role: "user", content });
  return captureUserTurn(db, { messageId: message.id, sessionId: session.id, text: content, useDeterministicClaims: false })[0];
}

function createResidenceClaim(db, eventId, value, validFrom, relation = "unresolved_conflict") {
  return applyClaimProposal(db, {
    namespace: "user", claim_type: "fact", subject: "user", predicate: "residence",
    value, canonical_text: `The user lives in ${value}.`, scope_type: "global", cardinality: "single",
    confidence: 0.96, importance: 0.8, stability: 0.8, explicit: true, epistemic_basis: "stated_by_user",
    value_resolution: { relation, confidence: 0.96 },
    temporal: { valid_from: validFrom, basis: "explicit", precision: "day", confidence: 0.95, current: "true" },
  }, { evidenceEventIds: [eventId], assertedAt: validFrom, epistemicBasis: "stated_by_user",
    confidence: 0.96, importance: 0.8, stability: 0.8, explicit: true, promotionScore: 0.9 });
}

function putVector(db, id, values) {
  const now = isoNow();
  db.run(`INSERT INTO memory_embeddings
    (object_type, object_id, embedding_profile_id, content_schema_version, content_hash,
     model, dimension, vector_blob, status, created_at, updated_at)
    VALUES ('claim', $id, $profile, 'test', $hash, 'fake', $dimension, $blob, 'ready', $now, $now)`,
    { $id: id, $profile: PROFILE_ID, $hash: `hash-${id}`, $dimension: values.length, $blob: vectorToBlob(values), $now: now });
}

test("semantic similarity only discovers a candidate and never mutates Claim state", async (t) => {
  const db = await createDatabase(t);
  const juneEvent = evidenceEvent(db, "In June 2026 I lived in Beijing.");
  const julyEvent = evidenceEvent(db, "From July 2026 I live in Shanghai.");
  const june = createResidenceClaim(db, juneEvent, "Beijing", "2026-06-01T00:00:00.000Z");
  const july = createResidenceClaim(db, julyEvent, "Shanghai", "2026-07-01T00:00:00.000Z");
  putVector(db, june.claimId, [1, 0, 0, 0]);
  putVector(db, july.claimId, [1, 0, 0, 0]);
  const before = db.all("SELECT id, status, temporal_state FROM memory_claims WHERE id IN ($a, $b) ORDER BY id", { $a: june.claimId, $b: july.claimId });
  const ids = discoverClaimNeighbors(db, { claimIds: [july.claimId] });
  assert.equal(ids.length, 1);
  assert.deepEqual(db.all("SELECT id, status, temporal_state FROM memory_claims WHERE id IN ($a, $b) ORDER BY id", { $a: june.claimId, $b: july.claimId }), before);
  assert.equal(db.get("SELECT status FROM claim_neighbor_candidates WHERE id = $id", { $id: ids[0] }).status, "pending_model");
});

test("grounded temporal adjudication uses the deterministic reducer and keeps history", async (t) => {
  const db = await createDatabase(t);
  const juneEvent = evidenceEvent(db, "In June 2026 I lived in Beijing.");
  const julyEvent = evidenceEvent(db, "From July 2026 I now live in Shanghai.");
  const june = createResidenceClaim(db, juneEvent, "Beijing", "2026-06-01T00:00:00.000Z");
  const july = createResidenceClaim(db, julyEvent, "Shanghai", "2026-07-01T00:00:00.000Z");
  putVector(db, june.claimId, [1, 0, 0, 0]);
  putVector(db, july.claimId, [1, 0, 0, 0]);
  const [candidateId] = discoverClaimNeighbors(db, { claimIds: [july.claimId] });
  const complete = async () => ({ data: { claim_relation: {
    relation: "temporal_update", confidence: 0.97, rationale: "Explicit month transition.",
    supporting_event_ids: [juneEvent, julyEvent],
  } } });
  const result = await adjudicateClaimNeighbor({ db, settings: { memoryModel: "test" }, apiKey: "test", candidateId, complete });
  assert.equal(result.status, "applied");
  assert.equal(db.get("SELECT temporal_state FROM memory_claims WHERE id = $id", { $id: june.claimId }).temporal_state, "historical");
  assert.equal(db.get("SELECT temporal_state FROM memory_claims WHERE id = $id", { $id: july.claimId }).temporal_state, "current");
  assert.equal(db.get("SELECT valid_to FROM memory_claims WHERE id = $id", { $id: june.claimId }).valid_to, "2026-07-01T00:00:00.000Z");
  assert.ok(db.get("SELECT id FROM claim_transitions WHERE from_claim_id = $old AND to_claim_id = $next AND transition_type = 'transitioned_to'", { $old: june.claimId, $next: july.claimId }));
});

test("deterministic reducer rejects an LLM relation without evidence from both claims", async (t) => {
  const db = await createDatabase(t);
  const firstEvent = evidenceEvent(db, "I prefer tea.");
  const secondEvent = evidenceEvent(db, "I prefer coffee.");
  const first = createResidenceClaim(db, firstEvent, "Tea City", "2026-06-01T00:00:00.000Z");
  const second = createResidenceClaim(db, secondEvent, "Coffee City", "2026-07-01T00:00:00.000Z");
  const result = applyClaimNeighborAdjudication(db, { claimAId: first.claimId, claimBId: second.claimId,
    relation: "correction", confidence: 1, evidenceEventIds: [secondEvent] });
  assert.equal(result.applied, false);
  assert.equal(result.reason, "evidence_must_cover_both_claims");
});
