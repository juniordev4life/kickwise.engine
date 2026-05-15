import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { configureServer } from "./setup.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Build the Engine Fastify instance with all plugins and routes registered.
 *
 * @returns {Promise<import("fastify").FastifyInstance>}
 *
 * @example
 *   const server = await buildServer();
 *   await server.listen({ port: 3002 });
 */
export async function buildServer() {
  const server = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        process.env.NODE_ENV === "production"
          ? undefined
          : {
              target: "pino-pretty",
              options: { colorize: true, translateTime: "SYS:standard" }
            }
    },
    requestIdHeader: "x-request-id",
    trustProxy: true
  });

  await configureServer(server, { __dirname });
  return server;
}
