const test = require("node:test");
const assert = require("node:assert/strict");

const { wellFormedString, wellFormedValue } = require("../electron/agent-sidecar.cjs");

test("repairs unpaired UTF-16 surrogates at the Electron-sidecar boundary", () => {
  const validEmoji = String.fromCharCode(0xD83D, 0xDC81);
  const loneHigh = String.fromCharCode(0xD83D);
  const loneLow = String.fromCharCode(0xDC81);

  assert.equal(wellFormedString(validEmoji), "💁");
  assert.equal(wellFormedString(`before${loneHigh}after`), "before�after");
  assert.equal(wellFormedString(`before${loneLow}after`), "before�after");
  assert.deepEqual(wellFormedValue({ messages: [{ content: loneLow }] }), { messages: [{ content: "�" }] });
});
