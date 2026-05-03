"use strict";

const express = require("express");
const { readAuditFeed } = require("../services/audit-feed-service");

const router = express.Router();

router.get("/", async (req, res) => {
  try {
    const rows = await readAuditFeed({
      agencyId: req.auth.agencyId,
      moduleKey: req.query.module || null,
      limit: req.query.limit || 50,
      cursor: req.query.cursor || null,
    });
    return res.json({ ok: true, audit: rows });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "AUDIT_FEED_FAILED", error: err?.message || "Failed" });
  }
});

module.exports = router;
