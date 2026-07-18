from __future__ import annotations

import asyncio
import threading
import time
from typing import Any, Callable


class ApprovalInbox:
    def __init__(self) -> None:
        self._condition = threading.Condition()
        self._responses: dict[str, dict[str, Any]] = {}

    def resolve(self, approval_id: str, response: dict[str, Any]) -> None:
        with self._condition:
            self._responses[approval_id] = response
            self._condition.notify_all()

    def _take(self, approval_id: str, timeout: float) -> dict[str, Any] | None:
        with self._condition:
            if approval_id not in self._responses:
                self._condition.wait(timeout)
            return self._responses.pop(approval_id, None)

    async def request(
        self,
        request: dict[str, Any],
        emit: Callable[[dict[str, Any]], None],
        cancel: threading.Event,
        deadline: float,
    ) -> dict[str, Any]:
        emit({"type": "approval_required", **request})
        while True:
            if cancel.is_set():
                return {"decision": "cancelled"}
            if deadline and time.monotonic() > deadline:
                return {"decision": "expired"}
            response = await asyncio.to_thread(self._take, request["approval_id"], 0.25)
            if response is not None:
                emit({
                    "type": "approval_resolved",
                    "approval_id": request["approval_id"],
                    "decision": response.get("decision", "deny"),
                })
                return response
