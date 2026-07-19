from __future__ import annotations

import re
from typing import Any

REPLACEMENT = "\ufffd"
MOJIBAKE_LEADS = frozenset("ÃÂâðçåæäéèêëìíîïòóôõöùúûü")
WINDOWS_PATH_RE = re.compile(r"[A-Za-z]:\\[^\r\n`\"<>|]+?\.[A-Za-z0-9]{1,10}")


def _legacy_bytes(value: str) -> bytes | None:
    output = bytearray()
    for character in value:
        try:
            encoded = character.encode("cp1252")
        except UnicodeEncodeError:
            code = ord(character)
            if code > 255:
                return None
            encoded = bytes([code])
        output.extend(encoded)
    return bytes(output)


def _repair_mojibake_cluster(value: str) -> str:
    raw = _legacy_bytes(value)
    if raw is None:
        return value
    try:
        candidate = raw.decode("utf-8")
    except UnicodeDecodeError:
        return value
    original_cjk = sum("\u3400" <= char <= "\u9fff" for char in value)
    candidate_cjk = sum("\u3400" <= char <= "\u9fff" for char in candidate)
    original_leads = sum(char in MOJIBAKE_LEADS for char in value)
    candidate_leads = sum(char in MOJIBAKE_LEADS for char in candidate)
    candidate_emoji = sum(ord(char) > 0xffff for char in candidate)
    if candidate_cjk > original_cjk or candidate_emoji or candidate_leads < original_leads:
        return candidate
    return value


def repair_utf8_mojibake(value: str) -> str:
    """Repair UTF-8 text that was accidentally decoded through a legacy code page."""
    output: list[str] = []
    cluster: list[str] = []

    def flush() -> None:
        if cluster:
            output.append(_repair_mojibake_cluster("".join(cluster)))
            cluster.clear()

    for character in str(value):
        if ord(character) > 127 and _legacy_bytes(character) is not None:
            cluster.append(character)
        else:
            flush()
            output.append(character)
    flush()
    return "".join(output)


def extract_windows_paths(value: str) -> list[str]:
    return [match.group(0) for match in WINDOWS_PATH_RE.finditer(str(value))]


def repair_known_paths(value: str, known_paths: list[str]) -> str:
    """Ground a damaged generated path to an exact path present in the user message."""
    known_exact = {path.casefold(): path for path in known_paths}
    known_by_skeleton: dict[str, list[str]] = {}
    for path in known_paths:
        skeleton = "".join(char.casefold() for char in path if ord(char) < 128)
        candidates = known_by_skeleton.setdefault(skeleton, [])
        if path not in candidates:
            candidates.append(path)

    def replace(match: re.Match[str]) -> str:
        candidate = match.group(0)
        exact = known_exact.get(candidate.casefold())
        if exact is not None:
            return exact
        skeleton = "".join(char.casefold() for char in candidate if ord(char) < 128)
        matches = known_by_skeleton.get(skeleton, [])
        # An ASCII-only skeleton is intentionally lossy. Chinese filenames in the
        # same directory can all collapse to `...\\Thought\\.md`; only ground a
        # damaged path when that skeleton identifies one unique user path.
        return matches[0] if len(matches) == 1 else candidate

    return WINDOWS_PATH_RE.sub(replace, str(value))


def repair_surrogates(value: str) -> str:
    """Combine valid UTF-16 surrogate pairs and replace unpaired code units."""
    text = str(value)
    output: list[str] = []
    index = 0
    while index < len(text):
        code = ord(text[index])
        if 0xD800 <= code <= 0xDBFF:
            if index + 1 < len(text):
                low = ord(text[index + 1])
                if 0xDC00 <= low <= 0xDFFF:
                    output.append(chr(0x10000 + ((code - 0xD800) << 10) + low - 0xDC00))
                    index += 2
                    continue
            output.append(REPLACEMENT)
        elif 0xDC00 <= code <= 0xDFFF:
            output.append(REPLACEMENT)
        else:
            output.append(text[index])
        index += 1
    return "".join(output)


def repair_value(value: Any) -> Any:
    if isinstance(value, str):
        return repair_utf8_mojibake(repair_surrogates(value))
    if isinstance(value, list):
        return [repair_value(item) for item in value]
    if isinstance(value, tuple):
        return tuple(repair_value(item) for item in value)
    if isinstance(value, dict):
        return {repair_surrogates(str(key)): repair_value(item) for key, item in value.items()}
    return value


class SurrogateStream:
    """Repairs text streams where a UTF-16 pair may be split across SSE deltas."""

    def __init__(self) -> None:
        self._pending_high = ""

    def feed(self, value: str) -> str:
        text = self._pending_high + str(value or "")
        self._pending_high = ""
        if text and 0xD800 <= ord(text[-1]) <= 0xDBFF:
            self._pending_high = text[-1]
            text = text[:-1]
        return repair_surrogates(text)

    def finish(self) -> str:
        if not self._pending_high:
            return ""
        self._pending_high = ""
        return REPLACEMENT


class ModelTextStream:
    """Repair surrogate fragments and legacy-decoded UTF-8 while preserving streaming."""

    def __init__(self, known_paths: list[str] | None = None) -> None:
        self._surrogates = SurrogateStream()
        self._pending_legacy = ""
        self._pending_path = ""
        self._known_paths = known_paths or []

    def _repair_ready(self, text: str, *, final: bool = False) -> str:
        output: list[str] = []
        for character in text:
            if ord(character) > 127 and _legacy_bytes(character) is not None:
                self._pending_legacy += character
            else:
                if self._pending_legacy:
                    output.append(_repair_mojibake_cluster(self._pending_legacy))
                    self._pending_legacy = ""
                output.append(character)
        if final and self._pending_legacy:
            output.append(_repair_mojibake_cluster(self._pending_legacy))
            self._pending_legacy = ""
        return "".join(output)

    def feed(self, value: str) -> str:
        repaired = self._repair_ready(self._surrogates.feed(value))
        combined = self._pending_path + repaired
        self._pending_path = ""
        path_start = re.search(r"[A-Za-z]:\\", combined)
        if not path_start:
            # Keep enough tail to recognize a drive prefix split across deltas.
            keep = min(2, len(combined))
            self._pending_path = combined[-keep:]
            return combined[:-keep] if keep else combined
        prefix = combined[:path_start.start()]
        candidate = combined[path_start.start():]
        terminator = re.search(r"[\r\n`\"]", candidate)
        if terminator:
            end = terminator.start()
            grounded = repair_known_paths(candidate[:end], self._known_paths)
            return prefix + grounded + candidate[end:]
        self._pending_path = candidate
        return prefix

    def finish(self) -> str:
        repaired = self._repair_ready(self._surrogates.finish(), final=True)
        result = repair_known_paths(self._pending_path + repaired, self._known_paths)
        self._pending_path = ""
        return result
