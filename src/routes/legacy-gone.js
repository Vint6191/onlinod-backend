"use strict";

const express = require("express");

function createLegacyGoneRouter(surface, replacement = null) {
  const router = express.Router();
  router.use((req, res) => res.status(410).json({
    ok: false,
    code: "LEGACY_PRODUCT_SURFACE_GONE",
    surface: String(surface || "legacy"),
    replacement: replacement || null,
    error: replacement
      ? `This legacy product surface is retired. Use ${replacement}.`
      : "This legacy product surface is retired.",
  }));
  return router;
}

module.exports = { createLegacyGoneRouter };
