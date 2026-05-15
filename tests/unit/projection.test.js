import { describe, expect, it } from "vitest";
import { scoreOneForTest } from "../../src/api/services/projection.services.js";

const PREDICTION_BVB_FAVORED = {
  probHomeWin: 0.58,
  probDraw: 0.21,
  probAwayWin: 0.21,
  expectedHomeGoals: 2.0,
  expectedAwayGoals: 1.1
};

const PREDICTION_DRAW_ODDS = {
  probHomeWin: 0.33,
  probDraw: 0.34,
  probAwayWin: 0.33,
  expectedHomeGoals: 1.5,
  expectedAwayGoals: 1.5
};

describe("projection scoreOne", () => {
  it("higher expected for a striker on the favored team than on the underdog", () => {
    const striker = {
      playerId: "1",
      teamId: "7",
      position: "FWD",
      averagePoints: 100,
      startingProbability: 0.9
    };
    const home = scoreOneForTest(striker, PREDICTION_BVB_FAVORED, true);
    const away = scoreOneForTest(striker, PREDICTION_BVB_FAVORED, false);
    expect(home.expectedPoints).toBeGreaterThan(away.expectedPoints);
  });

  it("higher expected for a defender when clean sheet is likely", () => {
    const defender = {
      playerId: "2",
      teamId: "7",
      position: "DEF",
      averagePoints: 100,
      startingProbability: 1
    };
    const tightGame = scoreOneForTest(
      defender,
      { ...PREDICTION_BVB_FAVORED, expectedAwayGoals: 0.4 },
      true
    );
    const looseGame = scoreOneForTest(
      defender,
      { ...PREDICTION_BVB_FAVORED, expectedAwayGoals: 2.5 },
      true
    );
    expect(tightGame.expectedPoints).toBeGreaterThan(looseGame.expectedPoints);
  });

  it("scales linearly with startingProbability", () => {
    const player = { playerId: "3", teamId: "7", position: "MID", averagePoints: 100 };
    const full = scoreOneForTest(
      { ...player, startingProbability: 1 },
      PREDICTION_BVB_FAVORED,
      true
    );
    const half = scoreOneForTest(
      { ...player, startingProbability: 0.5 },
      PREDICTION_BVB_FAVORED,
      true
    );
    expect(half.expectedPoints).toBeCloseTo(full.expectedPoints / 2, 6);
  });

  it("falls back to a reasonable default startingProbability when missing", () => {
    const player = { playerId: "4", teamId: "7", position: "MID", averagePoints: 100 };
    const out = scoreOneForTest(player, PREDICTION_BVB_FAVORED, true);
    expect(out.expectedPoints).toBeGreaterThan(0);
    expect(out.breakdown.startingProbability).toBeGreaterThan(0.5);
    expect(out.breakdown.startingProbability).toBeLessThan(1);
  });

  it("multiplier sits in the [0.7, 1.3] band", () => {
    const players = [
      { position: "GK", teamId: "7", averagePoints: 100, startingProbability: 1 },
      { position: "DEF", teamId: "7", averagePoints: 100, startingProbability: 1 },
      { position: "MID", teamId: "7", averagePoints: 100, startingProbability: 1 },
      { position: "FWD", teamId: "7", averagePoints: 100, startingProbability: 1 }
    ];
    for (const p of players) {
      const out = scoreOneForTest(p, PREDICTION_DRAW_ODDS, true);
      expect(out.breakdown.multiplier).toBeGreaterThanOrEqual(0.7);
      expect(out.breakdown.multiplier).toBeLessThanOrEqual(1.3);
    }
  });
});
