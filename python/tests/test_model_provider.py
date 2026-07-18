import json
import unittest

from pet_agent.model_provider import parse_sse_payloads


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


if __name__ == "__main__":
    unittest.main()
