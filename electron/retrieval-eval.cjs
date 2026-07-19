const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { PetDatabase, isoNow } = require("./database.cjs");
const { retrieveMemory } = require("./memory.cjs");

const readDataset = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

function seedDataset(db, dataset) {
  const now = isoNow();
  const day = db.ensureJournalDay();
  for (const claim of dataset.claims || []) {
    db.db.run(
      `INSERT INTO memory_claims
       (id, namespace, claim_type, subject, predicate, object_json, canonical_text,
        scope_type, scope_id, claim_key, value_hash, cardinality, status, confidence,
        importance, stability, promotion_score, epistemic_basis, sensitivity, temporal_state,
        asserted_at, temporal_basis, temporal_precision, temporal_confidence, valid_from,
        valid_to, version, created_at, updated_at)
       VALUES ($id, 'user', 'fact', 'user', $predicate, $object, $text,
        'global', NULL, $claimKey, $valueHash, 'single', $status, 0.9,
        $importance, 0.85, 0.9, $basis, 'private', $temporalState,
        $assertedAt, 'explicit', 'day', 0.9, $validFrom, $validTo, 1, $now, $now)`,
      {
        $id: claim.id,
        $predicate: claim.predicate,
        $object: JSON.stringify({ value: claim.text }),
        $text: claim.text,
        $claimKey: `eval:${claim.predicate}`,
        $valueHash: claim.id,
        $status: claim.status || "active",
        $importance: claim.importance ?? 0.7,
        $basis: claim.epistemic_basis || "stated_by_user",
        $temporalState: claim.temporal_state || "current",
        $assertedAt: claim.valid_from || now,
        $validFrom: claim.valid_from || null,
        $validTo: claim.valid_to || null,
        $now: now,
      },
    );
  }
  for (let index = 0; index < Number(dataset.distractor_count || 0); index += 1) {
    const id = `claim_distractor_${index + 1}`;
    db.db.run(
      `INSERT INTO memory_claims
       (id, namespace, claim_type, subject, predicate, object_json, canonical_text,
        scope_type, claim_key, value_hash, cardinality, status, confidence, importance,
        stability, promotion_score, epistemic_basis, sensitivity, temporal_state,
        asserted_at, temporal_basis, temporal_precision, temporal_confidence, version,
        created_at, updated_at)
       VALUES ($id, 'user', 'fact', 'user', $predicate, $object, $text,
        'global', $claimKey, $valueHash, 'single', 'active', 0.88, 0.79,
        0.8, 0.86, 'stated_by_user', 'private', 'current',
        $now, 'explicit', 'day', 0.9, 1, $now, $now)`,
      {
        $id: id,
        $predicate: `unrelated_preference_${index + 1}`,
        $object: JSON.stringify({ value: `Unrelated durable preference number ${index + 1}` }),
        $text: `Unrelated durable preference number ${index + 1} about a separate project.`,
        $claimKey: `eval:distractor:${index + 1}`,
        $valueHash: id,
        $now: now,
      },
    );
  }
  let sequence = 1;
  for (const event of dataset.events || []) {
    db.db.run(
      `INSERT INTO events
       (id, journal_day_id, sequence_no, event_type, actor, occurred_at, recorded_at,
        content, payload_json, source_kind, salience, continuity_value,
        continuity_score_version, continuity_components_json, confidence,
        retention_class, sensitivity, dedupe_key, extractor_version)
       VALUES ($id, $dayId, $sequence, $type, 'user', $occurredAt, $now,
        $content, '{}', 'eval_fixture', $salience, 0.8,
        'retrieval-eval-v1', '{}', 0.9, 'durable', 'private', $dedupe, 'retrieval-eval-v1')`,
      {
        $id: event.id,
        $dayId: day.id,
        $sequence: sequence++,
        $type: event.event_type || "user_statement",
        $occurredAt: event.occurred_at || now,
        $now: now,
        $content: event.content,
        $salience: event.salience ?? 0.7,
        $dedupe: `eval:${event.id}`,
      },
    );
  }
  db.persist();
}

const includesAll = (selected, expected = []) => expected.every((id) => selected.includes(id));

function scoreCases(dataset, results) {
  let expectedTotal = 0;
  let expectedHit = 0;
  let forbiddenTotal = 0;
  let forbiddenHit = 0;
  let disputedTotal = 0;
  let disputedHit = 0;
  const cases = dataset.cases.map((item, index) => {
    const result = results[index];
    const expected = [...(item.expected_claim_ids || []), ...(item.expected_event_ids || [])];
    const selected = [...result.selectedClaimIds, ...result.selectedEventIds];
    const forbidden = item.forbidden_claim_ids || [];
    const disputed = item.expected_disputed_ids || [];
    expectedTotal += expected.length;
    expectedHit += expected.filter((id) => selected.includes(id)).length;
    forbiddenTotal += forbidden.length;
    forbiddenHit += forbidden.filter((id) => selected.includes(id)).length;
    disputedTotal += disputed.length;
    disputedHit += disputed.filter((id) => result.context.includes(`\"id\":\"${id}\"`) && result.context.includes("\"status\":\"disputed\"")).length;
    return {
      id: item.id,
      passed: includesAll(selected, expected) && !forbidden.some((id) => selected.includes(id)),
      selected_claim_ids: result.selectedClaimIds,
      selected_event_ids: result.selectedEventIds,
      missing_ids: expected.filter((id) => !selected.includes(id)),
      forbidden_hits: forbidden.filter((id) => selected.includes(id)),
    };
  });
  return {
    case_pass_rate: cases.filter((item) => item.passed).length / Math.max(1, cases.length),
    recall: expectedHit / Math.max(1, expectedTotal),
    forbidden_leak_rate: forbiddenHit / Math.max(1, forbiddenTotal),
    disputed_protocol_recall: disputedHit / Math.max(1, disputedTotal),
    cases,
  };
}

async function evaluateDataset(dataset, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pet-retrieval-eval-"));
  const db = await new PetDatabase(path.join(directory, "pet.db")).initialize();
  try {
    seedDataset(db, dataset);
    const session = db.getActiveSession();
    const retrieve = options.retrieve || retrieveMemory;
    const results = [];
    for (const item of dataset.cases) {
      results.push(await retrieve(db, {
        query: item.query,
        sessionId: session.id,
        mode: item.mode || "text",
      }, options));
    }
    return { dataset_version: dataset.version, ...scoreCases(dataset, results) };
  } finally {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { evaluateDataset, readDataset, scoreCases, seedDataset };
