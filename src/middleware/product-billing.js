"use strict";
const { withProductBilling } = require("../services/product-billing-context-service");

function isDrainRequest(req) {
  const path = req.path, base = req.baseUrl;
  if (base === "/api/automation") return path.startsWith("/worker/") || /\/events(?:\/current-authorized)?$/.test(path);
  if (base === "/api/fan-data") return path === "/observations";
  if (base === "/api/dialog-intelligence") return /^\/batches\/[^/]+\/(?:renew|progress|complete|release)$/.test(path) || /\/ingest\//.test(path) || path.endsWith("/local-counts/reconcile");
  if (base === "/api/custom-orders") return /\/(execution-attempt|source-work\/heartbeat|media-commit|vault-settlement\/confirm|content-library-finalize|relay-write\/(?:reserve|close-unresolved|resolve-unresolved-matched))$/.test(path)
    || path === "/submissions/upload-work" || path === "/telegram-inbound"
    || /^\/telegram-deliveries\/(?:work|confirmed-projection-blocked|reconciliation-required|precommit-blocked|reminder-planning-blocked)$/.test(path)
    || /^\/telegram-deliveries\/[^/]+\/(?:claim|begin|confirm|unknown|proven-not-sent|fail-precommit|reference-cancel|reconcile|retry-confirmed-projection)$/.test(path);
  return false;
}
function productBilling(req, _res, next) {
  if (isDrainRequest(req)) return next();
  return withProductBilling(req.auth?.agencyId, () => next());
}
module.exports = { productBilling, isDrainRequest };
