# Pet v0.1

Local-first AI pet desktop prototype with text/voice chat, inspectable SQLite memory, event capture, retrieval, and daily consolidation.

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
```

