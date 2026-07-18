const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PetDatabase } = require("../electron/database.cjs");
const { applyClaimProposal } = require("../electron/claim-governance.cjs");
const { captureUserTurn, retrieveMemory } = require("../electron/memory.cjs");

async function createTestDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pet-claim-governance-test-"));
  const database = await new PetDatabase(path.join(directory, "pet.db")).initialize();
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return database;
}

function evidence(db, text, createdAt = new Date().toISOString()) {
  const session = db.getActiveSession();
  const message = db.addMessage({ sessionId: session.id, role: "user", content: text, modality: "text" });
  db.run("UPDATE messages SET created_at = $createdAt WHERE id = $id", { $id: message.id, $createdAt: createdAt });
  const [eventId] = captureUserTurn(db, {
    messageId: message.id,
    sessionId: session.id,
    text,
    useDeterministicClaims: false,
  });
  return { eventId, sessionId: session.id, messageId: message.id };
}

function propose(db, eventId, value, options = {}) {
  const slotId = options.slotId || null;
  let result;
  db.transaction(() => {
    result = applyClaimProposal(db, {
      namespace: "user",
      claim_type: options.claimType || "fact",
      subject: "user",
      predicate: options.predicate || "residence",
      value,
      canonical_text: options.text || `User lives in ${value}.`,
      scope_type: "global",
      confidence: options.confidence ?? 0.96,
      importance: options.importance ?? 0.85,
      stability: options.stability ?? 0.8,
      explicit: options.explicit ?? true,
      epistemic_basis: options.epistemicBasis || "stated_by_user",
      slot_resolution: slotId
        ? { action: "reuse_slot", slot_id: slotId, expected_version: 1, confidence: 0.98 }
        : { action: "create_slot", confidence: 0.98, novelty_reason: "No existing slot", new_slot: {
          subject: "user",
          predicate: options.predicate || "residence",
          cardinality: options.cardinality || "single",
          temporal_mode: options.temporalMode || "current_state",
        } },
      value_resolution: {
        relation: options.relation || "unresolved_conflict",
        target_claim_ids: options.targetClaimIds || [],
        confidence: options.relationConfidence ?? 0.96,
      },
      temporal: {
        valid_from: options.validFrom || null,
        valid_to: options.validTo || null,
        basis: options.temporalBasis || (options.validFrom ? "explicit" : "message_time_assumption"),
        precision: options.precision || (options.validFrom ? "day" : "unknown"),
        current: options.current ?? "true",
        confidence: options.temporalConfidence ?? 0.95,
      },
    }, {
      evidenceEventIds: [eventId],
      runId: options.runId || "test-run",
      assertedAt: options.assertedAt,
      epistemicBasis: options.epistemicBasis || "stated_by_user",
      confidence: options.confidence ?? 0.96,
      importance: options.importance ?? 0.85,
      stability: options.stability ?? 0.8,
      explicit: options.explicit ?? true,
      promotionScore: options.promotionScore ?? 0.9,
    });
  });
  return result;
}

test("records a temporal transition while keeping the old residence as history", async (t) => {
  const db = await createTestDatabase(t);
  const juneEvidence = evidence(db, "I lived in Beijing in June.", "2026-06-10T08:00:00.000Z");
  const beijing = propose(db, juneEvidence.eventId, "Beijing", {
    validFrom: "2026-06-01T00:00:00.000Z",
    assertedAt: "2026-06-10T08:00:00.000Z",
  });
  const julyEvidence = evidence(db, "I moved to Shanghai in July.", "2026-07-10T08:00:00.000Z");
  const shanghai = propose(db, julyEvidence.eventId, "Shanghai", {
    slotId: beijing.slotId,
    relation: "temporal_update",
    validFrom: "2026-07-01T00:00:00.000Z",
    assertedAt: "2026-07-10T08:00:00.000Z",
  });

  assert.equal(shanghai.action, "temporal_update");
  const claims = db.all("SELECT canonical_text, status, temporal_state, valid_from, valid_to FROM memory_claims WHERE slot_id = $slotId ORDER BY valid_from", { $slotId: beijing.slotId });
  assert.deepEqual(claims.map((claim) => [claim.status, claim.temporal_state]), [["active", "historical"], ["active", "current"]]);
  assert.equal(claims[0].valid_to, "2026-07-01T00:00:00.000Z");
  assert.equal(db.get("SELECT transition_type FROM claim_transitions WHERE slot_id = $slotId", { $slotId: beijing.slotId }).transition_type, "transitioned_to");

  const ordinary = retrieveMemory(db, { query: "Where do I live?", sessionId: julyEvidence.sessionId });
  assert.match(ordinary.context, /Shanghai/);
  assert.doesNotMatch(ordinary.context, /Beijing/);
  const history = retrieveMemory(db, { query: "Where did I live before?", sessionId: julyEvidence.sessionId });
  assert.match(history.context, /Beijing/);
  assert.match(history.context, /Shanghai/);
});

test("treats a correction as supersession rather than temporal history", async (t) => {
  const db = await createTestDatabase(t);
  const first = propose(db, evidence(db, "My name is Jon.").eventId, "Jon", { predicate: "name" });
  const corrected = propose(db, evidence(db, "Correction: my name is John.").eventId, "John", {
    predicate: "name",
    slotId: first.slotId,
    relation: "correction",
  });
  assert.equal(corrected.action, "corrected");
  const old = db.get("SELECT * FROM memory_claims WHERE id = $id", { $id: first.claimId });
  assert.equal(old.status, "superseded");
  assert.equal(old.temporal_state, "unknown");
  assert.equal(old.supersession_reason, "correction");
});

test("keeps an unclear single-value conflict disputed", async (t) => {
  const db = await createTestDatabase(t);
  const first = propose(db, evidence(db, "My timezone is UTC+8.").eventId, "UTC+8", { predicate: "timezone" });
  const second = propose(db, evidence(db, "My timezone is UTC+9.").eventId, "UTC+9", {
    predicate: "timezone",
    slotId: first.slotId,
    relation: "unresolved_conflict",
  });
  assert.equal(second.action, "disputed");
  const states = db.all("SELECT status, temporal_state FROM memory_claims WHERE slot_id = $slotId", { $slotId: first.slotId });
  assert.deepEqual(states.map((item) => item.status).sort(), ["disputed", "disputed"]);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM memory_claims WHERE slot_id = $slotId AND status = 'active' AND temporal_state = 'current'", { $slotId: first.slotId }).count, 0);
});

test("resolves a disputed slot when the user explicitly corrects it to an existing value", async (t) => {
  const db = await createTestDatabase(t);
  const first = propose(db, evidence(db, "My timezone is UTC+8.").eventId, "UTC+8", { predicate: "timezone" });
  propose(db, evidence(db, "My timezone might be UTC+9.").eventId, "UTC+9", {
    predicate: "timezone",
    slotId: first.slotId,
    relation: "unresolved_conflict",
  });
  const resolved = propose(db, evidence(db, "Correction: UTC+8 is the right timezone.").eventId, "UTC+8", {
    predicate: "timezone",
    slotId: first.slotId,
    relation: "correction",
  });
  assert.equal(resolved.action, "corrected_conflict");
  const claims = db.all("SELECT object_json, status, temporal_state FROM memory_claims WHERE slot_id = $slotId ORDER BY created_at", { $slotId: first.slotId });
  assert.equal(claims[0].status, "active");
  assert.equal(claims[0].temporal_state, "current");
  assert.equal(claims[1].status, "superseded");
});

test("allows different values to coexist in a set-valued slot", async (t) => {
  const db = await createTestDatabase(t);
  const coffee = propose(db, evidence(db, "I like coffee.").eventId, "coffee", {
    predicate: "liked_drink",
    cardinality: "set",
    temporalMode: "atemporal",
    relation: "coexist",
  });
  propose(db, evidence(db, "I also like tea.").eventId, "tea", {
    predicate: "liked_drink",
    slotId: coffee.slotId,
    relation: "coexist",
    temporalMode: "atemporal",
  });
  const active = db.get("SELECT COUNT(*) AS count FROM memory_claims WHERE slot_id = $slotId AND status = 'active' AND temporal_state = 'current'", { $slotId: coffee.slotId });
  assert.equal(active.count, 2);
});

test("merges repeated evidence for the same value without creating another claim", async (t) => {
  const db = await createTestDatabase(t);
  const first = propose(db, evidence(db, "I live in Shanghai.").eventId, "Shanghai");
  const repeated = propose(db, evidence(db, "Yes, I still live in Shanghai.").eventId, "Shanghai", {
    slotId: first.slotId,
    relation: "same_value",
  });
  assert.equal(repeated.claimId, first.claimId);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM memory_claims WHERE slot_id = $slotId", { $slotId: first.slotId }).count, 1);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM memory_evidence WHERE claim_id = $id", { $id: first.claimId }).count, 2);
});

test("backfills an older fact without replacing the newer current fact", async (t) => {
  const db = await createTestDatabase(t);
  const current = propose(db, evidence(db, "I have lived in Shanghai since July.").eventId, "Shanghai", {
    validFrom: "2026-07-01T00:00:00.000Z",
  });
  const older = propose(db, evidence(db, "In June I lived in Beijing.").eventId, "Beijing", {
    slotId: current.slotId,
    relation: "temporal_update",
    validFrom: "2026-06-01T00:00:00.000Z",
    current: "false",
  });
  assert.equal(older.action, "historical_backfill");
  assert.equal(db.get("SELECT canonical_text FROM memory_claims WHERE slot_id = $slotId AND status = 'active' AND temporal_state = 'current'", { $slotId: current.slotId }).canonical_text, "User lives in Shanghai.");
});

test("database invariant rejects a second active current assertion for a single slot", async (t) => {
  const db = await createTestDatabase(t);
  const first = propose(db, evidence(db, "I live in Beijing.").eventId, "Beijing");
  const claim = db.get("SELECT * FROM memory_claims WHERE id = $id", { $id: first.claimId });
  assert.throws(() => db.db.run(
    `INSERT INTO memory_claims
     (id, namespace, claim_type, subject, predicate, object_json, canonical_text,
      scope_type, scope_id, claim_key, value_hash, cardinality, status, confidence,
      importance, stability, promotion_score, epistemic_basis, sensitivity, slot_id,
      temporal_state, asserted_at, temporal_basis, temporal_precision, temporal_confidence,
      valid_from, created_at, updated_at)
     VALUES ('illegal-current', $namespace, $claimType, $subject, $predicate, '{}', 'Illegal second current',
      $scopeType, $scopeId, $claimKey, 'different-value', 'single', 'active', 0.99,
      0.9, 0.9, 0.9, 'stated_by_user', 'private', $slotId,
      'current', $now, 'explicit', 'day', 1, $now, $now, $now)`,
    {
      $namespace: claim.namespace,
      $claimType: claim.claim_type,
      $subject: claim.subject,
      $predicate: claim.predicate,
      $scopeType: claim.scope_type,
      $scopeId: claim.scope_id,
      $claimKey: claim.claim_key,
      $slotId: claim.slot_id,
      $now: new Date().toISOString(),
    },
  ), /UNIQUE constraint failed/);
});
