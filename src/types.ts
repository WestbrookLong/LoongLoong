export type Route = "chat" | "history" | "memory" | "logs" | "settings";
export type ThemeMode = "light" | "dark" | "system";

export interface Message {
  id: string;
  session_id: string;
  role: "user" | "assistant";
  content: string;
  modality: string;
  token_estimate: number;
  metadata_json: string;
  created_at: string;
  session_title?: string;
}

export interface Session {
  id: string;
  title: string;
  started_at: string;
  ended_at?: string;
  message_count: number;
  last_message_at?: string;
  preview?: string;
}

export interface Settings {
  petName: string;
  themeMode: ThemeMode;
  chatBaseUrl: string;
  transcriptionBaseUrl: string;
  chatModel: string;
  transcriptionModel: string;
  memoryModel: string;
  compressionModel: string;
  contextWindowTokens: string;
  reservedOutputTokens: string;
  contextSoftThreshold: string;
  contextTargetRatio: string;
  memoryBatchSize: string;
  embeddingEnabled: boolean;
  remoteEmbeddingConsent: boolean;
  embeddingBaseUrl: string;
  embeddingModel: string;
  embeddingDimension: string;
  embeddingBatchSize: string;
  temperature: string;
  autoSpeak: boolean;
  agentEnabled: boolean;
  agentWorkspaceRoot: string;
  agentMaxSteps: string;
  agentTimeoutSeconds: string;
  agentAllowedExecutables: string;
  agentDirectoryGrants: DirectoryGrant[];
  systemPrompt: string;
  hasApiKey: boolean;
  apiKey?: string;
}

export interface Dashboard {
  messages: number;
  events: number;
  memories: number;
  candidates: number;
  claimSlots: number;
  claimTransitions: number;
  logs: number;
  retrievals: number;
  retrievalStages: number;
  contextSnapshots: number;
  memoryExtractions: number;
  contextCompactions: number;
  topics: number;
  openLoops: number;
  continuityUpdates: number;
  topicHealthWarnings: number;
  topicRebuilds: number;
  topicMergeCandidates: number;
  continuityFeedback: number;
  continuityEvalRuns: number;
  agentTasks: number;
  agentRuns: number;
  toolExecutions: number;
  approvals: number;
  capabilityGrants: number;
  embeddings: number;
  embeddingJobs: number;
  databasePath: string;
}

export interface Bootstrap {
  settings: Settings;
  session: Session;
  messages: Message[];
  sessions: Session[];
  dashboard: Dashboard;
}

export interface ChatResult {
  userMessage: Message;
  assistantMessage: Message;
  retrieval: {
    id: string;
    tokenEstimate: number;
    selectedClaimIds: string[];
    selectedEventIds: string[];
  };
  dashboard: Dashboard;
  sessions: Session[];
}

export interface ChatStreamEvent {
  requestId: string;
  reasoningContentDelta?: string;
  contentDelta?: string;
  agentEvent?: AgentEvent;
}

export interface AgentToolEvent {
  type: "tool_started" | "tool_completed";
  step: number;
  tool_call_id: string;
  tool: string;
  arguments?: Record<string, unknown>;
  result?: {
    ok: boolean;
    summary?: string;
    error?: string;
    duration_ms?: number;
    provenance?: Record<string, unknown>;
  };
}

export interface AgentApprovalEvent {
  type: "approval_required" | "approval_resolved";
  approval_id: string;
  step?: number;
  tool_call_id?: string;
  tool?: string;
  operation?: string;
  risk?: "medium" | "high";
  resource_kind?: "path" | "command";
  requested_path?: string;
  suggested_root?: string;
  sensitive?: boolean;
  reason?: string;
  preview?: {
    path?: string;
    kind?: string;
    diff?: string;
    diff_truncated?: boolean;
    proposed_chars?: number;
    existing_content_unavailable?: boolean;
    proposed_preview?: string;
    proposed_preview_truncated?: boolean;
  };
  command?: { executable: string; args: string[]; cwd: string; signature: string };
  decision?: string;
}

export type AgentEvent = AgentToolEvent | AgentApprovalEvent;

export interface DirectoryGrant {
  id: string;
  root_path: string;
  operations: string[];
  scope: string;
  allow_sensitive: boolean;
  expires_at?: string | null;
}

export interface StreamingResponse {
  requestId: string;
  reasoningContent: string;
  content: string;
  startedAt: number;
  activities: AgentToolEvent[];
  approvals: AgentApprovalEvent[];
}

export interface VoicePayload {
  bytes: ArrayBuffer;
  mimeType: string;
}

export interface PetApi {
  bootstrap(): Promise<Bootstrap>;
  sendMessage(payload: { requestId: string; sessionId: string; text: string; modality: "text" | "voice"; deep?: boolean }): Promise<ChatResult>;
  cancelChat(requestId: string): Promise<{ cancelled: boolean }>;
  resolveAgentApproval(payload: { requestId: string; approvalId: string; decision: "approve" | "deny"; scope?: "once" | "task"; chooseDirectory?: boolean }): Promise<{ resolved: boolean; decision: string }>;
  agentRuntimeHealth(): Promise<{ ok: boolean; runtime_version: string; protocol: number; mode: string; capabilities: string[] }>;
  addAgentDirectory(): Promise<{ cancelled: boolean; grants: DirectoryGrant[] }>;
  revokeAgentGrant(id: string): Promise<{ grants: DirectoryGrant[] }>;
  onChatStream(callback: (event: ChatStreamEvent) => void): () => void;
  newChat(): Promise<{ session: Session; messages: Message[]; sessions: Session[] }>;
  switchSession(sessionId: string): Promise<{ session: Session; messages: Message[]; sessions: Session[] }>;
  renameSession(payload: { sessionId: string; title: string }): Promise<{ session: Session; sessions: Session[] }>;
  deleteSession(sessionId: string): Promise<{ session: Session; messages: Message[]; sessions: Session[] }>;
  transcribe(payload: VoicePayload): Promise<{ text: string }>;
  getRecords(payload: { type: string; search?: string; limit?: number }): Promise<Record<string, unknown>[]>;
  getDashboard(): Promise<Dashboard>;
  consolidate(date?: string): Promise<Record<string, unknown>>;
  scanTopics(): Promise<{ candidateIds: string[]; adjudications: Record<string, unknown>[] }>;
  reindexEmbeddings(): Promise<{ queued: number; processed: number; failed: number }>;
  evaluateContinuity(): Promise<{ runId: string; recommendation: { action: string; safe: boolean } }>;
  continuityProfileAction(payload: { action: "stage" | "promote"; profileId: string }): Promise<{ applied: boolean; reason?: string }>;
  openExternal(url: string): Promise<void>;
  getSettings(): Promise<Settings>;
  saveSettings(settings: Partial<Settings>): Promise<Settings>;
  testConnection(settings: Partial<Settings>): Promise<{ ok: boolean }>;
}
