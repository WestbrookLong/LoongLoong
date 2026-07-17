const crypto = require("node:crypto");
const { isoNow } = require("./database.cjs");
const { containsForbiddenSecret } = require("./memory.cjs");

const asArray = (value) => (Array.isArray(value) ? value : []);
const cleanText = (value, max = 1800) => String(value || "").trim().slice(0, max);
const parseJson = (value, fallback) => {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
};
const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");

function normalizeAlias(value) {
  return cleanText(value, 180)
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .slice(0, 180);
}

function resolveCanonicalTopic(db, topicId) {
  let topic = db.get("SELECT * FROM topic_threads WHERE id = $id", { $id: String(topicId || "") });
  const visited = new Set();
  for (let depth = 0; topic?.canonical_topic_id && depth < 12; depth += 1) {
    if (visited.has(topic.id)) return null;
    visited.add(topic.id);
    const next = db.get("SELECT * FROM topic_threads WHERE id = $id", { $id: topic.canonical_topic_id });
    if (!next) break;
    topic = next;
  }
  return topic || null;
}

function findTopicByAlias(db, alias) {
  const normalized = normalizeAlias(alias);
  if (!normalized) return null;
  const row = db.get(
    `SELECT t.* FROM topic_aliases a JOIN topic_threads t ON t.id = a.topic_id
     WHERE a.normalized_alias = $alias LIMIT 1`,
    { $alias: normalized },
  );
  return row ? resolveCanonicalTopic(db, row.id) : null;
}

function expandTopicFamily(db, topicId) {
  const canonical = resolveCanonicalTopic(db, topicId);
  if (!canonical) return [];
  return db.all("SELECT * FROM topic_threads ORDER BY created_at").filter((topic) => resolveCanonicalTopic(db, topic.id)?.id === canonical.id);
}

function topicFamilyIds(db, topicId) {
  return expandTopicFamily(db, topicId).map((topic) => topic.id);
}

function synchronizeTopicMaterializedSets(db, topicId) {
  const topic = resolveCanonicalTopic(db, topicId);
  if (!topic) return null;
  const familyIds = topicFamilyIds(db, topic.id);
  if (!familyIds.length) return topic;
  const placeholders = familyIds.map((_, index) => `$topic${index}`).join(", ");
  const params = Object.fromEntries(familyIds.map((id, index) => [`$topic${index}`, id]));
  const items = db.all(
    `SELECT id, status FROM topic_items WHERE topic_id IN (${placeholders}) AND status != 'superseded'`,
    params,
  );
  const activeIds = items.filter((item) => ["active", "confirmed", "unresolved"].includes(item.status)).map((item) => item.id);
  const tentativeIds = items.filter((item) => ["tentative", "reopened"].includes(item.status)).map((item) => item.id);
  db.db.run(
    `UPDATE topic_threads SET active_item_ids_json = $active, tentative_item_ids_json = $tentative
     WHERE id = $id`,
    { $id: topic.id, $active: JSON.stringify(activeIds), $tentative: JSON.stringify(tentativeIds) },
  );
  return db.get("SELECT * FROM topic_threads WHERE id = $id", { $id: topic.id });
}

function addAlias(db, topicId, alias, runId, eventIds) {
  const canonical = resolveCanonicalTopic(db, topicId);
  const value = cleanText(alias, 180);
  const normalized = normalizeAlias(value);
  if (!canonical || !value || !normalized || containsForbiddenSecret(value)) return null;
  let row = db.get("SELECT * FROM topic_aliases WHERE normalized_alias = $alias", { $alias: normalized });
  if (row && resolveCanonicalTopic(db, row.topic_id)?.id !== canonical.id) return null;
  if (!row) {
    const id = crypto.randomUUID();
    db.db.run(
      `INSERT INTO topic_aliases (id, alias, normalized_alias, topic_id, source_run_id, created_at)
       VALUES ($id, $alias, $normalized, $topicId, $runId, $createdAt)`,
      { $id: id, $alias: value, $normalized: normalized, $topicId: canonical.id, $runId: runId, $createdAt: isoNow() },
    );
    row = db.get("SELECT * FROM topic_aliases WHERE id = $id", { $id: id });
  }
  for (const eventId of eventIds) {
    db.db.run(
      `INSERT OR IGNORE INTO topic_alias_evidence (alias_id, event_id, created_at)
       VALUES ($aliasId, $eventId, $createdAt)`,
      { $aliasId: row.id, $eventId: eventId, $createdAt: isoNow() },
    );
  }
  return row;
}

function mergeTopics(db, update, context, evidence) {
  const source = db.get("SELECT * FROM topic_threads WHERE id = $id", { $id: String(update.source_topic_id || "") });
  const requestedTarget = db.get("SELECT * FROM topic_threads WHERE id = $id", { $id: String(update.target_topic_id || "") });
  const target = requestedTarget ? resolveCanonicalTopic(db, requestedTarget.id) : null;
  if (!source || !target || source.id === target.id) return { status: "rejected", reason: "invalid_merge_topics" };
  if (source.canonical_topic_id || source.status === "merged") return { status: "rejected", reason: "source_already_merged" };
  if (Number(update.expected_source_version) !== Number(source.version) || Number(update.expected_target_version) !== Number(target.version)) {
    return { status: "rejected", reason: "version_mismatch" };
  }
  if (!evidence.eventIds.length) return { status: "rejected", reason: "missing_evidence" };
  if (resolveCanonicalTopic(db, target.id)?.id === source.id) return { status: "rejected", reason: "canonical_cycle" };
  db.db.run(
    `UPDATE topic_threads SET status = 'merged', canonical_topic_id = $targetId,
     version = version + 1, last_active_at = $now WHERE id = $sourceId`,
    { $sourceId: source.id, $targetId: target.id, $now: isoNow() },
  );
  db.db.run(
    `INSERT OR IGNORE INTO topic_relations
     (source_topic_id, target_topic_id, relation, source_run_id, created_at)
     VALUES ($sourceId, $targetId, 'merged_into', $runId, $createdAt)`,
    { $sourceId: source.id, $targetId: target.id, $runId: context.runId, $createdAt: isoNow() },
  );
  addAlias(db, target.id, source.title, context.runId, evidence.eventIds);
  const state = db.get("SELECT * FROM continuity_state WHERE id = 'primary'");
  const originalRecent = parseJson(state?.recent_topic_ids_json, []);
  const recent = [...new Set(originalRecent.map((id) => id === source.id ? target.id : id))]
    .filter((id) => id !== target.id)
    .slice(0, 8);
  if (state?.active_topic_id === source.id) {
    db.db.run(
      `UPDATE continuity_state SET active_topic_id = $targetId, recent_topic_ids_json = $recent, updated_at = $now,
       last_topic_transition_at = $now, version = version + 1 WHERE id = 'primary'`,
      { $targetId: target.id, $recent: JSON.stringify(recent), $now: isoNow() },
    );
  } else if (JSON.stringify(originalRecent) !== JSON.stringify(recent)) {
    db.db.run(
      `UPDATE continuity_state SET recent_topic_ids_json = $recent, updated_at = $now,
       version = version + 1 WHERE id = 'primary'`,
      { $recent: JSON.stringify(recent), $now: isoNow() },
    );
  }
  if (context.sessionId) {
    const retrieval = db.get(
      "SELECT id, outcome_json FROM retrieval_logs WHERE session_id = $sessionId ORDER BY created_at DESC LIMIT 1",
      { $sessionId: context.sessionId },
    );
    if (retrieval) {
      const outcome = parseJson(retrieval.outcome_json, {});
      const toolVerified = evidence.eventIds.some((eventId) => {
        const event = db.get("SELECT source_kind FROM events WHERE id = $id", { $id: eventId });
        return event?.source_kind === "tool_receipt";
      });
      db.db.run(
        "UPDATE retrieval_logs SET outcome_json = $outcome WHERE id = $id",
        {
          $id: retrieval.id,
          $outcome: JSON.stringify({
            ...outcome,
            duplicate_topic_detected: true,
            merged_source_topic_id: source.id,
            canonical_topic_id: target.id,
            observed_at: isoNow(),
          }),
        },
      );
    }
  }
  synchronizeTopicMaterializedSets(db, target.id);
  return { status: "applied", source_topic_id: source.id, target_topic_id: target.id };
}

function applyGovernanceUpdates(db, updates, context, resolveEvidence) {
  const results = [];
  for (const [index, update] of asArray(updates).entries()) {
    const op = cleanText(update.op, 40);
    const evidence = resolveEvidence(db, update, context);
    if (op === "add_alias") {
      if (!evidence.eventIds.length) {
        results.push({ section: "topic_governance", index, op, status: "rejected", reason: "missing_evidence" });
        continue;
      }
      const alias = addAlias(db, update.topic_id, update.alias, context.runId, evidence.eventIds);
      results.push(alias
        ? { section: "topic_governance", index, op, status: "applied", alias_id: alias.id, topic_id: alias.topic_id }
        : { section: "topic_governance", index, op, status: "rejected", reason: "alias_conflict_or_invalid" });
      continue;
    }
    if (op === "merge") {
      results.push({ section: "topic_governance", index, op, ...mergeTopics(db, update, context, evidence) });
      continue;
    }
    results.push({ section: "topic_governance", index, op, status: "rejected", reason: "unsupported_operation" });
  }
  return results;
}

function structuralTopicFindings(db, topic) {
  const findings = [];
  const familyIds = topicFamilyIds(db, topic.id);
  const familySet = new Set(familyIds);
  const activeIds = parseJson(topic.active_item_ids_json, []);
  const tentativeIds = parseJson(topic.tentative_item_ids_json, []);
  for (const id of activeIds) {
    const item = db.get("SELECT id, topic_id, status FROM topic_items WHERE id = $id", { $id: id });
    if (!item || !familySet.has(item.topic_id)) findings.push({ type: "invalid_active_item_reference", item_id: id, severity: "high" });
    else if (!["active", "confirmed", "unresolved"].includes(item.status)) findings.push({ type: "inactive_item_in_active_set", item_id: id, status: item.status, severity: "high" });
  }
  for (const id of tentativeIds) {
    const item = db.get("SELECT id, topic_id, status FROM topic_items WHERE id = $id", { $id: id });
    if (!item || !familySet.has(item.topic_id)) findings.push({ type: "invalid_tentative_item_reference", item_id: id, severity: "high" });
    else if (!["tentative", "reopened"].includes(item.status)) findings.push({ type: "invalid_tentative_item_status", item_id: id, status: item.status, severity: "medium" });
  }
  if (topic.status === "merged" && !topic.canonical_topic_id) findings.push({ type: "merged_topic_without_canonical", severity: "critical" });
  return findings;
}

function checkTopicHealth(db, topicId, { trigger = "scheduled", sourceRunId = null, modelFindings = [] } = {}) {
  const topic = resolveCanonicalTopic(db, topicId);
  if (!topic) return null;
  const current = db.get("SELECT * FROM topic_threads WHERE id = $id", { $id: topic.id });
  const revisionCount = Number(db.get("SELECT COUNT(*) AS count FROM topic_revisions WHERE topic_id = $id", { $id: topic.id })?.count || 0);
  const inactiveDays = Math.max(0, (Date.now() - new Date(current.last_active_at).getTime()) / 86400000);
  const signals = {
    revision_count: revisionCount,
    inactive_days: Number(inactiveDays.toFixed(2)),
    threshold_candidate: revisionCount >= 20 || inactiveDays >= 30,
  };
  const findings = [...structuralTopicFindings(db, current), ...asArray(modelFindings)];
  const severeTopicFinding = findings.some((finding) => (
    ["high", "critical"].includes(finding.severity) && finding.issue_scope === "topic_state"
  ));
  const structuralFailure = findings.some((finding) => ["high", "critical"].includes(finding.severity) && !finding.issue_scope);
  const recommendation = severeTopicFinding || structuralFailure
    ? "rebuild_recommended"
    : findings.length
      ? "warning"
      : "healthy";
  const id = crypto.randomUUID();
  db.db.run(
    `INSERT INTO topic_health_runs
     (id, topic_id, trigger_type, base_version, status, signals_json, findings_json,
      recommendation, source_run_id, created_at)
     VALUES ($id, $topicId, $trigger, $version, 'complete', $signals, $findings,
      $recommendation, $sourceRunId, $createdAt)`,
    {
      $id: id,
      $topicId: current.id,
      $trigger: trigger,
      $version: current.version,
      $signals: JSON.stringify(signals),
      $findings: JSON.stringify(findings),
      $recommendation: recommendation,
      $sourceRunId: sourceRunId,
      $createdAt: isoNow(),
    },
  );
  return { id, topicId: current.id, recommendation, findings, signals };
}

function applyHealthReports(db, reports, context, resolveEvidence) {
  const results = [];
  for (const [index, report] of asArray(reports).entries()) {
    const topic = resolveCanonicalTopic(db, report.topic_id);
    const evidence = resolveEvidence(db, report, context);
    if (!topic || Number(report.expected_version) !== Number(topic.version) || !evidence.eventIds.length) {
      results.push({ section: "topic_health", index, status: "rejected", reason: !topic ? "unknown_topic" : !evidence.eventIds.length ? "missing_evidence" : "version_mismatch" });
      continue;
    }
    const issueScope = ["claim", "topic_state", "open_loop", "epistemic_expression", "response_reasoning"].includes(report.issue_scope)
      ? report.issue_scope
      : "response_reasoning";
    const severity = ["low", "medium", "high", "critical"].includes(report.severity) ? report.severity : "medium";
    const finding = {
      issue_scope: issueScope,
      severity,
      description: cleanText(report.description, 1200),
      related_ids: asArray(report.related_ids).map(String).slice(0, 20),
      evidence_event_ids: evidence.eventIds,
    };
    const health = checkTopicHealth(db, topic.id, { trigger: "model_report", sourceRunId: context.runId, modelFindings: [finding] });
    results.push({ section: "topic_health", index, status: "recorded", health_run_id: health.id, topic_id: topic.id, recommendation: health.recommendation });
  }
  return results;
}

function collectTopicEvidence(db, topicId) {
  const familyIds = topicFamilyIds(db, topicId);
  if (!familyIds.length) return { events: [], messages: [] };
  const placeholders = familyIds.map((_, index) => `$topic${index}`).join(", ");
  const params = Object.fromEntries(familyIds.map((id, index) => [`$topic${index}`, id]));
  const events = db.all(
    `SELECT e.* FROM events e WHERE e.id IN (
       SELECT event_id FROM topic_event_links WHERE topic_id IN (${placeholders})
       UNION
       SELECT tie.event_id FROM topic_item_evidence tie
       JOIN topic_items ti ON ti.id = tie.topic_item_id
       WHERE ti.topic_id IN (${placeholders})
       UNION
       SELECT ole.event_id FROM open_loop_evidence ole
       JOIN open_loops ol ON ol.id = ole.open_loop_id
       WHERE ol.topic_id IN (${placeholders})
     ) ORDER BY e.occurred_at LIMIT 300`,
    params,
  );
  const messageIds = [...new Set(events.filter((event) => event.source_kind === "message").map((event) => event.source_id).filter(Boolean))];
  if (!messageIds.length) return { events, messages: [] };
  const messagePlaceholders = messageIds.map((_, index) => `$message${index}`).join(", ");
  const messageParams = Object.fromEntries(messageIds.map((id, index) => [`$message${index}`, id]));
  const messages = db.all(`SELECT * FROM messages WHERE id IN (${messagePlaceholders}) ORDER BY created_at`, messageParams);
  return { events, messages };
}

function applyTopicRebuildResult(db, topicId, output, { runId, allowedEventIds }) {
  const topic = resolveCanonicalTopic(db, topicId);
  const proposal = output?.topic_rebuild;
  if (!topic || !proposal || Number(proposal.expected_version) !== Number(topic.version)) {
    return { applied: false, reason: !topic ? "unknown_topic" : !proposal ? "missing_proposal" : "version_mismatch" };
  }
  const familySet = new Set(topicFamilyIds(db, topic.id));
  const allowedActiveStatuses = new Set(["active", "confirmed", "unresolved"]);
  const allowedTentativeStatuses = new Set(["tentative", "reopened"]);
  const validateIds = (values, statuses) => [...new Set(asArray(values).map(String))].filter((id) => {
    const item = db.get("SELECT topic_id, status FROM topic_items WHERE id = $id", { $id: id });
    return item && familySet.has(item.topic_id) && statuses.has(item.status);
  });
  const activeIds = validateIds(proposal.active_item_ids, allowedActiveStatuses);
  const tentativeIds = validateIds(proposal.tentative_item_ids, allowedTentativeStatuses);
  const createdItemIds = [];
  for (const [index, missing] of asArray(proposal.missing_items).entries()) {
    const content = cleanText(missing.content, 2000);
    const type = ["evolution", "decision", "rationale", "rejected_idea", "unresolved_disagreement"].includes(missing.item_type) ? missing.item_type : null;
    const eventIds = asArray(missing.source_event_ids).map(String).filter((id) => allowedEventIds.has(id));
    if (!content || !type || !eventIds.length || containsForbiddenSecret(content)) continue;
    let item = db.get(
      `SELECT * FROM topic_items WHERE topic_id = $topicId AND item_type = $type
       AND LOWER(TRIM(content)) = LOWER(TRIM($content)) LIMIT 1`,
      { $topicId: topic.id, $type: type, $content: content },
    );
    if (!item) {
      const id = crypto.randomUUID();
      const status = type === "decision" ? "tentative" : type === "rejected_idea" ? "rejected" : type === "unresolved_disagreement" ? "unresolved" : "active";
      db.db.run(
        `INSERT INTO topic_items
         (id, topic_id, item_type, content, status, epistemic_basis, confidence,
          valid_from, valid_to, continuity_value,
          continuity_score_version, continuity_components_json, source_run_id, idempotency_key, created_at, updated_at)
         VALUES ($id, $topicId, $type, $content, $status, $basis, 0.65,
          $validFrom, NULL, 0.7,
          'topic-rebuild-default-v1', '{"rebuild_default":0.7}', $runId, $key, $createdAt, $updatedAt)`,
        {
          $id: id,
          $topicId: topic.id,
          $type: type,
          $content: content,
          $status: status,
          $basis: missing.epistemic_basis === "tool_verified" && toolVerified ? "tool_verified" : "inferred",
          $validFrom: isoNow(),
          $runId: runId,
          $key: hash(`${runId}:missing:${index}:${content}`),
          $createdAt: isoNow(),
          $updatedAt: isoNow(),
        },
      );
      item = db.get("SELECT * FROM topic_items WHERE id = $id", { $id: id });
      createdItemIds.push(id);
    }
    for (const eventId of eventIds) {
      db.db.run(
        `INSERT OR IGNORE INTO topic_item_evidence
         (topic_item_id, event_id, relation, weight, created_at)
         VALUES ($itemId, $eventId, 'supports', 1, $createdAt)`,
        { $itemId: item.id, $eventId: eventId, $createdAt: isoNow() },
      );
    }
  }
  const overview = cleanText(proposal.overview, 3000) || topic.overview;
  const position = cleanText(proposal.current_position, 3000) || topic.current_position;
  const resultVersion = Number(topic.version) + 1;
  const revisionId = crypto.randomUUID();
  const operations = [{
    op: "rebuild_materialized_state",
    active_item_ids: activeIds,
    tentative_item_ids: tentativeIds,
    open_loop_assessments: asArray(proposal.open_loop_assessments),
    conflicts: asArray(proposal.conflicts),
    created_item_ids: createdItemIds,
  }];
  db.db.run(
    `INSERT INTO topic_revisions
     (id, topic_id, base_version, result_version, overview, current_position,
      operations_json, source_run_id, created_at)
     VALUES ($id, $topicId, $baseVersion, $resultVersion, $overview, $position,
      $operations, $runId, $createdAt)`,
    {
      $id: revisionId,
      $topicId: topic.id,
      $baseVersion: topic.version,
      $resultVersion: resultVersion,
      $overview: overview,
      $position: position,
      $operations: JSON.stringify(operations),
      $runId: runId,
      $createdAt: isoNow(),
    },
  );
  db.db.run(
    `UPDATE topic_threads SET overview = $overview, current_position = $position,
     active_item_ids_json = $active, tentative_item_ids_json = $tentative,
     current_revision_id = $revisionId, version = $version, last_active_at = $now WHERE id = $id`,
    {
      $id: topic.id,
      $overview: overview,
      $position: position,
      $active: JSON.stringify(activeIds),
      $tentative: JSON.stringify(tentativeIds),
      $revisionId: revisionId,
      $version: resultVersion,
      $now: isoNow(),
    },
  );
  return { applied: true, topicId: topic.id, resultVersion, revisionId, activeIds, tentativeIds, createdItemIds };
}

function governanceOutputContract() {
  return [{
    op: "add_alias|merge",
    topic_id: null,
    alias: "",
    source_topic_id: null,
    target_topic_id: null,
    expected_source_version: null,
    expected_target_version: null,
    evidence: [{ message_id: "", quote: "" }],
    source_event_ids: [],
  }];
}

function healthReportContract() {
  return [{
    topic_id: null,
    expected_version: null,
    issue_scope: "claim|topic_state|open_loop|epistemic_expression|response_reasoning",
    severity: "low|medium|high|critical",
    description: "",
    related_ids: [],
    evidence: [{ message_id: "", quote: "" }],
    source_event_ids: [],
  }];
}

module.exports = {
  applyGovernanceUpdates,
  applyHealthReports,
  applyTopicRebuildResult,
  checkTopicHealth,
  collectTopicEvidence,
  expandTopicFamily,
  findTopicByAlias,
  governanceOutputContract,
  healthReportContract,
  mergeTopics,
  normalizeAlias,
  resolveCanonicalTopic,
  synchronizeTopicMaterializedSets,
  topicFamilyIds,
};
