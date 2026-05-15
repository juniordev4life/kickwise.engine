import { describe, expect, it } from "vitest";
import { matchOutcomeProbabilities, poissonPmf } from "../../src/utils/poisson.utils.js";

describe("poissonPmf", () => {
  it("returns ~0.3679 for k=0, λ=1 (≈ e^-1)", () => {
    expect(poissonPmf(0, 1)).toBeCloseTo(Math.exp(-1), 6);
  });

  it("returns 0 for invalid inputs", () => {
    expect(poissonPmf(-1, 1)).toBe(0);
    expect(poissonPmf(1, -1)).toBe(0);
    expect(poissonPmf(Number.NaN, 1)).toBe(0);
  });

  it("sums to 1 across all k up to a high cap", () => {
    const lambda = 2.4;
    let total = 0;
    for (let k = 0; k <= 30; k += 1) total += poissonPmf(k, lambda);
    expect(total).toBeCloseTo(1, 4);
  });
});

describe("matchOutcomeProbabilities", () => {
  it("returns probabilities that sum to ~1", () => {
    const r = matchOutcomeProbabilities(1.5, 1.1);
    expect(r.probHomeWin + r.probDraw + r.probAwayWin).toBeCloseTo(1, 6);
  });

  it("favors the team with higher expected goals", () => {
    const r = matchOutcomeProbabilities(2.0, 0.8);
    expect(r.probHomeWin).toBeGreaterThan(r.probAwayWin);
    expect(r.probHomeWin).toBeGreaterThan(r.probDraw);
  });

  it("yields ~equal home/away with equal λ", () => {
    const r = matchOutcomeProbabilities(1.4, 1.4);
    expect(Math.abs(r.probHomeWin - r.probAwayWin)).toBeLessThan(1e-6);
  });

  it("propagates expected goals back unchanged", () => {
    const r = matchOutcomeProbabilities(1.7, 0.9);
    expect(r.expectedHomeGoals).toBe(1.7);
    expect(r.expectedAwayGoals).toBe(0.9);
  });

  it("Dixon-Coles rho > 0 increases draw probability vs baseline", () => {
    const base = matchOutcomeProbabilities(1.4, 1.1, { rho: 0 });
    const dc = matchOutcomeProbabilities(1.4, 1.1, { rho: 0.1 });
    expect(dc.probDraw).toBeGreaterThan(base.probDraw);
    // and the trio still sums to 1
    expect(dc.probHomeWin + dc.probDraw + dc.probAwayWin).toBeCloseTo(1, 6);
  });

  it("rho == 0 is identical to the baseline", () => {
    const base = matchOutcomeProbabilities(1.6, 1.1);
    const dc = matchOutcomeProbabilities(1.6, 1.1, { rho: 0 });
    expect(dc.probHomeWin).toBeCloseTo(base.probHomeWin, 8);
    expect(dc.probDraw).toBeCloseTo(base.probDraw, 8);
    expect(dc.probAwayWin).toBeCloseTo(base.probAwayWin, 8);
  });
});
