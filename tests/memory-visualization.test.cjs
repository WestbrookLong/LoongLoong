const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PetDatabase } = require("../electron/database.cjs");
const { applyClaimProposal } = require("../electron/claim-governance.cjs");
const { captureUserTurn } = require("../electron/memory.cjs");
const {
  getMemoryDiagnostics,
  getMemoryGraph,
  getMemoryNodeDetail,
  getMemoryOverview,
  getMemoryRetrievalTrace,
  getMemoryTimeline,
  governMemory,
} = require("../electron/memory-visualization.cjs");

async function createTestDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pet-memory-atlas-test-"));
  const database = await new PetDatabase(path.join(directory, "pet.db")).initialize();
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return database;
}

function addEvidence(db, text) {
  const session = db.getActiveSession();
  const message = db.addMessage({ sessionId: session.id, role: "user", content: text });
  const [eventId] = captureUserTurn(db, {
    messageId: message.id,
    sessionId: session.id,
    text,
    useDeterministicClaims: false,
  });
  return { eventId, message, session };
}

function addClaim(db, eventId, value = "SQLite") {
  let result;
  db.transaction(() => {
    result = applyClaimProposal(db, {
      namespace: "user",
      claim_type: "preference",
      subject: "user",
      predicate: "preferred_database",
      value,
      canonical_text: `User prefers ${value}.`,
      scope_type: "global",
      explicit: true,
      epistemic_basis: "stated_by_user",
      slot_resolution: {
        action: "create_slot",
        confidence: 0.99,
        novelty_reason: "First database preference",
        new_slot: {
          subject: "user",
          predicate: "preferred_database",
          cardinality: "single",
          temporal_mode: "current_state",
        },
      },
      value_resolution: {
        relation: "same_value",
        target_claim_ids: [],
        confidence: 0.99,
      },
      temporal: {
        current: true,
        basis: "message_time_assumption",
        precision: "exact",
        confidence: 0.95,
      },
    }, {
      evidenceEventIds: [eventId],
      confidence: 0.98,
      importance: 0.86,
      stability: 0.82,
      promotionScore: 0.94,
      explicit: true,
      epistemicBasis: "stated_by_user",
      runId: "atlas-test",
    });
  });
  return result;
}

function addRetrievalTrace(db, { session, userMessage, assistantMessage, claimId, eventId }) {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO retrieval_logs
     (id, session_id, user_message_id, assistant_message_id, query, mode, candidate_count,
      selected_claim_ids, selected_event_ids, token_estimate, score_json, score_version,
      route_json, selected_topic_ids_json, selected_topic_item_ids_json,
      selected_open_loop_ids_json, outcome_json, created_at)
     VALUES ('retrieval-atlas', $sessionId, $userId, $assistantId, 'Which database?', 'text', 2,
      $claimIds, $eventIds, 42, '{"claim":0.91}', 'test-v1',
      '{"route":"memory"}', '[]', '[]', '[]', '{}', $now)`,
    {
      $sessionId: session.id,
      $userId: userMessage.id,
      $assistantId: assistantMessage.id,
      $claimIds: JSON.stringify([claimId]),
      $eventIds: JSON.stringify([eventId]),
      $now: now,
    },
  );
  db.run(
    `INSERT INTO retrieval_stage_logs
     (id, retrieval_id, stage, status, duration_ms, input_count, output_count, payload_json, created_at)
     VALUES ('stage-atlas', 'retrieval-atlas', 'hybrid_recall', 'complete', 12, 2, 1, '{"selected":1}', $now)`,
    { $now: now },
  );
}

test("projects the current memory model into overview, graph, timeline, and detail", async (t) => {
  const db = await createTestDatabase(t);
  const evidence = addEvidence(db, "Please remember that I prefer SQLite.");
  const claim = addClaim(db, evidence.eventId);

  const overview = getMemoryOverview(db);
  assert.equal(overview.stats.currentClaims, 1);
  assert.equal(overview.groupedClaims.preferences[0].id, claim.claimId);

  const graph = getMemoryGraph(db, { focusId: `claim:${claim.claimId}`, depth: 1 });
  assert.ok(graph.nodes.some((node) => node.id === `claim:${claim.claimId}`));
  assert.ok(graph.edges.some((edge) => edge.source === `event:${evidence.eventId}` && edge.target === `claim:${claim.claimId}`));

  const timeline = getMemoryTimeline(db);
  assert.ok(timeline.entries.some((entry) => entry.id === `claim:${claim.claimId}`));
  assert.ok(timeline.entries.some((entry) => entry.id === `event:${evidence.eventId}`));

  const detail = getMemoryNodeDetail(db, `claim:${claim.claimId}`);
  assert.equal(detail.record.id, claim.claimId);
  assert.equal(detail.evidence[0].id, evidence.eventId);
  assert.equal(detail.evidence[0].message_id, evidence.message.id);
});

test("binds a reply to the exact memories and retrieval stages provided to the model", async (t) => {
  const db = await createTestDatabase(t);
  const evidence = addEvidence(db, "Please remember that I prefer SQLite.");
  const claim = addClaim(db, evidence.eventId);
  const assistant = db.addMessage({
    sessionId: evidence.session.id,
    role: "assistant",
    content: "You prefer SQLite.",
    metadata: { retrievalId: "retrieval-atlas" },
  });
  addRetrievalTrace(db, {
    session: evidence.session,
    userMessage: evidence.message,
    assistantMessage: assistant,
    claimId: claim.claimId,
    eventId: evidence.eventId,
  });

  const trace = getMemoryRetrievalTrace(db, { messageId: assistant.id });
  assert.equal(trace.id, "retrieval-atlas");
  assert.equal(trace.claims[0].id, claim.claimId);
  assert.equal(trace.events[0].id, evidence.eventId);
  assert.equal(trace.stages[0].stage, "hybrid_recall");
  assert.match(trace.caveat, /模型/);

  const diagnostics = getMemoryDiagnostics(db);
  assert.equal(diagnostics.retrieval.total, 1);
  assert.equal(diagnostics.retrieval.stages, 1);
});

test("governs memory through confirmation, correction, hiding, and deletion with an audit trail", async (t) => {
  const db = await createTestDatabase(t);
  const evidence = addEvidence(db, "Please remember that I prefer SQLite.");
  const claim = addClaim(db, evidence.eventId);

  const confirmed = governMemory(db, {
    action: "confirm",
    objectType: "claim",
    objectId: claim.claimId,
    reason: "Still correct",
  });
  assert.equal(confirmed.result.claimId, claim.claimId);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM memory_claims").count, 1);

  governMemory(db, {
    action: "hide",
    objectType: "claim",
    objectId: claim.claimId,
    reason: "Do not surface this for now",
  });
  assert.equal(getMemoryOverview(db).stats.currentClaims, 0);
  assert.equal(
    db.get("SELECT surface_policy FROM memory_object_policies WHERE object_type = 'claim' AND object_id = $id", { $id: claim.claimId }).surface_policy,
    "do_not_surface",
  );

  governMemory(db, { action: "unhide", objectType: "claim", objectId: claim.claimId });
  assert.equal(getMemoryOverview(db).stats.currentClaims, 1);

  const corrected = governMemory(db, {
    action: "correct",
    objectType: "claim",
    objectId: claim.claimId,
    correctedText: "User prefers PostgreSQL.",
    reason: "Preference changed",
  });
  const replacementId = corrected.result.claimId;
  assert.notEqual(replacementId, claim.claimId);
  assert.equal(db.get("SELECT status FROM memory_claims WHERE id = $id", { $id: claim.claimId }).status, "superseded");
  assert.equal(db.get("SELECT epistemic_basis FROM memory_claims WHERE id = $id", { $id: replacementId }).epistemic_basis, "stated_by_user");

  const messageCount = db.get("SELECT COUNT(*) AS count FROM messages").count;
  governMemory(db, {
    action: "delete",
    objectType: "claim",
    objectId: replacementId,
    reason: "Remove derived memory",
  });
  assert.equal(db.get("SELECT COUNT(*) AS count FROM memory_claims WHERE id = $id", { $id: replacementId }).count, 0);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM messages").count, messageCount);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM memory_governance_actions").count, 5);
  assert.ok(db.get("SELECT COUNT(*) AS count FROM events WHERE event_type = 'memory_governance'").count >= 2);
});
