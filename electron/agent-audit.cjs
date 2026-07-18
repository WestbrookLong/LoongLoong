const crypto = require("node:crypto");
const { isoNow } = require("./database.cjs");

function redactText(value) {
  return String(value).replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s"']+/gi, "$1[REDACTED]").slice(0, 4000);
}

function safeArguments(receipt) {
  const args = { ...(receipt.arguments || {}) };
  if (typeof args.content === "string") {
    args.content = `[content omitted: ${args.content.length} chars, sha256=${crypto.createHash("sha256").update(args.content).digest("hex")}]`;
  }
  for (const key of ["old_text", "new_text"]) {
    if (typeof args[key] === "string") args[key] = `[${key} omitted: ${args[key].length} chars]`;
  }
  if (Array.isArray(args.args)) args.args = args.args.map(redactText);
  return args;
}

function createAgentAudit(db, { runId, sessionId, userMessageId, objective, limits, relatedTopicId = null, relatedOpenLoopId = null }) {
  const taskId = crypto.randomUUID();
  const now = isoNow();
  db.transaction(() => {
    db.db.run(
      `INSERT INTO agent_tasks
       (id, session_id, user_message_id, objective, status, related_topic_id, related_open_loop_id, created_at, updated_at)
       VALUES ($id, $sessionId, $messageId, $objective, 'running', $topicId, $openLoopId, $now, $now)`,
      { $id: taskId, $sessionId: sessionId, $messageId: userMessageId, $objective: objective,
        $topicId: relatedTopicId, $openLoopId: relatedOpenLoopId, $now: now },
    );
    db.db.run(
      `INSERT INTO agent_runs (id, task_id, session_id, status, limits_json, started_at)
       VALUES ($id, $taskId, $sessionId, 'running', $limits, $now)`,
      { $id: runId, $taskId: taskId, $sessionId: sessionId, $limits: JSON.stringify(limits), $now: now },
    );
  });
  return { taskId, runId };
}

function persistAgentResult(db, audit, result) {
  const now = isoNow();
  db.transaction(() => {
    for (const step of result.steps || []) {
      db.db.run(
        `INSERT INTO agent_steps (id, run_id, step_no, finish_reason, model_output_json, usage_json, created_at)
         VALUES ($id, $runId, $stepNo, $finishReason, $output, $usage, $now)`,
        { $id: crypto.randomUUID(), $runId: audit.runId, $stepNo: step.step, $finishReason: step.finish_reason || null,
          $output: JSON.stringify({ toolCallCount: step.tool_call_count || 0 }), $usage: JSON.stringify(step.usage || {}), $now: now },
      );
    }
    for (const receipt of result.receipts || []) {
      const toolResult = receipt.result || {};
      const safeResult = {
        ok: Boolean(toolResult.ok),
        summary: toolResult.summary || "",
        error: toolResult.error || null,
        retryable: Boolean(toolResult.retryable),
        duration_ms: Number(toolResult.duration_ms || 0),
        truncated: Boolean(toolResult.truncated),
        provenance: toolResult.provenance || {},
        approval_id: toolResult.approval_id || null,
        untrusted: toolResult.untrusted !== false,
      };
      db.db.run(
        `INSERT INTO tool_executions
         (id, run_id, step_no, tool_call_id, tool_name, arguments_json, result_json, status, duration_ms, truncated, approval_id, created_at)
         VALUES ($id, $runId, $stepNo, $callId, $tool, $arguments, $result, $status, $duration, $truncated, $approvalId, $now)`,
        { $id: crypto.randomUUID(), $runId: audit.runId, $stepNo: receipt.step, $callId: receipt.tool_call_id,
          $tool: receipt.tool, $arguments: JSON.stringify(safeArguments(receipt)), $result: JSON.stringify(safeResult),
          $status: toolResult.ok ? "complete" : "failed", $duration: Number(toolResult.duration_ms || 0),
          $truncated: toolResult.truncated ? 1 : 0, $approvalId: toolResult.approval_id || null, $now: now },
      );
    }
    db.db.run(
      `UPDATE agent_runs SET status = 'complete', step_count = $steps, stop_reason = $reason, completed_at = $now WHERE id = $id`,
      { $id: audit.runId, $steps: (result.steps || []).length, $reason: result.stopReason || "completed", $now: now },
    );
    db.db.run(
      `UPDATE agent_tasks SET status = 'complete', summary_json = $summary, updated_at = $now, completed_at = $now WHERE id = $id`,
      { $id: audit.taskId, $summary: JSON.stringify({ summary: result.taskSummary || "", receipts: (result.receipts || []).map((item) => ({ tool: item.tool, ok: Boolean(item.result?.ok) })) }), $now: now },
    );
  });
}

function failAgentAudit(db, audit, error, status = "failed") {
  const now = isoNow();
  db.transaction(() => {
    db.db.run("UPDATE agent_runs SET status = $status, error = $error, completed_at = $now WHERE id = $id",
      { $id: audit.runId, $status: status, $error: String(error), $now: now });
    db.db.run("UPDATE agent_tasks SET status = $status, updated_at = $now, completed_at = $now WHERE id = $id",
      { $id: audit.taskId, $status: status, $now: now });
    db.db.run("UPDATE approval_requests SET status = $status, resolved_at = $now WHERE run_id = $runId AND status = 'pending'",
      { $runId: audit.runId, $status: status === "cancelled" ? "cancelled" : "interrupted", $now: now });
  });
}

module.exports = { createAgentAudit, failAgentAudit, persistAgentResult };
