import json
import tempfile
import threading
import unittest
from pathlib import Path

from pet_agent.approvals import ApprovalInbox
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

    async def test_external_read_pauses_for_approval_and_resumes(self):
        with tempfile.TemporaryDirectory() as workspace, tempfile.TemporaryDirectory() as external:
            target = Path(external, "note.txt")
            target.write_text("approved external content", encoding="utf-8")
            approvals = ApprovalInbox()
            events = []
            def emit(event):
                events.append(event)
                if event.get("type") == "approval_required":
                    approvals.resolve(event["approval_id"], {
                        "decision": "approve", "root_path": external, "scope": "task",
                        "expires_at": 4_000_000_000,
                    })
            runtime = AgentRuntime({
                "workspace_root": workspace, "base_url": "https://example.com/v1", "api_key": "test", "model": "test",
                "messages": [{"role": "system", "content": "system"}], "max_steps": 3, "timeout_seconds": 30,
            }, emit, threading.Event(), approvals)
            runtime.provider = FakeProvider([
                ModelStep(tool_calls=[ToolCall("call_1", "filesystem_read", json.dumps({"path": str(target)}))], finish_reason="tool_calls"),
                ModelStep(content="done", finish_reason="stop"),
            ])
            result = await runtime.run()
            self.assertTrue(result["receipts"][0]["result"]["ok"])
            self.assertIn("approval_required", [event["type"] for event in events])
            self.assertIn("approval_resolved", [event["type"] for event in events])

    async def test_path_reference_and_lossy_model_path_resolve_before_execution(self):
        with tempfile.TemporaryDirectory() as workspace, tempfile.TemporaryDirectory() as external:
            directory = Path(external, "精神分析实践", "Thought")
            directory.mkdir(parents=True)
            target = directory / "杂记.md"
            target.write_text("grounded path content", encoding="utf-8")
            corrupted = target.as_posix().replace("/", "\\").encode("utf-8").decode("cp1252", "replace")
            approvals = ApprovalInbox()
            events = []

            def emit(event):
                events.append(event)
                if event.get("type") == "approval_required":
                    approvals.resolve(event["approval_id"], {
                        "decision": "approve", "root_path": str(directory), "scope": "task",
                    })

            runtime = AgentRuntime({
                "workspace_root": workspace, "base_url": "https://example.com/v1", "api_key": "test", "model": "test",
                "messages": [
                    {"role": "system", "content": "system"},
                    {"role": "user", "content": f"读取 {target}"},
                    {"role": "assistant", "content": "我再试一下。"},
                    {"role": "user", "content": "这是中文路径这个文件，你重新试一下"},
                ],
                "max_steps": 3, "timeout_seconds": 30,
            }, emit, threading.Event(), approvals)
            runtime.provider = FakeProvider([
                ModelStep(tool_calls=[
                    ToolCall("call_ref", "filesystem_read", json.dumps({"path": "path_ref_1"})),
                    ToolCall("call_mojibake", "filesystem_read", json.dumps({"path": corrupted}, ensure_ascii=False)),
                ], finish_reason="tool_calls"),
                ModelStep(content="done", finish_reason="stop"),
            ])

            result = await runtime.run()
            self.assertTrue(all(item["result"]["ok"] for item in result["receipts"]), result["receipts"])
            self.assertEqual([item["arguments"]["path"] for item in result["receipts"]], [str(target), str(target)])
            approval = next(event for event in events if event.get("type") == "approval_required")
            self.assertEqual(Path(approval["requested_path"]), target.resolve(strict=False))

    async def test_unicode_external_read_and_write_use_manual_approval(self):
        with tempfile.TemporaryDirectory() as workspace, tempfile.TemporaryDirectory() as external:
            approved_root = Path(external, "外部目录", "精神分析实践")
            approved_root.mkdir(parents=True)
            source = approved_root / "杂记.md"
            destination = approved_root / "新笔记.md"
            source.write_text("可读取的中文内容", encoding="utf-8")
            approvals = ApprovalInbox()
            events = []

            def emit(event):
                events.append(event)
                if event.get("type") == "approval_required":
                    approvals.resolve(event["approval_id"], {
                        "decision": "approve", "root_path": str(approved_root), "scope": "task",
                        "expires_at": 4_000_000_000,
                    })

            runtime = AgentRuntime({
                "workspace_root": workspace, "base_url": "https://example.com/v1", "api_key": "test", "model": "test",
                "messages": [{"role": "system", "content": "system"}], "max_steps": 3, "timeout_seconds": 30,
            }, emit, threading.Event(), approvals)
            runtime.provider = FakeProvider([
                ModelStep(tool_calls=[
                    ToolCall("call_read", "filesystem_read", json.dumps({"path": str(source)}, ensure_ascii=False)),
                    ToolCall("call_write", "filesystem_write", json.dumps({
                        "path": str(destination), "content": "审批后的写入内容",
                    }, ensure_ascii=False)),
                ], finish_reason="tool_calls"),
                ModelStep(content="done", finish_reason="stop"),
            ])

            result = await runtime.run()
            approval_events = [event for event in events if event.get("type") == "approval_required"]
            self.assertEqual(
                [Path(event["requested_path"]) for event in approval_events],
                [source.resolve(strict=False), destination.resolve(strict=False)],
            )
            self.assertTrue(all(receipt["result"]["ok"] for receipt in result["receipts"]), result["receipts"])
            self.assertEqual(destination.read_text(encoding="utf-8"), "审批后的写入内容")

    async def test_write_requires_approval_and_is_atomic(self):
        with tempfile.TemporaryDirectory() as workspace:
            target = Path(workspace, "output.txt")
            target.write_text("before\n", encoding="utf-8")
            approvals = ApprovalInbox()
            observed_preview = {}
            def emit(event):
                if event.get("type") == "approval_required":
                    observed_preview.update(event.get("preview") or {})
                    approvals.resolve(event["approval_id"], {
                        "decision": "approve", "root_path": workspace, "scope": "once",
                        "expires_at": 4_000_000_000,
                    })
            runtime = AgentRuntime({
                "workspace_root": workspace, "base_url": "https://example.com/v1", "api_key": "test", "model": "test",
                "messages": [{"role": "system", "content": "system"}], "max_steps": 3, "timeout_seconds": 30,
            }, emit, threading.Event(), approvals)
            runtime.provider = FakeProvider([
                ModelStep(tool_calls=[ToolCall("call_1", "filesystem_write", json.dumps({"path": "output.txt", "content": "after\n"}))], finish_reason="tool_calls"),
                ModelStep(content="written", finish_reason="stop"),
            ])
            result = await runtime.run()
            self.assertTrue(result["receipts"][0]["result"]["ok"])
            self.assertIn("-before", observed_preview["diff"])
            self.assertEqual(target.read_text(encoding="utf-8"), "after\n")

    async def test_structured_command_requires_approval(self):
        with tempfile.TemporaryDirectory() as workspace:
            approvals = ApprovalInbox()
            def emit(event):
                if event.get("type") == "approval_required":
                    approvals.resolve(event["approval_id"], {"decision": "approve", "scope": "once"})
            runtime = AgentRuntime({
                "workspace_root": workspace, "base_url": "https://example.com/v1", "api_key": "test", "model": "test",
                "messages": [{"role": "system", "content": "system"}], "max_steps": 3, "timeout_seconds": 30,
                "allowed_executables": ["python"],
            }, emit, threading.Event(), approvals)
            runtime.provider = FakeProvider([
                ModelStep(tool_calls=[ToolCall("call_1", "process_execute", json.dumps({
                    "executable": "python", "args": ["-c", "print('command-ok')"], "cwd": workspace,
                }))], finish_reason="tool_calls"),
                ModelStep(content="command complete", finish_reason="stop"),
            ])
            result = await runtime.run()
            self.assertTrue(result["receipts"][0]["result"]["ok"])
            self.assertIsNotNone(result["receipts"][0]["result"].get("approval_id"))

    async def test_sensitive_file_needs_explicit_sensitive_approval(self):
        with tempfile.TemporaryDirectory() as workspace:
            target = Path(workspace, ".env")
            target.write_text("TOKEN=secret", encoding="utf-8")
            approvals = ApprovalInbox()
            def emit(event):
                if event.get("type") == "approval_required":
                    approvals.resolve(event["approval_id"], {
                        "decision": "approve", "root_path": workspace, "scope": "once", "allow_sensitive": False,
                    })
            runtime = AgentRuntime({
                "workspace_root": workspace, "base_url": "https://example.com/v1", "api_key": "test", "model": "test",
                "messages": [{"role": "system", "content": "system"}], "max_steps": 3, "timeout_seconds": 30,
            }, emit, threading.Event(), approvals)
            runtime.provider = FakeProvider([
                ModelStep(tool_calls=[ToolCall("call_1", "filesystem_read", json.dumps({"path": ".env"}))], finish_reason="tool_calls"),
                ModelStep(content="denied", finish_reason="stop"),
            ])
            result = await runtime.run()
            self.assertFalse(result["receipts"][0]["result"]["ok"])
            self.assertIn("Sensitive access", result["receipts"][0]["result"]["error"])

    async def test_exact_replace_uses_diff_approval(self):
        with tempfile.TemporaryDirectory() as workspace:
            target = Path(workspace, "replace.txt")
            target.write_text("alpha beta alpha", encoding="utf-8")
            approvals = ApprovalInbox()
            def emit(event):
                if event.get("type") == "approval_required":
                    approvals.resolve(event["approval_id"], {
                        "decision": "approve", "root_path": workspace, "scope": "once",
                    })
            runtime = AgentRuntime({
                "workspace_root": workspace, "base_url": "https://example.com/v1", "api_key": "test", "model": "test",
                "messages": [{"role": "system", "content": "system"}], "max_steps": 3, "timeout_seconds": 30,
            }, emit, threading.Event(), approvals)
            runtime.provider = FakeProvider([
                ModelStep(tool_calls=[ToolCall("call_1", "filesystem_replace", json.dumps({
                    "path": "replace.txt", "old_text": "alpha", "new_text": "omega",
                }))], finish_reason="tool_calls"),
                ModelStep(content="replaced", finish_reason="stop"),
            ])
            result = await runtime.run()
            self.assertTrue(result["receipts"][0]["result"]["ok"])
            self.assertEqual(target.read_text(encoding="utf-8"), "omega beta alpha")

    async def test_task_scope_cannot_bypass_second_write_approval(self):
        with tempfile.TemporaryDirectory() as workspace:
            approvals = ApprovalInbox()
            approval_ids = []

            def emit(event):
                if event.get("type") == "approval_required":
                    approval_ids.append(event["approval_id"])
                    approvals.resolve(event["approval_id"], {
                        "decision": "approve", "root_path": workspace, "scope": "task",
                    })

            runtime = AgentRuntime({
                "workspace_root": workspace, "base_url": "https://example.com/v1", "api_key": "test", "model": "test",
                "messages": [{"role": "system", "content": "system"}], "max_steps": 3, "timeout_seconds": 30,
            }, emit, threading.Event(), approvals)
            runtime.provider = FakeProvider([
                ModelStep(tool_calls=[
                    ToolCall("call_1", "filesystem_write", json.dumps({"path": "one.txt", "content": "one"})),
                    ToolCall("call_2", "filesystem_write", json.dumps({"path": "two.txt", "content": "two"})),
                ], finish_reason="tool_calls"),
                ModelStep(content="done", finish_reason="stop"),
            ])
            result = await runtime.run()
            self.assertEqual(len(approval_ids), 2)
            self.assertTrue(all(receipt["result"]["ok"] for receipt in result["receipts"]), result["receipts"])


if __name__ == "__main__":
    unittest.main()
