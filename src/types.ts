export type Route = "chat" | "history" | "memory" | "logs" | "settings";

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
}

export interface Settings {
  petName: string;
  chatBaseUrl: string;
  transcriptionBaseUrl: string;
  chatModel: string;
  transcriptionModel: string;
  temperature: string;
  autoSpeak: boolean;
  systemPrompt: string;
  hasApiKey: boolean;
  apiKey?: string;
}

export interface Dashboard {
  messages: number;
  events: number;
  memories: number;
  candidates: number;
  logs: number;
  retrievals: number;
  databasePath: string;
}

export interface Bootstrap {
  settings: Settings;
  session: Session;
  messages: Message[];
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
}

export interface VoicePayload {
  bytes: ArrayBuffer;
  mimeType: string;
}

export interface PetApi {
  bootstrap(): Promise<Bootstrap>;
  sendMessage(payload: { text: string; modality: "text" | "voice"; deep?: boolean }): Promise<ChatResult>;
  newChat(): Promise<{ session: Session; messages: Message[] }>;
  transcribe(payload: VoicePayload): Promise<{ text: string }>;
  getRecords(payload: { type: string; search?: string; limit?: number }): Promise<Record<string, unknown>[]>;
  getDashboard(): Promise<Dashboard>;
  consolidate(date?: string): Promise<Record<string, unknown>>;
  getSettings(): Promise<Settings>;
  saveSettings(settings: Partial<Settings>): Promise<Settings>;
  testConnection(settings: Partial<Settings>): Promise<{ ok: boolean }>;
}
