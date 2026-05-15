import { bqTable, getBigQueryClient } from "../../config/bigQuery.config.js";
import { matchOutcomeProbabilities } from "../../utils/poisson.utils.js";

export const MODEL_VERSION = "poisson-xg-v2";

// All tunable knobs in one place. Backtest can override them so we can
// sweep different settings without re-deploying. Defaults reflect what
// looked sensible after the v1 backtest on 2024/2025: draws underestimated,
// home advantage roughly on target, finishing-luck noticeable enough to
// blend xG with actual goals.
export const DEFAULT_PARAMS = Object.freeze({
  // Sliding window of recent matches per team.
  formWindow: 10,

  // exp(-decayRate * gamesAgo) weighting inside the form window. 0 reproduces
  // the v1 equal-weights mean; 0.15 gives the most recent match ~2.5× the
  // weight of the oldest of 10.
  decayRate: 0.15,

  // Dixon-Coles draw boost. Positive values push probability into the
  // (0,0), (1,0), (0,1), (1,1) cells. 0.10 is a moderate top-flight value.
  rho: 0.1,

  // Convex blend xG-strength : actual-goals-strength. 0.7 = 70% xG signal
  // (chance quality) + 30% actual goals (finishing efficiency / luck).
  xgGoalsBlend: 0.7,

  // Empirical home factor on goals scored. Applied as ×factor to home λ
  // and /factor to away λ.
  homeAttackFactor: 1.1,

  // Hard floor to avoid λ=0 collapsing the prediction to draw=100%.
  minLambda: 0.3
});

/**
 * Compute a Poisson-xG match prediction for a fixture. v2 model:
 *   - blends xG-based and actual-goals-based strength ratios
 *   - applies exponential form-decay so recent results matter more
 *   - applies the Dixon-Coles correction to boost draws
 *
 * @param {object} args
 * @param {string} args.matchId openligadb match id
 * @param {object} [args.paramOverrides] override any of DEFAULT_PARAMS
 * @returns {Promise<object>} Prediction envelope including features
 *
 * @example
 *   const p = await computePrediction({ matchId: "12345" });
 *   p.probDraw // ~0.25 (v2 reports more draws than v1)
 */
export async function computePrediction({ matchId, paramOverrides }) {
  const params = { ...DEFAULT_PARAMS, ...(paramOverrides ?? {}) };
  const fixture = await loadFixture(matchId);
  if (!fixture) {
    const err = new Error(`Match ${matchId} not found`);
    err.statusCode = 404;
    throw err;
  }
  const seasonId = fixture.season_id;
  const baseline = await loadSeasonBaseline(seasonId);
  const [homeForm, awayForm] = await Promise.all([
    loadTeamForm({
      teamId: fixture.home_team_id,
      beforeDate: fixture.kickoff_at,
      windowSize: params.formWindow,
      decayRate: params.decayRate
    }),
    loadTeamForm({
      teamId: fixture.away_team_id,
      beforeDate: fixture.kickoff_at,
      windowSize: params.formWindow,
      decayRate: params.decayRate
    })
  ]);

  const homeStrengths = computeBlendedStrengths(homeForm, baseline, params.xgGoalsBlend);
  const awayStrengths = computeBlendedStrengths(awayForm, baseline, params.xgGoalsBlend);

  const homeDefenseFactor = 1 / params.homeAttackFactor;
  const lambdaHome = Math.max(
    params.minLambda,
    baseline.avgGoalsForPerMatch *
      homeStrengths.attack *
      awayStrengths.defense *
      params.homeAttackFactor
  );
  const lambdaAway = Math.max(
    params.minLambda,
    baseline.avgGoalsForPerMatch * awayStrengths.attack * homeStrengths.defense * homeDefenseFactor
  );

  const outcome = matchOutcomeProbabilities(lambdaHome, lambdaAway, { rho: params.rho });

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
      params,
      baseline,
      home: {
        teamId: fixture.home_team_id,
        matchesInWindow: homeForm.matchesUsed,
        xgPerMatch: homeForm.xgPerMatch,
        xgaPerMatch: homeForm.xgaPerMatch,
        goalsForPerMatch: homeForm.goalsForPerMatch,
        goalsAgainstPerMatch: homeForm.goalsAgainstPerMatch,
        attackStrength: homeStrengths.attack,
        defenseStrength: homeStrengths.defense
      },
      away: {
        teamId: fixture.away_team_id,
        matchesInWindow: awayForm.matchesUsed,
        xgPerMatch: awayForm.xgPerMatch,
        xgaPerMatch: awayForm.xgaPerMatch,
        goalsForPerMatch: awayForm.goalsForPerMatch,
        goalsAgainstPerMatch: awayForm.goalsAgainstPerMatch,
        attackStrength: awayStrengths.attack,
        defenseStrength: awayStrengths.defense
      }
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
        (SELECT AVG(xg) FROM \`${bqTable("xg_match_data")}\` WHERE season_id = @seasonId) AS avg_xg,
        (
          SELECT AVG(score) FROM (
            SELECT home_score AS score FROM \`${bqTable("matches")}\`
              WHERE season_id = @seasonId AND status = 'finished' AND home_score IS NOT NULL
            UNION ALL
            SELECT away_score AS score FROM \`${bqTable("matches")}\`
              WHERE season_id = @seasonId AND status = 'finished' AND away_score IS NOT NULL
          )
        ) AS avg_goals
    `,
    params: { seasonId }
  });
  const avgXg = Number(rows[0]?.avg_xg);
  const avgGoals = Number(rows[0]?.avg_goals);
  // Long-running Bundesliga averages as a safe fallback (early season,
  // historic backtests of partially-loaded seasons, ...).
  const safeXg = Number.isFinite(avgXg) && avgXg > 0 ? avgXg : 1.45;
  const safeGoals = Number.isFinite(avgGoals) && avgGoals > 0 ? avgGoals : 1.5;
  return {
    avgGoalsForPerMatch: safeXg,
    avgXgPerMatch: safeXg,
    avgActualGoalsPerMatch: safeGoals
  };
}

async function loadTeamForm({ teamId, beforeDate, windowSize, decayRate }) {
  const bq = getBigQueryClient();
  const [rows] = await bq.query({
    query: `
      SELECT
        x.xg, x.xga,
        CASE WHEN x.is_home THEN m.home_score ELSE m.away_score END AS goals_for,
        CASE WHEN x.is_home THEN m.away_score ELSE m.home_score END AS goals_against
      FROM \`${bqTable("xg_match_data")}\` x
      JOIN \`${bqTable("matches")}\` m ON m.match_id = x.match_id
      WHERE x.team_id = @teamId
        AND m.kickoff_at < @beforeDate
        AND x.xg IS NOT NULL
        AND m.home_score IS NOT NULL
        AND m.away_score IS NOT NULL
      ORDER BY m.kickoff_at DESC
      LIMIT @windowSize
    `,
    params: { teamId, beforeDate, windowSize },
    types: { teamId: "STRING", beforeDate: "TIMESTAMP", windowSize: "INT64" }
  });
  return aggregateForm(rows, decayRate);
}

function aggregateForm(rows, decayRate) {
  if (rows.length === 0) {
    return {
      xgPerMatch: null,
      xgaPerMatch: null,
      goalsForPerMatch: null,
      goalsAgainstPerMatch: null,
      matchesUsed: 0
    };
  }
  let weightSum = 0;
  let xgWeighted = 0;
  let xgaWeighted = 0;
  let goalsForWeighted = 0;
  let goalsAgainstWeighted = 0;
  rows.forEach((r, idx) => {
    // idx 0 = most recent (rows are sorted DESC by kickoff)
    const w = decayRate > 0 ? Math.exp(-decayRate * idx) : 1;
    weightSum += w;
    xgWeighted += w * Number(r.xg ?? 0);
    xgaWeighted += w * Number(r.xga ?? 0);
    goalsForWeighted += w * Number(r.goals_for ?? 0);
    goalsAgainstWeighted += w * Number(r.goals_against ?? 0);
  });
  return {
    xgPerMatch: xgWeighted / weightSum,
    xgaPerMatch: xgaWeighted / weightSum,
    goalsForPerMatch: goalsForWeighted / weightSum,
    goalsAgainstPerMatch: goalsAgainstWeighted / weightSum,
    matchesUsed: rows.length
  };
}

function computeBlendedStrengths(form, baseline, xgWeight) {
  const xgAttack = strengthRatio(form.xgPerMatch, baseline.avgXgPerMatch);
  const xgDefense = strengthRatio(form.xgaPerMatch, baseline.avgXgPerMatch);
  const goalAttack = strengthRatio(form.goalsForPerMatch, baseline.avgActualGoalsPerMatch);
  const goalDefense = strengthRatio(form.goalsAgainstPerMatch, baseline.avgActualGoalsPerMatch);
  const w = clamp01(xgWeight);
  return {
    attack: w * xgAttack + (1 - w) * goalAttack,
    defense: w * xgDefense + (1 - w) * goalDefense
  };
}

function strengthRatio(teamValue, leagueAverage) {
  if (!Number.isFinite(teamValue) || teamValue === null || teamValue === undefined) return 1;
  if (!leagueAverage) return 1;
  return teamValue / leagueAverage;
}

function clamp01(v) {
  if (!Number.isFinite(v)) return 0.5;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

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

/**
 * Compute predictions for every match of a given matchday and append the
 * results to the `predictions` BigQuery table. Each run gets a new run_at
 * so previous snapshots stay in the archive for backtesting.
 */
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
    await insertPredictionsToBigQuery(predictions);
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

async function insertPredictionsToBigQuery(predictions) {
  const bq = getBigQueryClient();
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
  await bq
    .dataset(process.env.BQ_DATASET ?? "kickwise_main")
    .table("predictions")
    .insert(stagingRows, { ignoreUnknownValues: false });
}

/**
 * Backtest a model variant against historical finished matches in a season.
 * Loads matches + every xG row up front and replays each fixture in memory
 * (no per-match BigQuery roundtrips), so a 306-game season finishes in a
 * few seconds.
 *
 * @param {object} args
 * @param {string} args.seasonId
 * @param {object} [args.paramOverrides] override any of DEFAULT_PARAMS
 * @param {import("fastify").FastifyBaseLogger} [args.log]
 * @returns {Promise<object>} aggregate Log-Loss + Brier + accuracy
 *
 * @example
 *   await backtest({ seasonId: "2024/2025", paramOverrides: { rho: 0.05 } });
 */
export async function backtest({ seasonId, paramOverrides, log }) {
  const params = { ...DEFAULT_PARAMS, ...(paramOverrides ?? {}) };
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
        SELECT
          x.team_id, x.xg, x.xga, x.is_home, m.kickoff_at, m.home_score, m.away_score
        FROM \`${bqTable("xg_match_data")}\` x
        JOIN \`${bqTable("matches")}\` m ON m.match_id = x.match_id
        WHERE x.xg IS NOT NULL AND m.home_score IS NOT NULL
        ORDER BY m.kickoff_at
      `
    }),
    bq.query({
      query: `
        SELECT
          (SELECT AVG(xg) FROM \`${bqTable("xg_match_data")}\` WHERE season_id = @seasonId) AS avg_xg,
          (
            SELECT AVG(score) FROM (
              SELECT home_score AS score FROM \`${bqTable("matches")}\`
                WHERE season_id = @seasonId AND status = 'finished' AND home_score IS NOT NULL
              UNION ALL
              SELECT away_score AS score FROM \`${bqTable("matches")}\`
                WHERE season_id = @seasonId AND status = 'finished' AND away_score IS NOT NULL
            )
          ) AS avg_goals
      `,
      params: { seasonId },
      types: { seasonId: "STRING" }
    })
  ]);

  const matches = matchesRows[0];
  const timeline = buildTeamTimeline(xgRows[0]);
  const avgXg = Number(baselineRows[0]?.[0]?.avg_xg);
  const avgGoals = Number(baselineRows[0]?.[0]?.avg_goals);
  const baseline = {
    avgGoalsForPerMatch: Number.isFinite(avgXg) && avgXg > 0 ? avgXg : 1.45,
    avgXgPerMatch: Number.isFinite(avgXg) && avgXg > 0 ? avgXg : 1.45,
    avgActualGoalsPerMatch: Number.isFinite(avgGoals) && avgGoals > 0 ? avgGoals : 1.5
  };

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

  const homeDefenseFactor = 1 / params.homeAttackFactor;

  for (const m of matches) {
    const homeForm = formFromTimeline(timeline, m.home_team_id, m.kickoff_at, params);
    const awayForm = formFromTimeline(timeline, m.away_team_id, m.kickoff_at, params);

    if (homeForm.matchesUsed === 0 || awayForm.matchesUsed === 0) {
      skipped += 1;
      continue;
    }

    const homeS = computeBlendedStrengths(homeForm, baseline, params.xgGoalsBlend);
    const awayS = computeBlendedStrengths(awayForm, baseline, params.xgGoalsBlend);

    const lambdaHome = Math.max(
      params.minLambda,
      baseline.avgGoalsForPerMatch * homeS.attack * awayS.defense * params.homeAttackFactor
    );
    const lambdaAway = Math.max(
      params.minLambda,
      baseline.avgGoalsForPerMatch * awayS.attack * homeS.defense * homeDefenseFactor
    );

    const outcome = matchOutcomeProbabilities(lambdaHome, lambdaAway, { rho: params.rho });

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

  log?.info({ seasonId, scored, skipped, params }, "Backtest completed");

  return {
    seasonId,
    modelVersion: MODEL_VERSION,
    params,
    matchesScored: scored,
    matchesSkipped: skipped,
    accuracyTop1: scored > 0 ? correctTop1 / scored : 0,
    logLoss: scored > 0 ? logLossSum / scored : 0,
    brierScore: scored > 0 ? brierSum / scored : 0,
    baseline,
    perOutcome
  };
}

function buildTeamTimeline(xgRows) {
  // teamId -> [{ kickoffMs, xg, xga, goalsFor, goalsAgainst }, ...] sorted ASC
  const map = new Map();
  for (const r of xgRows) {
    const kickoffMs = toEpochMs(r.kickoff_at);
    if (kickoffMs === null) continue;
    const teamId = r.team_id;
    const isHome = !!r.is_home;
    const goalsFor = isHome ? Number(r.home_score) : Number(r.away_score);
    const goalsAgainst = isHome ? Number(r.away_score) : Number(r.home_score);
    if (!map.has(teamId)) map.set(teamId, []);
    map.get(teamId).push({
      kickoffMs,
      xg: Number(r.xg),
      xga: Number(r.xga ?? 0),
      goalsFor,
      goalsAgainst
    });
  }
  return map;
}

function formFromTimeline(timeline, teamId, beforeKickoff, params) {
  const entries = timeline.get(teamId);
  const empty = {
    xgPerMatch: null,
    xgaPerMatch: null,
    goalsForPerMatch: null,
    goalsAgainstPerMatch: null,
    matchesUsed: 0
  };
  if (!entries) return empty;
  const beforeMs = toEpochMs(beforeKickoff);
  if (beforeMs === null) return empty;

  // Walk back through history; collect up to formWindow entries strictly
  // before this kickoff. Most-recent first so index 0 carries the highest
  // decay weight.
  const filtered = [];
  for (let i = entries.length - 1; i >= 0 && filtered.length < params.formWindow; i -= 1) {
    if (entries[i].kickoffMs < beforeMs) filtered.push(entries[i]);
  }
  if (filtered.length === 0) return empty;

  let weightSum = 0;
  let xgWeighted = 0;
  let xgaWeighted = 0;
  let goalsForWeighted = 0;
  let goalsAgainstWeighted = 0;
  filtered.forEach((e, idx) => {
    const w = params.decayRate > 0 ? Math.exp(-params.decayRate * idx) : 1;
    weightSum += w;
    xgWeighted += w * e.xg;
    xgaWeighted += w * e.xga;
    goalsForWeighted += w * e.goalsFor;
    goalsAgainstWeighted += w * e.goalsAgainst;
  });
  return {
    xgPerMatch: xgWeighted / weightSum,
    xgaPerMatch: xgaWeighted / weightSum,
    goalsForPerMatch: goalsForWeighted / weightSum,
    goalsAgainstPerMatch: goalsAgainstWeighted / weightSum,
    matchesUsed: filtered.length
  };
}

function toEpochMs(bqTimestamp) {
  if (!bqTimestamp) return null;
  if (bqTimestamp instanceof Date) return bqTimestamp.getTime();
  if (typeof bqTimestamp === "string") return Date.parse(bqTimestamp);
  if (typeof bqTimestamp === "object" && bqTimestamp.value) {
    return Date.parse(bqTimestamp.value);
  }
  return null;
}
