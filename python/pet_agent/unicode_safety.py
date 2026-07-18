from __future__ import annotations

from typing import Any

REPLACEMENT = "\ufffd"


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
        return repair_surrogates(value)
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
