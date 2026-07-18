import json
import tempfile
import threading
import unittest
from pathlib import Path

from pet_agent.model_provider import ModelStep, ToolCall
from pet_agent.runtime import AgentCancelled, AgentRuntime


class FakeProvider:
    def __init__(self, steps):
        self.steps = iter(steps)

    async def stream_step(self, messages, tools, on_event):
        result = next(self.steps)
        if result.reasoning_content:
            on_event({"type": "reasoning_delta", "text": result.reasoning_content})
        if result.content:
            on_event({"type": "answer_delta", "text": result.content})
        return result


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    def runtime(self, root, provider, cancel=None):
        runtime = AgentRuntime({
            "workspace_root": root, "base_url": "https://example.com/v1", "api_key": "test", "model": "test",
            "messages": [{"role": "system", "content": "system"}, {"role": "user", "content": "task"}],
            "max_steps": 4, "timeout_seconds": 30,
        }, lambda event: None, cancel or threading.Event())
        runtime.provider = provider
        return runtime

    async def test_direct_answer(self):
        with tempfile.TemporaryDirectory() as root:
            result = await self.runtime(root, FakeProvider([ModelStep(content="direct", finish_reason="stop")])).run()
            self.assertEqual(result["content"], "direct")
            self.assertEqual(result["receipts"], [])

    async def test_tool_loop_finishes_and_keeps_receipt(self):
        with tempfile.TemporaryDirectory() as root:
            events = []
            runtime = AgentRuntime({
                "workspace_root": root, "base_url": "https://example.com/v1", "api_key": "test",
                "model": "test", "messages": [{"role": "system", "content": "system"}, {"role": "user", "content": "list"}],
                "max_steps": 3, "timeout_seconds": 30,
            }, events.append, threading.Event())
            runtime.provider = FakeProvider([
                ModelStep(reasoning_content="inspect", tool_calls=[ToolCall("call_1", "filesystem_list", "{}")], finish_reason="tool_calls"),
                ModelStep(content="Workspace is empty.", finish_reason="stop"),
            ])
            result = await runtime.run()
            self.assertEqual(result["content"], "Workspace is empty.")
            self.assertTrue(result["receipts"][0]["result"]["ok"])
            self.assertEqual(len(result["steps"]), 2)
            self.assertIn("tool_completed", [event["type"] for event in events])

    async def test_duplicate_call_limit_is_enforced(self):
        with tempfile.TemporaryDirectory() as root:
            call = ToolCall("call", "filesystem_list", json.dumps({}))
            runtime = AgentRuntime({
                "workspace_root": root, "base_url": "https://example.com/v1", "api_key": "test", "model": "test",
                "messages": [{"role": "system", "content": "system"}], "max_steps": 4, "timeout_seconds": 30,
            }, lambda event: None, threading.Event())
            runtime.provider = FakeProvider([
                ModelStep(tool_calls=[ToolCall(f"call_{i}", call.name, call.arguments_text)], finish_reason="tool_calls") for i in range(3)
            ] + [ModelStep(content="done", finish_reason="stop")])
            result = await runtime.run()
            self.assertEqual(result["receipts"][2]["result"]["error"], "duplicate_call_limit")

    async def test_unknown_tool_error_is_returned_to_model(self):
        with tempfile.TemporaryDirectory() as root:
            provider = FakeProvider([
                ModelStep(tool_calls=[ToolCall("call_1", "not_available", "{}")], finish_reason="tool_calls"),
                ModelStep(content="I cannot use that tool.", finish_reason="stop"),
            ])
            result = await self.runtime(root, provider).run()
            self.assertFalse(result["receipts"][0]["result"]["ok"])
            self.assertIn("Unknown tool", result["receipts"][0]["result"]["error"])

    async def test_empty_responses_stop_safely(self):
        with tempfile.TemporaryDirectory() as root:
            runtime = self.runtime(root, FakeProvider([ModelStep(), ModelStep()]))
            with self.assertRaisesRegex(RuntimeError, "empty responses"):
                await runtime.run()

    async def test_step_limit_stops_safely(self):
        with tempfile.TemporaryDirectory() as root:
            for i in range(4):
                Path(root, f"dir-{i}").mkdir()
            provider = FakeProvider([ModelStep(tool_calls=[ToolCall(f"call_{i}", "filesystem_list", json.dumps({"path": f"dir-{i}"}))], finish_reason="tool_calls") for i in range(4)])
            runtime = self.runtime(root, provider)
            with self.assertRaisesRegex(RuntimeError, "step limit"):
                await runtime.run()

    async def test_user_cancel_before_start(self):
        with tempfile.TemporaryDirectory() as root:
            cancel = threading.Event()
            cancel.set()
            runtime = self.runtime(root, FakeProvider([ModelStep(content="never")]), cancel)
            with self.assertRaises(AgentCancelled):
                await runtime.run()


if __name__ == "__main__":
    unittest.main()
