const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PetDatabase } = require("../electron/database.cjs");
const { applyContinuityOutput, continuityScoreDetails, decideContinuityRoute } = require("../electron/continuity.cjs");
const { evaluateProfile, persistEvaluationRun, recordContinuityFeedback, searchProfiles } = require("../electron/continuity-eval.cjs");
const { getContinuityProfile, normalizeProfile, profileState, promoteContinuityProfile, stageContinuityProfile } = require("../electron/continuity-profiles.cjs");
const { adjudicateMergeCandidate, discoverMergeCandidates } = require("../electron/topic-merge.cjs");
const { resolveCanonicalTopic } = require("../electron/topic-governance.cjs");

async function createTestDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pet-merge-eval-"));
  const database = await new PetDatabase(path.join(directory, "pet.db")).initialize();
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return database;
}

function createTopic(db, session, title, content) {
  const message = db.addMessage({ sessionId: session.id, role: "user", content });
  const result = applyContinuityOutput(db, {
    continuity_output: {
      topic_updates: [{
        topic_ref: title,
        title,
        overview: content,
        current_position: content,
        make_active: true,
        evidence: [{ message_id: message.id, quote: message.content }],
        operations: [{
          op: "add_item",
          item_type: "decision",
          content,
          epistemic_basis: "stated_by_user",
          evidence: [{ message_id: message.id, quote: message.content }],
        }],
      }],
    },
  }, { sourceMessages: [message], sessionId: session.id, trigger: "test", modelVersion: "test" });
  return db.get("SELECT * FROM topic_threads WHERE id = $id", { $id: result.topicIds[0] });
}

function adjudicator(db, candidateId, decision, confidence = 0.98) {
  return async () => {
    const evidence = db.all(
      "SELECT event_id FROM topic_merge_candidate_evidence WHERE candidate_id = $id ORDER BY topic_side, event_id",
      { $id: candidateId },
    );
    return {
      data: {
        topic_merge_decision: {
          decision,
          confidence,
          rationale: "Evidence-grounded test adjudication.",
          supporting_event_ids: evidence.map((item) => item.event_id),
        },
      },
    };
  };
}

test("discovers, adjudicates, and canonically merges a duplicate Topic", async (t) => {
  const db = await createTestDatabase(t);
  const session = db.getActiveSession();
  const older = createTopic(db, session, "Pet memory design", "Design evidence-bound long-term memory for Pet.");
  const newer = createTopic(db, session, "Pet memory system", "Continue Pet memory design with evidence-bound long-term memory.");
  const candidateIds = discoverMergeCandidates(db, { topicIds: [newer.id], trigger: "test" });
  assert.equal(candidateIds.length, 1);
  const result = await adjudicateMergeCandidate({
    db,
    settings: { chatBaseUrl: "http://127.0.0.1:1", memoryModel: "test" },
    apiKey: "",
    candidateId: candidateIds[0],
    complete: adjudicator(db, candidateIds[0], "same_topic"),
  });
  assert.equal(result.status, "applied");
  assert.equal(resolveCanonicalTopic(db, newer.id).id, older.id);
  assert.equal(db.get("SELECT status FROM topic_merge_candidates WHERE id = $id", { $id: candidateIds[0] }).status, "applied");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM topic_items WHERE topic_id = $id", { $id: newer.id }).count, 1);
});

test("keeps a low-lexical semantic match pending review", async (t) => {
  const db = await createTestDatabase(t);
  const session = db.getActiveSession();
  const first = createTopic(db, session, "Cognitive archive", "Persist evidence-bound long-term companion memory decisions and open work.");
  const second = createTopic(db, session, "Pet recall layer", "Persist evidence-bound long-term companion memory decisions and open work.");
  const candidateIds = discoverMergeCandidates(db, { topicIds: [second.id], trigger: "test" });
  assert.equal(candidateIds.length, 1);
  const result = await adjudicateMergeCandidate({
    db,
    settings: { chatBaseUrl: "http://127.0.0.1:1", memoryModel: "test" },
    apiKey: "",
    candidateId: candidateIds[0],
    complete: adjudicator(db, candidateIds[0], "same_topic"),
  });
  assert.equal(result.status, "pending_review");
  assert.equal(resolveCanonicalTopic(db, first.id).id, first.id);
  assert.equal(resolveCanonicalTopic(db, second.id).id, second.id);
});

test("records related Topics without merging them", async (t) => {
  const db = await createTestDatabase(t);
  const session = db.getActiveSession();
  const first = createTopic(db, session, "Voice runtime", "Build low-latency voice runtime streaming.");
  const second = createTopic(db, session, "Voice memory", "Use voice runtime transcripts for memory extraction.");
  const candidateIds = discoverMergeCandidates(db, { topicIds: [second.id], trigger: "test" });
  assert.equal(candidateIds.length, 1);
  const result = await adjudicateMergeCandidate({
    db,
    settings: { chatBaseUrl: "http://127.0.0.1:1", memoryModel: "test" },
    apiKey: "",
    candidateId: candidateIds[0],
    complete: adjudicator(db, candidateIds[0], "related_but_distinct", 0.9),
  });
  assert.equal(result.status, "related");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM topic_relations WHERE relation = 'related_to'").count, 1);
  assert.equal(resolveCanonicalTopic(db, second.id).id, second.id);
});

test("evaluates versioned value and router profiles without changing production state", async (t) => {
  const db = await createTestDatabase(t);
  const fixtures = path.join(__dirname, "fixtures");
  const dataset = {
    route_cases: JSON.parse(fs.readFileSync(path.join(fixtures, "continuity-route-features.json"), "utf8")),
    value_cases: JSON.parse(fs.readFileSync(path.join(fixtures, "continuity-value-cases.json"), "utf8")),
  };
  const profile = getContinuityProfile();
  const metrics = evaluateProfile(profile, dataset);
  assert.equal(metrics.route.accuracy, 1);
  assert.equal(metrics.route.macro_f1, 1);
  assert.equal(metrics.value.must_keep_recall, 1);
  const report = searchProfiles(dataset, profile);
  assert.equal(report.recommendation.safe, true);
  assert.equal(db.get("SELECT active_profile_id FROM continuity_profile_state WHERE id = 'primary'").active_profile_id, profile.id);

  const route = decideContinuityRoute(dataset.route_cases[2].features, profile);
  assert.equal(route.routerVersion, "topic-router-v1");
  assert.equal(route.intent, "reopen_old_topic");
  assert.equal(continuityScoreDetails({}, "commitment", profile).score_version, "continuity-value-v1");
});

test("stages a safe evaluated Profile in shadow before explicit promotion", async (t) => {
  const db = await createTestDatabase(t);
  const baseline = getContinuityProfile();
  const candidate = normalizeProfile({
    ...baseline,
    id: "continuity-profile-candidate-test",
    value: { ...baseline.value, version: "continuity-value-candidate-test" },
    router: { ...baseline.router, version: "topic-router-candidate-test", lexical_match_threshold: 0.24 },
  });
  const report = {
    baseline: { profile: baseline, metrics: {} },
    challenger: { profile: candidate, metrics: {} },
    recommendation: { action: "review_challenger", safe: true, profile_distance: 0.02 },
  };
  persistEvaluationRun(db, "test-dataset", report);
  assert.equal(stageContinuityProfile(db, candidate.id).applied, true);
  assert.equal(profileState(db).challenger.id, candidate.id);
  assert.equal(db.get("SELECT active_profile_id FROM continuity_profile_state WHERE id = 'primary'").active_profile_id, baseline.id);
  assert.equal(promoteContinuityProfile(db, candidate.id).applied, true);
  assert.equal(profileState(db).active.id, candidate.id);
  assert.equal(profileState(db).challenger, null);
});

test("stores observational continuity feedback separately from online weights", async (t) => {
  const db = await createTestDatabase(t);
  const feedbackId = recordContinuityFeedback(db, {
    feedbackType: "immediate_user_correction",
    source: "user_correction",
    strength: "weak",
    notes: "The exact faulty layer is not yet classified.",
  });
  const feedback = db.get("SELECT * FROM continuity_feedback WHERE id = $id", { $id: feedbackId });
  assert.equal(feedback.strength, "weak");
  assert.equal(db.get("SELECT active_profile_id FROM continuity_profile_state WHERE id = 'primary'").active_profile_id, "continuity-profile-v1");
});
