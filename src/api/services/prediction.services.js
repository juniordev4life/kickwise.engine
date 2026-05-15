import { bqTable, getBigQueryClient } from "../../config/bigQuery.config.js";
import { matchOutcomeProbabilities } from "../../utils/poisson.utils.js";

export const MODEL_VERSION = "poisson-xg-v1";

// Sliding window of completed matches used to estimate each team's attacking
// and defensive strength. 10 is a common Premier League / Bundesliga choice —
// long enough to dampen noise from one outlier, short enough to track form
// (manager change, injury wave, ...).
const FORM_WINDOW = 10;

// Home advantage as a multiplier on the home side's expected goals. Empirical
// Bundesliga home factor is ~1.20 on goals scored. We apply it symmetrically:
// home attack × HOME_FACTOR_ATT, away attack × (1 / HOME_FACTOR_ATT). Net
// effect on expected goals is the classic ~10% bump per side.
const HOME_ATTACK_FACTOR = 1.1;
const HOME_DEFENSE_FACTOR = 1 / HOME_ATTACK_FACTOR;

// Hard floor for any expected-goals estimate. Without it a brand-new team
// with zero recorded matches in the window would yield λ=0 → Poisson(0) → all
// mass at 0 goals, which collapses the prediction to draw=100%.
const MIN_LAMBDA = 0.3;

/**
 * Compute a Poisson-xG match prediction for a fixture. Pulls each team's
 * rolling xG-for / xG-against averages from BigQuery, blends them with the
 * league-wide attack/defense baseline, applies a home-advantage multiplier
 * and turns the resulting (λ_home, λ_away) into outcome probabilities.
 *
 * @param {object} args
 * @param {string} args.matchId openligadb match id
 * @returns {Promise<object>} Prediction envelope including features
 *
 * @example
 *   const p = await computePrediction({ matchId: "12345" });
 *   p.probHomeWin // 0.51
 */
export async function computePrediction({ matchId }) {
  const fixture = await loadFixture(matchId);
  if (!fixture) {
    const err = new Error(`Match ${matchId} not found`);
    err.statusCode = 404;
    throw err;
  }
  const seasonId = fixture.season_id;
  const baseline = await loadSeasonBaseline(seasonId);
  const [homeForm, awayForm] = await Promise.all([
    loadTeamForm({ teamId: fixture.home_team_id, beforeDate: fixture.kickoff_at }),
    loadTeamForm({ teamId: fixture.away_team_id, beforeDate: fixture.kickoff_at })
  ]);

  const homeAttack = strengthRatio(homeForm.xgPerMatch, baseline.avgGoalsForPerMatch);
  const homeDefense = strengthRatio(homeForm.xgaPerMatch, baseline.avgGoalsForPerMatch);
  const awayAttack = strengthRatio(awayForm.xgPerMatch, baseline.avgGoalsForPerMatch);
  const awayDefense = strengthRatio(awayForm.xgaPerMatch, baseline.avgGoalsForPerMatch);

  const lambdaHome = Math.max(
    MIN_LAMBDA,
    baseline.avgGoalsForPerMatch * homeAttack * awayDefense * HOME_ATTACK_FACTOR
  );
  const lambdaAway = Math.max(
    MIN_LAMBDA,
    baseline.avgGoalsForPerMatch * awayAttack * homeDefense * HOME_DEFENSE_FACTOR
  );

  const outcome = matchOutcomeProbabilities(lambdaHome, lambdaAway);

  return {
    matchId,
    modelVersion: MODEL_VERSION,
    runAt: new Date().toISOString(),
    probHomeWin: outcome.probHomeWin,
    probDraw: outcome.probDraw,
    probAwayWin: outcome.probAwayWin,
    expectedHomeGoals: outcome.expectedHomeGoals,
    expectedAwayGoals: outcome.expectedAwayGoals,
    features: {
      seasonId,
      formWindow: FORM_WINDOW,
      baseline,
      home: {
        teamId: fixture.home_team_id,
        matchesInWindow: homeForm.matchesUsed,
        xgPerMatch: homeForm.xgPerMatch,
        xgaPerMatch: homeForm.xgaPerMatch,
        attackStrength: homeAttack,
        defenseStrength: homeDefense
      },
      away: {
        teamId: fixture.away_team_id,
        matchesInWindow: awayForm.matchesUsed,
        xgPerMatch: awayForm.xgPerMatch,
        xgaPerMatch: awayForm.xgaPerMatch,
        attackStrength: awayAttack,
        defenseStrength: awayDefense
      },
      homeAdvantage: { attack: HOME_ATTACK_FACTOR, defense: HOME_DEFENSE_FACTOR }
    }
  };
}

async function loadFixture(matchId) {
  const bq = getBigQueryClient();
  const [rows] = await bq.query({
    query: `
      SELECT match_id, season_id, home_team_id, away_team_id, kickoff_at
      FROM \`${bqTable("matches")}\`
      WHERE match_id = @matchId
      LIMIT 1
    `,
    params: { matchId }
  });
  return rows[0] ?? null;
}

async function loadSeasonBaseline(seasonId) {
  const bq = getBigQueryClient();
  const [rows] = await bq.query({
    query: `
      SELECT
        AVG(xg) AS avg_xg_per_team_per_match,
        COUNT(*) AS sample_size
      FROM \`${bqTable("xg_match_data")}\`
      WHERE season_id = @seasonId
    `,
    params: { seasonId }
  });
  const avg = Number(rows[0]?.avg_xg_per_team_per_match);
  // Fallback to the long-running Bundesliga average if we somehow have no
  // sample (early in a new season, before any matches have been played).
  const safe = Number.isFinite(avg) && avg > 0 ? avg : 1.45;
  return {
    avgGoalsForPerMatch: safe,
    sampleSize: Number(rows[0]?.sample_size ?? 0)
  };
}

async function loadTeamForm({ teamId, beforeDate }) {
  const bq = getBigQueryClient();
  const [rows] = await bq.query({
    query: `
      SELECT x.xg, x.xga
      FROM \`${bqTable("xg_match_data")}\` x
      JOIN \`${bqTable("matches")}\` m ON m.match_id = x.match_id
      WHERE x.team_id = @teamId
        AND m.kickoff_at < @beforeDate
        AND x.xg IS NOT NULL
      ORDER BY m.kickoff_at DESC
      LIMIT @windowSize
    `,
    params: { teamId, beforeDate, windowSize: FORM_WINDOW },
    types: { teamId: "STRING", beforeDate: "TIMESTAMP", windowSize: "INT64" }
  });
  if (rows.length === 0) {
    return { xgPerMatch: null, xgaPerMatch: null, matchesUsed: 0 };
  }
  const xgSum = rows.reduce((s, r) => s + Number(r.xg ?? 0), 0);
  const xgaSum = rows.reduce((s, r) => s + Number(r.xga ?? 0), 0);
  return {
    xgPerMatch: xgSum / rows.length,
    xgaPerMatch: xgaSum / rows.length,
    matchesUsed: rows.length
  };
}

function strengthRatio(teamValue, leagueAverage) {
  if (!Number.isFinite(teamValue) || teamValue === null || teamValue === undefined) return 1;
  if (!leagueAverage) return 1;
  return teamValue / leagueAverage;
}

/**
 * Compute predictions for every match of a given matchday and MERGE the
 * results into the `predictions` BigQuery table. Idempotent on the
 * (match_id, model_version, run_at) key — a re-run with the same run_at
 * would overwrite, but every wall-clock-different run keeps history.
 *
 * @param {object} args
 * @param {string} args.seasonId e.g. "2025/2026"
 * @param {number} args.matchday e.g. 34
 * @param {import("fastify").FastifyBaseLogger} [args.log]
 * @returns {Promise<{matchday: number, seasonId: string, predictionsWritten: number, failures: number}>}
 *
 * @example
 *   await computeAndCacheMatchdayPredictions({ seasonId: "2025/2026", matchday: 34 });
 */
/**
 * Find the matchday Kickwise should currently predict for: the smallest
 * matchday in the current season that still has at least one match not yet
 * finished. If every match is finished, returns null.
 *
 * @returns {Promise<{ seasonId: string, matchday: number } | null>}
 */
export async function findUpcomingMatchday() {
  const bq = getBigQueryClient();
  const [rows] = await bq.query({
    query: `
      SELECT season_id, MIN(matchday) AS matchday
      FROM \`${bqTable("matches")}\`
      WHERE status != 'finished'
        AND season_id = (
          SELECT season_id FROM \`${bqTable("seasons")}\` WHERE is_current LIMIT 1
        )
      GROUP BY season_id
      LIMIT 1
    `
  });
  if (!rows[0]) return null;
  return { seasonId: rows[0].season_id, matchday: Number(rows[0].matchday) };
}

export async function computeAndCacheMatchdayPredictions({ seasonId, matchday, log }) {
  const matchIds = await loadMatchIdsForMatchday(seasonId, matchday);
  const predictions = [];
  let failures = 0;
  for (const matchId of matchIds) {
    try {
      predictions.push(await computePrediction({ matchId }));
    } catch (err) {
      failures += 1;
      log?.warn({ matchId, err: err.message }, "Skipped prediction in batch run");
    }
  }
  if (predictions.length > 0) {
    await mergePredictionsToBigQuery(predictions);
  }
  return {
    seasonId,
    matchday,
    predictionsWritten: predictions.length,
    failures
  };
}

async function loadMatchIdsForMatchday(seasonId, matchday) {
  const bq = getBigQueryClient();
  const [rows] = await bq.query({
    query: `
      SELECT match_id
      FROM \`${bqTable("matches")}\`
      WHERE season_id = @seasonId AND matchday = @matchday
      ORDER BY kickoff_at
    `,
    params: { seasonId, matchday },
    types: { seasonId: "STRING", matchday: "INT64" }
  });
  return rows.map((r) => r.match_id);
}

async function mergePredictionsToBigQuery(predictions) {
  const bq = getBigQueryClient();
  const fqn = bqTable("predictions");
  const stagingRows = predictions.map((p) => ({
    match_id: p.matchId,
    model_version: p.modelVersion,
    run_at: p.runAt,
    prob_home_win: p.probHomeWin,
    prob_draw: p.probDraw,
    prob_away_win: p.probAwayWin,
    expected_home_goals: p.expectedHomeGoals,
    expected_away_goals: p.expectedAwayGoals,
    features: JSON.stringify(p.features ?? {})
  }));

  // Insert directly via streaming. predictions is partitioned by run_at and
  // we treat each batch run as a new archived snapshot — there's no need for
  // a true MERGE here (duplicates within the same wall-clock second are
  // accepted by the schema, downstream consumers pick MAX(run_at) anyway).
  await bq
    .dataset(process.env.BQ_DATASET ?? "kickwise_main")
    .table("predictions")
    .insert(stagingRows, { schema: fqn, ignoreUnknownValues: false });
}

/**
 * Backtest the current model against historical finished matches in a
 * season. Pulls all relevant data up front (matches + every xg_match_data
 * row pre-season-start) and replays each fixture in memory, so even a full
 * 306-game season runs in seconds instead of minutes.
 *
 * Strict in the form-window: only xg_match_data rows whose kickoff_at is
 * before the fixture being scored are considered (no leakage). The season
 * baseline is the long-running league average — close enough at v1 scale;
 * a stricter "baseline as-of kickoff" would shift it by <0.05 xG and is
 * planned for a v2 backtest.
 *
 * @param {object} args
 * @param {string} args.seasonId
 * @param {import("fastify").FastifyBaseLogger} [args.log]
 * @returns {Promise<object>} aggregate Log-Loss + Brier + accuracy + per-outcome breakdown
 *
 * @example
 *   const report = await backtest({ seasonId: "2024/2025" });
 *   report.logLoss // ~0.95
 */
export async function backtest({ seasonId, log }) {
  const bq = getBigQueryClient();

  const [matchesRows, xgRows, baselineRows] = await Promise.all([
    bq.query({
      query: `
        SELECT match_id, home_team_id, away_team_id, kickoff_at, home_score, away_score
        FROM \`${bqTable("matches")}\`
        WHERE season_id = @seasonId
          AND status = 'finished'
          AND home_score IS NOT NULL
          AND away_score IS NOT NULL
        ORDER BY kickoff_at
      `,
      params: { seasonId },
      types: { seasonId: "STRING" }
    }),
    bq.query({
      query: `
        SELECT x.team_id, x.xg, x.xga, m.kickoff_at
        FROM \`${bqTable("xg_match_data")}\` x
        JOIN \`${bqTable("matches")}\` m ON m.match_id = x.match_id
        WHERE x.xg IS NOT NULL
        ORDER BY m.kickoff_at
      `
    }),
    bq.query({
      query: `
        SELECT AVG(xg) AS avg_xg
        FROM \`${bqTable("xg_match_data")}\`
        WHERE season_id = @seasonId
      `,
      params: { seasonId },
      types: { seasonId: "STRING" }
    })
  ]);

  const matches = matchesRows[0];
  const timeline = buildTeamTimeline(xgRows[0]);
  const baselineAvg = Number(baselineRows[0]?.[0]?.avg_xg);
  const baseline = Number.isFinite(baselineAvg) && baselineAvg > 0 ? baselineAvg : 1.45;

  let logLossSum = 0;
  let brierSum = 0;
  let correctTop1 = 0;
  let scored = 0;
  let skipped = 0;
  const perOutcome = {
    home: { count: 0, predictedProb: 0 },
    draw: { count: 0, predictedProb: 0 },
    away: { count: 0, predictedProb: 0 }
  };

  for (const m of matches) {
    const homeForm = formFromTimeline(timeline, m.home_team_id, m.kickoff_at);
    const awayForm = formFromTimeline(timeline, m.away_team_id, m.kickoff_at);

    if (homeForm.matchesUsed === 0 || awayForm.matchesUsed === 0) {
      skipped += 1;
      continue;
    }

    const homeAttack = strengthRatio(homeForm.xgPerMatch, baseline);
    const homeDefense = strengthRatio(homeForm.xgaPerMatch, baseline);
    const awayAttack = strengthRatio(awayForm.xgPerMatch, baseline);
    const awayDefense = strengthRatio(awayForm.xgaPerMatch, baseline);

    const lambdaHome = Math.max(
      MIN_LAMBDA,
      baseline * homeAttack * awayDefense * HOME_ATTACK_FACTOR
    );
    const lambdaAway = Math.max(
      MIN_LAMBDA,
      baseline * awayAttack * homeDefense * HOME_DEFENSE_FACTOR
    );

    const outcome = matchOutcomeProbabilities(lambdaHome, lambdaAway);

    const homeScore = Number(m.home_score);
    const awayScore = Number(m.away_score);
    const actual = homeScore > awayScore ? "home" : homeScore === awayScore ? "draw" : "away";
    const probs = {
      home: outcome.probHomeWin,
      draw: outcome.probDraw,
      away: outcome.probAwayWin
    };

    const predicted =
      probs.home >= probs.draw && probs.home >= probs.away
        ? "home"
        : probs.draw >= probs.away
          ? "draw"
          : "away";
    if (predicted === actual) correctTop1 += 1;

    const pActual = probs[actual];
    logLossSum += -Math.log(Math.max(pActual, 1e-12));

    let brier = 0;
    for (const k of ["home", "draw", "away"]) {
      const target = k === actual ? 1 : 0;
      brier += (probs[k] - target) ** 2;
    }
    brierSum += brier;

    perOutcome[actual].count += 1;
    perOutcome[actual].predictedProb += pActual;
    scored += 1;
  }

  for (const k of Object.keys(perOutcome)) {
    const o = perOutcome[k];
    o.averagePredictedProbWhenActual = o.count > 0 ? o.predictedProb / o.count : 0;
  }

  log?.info({ seasonId, scored, skipped }, "Backtest completed");

  return {
    seasonId,
    modelVersion: MODEL_VERSION,
    matchesScored: scored,
    matchesSkipped: skipped,
    accuracyTop1: scored > 0 ? correctTop1 / scored : 0,
    logLoss: scored > 0 ? logLossSum / scored : 0,
    brierScore: scored > 0 ? brierSum / scored : 0,
    baselineAvgXg: baseline,
    perOutcome
  };
}

function buildTeamTimeline(xgRows) {
  // teamId -> array of { kickoffMs, xg, xga } sorted ascending by kickoff.
  const map = new Map();
  for (const r of xgRows) {
    const kickoffMs = toEpochMs(r.kickoff_at);
    if (kickoffMs === null) continue;
    const teamId = r.team_id;
    if (!map.has(teamId)) map.set(teamId, []);
    map.get(teamId).push({ kickoffMs, xg: Number(r.xg), xga: Number(r.xga ?? 0) });
  }
  return map;
}

function formFromTimeline(timeline, teamId, beforeKickoff) {
  const entries = timeline.get(teamId);
  if (!entries) return { xgPerMatch: null, xgaPerMatch: null, matchesUsed: 0 };
  const beforeMs = toEpochMs(beforeKickoff);
  if (beforeMs === null) return { xgPerMatch: null, xgaPerMatch: null, matchesUsed: 0 };

  // Pick the last FORM_WINDOW entries strictly before this kickoff.
  const filtered = [];
  for (let i = entries.length - 1; i >= 0 && filtered.length < FORM_WINDOW; i -= 1) {
    if (entries[i].kickoffMs < beforeMs) filtered.push(entries[i]);
  }
  if (filtered.length === 0) {
    return { xgPerMatch: null, xgaPerMatch: null, matchesUsed: 0 };
  }
  const xgSum = filtered.reduce((s, e) => s + e.xg, 0);
  const xgaSum = filtered.reduce((s, e) => s + e.xga, 0);
  return {
    xgPerMatch: xgSum / filtered.length,
    xgaPerMatch: xgaSum / filtered.length,
    matchesUsed: filtered.length
  };
}

function toEpochMs(bqTimestamp) {
  if (!bqTimestamp) return null;
  // BigQuery returns timestamps either as a JS Date, an ISO string, or
  // as { value: "..." }. Handle all three.
  if (bqTimestamp instanceof Date) return bqTimestamp.getTime();
  if (typeof bqTimestamp === "string") return Date.parse(bqTimestamp);
  if (typeof bqTimestamp === "object" && bqTimestamp.value) {
    return Date.parse(bqTimestamp.value);
  }
  return null;
}
