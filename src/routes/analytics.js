"use strict";

const express = require("express");
const router = express.Router();
router.use((_req, res) => res.status(410).json({
  ok: false, code: "ANALYTICS_LEGACY_GONE",
  error: "Legacy analytics snapshots are retired; use /api/home and /api/stats",
}));
module.exports = router;
