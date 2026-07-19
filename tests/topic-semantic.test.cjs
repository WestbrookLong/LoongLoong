const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { PetDatabase, isoNow } = require("../electron/database.cjs");
const { applyContinuityOutput, routeContinuityEnhanced } = require("../electron/continuity.cjs");
const { PROFILE_ID, vectorToBlob } = require("../electron/embedding.cjs");
const { prepareSemanticQuery, retrieveMemoryEnhanced } = require("../electron/retrieval.cjs");
const { discoverMergeCandidates } = require("../electron/topic-merge.cjs");

async function createDatabase(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pet-topic-semantic-"));
  const db = await new PetDatabase(path.join(directory, "pet.db")).initialize();
  t.after(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return db;
}

function createTopic(db, title, content) {
  const session = db.getActiveSession();
  const message = db.addMessage({ sessionId: session.id, role: "user", content });
  const result = applyContinuityOutput(db, { continuity_output: { topic_updates: [{
    topic_ref: title, title, overview: content, current_position: content, make_active: true,
    evidence: [{ message_id: message.id, quote: content }],
  }] } }, { sourceMessages: [message], sessionId: session.id, trigger: "test", modelVersion: "test" });
  return db.get("SELECT * FROM topic_threads WHERE id = $id", { $id: result.topicIds[0] });
}

function putTopicVector(db, id, values) {
  const now = isoNow();
  db.run(`INSERT INTO memory_embeddings
    (object_type, object_id, embedding_profile_id, content_schema_version, content_hash,
     model, dimension, vector_blob, status, created_at, updated_at)
    VALUES ('topic', $id, $profile, 'test', $hash, 'fake', $dimension, $blob, 'ready', $now, $now)`,
    { $id: id, $profile: PROFILE_ID, $hash: `hash-${id}`, $dimension: values.length, $blob: vectorToBlob(values), $now: now });
}

test("semantic routing reopens an older topic with low lexical overlap", async (t) => {
  const db = await createDatabase(t);
  const target = createTopic(db, "Cognitive archive", "Preserve durable companion recollections across sessions.");
  const active = createTopic(db, "Voice latency", "Tune streaming audio buffering and interruption latency.");
  putTopicVector(db, target.id, [1, 0, 0, 0]);
  putTopicVector(db, active.id, [0, 1, 0, 0]);
  const semanticQuery = { analysis: { lowInformation: false }, vector: Float32Array.from([1, 0, 0, 0]) };
  const route = routeContinuityEnhanced(db, "Let us resume the personal history layer", { semanticQuery });
  assert.equal(route.intent, "reopen_old_topic");
  assert.equal(route.targetTopicId, target.id);
  assert.equal(route.source, "topic_semantic");
});

test("low-information continuation bypasses semantic topic switching", async (t) => {
  const db = await createDatabase(t);
  createTopic(db, "First", "First long running topic.");
  const active = createTopic(db, "Current", "The active work topic.");
  const route = routeContinuityEnhanced(db, "继续", {
    semanticQuery: { analysis: { lowInformation: true }, vector: Float32Array.from([1, 0]) },
  });
  assert.equal(route.intent, "continue_current");
  assert.equal(route.targetTopicId, active.id);
});

test("shares one query embedding across topic routing and memory retrieval", async (t) => {
  const db = await createDatabase(t);
  const topic = createTopic(db, "Memory architecture", "Build durable memory retrieval.");
  putTopicVector(db, topic.id, [1, 0, 0, 0]);
  let calls = 0;
  const embedder = async () => { calls += 1; return [Float32Array.from([1, 0, 0, 0])]; };
  const settings = { embeddingEnabled: "true", remoteEmbeddingConsent: "true", hybridRetrievalEnabled: "false" };
  const semanticQuery = await prepareSemanticQuery({ db, query: "Recall architecture", mode: "text", settings, apiKey: "test", embedder });
  routeContinuityEnhanced(db, "Recall architecture", { semanticQuery });
  await retrieveMemoryEnhanced(db, { query: "Recall architecture", sessionId: db.getActiveSession().id, mode: "text" },
    { settings, apiKey: "test", embedder, semanticQuery });
  assert.equal(calls, 1);
});

test("embedding neighbors discover merge candidates without auto-merging", async (t) => {
  const db = await createDatabase(t);
  const first = createTopic(db, "Cognitive archive", "Preserve personal recollections.");
  const second = createTopic(db, "Recall substrate", "Store continuity traces.");
  putTopicVector(db, first.id, [1, 0, 0, 0]);
  putTopicVector(db, second.id, [1, 0, 0, 0]);
  const ids = discoverMergeCandidates(db, { topicIds: [second.id], trigger: "semantic_test" });
  assert.equal(ids.length, 1);
  const candidate = db.get("SELECT * FROM topic_merge_candidates WHERE id = $id", { $id: ids[0] });
  assert.equal(candidate.status, "pending_model");
  assert.equal(JSON.parse(candidate.score_components_json).semantic_score, 1);
  assert.equal(db.get("SELECT status FROM topic_threads WHERE id = $id", { $id: second.id }).status, "open");
});
