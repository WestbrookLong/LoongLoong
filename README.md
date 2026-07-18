# Pet v0.1

Local-first AI pet desktop prototype with text/voice chat, inspectable SQLite memory, event capture, retrieval, and daily consolidation.

## Memory v0.5

Detailed architecture, schema, algorithms, and implementation notes: [Memory_Design.md](./Memory_Design.md).

Pet keeps raw messages immutable and builds derived memory in separate layers:

- deterministic event capture is the offline fallback and evidence floor
- explicit memory requests are extracted by the memory LLM immediately
- ordinary turns are extracted in serialized background batches
- token pressure creates an iterative session context snapshot before the model call
- every context compaction also extracts durable events and claim candidates
- daily consolidation flushes pending extraction, writes a narrative summary, and proposes claim relations
- LLM output cannot mutate memory directly; evidence validation and the claim state reducer apply changes
- long-running topics preserve current position, decisions, rationales, rejected ideas, and disagreements across sessions
- open loops track unresolved questions, tasks, commitments, and explicit continuations with resolution evidence
- a continuity router handles low-information prompts such as "continue" before ordinary claim/event retrieval
- context snapshots reference canonical topic and open-loop versions instead of becoming their source of truth
- claims and topic items carry epistemic source, status, confidence, and validity into the reply prompt
- evidence-bound state reducers maintain Agent corrections, behavior adjustments, failure modes, commitments, interaction boundaries, and recurring tensions
- retrieval logs record score versions, routes, and the exact Topic, Item, and Open Loop IDs injected into a turn
- Topic Health checks treat age and revision count as signals only; evidence-backed rebuilds repair current materialized state without recreating history
- Topic aliases and merges resolve through a canonical Topic while preserving old IDs and evidence
- Topic merge candidates are discovered locally, semantically adjudicated by an LLM, and applied only through evidence- and version-checked reducers
- continuity value and Topic routing use separate versioned Profiles with offline evaluation, Shadow comparison, and explicit manual promotion

The development inspector exposes context snapshots, extraction runs, compaction runs, claims, evidence, and claim relations. Context and memory model settings are configurable independently from the chat model.

## Agent

Pet runs a bounded Agent loop through an isolated Python sidecar. It currently exposes:

- `web_search` and `web_read`, with Bing-to-Baidu search fallback
- `filesystem_list`, `filesystem_read`, and `filesystem_search`
- atomic `filesystem_write` and exact `filesystem_replace`
- single-directory `filesystem_create_directory`
- structured `process_execute` without shell-string interpolation

Install the sidecar dependencies before starting Pet:

```powershell
python -m pip install -r python/requirements-agent.txt
```

The browser runtime prefers the locally installed Microsoft Edge. If Edge is unavailable, install Playwright Chromium with `python -m playwright install chromium`.

In Settings, enable **Agent mode** and choose the default workspace. Reads inside that workspace are automatic. Access to another directory, sensitive-path reads, every write, and every command require an approval card plus a native confirmation dialog. External read access can be granted once, for the current task, or persisted from Settings; writes and commands are never persisted. Activity, approvals, task/run/tool receipts, capability grants, and policy decisions are inspectable in Logs.

Writes include a diff or proposed-content preview and use an expected-content hash plus temporary-file replacement. Commands use a configurable executable allowlist, structured argument arrays, a minimal environment, timeouts, and process-tree termination. This is an approval boundary, not an operating-system sandbox: only approve commands you understand.

Private-network browsing, downloads, device/UNC paths, symlinks/reparse points, recursive directory creation, deletes, and moves remain blocked. Sensitive files require a separate explicit approval and cannot receive persistent grants.

Example requests:

```text
List this project and explain its main modules.
Search for every model API call in the workspace.
Search the web for Playwright's current Python documentation, read the official page, and summarize it with sources.
Read D:\another-project and compare its package.json with this project (approval required).
Replace the exact version string in package.json (diff approval required).
Run git status in the workspace (command approval required).
```

For a packaged sidecar executable, install PyInstaller and build it before packaging Electron:

```powershell
python -m pip install pyinstaller
npm run build:sidecar
```

At runtime Pet prefers `release/agent-sidecar/pet-agent.exe` in development and `resources/agent-sidecar/pet-agent.exe` in a packaged app. It falls back to the Python entry point during development.

## Run

```powershell
npm install
npm run dev
```

Open Settings in the app and configure an OpenAI-compatible endpoint. `OPENAI_API_KEY` is also read from the environment. Without a model key the app remains usable in offline development mode and still records messages, events, memories, retrievals, and logs.

Development data is stored in `.pet-data/pet.db`. The directory is ignored by Git.

## Checks

```powershell
npm test
npm run test:agent
npm run build
npm run eval:continuity -- --search
```
