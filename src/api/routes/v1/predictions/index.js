import { getPredictionByMatchIdController } from "../../../controllers/predictions.controllers.js";

export default async function (fastify) {
  fastify.get("/:matchId", {
    schema: getPredictionByMatchIdController.schema,
    handler: getPredictionByMatchIdController.handler
  });
}
