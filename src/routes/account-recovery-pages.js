"use strict";
const path = require("node:path");
const router = require("express").Router();

// A public recovery page must also work when this browser still has an old
// web-console session. It does not load that console or its local token store.
router.get(["/forgot-password", "/reset-password"], (_req, res) => {
  res.set({
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  return res.sendFile(path.join(__dirname, "../../public/account-recovery/index.html"));
});

module.exports = router;
