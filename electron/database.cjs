const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const initSqlJs = require("sql.js");

const isoNow = () => new Date().toISOString();
const localDate = (date = new Date()) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

class PetDatabase {
  constructor(filePath) {
    this.filePath = filePath;
    this.db = null;
  }

  async initialize() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const wasmPath = require.resolve("sql.js/dist/sql-wasm.wasm");
    const SQL = await initSqlJs({ locateFile: () => wasmPath });
    const bytes = fs.existsSync(this.filePath) ? fs.readFileSync(this.filePath) : undefined;
    this.db = bytes ? new SQL.Database(bytes) : new SQL.Database();
    this.db.run("PRAGMA foreign_keys = ON");
    this.migrate();
    this.seed();
    this.persist();
    return this;
  }

  migrate() {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS journal_days (
        id TEXT PRIMARY KEY,
        local_date TEXT NOT NULL UNIQUE,
        timezone TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'open',
        opened_at TEXT NOT NULL,
        closed_at TEXT,
        summary TEXT,
        consolidation_cursor TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        started_at TEXT NOT NULL,
        ended_at TEXT,
        message_count INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        modality TEXT NOT NULL DEFAULT 'text',
        token_estimate INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        journal_day_id TEXT NOT NULL,
        sequence_no INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        actor TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        recorded_at TEXT NOT NULL,
        content TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        source_kind TEXT NOT NULL,
        source_id TEXT,
        hermes_session_id TEXT,
        activity_id TEXT,
        salience REAL NOT NULL DEFAULT 0,
        confidence REAL NOT NULL DEFAULT 1,
        retention_class TEXT NOT NULL,
        sensitivity TEXT NOT NULL DEFAULT 'private',
        supersedes_event_id TEXT,
        dedupe_key TEXT NOT NULL UNIQUE,
        extractor_version TEXT NOT NULL,
        FOREIGN KEY (journal_day_id) REFERENCES journal_days(id)
      );

      CREATE TABLE IF NOT EXISTS memory_claims (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        claim_type TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        object_json TEXT NOT NULL,
        canonical_text TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_id TEXT,
        claim_key TEXT NOT NULL,
        value_hash TEXT NOT NULL,
        cardinality TEXT NOT NULL,
        status TEXT NOT NULL,
        confidence REAL NOT NULL,
        importance REAL NOT NULL,
        stability REAL NOT NULL,
        promotion_score REAL NOT NULL DEFAULT 0,
        sensitivity TEXT NOT NULL,
        valid_from TEXT,
        valid_to TEXT,
        last_confirmed_at TEXT,
        last_recalled_at TEXT,
        recall_count INTEGER NOT NULL DEFAULT 0,
        review_after TEXT,
        superseded_by TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_evidence (
        claim_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        weight REAL NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (claim_id, event_id, relation),
        FOREIGN KEY (claim_id) REFERENCES memory_claims(id),
        FOREIGN KEY (event_id) REFERENCES events(id)
      );

      CREATE TABLE IF NOT EXISTS consolidation_runs (
        id TEXT PRIMARY KEY,
        journal_day_id TEXT NOT NULL,
        status TEXT NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 0,
        promoted_count INTEGER NOT NULL DEFAULT 0,
        disputed_count INTEGER NOT NULL DEFAULT 0,
        summary TEXT,
        model_version TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        FOREIGN KEY (journal_day_id) REFERENCES journal_days(id)
      );

      CREATE TABLE IF NOT EXISTS retrieval_logs (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        query TEXT NOT NULL,
        mode TEXT NOT NULL,
        candidate_count INTEGER NOT NULL,
        selected_claim_ids TEXT NOT NULL DEFAULT '[]',
        selected_event_ids TEXT NOT NULL DEFAULT '[]',
        token_estimate INTEGER NOT NULL,
        score_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS logs (
        id TEXT PRIMARY KEY,
        level TEXT NOT NULL,
        category TEXT NOT NULL,
        message TEXT NOT NULL,
        context_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_time ON messages(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_day_time ON events(journal_day_id, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_events_activity ON events(activity_id);
      CREATE INDEX IF NOT EXISTS idx_claims_status_scope ON memory_claims(status, scope_type, scope_id);
      CREATE INDEX IF NOT EXISTS idx_claims_key ON memory_claims(claim_key);
      CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(created_at DESC);
    `);
  }

  seed() {
    const legacyBaseUrl = this.get("SELECT value FROM app_settings WHERE key = 'baseUrl'")?.value;
    const defaultBaseUrl = legacyBaseUrl || "https://dashscope.aliyuncs.com/compatible-mode/v1";
    const defaults = {
      petName: "小步",
      chatBaseUrl: defaultBaseUrl,
      transcriptionBaseUrl: defaultBaseUrl,
      chatModel: "qwen3.7-max",
      transcriptionModel: "qwen3-asr-flash",
      temperature: "0.7",
      autoSpeak: "true",
      systemPrompt: "你是一个长期陪伴用户的 AI 宠物。你温暖、敏锐、诚实，会自然地使用记忆，但不会假装记得不存在的事情。",
    };
    const stamp = isoNow();
    for (const [key, value] of Object.entries(defaults)) {
      this.db.run(
        "INSERT OR IGNORE INTO app_settings (key, value, updated_at) VALUES ($key, $value, $updatedAt)",
        { $key: key, $value: value, $updatedAt: stamp },
      );
    }
    const session = this.get("SELECT id FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1");
    if (!session) {
      const sessionId = crypto.randomUUID();
      this.db.run(
        "INSERT INTO sessions (id, title, started_at) VALUES ($id, $title, $startedAt)",
        { $id: sessionId, $title: "第一次见面", $startedAt: stamp },
      );
      this.db.run(
        `INSERT INTO messages (id, session_id, role, content, modality, token_estimate, created_at)
         VALUES ($id, $sessionId, 'assistant', $content, 'system', 30, $createdAt)`,
        {
          $id: crypto.randomUUID(),
          $sessionId: sessionId,
          $content: "你好，我是小步。我们可以从打字开始，也可以打开麦克风聊聊。",
          $createdAt: stamp,
        },
      );
      this.db.run("UPDATE sessions SET message_count = 1 WHERE id = $id", { $id: sessionId });
    }
    this.ensureJournalDay();
  }

  ensureJournalDay(date = new Date()) {
    const dateText = localDate(date);
    let day = this.get("SELECT * FROM journal_days WHERE local_date = $date", { $date: dateText });
    if (!day) {
      const stamp = isoNow();
      const id = crypto.randomUUID();
      this.db.run(
        `INSERT INTO journal_days (id, local_date, timezone, opened_at, updated_at)
         VALUES ($id, $date, $timezone, $openedAt, $updatedAt)`,
        {
          $id: id,
          $date: dateText,
          $timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
          $openedAt: stamp,
          $updatedAt: stamp,
        },
      );
      day = this.get("SELECT * FROM journal_days WHERE id = $id", { $id: id });
    }
    return day;
  }

  getActiveSession() {
    return this.get("SELECT * FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1");
  }

  getSettings() {
    const rows = this.all("SELECT key, value FROM app_settings");
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  saveSettings(settings) {
    const stamp = isoNow();
    this.transaction(() => {
      for (const [key, value] of Object.entries(settings)) {
        if (key === "apiKey" || value === undefined) continue;
        this.db.run(
          `INSERT INTO app_settings (key, value, updated_at) VALUES ($key, $value, $updatedAt)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          { $key: key, $value: String(value), $updatedAt: stamp },
        );
      }
    });
    return this.getSettings();
  }

  addMessage({ sessionId, role, content, modality = "text", metadata = {} }) {
    const id = crypto.randomUUID();
    const createdAt = isoNow();
    const tokenEstimate = Math.max(1, Math.ceil(content.length / 2.4));
    this.db.run(
      `INSERT INTO messages
       (id, session_id, role, content, modality, token_estimate, metadata_json, created_at)
       VALUES ($id, $sessionId, $role, $content, $modality, $tokens, $metadata, $createdAt)`,
      {
        $id: id,
        $sessionId: sessionId,
        $role: role,
        $content: content,
        $modality: modality,
        $tokens: tokenEstimate,
        $metadata: JSON.stringify(metadata),
        $createdAt: createdAt,
      },
    );
    this.db.run(
      "UPDATE sessions SET message_count = message_count + 1 WHERE id = $id",
      { $id: sessionId },
    );
    this.persist();
    return this.get("SELECT * FROM messages WHERE id = $id", { $id: id });
  }

  log(level, category, message, context = {}) {
    this.db.run(
      "INSERT INTO logs (id, level, category, message, context_json, created_at) VALUES ($id, $level, $category, $message, $context, $createdAt)",
      {
        $id: crypto.randomUUID(),
        $level: level,
        $category: category,
        $message: message,
        $context: JSON.stringify(context),
        $createdAt: isoNow(),
      },
    );
    this.persist();
  }

  run(sql, params = {}) {
    this.db.run(sql, params);
    this.persist();
  }

  all(sql, params = {}) {
    const statement = this.db.prepare(sql);
    try {
      statement.bind(params);
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally {
      statement.free();
    }
  }

  get(sql, params = {}) {
    return this.all(sql, params)[0] || null;
  }

  transaction(callback) {
    this.db.run("BEGIN");
    try {
      const result = callback();
      this.db.run("COMMIT");
      this.persist();
      return result;
    } catch (error) {
      this.db.run("ROLLBACK");
      throw error;
    }
  }

  persist() {
    if (!this.db) return;
    fs.writeFileSync(this.filePath, Buffer.from(this.db.export()));
  }

  close() {
    if (!this.db) return;
    this.persist();
    this.db.close();
    this.db = null;
  }
}

module.exports = { PetDatabase, isoNow, localDate };
