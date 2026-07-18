from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable

import httpx

from .unicode_safety import SurrogateStream, repair_surrogates, repair_value


@dataclass
class ToolCall:
    id: str
    name: str
    arguments_text: str


@dataclass
class ModelStep:
    content: str = ""
    reasoning_content: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    finish_reason: str | None = None
    usage: dict[str, Any] = field(default_factory=dict)


def parse_sse_payloads(lines: list[str]) -> ModelStep:
    result = ModelStep()
    calls: dict[int, dict[str, str]] = {}
    for line in lines:
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        item = json.loads(data)
        if item.get("usage"):
            result.usage = item["usage"]
        choice = (item.get("choices") or [{}])[0]
        delta = choice.get("delta") or {}
        result.content += delta.get("content") or ""
        result.reasoning_content += delta.get("reasoning_content") or ""
        result.finish_reason = choice.get("finish_reason") or result.finish_reason
        for part in delta.get("tool_calls") or []:
            index = int(part.get("index", 0))
            call = calls.setdefault(index, {"id": "", "name": "", "arguments": ""})
            call["id"] += part.get("id") or ""
            function = part.get("function") or {}
            call["name"] += function.get("name") or ""
            call["arguments"] += function.get("arguments") or ""
    result.content = repair_surrogates(result.content)
    result.reasoning_content = repair_surrogates(result.reasoning_content)
    result.tool_calls = [ToolCall(
        repair_surrogates(value["id"] or f"call_{index}"),
        repair_surrogates(value["name"]),
        repair_surrogates(value["arguments"]),
    ) for index, value in sorted(calls.items())]
    return result


class OpenAICompatibleProvider:
    def __init__(self, *, base_url: str, api_key: str, model: str, temperature: float = 0.7) -> None:
        self.url = f"{base_url.rstrip('/')}/chat/completions"
        self.api_key = api_key
        self.model = model
        self.temperature = temperature

    async def stream_step(self, messages: list[dict[str, Any]], tools: list[dict[str, Any]],
                          on_event: Callable[[dict[str, Any]], None]) -> ModelStep:
        body = repair_value({
            "model": self.model, "messages": messages, "tools": tools, "tool_choice": "auto",
            "parallel_tool_calls": False, "temperature": self.temperature, "stream": True,
            "stream_options": {"include_usage": True}, "enable_thinking": True,
        })
        headers = {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}
        async with httpx.AsyncClient(timeout=httpx.Timeout(90, connect=20), follow_redirects=False) as client:
            response = await client.send(client.build_request("POST", self.url, headers=headers, json=body), stream=True)
            if response.status_code == 400:
                await response.aclose()
                body.pop("enable_thinking", None)
                response = await client.send(client.build_request("POST", self.url, headers=headers, json=body), stream=True)
            if response.status_code >= 400:
                raw = (await response.aread()).decode("utf-8", "replace")[:1000]
                raise RuntimeError(f"Model API returned HTTP {response.status_code}: {raw}")
            calls: dict[int, dict[str, str]] = {}
            result = ModelStep()
            reasoning_stream = SurrogateStream()
            content_stream = SurrogateStream()
            async for line in response.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data or data == "[DONE]":
                    continue
                item = json.loads(data)
                if item.get("usage"):
                    result.usage = item["usage"]
                choice = (item.get("choices") or [{}])[0]
                delta = choice.get("delta") or {}
                reasoning = reasoning_stream.feed(delta.get("reasoning_content") or "")
                content = content_stream.feed(delta.get("content") or "")
                if reasoning:
                    result.reasoning_content += reasoning
                    on_event({"type": "reasoning_delta", "text": reasoning})
                if content:
                    result.content += content
                    on_event({"type": "answer_delta", "text": content})
                result.finish_reason = choice.get("finish_reason") or result.finish_reason
                for part in delta.get("tool_calls") or []:
                    index = int(part.get("index", 0))
                    call = calls.setdefault(index, {"id": "", "name": "", "arguments": ""})
                    call["id"] += part.get("id") or ""
                    function = part.get("function") or {}
                    call["name"] += function.get("name") or ""
                    call["arguments"] += function.get("arguments") or ""
            reasoning_tail = reasoning_stream.finish()
            content_tail = content_stream.finish()
            if reasoning_tail:
                result.reasoning_content += reasoning_tail
                on_event({"type": "reasoning_delta", "text": reasoning_tail})
            if content_tail:
                result.content += content_tail
                on_event({"type": "answer_delta", "text": content_tail})
            await response.aclose()
            result.tool_calls = [ToolCall(
                repair_surrogates(value["id"] or f"call_{index}"),
                repair_surrogates(value["name"]),
                repair_surrogates(value["arguments"]),
            ) for index, value in sorted(calls.items())]
            return result
