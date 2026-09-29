"use strict";
// Exact retirement gateway: connection/lifecycle, keyring, password, avatar,
// Telegram and secret-read protocols retain their own owners.
module.exports = function retiredManagementWrites(req, res, next) {
  const key = `${req.method} ${req.baseUrl}${req.path}`.replace(/\/$/, "");
  if (
    /^(?:POST \/api\/creators|PATCH \/api\/creators\/[^/]+|PATCH \/api\/settings\/(?:account\/profile|workspace)|POST \/api\/network-profiles\/creators\/[^/]+\/proxy|(?:PATCH|DELETE) \/api\/network-profiles\/proxies\/[^/]+|PUT \/api\/network-profiles\/creators\/[^/]+)$/i.test(
      key
    )
  ) {
    return res
      .status(410)
      .json({
        ok: false,
        code: "MANAGEMENT_COMMAND_REQUIRED",
        error: "Update Desktop to use recoverable management commands",
      });
  }
  return next();
};
