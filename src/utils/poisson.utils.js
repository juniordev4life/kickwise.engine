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
 * a pair of independent Poisson means. Supports the Dixon-Coles
 * low-score correction: with rho > 0 the four cells (0,0), (1,0), (0,1),
 * (1,1) get a multiplicative adjustment that boosts draws (and damps the
 * 0-0 / 1-1 / 1-0 / 0-1 underestimation classic Poisson models exhibit).
 *
 * @param {number} expectedHomeGoals λ for home side
 * @param {number} expectedAwayGoals λ for away side
 * @param {object} [opts]
 * @param {number} [opts.maxGoals=8] Truncation cap for the score matrix
 * @param {number} [opts.rho=0] Dixon-Coles draw-correlation parameter. 0
 *   reproduces independent Poisson; 0.05–0.15 is the typical empirical
 *   range for top-flight European football.
 * @returns {{ probHomeWin: number, probDraw: number, probAwayWin: number,
 *   expectedHomeGoals: number, expectedAwayGoals: number }}
 *
 * @example
 *   matchOutcomeProbabilities(1.6, 1.1, { rho: 0.1 })
 *   // probDraw bumps a few percent vs the rho=0 baseline
 */
export function matchOutcomeProbabilities(expectedHomeGoals, expectedAwayGoals, opts = {}) {
  const { maxGoals = 8, rho = 0 } = opts;
  let pHome = 0;
  let pDraw = 0;
  let pAway = 0;
  for (let h = 0; h <= maxGoals; h += 1) {
    const ph = poissonPmf(h, expectedHomeGoals);
    for (let a = 0; a <= maxGoals; a += 1) {
      const pa = poissonPmf(a, expectedAwayGoals);
      const tau = dixonColesTau(h, a, expectedHomeGoals, expectedAwayGoals, rho);
      const joint = ph * pa * tau;
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

/**
 * Dixon-Coles τ-factor applied to the four low-score cells. Returns 1 for
 * every other (h, a) pair so the rest of the score matrix is unchanged.
 *
 * @param {number} h home goals
 * @param {number} a away goals
 * @param {number} lambdaH home λ
 * @param {number} lambdaA away λ
 * @param {number} rho correlation parameter
 * @returns {number}
 */
function dixonColesTau(h, a, lambdaH, lambdaA, rho) {
  if (!rho) return 1;
  // Sign convention chosen so positive rho boosts draws (matching the
  // empirical Bundesliga / Premier League observation that classic Poisson
  // undercounts 0-0 and 1-1). Original Dixon-Coles 1997 paper uses the
  // opposite sign convention, where their reported rho is typically
  // negative; this implementation flips that for readability.
  if (h === 0 && a === 0) return 1 + lambdaH * lambdaA * rho;
  if (h === 0 && a === 1) return 1 - lambdaH * rho;
  if (h === 1 && a === 0) return 1 - lambdaA * rho;
  if (h === 1 && a === 1) return 1 + rho;
  return 1;
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
