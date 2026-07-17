const DEFAULT_PROFILE_ID = "continuity-profile-v1";

const profiles = {
  [DEFAULT_PROFILE_ID]: {
    id: DEFAULT_PROFILE_ID,
    value: {
      version: "continuity-value-v1",
      weights: {
        future_reference: 0.3,
        unresolvedness: 0.25,
        error_prevention: 0.2,
        identity_relationship: 0.15,
        cross_session: 0.1,
      },
      floors: {
        commitment: 0.9,
        correction: 0.9,
        boundary: 0.9,
        open_loop: 0.8,
        ordinary: 0,
      },
    },
    router: {
      version: "topic-router-v1",
      lexical_match_threshold: 0.22,
      route_commit_threshold: 0.45,
      alias_confidence: 0.96,
      anaphora_confidence: 0.55,
      new_topic_confidence: 0.5,
    },
  },
};

function normalizeProfile(profile) {
  if (!profile) return profiles[DEFAULT_PROFILE_ID];
  const baseline = profiles[DEFAULT_PROFILE_ID];
  return {
    id: String(profile.id || "candidate-profile"),
    value: {
      ...baseline.value,
      ...(profile.value || {}),
      weights: { ...baseline.value.weights, ...(profile.value?.weights || {}) },
      floors: { ...baseline.value.floors, ...(profile.value?.floors || {}) },
    },
    router: { ...baseline.router, ...(profile.router || {}) },
  };
}

function getContinuityProfile(profileOrId) {
  if (profileOrId && typeof profileOrId === "object") return normalizeProfile(profileOrId);
  return profiles[String(profileOrId || DEFAULT_PROFILE_ID)] || profiles[DEFAULT_PROFILE_ID];
}

function profileState(db) {
  const state = db?.get?.("SELECT * FROM continuity_profile_state WHERE id = 'primary'");
  const fromDatabase = (id) => {
    if (!id) return null;
    const row = db?.get?.("SELECT profile_json FROM continuity_profiles WHERE id = $id", { $id: id });
    if (!row) return null;
    try {
      return normalizeProfile(JSON.parse(row.profile_json));
    } catch {
      return null;
    }
  };
  return {
    active: fromDatabase(state?.active_profile_id) || getContinuityProfile(state?.active_profile_id),
    challenger: fromDatabase(state?.challenger_profile_id),
  };
}

function stageContinuityProfile(db, profileId) {
  const row = db.get("SELECT * FROM continuity_profiles WHERE id = $id", { $id: String(profileId || "") });
  if (!row || !["candidate", "approved"].includes(row.status)) return { applied: false, reason: "profile_not_stageable" };
  const evaluation = row.source_eval_run_id
    ? db.get("SELECT recommendation_json FROM continuity_eval_runs WHERE id = $id", { $id: row.source_eval_run_id })
    : null;
  let recommendation = {};
  try { recommendation = JSON.parse(evaluation?.recommendation_json || "{}"); } catch {}
  if (!recommendation.safe) return { applied: false, reason: "safe_evaluation_required" };
  db.run(
    "UPDATE continuity_profile_state SET challenger_profile_id = $profileId, updated_at = $now WHERE id = 'primary'",
    { $profileId: row.id, $now: new Date().toISOString() },
  );
  return { applied: true, profileId: row.id, mode: "shadow" };
}

function promoteContinuityProfile(db, profileId) {
  const state = db.get("SELECT * FROM continuity_profile_state WHERE id = 'primary'");
  const row = db.get("SELECT * FROM continuity_profiles WHERE id = $id", { $id: String(profileId || "") });
  if (!row || state?.challenger_profile_id !== row.id) return { applied: false, reason: "profile_must_be_shadowed_first" };
  const now = new Date().toISOString();
  db.transaction(() => {
    db.db.run("UPDATE continuity_profiles SET status = 'approved', approved_at = COALESCE(approved_at, $now), activated_at = $now WHERE id = $id", { $id: row.id, $now: now });
    db.db.run(
      `UPDATE continuity_profile_state SET active_profile_id = $profileId,
       challenger_profile_id = NULL, updated_at = $now WHERE id = 'primary'`,
      { $profileId: row.id, $now: now },
    );
  });
  return { applied: true, profileId: row.id, mode: "active" };
}

module.exports = {
  DEFAULT_PROFILE_ID,
  getContinuityProfile,
  normalizeProfile,
  profileState,
  promoteContinuityProfile,
  profiles,
  stageContinuityProfile,
};
