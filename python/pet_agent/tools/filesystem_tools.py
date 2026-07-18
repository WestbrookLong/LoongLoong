from __future__ import annotations

import difflib
import fnmatch
import hashlib
import os
import uuid
from pathlib import Path
from typing import Iterator

from ..policy import CapabilityPolicy
from ..registry import ToolEntry, ToolRegistry
from ..results import ToolResult
from ..security import SecurityError, is_sensitive_path, resolve_authorized_path

MAX_FILE_BYTES = 2_000_000


def _decode(raw: bytes) -> str:
    if b"\x00" in raw[:4096]:
        for encoding in ("utf-16", "utf-16-le", "utf-16-be"):
            try:
                return raw.decode(encoding)
            except UnicodeError:
                continue
        raise ValueError("Binary files cannot be read.")
    for encoding in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return raw.decode(encoding)
        except UnicodeError:
            continue
    raise ValueError("The file encoding is not supported.")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


class FilesystemTools:
    def __init__(self, policy: CapabilityPolicy | str) -> None:
        if isinstance(policy, str):
            async def deny(_request):
                return {"decision": "deny"}
            policy = CapabilityPolicy(policy, deny)
        self.policy = policy
        self.root = policy.workspace_root
        if is_sensitive_path(self.root):
            raise SecurityError("The configured workspace itself is a protected path.")

    def _resolve(self, requested: str, operation: str = "read", *, must_exist: bool = True) -> Path:
        target = self.policy.target_path(requested)
        sensitive = is_sensitive_path(target)
        return resolve_authorized_path(
            self.root,
            self.policy.roots_for(operation, sensitive=sensitive),
            requested,
            must_exist=must_exist,
            allow_sensitive=self.policy.allow_sensitive_for(target, operation),
        )

    def _display(self, target: Path) -> str:
        try:
            return target.relative_to(self.root).as_posix()
        except ValueError:
            return str(target)

    def list(self, path: str = ".", max_entries: int = 200) -> ToolResult:
        target = self._resolve(path)
        if not target.is_dir():
            raise ValueError("Path is not a directory.")
        entries = []
        truncated = False
        for child in sorted(target.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower())):
            if child.is_symlink() or (is_sensitive_path(child) and not self.policy.allow_sensitive_for(child, "read")):
                continue
            if len(entries) >= max_entries:
                truncated = True
                break
            entries.append({"path": self._display(child), "name": child.name, "type": "directory" if child.is_dir() else "file", "size": child.stat().st_size if child.is_file() else None})
        return ToolResult(True, "filesystem_list", f"Listed {len(entries)} entries.", entries,
                          truncated=truncated, provenance={"path": str(target)})

    def read(self, path: str, start_line: int = 1, max_chars: int = 30000) -> ToolResult:
        target = self._resolve(path)
        if not target.is_file():
            raise ValueError("Path is not a file.")
        if target.stat().st_size > MAX_FILE_BYTES:
            raise ValueError("File exceeds the 2 MB read limit.")
        text = _decode(target.read_bytes())
        lines = text.splitlines()
        content = "\n".join(lines[max(0, start_line - 1):])
        truncated = len(content) > max_chars
        display = self._display(target)
        return ToolResult(True, "filesystem_read", f"Read {display}.", {
            "path": display, "start_line": start_line, "content": content[:max_chars], "line_count": len(lines),
        }, truncated=truncated, provenance={"path": str(target)})

    def _files(self, target: Path) -> Iterator[Path]:
        candidates = [target] if target.is_file() else target.rglob("*")
        for item in candidates:
            try:
                if (item.is_file() and not item.is_symlink() and item.stat().st_size <= MAX_FILE_BYTES and
                        (not is_sensitive_path(item) or self.policy.allow_sensitive_for(item, "read"))):
                    yield item
            except OSError:
                continue

    def search(self, query: str, path: str = ".", glob: str = "*", max_results: int = 100) -> ToolResult:
        target = self._resolve(path)
        needle = query.casefold()
        matches = []
        truncated = False
        for file in self._files(target):
            display = self._display(file)
            if not fnmatch.fnmatch(file.name, glob) and not fnmatch.fnmatch(display, glob):
                continue
            try:
                text = _decode(file.read_bytes())
            except (OSError, ValueError):
                continue
            for line_number, line in enumerate(text.splitlines(), 1):
                if needle in line.casefold():
                    if len(matches) >= max_results:
                        truncated = True
                        break
                    matches.append({"path": display, "line": line_number, "text": line.strip()[:500]})
            if truncated:
                break
        return ToolResult(True, "filesystem_search", f"Found {len(matches)} matching lines.", matches,
                          truncated=truncated, provenance={"path": str(target), "query": query})

    def preview_write(self, path: str, content: str) -> dict:
        target = self.policy.target_path(path)
        old_text = ""
        existing_sha256 = None
        existing_read = False
        if target.exists() and target.is_file():
            existing_sha256 = _sha256_file(target)
            try:
                readable = self._resolve(path, "read")
                raw = readable.read_bytes()
                if len(raw) <= MAX_FILE_BYTES:
                    old_text = _decode(raw)
                    existing_read = True
            except (OSError, ValueError, SecurityError):
                pass
        diff = "".join(difflib.unified_diff(
            old_text.splitlines(True), content.splitlines(True),
            fromfile=str(target), tofile=str(target), lineterm="\n",
        )) if existing_read or not target.exists() else ""
        return {
            "path": str(target), "kind": "modify" if target.exists() else "create",
            "diff": diff[:16000], "diff_truncated": len(diff) > 16000,
            "proposed_chars": len(content), "existing_sha256": existing_sha256,
            "existing_content_unavailable": target.exists() and not existing_read,
            "proposed_preview": content[:16000] if target.exists() and not existing_read else "",
            "proposed_preview_truncated": target.exists() and not existing_read and len(content) > 16000,
        }

    def write(self, path: str, content: str, expected_sha256: str = "") -> ToolResult:
        target = self._resolve(path, "write", must_exist=False)
        if len(content.encode("utf-8")) > MAX_FILE_BYTES:
            raise ValueError("Proposed file exceeds the 2 MB write limit.")
        if not target.parent.exists() or not target.parent.is_dir():
            raise ValueError("Parent directory does not exist.")
        existed = target.exists()
        if existed and not expected_sha256:
            raise ValueError("An existing file requires an approved content hash.")
        if existed and expected_sha256 == "__absent__":
            raise ValueError("A file appeared after approval; write was cancelled.")
        if existed and _sha256_file(target) != expected_sha256:
            raise ValueError("File changed after approval; write was cancelled.")
        if not existed and expected_sha256 not in {"", "__absent__"}:
            raise ValueError("File disappeared after approval; write was cancelled.")
        temporary = target.with_name(f".{target.name}.pet-agent-{uuid.uuid4().hex}.tmp")
        try:
            with temporary.open("w", encoding="utf-8", newline="") as stream:
                stream.write(content)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, target)
        finally:
            if temporary.exists():
                temporary.unlink()
        return ToolResult(True, "filesystem_write", f"Wrote {self._display(target)} atomically.", {
            "path": self._display(target), "bytes": target.stat().st_size,
            "sha256": _sha256_file(target), "created": not existed,
        }, provenance={"path": str(target)})

    def preview_replace(self, path: str, old_text: str, new_text: str, replace_all: bool = False) -> dict:
        target = self.policy.target_path(path)
        try:
            readable = self._resolve(path, "read")
            raw = readable.read_bytes()
            current = _decode(raw)
            updated = current.replace(old_text, new_text) if replace_all else current.replace(old_text, new_text, 1)
            preview = self.preview_write(path, updated)
            preview["match_count"] = current.count(old_text)
            preview["replace_all"] = replace_all
            return preview
        except (OSError, ValueError, SecurityError):
            return {
                "path": str(target), "kind": "replace", "existing_content_unavailable": True,
                "old_chars": len(old_text), "new_chars": len(new_text), "replace_all": replace_all,
            }

    def replace(self, path: str, old_text: str, new_text: str, replace_all: bool = False) -> ToolResult:
        if not old_text:
            raise ValueError("old_text cannot be empty.")
        target = self._resolve(path, "write")
        if target.stat().st_size > MAX_FILE_BYTES:
            raise ValueError("File exceeds the 2 MB replace limit.")
        raw = target.read_bytes()
        current = _decode(raw)
        count = current.count(old_text)
        if count == 0:
            raise ValueError("old_text was not found; no file was changed.")
        updated = current.replace(old_text, new_text) if replace_all else current.replace(old_text, new_text, 1)
        result = self.write(path, updated, hashlib.sha256(raw).hexdigest())
        result.tool = "filesystem_replace"
        result.summary = f"Replaced {'all' if replace_all else 'one'} occurrence in {self._display(target)}."
        if isinstance(result.data, dict):
            result.data["matched_occurrences"] = count
            result.data["replaced_occurrences"] = count if replace_all else 1
        return result

    def create_directory(self, path: str) -> ToolResult:
        target = self._resolve(path, "write", must_exist=False)
        if target.exists():
            if target.is_dir():
                return ToolResult(True, "filesystem_create_directory", f"Directory already exists: {self._display(target)}.", {"path": self._display(target), "created": False})
            raise ValueError("A file already exists at this path.")
        if not target.parent.exists():
            raise ValueError("Parent directory does not exist; recursive creation is not allowed.")
        target.mkdir()
        return ToolResult(True, "filesystem_create_directory", f"Created {self._display(target)}.", {"path": self._display(target), "created": True}, provenance={"path": str(target)})


def register_filesystem_tools(registry: ToolRegistry, policy: CapabilityPolicy) -> FilesystemTools:
    tools = FilesystemTools(policy)
    registry.register(ToolEntry("filesystem_list", "List a directory. The configured workspace is automatic; other locations require user approval.", {
        "type": "object", "properties": {"path": {"type": "string"}, "max_entries": {"type": "integer", "minimum": 1, "maximum": 500}}, "additionalProperties": False,
    }, tools.list, 15))
    registry.register(ToolEntry("filesystem_read", "Read a text file. External or sensitive paths pause for explicit user approval.", {
        "type": "object", "properties": {"path": {"type": "string"}, "start_line": {"type": "integer", "minimum": 1}, "max_chars": {"type": "integer", "minimum": 100, "maximum": 50000}}, "required": ["path"], "additionalProperties": False,
    }, tools.read, 15))
    registry.register(ToolEntry("filesystem_search", "Search text recursively in an approved directory.", {
        "type": "object", "properties": {"query": {"type": "string"}, "path": {"type": "string"}, "glob": {"type": "string"}, "max_results": {"type": "integer", "minimum": 1, "maximum": 200}}, "required": ["query"], "additionalProperties": False,
    }, tools.search, 30))
    registry.register(ToolEntry("filesystem_write", "Create or replace one UTF-8 text file. Every write requires a user-approved preview and is applied atomically.", {
        "type": "object", "properties": {"path": {"type": "string"}, "content": {"type": "string"}, "expected_sha256": {"type": "string"}}, "required": ["path", "content"], "additionalProperties": False,
    }, tools.write, 20, risk="write", auto_execute=False))
    registry.register(ToolEntry("filesystem_replace", "Replace one exact text fragment, or all exact matches, in a UTF-8 file. A Diff is shown for approval before an atomic write.", {
        "type": "object", "properties": {
            "path": {"type": "string"}, "old_text": {"type": "string"}, "new_text": {"type": "string"}, "replace_all": {"type": "boolean"},
        }, "required": ["path", "old_text", "new_text"], "additionalProperties": False,
    }, tools.replace, 20, risk="write", auto_execute=False))
    registry.register(ToolEntry("filesystem_create_directory", "Create exactly one directory. Parent directories must already exist and user approval is required.", {
        "type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"], "additionalProperties": False,
    }, tools.create_directory, 15, risk="write", auto_execute=False))
    return tools
