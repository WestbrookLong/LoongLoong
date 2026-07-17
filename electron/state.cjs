const crypto = require("node:crypto");
const { isoNow } = require("./database.cjs");
const { containsForbiddenSecret, estimateTokens } = require("./memory.cjs");
const { topicFamilyIds } = require("./topic-governance.cjs");

const STATE_TYPES = new Set(["self_model", "relationship"]);
const SELF_OPERATIONS = new Set([
  "record_user_correction",
  "set_behavior_adjustment",
  "add_failure_mode",
  "link_commitment",
  "fulfill_commitment",
]);
const RELATIONSHIP_OPERATIONS = new Set([
  "add_interaction_style",
  "add_trust_boundary",
  "add_recurring_tension",
  "resolve_tension",
]);
const SCOPE_TYPES = new Set(["global", "topic", "activity"]);

const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const asArray = (value) => (Array.isArray(value) ? value : []);
const cleanText = (value, max = 1200) => String(value || "").trim().slice(0, max);
const parseJson = (value, fallback) => {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
};
const normalizedText = (value) => cleanText(value).toLowerCase().replace(/\s+/g, " ");

function canonicalStateType(value) {
  return value === "self" ? "self_model" : cleanText(value, 40);
}

function operationText(operation) {
  return cleanText(operation.value ?? operation.text ?? operation.content, 1200);
}

function evidenceActors(evidence) {
  return new Set([
    ...asArray(evidence.messages).map((message) => message.role === "assistant" ? "agent" : "user"),
    ...asArray(evidence.events).map((event) => event.actor),
  ]);
}

function hasToolEvidence(evidence) {
  return asArray(evidence.events).some((event) => event.source_kind === "tool_receipt" || event.actor === "tool");
}

function hasDurableLanguage(evidence) {
  const source = `${asArray(evidence.messages).map((message) => message.content).join(" ")} ${asArray(evidence.events).map((event) => event.content).join(" ")}`;
  return /(?:以后|今后|长期|一直|总是|每次|不要再|别再|永远|习惯|原则|默认|from now on|going forward|always|every time|never again|as a rule|by default)/i.test(source);
}

function hasBoundaryLanguage(evidence) {
  const source = asArray(evidence.messages).map((message) => message.content).join(" ");
  return /(?:不要|不能|不允许|禁止|别再|边界|底线|隐私|do not|don't|never|must not|boundary|privacy)/i.test(source);
}

function hasRecurringLanguage(evidence) {
  const source = asArray(evidence.messages).map((message) => message.content).join(" ");
  return /(?:总是|反复|经常|多次|每次|一再|always|repeatedly|often|every time|keeps?)/i.test(source);
}

function independentEvidenceCount(evidence) {
  return new Set(asArray(evidence.events).map((event) => event.id)).size;
}

function normalizeScope(operation) {
  if (operation.scope_type && !SCOPE_TYPES.has(operation.scope_type)) return null;
  const scopeType = operation.scope_type || "global";
  const scopeId = cleanText(operation.scope_id, 160) || null;
  if (scopeType !== "global" && !scopeId) return null;
  return { scope_type: scopeType, scope_id: scopeId };
}

function entryText(entry) {
  return typeof entry === "string" ? entry : cleanText(entry?.text ?? entry?.value);
}

function scopeMatches(entry, scope) {
  if (typeof entry === "string") return scope.scope_type === "global";
  return (entry.scope_type || "global") === scope.scope_type && (entry.scope_id || null) === scope.scope_id;
}

function addOrConfirmEntry(state, field, text, scope, evidenceEventIds, extra = {}) {
  const entries = asArray(state[field]);
  const existingIndex = entries.findIndex((entry) => (
    normalizedText(entryText(entry)) === normalizedText(text) && scopeMatches(entry, scope) && (entry.status || "active") === "active"
  ));
  const now = isoNow();
  if (existingIndex >= 0) {
    const existing = typeof entries[existingIndex] === "string"
      ? { id: crypto.randomUUID(), text: entries[existingIndex], scope_type: "global", scope_id: null, status: "active", created_at: now }
      : entries[existingIndex];
    entries[existingIndex] = {
      ...existing,
      ...extra,
      evidence_event_ids: [...new Set([...asArray(existing.evidence_event_ids), ...evidenceEventIds])],
      last_confirmed_at: now,
    };
    state[field] = entries.slice(-60);
    return entries[existingIndex].id;
  }
  const entry = {
    id: crypto.randomUUID(),
    text,
    ...scope,
    status: "active",
    evidence_event_ids: evidenceEventIds,
    created_at: now,
    last_confirmed_at: now,
    ...extra,
  };
  state[field] = [...entries, entry].slice(-60);
  return entry.id;
}

function applySelfOperation(db, state, operation, evidence) {
  const op = cleanText(operation.op, 50);
  if (!SELF_OPERATIONS.has(op)) return { status: "rejected", reason: "unsupported_operation" };
  const actors = evidenceActors(evidence);
  const scope = normalizeScope(operation);
  if (!scope) return { status: "rejected", reason: "invalid_scope" };
  const text = operationText(operation);
  const eventIds = evidence.eventIds;

  if (op === "link_commitment" || op === "fulfill_commitment") {
    if (!eventIds.length) return { status: "rejected", reason: "missing_evidence" };
    const loopId = cleanText(operation.open_loop_id ?? operation.value, 160);
    const loop = db.get("SELECT * FROM open_loops WHERE id = $id", { $id: loopId });
    if (!loop || loop.loop_type !== "commitment" || loop.owner !== "agent") {
      return { status: "rejected", reason: "agent_commitment_required" };
    }
    const ids = new Set(asArray(state.unfulfilled_commitment_ids));
    if (op === "link_commitment") {
      if (loop.status !== "open") return { status: "rejected", reason: "commitment_not_open" };
      ids.add(loop.id);
    } else {
      if (loop.status !== "resolved") return { status: "rejected", reason: "commitment_not_resolved" };
      ids.delete(loop.id);
    }
    state.unfulfilled_commitment_ids = [...ids];
    return { status: "applied", open_loop_id: loop.id };
  }

  if (!text || containsForbiddenSecret(text)) return { status: "rejected", reason: "invalid_content" };
  if (!eventIds.length) return { status: "rejected", reason: "missing_evidence" };

  if (op === "record_user_correction") {
    if (!actors.has("user")) return { status: "rejected", reason: "user_evidence_required" };
    const entryId = addOrConfirmEntry(state, "user_corrections_to_agent", text, scope, eventIds, {
      target_message_id: cleanText(operation.target_message_id, 160) || null,
    });
    return { status: "applied", entry_id: entryId };
  }

  if (op === "set_behavior_adjustment") {
    if (!actors.has("user")) return { status: "rejected", reason: "user_evidence_required" };
    if (!hasDurableLanguage(evidence) && independentEvidenceCount(evidence) < 2) {
      return { status: "rejected", reason: "durability_required" };
    }
    const entryId = addOrConfirmEntry(state, "current_behavior_adjustments", text, scope, eventIds);
    return { status: "applied", entry_id: entryId };
  }

  if (op === "add_failure_mode") {
    if (!actors.has("user") && !hasToolEvidence(evidence)) return { status: "rejected", reason: "external_evidence_required" };
    if (!hasDurableLanguage(evidence) && independentEvidenceCount(evidence) < 2) {
      return { status: "rejected", reason: "durability_required" };
    }
    const entryId = addOrConfirmEntry(state, "known_failure_modes", text, scope, eventIds);
    return { status: "applied", entry_id: entryId };
  }

  return { status: "rejected", reason: "unsupported_operation" };
}

function applyRelationshipOperation(state, operation, evidence) {
  const op = cleanText(operation.op, 50);
  if (!RELATIONSHIP_OPERATIONS.has(op)) return { status: "rejected", reason: "unsupported_operation" };
  const actors = evidenceActors(evidence);
  if (!actors.has("user")) return { status: "rejected", reason: "user_evidence_required" };
  const scope = normalizeScope(operation);
  if (!scope) return { status: "rejected", reason: "invalid_scope" };
  const text = operationText(operation);
  const eventIds = evidence.eventIds;
  if (!eventIds.length) return { status: "rejected", reason: "missing_evidence" };

  if (op === "resolve_tension") {
    const targetId = cleanText(operation.target_id ?? operation.value, 160);
    const tensions = asArray(state.recurring_tensions);
    const target = tensions.find((entry) => typeof entry !== "string" && entry.id === targetId && entry.status !== "resolved");
    if (!target) return { status: "rejected", reason: "tension_not_found" };
    target.status = "resolved";
    target.resolved_at = isoNow();
    target.resolution = text || null;
    target.evidence_event_ids = [...new Set([...asArray(target.evidence_event_ids), ...eventIds])];
    state.recurring_tensions = tensions;
    return { status: "applied", entry_id: target.id };
  }

  if (!text || containsForbiddenSecret(text)) return { status: "rejected", reason: "invalid_content" };
  if (op === "add_interaction_style") {
    if (!hasDurableLanguage(evidence) && independentEvidenceCount(evidence) < 2) {
      return { status: "rejected", reason: "durability_required" };
    }
    return { status: "applied", entry_id: addOrConfirmEntry(state, "interaction_style", text, scope, eventIds) };
  }
  if (op === "add_trust_boundary") {
    if (!hasBoundaryLanguage(evidence)) return { status: "rejected", reason: "explicit_boundary_required" };
    return { status: "applied", entry_id: addOrConfirmEntry(state, "trust_boundaries", text, scope, eventIds) };
  }
  if (op === "add_recurring_tension") {
    if (!hasRecurringLanguage(evidence) && independentEvidenceCount(evidence) < 2) {
      return { status: "rejected", reason: "recurrence_required" };
    }
    return { status: "applied", entry_id: addOrConfirmEntry(state, "recurring_tensions", text, scope, eventIds) };
  }
  return { status: "rejected", reason: "unsupported_operation" };
}

function applyStateUpdates(db, updates, context, resolveEvidence) {
  const applied = [];
  for (const [index, update] of asArray(updates).entries()) {
    const stateType = canonicalStateType(update.state_type);
    if (!STATE_TYPES.has(stateType)) {
      applied.push({ section: "state", index, status: "rejected", reason: "unsupported_state_type" });
      continue;
    }
    const document = db.get("SELECT * FROM state_documents WHERE state_type = $type", { $type: stateType });
    if (!document || Number(update.expected_version) !== Number(document.version)) {
      applied.push({ section: "state", index, state_type: stateType, status: "rejected", reason: "version_mismatch" });
      continue;
    }
    const state = structuredClone(parseJson(document.current_state_json, {}));
    const operationResults = [];
    const allEventIds = new Set();
    for (const [operationIndex, operation] of asArray(update.operations).entries()) {
      const evidence = resolveEvidence(db, operation, context);
      evidence.eventIds.forEach((id) => allEventIds.add(id));
      const result = stateType === "self_model"
        ? applySelfOperation(db, state, operation, evidence)
        : applyRelationshipOperation(state, operation, evidence);
      operationResults.push({
        index: operationIndex,
        op: cleanText(operation.op, 50),
        evidence_event_ids: evidence.eventIds,
        ...result,
      });
    }
    if (!operationResults.some((result) => result.status === "applied")) {
      applied.push({ section: "state", index, state_type: stateType, status: "rejected", reason: "no_valid_operations", operations: operationResults });
      continue;
    }
    const idempotencyKey = hash(`${document.id}:${context.runId}:${JSON.stringify(operationResults)}`);
    if (db.get("SELECT id FROM state_revisions WHERE idempotency_key = $key", { $key: idempotencyKey })) {
      applied.push({ section: "state", index, state_type: stateType, status: "skipped", reason: "already_processed" });
      continue;
    }
    const revisionId = crypto.randomUUID();
    const resultVersion = Number(document.version) + 1;
    db.db.run(
      `INSERT INTO state_revisions
       (id, document_id, base_version, result_version, operations_json, resulting_state_json,
        source_run_id, idempotency_key, created_at)
       VALUES ($id, $documentId, $baseVersion, $resultVersion, $operations, $state,
        $runId, $key, $createdAt)`,
      {
        $id: revisionId,
        $documentId: document.id,
        $baseVersion: document.version,
        $resultVersion: resultVersion,
        $operations: JSON.stringify(operationResults),
        $state: JSON.stringify(state),
        $runId: context.runId,
        $key: idempotencyKey,
        $createdAt: isoNow(),
      },
    );
    for (const eventId of allEventIds) {
      db.db.run(
        `INSERT OR IGNORE INTO state_revision_evidence
         (revision_id, event_id, relation, created_at)
         VALUES ($revisionId, $eventId, 'supports', $createdAt)`,
        { $revisionId: revisionId, $eventId: eventId, $createdAt: isoNow() },
      );
    }
    db.db.run(
      `UPDATE state_documents SET current_state_json = $state, current_revision_id = $revisionId,
       version = $version, updated_at = $updatedAt WHERE id = $id`,
      {
        $id: document.id,
        $state: JSON.stringify(state),
        $revisionId: revisionId,
        $version: resultVersion,
        $updatedAt: isoNow(),
      },
    );
    applied.push({ section: "state", index, state_type: stateType, status: "updated", revision_id: revisionId, operations: operationResults });
  }
  return applied;
}

function statePromptState(db) {
  const result = {};
  for (const document of db.all("SELECT * FROM state_documents ORDER BY state_type")) {
    const state = parseJson(document.current_state_json, {});
    result[document.state_type] = {
      version: Number(document.version),
      ...(document.state_type === "self_model" ? {
        user_corrections_to_agent: asArray(state.user_corrections_to_agent).filter((item) => (item.status || "active") === "active").slice(-20),
        current_behavior_adjustments: asArray(state.current_behavior_adjustments).filter((item) => (item.status || "active") === "active").slice(-20),
        known_failure_modes: asArray(state.known_failure_modes).filter((item) => (item.status || "active") === "active").slice(-20),
        unfulfilled_commitment_ids: asArray(state.unfulfilled_commitment_ids).slice(-20),
      } : {
        interaction_style: asArray(state.interaction_style).filter((item) => (item.status || "active") === "active").slice(-20),
        trust_boundaries: asArray(state.trust_boundaries).filter((item) => (item.status || "active") === "active").slice(-20),
        recurring_tensions: asArray(state.recurring_tensions).filter((item) => (item.status || "active") !== "resolved").slice(-20),
      }),
    };
  }
  return result;
}

function scopeRelevant(entry, topicIds, activityId) {
  if (typeof entry === "string" || !entry?.scope_type || entry.scope_type === "global") return true;
  if (entry.scope_type === "topic") return topicIds.has(entry.scope_id);
  if (entry.scope_type === "activity") return Boolean(activityId && entry.scope_id === activityId);
  return false;
}

function buildStateContext(db, { mode = "text", topicId = null, activityId = null } = {}) {
  const budgets = { voice: 180, text: 450, deep: 900 };
  const maxTokens = budgets[mode] || budgets.text;
  const promptState = statePromptState(db);
  const relevantTopicIds = new Set(topicId ? topicFamilyIds(db, topicId) : []);
  const records = [];
  for (const [stateType, document] of Object.entries(promptState)) {
    for (const [field, values] of Object.entries(document)) {
      if (field === "version" || !Array.isArray(values)) continue;
      for (const value of values) {
        if (!scopeRelevant(value, relevantTopicIds, activityId)) continue;
        if (field === "unfulfilled_commitment_ids") {
          const loop = db.get("SELECT id, description, status FROM open_loops WHERE id = $id", { $id: value });
          if (loop?.status === "open") records.push({ state_type: stateType, field, ...loop });
        } else {
          records.push({ state_type: stateType, field, ...(typeof value === "string" ? { text: value } : value) });
        }
      }
    }
  }
  let body = "";
  for (const record of records.slice(-40)) {
    const line = `${JSON.stringify(record)}\n`;
    if (estimateTokens(body + line) > maxTokens) break;
    body += line;
  }
  const context = body
    ? `<agent_state_context untrusted="true">\n${body}<state_caveat>这些状态仅用于约束 Agent 行为，不得据此宣称用户信任、亲密或具有某种心理状态。</state_caveat>\n</agent_state_context>`
    : "";
  return { context, tokenEstimate: estimateTokens(context), state: promptState };
}

function stateUpdateContract() {
  return [{
    state_type: "self_model|relationship",
    expected_version: null,
    operations: [{
      op: "record_user_correction|set_behavior_adjustment|add_failure_mode|link_commitment|fulfill_commitment|add_interaction_style|add_trust_boundary|add_recurring_tension|resolve_tension",
      value: "",
      target_id: null,
      target_message_id: null,
      open_loop_id: null,
      scope_type: "global|topic|activity",
      scope_id: null,
      evidence: [{ message_id: "", quote: "" }],
      source_event_ids: [],
    }],
  }];
}

module.exports = {
  applyStateUpdates,
  buildStateContext,
  statePromptState,
  stateUpdateContract,
};
