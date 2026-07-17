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
