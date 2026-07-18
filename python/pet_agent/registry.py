from __future__ import annotations

import asyncio
import inspect
import time
from dataclasses import dataclass
from typing import Any, Awaitable, Callable

from .results import ToolResult

Handler = Callable[..., Awaitable[ToolResult] | ToolResult]


@dataclass
class ToolEntry:
    name: str
    description: str
    parameters: dict[str, Any]
    handler: Handler
    timeout_seconds: float = 30
    risk: str = "read"
    auto_execute: bool = True
    parallel: bool = False
    enabled: bool = True


class ToolRegistry:
    def __init__(self) -> None:
        self._tools: dict[str, ToolEntry] = {}

    def register(self, entry: ToolEntry) -> None:
        if entry.name in self._tools:
            raise ValueError(f"Duplicate tool: {entry.name}")
        self._tools[entry.name] = entry

    def definitions(self) -> list[dict[str, Any]]:
        return [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.parameters,
                },
            }
            for tool in self._tools.values() if tool.enabled
        ]

    def get(self, name: str) -> ToolEntry | None:
        return self._tools.get(name)

    def list(self) -> list[ToolEntry]:
        return list(self._tools.values())

    @staticmethod
    def _validate(schema: dict[str, Any], arguments: dict[str, Any]) -> str | None:
        if not isinstance(arguments, dict):
            return "Arguments must be a JSON object."
        properties = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in arguments:
                return f"Missing required argument: {key}"
        if schema.get("additionalProperties") is False:
            extra = set(arguments) - set(properties)
            if extra:
                return f"Unknown argument: {sorted(extra)[0]}"
        type_map = {"string": str, "integer": int, "number": (int, float), "boolean": bool, "array": list, "object": dict}
        for key, value in arguments.items():
            rule = properties.get(key, {})
            expected = type_map.get(rule.get("type"))
            if expected and (not isinstance(value, expected) or rule.get("type") == "integer" and isinstance(value, bool)):
                return f"Invalid type for {key}: expected {rule['type']}"
            if isinstance(value, (int, float)):
                if "minimum" in rule and value < rule["minimum"]:
                    return f"{key} must be at least {rule['minimum']}"
                if "maximum" in rule and value > rule["maximum"]:
                    return f"{key} must be at most {rule['maximum']}"
        return None

    async def dispatch(self, name: str, arguments: dict[str, Any], *, approved: bool = False) -> ToolResult:
        started = time.monotonic()
        entry = self._tools.get(name)
        if not entry or not entry.enabled:
            return ToolResult(False, name, "Tool is not available.", error=f"Unknown tool: {name}")
        if (entry.risk != "read" or not entry.auto_execute) and not approved:
            return ToolResult(False, name, "Tool requires approval and cannot run in read-only mode.", error="approval_required")
        validation_error = self._validate(entry.parameters, arguments)
        if validation_error:
            return ToolResult(False, name, "Tool arguments were rejected.", error=validation_error)
        try:
            if inspect.iscoroutinefunction(entry.handler):
                value = await asyncio.wait_for(entry.handler(**arguments), timeout=entry.timeout_seconds)
            else:
                value = await asyncio.wait_for(asyncio.to_thread(entry.handler, **arguments), timeout=entry.timeout_seconds)
                if inspect.isawaitable(value):
                    value = await asyncio.wait_for(value, timeout=entry.timeout_seconds)
            if not isinstance(value, ToolResult):
                value = ToolResult(True, name, "Tool completed.", data=value)
            value.duration_ms = int((time.monotonic() - started) * 1000)
            return value
        except asyncio.TimeoutError:
            return ToolResult(False, name, "Tool timed out.", error="timeout", retryable=True,
                              duration_ms=int((time.monotonic() - started) * 1000))
        except Exception as exc:
            return ToolResult(False, name, "Tool failed safely.", error=str(exc),
                              duration_ms=int((time.monotonic() - started) * 1000))
