const crypto = require("node:crypto");
const { isoNow } = require("./database.cjs");

const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, Number(value) || 0));
const clean = (value, max = 1000) => String(value || "").trim().slice(0, max);
const asArray = (value) => (Array.isArray(value) ? value : []);
const hash = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
const normalizePart = (value, fallback = "unknown") => clean(value || fallback, 160).toLowerCase().replace(/\s+/g, "_");
const normalizeCardinality = (value) => ["set", "multi"].includes(String(value || "").toLowerCase()) ? "set" : "single";
const normalizeTemporalMode = (value) => ["event", "atemporal"].includes(String(value || "").toLowerCase())
  ? String(value).toLowerCase()
  : "current_state";

function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function slotKey({ namespace, scopeType, scopeId, subject, predicate }) {
  return [
    normalizePart(namespace, "user"),
    normalizePart(scopeType, "global"),
    normalizePart(scopeId, "global"),
    normalizePart(subject, "user"),
    normalizePart(predicate, "fact"),
  ].join(":");
}

function queryTerms(text) {
  return [...new Set(String(text || "").toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) || [])];
}

function lexicalScore(text, terms) {
  if (!terms.length) return 0;
  const haystack = String(text || "").toLowerCase();
  return terms.filter((term) => haystack.includes(term)).length / terms.length;
}

function recallClaimSlots(db, text, limit = 12) {
  const terms = queryTerms(text);
  const slots = db.all(
    `SELECT * FROM claim_slots WHERE status = 'active'
     ORDER BY updated_at DESC LIMIT 120`,
  );
  return slots
    .map((slot) => {
      const claims = db.all(
        `SELECT id, canonical_text, value_hash, status, temporal_state, confidence,
                epistemic_basis, valid_from, valid_to, asserted_at
         FROM memory_claims WHERE slot_id = $slotId
           AND status IN ('active', 'candidate', 'disputed')
         ORDER BY CASE temporal_state WHEN 'current' THEN 0 WHEN 'historical' THEN 1 ELSE 2 END,
                  valid_from DESC, updated_at DESC LIMIT 8`,
        { $slotId: slot.id },
      );
      const searchable = `${slot.subject} ${slot.predicate} ${claims.map((claim) => claim.canonical_text).join(" ")}`;
      const score = lexicalScore(searchable, terms) + (claims.some((claim) => claim.temporal_state === "current") ? 0.08 : 0);
      return {
        id: slot.id,
        version: Number(slot.version),
        namespace: slot.namespace,
        subject: slot.subject,
        predicate: slot.predicate,
        scope_type: slot.scope_type,
        scope_id: slot.scope_id,
        cardinality: slot.cardinality,
        temporal_mode: slot.temporal_mode,
        claims,
        score,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score, ...slot }) => slot);
}

function resolveOrCreateSlot(db, candidate, { allowedSlotIds = [] } = {}) {
  const proposal = candidate.slot_resolution || {};
  const proposedNew = proposal.new_slot || {};
  const namespace = clean(proposedNew.namespace || candidate.namespace || "user", 60);
  const subject = clean(proposedNew.subject || candidate.subject || "user", 160);
  const predicate = clean(proposedNew.predicate || candidate.predicate || candidate.claim_type || "fact", 160);
  const scopeType = clean(proposedNew.scope_type || candidate.scope_type || candidate.scope || "global", 60);
  const scopeId = clean(proposedNew.scope_id || candidate.scope_id, 160) || null;
  const canonicalKey = slotKey({ namespace, scopeType, scopeId, subject, predicate });
  const exactText = clean(candidate.canonical_text || candidate.text, 1000);
  const textMatch = exactText
    ? db.get(
      `SELECT s.* FROM memory_claims c JOIN claim_slots s ON s.id = c.slot_id
       WHERE LOWER(TRIM(c.canonical_text)) = LOWER(TRIM($text))
       ORDER BY CASE c.status WHEN 'active' THEN 0 ELSE 1 END, c.updated_at DESC LIMIT 1`,
      { $text: exactText },
    )
    : null;
  if (textMatch) return { slot: textMatch, created: false };

  if (proposal.action === "reuse_slot" && proposal.slot_id) {
    const allowed = !allowedSlotIds.length || allowedSlotIds.includes(String(proposal.slot_id));
    const selected = allowed
      ? db.get("SELECT * FROM claim_slots WHERE id = $id AND status = 'active'", { $id: String(proposal.slot_id) })
      : null;
    if (selected) {
      if (proposal.expected_version != null && Number(proposal.expected_version) !== Number(selected.version)) {
        return { rejected: true, reason: "slot_version_conflict" };
      }
      return { slot: selected, created: false };
    }
    return { rejected: true, reason: "invalid_slot_reference" };
  }

  const exact = db.get("SELECT * FROM claim_slots WHERE canonical_key = $key", { $key: canonicalKey });
  if (exact) return { slot: exact, created: false };

  if (proposal.action === "create_slot" && Number(proposal.confidence || 0) < 0.75) {
    return { rejected: true, reason: "insufficient_slot_novelty_confidence" };
  }
  const now = isoNow();
  const id = `slot_${hash(canonicalKey).slice(0, 24)}`;
  const cardinality = normalizeCardinality(proposedNew.cardinality || candidate.cardinality);
  const temporalMode = normalizeTemporalMode(proposedNew.temporal_mode || candidate.temporal_mode);
  db.db.run(
    `INSERT OR IGNORE INTO claim_slots
     (id, namespace, subject, predicate, scope_type, scope_id, canonical_key,
      cardinality, temporal_mode, status, version, created_at, updated_at)
     VALUES ($id, $namespace, $subject, $predicate, $scopeType, $scopeId, $key,
      $cardinality, $temporalMode, 'active', 1, $now, $now)`,
    {
      $id: id,
      $namespace: namespace,
      $subject: subject,
      $predicate: predicate,
      $scopeType: scopeType,
      $scopeId: scopeId,
      $key: canonicalKey,
      $cardinality: cardinality,
      $temporalMode: temporalMode,
      $now: now,
    },
  );
  return { slot: db.get("SELECT * FROM claim_slots WHERE canonical_key = $key", { $key: canonicalKey }), created: true };
}

function addEvidence(db, claimId, evidenceEventIds, weight, now) {
  for (const eventId of new Set(evidenceEventIds)) {
    if (!db.get("SELECT id FROM events WHERE id = $id", { $id: eventId })) continue;
    db.db.run(
      `INSERT OR IGNORE INTO memory_evidence (claim_id, event_id, relation, weight, created_at)
       VALUES ($claimId, $eventId, 'supports', $weight, $now)`,
      { $claimId: claimId, $eventId: eventId, $weight: weight, $now: now },
    );
  }
}

function addTransition(db, { slotId, fromClaimId = null, toClaimId = null, type, effectiveAt = null, temporalBasis, runId, evidenceEventIds, metadata = {} }) {
  const id = crypto.randomUUID();
  const now = isoNow();
  db.db.run(
    `INSERT INTO claim_transitions
     (id, slot_id, from_claim_id, to_claim_id, transition_type, effective_at,
      temporal_basis, source_run_id, metadata_json, created_at)
     VALUES ($id, $slotId, $fromId, $toId, $type, $effectiveAt,
      $temporalBasis, $runId, $metadata, $now)`,
    {
      $id: id,
      $slotId: slotId,
      $fromId: fromClaimId,
      $toId: toClaimId,
      $type: type,
      $effectiveAt: effectiveAt,
      $temporalBasis: temporalBasis || "unknown",
      $runId: runId || null,
      $metadata: JSON.stringify(metadata),
      $now: now,
    },
  );
  for (const eventId of new Set(evidenceEventIds || [])) {
    if (!db.get("SELECT id FROM events WHERE id = $id", { $id: eventId })) continue;
    db.db.run(
      "INSERT OR IGNORE INTO claim_transition_evidence (transition_id, event_id, relation, created_at) VALUES ($transitionId, $eventId, 'supports', $now)",
      { $transitionId: id, $eventId: eventId, $now: now },
    );
  }
  return id;
}

function normalizedRelation(candidate, slot) {
  const proposal = candidate.value_resolution || {};
  const raw = clean(proposal.relation || candidate.relation || candidate.relation_to_existing, 40).toLowerCase();
  const map = {
    same_as: "same_value",
    supports: "same_value",
    related_to: "",
    contradicts: "unresolved_conflict",
    refines: "refinement",
  };
  const normalized = map[raw] ?? raw;
  const allowed = new Set(["same_value", "coexist", "temporal_update", "correction", "unresolved_conflict", "refinement"]);
  if (allowed.has(normalized) && Number(proposal.confidence ?? candidate.confidence ?? 0) >= 0.65) return normalized;
  if (slot.cardinality === "set") return "coexist";
  return "unresolved_conflict";
}

function groundedRelation(db, relation, evidenceEventIds, temporal, epistemicBasis) {
  if (!["correction", "temporal_update"].includes(relation)) return relation;
  const ids = [...new Set(evidenceEventIds || [])];
  if (!ids.length) return "unresolved_conflict";
  const params = Object.fromEntries(ids.map((id, index) => [`$id${index}`, id]));
  const placeholders = ids.map((_, index) => `$id${index}`).join(", ");
  const rows = db.all(
    `SELECT e.event_type, e.content, COALESCE(GROUP_CONCAT(m.content, ' '), '') AS source_text
     FROM events e
     LEFT JOIN event_sources es ON es.event_id = e.id
     LEFT JOIN messages m ON m.id = es.message_id
     WHERE e.id IN (${placeholders}) GROUP BY e.id`,
    params,
  );
  const evidenceText = rows.map((row) => `${row.event_type} ${row.content} ${row.source_text}`).join(" ");
  if (relation === "correction") {
    const validBasis = ["stated_by_user", "mutually_confirmed", "tool_verified"].includes(epistemicBasis);
    const correctionCue = /(?:correction|corrected|actually|mistake|not .{0,40} but|更正|纠正|记错|说错|不是.{0,20}(?:而是|是))/i.test(evidenceText);
    return validBasis && correctionCue ? relation : "unresolved_conflict";
  }
  const explicitTime = temporal.basis === "explicit" && Boolean(temporal.validFrom) && temporal.confidence >= 0.7;
  const changeCue = /(?:now|currently|moved|changed|since|from now|no longer|现在|目前|已经|搬|改成|不再|从.{0,20}开始)/i.test(evidenceText);
  const anchoredNow = temporal.basis === "message_time_assumption" && temporal.confidence >= 0.5 && changeCue;
  return explicitTime || anchoredNow ? relation : "unresolved_conflict";
}

function temporalDetails(candidate, slot, assertedAt) {
  const proposal = candidate.temporal || {};
  const validFrom = parseDate(proposal.valid_from || candidate.valid_from);
  const validTo = parseDate(proposal.valid_to || candidate.valid_to);
  const basis = clean(proposal.basis || candidate.temporal_basis || (validFrom ? "explicit" : "message_time_assumption"), 40);
  const precision = clean(proposal.precision || candidate.temporal_precision || (validFrom ? "exact" : "unknown"), 20);
  const confidence = clamp(proposal.confidence ?? candidate.temporal_confidence ?? (validFrom ? 0.9 : 0.55));
  const currentHint = String(proposal.current ?? "unknown").toLowerCase();
  const now = isoNow();
  let state = "unknown";
  if (validFrom && validFrom > now) state = "future";
  else if (validTo && validTo <= now) state = "historical";
  else if (currentHint === "false") state = "historical";
  else if (currentHint === "true" || slot.temporal_mode === "atemporal" || basis === "message_time_assumption") state = "current";
  return {
    validFrom: validFrom || (state === "current" ? assertedAt : null),
    validTo,
    basis,
    precision,
    confidence,
    state,
  };
}

function insertClaim(db, candidate, slot, details) {
  const id = crypto.randomUUID();
  const now = isoNow();
  db.db.run(
    `INSERT INTO memory_claims
     (id, namespace, claim_type, subject, predicate, object_json, canonical_text,
      scope_type, scope_id, claim_key, value_hash, cardinality, status, confidence,
      importance, stability, promotion_score, epistemic_basis, sensitivity, slot_id,
      temporal_state, asserted_at, temporal_basis, temporal_precision, temporal_confidence,
      valid_from, valid_to, last_confirmed_at, review_after, created_at, updated_at)
     VALUES ($id, $namespace, $claimType, $subject, $predicate, $objectJson, $canonicalText,
      $scopeType, $scopeId, $claimKey, $valueHash, $cardinality, 'candidate', $confidence,
      $importance, $stability, $promotionScore, $epistemicBasis, 'private', $slotId,
      $temporalState, $assertedAt, $temporalBasis, $temporalPrecision, $temporalConfidence,
      $validFrom, $validTo, $lastConfirmedAt, $reviewAfter, $now, $now)`,
    {
      $id: id,
      $namespace: slot.namespace,
      $claimType: clean(candidate.claim_type || candidate.type || "fact", 60),
      $subject: slot.subject,
      $predicate: slot.predicate,
      $objectJson: JSON.stringify({ value: details.value, source_run_id: details.runId, explicit: details.explicit, epistemic_basis: details.epistemicBasis }),
      $canonicalText: details.canonicalText,
      $scopeType: slot.scope_type,
      $scopeId: slot.scope_id,
      $claimKey: slot.canonical_key,
      $valueHash: details.valueHash,
      $cardinality: slot.cardinality,
      $confidence: details.confidence,
      $importance: details.importance,
      $stability: details.stability,
      $promotionScore: details.promotionScore,
      $epistemicBasis: details.epistemicBasis,
      $slotId: slot.id,
      $temporalState: details.temporal.state,
      $assertedAt: details.assertedAt,
      $temporalBasis: details.temporal.basis,
      $temporalPrecision: details.temporal.precision,
      $temporalConfidence: details.temporal.confidence,
      $validFrom: details.temporal.validFrom,
      $validTo: details.temporal.validTo,
      $lastConfirmedAt: details.assertedAt,
      $reviewAfter: clean(candidate.review_after, 50) || null,
      $now: now,
    },
  );
  return id;
}

function applyClaimProposal(db, candidate, options = {}) {
  const canonicalText = clean(candidate.canonical_text || candidate.text, 1000);
  if (!canonicalText || !asArray(options.evidenceEventIds).length) return { rejected: true, reason: "missing_text_or_evidence" };
  const resolved = resolveOrCreateSlot(db, candidate, options);
  if (resolved.rejected) return resolved;
  const slot = resolved.slot;
  const value = candidate.value ?? canonicalText;
  const valueHash = hash(JSON.stringify(value).toLowerCase());
  const assertedAt = parseDate(options.assertedAt) || isoNow();
  const confidence = clamp(options.confidence ?? candidate.confidence ?? 0.75);
  const importance = clamp(options.importance ?? candidate.importance ?? 0.6);
  const stability = clamp(options.stability ?? candidate.stability ?? 0.6);
  const explicit = options.explicit ?? candidate.explicit === true;
  const epistemicBasis = clean(options.epistemicBasis || candidate.epistemic_basis || "unknown_legacy", 40);
  const promotionScore = clamp(options.promotionScore ?? (0.45 * confidence + 0.3 * importance + 0.2 * stability + (explicit ? 0.05 : 0)));
  const eligible = explicit && confidence >= 0.78 && promotionScore >= 0.72
    && !["inferred", "unknown_legacy"].includes(epistemicBasis);
  const temporal = temporalDetails(candidate, slot, assertedAt);
  const evidenceEventIds = asArray(options.evidenceEventIds).map(String);
  const existingSame = db.get(
    `SELECT * FROM memory_claims WHERE slot_id = $slotId AND value_hash = $valueHash
       AND status IN ('candidate', 'active', 'disputed')
     ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'disputed' THEN 1 ELSE 2 END, updated_at DESC LIMIT 1`,
    { $slotId: slot.id, $valueHash: valueHash },
  );
  if (existingSame) {
    const now = isoNow();
    db.db.run(
      `UPDATE memory_claims SET confidence = MIN(0.99, MAX(confidence, $confidence) + 0.03),
       importance = MAX(importance, $importance), promotion_score = MAX(promotion_score, $score),
       last_confirmed_at = $assertedAt, asserted_at = MAX(COALESCE(asserted_at, ''), $assertedAt),
       updated_at = $now, version = version + 1 WHERE id = $id`,
      { $id: existingSame.id, $confidence: confidence, $importance: importance, $score: promotionScore, $assertedAt: assertedAt, $now: now },
    );
    addEvidence(db, existingSame.id, evidenceEventIds, confidence, now);
    const repeatedRelation = groundedRelation(
      db,
      normalizedRelation(candidate, slot),
      evidenceEventIds,
      temporal,
      epistemicBasis,
    );
    if (existingSame.status === "disputed" && eligible && repeatedRelation === "correction") {
      const competing = db.all(
        `SELECT id FROM memory_claims WHERE slot_id = $slotId AND id != $id
           AND status = 'disputed' AND value_hash != $valueHash`,
        { $slotId: slot.id, $id: existingSame.id, $valueHash: valueHash },
      );
      for (const claim of competing) {
        db.db.run(
          "UPDATE memory_claims SET status = 'superseded', temporal_state = 'unknown', superseded_by = $winnerId, supersession_reason = 'correction', updated_at = $now WHERE id = $id",
          { $id: claim.id, $winnerId: existingSame.id, $now: now },
        );
        addTransition(db, {
          slotId: slot.id,
          fromClaimId: claim.id,
          toClaimId: existingSame.id,
          type: "corrected_by",
          effectiveAt: temporal.validFrom || assertedAt,
          temporalBasis: temporal.basis,
          runId: options.runId,
          evidenceEventIds,
          metadata: { resolution: "reconfirmed_existing_value" },
        });
      }
      db.db.run(
        "UPDATE memory_claims SET status = 'active', temporal_state = 'current', supersession_reason = NULL, updated_at = $now WHERE id = $id",
        { $id: existingSame.id, $now: now },
      );
      return { claimId: existingSame.id, slotId: slot.id, action: "corrected_conflict" };
    }
    addTransition(db, {
      slotId: slot.id,
      fromClaimId: existingSame.id,
      toClaimId: existingSame.id,
      type: "confirmed_again",
      effectiveAt: assertedAt,
      temporalBasis: temporal.basis,
      runId: options.runId,
      evidenceEventIds,
    });
    return { claimId: existingSame.id, slotId: slot.id, action: "confirmed_again" };
  }

  const claimId = insertClaim(db, candidate, slot, {
    value,
    valueHash,
    canonicalText,
    assertedAt,
    confidence,
    importance,
    stability,
    promotionScore,
    explicit,
    epistemicBasis,
    temporal,
    runId: options.runId,
  });
  addEvidence(db, claimId, evidenceEventIds, confidence, isoNow());

  const currentClaims = db.all(
    `SELECT * FROM memory_claims WHERE slot_id = $slotId AND id != $id
       AND status = 'active' AND temporal_state = 'current'
     ORDER BY valid_from DESC, asserted_at DESC, updated_at DESC`,
    { $slotId: slot.id, $id: claimId },
  );
  const disputedClaims = db.all(
    `SELECT * FROM memory_claims WHERE slot_id = $slotId AND id != $id
       AND status = 'disputed'
     ORDER BY asserted_at DESC, updated_at DESC`,
    { $slotId: slot.id, $id: claimId },
  );
  if (!eligible || temporal.state === "future") {
    return { claimId, slotId: slot.id, action: temporal.state === "future" ? "future_candidate" : "candidate" };
  }
  const targetIds = new Set(asArray(candidate.value_resolution?.target_claim_ids || candidate.linked_claim_ids).map(String));
  const proposedRelation = normalizedRelation(candidate, slot);
  const relation = groundedRelation(db, proposedRelation, evidenceEventIds, temporal, epistemicBasis);
  const peers = currentClaims.length ? currentClaims : disputedClaims;
  if (!peers.length) {
    db.db.run("UPDATE memory_claims SET status = 'active', updated_at = $now WHERE id = $id", { $id: claimId, $now: isoNow() });
    return { claimId, slotId: slot.id, action: temporal.state === "historical" ? "historical_assertion" : "activated" };
  }

  const target = peers.find((claim) => targetIds.has(claim.id)) || peers[0];
  const now = isoNow();
  const transition = (type, metadata = {}) => addTransition(db, {
    slotId: slot.id,
    fromClaimId: target.id,
    toClaimId: claimId,
    type,
    effectiveAt: temporal.validFrom || assertedAt,
    temporalBasis: temporal.basis,
    runId: options.runId,
    evidenceEventIds,
    metadata,
  });

  if (relation === "coexist" && slot.cardinality === "set") {
    db.db.run("UPDATE memory_claims SET status = 'active', temporal_state = 'current', updated_at = $now WHERE id = $id", { $id: claimId, $now: now });
    transition("coexists_with");
    return { claimId, slotId: slot.id, action: "coexist" };
  }

  if (relation === "correction") {
    db.db.run(
      "UPDATE memory_claims SET status = 'superseded', temporal_state = 'unknown', superseded_by = $newId, supersession_reason = 'correction', updated_at = $now WHERE id = $oldId",
      { $oldId: target.id, $newId: claimId, $now: now },
    );
    db.db.run("UPDATE memory_claims SET status = 'active', temporal_state = 'current', updated_at = $now WHERE id = $id", { $id: claimId, $now: now });
    transition("corrected_by");
    return { claimId, slotId: slot.id, action: "corrected" };
  }

  if (relation === "refinement") {
    db.db.run(
      "UPDATE memory_claims SET status = 'superseded', temporal_state = 'unknown', superseded_by = $newId, supersession_reason = 'refinement', updated_at = $now WHERE id = $oldId",
      { $oldId: target.id, $newId: claimId, $now: now },
    );
    db.db.run("UPDATE memory_claims SET status = 'active', temporal_state = 'current', updated_at = $now WHERE id = $id", { $id: claimId, $now: now });
    transition("refined_by");
    return { claimId, slotId: slot.id, action: "refined" };
  }

  if (relation === "temporal_update") {
    const effectiveAt = temporal.validFrom || assertedAt;
    const targetStart = parseDate(target.valid_from);
    const isOlderAssertion = targetStart && effectiveAt < targetStart && temporal.basis !== "message_time_assumption";
    if (isOlderAssertion || temporal.state === "historical") {
      db.db.run(
        "UPDATE memory_claims SET status = 'active', temporal_state = 'historical', valid_to = COALESCE(valid_to, $targetStart), updated_at = $now WHERE id = $id",
        { $id: claimId, $targetStart: targetStart, $now: now },
      );
      transition("transitioned_to", { direction: "historical_backfill", current_claim_id: target.id });
      return { claimId, slotId: slot.id, action: "historical_backfill" };
    }
    db.db.run(
      "UPDATE memory_claims SET temporal_state = 'historical', valid_to = $effectiveAt, updated_at = $now WHERE id = $oldId",
      { $oldId: target.id, $effectiveAt: effectiveAt, $now: now },
    );
    db.db.run(
      "UPDATE memory_claims SET status = 'active', temporal_state = 'current', valid_from = $effectiveAt, updated_at = $now WHERE id = $id",
      { $id: claimId, $effectiveAt: effectiveAt, $now: now },
    );
    transition("transitioned_to");
    return { claimId, slotId: slot.id, action: "temporal_update" };
  }

  db.db.run(
    "UPDATE memory_claims SET status = 'disputed', temporal_state = 'unknown', supersession_reason = 'unresolved_conflict', updated_at = $now WHERE id IN ($newId, $oldId)",
    { $newId: claimId, $oldId: target.id, $now: now },
  );
  transition("conflicts_with", { proposed_relation: proposedRelation, reduced_relation: relation });
  return { claimId, slotId: slot.id, action: "disputed" };
}

function reduceExistingCandidate(db, claimId, options = {}) {
  const claim = db.get("SELECT * FROM memory_claims WHERE id = $id", { $id: claimId });
  if (!claim || claim.status !== "candidate") return { skipped: true };
  if (Number(claim.promotion_score) < 0.72 || ["inferred", "unknown_legacy"].includes(claim.epistemic_basis)) {
    return { skipped: true, reason: "not_promotable" };
  }
  const current = db.get(
    `SELECT * FROM memory_claims WHERE slot_id = $slotId AND id != $id
       AND status = 'active' AND temporal_state = 'current' ORDER BY updated_at DESC LIMIT 1`,
    { $slotId: claim.slot_id, $id: claim.id },
  );
  if (!current) {
    db.db.run("UPDATE memory_claims SET status = 'active', temporal_state = CASE WHEN temporal_state = 'unknown' THEN 'current' ELSE temporal_state END, updated_at = $now WHERE id = $id", { $id: claim.id, $now: isoNow() });
    return { claimId: claim.id, action: "activated" };
  }
  db.db.run(
    "UPDATE memory_claims SET status = 'disputed', temporal_state = 'unknown', supersession_reason = 'unresolved_conflict', updated_at = $now WHERE id IN ($newId, $oldId)",
    { $newId: claim.id, $oldId: current.id, $now: isoNow() },
  );
  return { claimId: claim.id, action: "disputed" };
}

module.exports = {
  applyClaimProposal,
  recallClaimSlots,
  reduceExistingCandidate,
  resolveOrCreateSlot,
  slotKey,
};
