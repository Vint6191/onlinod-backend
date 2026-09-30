"use strict";
module.exports = function retiredTelegramControlWrites(req, res, next) {
  if (
    /^(?:PATCH \/telegram\/reminders|POST \/telegram\/accounts|DELETE \/telegram\/accounts\/[^/]+|POST \/telegram\/accounts\/[^/]+\/force-retire|PUT \/telegram\/accounts\/[^/]+\/session)\/?$/i.test(
      `${req.method} ${req.path}`
    )
  )
    return res
      .status(410)
      .json({
        ok: false,
        code: "TELEGRAM_CONTROL_COMMAND_REQUIRED",
        error: "Update Desktop to use recoverable Telegram actions",
      });
  return next();
};
