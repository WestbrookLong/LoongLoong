const path = require("node:path");
const fs = require("node:fs");
const { spawn } = require("node:child_process");

function wellFormedString(value) {
  const text = String(value);
  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xD800 && code <= 0xDBFF) {
      const low = text.charCodeAt(index + 1);
      if (low >= 0xDC00 && low <= 0xDFFF) {
        output += text[index] + text[index + 1];
        index += 1;
      } else {
        output += "\uFFFD";
      }
    } else if (code >= 0xDC00 && code <= 0xDFFF) {
      output += "\uFFFD";
    } else {
      output += text[index];
    }
  }
  return output;
}

function wellFormedValue(value) {
  if (typeof value === "string") return wellFormedString(value);
  if (Array.isArray(value)) return value.map(wellFormedValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [wellFormedString(key), wellFormedValue(item)]));
  }
  return value;
}

class AgentSidecar {
  constructor({ onLog = () => {} } = {}) {
    this.onLog = onLog;
    this.child = null;
    this.readyPromise = null;
    this.runs = new Map();
    this.stdoutBuffer = "";
    this.runtimeInfo = null;
  }

  launchTarget() {
    const executableName = process.platform === "win32" ? "pet-agent.exe" : "pet-agent";
    const bundledCandidates = [
      path.join(process.resourcesPath || "", "agent-sidecar", executableName),
      path.join(__dirname, "..", "release", "agent-sidecar", executableName),
    ];
    const bundled = bundledCandidates.find((candidate) => candidate && fs.existsSync(candidate));
    if (bundled) return { executable: bundled, args: [], mode: "bundled" };
    const script = path.join(__dirname, "..", "python", "pet_agent", "sidecar.py");
    return { executable: process.env.PET_PYTHON || "python", args: ["-u", script], mode: "python" };
  }

  start() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => {
      const target = this.launchTarget();
      const env = { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" };
      delete env.OPENAI_API_KEY;
      delete env.DASHSCOPE_API_KEY;
      const child = spawn(target.executable, target.args, {
        cwd: path.join(__dirname, ".."), env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;
      const timer = setTimeout(() => reject(new Error("Agent sidecar startup timed out.")), 12000);
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        this.stdoutBuffer += chunk;
        let newline;
        while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
          const line = this.stdoutBuffer.slice(0, newline).trim();
          this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
          if (!line) continue;
          try {
            const event = wellFormedValue(JSON.parse(line));
            if (event.type === "ready") {
              clearTimeout(timer);
              if (Number(event.protocol || 0) < 2) {
                reject(new Error(`Agent sidecar protocol ${event.protocol} is no longer supported.`));
                child.kill();
                continue;
              }
              this.runtimeInfo = { ...event, mode: target.mode, executable: target.executable };
              resolve(event);
            }
            this.handleEvent(event);
          } catch (error) {
            this.onLog("warn", "Agent sidecar returned invalid JSON.", { error: String(error.message || error) });
          }
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => this.onLog("warn", "Agent sidecar diagnostic.", { detail: String(chunk).slice(0, 2000) }));
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        this.child = null;
        this.readyPromise = null;
        this.runtimeInfo = null;
        for (const pending of this.runs.values()) pending.reject(new Error(`Agent sidecar exited (${code}).`));
        this.runs.clear();
      });
    });
    return this.readyPromise;
  }

  handleEvent(event) {
    const pending = this.runs.get(event.run_id);
    if (!pending) return;
    pending.onEvent(event);
    if (event.type === "run_completed") {
      this.runs.delete(event.run_id);
      pending.resolve(event.result);
    } else if (event.type === "run_failed" || event.type === "run_cancelled") {
      this.runs.delete(event.run_id);
      const error = new Error(event.error || (event.type === "run_cancelled" ? "Agent run was cancelled." : "Agent run failed."));
      error.code = event.type === "run_cancelled" ? "AGENT_CANCELLED" : "AGENT_FAILED";
      pending.reject(error);
    }
  }

  send(message) {
    if (!this.child?.stdin?.writable) throw new Error("Agent sidecar is not running.");
    this.child.stdin.write(`${JSON.stringify(wellFormedValue(message))}\n`);
  }

  async run(runId, payload, onEvent = () => {}) {
    await this.start();
    return new Promise((resolve, reject) => {
      this.runs.set(runId, { resolve, reject, onEvent });
      this.send({ type: "run_start", run_id: runId, payload });
    });
  }

  cancel(runId) {
    if (this.child) this.send({ type: "cancel_run", run_id: runId });
  }

  resolveApproval(runId, approvalId, response) {
    this.send({ type: "approval_resolve", run_id: runId, approval_id: approvalId, response });
  }

  async health() {
    await this.start();
    return { ok: true, ...this.runtimeInfo };
  }

  close() {
    if (!this.child) return;
    try { this.send({ type: "shutdown" }); } catch {}
    setTimeout(() => this.child?.kill(), 1000).unref();
  }
}

module.exports = { AgentSidecar, wellFormedString, wellFormedValue };
