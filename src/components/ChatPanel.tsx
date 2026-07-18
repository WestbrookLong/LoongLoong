import { ArrowUp, Mic, Search, Square } from "lucide-react";
import { FormEvent, KeyboardEvent, lazy, Suspense, useEffect, useRef, useState } from "react";
import type { Message, StreamingResponse } from "../types";
import { ReasoningPanel } from "./ReasoningPanel";
import { AgentActivityList } from "./AgentActivityList";

const MarkdownMessage = lazy(() => import("./MarkdownMessage").then((module) => ({
  default: module.MarkdownMessage,
})));

interface Props {
  messages: Message[];
  busy: boolean;
  streamingResponse: StreamingResponse | null;
  onSend: (text: string, deep?: boolean) => Promise<void>;
  onMic: () => void;
  onCancel: () => void;
}

function formatTime(value: string) {
  return new Date(value).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
}

function messageReasoning(message: Message) {
  try {
    const metadata = JSON.parse(message.metadata_json || "{}");
    return {
      content: String(metadata.reasoningContent || ""),
      durationMs: Number(metadata.reasoningDurationMs || 0),
    };
  } catch {
    return { content: "", durationMs: 0 };
  }
}

export function ChatPanel({ messages, busy, streamingResponse, onSend, onMic, onCancel }: Props) {
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
        behavior: initializedRef.current && !streamingResponse ? "smooth" : "auto",
      });
      initializedRef.current = true;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [messages.length, busy, streamingResponse?.reasoningContent.length, streamingResponse?.content.length, streamingResponse?.activities.length]);

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
        {messages.map((message) => {
          const reasoning = message.role === "assistant" ? messageReasoning(message) : null;
          return (
            <article key={message.id} className={`message ${message.role}`}>
              <div className="message-meta">
                <span>{message.role === "user" ? "你" : "Pet"}</span>
                <time>{formatTime(message.created_at)}</time>
                {message.modality === "voice" && <Mic size={13} />}
              </div>
              {reasoning?.content && <ReasoningPanel content={reasoning.content} durationMs={reasoning.durationMs} />}
              {message.role === "assistant"
                ? (
                  <Suspense fallback={<p>{message.content}</p>}>
                    <MarkdownMessage content={message.content} />
                  </Suspense>
                )
                : <p>{message.content}</p>}
            </article>
          );
        })}
        {busy && streamingResponse && (streamingResponse.reasoningContent || streamingResponse.content || streamingResponse.activities.length) && (
          <article className="message assistant streaming-message">
            <div className="message-meta"><span>Pet</span><time>正在回答</time></div>
            <ReasoningPanel
              content={streamingResponse.reasoningContent}
              active
              answerStarted={Boolean(streamingResponse.content)}
              startedAt={streamingResponse.startedAt}
            />
            <AgentActivityList activities={streamingResponse.activities} />
            {streamingResponse.content && (
              <Suspense fallback={<p>{streamingResponse.content}</p>}>
                <MarkdownMessage content={streamingResponse.content} />
              </Suspense>
            )}
          </article>
        )}
        {busy && !streamingResponse?.reasoningContent && !streamingResponse?.content && !streamingResponse?.activities.length && (
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
        {busy
          ? <button type="button" className="send-button cancel-run" title="停止 Agent" onClick={onCancel}><Square size={15} /></button>
          : <button type="submit" className="send-button" title="发送" disabled={!text.trim()}><ArrowUp size={19} /></button>}
      </form>
    </section>
  );
}
