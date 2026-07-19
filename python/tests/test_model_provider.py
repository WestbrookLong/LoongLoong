import json
import unittest
from unittest.mock import patch

from pet_agent.model_provider import OpenAICompatibleProvider, parse_sse_payloads
from pet_agent.unicode_safety import SurrogateStream, repair_surrogates, repair_value


class ModelProviderTests(unittest.TestCase):
    def test_fragmented_tool_calls_and_reasoning(self):
        chunks = [
            {"choices": [{"delta": {"reasoning_content": "think "}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "call_", "function": {"name": "web_", "arguments": "{\"query\":"}}]}}]},
            {"choices": [{"delta": {"tool_calls": [{"index": 0, "id": "1", "function": {"name": "search", "arguments": "\"Pet\"}"}}]}, "finish_reason": "tool_calls"}], "usage": {"total_tokens": 9}},
        ]
        result = parse_sse_payloads([f"data: {json.dumps(chunk)}" for chunk in chunks] + ["data: [DONE]"])
        self.assertEqual(result.reasoning_content, "think ")
        self.assertEqual(result.tool_calls[0].id, "call_1")
        self.assertEqual(result.tool_calls[0].name, "web_search")
        self.assertEqual(json.loads(result.tool_calls[0].arguments_text), {"query": "Pet"})
        self.assertEqual(result.usage["total_tokens"], 9)

    def test_repairs_surrogate_pair_split_across_stream_deltas(self):
        stream = SurrogateStream()
        first = stream.feed("thinking " + chr(0xD83D))
        second = stream.feed(chr(0xDC81) + " done")
        self.assertEqual(first, "thinking ")
        self.assertEqual(second, "💁 done")
        self.assertEqual(stream.finish(), "")
        chunks = [
            {"choices": [{"delta": {"reasoning_content": chr(0xD83D)}}]},
            {"choices": [{"delta": {"reasoning_content": chr(0xDC81)}, "finish_reason": "stop"}]},
        ]
        parsed = parse_sse_payloads([f"data: {json.dumps(chunk)}" for chunk in chunks])
        self.assertEqual(parsed.reasoning_content, "💁")

    def test_repairs_unpaired_surrogates_before_json_transport(self):
        lone_low = chr(0xDC81)
        self.assertEqual(repair_surrogates(f"a{lone_low}b"), "a�b")
        repaired = repair_value({"messages": [{"content": lone_low}]})
        self.assertEqual(repaired["messages"][0]["content"], "�")
        json.dumps(repaired, ensure_ascii=False).encode("utf-8")


class ModelProviderStreamingTests(unittest.IsolatedAsyncioTestCase):
    async def test_stream_transport_repairs_split_surrogates_and_request_messages(self):
        high = chr(0xD83D)
        low = chr(0xDC81)
        lines = [
            "data: " + json.dumps({"choices": [{"delta": {"reasoning_content": high}}]}),
            "data: " + json.dumps({"choices": [{"delta": {"reasoning_content": low}, "finish_reason": "stop"}]}),
            "data: [DONE]",
        ]

        class FakeResponse:
            status_code = 200

            async def aiter_bytes(self):
                for line in lines:
                    yield (line + "\n").encode("utf-8", "surrogatepass")

            async def aclose(self):
                return None

        class FakeClient:
            request_json = None

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            def build_request(self, _method, _url, **kwargs):
                self.request_json = kwargs["json"]
                return kwargs

            async def send(self, _request, **_kwargs):
                return FakeResponse()

        client = FakeClient()
        provider = OpenAICompatibleProvider(base_url="https://example.com/v1", api_key="test", model="test")
        events = []
        with patch("pet_agent.model_provider.httpx.AsyncClient", return_value=client):
            result = await provider.stream_step(
                [{"role": "user", "content": f"before{low}after"}], [], events.append,
            )
        self.assertEqual(client.request_json["messages"][0]["content"], "before�after")
        self.assertEqual(result.reasoning_content, "💁")
        self.assertEqual(events, [{"type": "reasoning_delta", "text": "💁"}])

    async def test_stream_decodes_unicode_tool_path_as_utf8_despite_wrong_charset(self):
        path = r"D:\Users\WESTBROOK\Obsidian Vault\Obsidian_Note\精神分析实践\Thought\杂记.md"
        payload = {
            "choices": [{"delta": {"tool_calls": [{
                "index": 0, "id": "call_1",
                "function": {"name": "filesystem_read", "arguments": json.dumps({"path": path}, ensure_ascii=False)},
            }]}, "finish_reason": "tool_calls"}],
        }
        raw = ("data: " + json.dumps(payload, ensure_ascii=False) + "\r\ndata: [DONE]\r\n").encode("utf-8")

        class FakeResponse:
            status_code = 200
            encoding = "iso-8859-1"

            async def aiter_bytes(self):
                for offset in range(0, len(raw), 7):
                    yield raw[offset:offset + 7]

            async def aclose(self):
                return None

        class FakeClient:
            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            def build_request(self, _method, _url, **kwargs):
                return kwargs

            async def send(self, _request, **_kwargs):
                return FakeResponse()

        provider = OpenAICompatibleProvider(base_url="https://example.com/v1", api_key="test", model="test")
        with patch("pet_agent.model_provider.httpx.AsyncClient", return_value=FakeClient()):
            result = await provider.stream_step([{"role": "user", "content": path}], [], lambda _event: None)

        self.assertEqual(json.loads(result.tool_calls[0].arguments_text)["path"], path)


if __name__ == "__main__":
    unittest.main()
