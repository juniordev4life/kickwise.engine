import Fastify from "fastify";

const port = Number.parseInt(process.env.PORT ?? "3002", 10);

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
  }
});

server.get("/health", async () => ({
  service: "engine",
  status: "ok",
  phase: "1 — skeleton",
  timestamp: new Date().toISOString()
}));

server.get("/", async () => ({
  message:
    "Kickwise Engine — Phase 2 coming soon (Poisson predictions, player projections, 3-2-1 manager H2H)"
}));

try {
  await server.listen({ port, host: "0.0.0.0" });
} catch (err) {
  server.log.error({ err }, "Engine failed to start");
  process.exit(1);
}
