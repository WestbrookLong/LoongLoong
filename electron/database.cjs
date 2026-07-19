const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const initSqlJs = require("sql.js");
const { getContinuityProfile } = require("./continuity-profiles.cjs");

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
        continuity_score_version TEXT NOT NULL DEFAULT 'unknown-legacy',
        continuity_components_json TEXT NOT NULL DEFAULT '{}',
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
        slot_id TEXT,
        temporal_state TEXT NOT NULL DEFAULT 'unknown',
        asserted_at TEXT,
        temporal_basis TEXT NOT NULL DEFAULT 'unknown_legacy',
        temporal_precision TEXT NOT NULL DEFAULT 'unknown',
        temporal_confidence REAL NOT NULL DEFAULT 0,
        supersession_reason TEXT,
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
        score_version TEXT NOT NULL DEFAULT 'memory-retrieval-v1',
        route_json TEXT NOT NULL DEFAULT '{}',
        selected_topic_ids_json TEXT NOT NULL DEFAULT '[]',
        selected_topic_item_ids_json TEXT NOT NULL DEFAULT '[]',
        selected_open_loop_ids_json TEXT NOT NULL DEFAULT '[]',
        outcome_json TEXT NOT NULL DEFAULT '{}',
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

      CREATE TABLE IF NOT EXISTS claim_slots (
        id TEXT PRIMARY KEY,
        namespace TEXT NOT NULL,
        subject TEXT NOT NULL,
        predicate TEXT NOT NULL,
        scope_type TEXT NOT NULL,
        scope_id TEXT,
        canonical_key TEXT NOT NULL UNIQUE,
        cardinality TEXT NOT NULL DEFAULT 'single',
        temporal_mode TEXT NOT NULL DEFAULT 'current_state',
        status TEXT NOT NULL DEFAULT 'active',
        canonical_slot_id TEXT,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (canonical_slot_id) REFERENCES claim_slots(id)
      );

      CREATE TABLE IF NOT EXISTS claim_transitions (
        id TEXT PRIMARY KEY,
        slot_id TEXT NOT NULL,
        from_claim_id TEXT,
        to_claim_id TEXT,
        transition_type TEXT NOT NULL,
        effective_at TEXT,
        temporal_basis TEXT NOT NULL DEFAULT 'unknown',
        source_run_id TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (slot_id) REFERENCES claim_slots(id),
        FOREIGN KEY (from_claim_id) REFERENCES memory_claims(id),
        FOREIGN KEY (to_claim_id) REFERENCES memory_claims(id)
      );

      CREATE TABLE IF NOT EXISTS claim_transition_evidence (
        transition_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT 'supports',
        created_at TEXT NOT NULL,
        PRIMARY KEY (transition_id, event_id, relation),
        FOREIGN KEY (transition_id) REFERENCES claim_transitions(id),
        FOREIGN KEY (event_id) REFERENCES events(id)
      );

      CREATE TABLE IF NOT EXISTS topic_threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        overview TEXT NOT NULL DEFAULT '',
        current_position TEXT NOT NULL DEFAULT '',
        continuity_value REAL NOT NULL DEFAULT 0,
        continuity_score_version TEXT NOT NULL DEFAULT 'unknown-legacy',
        continuity_components_json TEXT NOT NULL DEFAULT '{}',
        canonical_topic_id TEXT,
        active_item_ids_json TEXT NOT NULL DEFAULT '[]',
        tentative_item_ids_json TEXT NOT NULL DEFAULT '[]',
        current_revision_id TEXT,
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY (canonical_topic_id) REFERENCES topic_threads(id)
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
        confidence REAL NOT NULL DEFAULT 0.8,
        valid_from TEXT,
        valid_to TEXT,
        continuity_value REAL NOT NULL DEFAULT 0,
        continuity_score_version TEXT NOT NULL DEFAULT 'unknown-legacy',
        continuity_components_json TEXT NOT NULL DEFAULT '{}',
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
        continuity_score_version TEXT NOT NULL DEFAULT 'unknown-legacy',
        continuity_components_json TEXT NOT NULL DEFAULT '{}',
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

      CREATE TABLE IF NOT EXISTS topic_aliases (
        id TEXT PRIMARY KEY,
        alias TEXT NOT NULL,
        normalized_alias TEXT NOT NULL UNIQUE,
        topic_id TEXT NOT NULL,
        source_run_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (topic_id) REFERENCES topic_threads(id)
      );

      CREATE TABLE IF NOT EXISTS topic_alias_evidence (
        alias_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (alias_id, event_id),
        FOREIGN KEY (alias_id) REFERENCES topic_aliases(id),
        FOREIGN KEY (event_id) REFERENCES events(id)
      );

      CREATE TABLE IF NOT EXISTS topic_relations (
        source_topic_id TEXT NOT NULL,
        target_topic_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        source_run_id TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (source_topic_id, target_topic_id, relation),
        FOREIGN KEY (source_topic_id) REFERENCES topic_threads(id),
        FOREIGN KEY (target_topic_id) REFERENCES topic_threads(id)
      );

      CREATE TABLE IF NOT EXISTS topic_health_runs (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        base_version INTEGER NOT NULL,
        status TEXT NOT NULL,
        signals_json TEXT NOT NULL DEFAULT '{}',
        findings_json TEXT NOT NULL DEFAULT '[]',
        recommendation TEXT NOT NULL DEFAULT 'healthy',
        source_run_id TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (topic_id) REFERENCES topic_threads(id)
      );

      CREATE TABLE IF NOT EXISTS topic_rebuild_runs (
        id TEXT PRIMARY KEY,
        topic_id TEXT NOT NULL,
        health_run_id TEXT,
        base_version INTEGER NOT NULL,
        result_version INTEGER,
        status TEXT NOT NULL,
        source_event_ids_json TEXT NOT NULL DEFAULT '[]',
        source_hash TEXT NOT NULL UNIQUE,
        model_version TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        raw_output_json TEXT NOT NULL DEFAULT '{}',
        applied_json TEXT NOT NULL DEFAULT '{}',
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        FOREIGN KEY (topic_id) REFERENCES topic_threads(id),
        FOREIGN KEY (health_run_id) REFERENCES topic_health_runs(id)
      );

      CREATE TABLE IF NOT EXISTS topic_merge_candidates (
        id TEXT PRIMARY KEY,
        pair_key TEXT NOT NULL UNIQUE,
        topic_a_id TEXT NOT NULL,
        topic_b_id TEXT NOT NULL,
        topic_a_version INTEGER NOT NULL,
        topic_b_version INTEGER NOT NULL,
        discovery_trigger TEXT NOT NULL,
        discovery_version TEXT NOT NULL,
        lexical_score REAL NOT NULL DEFAULT 0,
        structural_score REAL NOT NULL DEFAULT 0,
        score_components_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending_model',
        decision TEXT,
        model_confidence REAL,
        rationale TEXT,
        evidence_event_ids_json TEXT NOT NULL DEFAULT '[]',
        canonical_target_topic_id TEXT,
        source_hash TEXT NOT NULL,
        model_version TEXT,
        prompt_version TEXT,
        raw_output_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        adjudicated_at TEXT,
        applied_at TEXT,
        error TEXT,
        FOREIGN KEY (topic_a_id) REFERENCES topic_threads(id),
        FOREIGN KEY (topic_b_id) REFERENCES topic_threads(id),
        FOREIGN KEY (canonical_target_topic_id) REFERENCES topic_threads(id)
      );

      CREATE TABLE IF NOT EXISTS topic_merge_candidate_evidence (
        candidate_id TEXT NOT NULL,
        topic_side TEXT NOT NULL,
        event_id TEXT NOT NULL,
        relation TEXT NOT NULL DEFAULT 'supports_comparison',
        created_at TEXT NOT NULL,
        PRIMARY KEY (candidate_id, topic_side, event_id),
        FOREIGN KEY (candidate_id) REFERENCES topic_merge_candidates(id),
        FOREIGN KEY (event_id) REFERENCES events(id)
      );

      CREATE TABLE IF NOT EXISTS continuity_profile_state (
        id TEXT PRIMARY KEY,
        active_profile_id TEXT NOT NULL,
        challenger_profile_id TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS continuity_profiles (
        id TEXT PRIMARY KEY,
        profile_json TEXT NOT NULL,
        status TEXT NOT NULL,
        source_eval_run_id TEXT,
        created_at TEXT NOT NULL,
        approved_at TEXT,
        activated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS continuity_feedback (
        id TEXT PRIMARY KEY,
        retrieval_log_id TEXT,
        expected_topic_id TEXT,
        expected_route TEXT,
        feedback_type TEXT NOT NULL,
        source TEXT NOT NULL,
        strength TEXT NOT NULL,
        notes TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (retrieval_log_id) REFERENCES retrieval_logs(id),
        FOREIGN KEY (expected_topic_id) REFERENCES topic_threads(id)
      );

      CREATE TABLE IF NOT EXISTS continuity_eval_runs (
        id TEXT PRIMARY KEY,
        dataset_version TEXT NOT NULL,
        baseline_profile_id TEXT NOT NULL,
        candidate_profile_ids_json TEXT NOT NULL DEFAULT '[]',
        metrics_json TEXT NOT NULL DEFAULT '{}',
        recommendation_json TEXT NOT NULL DEFAULT '{}',
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
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
        idempotency_key TEXT,
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

      CREATE TABLE IF NOT EXISTS embedding_profiles (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL,
        api_style TEXT NOT NULL,
        model TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        document_schema_version TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_object_policies (
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        surface_policy TEXT NOT NULL DEFAULT 'normal',
        embedding_policy TEXT NOT NULL DEFAULT 'inherit',
        reason TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (object_type, object_id)
      );

      CREATE TABLE IF NOT EXISTS memory_embeddings (
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        embedding_profile_id TEXT NOT NULL,
        content_schema_version TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        dimension INTEGER NOT NULL,
        vector_blob BLOB,
        status TEXT NOT NULL,
        source_updated_at TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (object_type, object_id, embedding_profile_id),
        FOREIGN KEY (embedding_profile_id) REFERENCES embedding_profiles(id)
      );

      CREATE TABLE IF NOT EXISTS embedding_jobs (
        id TEXT PRIMARY KEY,
        object_type TEXT NOT NULL,
        object_id TEXT NOT NULL,
        embedding_profile_id TEXT NOT NULL,
        expected_content_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        available_at TEXT NOT NULL,
        lease_until TEXT,
        error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (object_type, object_id, embedding_profile_id, expected_content_hash),
        FOREIGN KEY (embedding_profile_id) REFERENCES embedding_profiles(id)
      );

      CREATE TABLE IF NOT EXISTS retrieval_stage_logs (
        id TEXT PRIMARY KEY,
        retrieval_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        input_count INTEGER NOT NULL DEFAULT 0,
        output_count INTEGER NOT NULL DEFAULT 0,
        payload_json TEXT NOT NULL DEFAULT '{}',
        error TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY (retrieval_id) REFERENCES retrieval_logs(id)
      );

      CREATE TABLE IF NOT EXISTS retrieval_profiles (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        config_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        activated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS reranker_profiles (
        id TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        model TEXT NOT NULL,
        config_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        activated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        user_message_id TEXT NOT NULL,
        objective TEXT NOT NULL,
        status TEXT NOT NULL,
        summary_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id),
        FOREIGN KEY (user_message_id) REFERENCES messages(id)
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        step_count INTEGER NOT NULL DEFAULT 0,
        stop_reason TEXT,
        limits_json TEXT NOT NULL DEFAULT '{}',
        started_at TEXT NOT NULL,
        completed_at TEXT,
        error TEXT,
        FOREIGN KEY (task_id) REFERENCES agent_tasks(id),
        FOREIGN KEY (session_id) REFERENCES sessions(id)
      );

      CREATE TABLE IF NOT EXISTS agent_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_no INTEGER NOT NULL,
        finish_reason TEXT,
        model_output_json TEXT NOT NULL DEFAULT '{}',
        usage_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id)
      );

      CREATE TABLE IF NOT EXISTS tool_executions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        step_no INTEGER NOT NULL,
        tool_call_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        arguments_json TEXT NOT NULL DEFAULT '{}',
        result_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        truncated INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id)
      );

      CREATE TABLE IF NOT EXISTS approval_requests (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        operation TEXT NOT NULL,
        requested_path TEXT,
        risk TEXT NOT NULL,
        status TEXT NOT NULL,
        request_json TEXT NOT NULL DEFAULT '{}',
        response_json TEXT NOT NULL DEFAULT '{}',
        requested_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id)
      );

      CREATE TABLE IF NOT EXISTS capability_grants (
        id TEXT PRIMARY KEY,
        root_path TEXT NOT NULL,
        operations_json TEXT NOT NULL DEFAULT '["read"]',
        scope TEXT NOT NULL,
        allow_sensitive INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active',
        created_at TEXT NOT NULL,
        expires_at TEXT,
        revoked_at TEXT
      );

      CREATE TABLE IF NOT EXISTS policy_decisions (
        id TEXT PRIMARY KEY,
        run_id TEXT,
        approval_id TEXT,
        decision TEXT NOT NULL,
        detail_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY (run_id) REFERENCES agent_runs(id),
        FOREIGN KEY (approval_id) REFERENCES approval_requests(id)
      );

      CREATE INDEX IF NOT EXISTS idx_messages_session_time ON messages(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_events_day_time ON events(journal_day_id, occurred_at);
      CREATE INDEX IF NOT EXISTS idx_events_activity ON events(activity_id);
      CREATE INDEX IF NOT EXISTS idx_claims_status_scope ON memory_claims(status, scope_type, scope_id);
      CREATE INDEX IF NOT EXISTS idx_claims_key ON memory_claims(claim_key);
      CREATE INDEX IF NOT EXISTS idx_logs_time ON logs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_tasks_session ON agent_tasks(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_runs_task ON agent_runs(task_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_steps_run ON agent_steps(run_id, step_no);
      CREATE INDEX IF NOT EXISTS idx_tool_executions_run ON tool_executions(run_id, step_no);
      CREATE INDEX IF NOT EXISTS idx_approval_requests_run ON approval_requests(run_id, requested_at DESC);
      CREATE INDEX IF NOT EXISTS idx_capability_grants_status ON capability_grants(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_policy_decisions_run ON policy_decisions(run_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_context_snapshots_session ON context_snapshots(session_id, source_end_rowid DESC);
      CREATE INDEX IF NOT EXISTS idx_extraction_runs_session ON memory_extraction_runs(session_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_event_sources_message ON event_sources(message_id);
      CREATE INDEX IF NOT EXISTS idx_claim_relations_target ON claim_relations(target_claim_id);
      CREATE INDEX IF NOT EXISTS idx_topics_status_active ON topic_threads(status, last_active_at DESC);
      CREATE INDEX IF NOT EXISTS idx_topic_items_topic ON topic_items(topic_id, item_type, status, created_at);
      CREATE INDEX IF NOT EXISTS idx_topic_event_links_event ON topic_event_links(event_id);
      CREATE INDEX IF NOT EXISTS idx_open_loops_topic_status ON open_loops(topic_id, status, priority DESC);
      CREATE INDEX IF NOT EXISTS idx_continuity_runs_time ON continuity_update_runs(started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_topic_aliases_topic ON topic_aliases(topic_id);
      CREATE INDEX IF NOT EXISTS idx_topic_relations_target ON topic_relations(target_topic_id, relation);
      CREATE INDEX IF NOT EXISTS idx_topic_health_topic ON topic_health_runs(topic_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_topic_rebuild_topic ON topic_rebuild_runs(topic_id, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_topic_merge_status ON topic_merge_candidates(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_topic_merge_topics ON topic_merge_candidates(topic_a_id, topic_b_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_continuity_feedback_retrieval ON continuity_feedback(retrieval_log_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_continuity_eval_time ON continuity_eval_runs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_continuity_profiles_status ON continuity_profiles(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_claim_slots_lookup ON claim_slots(namespace, scope_type, scope_id, subject, predicate);
      CREATE INDEX IF NOT EXISTS idx_claim_transitions_slot ON claim_transitions(slot_id, effective_at DESC, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_claim_transition_evidence_event ON claim_transition_evidence(event_id);
      CREATE INDEX IF NOT EXISTS idx_embedding_jobs_ready ON embedding_jobs(status, available_at);
      CREATE INDEX IF NOT EXISTS idx_embeddings_profile_status ON memory_embeddings(embedding_profile_id, status, object_type);
      CREATE INDEX IF NOT EXISTS idx_retrieval_stage_retrieval ON retrieval_stage_logs(retrieval_id, created_at);
    `);

    const ensureColumn = (table, column, definition) => {
      const columns = this.all(`PRAGMA table_info(${table})`).map((item) => item.name);
      if (!columns.includes(column)) this.db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    };
    ensureColumn("messages", "memory_processed_at", "TEXT");
    ensureColumn("agent_tasks", "related_topic_id", "TEXT");
    ensureColumn("agent_tasks", "related_open_loop_id", "TEXT");
    ensureColumn("tool_executions", "approval_id", "TEXT");
    ensureColumn("events", "continuity_value", "REAL NOT NULL DEFAULT 0");
    ensureColumn("events", "continuity_score_version", "TEXT NOT NULL DEFAULT 'unknown-legacy'");
    ensureColumn("events", "continuity_components_json", "TEXT NOT NULL DEFAULT '{}'");
    ensureColumn("memory_claims", "epistemic_basis", "TEXT NOT NULL DEFAULT 'unknown_legacy'");
    ensureColumn("memory_claims", "slot_id", "TEXT");
    ensureColumn("memory_claims", "temporal_state", "TEXT NOT NULL DEFAULT 'unknown'");
    ensureColumn("memory_claims", "asserted_at", "TEXT");
    ensureColumn("memory_claims", "temporal_basis", "TEXT NOT NULL DEFAULT 'unknown_legacy'");
    ensureColumn("memory_claims", "temporal_precision", "TEXT NOT NULL DEFAULT 'unknown'");
    ensureColumn("memory_claims", "temporal_confidence", "REAL NOT NULL DEFAULT 0");
    ensureColumn("memory_claims", "supersession_reason", "TEXT");
    ensureColumn("context_snapshots", "continuity_refs_json", "TEXT NOT NULL DEFAULT '{}'");
    ensureColumn("continuity_update_runs", "source_message_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn("state_revisions", "idempotency_key", "TEXT");
    ensureColumn("retrieval_logs", "score_version", "TEXT NOT NULL DEFAULT 'memory-retrieval-v1'");
    ensureColumn("retrieval_logs", "route_json", "TEXT NOT NULL DEFAULT '{}'");
    ensureColumn("retrieval_logs", "selected_topic_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn("retrieval_logs", "selected_topic_item_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn("retrieval_logs", "selected_open_loop_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn("retrieval_logs", "outcome_json", "TEXT NOT NULL DEFAULT '{}'");
    ensureColumn("topic_threads", "continuity_score_version", "TEXT NOT NULL DEFAULT 'unknown-legacy'");
    ensureColumn("topic_threads", "continuity_components_json", "TEXT NOT NULL DEFAULT '{}'");
    ensureColumn("topic_threads", "canonical_topic_id", "TEXT");
    ensureColumn("topic_threads", "active_item_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn("topic_threads", "tentative_item_ids_json", "TEXT NOT NULL DEFAULT '[]'");
    ensureColumn("topic_items", "continuity_score_version", "TEXT NOT NULL DEFAULT 'unknown-legacy'");
    ensureColumn("topic_items", "continuity_components_json", "TEXT NOT NULL DEFAULT '{}'");
    ensureColumn("topic_items", "confidence", "REAL NOT NULL DEFAULT 0.8");
    ensureColumn("topic_items", "valid_from", "TEXT");
    ensureColumn("topic_items", "valid_to", "TEXT");
    ensureColumn("open_loops", "continuity_score_version", "TEXT NOT NULL DEFAULT 'unknown-legacy'");
    ensureColumn("open_loops", "continuity_components_json", "TEXT NOT NULL DEFAULT '{}'");
    this.migrateClaimSlots();
    this.db.run("CREATE INDEX IF NOT EXISTS idx_memory_claims_slot_state ON memory_claims(slot_id, status, temporal_state, valid_from DESC)");
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_single_current_active ON memory_claims(slot_id) WHERE slot_id IS NOT NULL AND cardinality = 'single' AND status = 'active' AND temporal_state = 'current'");
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_set_current_value_active ON memory_claims(slot_id, value_hash) WHERE slot_id IS NOT NULL AND cardinality = 'set' AND status = 'active' AND temporal_state = 'current'");
    this.db.run("CREATE UNIQUE INDEX IF NOT EXISTS idx_state_revisions_idempotency ON state_revisions(idempotency_key) WHERE idempotency_key IS NOT NULL");
    this.db.run(
      `UPDATE memory_claims SET epistemic_basis = 'stated_by_user'
       WHERE epistemic_basis = 'unknown_legacy' AND EXISTS (
         SELECT 1 FROM memory_evidence me
         JOIN events e ON e.id = me.event_id
         WHERE me.claim_id = memory_claims.id AND e.actor = 'user'
       )`,
    );
  }

  migrateClaimSlots() {
    const normalize = (value, fallback = "unknown") => String(value || fallback).trim().toLowerCase().replace(/\s+/g, "_");
    const slotIdFor = (key) => `slot_${crypto.createHash("sha256").update(key).digest("hex").slice(0, 24)}`;
    const now = isoNow();
    const claims = this.all("SELECT * FROM memory_claims ORDER BY created_at ASC, id ASC");

    for (const claim of claims) {
      const canonicalKey = [
        normalize(claim.namespace, "user"),
        normalize(claim.scope_type, "global"),
        normalize(claim.scope_id, "global"),
        normalize(claim.subject, "user"),
        normalize(claim.predicate, claim.claim_type || "fact"),
      ].join(":");
      const slotId = claim.slot_id || slotIdFor(canonicalKey);
      const cardinality = claim.cardinality === "multi" || claim.cardinality === "set" ? "set" : "single";
      this.db.run(
        `INSERT INTO claim_slots (
          id, namespace, subject, predicate, scope_type, scope_id, canonical_key,
          cardinality, temporal_mode, status, created_at, updated_at
        ) VALUES ($id, $namespace, $subject, $predicate, $scopeType, $scopeId, $canonicalKey,
          $cardinality, 'current_state', 'active', $createdAt, $updatedAt)
        ON CONFLICT(canonical_key) DO UPDATE SET
          cardinality = CASE WHEN claim_slots.cardinality = 'set' OR excluded.cardinality = 'set' THEN 'set' ELSE 'single' END,
          updated_at = excluded.updated_at`,
        {
          $id: slotId,
          $namespace: claim.namespace || "user",
          $subject: claim.subject || "user",
          $predicate: claim.predicate || claim.claim_type || "fact",
          $scopeType: claim.scope_type || "global",
          $scopeId: claim.scope_id || null,
          $canonicalKey: canonicalKey,
          $cardinality: cardinality,
          $createdAt: claim.created_at || now,
          $updatedAt: now,
        },
      );
      const storedSlot = this.get("SELECT id, cardinality FROM claim_slots WHERE canonical_key = $key", { $key: canonicalKey });
      const temporalState = claim.temporal_state && claim.temporal_state !== "unknown"
        ? claim.temporal_state
        : claim.status === "active" && claim.valid_to && claim.valid_to <= now
          ? "historical"
          : claim.status === "active" && claim.valid_from && claim.valid_from > now
            ? "future"
            : claim.status === "active"
              ? "current"
              : "unknown";
      this.db.run(
        `UPDATE memory_claims SET
          slot_id = $slotId,
          cardinality = $cardinality,
          temporal_state = $temporalState,
          asserted_at = COALESCE(asserted_at, created_at),
          temporal_basis = CASE WHEN temporal_basis = 'unknown_legacy' THEN 'legacy_default' ELSE temporal_basis END
         WHERE id = $id`,
        {
          $slotId: storedSlot.id,
          $cardinality: storedSlot.cardinality,
          $temporalState: temporalState,
          $id: claim.id,
        },
      );
    }

    this.db.run(
      `UPDATE memory_claims SET cardinality = (
        SELECT cardinality FROM claim_slots WHERE claim_slots.id = memory_claims.slot_id
      ) WHERE slot_id IS NOT NULL`,
    );

    const conflictingSlots = this.all(
      `SELECT slot_id, COUNT(*) AS count, COUNT(DISTINCT value_hash) AS value_count
       FROM memory_claims
       WHERE slot_id IS NOT NULL AND cardinality = 'single' AND status = 'active' AND temporal_state = 'current'
       GROUP BY slot_id HAVING COUNT(*) > 1`,
    );
    for (const group of conflictingSlots) {
      const members = this.all(
        `SELECT * FROM memory_claims WHERE slot_id = $slotId
         AND cardinality = 'single' AND status = 'active' AND temporal_state = 'current'
         ORDER BY confidence DESC, updated_at DESC, id ASC`,
        { $slotId: group.slot_id },
      );
      if (Number(group.value_count) === 1) {
        const [keeper, ...duplicates] = members;
        for (const duplicate of duplicates) {
          this.db.run(
            "INSERT OR IGNORE INTO memory_evidence (claim_id, event_id, relation, weight, created_at) SELECT $keeperId, event_id, relation, weight, created_at FROM memory_evidence WHERE claim_id = $duplicateId",
            { $keeperId: keeper.id, $duplicateId: duplicate.id },
          );
          this.db.run(
            "UPDATE memory_claims SET status = 'superseded', temporal_state = 'unknown', superseded_by = $keeperId, supersession_reason = 'legacy_duplicate', updated_at = $now WHERE id = $id",
            { $keeperId: keeper.id, $now: now, $id: duplicate.id },
          );
          this.db.run(
            "INSERT OR IGNORE INTO claim_relations (source_claim_id, target_claim_id, relation, confidence, source_run_id, created_at) VALUES ($source, $target, 'same_as', 1, 'migration-v0.6', $now)",
            { $source: duplicate.id, $target: keeper.id, $now: now },
          );
        }
      } else {
        this.db.run(
          `UPDATE memory_claims SET status = 'disputed', temporal_state = 'unknown',
           supersession_reason = 'legacy_unresolved_conflict', updated_at = $now
           WHERE slot_id = $slotId AND cardinality = 'single' AND status = 'active' AND temporal_state = 'current'`,
          { $slotId: group.slot_id, $now: now },
        );
      }
    }
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
    this.db.run(
      "UPDATE topic_rebuild_runs SET status = 'interrupted', error = $error, completed_at = $now WHERE status = 'running'",
      { $error: error, $now: now },
    );
    this.db.run(
      "UPDATE topic_merge_candidates SET status = 'interrupted', error = $error, updated_at = $now WHERE status = 'adjudicating'",
      { $error: error, $now: now },
    );
    this.db.run(
      "UPDATE agent_runs SET status = 'interrupted', error = $error, completed_at = $now WHERE status = 'running'",
      { $error: error, $now: now },
    );
    this.db.run(
      "UPDATE agent_tasks SET status = 'interrupted', completed_at = $now, updated_at = $now WHERE status = 'running'",
      { $now: now },
    );
    this.db.run(
      "UPDATE approval_requests SET status = 'interrupted', resolved_at = $now WHERE status = 'pending'",
      { $now: now },
    );
  }

  seed() {
    const legacyBaseUrl = this.get("SELECT value FROM app_settings WHERE key = 'baseUrl'")?.value;
    const defaultBaseUrl = legacyBaseUrl || "https://dashscope.aliyuncs.com/compatible-mode/v1";
    const defaults = {
      petName: "小步",
      themeMode: "system",
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
      embeddingEnabled: "true",
      remoteEmbeddingConsent: "true",
      embeddingBaseUrl: "https://dashscope.aliyuncs.com/api/v1",
      embeddingModel: "text-embedding-v4",
      embeddingDimension: "1024",
      embeddingBatchSize: "10",
      hybridRetrievalEnabled: "true",
      rerankerEnabled: "true",
      rerankerModel: "qwen3.7-max",
      rerankerTimeoutMs: "5000",
      temperature: "0.7",
      autoSpeak: "true",
      agentEnabled: "true",
      agentWorkspaceRoot: process.cwd(),
      agentMaxSteps: "8",
      agentTimeoutSeconds: "300",
      agentAllowedExecutables: "git,npm,npx,node,python",
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
      `INSERT OR IGNORE INTO embedding_profiles
       (id, provider, api_style, model, dimension, document_schema_version,
        config_json, status, created_at, updated_at)
       VALUES ('aliyun-text-embedding-v4-1024-v1', 'aliyun', 'dashscope-native',
        'text-embedding-v4', 1024, 'pet-memory-document-v1', '{}', 'active', $now, $now)`,
      { $now: stamp },
    );
    this.db.run(
      `INSERT OR IGNORE INTO retrieval_profiles
       (id, version, config_json, status, created_at, activated_at)
       VALUES ('hybrid-rrf-v1', 'memory-retrieval-v3', $config, 'active', $now, $now)`,
      {
        $config: JSON.stringify({ rrf_k: 60, weights: { lexical: 1.2, semantic: 1.1, structural: 0.6 }, semantic_floor: 0.15 }),
        $now: stamp,
      },
    );
    this.db.run(
      `INSERT OR IGNORE INTO reranker_profiles
       (id, version, model, config_json, status, created_at, activated_at)
       VALUES ('structured-reranker-v1', 'memory-reranker-v1', 'qwen3.7-max',
        '{"max_candidates":20,"timeout_ms":5000}', 'active', $now, $now)`,
      { $now: stamp },
    );
    this.db.run(
      `INSERT OR IGNORE INTO continuity_state
       (id, recent_topic_ids_json, updated_at) VALUES ('primary', '[]', $updatedAt)`,
      { $updatedAt: stamp },
    );
    this.db.run(
      `INSERT OR IGNORE INTO continuity_profile_state
       (id, active_profile_id, updated_at) VALUES ('primary', 'continuity-profile-v1', $updatedAt)`,
      { $updatedAt: stamp },
    );
    const baselineProfile = getContinuityProfile();
    this.db.run(
      `INSERT OR IGNORE INTO continuity_profiles
       (id, profile_json, status, created_at, approved_at, activated_at)
       VALUES ($id, $profile, 'baseline', $createdAt, $approvedAt, $activatedAt)`,
      {
        $id: baselineProfile.id,
        $profile: JSON.stringify(baselineProfile),
        $createdAt: stamp,
        $approvedAt: stamp,
        $activatedAt: stamp,
      },
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

  listSessions(limit = 100) {
    const safeLimit = Math.min(200, Math.max(1, Number(limit) || 100));
    return this.all(
      `SELECT s.*,
              COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.session_id = s.id), s.started_at) AS last_message_at,
              COALESCE((SELECT m.content FROM messages m WHERE m.session_id = s.id ORDER BY m.created_at DESC LIMIT 1), '') AS preview
       FROM sessions s
       ORDER BY last_message_at DESC, s.started_at DESC
       LIMIT $limit`,
      { $limit: safeLimit },
    );
  }

  messagesForSession(sessionId, limit = 100) {
    const safeLimit = Math.min(500, Math.max(1, Number(limit) || 100));
    return this.all(
      `SELECT * FROM messages WHERE session_id = $sessionId
       ORDER BY created_at DESC LIMIT $limit`,
      { $sessionId: sessionId, $limit: safeLimit },
    ).reverse();
  }

  activateSession(sessionId) {
    const selected = this.get("SELECT * FROM sessions WHERE id = $id", { $id: sessionId });
    if (!selected) throw new Error("会话不存在或已被删除。");
    const now = isoNow();
    this.transaction(() => {
      this.db.run(
        "UPDATE sessions SET ended_at = $endedAt WHERE ended_at IS NULL AND id != $id",
        { $id: sessionId, $endedAt: now },
      );
      this.db.run("UPDATE sessions SET ended_at = NULL WHERE id = $id", { $id: sessionId });
    });
    return this.get("SELECT * FROM sessions WHERE id = $id", { $id: sessionId });
  }

  renameSession(sessionId, title) {
    const id = String(sessionId || "").trim();
    const nextTitle = String(title || "").trim().replace(/\s+/g, " ");
    if (!id) throw new Error("会话 ID 不能为空。");
    if (!nextTitle) throw new Error("会话名称不能为空。");
    if (nextTitle.length > 80) throw new Error("会话名称不能超过 80 个字符。");
    const session = this.get("SELECT id FROM sessions WHERE id = $id", { $id: id });
    if (!session) throw new Error("会话不存在或已被删除。");
    this.run("UPDATE sessions SET title = $title WHERE id = $id", { $id: id, $title: nextTitle });
    return this.get("SELECT * FROM sessions WHERE id = $id", { $id: id });
  }

  deleteSession(sessionId) {
    const id = String(sessionId || "").trim();
    if (!id) throw new Error("会话 ID 不能为空。");
    const session = this.get("SELECT * FROM sessions WHERE id = $id", { $id: id });
    if (!session) throw new Error("会话不存在或已被删除。");
    this.transaction(() => {
      const runIds = this.all("SELECT id FROM agent_runs WHERE session_id = $id", { $id: id }).map((row) => row.id);
      for (const runId of runIds) {
        this.db.run("DELETE FROM policy_decisions WHERE run_id = $runId", { $runId: runId });
        this.db.run("DELETE FROM approval_requests WHERE run_id = $runId", { $runId: runId });
        this.db.run("DELETE FROM tool_executions WHERE run_id = $runId", { $runId: runId });
        this.db.run("DELETE FROM agent_steps WHERE run_id = $runId", { $runId: runId });
      }
      this.db.run("DELETE FROM agent_runs WHERE session_id = $id", { $id: id });
      this.db.run("DELETE FROM agent_tasks WHERE session_id = $id", { $id: id });

      this.db.run("DELETE FROM context_compaction_runs WHERE session_id = $id", { $id: id });
      this.db.run("UPDATE context_snapshots SET parent_snapshot_id = NULL WHERE session_id = $id", { $id: id });
      this.db.run("DELETE FROM context_snapshots WHERE session_id = $id", { $id: id });
      this.db.run("DELETE FROM retrieval_logs WHERE session_id = $id", { $id: id });

      // Preserve materialized memory/state runs while detaching the deleted chat container.
      this.db.run("UPDATE memory_extraction_runs SET session_id = NULL WHERE session_id = $id", { $id: id });
      this.db.run("UPDATE continuity_update_runs SET session_id = NULL WHERE session_id = $id", { $id: id });
      this.db.run(
        `UPDATE events SET source_kind = 'deleted_session', source_id = NULL, hermes_session_id = NULL
         WHERE hermes_session_id = $id OR source_id IN (SELECT id FROM messages WHERE session_id = $id)`,
        { $id: id },
      );
      this.db.run(
        "DELETE FROM event_sources WHERE message_id IN (SELECT id FROM messages WHERE session_id = $id)",
        { $id: id },
      );
      this.db.run("DELETE FROM messages WHERE session_id = $id", { $id: id });
      this.db.run("DELETE FROM sessions WHERE id = $id", { $id: id });
    });
    return session;
  }

  getSettings() {
    const rows = this.all("SELECT key, value FROM app_settings");
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  saveSettings(settings) {
    const stamp = isoNow();
    this.transaction(() => {
      for (const [key, value] of Object.entries(settings)) {
        if (key === "apiKey" || key === "hasApiKey" || key === "agentDirectoryGrants" || value === undefined) continue;
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
