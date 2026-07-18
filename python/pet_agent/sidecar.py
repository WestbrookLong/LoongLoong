from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
import traceback
from pathlib import Path
from typing import Any

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="strict")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from pet_agent.runtime import AgentCancelled, AgentRuntime
else:
    from .runtime import AgentCancelled, AgentRuntime

WRITE_LOCK = threading.Lock()
RUNS: dict[str, threading.Event] = {}


def emit(message: dict[str, Any]) -> None:
    with WRITE_LOCK:
        sys.stdout.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()


def run_worker(run_id: str, payload: dict[str, Any], cancel: threading.Event) -> None:
    try:
        emit({"type": "run_started", "run_id": run_id})
        runtime = AgentRuntime(payload, lambda event: emit({"run_id": run_id, **event}), cancel)
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
    emit({"type": "ready", "pid": os.getpid(), "protocol": 1})
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
                cancel = threading.Event()
                RUNS[run_id] = cancel
                threading.Thread(target=run_worker, args=(run_id, message["payload"], cancel), daemon=True).start()
            elif kind == "cancel_run":
                if event := RUNS.get(str(message.get("run_id"))):
                    event.set()
            elif kind == "shutdown":
                for event in RUNS.values():
                    event.set()
                break
        except Exception as exc:
            emit({"type": "protocol_error", "error": str(exc)})


if __name__ == "__main__":
    main()
