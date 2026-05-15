import path from "node:path";
import autoload from "@fastify/autoload";
import { handleErrorResponse } from "./api/helpers/responseHandler.helpers.js";

/**
 * Wire Engine plugins, error handling, and route auto-loading.
 *
 * @param {import("fastify").FastifyInstance} server
 * @param {{ __dirname: string }} ctx
 */
export async function configureServer(server, { __dirname }) {
  server.setErrorHandler((error, request, reply) => handleErrorResponse(reply, error, request));

  server.get("/health", async () => ({
    service: "engine",
    status: "ok",
    timestamp: new Date().toISOString()
  }));

  await server.register(autoload, {
    dir: path.join(__dirname, "api", "routes"),
    options: { prefix: "/api" }
  });
}
