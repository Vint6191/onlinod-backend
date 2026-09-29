"use strict";
module.exports = function retiredAccountSecurityWrites(req, res, next) {
  if (/^(?:POST \/account\/(?:password|devices\/logout-others|sessions\/revoke-others)|DELETE \/account\/(?:devices|sessions)\/[^/]+)\/?$/i.test(`${req.method} ${req.path}`))
    return res.status(410).json({ ok: false, code: "ACCOUNT_SECURITY_COMMAND_REQUIRED", error: "Update Desktop to use recoverable account actions" });
  return next();
};
