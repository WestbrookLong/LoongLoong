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
npm run build
npm run eval:continuity -- --search
```
