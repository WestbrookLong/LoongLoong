const assert = require("node:assert/strict");
const test = require("node:test");
const { chatCompletion, transcribeAudio } = require("../electron/model.cjs");

test("uses the dedicated chat base URL", async (t) => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => { global.fetch = originalFetch; });

  await chatCompletion({
    settings: {
      chatBaseUrl: "https://text.example/v1/",
      transcriptionBaseUrl: "https://voice.example/v1",
      chatModel: "test-chat",
    },
    apiKey: "secret",
    messages: [{ role: "user", content: "hello" }],
  });

  assert.equal(request.url, "https://text.example/v1/chat/completions");
});

test("streams reasoning separately from the final answer", async (t) => {
  const originalFetch = global.fetch;
  let requestBody;
  global.fetch = async (_url, options) => {
    requestBody = JSON.parse(options.body);
    return new Response([
    'data: {"choices":[{"delta":{"reasoning_content":"先分析"}}]}',
    "",
    'data: {"choices":[{"delta":{"reasoning_content":"问题。"}}]}',
    "",
    'data: {"choices":[{"delta":{"content":"最终"}}]}',
    "",
    'data: {"choices":[{"delta":{"content":"回答"}}]}',
    "",
    "data: [DONE]",
    "",
    ].join("\n"), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
  t.after(() => { global.fetch = originalFetch; });

  const deltas = [];
  const result = await chatCompletion({
    settings: { chatBaseUrl: "https://text.example/v1", chatModel: "qwen-test" },
    apiKey: "secret",
    messages: [{ role: "user", content: "hello" }],
    onDelta: (delta) => deltas.push(delta),
  });

  assert.equal(result.reasoningContent, "先分析问题。");
  assert.equal(result.content, "最终回答");
  assert.equal(requestBody.stream, true);
  assert.equal(requestBody.enable_thinking, true);
  assert.equal(deltas.map((item) => item.reasoningContentDelta).join(""), "先分析问题。");
  assert.equal(deltas.map((item) => item.contentDelta).join(""), "最终回答");
});

test("sends Qwen ASR audio through chat completions", async (t) => {
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ choices: [{ message: { content: "你好" } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  t.after(() => { global.fetch = originalFetch; });

  const result = await transcribeAudio({
    settings: {
      chatBaseUrl: "https://text.example/v1",
      transcriptionBaseUrl: "https://voice.example/v1/",
      transcriptionModel: "qwen3-asr-flash",
    },
    apiKey: "secret",
    bytes: Buffer.from("audio"),
    mimeType: "audio/webm",
  });

  const body = JSON.parse(request.options.body);
  assert.equal(request.url, "https://voice.example/v1/chat/completions");
  assert.equal(body.model, "qwen3-asr-flash");
  assert.equal(body.messages[0].content[0].type, "input_audio");
  assert.match(body.messages[0].content[0].input_audio.data, /^data:audio\/webm;base64,/);
  assert.equal(result, "你好");
});
