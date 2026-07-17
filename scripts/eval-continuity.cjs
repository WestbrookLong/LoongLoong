const fs = require("node:fs");
const path = require("node:path");
const { PetDatabase } = require("../electron/database.cjs");
const { evaluateProfile, persistEvaluationRun, searchProfiles } = require("../electron/continuity-eval.cjs");
const { getContinuityProfile } = require("../electron/continuity-profiles.cjs");

async function main() {
  const args = new Set(process.argv.slice(2));
  const fixtures = path.join(process.cwd(), "tests", "fixtures");
  const dataset = {
    route_cases: JSON.parse(fs.readFileSync(path.join(fixtures, "continuity-route-features.json"), "utf8")),
    value_cases: JSON.parse(fs.readFileSync(path.join(fixtures, "continuity-value-cases.json"), "utf8")),
  };
  const datasetVersion = "continuity-eval-v1";
  const report = args.has("--search")
    ? searchProfiles(dataset)
    : { baseline: { profile: getContinuityProfile(), metrics: evaluateProfile(getContinuityProfile(), dataset) } };
  if (args.has("--persist")) {
    if (!report.challenger) throw new Error("Use --search with --persist so the evaluation has a challenger report.");
    const db = await new PetDatabase(path.join(process.cwd(), ".pet-data", "pet.db")).initialize();
    report.evaluation_run_id = persistEvaluationRun(db, datasetVersion, report);
    db.close();
  }
  process.stdout.write(`${JSON.stringify({ dataset_version: datasetVersion, ...report }, null, 2)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
