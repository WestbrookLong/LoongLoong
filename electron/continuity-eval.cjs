const crypto = require("node:crypto");
const { isoNow } = require("./database.cjs");
const { continuityScoreDetails, decideContinuityRoute } = require("./continuity.cjs");
const { getContinuityProfile, normalizeProfile } = require("./continuity-profiles.cjs");

const SIGNAL_NAMES = [
  "future_reference",
  "unresolvedness",
  "error_prevention",
  "identity_relationship",
  "cross_session",
];

function routeCasePass(prediction, testCase) {
  return prediction.intent === testCase.expected_route
    && (testCase.expected_topic_id === undefined || prediction.targetTopicId === testCase.expected_topic_id);
}

function evaluateRouteCases(profileInput, cases) {
  const profile = getContinuityProfile(profileInput);
  const results = cases.map((testCase) => {
    const prediction = decideContinuityRoute(testCase.features, profile);
    return { id: testCase.id, pass: routeCasePass(prediction, testCase), prediction, expected_route: testCase.expected_route, expected_topic_id: testCase.expected_topic_id };
  });
  const wrongReopens = results.filter((result) => result.prediction.intent === "reopen_old_topic" && !result.pass).length;
  const duplicateNewTopics = results.filter((result) => result.prediction.intent === "new_topic" && !result.pass).length;
  const labels = [...new Set(cases.map((item) => item.expected_route))];
  const macroF1 = labels.length ? labels.reduce((sum, label) => {
    const truePositive = results.filter((result) => result.expected_route === label && result.prediction.intent === label).length;
    const falsePositive = results.filter((result) => result.expected_route !== label && result.prediction.intent === label).length;
    const falseNegative = results.filter((result) => result.expected_route === label && result.prediction.intent !== label).length;
    const precision = truePositive / Math.max(1, truePositive + falsePositive);
    const recall = truePositive / Math.max(1, truePositive + falseNegative);
    return sum + (precision + recall ? (2 * precision * recall) / (precision + recall) : 0);
  }, 0) / labels.length : 0;
  return {
    accuracy: results.length ? results.filter((result) => result.pass).length / results.length : 0,
    macro_f1: macroF1,
    false_reopen_rate: results.length ? wrongReopens / results.length : 0,
    duplicate_new_topic_rate: results.length ? duplicateNewTopics / results.length : 0,
    results,
  };
}

function evaluateValueCases(profileInput, cases) {
  const profile = getContinuityProfile(profileInput);
  const results = cases.map((testCase) => {
    if (testCase.type === "minimum") {
      const actual = continuityScoreDetails(testCase.signals, testCase.kind, profile).score;
      return { id: testCase.id, type: testCase.type, pass: actual >= testCase.expected_min, actual, expected_min: testCase.expected_min, must_keep: Boolean(testCase.must_keep) };
    }
    const higher = continuityScoreDetails(testCase.higher.signals, testCase.higher.kind || "ordinary", profile).score;
    const lower = continuityScoreDetails(testCase.lower.signals, testCase.lower.kind || "ordinary", profile).score;
    return { id: testCase.id, type: testCase.type, pass: higher > lower, higher, lower, must_keep: false };
  });
  const minimum = results.filter((result) => result.type === "minimum");
  const mustKeep = minimum.filter((result) => result.must_keep);
  const pairwise = results.filter((result) => result.type === "pairwise");
  const openLoop = minimum.filter((result) => result.id.includes("open-loop"));
  const weightedTotal = results.reduce((sum, result) => sum + Number(cases.find((item) => item.id === result.id)?.token_weight || 1), 0);
  const weightedPassed = results.filter((result) => result.pass).reduce((sum, result) => sum + Number(cases.find((item) => item.id === result.id)?.token_weight || 1), 0);
  return {
    must_keep_recall: mustKeep.length ? mustKeep.filter((result) => result.pass).length / mustKeep.length : 1,
    minimum_accuracy: minimum.length ? minimum.filter((result) => result.pass).length / minimum.length : 1,
    pairwise_accuracy: pairwise.length ? pairwise.filter((result) => result.pass).length / pairwise.length : 1,
    open_loop_recall: openLoop.length ? openLoop.filter((result) => result.pass).length / openLoop.length : 1,
    token_weighted_recall: weightedTotal ? weightedPassed / weightedTotal : 1,
    results,
  };
}

function evaluateProfile(profileInput, dataset) {
  const profile = getContinuityProfile(profileInput);
  return {
    profile_id: profile.id,
    value_version: profile.value.version,
    router_version: profile.router.version,
    route: evaluateRouteCases(profile, dataset.route_cases || []),
    value: evaluateValueCases(profile, dataset.value_cases || []),
  };
}

function profileDistance(left, right) {
  return SIGNAL_NAMES.reduce((sum, name) => sum + Math.abs(left.value.weights[name] - right.value.weights[name]), 0)
    + Math.abs(left.router.lexical_match_threshold - right.router.lexical_match_threshold);
}

function valueObjective(metrics) {
  return metrics.must_keep_recall * 1000 + metrics.pairwise_accuracy * 10 + metrics.minimum_accuracy;
}

function routerObjective(metrics) {
  return metrics.macro_f1 * 100 - metrics.false_reopen_rate * 25 - metrics.duplicate_new_topic_rate * 25;
}

function candidateWeights() {
  const candidates = [];
  const total = 20;
  for (let a = 0; a <= total; a += 1) {
    for (let b = 0; b <= total - a; b += 1) {
      for (let c = 0; c <= total - a - b; c += 1) {
        for (let d = 0; d <= total - a - b - c; d += 1) {
          const e = total - a - b - c - d;
          candidates.push(Object.fromEntries([a, b, c, d, e].map((value, index) => [SIGNAL_NAMES[index], value / total])));
        }
      }
    }
  }
  return candidates;
}

function searchProfiles(dataset, baselineInput = null) {
  const baseline = getContinuityProfile(baselineInput);
  const baselineMetrics = evaluateProfile(baseline, dataset);
  let bestValue = baseline;
  let bestValueMetrics = baselineMetrics.value;
  for (const weights of candidateWeights()) {
    const candidate = normalizeProfile({
      ...baseline,
      id: "continuity-profile-value-search",
      value: { ...baseline.value, weights },
    });
    const metrics = evaluateValueCases(candidate, dataset.value_cases || []);
    const better = valueObjective(metrics) > valueObjective(bestValueMetrics)
      || (valueObjective(metrics) === valueObjective(bestValueMetrics) && profileDistance(candidate, baseline) < profileDistance(bestValue, baseline));
    if (better) {
      bestValue = candidate;
      bestValueMetrics = metrics;
    }
  }

  let best = bestValue;
  let bestRouteMetrics = evaluateRouteCases(best, dataset.route_cases || []);
  for (let threshold = 0.16; threshold <= 0.34 + 1e-9; threshold += 0.02) {
    const candidate = normalizeProfile({
      ...bestValue,
      id: "continuity-profile-challenger",
      router: { ...bestValue.router, lexical_match_threshold: Number(threshold.toFixed(2)) },
    });
    const metrics = evaluateRouteCases(candidate, dataset.route_cases || []);
    const respectsSafety = metrics.false_reopen_rate <= baselineMetrics.route.false_reopen_rate
      && metrics.duplicate_new_topic_rate <= baselineMetrics.route.duplicate_new_topic_rate;
    const better = respectsSafety && (routerObjective(metrics) > routerObjective(bestRouteMetrics)
      || (routerObjective(metrics) === routerObjective(bestRouteMetrics) && profileDistance(candidate, baseline) < profileDistance(best, baseline)));
    if (better) {
      best = candidate;
      bestRouteMetrics = metrics;
    }
  }
  if (profileDistance(best, baseline) > 0) {
    const suffix = crypto.createHash("sha256").update(JSON.stringify({ value: best.value, router: best.router })).digest("hex").slice(0, 10);
    best = normalizeProfile({
      ...best,
      id: `continuity-profile-candidate-${suffix}`,
      value: { ...best.value, version: `continuity-value-candidate-${suffix}` },
      router: { ...best.router, version: `topic-router-candidate-${suffix}` },
    });
  }
  const challengerMetrics = evaluateProfile(best, dataset);
  const safe = challengerMetrics.value.must_keep_recall === 1
    && challengerMetrics.route.false_reopen_rate <= baselineMetrics.route.false_reopen_rate
    && challengerMetrics.route.duplicate_new_topic_rate <= baselineMetrics.route.duplicate_new_topic_rate;
  return {
    baseline: { profile: baseline, metrics: baselineMetrics },
    challenger: { profile: best, metrics: challengerMetrics },
    recommendation: {
      action: safe && profileDistance(best, baseline) > 0 ? "review_challenger" : "keep_baseline",
      safe,
      profile_distance: Number(profileDistance(best, baseline).toFixed(4)),
      note: "Offline output never changes the active production profile.",
    },
  };
}

function persistEvaluationRun(db, datasetVersion, report) {
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.db.run(
      `INSERT INTO continuity_eval_runs
     (id, dataset_version, baseline_profile_id, candidate_profile_ids_json,
      metrics_json, recommendation_json, details_json, created_at)
     VALUES ($id, $dataset, $baseline, $candidates, $metrics, $recommendation, $details, $createdAt)`,
      {
      $id: id,
      $dataset: datasetVersion,
      $baseline: report.baseline.profile.id,
      $candidates: JSON.stringify([report.challenger.profile.id]),
      $metrics: JSON.stringify({ baseline: report.baseline.metrics, challenger: report.challenger.metrics }),
      $recommendation: JSON.stringify(report.recommendation),
      $details: JSON.stringify({ challenger_profile: report.challenger.profile }),
      $createdAt: isoNow(),
      },
    );
    if (report.recommendation.action === "review_challenger") {
      db.db.run(
        `INSERT OR REPLACE INTO continuity_profiles
         (id, profile_json, status, source_eval_run_id, created_at)
         VALUES ($id, $profile, 'candidate', $runId, $createdAt)`,
        {
          $id: report.challenger.profile.id,
          $profile: JSON.stringify(report.challenger.profile),
          $runId: id,
          $createdAt: isoNow(),
        },
      );
    }
  });
  return id;
}

function recordContinuityFeedback(db, feedback) {
  const id = crypto.randomUUID();
  db.run(
    `INSERT INTO continuity_feedback
     (id, retrieval_log_id, expected_topic_id, expected_route, feedback_type,
      source, strength, notes, created_at)
     VALUES ($id, $retrievalId, $topicId, $route, $type, $source, $strength, $notes, $createdAt)`,
    {
      $id: id,
      $retrievalId: feedback.retrievalLogId || null,
      $topicId: feedback.expectedTopicId || null,
      $route: feedback.expectedRoute || null,
      $type: String(feedback.feedbackType || "observation"),
      $source: String(feedback.source || "derived"),
      $strength: feedback.strength === "strong" ? "strong" : "weak",
      $notes: String(feedback.notes || "").slice(0, 1200) || null,
      $createdAt: isoNow(),
    },
  );
  return id;
}

module.exports = {
  evaluateProfile,
  evaluateRouteCases,
  evaluateValueCases,
  persistEvaluationRun,
  recordContinuityFeedback,
  searchProfiles,
};
