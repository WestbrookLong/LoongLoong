from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any


@dataclass
class ToolResult:
    ok: bool
    tool: str
    summary: str
    data: Any = None
    error: str | None = None
    retryable: bool = False
    duration_ms: int = 0
    truncated: bool = False
    provenance: dict[str, Any] = field(default_factory=dict)
    untrusted: bool = True

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)
