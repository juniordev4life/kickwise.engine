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
