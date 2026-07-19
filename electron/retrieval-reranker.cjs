const { structuredCompletion } = require("./model.cjs");

function shouldRerank(analysis, fused, mode) {
  if (mode === "voice") return false;
  if (mode === "deep" || analysis.temporalIntent || analysis.explanationIntent) return true;
  const top = fused.slice(0, 12);
  if (top.some((item) => item.objectType === "claim" && item.row.status === "disputed")) return true;
  if (top.some((item) => item.channels.semantic && !item.channels.lexical)) return true;
  return top.length >= 12 && Math.abs(Number(top[0]?.fusionScore || 0) - Number(top[7]?.fusionScore || 0)) < 0.006;
}

function candidatePayload(item) {
  return {
    id: item.key,
    type: item.objectType,
    text: item.text.slice(0, 800),
    status: item.row.status || null,
    temporal_state: item.row.temporal_state || null,
    epistemic_basis: item.row.epistemic_basis || null,
    fusion_score: Number(item.fusionScore.toFixed(6)),
    channels: item.channels,
  };
}

function validateDecisions(data, allowedIds) {
  const decisions = [];
  const seen = new Set();
  for (const item of Array.isArray(data?.decisions) ? data.decisions : []) {
    const id = String(item?.id || "");
    const decision = String(item?.decision || "");
    const usage = String(item?.usage || "");
    if (!allowedIds.has(id) || seen.has(id)) continue;
    if (!["include", "exclude", "uncertain"].includes(decision)) continue;
    if (!["answer", "context", "historical", "conflict"].includes(usage)) continue;
    const relevance = Math.max(0, Math.min(1, Number(item.relevance || 0)));
    decisions.push({ id, decision, usage, relevance });
    seen.add(id);
  }
  if (!decisions.length) throw new Error("Reranker returned no valid candidate decisions.");
  return decisions;
}

async function rerankCandidates({ settings, apiKey, query, analysis, fused, complete = structuredCompletion }) {
  const maxCandidates = 20;
  const input = fused.slice(0, maxCandidates);
  const allowedIds = new Set(input.map((item) => item.key));
  const controller = new AbortController();
  const timeoutMs = Math.max(500, Math.min(15_000, Number(settings.rerankerTimeoutMs || 5000)));
  const timer = setTimeout(() => controller.abort(new Error("Reranker timed out.")), timeoutMs);
  try {
    const response = await complete({
      settings,
      apiKey,
      model: settings.rerankerModel || settings.memoryModel || settings.chatModel,
      temperature: 0,
      signal: controller.signal,
      messages: [
        { role: "system", content: [
          "Rank only the supplied memory candidates for the user's current query.",
          "Return JSON: {decisions:[{id,decision,relevance,usage}]}",
          "decision must be include, exclude, or uncertain. usage must be answer, context, historical, or conflict.",
          "Never invent IDs. Historical memory cannot answer a current-state question. Disputed memory must use conflict or uncertain semantics.",
        ].join("\n") },
        { role: "user", content: JSON.stringify({ query, analysis, candidates: input.map(candidatePayload) }) },
      ],
    });
    const decisions = validateDecisions(response.data, allowedIds);
    const byId = new Map(decisions.map((item) => [item.id, item]));
    const reranked = fused.map((item) => {
      const decision = byId.get(item.key);
      if (!decision) return { ...item, rerank: null };
      const policyPenalty = decision.decision === "exclude" ? -0.04 : decision.decision === "uncertain" ? -0.005 : 0;
      return { ...item, fusionScore: item.fusionScore + 0.04 * decision.relevance + policyPenalty, rerank: decision };
    }).filter((item) => item.rerank?.decision !== "exclude").sort((left, right) => right.fusionScore - left.fusionScore);
    return { applied: true, reranked, decisions, usage: response.usage || {}, raw: response.raw || "" };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { candidatePayload, rerankCandidates, shouldRerank, validateDecisions };
