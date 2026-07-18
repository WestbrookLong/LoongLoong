from __future__ import annotations

import asyncio
import ipaddress
import socket
from pathlib import Path
from urllib.parse import urlsplit


class SecurityError(ValueError):
    pass


DENIED_PARTS = {".pet-data", ".git", "node_modules", ".ssh"}
DENIED_SUFFIXES = {".pem", ".key", ".pfx", ".p12"}


def is_sensitive_path(path: Path) -> bool:
    lowered = [part.lower() for part in path.parts]
    if any(part in DENIED_PARTS for part in lowered):
        return True
    name = path.name.lower()
    return name == ".env" or name.startswith(".env.") or name == "model-key.bin" or name.startswith("id_rsa") or path.suffix.lower() in DENIED_SUFFIXES


def resolve_workspace_path(root: Path, requested: str, *, must_exist: bool = True) -> Path:
    root = root.resolve(strict=True)
    if ".." in Path(requested).parts:
        raise SecurityError("Parent-directory traversal is not allowed.")
    raw_candidate = root / requested
    try:
        raw_relative = raw_candidate.absolute().relative_to(root)
    except ValueError as exc:
        raise SecurityError("Path escapes the configured workspace.") from exc
    cursor = root
    for part in raw_relative.parts:
        if part == "..":
            raise SecurityError("Parent-directory traversal is not allowed.")
        cursor = cursor / part
        if cursor.exists() and cursor.is_symlink():
            raise SecurityError("Symbolic links and reparse points are not allowed.")
        if cursor.exists():
            try:
                if cursor.stat().st_file_attributes & 0x400:
                    raise SecurityError("Symbolic links and reparse points are not allowed.")
            except AttributeError:
                pass
    candidate = raw_candidate.resolve(strict=must_exist)
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise SecurityError("Path escapes the configured workspace.") from exc
    if is_sensitive_path(candidate.relative_to(root)):
        raise SecurityError("Access to this path is denied by the read-only Agent policy.")
    cursor = root
    for part in candidate.relative_to(root).parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise SecurityError("Symbolic links and reparse points are not allowed.")
        try:
            attributes = cursor.stat().st_file_attributes
            if attributes & 0x400:
                raise SecurityError("Symbolic links and reparse points are not allowed.")
        except AttributeError:
            pass
    return candidate


def _check_ip(ip_text: str) -> None:
    ip = ipaddress.ip_address(ip_text.split("%", 1)[0])
    if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast or
            ip.is_reserved or ip.is_unspecified):
        raise SecurityError(f"Network address is not public: {ip}")


async def validate_public_url(url: str, *, resolve_dns: bool = True) -> str:
    parsed = urlsplit(str(url).strip())
    if parsed.scheme not in {"http", "https"}:
        raise SecurityError("Only HTTP and HTTPS URLs are allowed.")
    if not parsed.hostname or parsed.username or parsed.password:
        raise SecurityError("URL host is invalid.")
    hostname = parsed.hostname.rstrip(".").lower()
    if hostname == "localhost" or hostname.endswith(".localhost") or hostname in {"metadata.google.internal", "instance-data"}:
        raise SecurityError("Local and metadata hosts are blocked.")
    try:
        ipaddress.ip_address(hostname.split("%", 1)[0])
    except ValueError:
        pass
    else:
        _check_ip(hostname)
        return url
    if resolve_dns:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        infos = await asyncio.to_thread(socket.getaddrinfo, hostname, port, type=socket.SOCK_STREAM)
        if not infos:
            raise SecurityError("Host did not resolve.")
        for info in infos:
            _check_ip(info[4][0])
    return url
