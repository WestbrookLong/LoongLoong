import tempfile
import unittest
from pathlib import Path

from pet_agent.security import SecurityError, resolve_workspace_path, validate_public_url
from pet_agent.tools.filesystem_tools import FilesystemTools


class SecurityAndFilesystemTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "src").mkdir()
        (self.root / "src" / "app.py").write_text("first\nHello Agent\nlast", encoding="utf-8")
        (self.root / ".env").write_text("SECRET=value", encoding="utf-8")
        (self.root / ".pet-data").mkdir()
        (self.root / ".pet-data" / "pet.db").write_bytes(b"secret")

    def tearDown(self):
        self.temp.cleanup()

    def test_read_list_and_search(self):
        tools = FilesystemTools(str(self.root))
        listing = tools.list()
        self.assertTrue(listing.ok)
        self.assertNotIn(".env", [item["name"] for item in listing.data])
        self.assertNotIn(".pet-data", [item["name"] for item in listing.data])
        read = tools.read("src/app.py")
        self.assertIn("Hello Agent", read.data["content"])
        short = tools.read("src/app.py", max_chars=8)
        self.assertTrue(short.truncated)
        matches = tools.search("hello", glob="*.py")
        self.assertEqual(matches.data[0]["line"], 2)

    def test_traversal_and_sensitive_files_are_blocked(self):
        with self.assertRaises(SecurityError):
            resolve_workspace_path(self.root, "../outside.txt", must_exist=False)
        with self.assertRaises(SecurityError):
            resolve_workspace_path(self.root, ".env")
        with self.assertRaises(SecurityError):
            resolve_workspace_path(self.root, ".pet-data/pet.db")
        with self.assertRaises(SecurityError):
            FilesystemTools(str(self.root / ".pet-data"))
        (self.root / "binary.bin").write_bytes(b"\x00\x01\x02")
        with self.assertRaises(ValueError):
            FilesystemTools(str(self.root)).read("binary.bin")

    async def test_private_network_urls_are_blocked_without_dns(self):
        for url in ("http://127.0.0.1", "http://10.0.0.1", "http://169.254.169.254/latest", "file:///etc/passwd"):
            with self.assertRaises(SecurityError, msg=url):
                await validate_public_url(url, resolve_dns=False)
        self.assertEqual(await validate_public_url("https://8.8.8.8/test", resolve_dns=False), "https://8.8.8.8/test")


if __name__ == "__main__":
    unittest.main()
