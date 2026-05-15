/**
 * Send the standard Kickwise success envelope.
 *
 * @param {import("fastify").FastifyReply} reply
 * @param {number} code
 * @param {string} title
 * @param {string} message
 * @param {*} data
 * @returns {import("fastify").FastifyReply}
 *
 * @example
 *   return setGeneralResponse(reply, 200, "Success", "Prediction computed", { prediction });
 */
export function setGeneralResponse(reply, code, title, message, data = {}) {
  return reply.status(code).send({
    traceId: reply.request?.id ?? null,
    code,
    title,
    message,
    data,
    errors: []
  });
}

/**
 * Convert any thrown error into the Kickwise error envelope.
 *
 * @param {import("fastify").FastifyReply} reply
 * @param {Error} error
 * @param {import("fastify").FastifyRequest} request
 * @returns {import("fastify").FastifyReply}
 */
export function handleErrorResponse(reply, error, request) {
  const statusCode = error.statusCode ?? 500;
  const errors = error.validation
    ? error.validation.map((v) => v.message ?? JSON.stringify(v))
    : [error.message ?? "Unknown error"];

  if (statusCode >= 500) {
    request?.log?.error({ err: error }, "Unhandled error in Engine");
  } else {
    request?.log?.warn({ err: error }, "Handled error in Engine");
  }

  return reply.status(statusCode).send({
    traceId: request?.id ?? null,
    code: statusCode,
    title: error.title ?? (statusCode >= 500 ? "Server Error" : "Bad Request"),
    message: error.message ?? "Unknown error",
    data: {},
    errors
  });
}
