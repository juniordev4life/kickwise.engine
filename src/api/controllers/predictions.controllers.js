import { handleErrorResponse, setGeneralResponse } from "../helpers/responseHandler.helpers.js";
import { computePrediction } from "../services/prediction.services.js";

const matchParamsSchema = {
  type: "object",
  required: ["matchId"],
  properties: {
    matchId: { type: "string", pattern: "^[0-9]+$" }
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
