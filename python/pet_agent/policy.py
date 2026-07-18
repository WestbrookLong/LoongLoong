from __future__ import annotations

import hashlib
import json
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

from .security import SecurityError, is_sensitive_path

ApprovalHandler = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


@dataclass
class CapabilityGrant:
    id: str
    root_path: Path
    operations: set[str]
    scope: str = "task"
    allow_sensitive: bool = False
    expires_at: float | None = None

    def valid_for(self, target: Path, operation: str, sensitive: bool) -> bool:
        if self.expires_at and time.time() > self.expires_at:
            return False
        if operation not in self.operations:
            return False
        if sensitive and not self.allow_sensitive:
            return False
        try:
            target.relative_to(self.root_path)
            return True
        except ValueError:
            return False


@dataclass
class Authorization:
    allowed: bool
    approved: bool = False
    approval_id: str | None = None
    error: str | None = None


class CapabilityPolicy:
    PATH_TOOLS = {
        "filesystem_list": "read",
        "filesystem_read": "read",
        "filesystem_search": "read",
        "filesystem_write": "write",
        "filesystem_replace": "write",
        "filesystem_create_directory": "write",
    }

    def __init__(self, workspace_root: str, approval_handler: ApprovalHandler, grants: list[dict[str, Any]] | None = None) -> None:
        self.workspace_root = Path(workspace_root).resolve(strict=True)
        self.approval_handler = approval_handler
        self.grants: list[CapabilityGrant] = []
        for raw in grants or []:
            try:
                self.grants.append(CapabilityGrant(
                    id=str(raw.get("id") or uuid.uuid4()),
                    root_path=Path(raw["root_path"]).resolve(strict=True),
                    operations=set(raw.get("operations") or ["read"]),
                    scope=str(raw.get("scope") or "persistent"),
                    allow_sensitive=bool(raw.get("allow_sensitive", False)),
                    expires_at=float(raw["expires_at"]) if raw.get("expires_at") else None,
                ))
            except (KeyError, OSError, ValueError):
                continue

    def target_path(self, requested: str) -> Path:
        raw = str(requested or ".").strip()
        lowered = raw.lower()
        if lowered.startswith(("\\\\.\\", "\\\\?\\", "\\\\")):
            raise SecurityError("Device, extended-length, and network-share paths are not supported.")
        path = Path(raw)
        return (path if path.is_absolute() else self.workspace_root / path).resolve(strict=False)

    def _workspace_contains(self, target: Path) -> bool:
        try:
            target.relative_to(self.workspace_root)
            return True
        except ValueError:
            return False

    def _grant_for(self, target: Path, operation: str, sensitive: bool) -> CapabilityGrant | None:
        return next((grant for grant in self.grants if grant.valid_for(target, operation, sensitive)), None)

    def roots_for(self, operation: str, *, sensitive: bool = False) -> list[Path]:
        roots = [self.workspace_root] if operation == "read" and not sensitive else []
        roots.extend(grant.root_path for grant in self.grants if operation in grant.operations and (not sensitive or grant.allow_sensitive))
        return roots

    def allow_sensitive_for(self, target: Path, operation: str) -> bool:
        return bool(self._grant_for(target, operation, True))

    async def authorize(self, tool: str, arguments: dict[str, Any], preview: dict[str, Any] | None = None,
                        context: dict[str, Any] | None = None) -> Authorization:
        if tool in {"web_search", "web_read"}:
            return Authorization(True)
        if tool == "process_execute":
            return await self._authorize_command(arguments, context or {})
        operation = self.PATH_TOOLS.get(tool)
        if not operation:
            return Authorization(True)
        try:
            target = self.target_path(arguments.get("path", "."))
        except (OSError, SecurityError, ValueError) as exc:
            return Authorization(False, error=str(exc))
        sensitive = is_sensitive_path(target)
        if operation == "read" and self._workspace_contains(target) and not sensitive:
            return Authorization(True)
        if self._grant_for(target, operation, sensitive):
            return Authorization(True, approved=True)
        approval_id = str(uuid.uuid4())
        suggested_root = target if target.is_dir() else target.parent
        request = {
            **(context or {}),
            "approval_id": approval_id,
            "tool": tool,
            "operation": "sensitive_read" if operation == "read" and sensitive else operation,
            "risk": "high" if sensitive or operation == "write" else "medium",
            "resource_kind": "path",
            "requested_path": str(target),
            "suggested_root": str(suggested_root),
            "sensitive": sensitive,
            "preview": preview or {},
            "reason": "The Agent needs explicit access outside its automatic read workspace." if not sensitive else "This path may contain credentials or other sensitive data that could be sent to the model.",
        }
        response = await self.approval_handler(request)
        if response.get("decision") != "approve":
            return Authorization(False, approval_id=approval_id, error=f"User {response.get('decision', 'denied')} the request.")
        root = Path(response.get("root_path") or suggested_root).resolve(strict=False)
        try:
            target.relative_to(root)
        except ValueError:
            return Authorization(False, approval_id=approval_id, error="Approved root does not contain the requested path.")
        granted_operation = operation
        grant = CapabilityGrant(
            id=str(response.get("grant_id") or approval_id),
            root_path=root,
            operations={granted_operation},
            scope="once" if operation == "write" else str(response.get("scope") or "once"),
            allow_sensitive=sensitive and bool(response.get("allow_sensitive")),
            expires_at=float(response["expires_at"]) if response.get("expires_at") else None,
        )
        self.grants.append(grant)
        if sensitive and not grant.allow_sensitive:
            return Authorization(False, approval_id=approval_id, error="Sensitive access was not explicitly approved.")
        return Authorization(True, approved=True, approval_id=approval_id)

    def release_once(self, approval_id: str | None) -> None:
        if not approval_id:
            return
        self.grants = [grant for grant in self.grants if not (grant.id == approval_id and grant.scope == "once")]

    async def _authorize_command(self, arguments: dict[str, Any], context: dict[str, Any]) -> Authorization:
        executable = str(arguments.get("executable") or "")
        args = [str(item) for item in arguments.get("args") or []]
        try:
            cwd = self.target_path(arguments.get("cwd") or ".")
        except (OSError, SecurityError, ValueError) as exc:
            return Authorization(False, error=str(exc))
        signature = hashlib.sha256(json.dumps([executable, args, str(cwd)], ensure_ascii=False).encode()).hexdigest()
        approval_id = str(uuid.uuid4())
        response = await self.approval_handler({
            **context,
            "approval_id": approval_id,
            "tool": "process_execute",
            "operation": "execute",
            "risk": "high",
            "resource_kind": "command",
            "requested_path": str(cwd),
            "suggested_root": str(cwd),
            "command": {"executable": executable, "args": args, "cwd": str(cwd), "signature": signature},
            "reason": "Commands run with the current Windows user's permissions and are not a filesystem sandbox.",
        })
        if response.get("decision") != "approve":
            return Authorization(False, approval_id=approval_id, error=f"User {response.get('decision', 'denied')} the command.")
        return Authorization(True, approved=True, approval_id=approval_id)
