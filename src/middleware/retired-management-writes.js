"use strict";
// Exact retirement gateway: connection completion/retirement, keyring, password,
// Telegram identity and secret-read protocols retain their own owners.
module.exports = function retiredManagementWrites(req, res, next) {
  const key = `${req.method} ${req.baseUrl}${req.path}`.replace(/\/$/, "");
  if (/^(?:POST \/api\/traffic\/creators\/[^/]+\/refresh|POST \/api\/dialog-intelligence\/creators\/[^/]+\/dialogs\/[^/]+\/(?:scans|cancel)|PATCH \/api\/dialog-intelligence\/control|POST \/api\/stats\/creators\/[^/]+\/(?:refresh|(?:notification-scan|financial-transaction-scan|campaign-scan)\/(?:start|stop))|POST \/api\/server\/vault-directory\/[^/]+\/unsorted\/(?:scans|pause|resume|cancel)|POST \/api\/dialog-intelligence\/creators\/[^/]+\/(?:scans|pause|resume|cancel)|POST \/api\/subscribers\/[^/]+\/scan|PATCH \/api\/subscribers\/[^/]+\/hidden-online\/[^/]+\/status|POST \/api\/automation\/(?:follow-back|follow|likes|sfs)\/[^/]+\/candidates\/[^/]+\/action|POST \/api\/automation\/(?:follow-back|follow|likes|sfs|bumps)\/[^/]+\/(?:plan|plan-auto|discover|reply-scan)|POST \/api\/automation\/deliveries\/(?:retry-safe|[^/]+\/(?:retry|cancel|release)))$/i.test(key)) {
    return res.status(410).json({ok:false,code:"MANAGEMENT_COMMAND_REQUIRED",error:"Update Desktop to use recoverable operations"});
  }
  if (/^(?:POST \/api\/team\/(?:claims\/override|analytics\/ppv\/conflicts\/[^/]+\/resolve)|(?:POST|PATCH|DELETE) \/api\/server\/automation\/(?:bumps|sfs-comments)(?:\/(?!gc$).+)?|DELETE \/api\/creators\/[^/]+|PATCH \/api\/automation\/controls|PATCH \/api\/traffic\/creators\/[^/]+\/sources\/[^/]+|PUT \/api\/server\/media-library\/[^/]+\/assets\/[^/]+\/metadata|POST \/api\/server\/media-library\/[^/]+\/(?:folders\/mutate|assets\/delete)|PATCH \/api\/custom-orders\/[^/]+|PUT \/api\/custom-orders\/creators\/[^/]+\/vault-destination)$/i.test(key)) {
    return res.status(410).json({ok:false,code:"MANAGEMENT_COMMAND_REQUIRED",error:"Update Desktop to recover control commands"});
  }
  if (
    /^(?:(?:POST|DELETE) \/api\/settings\/account\/avatar|POST \/api\/creators\/[^/]+\/avatar|POST \/api\/creators|POST \/api\/creators\/[^/]+\/begin-connection|PATCH \/api\/creators\/[^/]+\/telegram-contact|PATCH \/api\/billing\/creators\/[^/]+\/preferences|POST \/api\/billing\/creators\/[^/]+\/(?:start|cancel-renewal)|PATCH \/api\/creators\/[^/]+|PATCH \/api\/settings\/(?:account\/profile|workspace)|POST \/api\/network-profiles\/creators\/[^/]+\/proxy|(?:PATCH|DELETE) \/api\/network-profiles\/proxies\/[^/]+|PUT \/api\/network-profiles\/creators\/[^/]+)$/i.test(
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
