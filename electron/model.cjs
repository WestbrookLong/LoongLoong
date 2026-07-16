function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");
}

function requestHeaders(apiKey) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

async function chatCompletion({ settings, apiKey, messages }) {
  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(baseUrl);
  if (!apiKey && !isLocal) {
    return {
      offline: true,
      content: "我已经把这段话记录下来了。现在还没有配置模型 API；在设置中填入接口密钥后，我就能真正和你继续聊。",
    };
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: requestHeaders(apiKey),
    body: JSON.stringify({
      model: settings.chatModel || "gpt-4o-mini",
      messages,
      temperature: Number(settings.temperature || 0.7),
    }),
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`模型请求失败 (${response.status}): ${details.slice(0, 500)}`);
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error("模型返回了空响应。");
  return { offline: false, content: String(content) };
}

async function transcribeAudio({ settings, apiKey, bytes, mimeType }) {
  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  const isLocal = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(baseUrl);
  if (!apiKey && !isLocal) throw new Error("请先在设置中配置模型 API 密钥。");

  const extension = mimeType?.includes("ogg") ? "ogg" : mimeType?.includes("mp4") ? "m4a" : "webm";
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mimeType || "audio/webm" }), `voice.${extension}`);
  form.append("model", settings.transcriptionModel || "gpt-4o-mini-transcribe");

  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(`${baseUrl}/audio/transcriptions`, {
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
  const baseUrl = normalizeBaseUrl(settings.baseUrl);
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(`${baseUrl}/models`, { headers });
  if (!response.ok) throw new Error(`连接失败 (${response.status})`);
  return { ok: true };
}

module.exports = { chatCompletion, testConnection, transcribeAudio };

