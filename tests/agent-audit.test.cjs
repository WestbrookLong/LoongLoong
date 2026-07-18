const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");

const { PetDatabase } = require("../electron/database.cjs");
const { createAgentAudit, persistAgentResult } = require("../electron/agent-audit.cjs");
const { activeGrants, addPersistentReadGrant, recordApprovalRequest, resolveApprovalRequest, revokeGrant } = require("../electron/approval-broker.cjs");

test("persists Agent task, run, steps, and read-only tool receipts", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pet-agent-audit-"));
  const database = await new PetDatabase(path.join(directory, "pet.db")).initialize();
  try {
    const session = database.getActiveSession();
    const message = database.addMessage({ sessionId: session.id, role: "user", content: "read README", modality: "text" });
    const runId = crypto.randomUUID();
    const audit = createAgentAudit(database, {
      runId, sessionId: session.id, userMessageId: message.id, objective: "read README", limits: { maxSteps: 8 },
    });
    persistAgentResult(database, audit, {
      taskSummary: "README summarized", stopReason: "completed",
      steps: [{ step: 1, finish_reason: "tool_calls", tool_call_count: 1, usage: { total_tokens: 10 } }],
      receipts: [{ step: 1, tool_call_id: "call_1", tool: "filesystem_read", arguments: { path: "README.md" }, result: { ok: true, duration_ms: 4, truncated: false } }],
    });
    assert.equal(database.get("SELECT status FROM agent_tasks WHERE id = $id", { $id: audit.taskId }).status, "complete");
    assert.equal(database.get("SELECT step_count FROM agent_runs WHERE id = $id", { $id: runId }).step_count, 1);
    assert.equal(database.get("SELECT tool_name FROM tool_executions WHERE run_id = $id", { $id: runId }).tool_name, "filesystem_read");
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("records approvals and manages persistent directory grants", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pet-approval-audit-"));
  const database = await new PetDatabase(path.join(directory, "pet.db")).initialize();
  try {
    const session = database.getActiveSession();
    const message = database.addMessage({ sessionId: session.id, role: "user", content: "read external", modality: "text" });
    const runId = crypto.randomUUID();
    createAgentAudit(database, { runId, sessionId: session.id, userMessageId: message.id, objective: "read external", limits: {} });
    const approvalId = crypto.randomUUID();
    recordApprovalRequest(database, runId, {
      approval_id: approvalId, tool: "filesystem_read", operation: "read", risk: "medium",
      requested_path: directory, preview: { diff: "secret preview must not persist" },
    });
    resolveApprovalRequest(database, runId, approvalId, { decision: "approve", scope: "once" });
    const approval = database.get("SELECT * FROM approval_requests WHERE id = $id", { $id: approvalId });
    assert.equal(approval.status, "approved");
    assert.doesNotMatch(approval.request_json, /secret preview/);
    const grant = addPersistentReadGrant(database, directory);
    assert.equal(activeGrants(database)[0].root_path, path.resolve(directory));
    revokeGrant(database, grant.id);
    assert.equal(activeGrants(database).length, 0);
  } finally {
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
