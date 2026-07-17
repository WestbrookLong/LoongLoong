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
    this.recoverInterruptedRuns();
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
        continuity_value REAL NOT NULL DEFAULT 0,
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
        epistemic_basis TEXT NOT NULL DEFAULT 'unknown_legacy',
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

      CREATE TABLE IF NOT EXISTS context_snapshots (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        parent_snapshot_id TEXT,
        summary_text TEXT NOT NULL,
        state_json TEXT NOT NULL,
        source_message_ids_json TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        source_start_rowid INTEGER NOT NULL,
        source_end_rowid INTEGER NOT NULL,
        source_token_count INTEGER NOT NULL,
        summary_token_count INTEGER NOT NULL,
        continuity_refs_json TEXT NOT NULL DEFAULT '{}',
        model_version TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id),
        FOREIGN KEY (parent_snapshot_id) REFERENCES context_snapshots(id)
      );

      CREATE TABLE IF NOT EXISTS context_compaction_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        snapshot_id TEXT,
        trigger_type TEXT NOT NULL,
        status TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        source_message_count INTEGER NOT NULL DEFAULT 0,
        model_version TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id),
        FOREIGN KEY (snapshot_id) REFERENCES context_snapshots(id)
      );

      CREATE TABLE IF NOT EXISTS memory_extraction_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        trigger_type TEXT NOT NULL,
        status TEXT NOT NULL,
        source_message_ids_json TEXT NOT NULL DEFAULT '[]',
        source_hash TEXT NOT NULL,
        event_count INTEGER NOT NULL DEFAULT 0,
        claim_count INTEGER NOT NULL DEFAULT 0,
        model_version TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        raw_output_json TEXT NOT NULL DEFAULT '{}',
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS event_sources (
        event_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT 'derived_from',
        evidence_quote TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (event_id, message_id),
        FOREIGN KEY (event_id) REFERENCES events(id),
        FOREIGN KEY (message_id) REFERENCES messages(id)
      );

      CREATE TABLE IF NOT EXISTS claim_relations (
        source_claim_id TEXT NOT NULL,
        target_claim_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        confidence REAL NOT NULL,
        source_run_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (source_claim_id, target_claim_id, relation),
        FOREIGN KEY (source_claim_id) REFERENCES memory_claims(id),
        FOREIGN KEY (target_claim_id) REFERENCES memory_claims(id)
      );

      CREATE TABLE IF NOT EXISTS topic_threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        overview TEXT NOT NULL DEFAULT '',
        current_position TEXT NOT NULL DEFAULT '',
        continuity_value REAL NOT NULL DEFAULT 0,
        current_revision_id TEXT,
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS topic_revisions (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL,
        base_version INTEGER NOT NULL,
        result_version INTEGER NOT NULL,
        overview TEXT NOT NULL,
        current_position TEXT NOT NULL,
        operations_json TEXT NOT NULL DEFAULT '[]',
        source_run_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (topic_id) REFERENCES topic_threads(id)
      );

      CREATE TABLE IF NOT EXISTS topic_items (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL,
        item_type TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        epistemic_basis TEXT NOT NULL,
        continuity_value REAL NOT NULL DEFAULT 0,
        superseded_by TEXT,
        source_run_id TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (topic_id) REFERENCES topic_threads(id),
        FOREIGN KEY (superseded_by) REFERENCES topic_items(id)
      );

      CREATE TABLE IF NOT EXISTS topic_item_evidence (
        topic_item_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT 'supports',
        weight REAL NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        PRIMARY KEY (topic_item_id, event_id, relation),
        FOREIGN KEY (topic_item_id) REFERENCES topic_items(id),
        FOREIGN KEY (event_id) REFERENCES events(id)
      );

      CREATE TABLE IF NOT EXISTS topic_event_links (
        topic_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT 'discusses',
        weight REAL NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        PRIMARY KEY (topic_id, event_id, relation),
        FOREIGN KEY (topic_id) REFERENCES topic_threads(id),
        FOREIGN KEY (event_id) REFERENCES events(id)
      );

      CREATE TABLE IF NOT EXISTS open_loops (
        id TEXT PRIMARY KEY,
        topic_id TEXT,
        loop_type TEXT NOT NULL,
        owner TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        priority REAL NOT NULL DEFAULT 0.5,
        continuity_value REAL NOT NULL DEFAULT 0.8,
        resolution_summary TEXT,
        resolution_event_id TEXT,
        source_run_id TEXT,
        idempotency_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_touched_at TEXT NOT NULL,
        resolved_at TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (topic_id) REFERENCES topic_threads(id),
        FOREIGN KEY (resolution_event_id) REFERENCES events(id)
      );

      CREATE TABLE IF NOT EXISTS open_loop_evidence (
        open_loop_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        PRIMARY KEY (open_loop_id, event_id, relation),
        FOREIGN KEY (open_loop_id) REFERENCES open_loops(id),
        FOREIGN KEY (event_id) REFERENCES events(id)
      );

      CREATE TABLE IF NOT EXISTS continuity_state (
        id TEXT PRIMARY KEY,
        active_topic_id TEXT,
        recent_topic_ids_json TEXT NOT NULL DEFAULT '[]',
        last_topic_transition_at TEXT,
        updated_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (active_topic_id) REFERENCES topic_threads(id)
      );

      CREATE TABLE IF NOT EXISTS continuity_update_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT,
        trigger_type TEXT NOT NULL,
        status TEXT NOT NULL,
        source_message_ids_json TEXT NOT NULL DEFAULT '[]',
        source_event_ids_json TEXT NOT NULL DEFAULT '[]',
        source_hash TEXT NOT NULL,
        model_version TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        raw_output_json TEXT NOT NULL DEFAULT '{}',
        applied_ops_json TEXT NOT NULL DEFAULT '[]',
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS state_documents (
        id TEXT PRIMARY KEY,
        state_type TEXT NOT NULL UNIQUE,
        current_state_json TEXT NOT NULL DEFAULT '{}',
        current_revision_id TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS state_revisions (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        base_version INTEGER NOT NULL,
        result_version INTEGER NOT NULL,
        operations_json TEXT NOT NULL DEFAULT '[]',
        resulting_state_json TEXT NOT NULL,
        source_run_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (document_id) REFERENCES state_documents(id)
      );

      CREATE TABLE IF NOT EXISTS state_revision_evidence (
        revision_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT 'supports',
        created_at TEXT NOT NULL,
        PRIMARY KEY (revision_id, event_id, relation),
        FOREIGN KEY (revision_id) REFERENCES state_revisions(id),
        FOREIGN KEY (event_id) REFERENCES events(id)
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
      CREATE INDEX IF NOT EXISTS idx_context_snapshots_session ON context_snapshots(session_id, source_end_rowid DESC);
      CREATE INDEX IF NOT EXISTS idx_extraction_runs_session ON memory_extraction_runs(session_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_event_sources_message ON event_sources(message_id);
      CREATE INDEX IF NOT EXISTS idx_claim_relations_target ON claim_relations(target_claim_id);
      CREATE INDEX IF NOT EXISTS idx_topics_status_active ON topic_threads(status, last_active_at DESC);
      CREATE INDEX IF NOT EXISTS idx_topic_items_topic ON topic_items(topic_id, item_type, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_topic_event_links_event ON topic_event_links(event_id);
      CREATE INDEX IF NOT EXISTS idx_open_loops_topic_status ON open_loops(topic_id, status, priority DESC);
      CREATE INDEX IF NOT EXISTS idx_continuity_runs_time ON continuity_update_runs(started_at DESC);
    `);

    const ensureColumn = (table, column, definition) => {
      const columns = this.all(`PRAGMA table_info(${table})`).map((item) => item.name);
      if (!columns.includes(column)) this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };
    ensureColumn("messages", "memory_processed_at", "TEXT");
    ensureColumn("events", "continuity_value", "REAL NOT NULL DEFAULT 0");
    ensureColumn("memory_claims", "epistemic_basis", "TEXT NOT NULL DEFAULT 'unknown_legacy'");
    ensureColumn("context_snapshots", "continuity_refs_json", "TEXT NOT NULL DEFAULT '{}'");
    ensureColumn("continuity_update_runs", "source_message_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    this.db.run(
      `UPDATE memory_claims SET epistemic_basis = 'stated_by_user'
       WHERE epistemic_basis = 'unknown_legacy' AND EXISTS (
         SELECT 1 FROM memory_evidence me
         JOIN events e ON e.id = me.event_id
         WHERE me.claim_id = memory_claims.id AND e.actor = 'user'
       )`,
    );
  }

  recoverInterruptedRuns() {
    const now = isoNow();
    const error = "Pet 上次退出时任务仍在运行，已在本次启动时标记为中断。";
    this.db.run(
      "UPDATE memory_extraction_runs SET status = 'interrupted', error = $error, completed_at = $now WHERE status = 'running'",
      { $error: error, $now: now },
    );
    this.db.run(
      "UPDATE context_compaction_runs SET status = 'interrupted', error = $error, completed_at = $now WHERE status = 'running'",
      { $error: error, $now: now },
    );
    this.db.run(
      "UPDATE consolidation_runs SET status = 'interrupted', error = $error, completed_at = $now WHERE status = 'running'",
      { $error: error, $now: now },
    );
    this.db.run(
      "UPDATE continuity_update_runs SET status = 'interrupted', error = $error, completed_at = $now WHERE status = 'running'",
      { $error: error, $now: now },
    );
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
      memoryModel: "qwen3.7-max",
      compressionModel: "qwen3.7-max",
      contextWindowTokens: "32768",
      reservedOutputTokens: "4096",
      contextSoftThreshold: "0.75",
      contextTargetRatio: "0.45",
      memoryBatchSize: "6",
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
    this.db.run(
      `INSERT OR IGNORE INTO continuity_state
       (id, recent_topic_ids_json, updated_at) VALUES ('primary', '[]', $updatedAt)`,
      { $updatedAt: stamp },
    );
    const stateDefaults = {
      relationship: {
        interaction_style: [],
        trust_boundaries: [],
        shared_history_summary: "",
        important_shared_moments: [],
        recurring_tensions: [],
        current_relationship_model: "",
      },
      self_model: {
        successful_patterns: [],
        known_failure_modes: [],
        user_corrections_to_agent: [],
        current_behavior_adjustments: [],
        unfulfilled_commitment_ids: [],
      },
    };
    for (const [stateType, stateValue] of Object.entries(stateDefaults)) {
      this.db.run(
        `INSERT OR IGNORE INTO state_documents
         (id, state_type, current_state_json, updated_at)
         VALUES ($id, $stateType, $state, $updatedAt)`,
        {
          $id: `state-${stateType}`,
          $stateType: stateType,
          $state: JSON.stringify(stateValue),
          $updatedAt: stamp,
        },
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
