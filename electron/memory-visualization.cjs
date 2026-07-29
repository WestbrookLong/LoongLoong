const crypto = require("node:crypto");
const { isoNow } = require("./database.cjs");
const { applyClaimProposal } = require("./claim-governance.cjs");

const parseJson = (value, fallback = {}) => {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
};

const asArray = (value) => Array.isArray(value) ? value : [];
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, Number(value) || 0));
const clean = (value, max = 1200) => String(value || "").trim().slice(0, max);
const visualId = (type, id) => `${type}:${id}`;

function splitVisualId(value) {
  const text = String(value || "");
  const index = text.indexOf(":");
  return index > 0 ? { type: text.slice(0, index), id: text.slice(index + 1) } : { type: "", id: text };
}

function placeholders(values, prefix = "id") {
  return {
    sql: values.map((_, index) => `$${prefix}${index}`).join(", "),
    params: Object.fromEntries(values.map((value, index) => [`$${prefix}${index}`, value])),
  };
}

function rowsByIds(db, table, ids, columns = "*") {
  if (!ids.length) return [];
  const list = placeholders(ids);
  return db.all(`SELECT ${columns} FROM ${table} WHERE id IN (${list.sql})`, list.params);
}

function claimCategory(row) {
  const text = `${row.claim_type || ""} ${row.predicate || ""}`.toLowerCase();
  if (/(prefer|like|dislike|偏好|喜欢|讨厌)/.test(text)) return "preferences";
  if (/(goal|plan|objective|目标|计划|想要)/.test(text)) return "goals";
  if (/(constraint|boundary|rule|要求|约束|边界)/.test(text)) return "constraints";
  if (/(habit|routine|习惯|规律)/.test(text)) return "habits";
  return "facts";
}

function policyLookup(db) {
  return new Map(db.all("SELECT * FROM memory_object_policies")
    .map((row) => [visualId(row.object_type, row.object_id), row]));
}

function currentClaimAt(row, asOf = null) {
  const point = asOf ? new Date(asOf).toISOString() : isoNow();
  const start = row.valid_from || row.asserted_at || row.created_at;
  if (start && start > point) return false;
  if (row.valid_to && row.valid_to <= point) return false;
  if (!asOf) return ["active", "disputed", "candidate"].includes(row.status);
  if (row.status === "rejected") return false;
  if (row.status === "superseded" && row.temporal_state !== "historical" && row.updated_at <= point) return false;
  return true;
}

function topicAt(db, row, asOf = null) {
  if (!asOf) return row;
  const revision = db.get(
    `SELECT * FROM topic_revisions WHERE topic_id = $id AND created_at <= $asOf
     ORDER BY created_at DESC LIMIT 1`,
    { $id: row.id, $asOf: new Date(asOf).toISOString() },
  );
  return revision
    ? { ...row, overview: revision.overview, current_position: revision.current_position, version: revision.result_version }
    : row;
}

function getMemoryOverview(db, { asOf = null } = {}) {
  const policies = policyLookup(db);
  const claims = db.all(
    `SELECT c.*, s.predicate AS slot_predicate FROM memory_claims c
     LEFT JOIN claim_slots s ON s.id = c.slot_id
     WHERE c.status != 'rejected'
     ORDER BY c.importance DESC, c.updated_at DESC`,
  ).filter((row) => currentClaimAt(row, asOf))
    .map((row) => ({ ...row, hidden: policies.get(visualId("claim", row.id))?.surface_policy === "do_not_surface" }));
  const visibleClaims = claims.filter((row) => !row.hidden);
  const groupedClaims = { facts: [], preferences: [], goals: [], constraints: [], habits: [] };
  for (const claim of visibleClaims) groupedClaims[claimCategory(claim)].push(claim);

  const topics = db.all(
    `SELECT t.*, COUNT(DISTINCT ti.id) AS item_count,
            COUNT(DISTINCT CASE WHEN ol.status = 'open' THEN ol.id END) AS open_loop_count
     FROM topic_threads t
     LEFT JOIN topic_items ti ON ti.topic_id = t.id
     LEFT JOIN open_loops ol ON ol.topic_id = t.id
     WHERE t.status NOT IN ('archived', 'merged') AND t.canonical_topic_id IS NULL
     GROUP BY t.id ORDER BY t.last_active_at DESC LIMIT 12`,
  ).filter((row) => !asOf || row.created_at <= new Date(asOf).toISOString())
    .map((row) => topicAt(db, row, asOf));
  const openLoops = db.all(
    `SELECT ol.*, t.title AS topic_title FROM open_loops ol
     LEFT JOIN topic_threads t ON t.id = ol.topic_id
     WHERE ol.status = 'open' ORDER BY ol.priority DESC, ol.last_touched_at DESC LIMIT 20`,
  ).filter((row) => {
    if (!asOf) return true;
    const point = new Date(asOf).toISOString();
    return row.created_at <= point && (!row.resolved_at || row.resolved_at > point);
  }).map((row) => asOf ? { ...row, status: "open", resolved_at: null } : row);
  const days = db.all(
    `SELECT j.local_date, j.summary, COUNT(e.id) AS event_count
     FROM journal_days j LEFT JOIN events e ON e.journal_day_id = j.id
     GROUP BY j.id ORDER BY j.local_date DESC LIMIT 84`,
  ).reverse();
  const states = db.all("SELECT * FROM state_documents ORDER BY state_type")
    .map((row) => ({ ...row, state: parseJson(row.current_state_json, {}) }));
  const governance = db.all(
    "SELECT * FROM memory_governance_actions ORDER BY created_at DESC LIMIT 16",
  );
  const transitions = db.all(
    `SELECT t.*, old.canonical_text AS from_text, next.canonical_text AS to_text
     FROM claim_transitions t
     LEFT JOIN memory_claims old ON old.id = t.from_claim_id
     LEFT JOIN memory_claims next ON next.id = t.to_claim_id
     ORDER BY t.created_at DESC LIMIT 16`,
  );
  const recentChanges = [
    ...governance.map((row) => ({ id: row.id, kind: "governance", action: row.action, status: row.status,
      objectType: row.object_type, objectId: row.object_id, text: row.reason || row.action, createdAt: row.created_at })),
    ...transitions.map((row) => ({ id: row.id, kind: "transition", action: row.transition_type, status: "complete",
      objectType: "claim", objectId: row.to_claim_id || row.from_claim_id,
      text: [row.from_text, row.to_text].filter(Boolean).join(" → "), createdAt: row.created_at })),
  ].sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))).slice(0, 18);
  const pendingNeighbors = Number(db.get(
    "SELECT COUNT(*) AS count FROM claim_neighbor_candidates WHERE status IN ('pending_model', 'pending_review', 'failed')",
  )?.count || 0);
  const hidden = Number(db.get(
    "SELECT COUNT(*) AS count FROM memory_object_policies WHERE surface_policy = 'do_not_surface'",
  )?.count || 0);
  return {
    generatedAt: isoNow(),
    asOf,
    stats: {
      currentClaims: visibleClaims.filter((row) => row.status === "active" && row.temporal_state === "current").length,
      disputedClaims: visibleClaims.filter((row) => row.status === "disputed").length,
      candidateClaims: visibleClaims.filter((row) => row.status === "candidate").length,
      activeTopics: topics.filter((row) => row.status === "open").length,
      openLoops: openLoops.length,
      hidden,
      pendingNeighbors,
    },
    groupedClaims: Object.fromEntries(Object.entries(groupedClaims).map(([key, rows]) => [key, rows.slice(0, 12)])),
    topics,
    openLoops,
    days,
    states,
    recentChanges,
    reviewQueue: visibleClaims.filter((row) => ["disputed", "candidate"].includes(row.status)).slice(0, 24),
  };
}

function addNode(nodes, node) {
  if (!node?.id || nodes.has(node.id)) return;
  nodes.set(node.id, node);
}

function addEdge(edges, edge) {
  if (!edge?.source || !edge?.target || edge.source === edge.target) return;
  const id = edge.id || `${edge.type}:${edge.source}:${edge.target}`;
  if (!edges.has(id)) edges.set(id, { ...edge, id });
}

function getMemoryGraph(db, {
  focusId = "identity:user",
  depth = 2,
  mode = "local",
  includeSimilarity = false,
  includeRetrieval = false,
  asOf = null,
  limit = 450,
} = {}) {
  const nodes = new Map();
  const edges = new Map();
  const policies = policyLookup(db);
  addNode(nodes, { id: "identity:user", rawId: "user", type: "identity", label: "关于你", summary: "Pet 对用户形成的长期记忆", status: "active", synthetic: true });
  addNode(nodes, { id: "identity:pet", rawId: "pet", type: "identity", label: "Pet", summary: "Agent 的行为调整与持续状态", status: "active", synthetic: true });

  const slots = db.all("SELECT * FROM claim_slots WHERE status = 'active'");
  for (const slot of slots) addNode(nodes, {
    id: visualId("slot", slot.id), rawId: slot.id, type: "slot", label: slot.predicate,
    summary: `${slot.subject} · ${slot.cardinality}`, status: slot.status, date: slot.updated_at, meta: slot,
  });
  const claims = db.all("SELECT * FROM memory_claims WHERE status != 'rejected' ORDER BY updated_at DESC")
    .filter((row) => currentClaimAt(row, asOf) || mode === "local");
  for (const claim of claims) {
    const policy = policies.get(visualId("claim", claim.id));
    if (policy?.surface_policy === "do_not_surface" && mode !== "developer") continue;
    addNode(nodes, {
      id: visualId("claim", claim.id), rawId: claim.id, type: "claim", label: claim.canonical_text,
      summary: claim.predicate, status: claim.status, temporalState: claim.temporal_state,
      epistemicBasis: claim.epistemic_basis, confidence: Number(claim.confidence),
      start: claim.valid_from || claim.asserted_at || claim.created_at, end: claim.valid_to,
      date: claim.updated_at, hidden: policy?.surface_policy === "do_not_surface", meta: claim,
    });
    if (claim.slot_id) addEdge(edges, {
      source: visualId("claim", claim.id), target: visualId("slot", claim.slot_id), type: "instance_of", label: "属于事实槽",
    });
    const identity = String(claim.subject || "").toLowerCase().includes("agent") ? "identity:pet" : "identity:user";
    addEdge(edges, { source: visualId("claim", claim.id), target: identity, type: "describes", label: "描述" });
    if (claim.scope_type === "topic" && claim.scope_id) addEdge(edges, {
      source: visualId("claim", claim.id), target: visualId("topic", claim.scope_id), type: "scoped_to", label: "属于主题",
    });
  }

  const topics = db.all("SELECT * FROM topic_threads WHERE status != 'archived'")
    .map((row) => topicAt(db, row, asOf));
  for (const topic of topics) {
    addNode(nodes, {
      id: visualId("topic", topic.id), rawId: topic.id, type: "topic", label: topic.title,
      summary: topic.current_position || topic.overview, status: topic.status, confidence: Number(topic.continuity_value || 0),
      start: topic.created_at, end: topic.status === "resolved" ? topic.last_active_at : null, date: topic.last_active_at, meta: topic,
    });
    addEdge(edges, { source: visualId("topic", topic.id), target: "identity:user", type: "concerns", label: "持续主题" });
    if (topic.canonical_topic_id) addEdge(edges, {
      source: visualId("topic", topic.id), target: visualId("topic", topic.canonical_topic_id), type: "merged_into", label: "合并到", directed: true,
    });
  }

  const topicItems = db.all("SELECT * FROM topic_items WHERE status != 'superseded'");
  for (const item of topicItems) {
    addNode(nodes, {
      id: visualId("topic_item", item.id), rawId: item.id, type: "topic_item",
      label: item.content, summary: item.item_type, status: item.status, epistemicBasis: item.epistemic_basis,
      confidence: Number(item.confidence), start: item.valid_from || item.created_at, end: item.valid_to,
      date: item.updated_at, meta: item,
    });
    addEdge(edges, {
      source: visualId("topic_item", item.id), target: visualId("topic", item.topic_id),
      type: "belongs_to", label: item.item_type,
    });
  }

  const loops = db.all("SELECT * FROM open_loops");
  for (const loop of loops) {
    addNode(nodes, {
      id: visualId("open_loop", loop.id), rawId: loop.id, type: "open_loop", label: loop.description,
      summary: `${loop.loop_type} · ${loop.owner}`, status: loop.status, confidence: Number(loop.priority),
      start: loop.created_at, end: loop.resolved_at, date: loop.last_touched_at, meta: loop,
    });
    if (loop.topic_id) addEdge(edges, {
      source: visualId("open_loop", loop.id), target: visualId("topic", loop.topic_id), type: "pending_in", label: loop.status === "open" ? "待完成" : "已解决",
    });
  }

  const events = db.all(
    `SELECT e.*, j.local_date FROM events e JOIN journal_days j ON j.id = e.journal_day_id
     WHERE e.sensitivity != 'forbidden' ORDER BY e.occurred_at DESC LIMIT 900`,
  );
  for (const event of events) addNode(nodes, {
    id: visualId("event", event.id), rawId: event.id, type: "event", label: event.content,
    summary: `${event.event_type} · ${event.actor}`, status: "recorded", confidence: Number(event.confidence),
    start: event.occurred_at, date: event.occurred_at, meta: event,
  });
  for (const row of db.all("SELECT * FROM memory_evidence")) addEdge(edges, {
    source: visualId("event", row.event_id), target: visualId("claim", row.claim_id),
    type: row.relation || "supports", label: row.relation || "证据", confidence: Number(row.weight), directed: true,
  });
  for (const row of db.all("SELECT * FROM topic_event_links")) addEdge(edges, {
    source: visualId("event", row.event_id), target: visualId("topic", row.topic_id),
    type: row.relation || "discusses", label: row.relation || "涉及", confidence: Number(row.weight),
  });
  for (const row of db.all("SELECT * FROM topic_item_evidence")) addEdge(edges, {
    source: visualId("event", row.event_id), target: visualId("topic_item", row.topic_item_id),
    type: row.relation || "supports", label: row.relation || "证据", confidence: Number(row.weight), directed: true,
  });
  for (const row of db.all("SELECT * FROM open_loop_evidence")) addEdge(edges, {
    source: visualId("event", row.event_id), target: visualId("open_loop", row.open_loop_id),
    type: row.relation || "supports", label: row.relation || "证据", confidence: Number(row.weight), directed: true,
  });
  for (const row of db.all("SELECT * FROM claim_relations")) addEdge(edges, {
    source: visualId("claim", row.source_claim_id), target: visualId("claim", row.target_claim_id),
    type: row.relation, label: row.relation, confidence: Number(row.confidence), directed: true,
  });
  for (const row of db.all("SELECT * FROM claim_transitions")) {
    if (row.from_claim_id && row.to_claim_id) addEdge(edges, {
      source: visualId("claim", row.from_claim_id), target: visualId("claim", row.to_claim_id),
      type: row.transition_type, label: row.transition_type, date: row.effective_at || row.created_at, directed: true,
    });
  }
  for (const row of db.all("SELECT * FROM topic_relations")) addEdge(edges, {
    source: visualId("topic", row.source_topic_id), target: visualId("topic", row.target_topic_id),
    type: row.relation, label: row.relation, directed: true,
  });

  for (const state of db.all("SELECT * FROM state_documents")) {
    addNode(nodes, {
      id: visualId("state", state.id), rawId: state.id, type: "state", label: state.state_type === "self_model" ? "Pet 的行为调整" : "互动方式",
      summary: `${state.state_type} · v${state.version}`, status: "active", date: state.updated_at, meta: { ...state, current_state: parseJson(state.current_state_json, {}) },
    });
    addEdge(edges, { source: visualId("state", state.id), target: "identity:pet", type: "shapes", label: "塑造行为" });
  }
  for (const row of db.all(
    `SELECT sre.*, sr.document_id FROM state_revision_evidence sre
     JOIN state_revisions sr ON sr.id = sre.revision_id`,
  )) addEdge(edges, {
    source: visualId("event", row.event_id), target: visualId("state", row.document_id),
    type: row.relation || "supports", label: "促成调整", directed: true,
  });

  if (includeSimilarity) {
    for (const row of db.all(
      `SELECT * FROM claim_neighbor_candidates
       WHERE status NOT IN ('stale', 'failed') AND similarity >= 0.55 ORDER BY similarity DESC LIMIT 180`,
    )) addEdge(edges, {
      source: visualId("claim", row.claim_a_id), target: visualId("claim", row.claim_b_id),
      type: "semantic_similarity", label: `语义相似 ${Number(row.similarity).toFixed(2)}`,
      confidence: Number(row.similarity), inferred: true,
    });
  }

  if (includeRetrieval) {
    const retrievals = db.all("SELECT * FROM retrieval_logs ORDER BY created_at DESC LIMIT 24");
    for (const retrieval of retrievals) {
      addNode(nodes, {
        id: visualId("retrieval", retrieval.id), rawId: retrieval.id, type: "retrieval", label: retrieval.query,
        summary: `${retrieval.mode} · ${retrieval.score_version}`, status: "complete", date: retrieval.created_at, meta: retrieval,
      });
      for (const [type, field] of [
        ["claim", "selected_claim_ids"],
        ["event", "selected_event_ids"],
        ["topic", "selected_topic_ids_json"],
        ["topic_item", "selected_topic_item_ids_json"],
        ["open_loop", "selected_open_loop_ids_json"],
      ]) {
        for (const id of asArray(parseJson(retrieval[field], []))) addEdge(edges, {
          source: visualId(type, id), target: visualId("retrieval", retrieval.id),
          type: "provided_to", label: "提供给回复", directed: true,
        });
      }
    }
  }

  for (const edge of [...edges.values()]) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target)) edges.delete(edge.id);
  }

  let selectedIds;
  if (mode === "global" || mode === "developer") {
    const coreTypes = mode === "global"
      ? new Set(["identity", "claim", "topic", "open_loop", "state"])
      : new Set(["identity", "claim", "topic", "open_loop", "state", "retrieval", "slot"]);
    selectedIds = new Set([...nodes.values()].filter((node) => coreTypes.has(node.type)).slice(0, limit).map((node) => node.id));
  } else {
    const start = nodes.has(focusId) ? focusId : "identity:user";
    selectedIds = new Set([start]);
    let frontier = [start];
    const localLimit = Math.min(limit, start.startsWith("identity:") ? 72 : 120);
    const rankNode = (id) => {
      const node = nodes.get(id);
      if (!node) return -Infinity;
      const typeWeight = {
        identity: 8,
        topic: 7,
        claim: 6,
        open_loop: 5,
        state: 4,
        topic_item: 3,
        slot: 2,
        event: 1,
        retrieval: 0,
      }[node.type] || 0;
      const importance = Number(node.meta?.importance || node.meta?.priority || node.confidence || 0);
      const freshness = Date.parse(node.date || node.start || "") || 0;
      return (typeWeight * 1e15) + (importance * 1e14) + freshness;
    };
    for (let level = 0; level < Math.max(1, Math.min(4, Number(depth) || 2)); level += 1) {
      const next = new Set();
      const expandable = start.startsWith("identity:")
        ? frontier
        : frontier.filter((id) => !id.startsWith("identity:"));
      for (const edge of edges.values()) {
        if (expandable.includes(edge.source) && !selectedIds.has(edge.target)) next.add(edge.target);
        if (expandable.includes(edge.target) && !selectedIds.has(edge.source)) next.add(edge.source);
      }
      const levelLimit = level === 0 ? (start.startsWith("identity:") ? 28 : 24) : 44;
      const ranked = [...next].sort((left, right) => rankNode(right) - rankNode(left)).slice(0, levelLimit);
      for (const id of ranked) {
        if (selectedIds.size >= localLimit) break;
        selectedIds.add(id);
      }
      frontier = ranked;
      if (!frontier.length || selectedIds.size >= localLimit) break;
    }
  }

  const selectedNodes = [...selectedIds].map((id) => nodes.get(id)).filter(Boolean);
  const selectedEdges = [...edges.values()].filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target));
  return {
    generatedAt: isoNow(),
    mode,
    focusId: selectedIds.has(focusId) ? focusId : "identity:user",
    asOf,
    nodes: selectedNodes,
    edges: selectedEdges,
    truncated: selectedNodes.length >= limit,
    totals: { nodes: nodes.size, edges: edges.size },
  };
}

function getMemoryTimeline(db, { from = null, to = null, limit = 800 } = {}) {
  const entries = [];
  const inRange = (start, end = null) => {
    if (from && end && end < from) return false;
    if (to && start && start > to) return false;
    return true;
  };
  for (const row of db.all(
    `SELECT e.*, j.local_date FROM events e JOIN journal_days j ON j.id = e.journal_day_id
     WHERE e.sensitivity != 'forbidden' ORDER BY e.occurred_at DESC LIMIT $limit`,
    { $limit: Math.min(1200, limit) },
  )) if (inRange(row.occurred_at)) entries.push({
    id: visualId("event", row.id), rawId: row.id, track: "events", type: "event",
    label: row.content, status: "recorded", start: row.occurred_at, end: null, meta: row,
  });
  for (const row of db.all("SELECT * FROM topic_threads WHERE status != 'archived'")) if (inRange(row.created_at, row.status === "resolved" ? row.last_active_at : null)) entries.push({
    id: visualId("topic", row.id), rawId: row.id, track: "topics", type: "topic",
    label: row.title, status: row.status, start: row.created_at, end: row.status === "resolved" ? row.last_active_at : null, meta: row,
  });
  for (const row of db.all("SELECT * FROM memory_claims WHERE status != 'rejected'")) {
    const start = row.valid_from || row.asserted_at || row.created_at;
    if (inRange(start, row.valid_to)) entries.push({
      id: visualId("claim", row.id), rawId: row.id, track: "claims", type: "claim",
      label: row.canonical_text, status: row.status, temporalState: row.temporal_state,
      start, end: row.valid_to, epistemicBasis: row.epistemic_basis, meta: row,
    });
  }
  for (const row of db.all("SELECT * FROM open_loops")) if (inRange(row.created_at, row.resolved_at)) entries.push({
    id: visualId("open_loop", row.id), rawId: row.id, track: "open_loops", type: "open_loop",
    label: row.description, status: row.status, start: row.created_at, end: row.resolved_at, meta: row,
  });
  for (const row of db.all("SELECT * FROM memory_governance_actions")) if (inRange(row.created_at)) entries.push({
    id: visualId("governance", row.id), rawId: row.id, track: "changes", type: "governance",
    label: row.reason || row.action, status: row.status, start: row.created_at, end: null, meta: row,
  });
  entries.sort((left, right) => String(left.start).localeCompare(String(right.start)));
  const timestamps = entries.flatMap((entry) => [entry.start, entry.end].filter(Boolean)).map((value) => new Date(value).getTime()).filter(Number.isFinite);
  return {
    generatedAt: isoNow(),
    from: from || (timestamps.length ? new Date(Math.min(...timestamps)).toISOString() : null),
    to: to || (timestamps.length ? new Date(Math.max(Date.now(), ...timestamps)).toISOString() : null),
    entries: entries.slice(-limit),
  };
}

function retrievalRowsFor(db, objectType, objectId, limit = 20) {
  const field = {
    claim: "selected_claim_ids",
    event: "selected_event_ids",
    topic: "selected_topic_ids_json",
    topic_item: "selected_topic_item_ids_json",
    open_loop: "selected_open_loop_ids_json",
  }[objectType];
  if (!field) return [];
  return db.all(
    `SELECT * FROM retrieval_logs WHERE ${field} LIKE $needle ORDER BY created_at DESC LIMIT $limit`,
    { $needle: `%"${String(objectId).replace(/[%_]/g, "")}"%`, $limit: limit },
  );
}

function getMemoryNodeDetail(db, nodeId) {
  const { type, id } = splitVisualId(nodeId);
  const policies = policyLookup(db);
  const policy = policies.get(visualId(type, id)) || null;
  if (type === "claim") {
    const record = db.get(
      `SELECT c.*, s.predicate AS slot_predicate, s.cardinality AS slot_cardinality
       FROM memory_claims c LEFT JOIN claim_slots s ON s.id = c.slot_id WHERE c.id = $id`,
      { $id: id },
    );
    if (!record) return null;
    return {
      type, id, record, policy,
      evidence: db.all(
        `SELECT e.*, me.relation, me.weight,
                COALESCE(es.message_id, CASE WHEN e.source_kind = 'message' THEN e.source_id END) AS message_id,
                m.role AS message_role,
                m.content AS message_content, m.created_at AS message_created_at
         FROM memory_evidence me JOIN events e ON e.id = me.event_id
         LEFT JOIN event_sources es ON es.event_id = e.id
         LEFT JOIN messages m ON m.id = COALESCE(es.message_id, CASE WHEN e.source_kind = 'message' THEN e.source_id END)
         WHERE me.claim_id = $id ORDER BY e.occurred_at DESC`,
        { $id: id },
      ),
      transitions: db.all(
        `SELECT t.*, old.canonical_text AS from_text, next.canonical_text AS to_text
         FROM claim_transitions t
         LEFT JOIN memory_claims old ON old.id = t.from_claim_id
         LEFT JOIN memory_claims next ON next.id = t.to_claim_id
         WHERE t.from_claim_id = $id OR t.to_claim_id = $id ORDER BY t.created_at DESC`,
        { $id: id },
      ),
      relations: db.all(
        `SELECT r.*, source.canonical_text AS source_text, target.canonical_text AS target_text
         FROM claim_relations r
         LEFT JOIN memory_claims source ON source.id = r.source_claim_id
         LEFT JOIN memory_claims target ON target.id = r.target_claim_id
         WHERE r.source_claim_id = $id OR r.target_claim_id = $id ORDER BY r.created_at DESC`,
        { $id: id },
      ),
      retrievals: retrievalRowsFor(db, type, id),
      actions: db.all(
        "SELECT * FROM memory_governance_actions WHERE object_type = $type AND object_id = $id ORDER BY created_at DESC",
        { $type: type, $id: id },
      ),
    };
  }
  if (type === "topic") {
    const record = db.get("SELECT * FROM topic_threads WHERE id = $id", { $id: id });
    if (!record) return null;
    return {
      type, id, record, policy,
      items: db.all("SELECT * FROM topic_items WHERE topic_id = $id ORDER BY created_at DESC", { $id: id }),
      openLoops: db.all("SELECT * FROM open_loops WHERE topic_id = $id ORDER BY last_touched_at DESC", { $id: id }),
      evidence: db.all(
        `SELECT e.*, tel.relation, tel.weight FROM topic_event_links tel
         JOIN events e ON e.id = tel.event_id WHERE tel.topic_id = $id ORDER BY e.occurred_at DESC`,
        { $id: id },
      ),
      revisions: db.all("SELECT * FROM topic_revisions WHERE topic_id = $id ORDER BY created_at DESC", { $id: id }),
      aliases: db.all("SELECT * FROM topic_aliases WHERE topic_id = $id ORDER BY created_at DESC", { $id: id }),
      retrievals: retrievalRowsFor(db, type, id),
      actions: db.all(
        "SELECT * FROM memory_governance_actions WHERE object_type = $type AND object_id = $id ORDER BY created_at DESC",
        { $type: type, $id: id },
      ),
    };
  }
  if (type === "event") {
    const record = db.get(
      "SELECT e.*, j.local_date FROM events e JOIN journal_days j ON j.id = e.journal_day_id WHERE e.id = $id",
      { $id: id },
    );
    if (!record) return null;
    return {
      type, id, record, policy,
      sources: db.all(
        `SELECT COALESCE(es.event_id, e.id) AS event_id, m.id AS message_id,
                COALESCE(es.relation, 'derived_from') AS relation, es.evidence_quote,
                m.role, m.content, m.created_at
         FROM events e
         JOIN messages m ON m.id = e.source_id AND e.source_kind = 'message'
         LEFT JOIN event_sources es ON es.event_id = e.id AND es.message_id = m.id
         WHERE e.id = $id
         UNION
         SELECT es.event_id, m.id AS message_id, es.relation, es.evidence_quote,
                m.role, m.content, m.created_at
         FROM event_sources es JOIN messages m ON m.id = es.message_id
         WHERE es.event_id = $id`,
        { $id: id },
      ),
      claims: db.all(
        `SELECT c.*, me.relation, me.weight FROM memory_evidence me
         JOIN memory_claims c ON c.id = me.claim_id WHERE me.event_id = $id`,
        { $id: id },
      ),
      topics: db.all(
        `SELECT t.*, tel.relation FROM topic_event_links tel
         JOIN topic_threads t ON t.id = tel.topic_id WHERE tel.event_id = $id`,
        { $id: id },
      ),
      retrievals: retrievalRowsFor(db, type, id),
    };
  }
  if (type === "slot") {
    const record = db.get("SELECT * FROM claim_slots WHERE id = $id", { $id: id });
    if (!record) return null;
    return {
      type, id, record, policy,
      claims: db.all("SELECT * FROM memory_claims WHERE slot_id = $id ORDER BY valid_from, created_at", { $id: id }),
      transitions: db.all(
        `SELECT t.*, old.canonical_text AS from_text, next.canonical_text AS to_text
         FROM claim_transitions t
         LEFT JOIN memory_claims old ON old.id = t.from_claim_id
         LEFT JOIN memory_claims next ON next.id = t.to_claim_id
         WHERE t.slot_id = $id ORDER BY t.created_at`,
        { $id: id },
      ),
    };
  }
  if (type === "open_loop") {
    const record = db.get("SELECT * FROM open_loops WHERE id = $id", { $id: id });
    if (!record) return null;
    return {
      type, id, record, policy,
      evidence: db.all(
        `SELECT e.*, ole.relation, ole.weight FROM open_loop_evidence ole
         JOIN events e ON e.id = ole.event_id WHERE ole.open_loop_id = $id ORDER BY e.occurred_at DESC`,
        { $id: id },
      ),
      topic: record.topic_id ? db.get("SELECT * FROM topic_threads WHERE id = $id", { $id: record.topic_id }) : null,
      retrievals: retrievalRowsFor(db, type, id),
      actions: db.all(
        "SELECT * FROM memory_governance_actions WHERE object_type = $type AND object_id = $id ORDER BY created_at DESC",
        { $type: type, $id: id },
      ),
    };
  }
  if (type === "topic_item") {
    const record = db.get("SELECT * FROM topic_items WHERE id = $id", { $id: id });
    if (!record) return null;
    return {
      type, id, record, policy,
      evidence: db.all(
        `SELECT e.*, tie.relation, tie.weight FROM topic_item_evidence tie
         JOIN events e ON e.id = tie.event_id WHERE tie.topic_item_id = $id ORDER BY e.occurred_at DESC`,
        { $id: id },
      ),
      topic: db.get("SELECT * FROM topic_threads WHERE id = $id", { $id: record.topic_id }),
      retrievals: retrievalRowsFor(db, type, id),
    };
  }
  if (type === "state") {
    const record = db.get("SELECT * FROM state_documents WHERE id = $id", { $id: id });
    if (!record) return null;
    return {
      type, id, record: { ...record, current_state: parseJson(record.current_state_json, {}) }, policy,
      revisions: db.all("SELECT * FROM state_revisions WHERE document_id = $id ORDER BY created_at DESC", { $id: id }),
    };
  }
  if (type === "retrieval") return getMemoryRetrievalTrace(db, { retrievalId: id });
  if (type === "identity") return { type, id, record: { id, label: id === "user" ? "关于你" : "Pet" }, policy: null };
  return null;
}

function getMemoryRetrievalTrace(db, { messageId = null, retrievalId = null } = {}) {
  let assistantMessage = null;
  if (messageId) assistantMessage = db.get("SELECT * FROM messages WHERE id = $id AND role = 'assistant'", { $id: messageId });
  let id = retrievalId;
  if (!id && assistantMessage) id = parseJson(assistantMessage.metadata_json, {}).retrievalId;
  let retrieval = id ? db.get("SELECT * FROM retrieval_logs WHERE id = $id", { $id: id }) : null;
  if (!retrieval && messageId) retrieval = db.get(
    "SELECT * FROM retrieval_logs WHERE assistant_message_id = $id ORDER BY created_at DESC LIMIT 1",
    { $id: messageId },
  );
  if (!retrieval) return null;
  if (!assistantMessage && retrieval.assistant_message_id) assistantMessage = db.get(
    "SELECT * FROM messages WHERE id = $id",
    { $id: retrieval.assistant_message_id },
  );
  const selectedClaimIds = asArray(parseJson(retrieval.selected_claim_ids, []));
  const selectedEventIds = asArray(parseJson(retrieval.selected_event_ids, []));
  const selectedTopicIds = asArray(parseJson(retrieval.selected_topic_ids_json, []));
  const selectedItemIds = asArray(parseJson(retrieval.selected_topic_item_ids_json, []));
  const selectedLoopIds = asArray(parseJson(retrieval.selected_open_loop_ids_json, []));
  return {
    type: "retrieval",
    id: retrieval.id,
    retrieval: {
      ...retrieval,
      route: parseJson(retrieval.route_json, {}),
      score: parseJson(retrieval.score_json, {}),
      outcome: parseJson(retrieval.outcome_json, {}),
    },
    userMessage: retrieval.user_message_id
      ? db.get("SELECT * FROM messages WHERE id = $id", { $id: retrieval.user_message_id })
      : null,
    assistantMessage,
    claims: rowsByIds(db, "memory_claims", selectedClaimIds),
    events: rowsByIds(db, "events", selectedEventIds),
    topics: rowsByIds(db, "topic_threads", selectedTopicIds),
    topicItems: rowsByIds(db, "topic_items", selectedItemIds),
    openLoops: rowsByIds(db, "open_loops", selectedLoopIds),
    stages: db.all("SELECT * FROM retrieval_stage_logs WHERE retrieval_id = $id ORDER BY created_at", { $id: retrieval.id })
      .map((row) => ({ ...row, payload: parseJson(row.payload_json, {}) })),
    caveat: "这些记忆被提供给了回复模型，但日志本身不能证明模型最终依赖了其中每一条。",
  };
}

function getMemoryDiagnostics(db) {
  const count = (table, where = "") => Number(db.get(`SELECT COUNT(*) AS count FROM ${table} ${where}`)?.count || 0);
  return {
    generatedAt: isoNow(),
    embeddings: {
      ready: count("memory_embeddings", "WHERE status = 'ready'"),
      failed: count("memory_embeddings", "WHERE status = 'failed'"),
      pendingJobs: count("embedding_jobs", "WHERE status IN ('pending', 'running')"),
      failedJobs: count("embedding_jobs", "WHERE status = 'failed'"),
      profiles: db.all("SELECT * FROM embedding_profiles ORDER BY created_at DESC"),
    },
    retrieval: {
      total: count("retrieval_logs"),
      stages: count("retrieval_stage_logs"),
      degradedStages: count("retrieval_stage_logs", "WHERE status = 'degraded'"),
      recent: db.all("SELECT * FROM retrieval_logs ORDER BY created_at DESC LIMIT 12")
        .map((row) => ({ ...row, route: parseJson(row.route_json, {}), score: parseJson(row.score_json, {}) })),
      recentStages: db.all("SELECT * FROM retrieval_stage_logs ORDER BY created_at DESC LIMIT 24")
        .map((row) => ({ ...row, payload: parseJson(row.payload_json, {}) })),
    },
    governance: {
      disputedClaims: count("memory_claims", "WHERE status = 'disputed'"),
      pendingClaimNeighbors: count("claim_neighbor_candidates", "WHERE status IN ('pending_model', 'pending_review')"),
      topicWarnings: count("topic_health_runs", "WHERE recommendation != 'healthy'"),
      hiddenObjects: count("memory_object_policies", "WHERE surface_policy = 'do_not_surface'"),
      neighbors: db.all(
        `SELECT n.*, a.canonical_text AS claim_a_text, b.canonical_text AS claim_b_text
         FROM claim_neighbor_candidates n
         JOIN memory_claims a ON a.id = n.claim_a_id
         JOIN memory_claims b ON b.id = n.claim_b_id
         ORDER BY n.updated_at DESC LIMIT 20`,
      ),
    },
  };
}

function insertGovernanceEvent(db, { actionId, content, objectId }) {
  const now = isoNow();
  const day = db.ensureJournalDay(new Date(now));
  const next = Number(db.get(
    "SELECT COALESCE(MAX(sequence_no), 0) + 1 AS value FROM events WHERE journal_day_id = $id",
    { $id: day.id },
  )?.value || 1);
  const id = crypto.randomUUID();
  db.db.run(
    `INSERT INTO events
     (id, journal_day_id, sequence_no, event_type, actor, occurred_at, recorded_at,
      content, payload_json, source_kind, source_id, salience, continuity_value,
      continuity_score_version, continuity_components_json, confidence, retention_class,
      sensitivity, dedupe_key, extractor_version)
     VALUES ($id, $dayId, $sequence, 'memory_governance', 'user', $now, $now,
      $content, $payload, 'memory_atlas', $actionId, 0.95, 0.95,
      'memory-atlas-v1', '{}', 1, 'durable', 'private', $dedupe, 'memory-atlas-v1')`,
    {
      $id: id, $dayId: day.id, $sequence: next, $now: now, $content: content,
      $payload: JSON.stringify({ action_id: actionId, object_id: objectId }),
      $actionId: actionId, $dedupe: `memory-atlas:${actionId}`,
    },
  );
  return id;
}

function upsertPolicy(db, type, id, surfacePolicy, embeddingPolicy, reason) {
  db.db.run(
    `INSERT INTO memory_object_policies
     (object_type, object_id, surface_policy, embedding_policy, reason, updated_at)
     VALUES ($type, $id, $surface, $embedding, $reason, $now)
     ON CONFLICT(object_type, object_id) DO UPDATE SET
       surface_policy = excluded.surface_policy,
       embedding_policy = excluded.embedding_policy,
       reason = excluded.reason,
       updated_at = excluded.updated_at`,
    { $type: type, $id: id, $surface: surfacePolicy, $embedding: embeddingPolicy, $reason: reason, $now: isoNow() },
  );
}

function hardDeleteClaim(db, id) {
  const neighborIds = db.all(
    "SELECT id FROM claim_neighbor_candidates WHERE claim_a_id = $id OR claim_b_id = $id",
    { $id: id },
  ).map((row) => row.id);
  if (neighborIds.length) {
    const list = placeholders(neighborIds, "neighbor");
    db.db.run(`DELETE FROM claim_neighbor_evidence WHERE candidate_id IN (${list.sql})`, list.params);
    db.db.run(`DELETE FROM claim_neighbor_candidates WHERE id IN (${list.sql})`, list.params);
  }
  const transitionIds = db.all(
    "SELECT id FROM claim_transitions WHERE from_claim_id = $id OR to_claim_id = $id",
    { $id: id },
  ).map((row) => row.id);
  if (transitionIds.length) {
    const list = placeholders(transitionIds, "transition");
    db.db.run(`DELETE FROM claim_transition_evidence WHERE transition_id IN (${list.sql})`, list.params);
    db.db.run(`DELETE FROM claim_transitions WHERE id IN (${list.sql})`, list.params);
  }
  db.db.run("UPDATE memory_claims SET superseded_by = NULL WHERE superseded_by = $id", { $id: id });
  db.db.run("DELETE FROM claim_relations WHERE source_claim_id = $id OR target_claim_id = $id", { $id: id });
  db.db.run("DELETE FROM memory_evidence WHERE claim_id = $id", { $id: id });
  db.db.run("DELETE FROM memory_embeddings WHERE object_type = 'claim' AND object_id = $id", { $id: id });
  db.db.run("DELETE FROM embedding_jobs WHERE object_type = 'claim' AND object_id = $id", { $id: id });
  db.db.run("DELETE FROM memory_object_policies WHERE object_type = 'claim' AND object_id = $id", { $id: id });
  db.db.run("DELETE FROM memory_claims WHERE id = $id", { $id: id });
}

function governMemory(db, payload = {}) {
  const action = clean(payload.action, 40);
  const objectType = clean(payload.objectType, 40);
  const objectId = clean(payload.objectId, 180);
  if (!["confirm", "correct", "hide", "unhide", "delete"].includes(action)) throw new Error("不支持的记忆治理操作。");
  if (!["claim", "topic", "topic_item", "open_loop", "event"].includes(objectType)) throw new Error("该记忆类型暂不支持治理。");
  const table = {
    claim: "memory_claims",
    topic: "topic_threads",
    topic_item: "topic_items",
    open_loop: "open_loops",
    event: "events",
  }[objectType];
  const before = db.get(`SELECT * FROM ${table} WHERE id = $id`, { $id: objectId });
  if (!before) throw new Error("记忆对象不存在或已经删除。");
  if (["confirm", "correct", "delete"].includes(action) && objectType !== "claim") {
    throw new Error("当前只有事实记忆支持确认、纠正和删除。");
  }
  const actionId = crypto.randomUUID();
  const reason = clean(payload.reason || payload.correctedText || action, 1200);
  let sourceEventId = null;
  let result = null;
  let after = null;

  db.transaction(() => {
    if (action === "hide" || action === "unhide") {
      upsertPolicy(
        db,
        objectType,
        objectId,
        action === "hide" ? "do_not_surface" : "normal",
        action === "hide" ? "do_not_embed" : "inherit",
        reason || (action === "hide" ? "用户要求不再主动提起" : "用户恢复该记忆"),
      );
      if (action === "hide") {
        db.db.run("DELETE FROM memory_embeddings WHERE object_type = $type AND object_id = $id", { $type: objectType, $id: objectId });
        db.db.run("DELETE FROM embedding_jobs WHERE object_type = $type AND object_id = $id", { $type: objectType, $id: objectId });
      }
      result = { action, objectType, objectId };
      after = { ...before, surface_policy: action === "hide" ? "do_not_surface" : "normal" };
    } else if (action === "delete") {
      hardDeleteClaim(db, objectId);
      result = { action, objectType, objectId, deleted: true };
      after = { deleted: true };
    } else {
      const correctedText = clean(payload.correctedText, 1000);
      if (action === "correct" && correctedText.length < 2) throw new Error("请输入纠正后的记忆内容。");
      const content = action === "confirm"
        ? `用户确认这条记忆是正确的：${before.canonical_text}`
        : `用户纠正记忆：不是“${before.canonical_text}”，而是“${correctedText}”。`;
      sourceEventId = insertGovernanceEvent(db, { actionId, content, objectId });
      const parsedValue = parseJson(before.object_json, before.canonical_text);
      const oldValue = parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue)
        ? (parsedValue.value ?? before.canonical_text)
        : parsedValue;
      const slot = db.get("SELECT * FROM claim_slots WHERE id = $id", { $id: before.slot_id });
      result = applyClaimProposal(db, {
        canonical_text: action === "confirm" ? before.canonical_text : correctedText,
        value: action === "confirm" ? oldValue : correctedText,
        claim_type: before.claim_type,
        slot_resolution: {
          action: "reuse_slot",
          slot_id: before.slot_id,
          expected_version: Number(slot?.version || 1),
        },
        value_resolution: {
          relation: action === "confirm" ? "same_value" : "correction",
          confidence: 1,
          target_claim_ids: [before.id],
        },
        temporal: {
          current: true,
          basis: "message_time_assumption",
          precision: "exact",
          confidence: 0.95,
        },
        explicit: true,
        epistemic_basis: "stated_by_user",
        importance: Number(before.importance),
        stability: Number(before.stability),
      }, {
        evidenceEventIds: [sourceEventId],
        allowedSlotIds: [before.slot_id],
        assertedAt: isoNow(),
        confidence: 0.99,
        importance: Number(before.importance),
        stability: Number(before.stability),
        promotionScore: 0.98,
        explicit: true,
        epistemicBasis: "stated_by_user",
        runId: actionId,
      });
      if (result.rejected) throw new Error(`记忆治理未应用：${result.reason}`);
      after = db.get("SELECT * FROM memory_claims WHERE id = $id", { $id: result.claimId || objectId });
    }
    db.db.run(
      `INSERT INTO memory_governance_actions
       (id, object_type, object_id, action, status, reason, before_json, after_json, source_event_id, created_at)
       VALUES ($id, $type, $objectId, $action, 'complete', $reason, $before, $after, $eventId, $now)`,
      {
        $id: actionId, $type: objectType, $objectId: objectId, $action: action, $reason: reason || null,
        $before: JSON.stringify(before), $after: JSON.stringify(after || {}), $eventId: sourceEventId, $now: isoNow(),
      },
    );
  });
  db.log("info", "memory_atlas", "用户完成记忆治理操作。", { actionId, action, objectType, objectId, result });
  return { actionId, action, objectType, objectId, sourceEventId, result, after };
}

module.exports = {
  getMemoryDiagnostics,
  getMemoryGraph,
  getMemoryNodeDetail,
  getMemoryOverview,
  getMemoryRetrievalTrace,
  getMemoryTimeline,
  governMemory,
  splitVisualId,
};
