function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
}

function endpoint(baseUrl, path) {
  const normalized = normalizeBaseUrl(baseUrl);
  return normalized.endsWith(path) ? normalized : `${normalized}${path}`;
}

function requestHeaders(apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function parseJsonResponse(content) {
  const text = String(content || "").trim();
  const unfenced = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(unfenced);
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(unfenced.slice(start, end + 1));
    throw new Error("智能记忆模型没有返回有效的 JSON。");
  }
}

async function structuredCompletion({ settings, apiKey, model, messages, temperature = 0.1 }) {
  const baseUrl = normalizeBaseUrl(settings.chatBaseUrl || settings.baseUrl);
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(baseUrl);
  if (!apiKey && !isLocal) throw new Error("请先配置模型 API 密钥以启用智能记忆。");

  const payload = {
    model: model || settings.memoryModel || settings.chatModel,
    messages,
    temperature,
    response_format: { type: "json_object" },
  };
  let response = await fetch(endpoint(baseUrl, "/chat/completions"), {
    method: "POST",
    headers: requestHeaders(apiKey),
    body: JSON.stringify(payload),
  });
  if (!response.ok && response.status === 400) {
    delete payload.response_format;
    response = await fetch(endpoint(baseUrl, "/chat/completions"), {
      method: "POST",
      headers: requestHeaders(apiKey),
      body: JSON.stringify(payload),
    });
  }
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`智能记忆请求失败 (${response.status}): ${details.slice(0, 500)}`);
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("智能记忆模型返回了空响应。");
  return {
    data: parseJsonResponse(content),
    raw: String(content),
    usage: data.usage || {},
  };
}

function chatDeltaText(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => typeof item === "string" ? item : String(item?.text || item?.content || "")).join("");
}

async function readChatStream(response, onDelta) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream")) {
    const data = await response.json();
    const message = data?.choices?.[0]?.message || {};
    const reasoningContent = chatDeltaText(message.reasoning_content ?? message.reasoning);
    const content = chatDeltaText(message.content);
    if (reasoningContent) onDelta({ reasoningContentDelta: reasoningContent, contentDelta: "" });
    if (content) onDelta({ reasoningContentDelta: "", contentDelta: content });
    return { content, reasoningContent, reasoningDurationMs: 0 };
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error("模型流式响应不可读取。");
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let reasoningContent = "";
  const startedAt = Date.now();
  let answerStartedAt = 0;

  const consumeEvent = (block) => {
    const payload = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!payload || payload === "[DONE]") return;
    const data = JSON.parse(payload);
    const delta = data?.choices?.[0]?.delta || {};
    const reasoningContentDelta = chatDeltaText(delta.reasoning_content ?? delta.reasoning);
    const contentDelta = chatDeltaText(delta.content);
    if (!reasoningContentDelta && !contentDelta) return;
    reasoningContent += reasoningContentDelta;
    if (contentDelta && !answerStartedAt) answerStartedAt = Date.now();
    content += contentDelta;
    onDelta({ reasoningContentDelta, contentDelta });
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || "";
    for (const block of blocks) consumeEvent(block);
    if (done) break;
  }
  if (buffer.trim()) consumeEvent(buffer);
  return {
    content,
    reasoningContent,
    reasoningDurationMs: reasoningContent ? (answerStartedAt || Date.now()) - startedAt : 0,
  };
}

async function chatCompletion({ settings, apiKey, messages, onDelta = null }) {
  const baseUrl = normalizeBaseUrl(settings.chatBaseUrl || settings.baseUrl);
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(baseUrl);
  if (!apiKey && !isLocal) {
    const result = {
      offline: true,
      content: "我已经把这段话记录下来了。现在还没有配置模型 API；在设置中填入接口密钥后，我就能真正和你继续聊。",
      reasoningContent: "",
      reasoningDurationMs: 0,
    };
    onDelta?.({ reasoningContentDelta: "", contentDelta: result.content });
    return result;
  }

  const payload = {
    model: settings.chatModel || "gpt-4o-mini",
    messages,
    temperature: Number(settings.temperature || 0.7),
    stream: Boolean(onDelta),
  };
  if (onDelta) {
    payload.stream_options = { include_usage: true };
    payload.enable_thinking = true;
  }
  const request = () => fetch(endpoint(baseUrl, "/chat/completions"), {
    method: "POST",
    headers: requestHeaders(apiKey),
    body: JSON.stringify(payload),
  });
  let response = await request();
  if (!response.ok && response.status === 400 && payload.enable_thinking) {
    delete payload.enable_thinking;
    response = await request();
  }
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`模型请求失败 (${response.status}): ${details.slice(0, 500)}`);
  }
  if (onDelta) {
    const streamed = await readChatStream(response, onDelta);
    if (!streamed.content) throw new Error("模型返回了空响应。");
    return { offline: false, ...streamed };
  }
  const data = await response.json();
  const message = data?.choices?.[0]?.message || {};
  const content = chatDeltaText(message.content);
  if (!content) throw new Error("模型返回了空响应。");
  return {
    offline: false,
    content,
    reasoningContent: chatDeltaText(message.reasoning_content ?? message.reasoning),
    reasoningDurationMs: 0,
  };
}

async function transcribeAudio({ settings, apiKey, bytes, mimeType }) {
  const baseUrl = normalizeBaseUrl(settings.transcriptionBaseUrl || settings.baseUrl);
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(baseUrl);
  if (!apiKey && !isLocal) throw new Error("请先在设置中配置模型 API 密钥。");

  const model = settings.transcriptionModel || "qwen3-asr-flash";
  if (/^qwen\d*-asr-/i.test(model)) {
    const audioType = mimeType || "audio/webm";
    const dataUri = `data:${audioType};base64,${Buffer.from(bytes).toString("base64")}`;
    const response = await fetch(endpoint(baseUrl, "/chat/completions"), {
      method: "POST",
      headers: requestHeaders(apiKey),
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: [{ type: "input_audio", input_audio: { data: dataUri } }],
          },
        ],
        stream: false,
      }),
    });
    if (!response.ok) {
      const details = await response.text();
      throw new Error(`语音转写失败 (${response.status}): ${details.slice(0, 500)}`);
    }
    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    const text = Array.isArray(content)
      ? content.map((item) => item?.text || item?.content || "").join("")
      : String(content || "");
    if (!text.trim()) throw new Error("语音转写服务返回了空结果。");
    return text.trim();
  }

  const extension = mimeType?.includes("ogg") ? "ogg" : mimeType?.includes("mp4") ? "m4a" : "webm";
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType || "audio/webm" }), `voice.${extension}`);
  form.append("model", model);

  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(endpoint(baseUrl, "/audio/transcriptions"), {
    method: "POST",
    headers,
    body: form,
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`语音转写失败 (${response.status}): ${details.slice(0, 500)}`);
  }
  const data = await response.json();
  return String(data.text || "").trim();
}

async function testConnection({ settings, apiKey }) {
  const baseUrl = normalizeBaseUrl(settings.chatBaseUrl || settings.baseUrl);
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(`${baseUrl}/models`, { headers });
  if (!response.ok) throw new Error(`连接失败 (${response.status})`);
  return { ok: true };
}

module.exports = { chatCompletion, endpoint, parseJsonResponse, structuredCompletion, testConnection, transcribeAudio };
