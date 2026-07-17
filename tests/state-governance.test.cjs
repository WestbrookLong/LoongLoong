const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PetDatabase } = require("../electron/database.cjs");
const { applyContinuityOutput, buildContinuityContext, routeContinuity } = require("../electron/continuity.cjs");
const { applyMemoryOutput, rebuildTopicIntelligently } = require("../electron/memory-intelligence.cjs");
const { retrieveMemory } = require("../electron/memory.cjs");
const { buildStateContext } = require("../electron/state.cjs");
const { checkTopicHealth, resolveCanonicalTopic } = require("../electron/topic-governance.cjs");

async function createTestDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pet-state-test-"));
  const database = await new PetDatabase(path.join(directory, "pet.db")).initialize();
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return database;
}

function evidence(message, quote = message.content) {
  return [{ message_id: message.id, quote }];
}

function createTopic(db, session, { title, content, itemType = "decision", itemContent = content }) {
  const message = db.addMessage({ sessionId: session.id, role: "user", content });
  const result = applyContinuityOutput(db, {
    continuity_output: {
      topic_updates: [{
        topic_ref: title,
        title,
        overview: content,
        current_position: content,
        make_active: true,
        evidence: evidence(message),
        operations: [{
          op: "add_item",
          item_type: itemType,
          content: itemContent,
          epistemic_basis: "stated_by_user",
          evidence: evidence(message),
        }],
      }],
    },
  }, { sourceMessages: [message], sessionId: session.id, trigger: "explicit", modelVersion: "test" });
  return { message, result, topic: db.get("SELECT * FROM topic_threads WHERE id = $id", { $id: result.topicIds[0] }) };
}

test("injects epistemic metadata and prevents new unknown_legacy claims", async (t) => {
  const db = await createTestDatabase(t);
  const session = db.getActiveSession();
  const message = db.addMessage({ sessionId: session.id, role: "user", content: "I prefer concise technical answers going forward." });
  const applied = applyMemoryOutput(db, {
    claim_candidates: [{
      namespace: "user",
      claim_type: "preference",
      subject: "user",
      predicate: "answer_style",
      value: "concise technical",
      canonical_text: "The user prefers concise technical answers.",
      confidence: 0.98,
      importance: 0.9,
      stability: 0.9,
      explicit: true,
      epistemic_basis: "unknown_legacy",
      evidence: evidence(message),
    }],
  }, { sourceMessages: [message], runId: "epistemic-test" });
  const claim = db.get("SELECT * FROM memory_claims WHERE id = $id", { $id: applied.claimIds[0] });
  assert.equal(claim.epistemic_basis, "stated_by_user");
  db.run("UPDATE memory_claims SET status = 'disputed' WHERE id = $id", { $id: claim.id });
  const retrieval = retrieveMemory(db, { query: "technical answers", sessionId: session.id, mode: "text" });
  assert.match(retrieval.context, /"status":"disputed"/);
  assert.match(retrieval.context, /"epistemic_basis":"stated_by_user"/);
  assert.match(retrieval.context, /disputed 状态必须明确存在争议/);

  db.run("UPDATE memory_claims SET valid_to = '2000-01-01T00:00:00.000Z' WHERE id = $id", { $id: claim.id });
  const expired = retrieveMemory(db, { query: "technical answers", sessionId: session.id, mode: "text" });
  assert.doesNotMatch(expired.context, new RegExp(claim.id));
});

test("applies durable self behavior updates and rejects one-off global requests", async (t) => {
  const db = await createTestDatabase(t);
  const session = db.getActiveSession();
  const durable = db.addMessage({
    sessionId: session.id,
    role: "user",
    content: "Going forward, architecture advice must prioritize real functional gaps.",
  });
  const first = applyContinuityOutput(db, {
    continuity_output: {
      state_updates: [{
        state_type: "self",
        expected_version: 1,
        operations: [{
          op: "record_user_correction",
          value: "Architecture advice previously prioritized unnecessary completeness.",
          scope_type: "global",
          evidence: evidence(durable),
        }, {
          op: "set_behavior_adjustment",
          value: "Going forward, prioritize real functional gaps in architecture advice.",
          scope_type: "global",
          evidence: evidence(durable),
        }],
      }],
    },
  }, { sourceMessages: [durable], sessionId: session.id, trigger: "explicit", modelVersion: "test" });
  assert.equal(first.applied.find((item) => item.section === "state").status, "updated");
  const self = db.get("SELECT * FROM state_documents WHERE state_type = 'self_model'");
  const selfState = JSON.parse(self.current_state_json);
  assert.equal(self.version, 2);
  assert.equal(selfState.current_behavior_adjustments.length, 1);
  assert.equal(selfState.user_corrections_to_agent.length, 1);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM state_revision_evidence").count, 1);
  const context = buildStateContext(db, { mode: "text" });
  assert.match(context.context, /prioritize real functional gaps/);

  const temporary = db.addMessage({ sessionId: session.id, role: "user", content: "Keep this answer short." });
  const second = applyContinuityOutput(db, {
    continuity_output: {
      state_updates: [{
        state_type: "self_model",
        expected_version: 2,
        operations: [{
          op: "set_behavior_adjustment",
          value: "Always keep every answer short.",
          scope_type: "global",
          evidence: evidence(temporary),
        }],
      }],
    },
  }, { sourceMessages: [temporary], sessionId: session.id, trigger: "explicit", modelVersion: "test" });
  const rejected = second.applied.find((item) => item.section === "state");
  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.operations[0].reason, "durability_required");
  assert.equal(db.get("SELECT version FROM state_documents WHERE state_type = 'self_model'").version, 2);
});

test("keeps relationship updates restrained and evidence-bound", async (t) => {
  const db = await createTestDatabase(t);
  const session = db.getActiveSession();
  const assistant = db.addMessage({ sessionId: session.id, role: "assistant", content: "We have a very close relationship." });
  const rejected = applyContinuityOutput(db, {
    continuity_output: {
      state_updates: [{
        state_type: "relationship",
        expected_version: 1,
        operations: [{
          op: "add_interaction_style",
          value: "The user trusts the agent deeply.",
          scope_type: "global",
          evidence: evidence(assistant),
        }],
      }],
    },
  }, { sourceMessages: [assistant], sessionId: session.id, trigger: "explicit", modelVersion: "test" });
  assert.equal(rejected.applied.find((item) => item.section === "state").operations[0].reason, "user_evidence_required");

  const boundary = db.addMessage({ sessionId: session.id, role: "user", content: "Do not present your guesses as things I explicitly said." });
  const accepted = applyContinuityOutput(db, {
    continuity_output: {
      state_updates: [{
        state_type: "relationship",
        expected_version: 1,
        operations: [{
          op: "add_trust_boundary",
          value: "Do not present guesses as user-stated facts.",
          scope_type: "global",
          evidence: evidence(boundary),
        }, {
          op: "set_relationship_summary",
          value: "The relationship is close.",
          scope_type: "global",
          evidence: evidence(boundary),
        }],
      }],
    },
  }, { sourceMessages: [boundary], sessionId: session.id, trigger: "explicit", modelVersion: "test" });
  const stateResult = accepted.applied.find((item) => item.section === "state");
  assert.equal(stateResult.status, "updated");
  assert.equal(stateResult.operations[0].status, "applied");
  assert.equal(stateResult.operations[1].reason, "unsupported_operation");
  const relationship = JSON.parse(db.get("SELECT current_state_json FROM state_documents WHERE state_type = 'relationship'").current_state_json);
  assert.equal(relationship.trust_boundaries.length, 1);
  assert.equal(relationship.current_relationship_model, "");
});

test("links and fulfills agent commitments through open loops as the source of truth", async (t) => {
  const db = await createTestDatabase(t);
  const session = db.getActiveSession();
  const promise = db.addMessage({ sessionId: session.id, role: "assistant", content: "I will add the migration test next." });
  const created = applyContinuityOutput(db, {
    continuity_output: {
      open_loop_updates: [{
        op: "create",
        loop_type: "commitment",
        owner: "agent",
        description: "Add the migration test.",
        evidence: evidence(promise),
      }],
    },
  }, { sourceMessages: [promise], sessionId: session.id, trigger: "explicit", modelVersion: "test" });
  const loopId = created.openLoopIds[0];
  const linked = applyContinuityOutput(db, {
    continuity_output: {
      state_updates: [{
        state_type: "self_model",
        expected_version: 1,
        operations: [{ op: "link_commitment", open_loop_id: loopId, scope_type: "global", evidence: evidence(promise) }],
      }],
    },
  }, { sourceMessages: [promise], sessionId: session.id, trigger: "explicit-link", modelVersion: "test" });
  assert.equal(linked.applied.find((item) => item.section === "state").status, "updated");
  let selfState = JSON.parse(db.get("SELECT current_state_json FROM state_documents WHERE state_type = 'self_model'").current_state_json);
  assert.deepEqual(selfState.unfulfilled_commitment_ids, [loopId]);

  const done = db.addMessage({ sessionId: session.id, role: "assistant", content: "The migration test is now implemented and passing." });
  const fulfilled = applyContinuityOutput(db, {
    continuity_output: {
      open_loop_updates: [{
        op: "resolve",
        open_loop_id: loopId,
        expected_version: 1,
        resolution_summary: "Migration test implemented.",
        evidence: evidence(done),
      }],
      state_updates: [{
        state_type: "self_model",
        expected_version: 2,
        operations: [{ op: "fulfill_commitment", open_loop_id: loopId, scope_type: "global", evidence: evidence(done) }],
      }],
    },
  }, { sourceMessages: [done], sessionId: session.id, trigger: "explicit", modelVersion: "test" });
  assert.equal(fulfilled.applied.find((item) => item.section === "state").status, "updated");
  selfState = JSON.parse(db.get("SELECT current_state_json FROM state_documents WHERE state_type = 'self_model'").current_state_json);
  assert.deepEqual(selfState.unfulfilled_commitment_ids, []);
  assert.equal(db.get("SELECT status FROM open_loops WHERE id = $id", { $id: loopId }).status, "resolved");
});

test("merges duplicate topics through canonical resolution without rewriting old references", async (t) => {
  const db = await createTestDatabase(t);
  const session = db.getActiveSession();
  const first = createTopic(db, session, {
    title: "Pet memory architecture",
    content: "Design the Pet memory architecture.",
    itemContent: "Use evidence-bound memory updates.",
  });
  const second = createTopic(db, session, {
    title: "Long-term memory design",
    content: "Continue the long-term memory design.",
    itemContent: "Keep raw evidence for every durable state.",
  });
  const mergeEvidence = db.addMessage({ sessionId: session.id, role: "user", content: "These two topics are the same Pet memory design topic." });
  const merged = applyContinuityOutput(db, {
    continuity_output: {
      topic_governance_updates: [{
        op: "merge",
        source_topic_id: first.topic.id,
        target_topic_id: second.topic.id,
        expected_source_version: first.topic.version,
        expected_target_version: second.topic.version,
        evidence: evidence(mergeEvidence),
      }],
    },
  }, { sourceMessages: [mergeEvidence], sessionId: session.id, trigger: "explicit", modelVersion: "test" });
  assert.equal(merged.applied.find((item) => item.section === "topic_governance").status, "applied");
  const oldTopic = db.get("SELECT * FROM topic_threads WHERE id = $id", { $id: first.topic.id });
  assert.equal(oldTopic.status, "merged");
  assert.equal(oldTopic.canonical_topic_id, second.topic.id);
  assert.equal(resolveCanonicalTopic(db, first.topic.id).id, second.topic.id);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM topic_items WHERE topic_id = $id", { $id: first.topic.id }).count, 1);
  const route = routeContinuity(db, first.topic.title);
  assert.equal(route.targetTopicId, second.topic.id);
  assert.equal(route.source, "topic_alias");
  const context = buildContinuityContext(db, { mode: "deep", route });
  assert.match(context.context, /Use evidence-bound memory updates/);
  assert.match(context.context, /Keep raw evidence for every durable state/);
});

test("injects Topic Item epistemic metadata and excludes expired items", async (t) => {
  const db = await createTestDatabase(t);
  const session = db.getActiveSession();
  const created = createTopic(db, session, {
    title: "Temporal topic item",
    content: "Discuss the validity of a temporary option.",
    itemContent: "Temporary option Z remains tentative.",
  });
  const route = { intent: "continue_current", targetTopicId: created.topic.id, confidence: 1 };
  const before = buildContinuityContext(db, { mode: "text", route });
  assert.match(before.context, /basis=stated_by_user/);
  assert.match(before.context, /confidence=0\.90/);
  assert.match(before.context, /valid_from=/);
  const item = db.get("SELECT * FROM topic_items WHERE topic_id = $id", { $id: created.topic.id });
  db.run("UPDATE topic_items SET valid_to = '2000-01-01T00:00:00.000Z' WHERE id = $id", { $id: item.id });
  const after = buildContinuityContext(db, { mode: "text", route });
  assert.doesNotMatch(after.context, /Temporary option Z remains tentative/);
});

test("passes the fixed offline continuity routing fixture", async (t) => {
  const db = await createTestDatabase(t);
  const session = db.getActiveSession();
  const pet = createTopic(db, session, {
    title: "Pet memory architecture",
    content: "Design evidence-bound long-term memory for Pet.",
  }).topic;
  const voice = createTopic(db, session, {
    title: "Voice runtime",
    content: "Improve streaming speech latency and interruption handling.",
  }).topic;
  const topics = { pet_memory: pet.id, voice_runtime: voice.id };
  const cases = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "continuity-routing-cases.json"), "utf8"));
  for (const fixture of cases) {
    db.run("UPDATE continuity_state SET active_topic_id = $id WHERE id = 'primary'", { $id: topics[fixture.active_topic] });
    const route = routeContinuity(db, fixture.query);
    assert.equal(route.intent, fixture.expected_route, fixture.name);
    assert.equal(route.targetTopicId, fixture.expected_topic ? topics[fixture.expected_topic] : null, fixture.name);
  }
});

test("uses thresholds only as health signals and rebuilds materialized state without duplicating items", async (t) => {
  const db = await createTestDatabase(t);
  const session = db.getActiveSession();
  const created = createTopic(db, session, {
    title: "Topic rebuild design",
    content: "Design evidence-based Topic rebuild behavior.",
    itemContent: "Rebuild current state without recreating historical items.",
  });
  const topicId = created.topic.id;
  const item = db.get("SELECT * FROM topic_items WHERE topic_id = $id", { $id: topicId });
  db.run("UPDATE topic_threads SET last_active_at = '2000-01-01T00:00:00.000Z' WHERE id = $id", { $id: topicId });
  const thresholdOnly = checkTopicHealth(db, topicId, { trigger: "scheduled_candidate" });
  assert.equal(thresholdOnly.signals.threshold_candidate, true);
  assert.equal(thresholdOnly.recommendation, "healthy");

  db.run("UPDATE topic_threads SET active_item_ids_json = $ids WHERE id = $id", {
    $id: topicId,
    $ids: JSON.stringify(["missing-item-id"]),
  });
  // Directly preserve the corrupt materialized set so the checker can diagnose it.
  const originalStatus = item.status;
  db.run("UPDATE topic_items SET status = 'rejected' WHERE id = $id", { $id: item.id });
  db.run("UPDATE topic_threads SET active_item_ids_json = $ids WHERE id = $id", { $id: topicId, $ids: JSON.stringify([item.id]) });
  const unhealthy = checkTopicHealth(db, topicId, { trigger: "user_correction" });
  assert.equal(unhealthy.recommendation, "rebuild_recommended");

  db.run("UPDATE topic_items SET status = $status WHERE id = $id", { $id: item.id, $status: originalStatus });
  const beforeCount = db.get("SELECT COUNT(*) AS count FROM topic_items WHERE topic_id = $id", { $id: topicId }).count;
  const rebuild = await rebuildTopicIntelligently({
    db,
    settings: { chatBaseUrl: "http://127.0.0.1:11434/v1", chatModel: "test", compressionModel: "test" },
    apiKey: "",
    topicId,
    healthRunId: unhealthy.id,
    complete: async () => ({
      data: {
        topic_rebuild: {
          topic_id: topicId,
          expected_version: db.get("SELECT version FROM topic_threads WHERE id = $id", { $id: topicId }).version,
          overview: "Topic rebuild keeps existing evidence and IDs.",
          current_position: "The materialized state is consistent again.",
          active_item_ids: [item.id],
          tentative_item_ids: [],
          open_loop_assessments: [],
          conflicts: [],
          missing_items: [],
        },
      },
    }),
  });
  assert.equal(rebuild.applied, true);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM topic_items WHERE topic_id = $id", { $id: topicId }).count, beforeCount);
  assert.deepEqual(JSON.parse(db.get("SELECT active_item_ids_json FROM topic_threads WHERE id = $id", { $id: topicId }).active_item_ids_json), [item.id]);
  assert.equal(db.get("SELECT status FROM topic_rebuild_runs WHERE id = $id", { $id: rebuild.runId }).status, "complete");
});
