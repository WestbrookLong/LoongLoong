const path = require("node:path");
const { spawn } = require("node:child_process");

class AgentSidecar {
  constructor({ onLog = () => {} } = {}) {
    this.onLog = onLog;
    this.child = null;
    this.readyPromise = null;
    this.runs = new Map();
    this.stdoutBuffer = "";
  }

  start() {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => {
      const executable = process.env.PET_PYTHON || "python";
      const script = path.join(__dirname, "..", "python", "pet_agent", "sidecar.py");
      const env = { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" };
      delete env.OPENAI_API_KEY;
      delete env.DASHSCOPE_API_KEY;
      const child = spawn(executable, ["-u", script], {
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
            const event = JSON.parse(line);
            if (event.type === "ready") {
              clearTimeout(timer);
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
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
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

  close() {
    if (!this.child) return;
    try { this.send({ type: "shutdown" }); } catch {}
    setTimeout(() => this.child?.kill(), 1000).unref();
  }
}

module.exports = { AgentSidecar };
