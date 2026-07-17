import { ArrowUp, Mic, Search } from "lucide-react";
import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import type { Message } from "../types";

interface Props {
  messages: Message[];
  busy: boolean;
  onSend: (text: string, deep?: boolean) => Promise<void>;
  onMic: () => void;
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

export function ChatPanel({ messages, busy, onSend, onMic }: Props) {
  const [text, setText] = useState("");
  const [deep, setDeep] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const initializedRef = useRef(false);

  useEffect(() => {
    const list = listRef.current;
    if (!list || (initializedRef.current && !stickToBottomRef.current)) return;

    const frame = window.requestAnimationFrame(() => {
      list.scrollTo({
        top: list.scrollHeight,
        behavior: initializedRef.current ? "smooth" : "auto",
      });
      initializedRef.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages.length, busy]);

  const updateScrollPosition = () => {
    const list = listRef.current;
    if (!list) return;
    stickToBottomRef.current = list.scrollHeight - list.scrollTop - list.clientHeight < 72;
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    stickToBottomRef.current = true;
    setText("");
    await onSend(value, deep);
    setDeep(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <section className="chat-panel">
      <header className="panel-header">
        <div>
          <h1>对话</h1>
          <span>{messages.length} 条消息</span>
        </div>
        <button
          className={`deep-toggle ${deep ? "active" : ""}`}
          title="深度回忆"
          onClick={() => setDeep((current) => !current)}
        >
          <Search size={16} />
          深度回忆
        </button>
      </header>

      <div ref={listRef} className="message-list" onScroll={updateScrollPosition}>
        {messages.map((message) => (
          <article key={message.id} className={`message ${message.role}`}>
            <div className="message-meta">
              <span>{message.role === "user" ? "你" : "Pet"}</span>
              <time>{formatTime(message.created_at)}</time>
              {message.modality === "voice" && <Mic size={13} />}
            </div>
            <p>{message.content}</p>
          </article>
        ))}
        {busy && (
          <div className="thinking-row" aria-label="正在思考">
            <span /><span /><span />
          </div>
        )}
      </div>

      <form className="composer" onSubmit={submit}>
        <textarea
          value={text}
          rows={1}
          placeholder="输入消息"
          aria-label="输入消息"
          disabled={busy}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <button type="button" className="composer-icon" title="语音输入" onClick={onMic} disabled={busy}>
          <Mic size={19} />
        </button>
        <button type="submit" className="send-button" title="发送" disabled={busy || !text.trim()}>
          <ArrowUp size={19} />
        </button>
      </form>
    </section>
  );
}
