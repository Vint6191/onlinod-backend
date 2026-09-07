"use strict";

// HTTP statuses that are deterministic provider rejections for the protected
// request itself. 408/409 and all 5xx remain ambiguous: the provider may have
// committed an effect before the response/error was produced.
const PROVEN_NO_EFFECT_HTTP_STATUSES = new Set([
  400, 401, 402, 403, 404, 405, 406, 407,
  410, 411, 412, 413, 414, 415, 416, 417, 418,
  421, 422, 423, 424, 426, 428, 429, 431, 451,
]);

function isProviderStatusProvenNoEffect(value) {
  const status = Number(value);
  return Number.isInteger(status) && PROVEN_NO_EFFECT_HTTP_STATUSES.has(status);
}

function isProviderStatusProvenSuccess(value) {
  const status = Number(value);
  return Number.isInteger(status) && status >= 200 && status < 300;
}

module.exports = { PROVEN_NO_EFFECT_HTTP_STATUSES, isProviderStatusProvenNoEffect, isProviderStatusProvenSuccess };
