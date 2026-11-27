"use strict";

// Only body-parser's documented, typed client failures belong to this boundary.
// Arbitrary errors carrying a status property remain internal server failures.
const BODY_ERRORS = Object.freeze({
  "entity.parse.failed": { status: 400, code: "INVALID_JSON", error: "Invalid JSON request body" },
  "entity.too.large": { status: 413, code: "REQUEST_BODY_TOO_LARGE", error: "Request body is too large" },
  "encoding.unsupported": { status: 415, code: "UNSUPPORTED_CONTENT_ENCODING", error: "Unsupported content encoding" },
  "charset.unsupported": { status: 415, code: "UNSUPPORTED_CHARSET", error: "Unsupported request charset" },
  "request.aborted": { status: 400, code: "REQUEST_BODY_ABORTED", error: "Request body was interrupted" },
  "request.size.invalid": { status: 400, code: "REQUEST_BODY_SIZE_INVALID", error: "Request body size is invalid" },
});

function httpBodyError(err, _req, res, next) {
  const mapped = Object.hasOwn(BODY_ERRORS, err?.type) ? BODY_ERRORS[err.type] : null;
  if (!mapped || err.status !== mapped.status) return next(err);
  if (res.headersSent) return next(err);
  // Never serialize err.body, parser messages, tokens, or submitted credentials.
  return res.status(mapped.status).json({ ok: false, code: mapped.code, error: mapped.error });
}

module.exports = { httpBodyError };
