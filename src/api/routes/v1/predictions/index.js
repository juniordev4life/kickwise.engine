import {
  getPredictionByMatchIdController,
  postBacktestController,
  postBatchPredictionsController,
  postRefreshCurrentController
} from "../../../controllers/predictions.controllers.js";

export default async function (fastify) {
  fastify.get("/:matchId", {
    schema: getPredictionByMatchIdController.schema,
    handler: getPredictionByMatchIdController.handler
  });

  fastify.post("/batch", {
    schema: postBatchPredictionsController.schema,
    handler: postBatchPredictionsController.handler
  });

  fastify.post("/refresh-current", {
    handler: postRefreshCurrentController.handler
  });

  fastify.post("/backtest", {
    schema: postBacktestController.schema,
    handler: postBacktestController.handler
  });
}
