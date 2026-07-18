from __future__ import annotations

import fnmatch
from pathlib import Path
from typing import Iterator

from ..registry import ToolEntry, ToolRegistry
from ..results import ToolResult
from ..security import SecurityError, is_sensitive_path, resolve_workspace_path

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


class FilesystemTools:
    def __init__(self, workspace_root: str) -> None:
        self.root = Path(workspace_root).resolve(strict=True)
        if is_sensitive_path(self.root):
            raise SecurityError("The configured workspace itself is a protected path.")

    def list(self, path: str = ".", max_entries: int = 200) -> ToolResult:
        target = resolve_workspace_path(self.root, path)
        if not target.is_dir():
            raise ValueError("Path is not a directory.")
        entries = []
        truncated = False
        for child in sorted(target.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower())):
            relative = child.relative_to(self.root)
            if is_sensitive_path(relative) or child.is_symlink():
                continue
            if len(entries) >= max_entries:
                truncated = True
                break
            entries.append({"path": relative.as_posix(), "name": child.name, "type": "directory" if child.is_dir() else "file", "size": child.stat().st_size if child.is_file() else None})
        return ToolResult(True, "filesystem_list", f"Listed {len(entries)} workspace entries.", entries,
                          truncated=truncated, provenance={"workspace": str(self.root), "path": path})

    def read(self, path: str, start_line: int = 1, max_chars: int = 30000) -> ToolResult:
        target = resolve_workspace_path(self.root, path)
        if not target.is_file():
            raise ValueError("Path is not a file.")
        if target.stat().st_size > MAX_FILE_BYTES:
            raise ValueError("File exceeds the 2 MB read-only limit.")
        text = _decode(target.read_bytes())
        lines = text.splitlines()
        content = "\n".join(lines[max(0, start_line - 1):])
        truncated = len(content) > max_chars
        content = content[:max_chars]
        relative = target.relative_to(self.root).as_posix()
        return ToolResult(True, "filesystem_read", f"Read {relative}.", {
            "path": relative, "start_line": start_line, "content": content,
            "line_count": len(lines),
        }, truncated=truncated, provenance={"workspace": str(self.root), "path": relative})

    def _files(self, target: Path) -> Iterator[Path]:
        candidates = [target] if target.is_file() else target.rglob("*")
        for item in candidates:
            try:
                relative = item.relative_to(self.root)
                if item.is_file() and not item.is_symlink() and not is_sensitive_path(relative) and item.stat().st_size <= MAX_FILE_BYTES:
                    yield item
            except (OSError, ValueError):
                continue

    def search(self, query: str, path: str = ".", glob: str = "*", max_results: int = 100) -> ToolResult:
        target = resolve_workspace_path(self.root, path)
        needle = query.casefold()
        matches = []
        truncated = False
        for file in self._files(target):
            relative = file.relative_to(self.root).as_posix()
            if not fnmatch.fnmatch(file.name, glob) and not fnmatch.fnmatch(relative, glob):
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
                    matches.append({"path": relative, "line": line_number, "text": line.strip()[:500]})
            if truncated:
                break
        return ToolResult(True, "filesystem_search", f"Found {len(matches)} matching lines.", matches,
                          truncated=truncated, provenance={"workspace": str(self.root), "path": path, "query": query})


def register_filesystem_tools(registry: ToolRegistry, workspace_root: str) -> None:
    tools = FilesystemTools(workspace_root)
    registry.register(ToolEntry("filesystem_list", "List files and directories inside the configured workspace. Sensitive and generated directories are omitted.", {
        "type": "object", "properties": {"path": {"type": "string"}, "max_entries": {"type": "integer", "minimum": 1, "maximum": 500}}, "additionalProperties": False,
    }, tools.list, 15))
    registry.register(ToolEntry("filesystem_read", "Read a text file inside the configured workspace. This tool cannot read secrets, binary files, links, or files outside the workspace.", {
        "type": "object", "properties": {"path": {"type": "string"}, "start_line": {"type": "integer", "minimum": 1}, "max_chars": {"type": "integer", "minimum": 100, "maximum": 50000}}, "required": ["path"], "additionalProperties": False,
    }, tools.read, 15))
    registry.register(ToolEntry("filesystem_search", "Search text in files inside the configured workspace. Results include file paths, line numbers, and short snippets.", {
        "type": "object", "properties": {"query": {"type": "string"}, "path": {"type": "string"}, "glob": {"type": "string"}, "max_results": {"type": "integer", "minimum": 1, "maximum": 200}}, "required": ["query"], "additionalProperties": False,
    }, tools.search, 30))
