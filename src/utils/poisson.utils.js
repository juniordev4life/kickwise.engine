/**
 * Poisson probability mass function: P(k events | mean λ).
 *
 * @param {number} k Number of events (0,1,2,...). Cast to integer; negative
 *   inputs return 0.
 * @param {number} lambda Expected number of events (>=0).
 * @returns {number} Probability in [0, 1].
 *
 * @example
 *   poissonPmf(2, 1.5) // ≈ 0.2510
 */
export function poissonPmf(k, lambda) {
  if (lambda < 0 || k < 0 || !Number.isFinite(lambda) || !Number.isFinite(k)) return 0;
  const kInt = Math.trunc(k);
  // exp(-λ) * λ^k / k!  — computed in log space first to stay stable for
  // small λ * large k (rare in football, but cheap insurance).
  const logP = -lambda + kInt * Math.log(lambda || 1e-12) - logFactorial(kInt);
  return Math.exp(logP);
}

/**
 * Outcome distribution (home win / draw / away win) and expected goals from
 * a pair of independent Poisson means.
 *
 * @param {number} expectedHomeGoals λ for home side
 * @param {number} expectedAwayGoals λ for away side
 * @param {number} [maxGoals=8] Truncation cap for the score matrix
 * @returns {{ probHomeWin: number, probDraw: number, probAwayWin: number,
 *   expectedHomeGoals: number, expectedAwayGoals: number }}
 *
 * @example
 *   matchOutcomeProbabilities(1.6, 1.1)
 *   // { probHomeWin: ~0.49, probDraw: ~0.26, probAwayWin: ~0.25, ... }
 */
export function matchOutcomeProbabilities(expectedHomeGoals, expectedAwayGoals, maxGoals = 8) {
  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  for (let h = 0; h <= maxGoals; h += 1) {
    const ph = poissonPmf(h, expectedHomeGoals);
    for (let a = 0; a <= maxGoals; a += 1) {
      const pa = poissonPmf(a, expectedAwayGoals);
      const joint = ph * pa;
      if (h > a) pHome += joint;
      else if (h === a) pDraw += joint;
      else pAway += joint;
    }
  }
  const total = pHome + pDraw + pAway || 1;
  return {
    probHomeWin: pHome / total,
    probDraw: pDraw / total,
    probAwayWin: pAway / total,
    expectedHomeGoals,
    expectedAwayGoals
  };
}

const LOG_FACT_CACHE = [0];

function logFactorial(n) {
  if (n < LOG_FACT_CACHE.length) return LOG_FACT_CACHE[n];
  let acc = LOG_FACT_CACHE[LOG_FACT_CACHE.length - 1];
  for (let i = LOG_FACT_CACHE.length; i <= n; i += 1) {
    acc += Math.log(i);
    LOG_FACT_CACHE[i] = acc;
  }
  return LOG_FACT_CACHE[n];
}
