const crypto = require("node:crypto");
const path = require("node:path");
const { isoNow } = require("./database.cjs");

function sanitizeRequest(request) {
  const preview = request.preview || {};
  const command = request.command ? {
    ...request.command,
    args: (request.command.args || []).map((item) => String(item).replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s"']+/gi, "$1[REDACTED]").slice(0, 4000)),
  } : undefined;
  return {
    ...request,
    command,
    preview: {
      ...preview,
      diff: preview.diff ? `[diff omitted from audit: ${preview.diff.length} chars]` : "",
      proposed_preview: preview.proposed_preview ? `[proposed content omitted from audit: ${preview.proposed_preview.length} chars]` : "",
    },
  };
}

function recordApprovalRequest(db, runId, request) {
  db.run(
    `INSERT OR REPLACE INTO approval_requests
     (id, run_id, tool_name, operation, requested_path, risk, status, request_json, requested_at)
     VALUES ($id, $runId, $tool, $operation, $path, $risk, 'pending', $request, $now)`,
    {
      $id: request.approval_id, $runId: runId, $tool: request.tool, $operation: request.operation,
      $path: request.requested_path || null, $risk: request.risk || "medium",
      $request: JSON.stringify(sanitizeRequest(request)), $now: isoNow(),
    },
  );
}

function resolveApprovalRequest(db, runId, approvalId, response) {
  const now = isoNow();
  db.transaction(() => {
    db.db.run(
      `UPDATE approval_requests SET status = $status, response_json = $response, resolved_at = $now
       WHERE id = $id AND run_id = $runId`,
      { $id: approvalId, $runId: runId, $status: response.decision === "approve" ? "approved" : "denied", $response: JSON.stringify(response), $now: now },
    );
    db.db.run(
      `INSERT INTO policy_decisions (id, run_id, approval_id, decision, detail_json, created_at)
       VALUES ($id, $runId, $approvalId, $decision, $detail, $now)`,
      { $id: crypto.randomUUID(), $runId: runId, $approvalId: approvalId, $decision: response.decision || "deny", $detail: JSON.stringify({ scope: response.scope || "once" }), $now: now },
    );
  });
}

function addPersistentReadGrant(db, rootPath) {
  const normalized = path.resolve(String(rootPath));
  const existing = db.get(
    "SELECT * FROM capability_grants WHERE root_path = $path AND status = 'active' AND scope = 'persistent'",
    { $path: normalized },
  );
  if (existing) return existing;
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO capability_grants
     (id, root_path, operations_json, scope, allow_sensitive, status, created_at)
     VALUES ($id, $path, '["read"]', 'persistent', 0, 'active', $now)`,
    { $id: id, $path: normalized, $now: isoNow() },
  );
  return db.get("SELECT * FROM capability_grants WHERE id = $id", { $id: id });
}

function revokeGrant(db, id) {
  db.run(
    "UPDATE capability_grants SET status = 'revoked', revoked_at = $now WHERE id = $id AND status = 'active'",
    { $id: id, $now: isoNow() },
  );
  return { revoked: true };
}

function activeGrants(db) {
  return db.all(
    `SELECT * FROM capability_grants
     WHERE status = 'active' AND (expires_at IS NULL OR expires_at > $now)
     ORDER BY created_at`,
    { $now: isoNow() },
  ).map((row) => ({
    id: row.id,
    root_path: row.root_path,
    operations: JSON.parse(row.operations_json || '["read"]'),
    scope: row.scope,
    allow_sensitive: Boolean(row.allow_sensitive),
    expires_at: row.expires_at,
  }));
}

module.exports = { activeGrants, addPersistentReadGrant, recordApprovalRequest, resolveApprovalRequest, revokeGrant };
