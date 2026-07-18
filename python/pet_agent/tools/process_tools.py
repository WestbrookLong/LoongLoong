from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
from pathlib import Path
from typing import Any

from ..policy import CapabilityPolicy
from ..registry import ToolEntry, ToolRegistry
from ..results import ToolResult

DEFAULT_EXECUTABLES = {"git", "npm", "npx", "node", "python", "python3"}
MAX_OUTPUT_CHARS = 30000


class ProcessTools:
    def __init__(self, policy: CapabilityPolicy, allowed_executables: list[str] | None = None) -> None:
        self.policy = policy
        self.allowed = {item.lower().removesuffix(".exe").removesuffix(".cmd") for item in (allowed_executables or DEFAULT_EXECUTABLES)}

    async def execute(self, executable: str, args: list[str] | None = None, cwd: str = ".", timeout_seconds: int = 60) -> ToolResult:
        if Path(executable).name != executable:
            raise ValueError("Executable must be an allowlisted name resolved from PATH, not a path.")
        name = Path(executable).name.lower().removesuffix(".exe").removesuffix(".cmd")
        if name not in self.allowed:
            raise ValueError(f"Executable is not in the configured allowlist: {name}")
        resolved_executable = shutil.which(executable)
        if not resolved_executable:
            raise ValueError(f"Executable was not found: {executable}")
        arguments = [str(item) for item in (args or [])]
        if any("\x00" in item for item in arguments):
            raise ValueError("Command arguments contain a null byte.")
        workdir = self.policy.target_path(cwd)
        if not workdir.exists() or not workdir.is_dir():
            raise ValueError("Command working directory does not exist.")
        safe_env = {
            key: value for key, value in os.environ.items()
            if key.upper() in {"PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"}
        }
        flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
        process = await asyncio.create_subprocess_exec(
            resolved_executable, *arguments, cwd=str(workdir), env=safe_env,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
            creationflags=flags,
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=min(300, max(1, timeout_seconds)))
        except asyncio.TimeoutError:
            if os.name == "nt":
                await asyncio.to_thread(subprocess.run, ["taskkill", "/PID", str(process.pid), "/T", "/F"],
                                        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False)
            else:
                process.kill()
            await process.wait()
            raise TimeoutError("Command timed out and its process tree was terminated.")
        stdout_text = stdout.decode("utf-8", "replace")
        stderr_text = stderr.decode("utf-8", "replace")
        truncated = len(stdout_text) + len(stderr_text) > MAX_OUTPUT_CHARS
        remaining = MAX_OUTPUT_CHARS
        output_stdout = stdout_text[:remaining]
        remaining -= len(output_stdout)
        output_stderr = stderr_text[:max(0, remaining)]
        ok = process.returncode == 0
        return ToolResult(ok, "process_execute", f"Command exited with code {process.returncode}.", {
            "executable": resolved_executable, "args": arguments, "cwd": str(workdir),
            "exit_code": process.returncode, "stdout": output_stdout, "stderr": output_stderr,
        }, error=None if ok else f"nonzero_exit:{process.returncode}", truncated=truncated,
            provenance={"cwd": str(workdir), "executable": resolved_executable})


def register_process_tools(registry: ToolRegistry, policy: CapabilityPolicy, allowed_executables: list[str] | None = None) -> ProcessTools:
    tools = ProcessTools(policy, allowed_executables)
    registry.register(ToolEntry("process_execute", "Run one explicitly approved executable with a structured argument array and no shell interpolation. Commands are not a filesystem sandbox.", {
        "type": "object",
        "properties": {
            "executable": {"type": "string"},
            "args": {"type": "array"},
            "cwd": {"type": "string"},
            "timeout_seconds": {"type": "integer", "minimum": 1, "maximum": 300},
        },
        "required": ["executable"], "additionalProperties": False,
    }, tools.execute, 310, risk="execute", auto_execute=False))
    return tools
