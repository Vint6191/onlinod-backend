"use strict";

// Backward-compatible aliases for clients that still call /api/vault/unsorted.
// The durable P17.7 scanner itself lives under /api/server/vault-directory and
// stores normalized rows instead of accepting renderer-built snapshots.

const express = require("express");
const prisma = require("../prisma");
const {
  getVaultUnsortedState,
  markVaultUnsortedItems,
} = require("../services/vault-unsorted-service");

const router = express.Router();

async function loadCreator(req, res, creatorId) {
  const creator = await prisma.creatorAccount.findFirst({
    where: { id: creatorId, agencyId: req.auth.agencyId, deletedAt: null },
    select: { id: true },
  });
  if (!creator) {
    res.status(404).json({ ok: false, code: "CREATOR_NOT_FOUND", error: "Creator not found" });
    return null;
  }
  return creator;
}

router.get("/unsorted/:creatorId", async (req, res) => {
  try {
    const creator = await loadCreator(req, res, req.params.creatorId);
    if (!creator) return;
    return res.json(await getVaultUnsortedState({
      agencyId: req.auth.agencyId,
      creatorId: creator.id,
    }));
  } catch (err) {
    return res.status(500).json({ ok: false, code: "VAULT_UNSORTED_GET_FAILED", error: err?.message || "Failed" });
  }
});

router.put("/unsorted/:creatorId", async (_req, res) => {
  return res.status(410).json({
    ok: false,
    code: "VAULT_UNSORTED_LEGACY_SNAPSHOT_DISABLED",
    error: "Renderer-built Unsorted snapshots are disabled. Start the durable server-coordinated scan instead.",
  });
});

router.post("/unsorted/:creatorId/items/:mediaId/mark-sorted", async (req, res) => {
  try {
    const creator = await loadCreator(req, res, req.params.creatorId);
    if (!creator) return;
    return res.json(await markVaultUnsortedItems({
      agencyId: req.auth.agencyId,
      creatorId: creator.id,
      mediaIds: [String(req.params.mediaId || "")],
      status: "SORTED",
    }));
  } catch (err) {
    return res.status(500).json({ ok: false, code: "VAULT_UNSORTED_MARK_SORTED_FAILED", error: err?.message || "Failed" });
  }
});

module.exports = router;
