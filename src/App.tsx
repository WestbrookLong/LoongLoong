import { AlertCircle, CheckCircle2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ChatPanel } from "./components/ChatPanel";
import { DataInspector } from "./components/DataInspector";
import { Navigation } from "./components/Navigation";
import { PetStage } from "./components/PetStage";
import { SettingsView } from "./components/SettingsView";
import { useVoiceConversation } from "./hooks/useVoiceConversation";
import type { Bootstrap, Dashboard, Message, Route, Settings } from "./types";

interface Toast {
  id: number;
  message: string;
  error: boolean;
}

export default function App() {
  const [route, setRoute] = useState<Route>("chat");
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);

  const notify = useCallback((message: string, error = false) => {
    const next = { id: Date.now(), message, error };
    setToast(next);
    window.setTimeout(() => setToast((current) => current?.id === next.id ? null : current), 3600);
  }, []);

  useEffect(() => {
    window.pet.bootstrap()
      .then((data) => {
        setBoot(data);
        setMessages(data.messages);
        setSettings(data.settings);
        setDashboard(data.dashboard);
      })
      .catch((error) => notify(error instanceof Error ? error.message : String(error), true));
  }, [notify]);

  const send = useCallback(async (text: string, modality: "text" | "voice", deep = false) => {
    if (busy) return undefined;
    const tempId = `temp-${Date.now()}`;
    const optimistic: Message = {
      id: tempId,
      session_id: boot?.session.id || "",
      role: "user",
      content: text,
      modality,
      token_estimate: 0,
      metadata_json: "{}",
      created_at: new Date().toISOString(),
    };
    setMessages((current) => [...current, optimistic]);
    setBusy(true);
    try {
      const result = await window.pet.sendMessage({ text, modality, deep });
      setMessages((current) => [
        ...current.filter((message) => message.id !== tempId),
        result.userMessage,
        result.assistantMessage,
      ]);
      setDashboard(result.dashboard);
      return result.assistantMessage.content;
    } catch (error) {
      setMessages((current) => current.filter((message) => message.id !== tempId));
      notify(error instanceof Error ? error.message : String(error), true);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [boot?.session.id, busy, notify]);

  const voice = useVoiceConversation({
    autoSpeak: settings?.autoSpeak ?? true,
    onTranscript: (text) => send(text, "voice"),
    onError: (message) => notify(message, true),
  });

  const newChat = async () => {
    if (busy) return;
    try {
      const result = await window.pet.newChat();
      setMessages(result.messages);
      setBoot((current) => current ? { ...current, session: result.session, messages: result.messages } : current);
      setRoute("chat");
      setDashboard(await window.pet.getDashboard());
    } catch (error) {
      notify(error instanceof Error ? error.message : String(error), true);
    }
  };

  if (!boot || !settings || !dashboard) {
    return <div className="app-loading"><span /><span /><span /></div>;
  }

  return (
    <div className="app-shell">
      <Navigation route={route} onRoute={setRoute} onNewChat={() => void newChat()} />

      {route === "chat" && (
        <main className="conversation-view">
          <PetStage
            name={settings.petName}
            status={busy && voice.status === "idle" ? "thinking" : voice.status}
            level={voice.level}
            continuous={voice.continuous}
            onMic={() => void voice.toggleManual()}
            onContinuous={(enabled) => void voice.setContinuous(enabled)}
            disabled={busy && voice.status === "idle"}
          />
          <ChatPanel
            messages={messages}
            busy={busy}
            onSend={(text, deep) => send(text, "text", deep).then(() => undefined)}
            onMic={() => void voice.toggleManual()}
          />
          <div className="dev-stats" aria-label="开发状态">
            <span><b>{dashboard.events}</b> 事件</span>
            <span><b>{dashboard.memories}</b> 记忆</span>
            <span><b>{dashboard.retrievals}</b> 检索</span>
          </div>
        </main>
      )}

      {route === "history" && (
        <DataInspector kind="history" dashboard={dashboard} onDashboard={setDashboard} notify={notify} />
      )}
      {route === "memory" && (
        <DataInspector kind="memory" dashboard={dashboard} onDashboard={setDashboard} notify={notify} />
      )}
      {route === "logs" && (
        <DataInspector kind="logs" dashboard={dashboard} onDashboard={setDashboard} notify={notify} />
      )}
      {route === "settings" && (
        <SettingsView settings={settings} onSaved={setSettings} notify={notify} />
      )}

      {toast && (
        <div className={`toast ${toast.error ? "error" : "success"}`} role="status">
          {toast.error ? <AlertCircle size={18} /> : <CheckCircle2 size={18} />}
          {toast.message}
        </div>
      )}
    </div>
  );
}

