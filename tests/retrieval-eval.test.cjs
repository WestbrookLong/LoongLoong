const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const { evaluateDataset, readDataset } = require("../electron/retrieval-eval.cjs");

test("records the deterministic Phase 0 retrieval baseline", async () => {
  const dataset = readDataset(path.join(__dirname, "fixtures", "retrieval-baseline-v1.json"));
  const report = await evaluateDataset(dataset);
  assert.equal(report.dataset_version, "retrieval-baseline-v1");
  assert.equal(report.cases.length, 6);
  assert.ok(report.recall >= 0 && report.recall <= 1);
  assert.equal(report.forbidden_leak_rate, 0);
  assert.equal(report.disputed_protocol_recall, 1);
  assert.ok(report.cases.some((item) => item.missing_ids.length > 0), "baseline should preserve a semantic retrieval gap");
});
