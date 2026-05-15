import { postMatchProjectionsController } from "../../../controllers/predictions.controllers.js";

export default async function (fastify) {
  fastify.post("/match/:matchId", {
    schema: postMatchProjectionsController.schema,
    handler: postMatchProjectionsController.handler
  });
}
