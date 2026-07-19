from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="strict")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from pet_agent.approvals import ApprovalInbox
    from pet_agent.runtime import AgentCancelled, AgentRuntime
    from pet_agent.unicode_safety import repair_value
else:
    from .approvals import ApprovalInbox
    from .runtime import AgentCancelled, AgentRuntime
    from .unicode_safety import repair_value

WRITE_LOCK = threading.Lock()
PROTOCOL_VERSION = 2
RUNTIME_VERSION = "2.1.1"


@dataclass
class RunState:
    cancel: threading.Event = field(default_factory=threading.Event)
    approvals: ApprovalInbox = field(default_factory=ApprovalInbox)


RUNS: dict[str, RunState] = {}


def emit(message: dict[str, Any]) -> None:
    with WRITE_LOCK:
        sys.stdout.write(json.dumps(repair_value(message), ensure_ascii=True, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def run_worker(run_id: str, payload: dict[str, Any], state: RunState) -> None:
    try:
        emit({"type": "run_started", "run_id": run_id})
        runtime = AgentRuntime(payload, lambda event: emit({"run_id": run_id, **event}), state.cancel, state.approvals)
        result = asyncio.run(runtime.run())
        emit({"type": "run_completed", "run_id": run_id, "result": result})
    except AgentCancelled as exc:
        emit({"type": "run_cancelled", "run_id": run_id, "error": str(exc)})
    except Exception as exc:
        print(f"Agent run {run_id} failed: {exc}\n{traceback.format_exc()}", file=sys.stderr, flush=True)
        emit({"type": "run_failed", "run_id": run_id, "error": str(exc)})
    finally:
        RUNS.pop(run_id, None)


def main() -> None:
    emit({
        "type": "ready", "pid": os.getpid(), "protocol": PROTOCOL_VERSION,
        "runtime_version": RUNTIME_VERSION,
        "capabilities": ["approvals", "external_read", "filesystem_write", "process_execute", "web_fallback", "known_path_grounding", "path_references"],
    })
    for raw in sys.stdin:
        try:
            message = json.loads(raw)
            kind = message.get("type")
            if kind == "ping":
                emit({"type": "pong", "id": message.get("id")})
            elif kind == "run_start":
                run_id = str(message["run_id"])
                if run_id in RUNS:
                    emit({"type": "run_failed", "run_id": run_id, "error": "Run already exists."})
                    continue
                state = RunState()
                RUNS[run_id] = state
                threading.Thread(target=run_worker, args=(run_id, repair_value(message["payload"]), state), daemon=True).start()
            elif kind == "cancel_run":
                if state := RUNS.get(str(message.get("run_id"))):
                    state.cancel.set()
                    state.approvals.resolve(str(message.get("approval_id") or ""), {"decision": "cancelled"})
            elif kind == "approval_resolve":
                if state := RUNS.get(str(message.get("run_id"))):
                    state.approvals.resolve(str(message.get("approval_id")), dict(message.get("response") or {}))
            elif kind == "shutdown":
                for state in RUNS.values():
                    state.cancel.set()
                break
        except Exception as exc:
            emit({"type": "protocol_error", "error": str(exc)})


if __name__ == "__main__":
    main()
