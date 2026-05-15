import { bqTable, getBigQueryClient } from "../../config/bigQuery.config.js";
import { matchOutcomeProbabilities, poissonPmf } from "../../utils/poisson.utils.js";
import { computePrediction, DEFAULT_PARAMS } from "./prediction.services.js";

export const PROJECTION_MODEL_VERSION = "kickbase-points-v1";

// Position weights map how much of a player's points come from each of the
// match-context signals (clean sheet, team winning, team scoring volume).
// They sum to 1 within a position so the "situational multiplier" stays
// dimensionless. Calibrated against the rough Bundesliga heuristic that
// defensive Kickbase points lean ~half on clean sheets, attackers lean
// heavily on team scoring + winning.
const POSITION_WEIGHTS = {
  GK: { cleanSheet: 0.6, win: 0.4, attack: 0 },
  DEF: { cleanSheet: 0.5, win: 0.5, attack: 0 },
  MID: { cleanSheet: 0.3, win: 0.5, attack: 0.2 },
  FWD: { cleanSheet: 0, win: 0.7, attack: 0.3 }
};

// The "situational multiplier" maps situational_factor ∈ [0, 1] into the
// observed Kickbase point variance range. Empirically a player on a great
// matchday (clean sheet + win + scoring) puts up ~+50% over their average;
// in a 0-3 loss they sit ~-30%. Centering at 1.0 when factor=0.5 keeps the
// projection unbiased on a 50/50 fixture.
const MULTIPLIER_MIN = 0.7;
const MULTIPLIER_RANGE = 0.6;

// Attack normalization: a team expected to score 2.5 goals = "max attack
// situational signal". Anything beyond is clipped (otherwise a 3-goal
// expectation game would silently dominate).
const ATTACK_REFERENCE_GOALS = 2.5;

// Default starting probability if the Kickbase API didn't provide one.
// 0.65 is roughly the squad-share rate of a starting player given Kickbase
// shows ~15 rotation candidates per club.
const DEFAULT_STARTING_PROB = 0.65;

/**
 * Project Kickbase points for each player at a given match, using the
 * pre-computed (or just-computed) match prediction.
 *
 * @param {object} args
 * @param {string} args.matchId
 * @param {Array<object>} args.players Each player must carry `position`,
 *   `teamId`, `averagePoints`, optionally `startingProbability`.
 * @returns {Promise<{
 *   matchId: string,
 *   modelVersion: string,
 *   prediction: object,
 *   projections: Array<object>
 * }>}
 */
export async function projectPlayersForMatch({ matchId, players }) {
  const prediction = await loadOrComputePrediction(matchId);
  const fixture = await loadFixture(matchId);
  if (!fixture) {
    const err = new Error(`Match ${matchId} not found`);
    err.statusCode = 404;
    throw err;
  }
  const homeTeamId = String(fixture.home_team_id);
  const awayTeamId = String(fixture.away_team_id);

  const projections = (players ?? []).map((player) => {
    const teamId = String(player.teamId ?? "");
    const isHome = teamId === homeTeamId;
    const isAway = teamId === awayTeamId;
    if (!isHome && !isAway) {
      return {
        playerId: player.playerId ?? null,
        teamId,
        expectedPoints: 0,
        reason: "player team is not part of this match"
      };
    }
    return scoreOne(player, prediction, isHome);
  });

  return {
    matchId,
    modelVersion: PROJECTION_MODEL_VERSION,
    prediction: {
      probHomeWin: prediction.probHomeWin,
      probDraw: prediction.probDraw,
      probAwayWin: prediction.probAwayWin,
      expectedHomeGoals: prediction.expectedHomeGoals,
      expectedAwayGoals: prediction.expectedAwayGoals,
      matchPredictionModelVersion: prediction.modelVersion
    },
    matchup: { homeTeamId, awayTeamId },
    projections
  };
}

function scoreOne(player, prediction, isHome) {
  const teamWinProb = isHome ? prediction.probHomeWin : prediction.probAwayWin;
  const teamExpectedGoals = isHome ? prediction.expectedHomeGoals : prediction.expectedAwayGoals;
  const opponentExpectedGoals = isHome
    ? prediction.expectedAwayGoals
    : prediction.expectedHomeGoals;
  // Probability the opponent scores 0 — the headline clean-sheet number
  // for the defending team (GK and DEF Kickbase bonus).
  const cleanSheetProb = poissonPmf(0, opponentExpectedGoals);
  const attackFactor = Math.min(1, teamExpectedGoals / ATTACK_REFERENCE_GOALS);

  const weights = POSITION_WEIGHTS[player.position] ?? POSITION_WEIGHTS.MID;
  const situational =
    weights.cleanSheet * cleanSheetProb + weights.win * teamWinProb + weights.attack * attackFactor;

  const multiplier = MULTIPLIER_MIN + MULTIPLIER_RANGE * situational;
  const baseAvg = Number(player.averagePoints);
  const startingProb =
    player.startingProbability !== null && player.startingProbability !== undefined
      ? Number(player.startingProbability)
      : DEFAULT_STARTING_PROB;

  const safeBase = Number.isFinite(baseAvg) ? baseAvg : 0;
  const safeStart = Number.isFinite(startingProb) ? Math.min(1, Math.max(0, startingProb)) : 0;

  return {
    playerId: player.playerId ?? null,
    teamId: String(player.teamId ?? ""),
    position: player.position ?? null,
    expectedPoints: safeBase * multiplier * safeStart,
    breakdown: {
      averagePoints: safeBase,
      startingProbability: safeStart,
      teamWinProbability: teamWinProb,
      cleanSheetProbability: cleanSheetProb,
      teamExpectedGoals,
      opponentExpectedGoals,
      situationalFactor: situational,
      multiplier,
      isHome
    }
  };
}

async function loadFixture(matchId) {
  const bq = getBigQueryClient();
  const [rows] = await bq.query({
    query: `
      SELECT home_team_id, away_team_id
      FROM \`${bqTable("matches")}\`
      WHERE match_id = @matchId
      LIMIT 1
    `,
    params: { matchId }
  });
  return rows[0] ?? null;
}

async function loadOrComputePrediction(matchId) {
  // Prefer the most recent cached prediction (cheap BQ read); fall back to a
  // fresh on-the-fly computation if the cache is empty for this match (e.g.
  // a backtest of a historic fixture).
  const bq = getBigQueryClient();
  const [rows] = await bq.query({
    query: `
      SELECT model_version, prob_home_win, prob_draw, prob_away_win,
             expected_home_goals, expected_away_goals
      FROM \`${bqTable("predictions")}\`
      WHERE match_id = @matchId
      ORDER BY run_at DESC
      LIMIT 1
    `,
    params: { matchId }
  });
  if (rows[0]) {
    return {
      modelVersion: rows[0].model_version,
      probHomeWin: rows[0].prob_home_win,
      probDraw: rows[0].prob_draw,
      probAwayWin: rows[0].prob_away_win,
      expectedHomeGoals: rows[0].expected_home_goals,
      expectedAwayGoals: rows[0].expected_away_goals
    };
  }
  return computePrediction({ matchId });
}

/**
 * Helper for tests / consumers that already have a prediction object and
 * just need the scoring math without the BigQuery roundtrip.
 *
 * @param {object} player
 * @param {object} prediction
 * @param {boolean} isHome
 */
export function scoreOneForTest(player, prediction, isHome) {
  return scoreOne(player, prediction, isHome);
}

// Re-export so the projection module can be used standalone in tests
export { DEFAULT_PARAMS, matchOutcomeProbabilities };
