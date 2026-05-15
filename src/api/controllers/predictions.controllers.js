import { handleErrorResponse, setGeneralResponse } from "../helpers/responseHandler.helpers.js";
import {
  backtest,
  computeAndCacheMatchdayPredictions,
  computePrediction,
  findUpcomingMatchday
} from "../services/prediction.services.js";

const matchParamsSchema = {
  type: "object",
  required: ["matchId"],
  properties: {
    matchId: { type: "string", pattern: "^[0-9]+$" }
  }
};

const batchBodySchema = {
  type: "object",
  required: ["seasonId", "matchday"],
  properties: {
    seasonId: { type: "string", pattern: "^\\d{4}/\\d{4}$" },
    matchday: { type: "integer", minimum: 1, maximum: 34 }
  }
};

const backtestBodySchema = {
  type: "object",
  required: ["seasonId"],
  properties: {
    seasonId: { type: "string", pattern: "^\\d{4}/\\d{4}$" },
    paramOverrides: {
      type: "object",
      additionalProperties: false,
      properties: {
        formWindow: { type: "integer", minimum: 1, maximum: 50 },
        decayRate: { type: "number", minimum: 0, maximum: 1 },
        rho: { type: "number", minimum: -0.5, maximum: 0.5 },
        xgGoalsBlend: { type: "number", minimum: 0, maximum: 1 },
        homeAttackFactor: { type: "number", minimum: 0.5, maximum: 2 },
        minLambda: { type: "number", minimum: 0, maximum: 1 }
      }
    }
  }
};

/**
 * GET /api/v1/predictions/:matchId — Poisson-xG prediction for a single fixture.
 */
export const getPredictionByMatchIdController = {
  schema: { params: matchParamsSchema },
  handler: async (request, reply) => {
    try {
      const prediction = await computePrediction({ matchId: request.params.matchId });
      return setGeneralResponse(reply, 200, "Success", "Prediction computed", { prediction });
    } catch (error) {
      return handleErrorResponse(reply, error, request);
    }
  }
};

/**
 * POST /api/v1/predictions/batch — compute all predictions for a matchday
 * and persist them in the `predictions` BigQuery table.
 */
export const postBatchPredictionsController = {
  schema: { body: batchBodySchema },
  handler: async (request, reply) => {
    try {
      const summary = await computeAndCacheMatchdayPredictions({
        seasonId: request.body.seasonId,
        matchday: request.body.matchday,
        log: request.log
      });
      return setGeneralResponse(reply, 200, "Success", "Matchday predictions cached", summary);
    } catch (error) {
      return handleErrorResponse(reply, error, request);
    }
  }
};

/**
 * POST /api/v1/predictions/refresh-current — auto-detect the next unfinished
 * matchday and cache its predictions. Designed for Cloud Scheduler.
 */
export const postRefreshCurrentController = {
  handler: async (request, reply) => {
    try {
      const target = await findUpcomingMatchday();
      if (!target) {
        return setGeneralResponse(
          reply,
          200,
          "Success",
          "Season fully finished — nothing to refresh",
          {
            refreshed: false
          }
        );
      }
      const summary = await computeAndCacheMatchdayPredictions({
        seasonId: target.seasonId,
        matchday: target.matchday,
        log: request.log
      });
      return setGeneralResponse(reply, 200, "Success", "Current matchday refreshed", {
        refreshed: true,
        ...summary
      });
    } catch (error) {
      return handleErrorResponse(reply, error, request);
    }
  }
};

/**
 * POST /api/v1/predictions/backtest — score every finished match of a
 * season against the current model. Returns aggregate Log-Loss, Brier, top-1.
 */
export const postBacktestController = {
  schema: { body: backtestBodySchema },
  handler: async (request, reply) => {
    try {
      const report = await backtest({
        seasonId: request.body.seasonId,
        paramOverrides: request.body.paramOverrides,
        log: request.log
      });
      return setGeneralResponse(reply, 200, "Success", "Backtest completed", report);
    } catch (error) {
      return handleErrorResponse(reply, error, request);
    }
  }
};
