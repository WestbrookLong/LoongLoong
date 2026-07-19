const path = require("node:path");
const { evaluateDataset, readDataset } = require("../electron/retrieval-eval.cjs");

async function main() {
  const fixturePath = path.join(process.cwd(), "tests", "fixtures", "retrieval-baseline-v1.json");
  const report = await evaluateDataset(readDataset(fixturePath));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
