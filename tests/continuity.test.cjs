const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PetDatabase } = require("../electron/database.cjs");
const {
  applyContinuityOutput,
  buildContinuityContext,
  calculateContinuityValue,
  continuitySnapshotRefs,
  routeContinuity,
} = require("../electron/continuity.cjs");
const { applyMemoryOutput } = require("../electron/memory-intelligence.cjs");

async function createTestDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pet-continuity-test-"));
  const database = await new PetDatabase(path.join(directory, "pet.db")).initialize();
  t.after(() => {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return database;
}

function topicProposal(message) {
  const evidence = [{ message_id: message.id, quote: "继续设计 Pet 的长期主题和开放循环" }];
  return {
    continuity_output: {
      routing: {
        intent: "new_topic",
        target_topic_ref: "pet-continuity",
        confidence: 0.96,
      },
      topic_updates: [{
        topic_ref: "pet-continuity",
        title: "Pet 连续性记忆",
        overview: "设计跨 Session 持续存在的主题和开放循环。",
        current_position: "已经确定使用 Topic 与 Open Loop 分离建模。",
        make_active: true,
        continuity_signals: {
          future_reference: 1,
          unresolvedness: 0.8,
          error_prevention: 0.7,
          identity_relationship: 0.4,
          cross_session: 1,
        },
        evidence,
        operations: [{
          op: "add_item",
          item_type: "decision",
          content: "Topic 保存讨论状态，Open Loop 保存未完成事项。",
          epistemic_basis: "stated_by_user",
          continuity_signals: { future_reference: 0.9, cross_session: 1 },
          evidence,
        }],
      }],
      open_loop_updates: [{
        op: "create",
        topic_ref: "pet-continuity",
        loop_type: "task",
        owner: "shared",
        description: "为连续性记忆补充主题重建机制。",
        priority: 0.8,
        continuity_signals: { future_reference: 1, unresolvedness: 1, cross_session: 1 },
        evidence,
      }],
    },
  };
}

test("creates an auditable topic, decision, and open loop from grounded evidence", async (t) => {
  const db = await createTestDatabase(t);
  const session = db.getActiveSession();
  const message = db.addMessage({
    sessionId: session.id,
    role: "user",
    content: "我们继续设计 Pet 的长期主题和开放循环。",
  });
  const output = topicProposal(message);
  const result = applyContinuityOutput(db, output, {
    sourceMessages: [message],
    sessionId: session.id,
    parentRunId: "memory-run-1",
    trigger: "explicit",
    modelVersion: "test",
  });

  assert.equal(result.skipped, false);
  assert.equal(result.topicIds.length, 1);
  assert.equal(result.openLoopIds.length, 1);
  const topic = db.get("SELECT * FROM topic_threads WHERE id = $id", { $id: result.topicIds[0] });
  const item = db.get("SELECT * FROM topic_items WHERE topic_id = $id", { $id: topic.id });
  const loop = db.get("SELECT * FROM open_loops WHERE id = $id", { $id: result.openLoopIds[0] });
  assert.equal(topic.title, "Pet 连续性记忆");
  assert.equal(item.status, "confirmed");
  assert.equal(item.epistemic_basis, "stated_by_user");
  assert.equal(loop.status, "open");
  assert.equal(loop.topic_id, topic.id);
  assert.equal(db.get("SELECT active_topic_id FROM continuity_state WHERE id = 'primary'").active_topic_id, topic.id);
  assert.ok(db.get("SELECT * FROM topic_item_evidence WHERE topic_item_id = $id", { $id: item.id }));
  assert.ok(db.get("SELECT * FROM open_loop_evidence WHERE open_loop_id = $id", { $id: loop.id }));
  assert.equal(db.get("SELECT status FROM continuity_update_runs WHERE id = $id", { $id: result.runId }).status, "complete");

  const duplicate = applyContinuityOutput(db, output, {
    sourceMessages: [message],
    sessionId: session.id,
    parentRunId: "memory-run-1",
    trigger: "explicit",
    modelVersion: "test",
  });
  assert.equal(duplicate.reason, "already_processed");
  assert.equal(db.get("SELECT COUNT(*) AS count FROM topic_threads").count, 1);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM topic_items").count, 1);
  assert.equal(db.get("SELECT COUNT(*) AS count FROM open_loops").count, 1);

  const stateVersion = db.get("SELECT version FROM continuity_state WHERE id = 'primary'").version;
  applyContinuityOutput(db, {
    continuity_output: {
      topic_updates: [{ topic_id: topic.id, expected_version: topic.version, make_active: true }],
    },
  }, { sessionId: session.id, trigger: "batch", modelVersion: "test" });
  assert.equal(db.get("SELECT version FROM continuity_state WHERE id = 'primary'").version, stateVersion);
});

test("routes low-information continuation to the active topic and builds protected context", async (t) => {
  const db = await createTestDatabase(t);
  const session = db.getActiveSession();
  const message = db.addMessage({
    sessionId: session.id,
    role: "user",
    content: "我们继续设计 Pet 的长期主题和开放循环。",
  });
  applyContinuityOutput(db, topicProposal(message), {
    sourceMessages: [message],
    sessionId: session.id,
    trigger: "explicit",
    modelVersion: "test",
  });

  const route = routeContinuity(db, "继续。");
  const context = buildContinuityContext(db, { mode: "text", route });
  const refs = continuitySnapshotRefs(db);
  assert.equal(route.intent, "continue_current");
  assert.equal(route.targetTopicId, refs.active_topic.id);
  assert.match(context.context, /Pet 连续性记忆/);
  assert.match(context.context, /为连续性记忆补充主题重建机制/);
  assert.deepEqual(context.openLoopIds.length, 1);
  assert.equal(refs.open_loops.length, 1);
});

test("requires evidence and matching versions to resolve an open loop", async (t) => {
  const db = await createTestDatabase(t);
  const session = db.getActiveSession();
  const first = db.addMessage({
    sessionId: session.id,
    role: "user",
    content: "我们继续设计 Pet 的长期主题和开放循环。",
  });
  const created = applyContinuityOutput(db, topicProposal(first), {
    sourceMessages: [first],
    sessionId: session.id,
    trigger: "explicit",
    modelVersion: "test",
  });
  const loopId = created.openLoopIds[0];

  const invalid = applyContinuityOutput(db, {
    continuity_output: {
      open_loop_updates: [{ op: "resolve", open_loop_id: loopId, expected_version: 1 }],
    },
  }, { sourceMessages: [], sessionId: session.id, trigger: "batch", modelVersion: "test" });
  assert.equal(invalid.applied[0].status, "rejected");
  assert.equal(db.get("SELECT status FROM open_loops WHERE id = $id", { $id: loopId }).status, "open");

  const resolution = db.addMessage({
    sessionId: session.id,
    role: "user",
    content: "主题重建机制已经实现并通过测试。",
  });
  const resolved = applyContinuityOutput(db, {
    continuity_output: {
      open_loop_updates: [{
        op: "resolve",
        open_loop_id: loopId,
        expected_version: 1,
        resolution_summary: "主题重建机制已经实现。",
        evidence: [{ message_id: resolution.id, quote: "主题重建机制已经实现并通过测试" }],
      }],
    },
  }, { sourceMessages: [resolution], sessionId: session.id, trigger: "explicit", modelVersion: "test" });
  assert.equal(resolved.openLoopIds[0], loopId);
  const loop = db.get("SELECT * FROM open_loops WHERE id = $id", { $id: loopId });
  assert.equal(loop.status, "resolved");
  assert.ok(loop.resolution_event_id);
  assert.ok(db.get("SELECT * FROM open_loop_evidence WHERE open_loop_id = $id AND relation = 'resolves'", { $id: loopId }));
});

test("keeps explicitly inferred claims as candidates", async (t) => {
  const db = await createTestDatabase(t);
  const session = db.getActiveSession();
  const message = db.addMessage({
    sessionId: session.id,
    role: "user",
    content: "最近我可能更喜欢安静一点的交流。",
  });
  const result = applyMemoryOutput(db, {
    claim_candidates: [{
      namespace: "user",
      claim_type: "preference",
      subject: "user",
      predicate: "interaction_energy",
      value: "quiet",
      canonical_text: "用户可能偏好更安静的交流。",
      confidence: 0.98,
      importance: 0.9,
      stability: 0.9,
      explicit: true,
      epistemic_basis: "inferred",
      evidence: [{ message_id: message.id, quote: "可能更喜欢安静一点的交流" }],
    }],
  }, { sourceMessages: [message], runId: "inferred-run" });
  const claim = db.get("SELECT * FROM memory_claims WHERE id = $id", { $id: result.claimIds[0] });
  assert.equal(claim.epistemic_basis, "inferred");
  assert.equal(claim.status, "candidate");
});

test("computes continuity value from components with hard floors", () => {
  assert.equal(calculateContinuityValue({}, "open_loop"), 0.8);
  assert.equal(calculateContinuityValue({}, "commitment"), 0.9);
  assert.equal(calculateContinuityValue({ future_reference: 1, unresolvedness: 1, cross_session: 1 }, "ordinary"), 0.65);
});
