import asyncio
import unittest

from pet_agent.registry import ToolEntry, ToolRegistry
from pet_agent.results import ToolResult


class RegistryTests(unittest.IsolatedAsyncioTestCase):
    async def test_dispatch_validates_and_wraps(self):
        registry = ToolRegistry()
        registry.register(ToolEntry("echo", "echo", {
            "type": "object", "properties": {"text": {"type": "string"}},
            "required": ["text"], "additionalProperties": False,
        }, lambda text: ToolResult(True, "echo", "ok", {"text": text})))
        good = await registry.dispatch("echo", {"text": "hello"})
        missing = await registry.dispatch("echo", {})
        unknown = await registry.dispatch("missing", {})
        self.assertTrue(good.ok)
        self.assertEqual(good.data["text"], "hello")
        self.assertFalse(missing.ok)
        self.assertIn("Missing required", missing.error)
        self.assertFalse(unknown.ok)

    async def test_async_timeout(self):
        async def slow():
            await asyncio.sleep(0.05)
            return ToolResult(True, "slow", "ok")
        registry = ToolRegistry()
        registry.register(ToolEntry("slow", "slow", {"type": "object", "properties": {}}, slow, 0.005))
        result = await registry.dispatch("slow", {})
        self.assertFalse(result.ok)
        self.assertEqual(result.error, "timeout")


if __name__ == "__main__":
    unittest.main()
