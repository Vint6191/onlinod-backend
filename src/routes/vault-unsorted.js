"use strict";

const express = require("express");
const prisma = require("../prisma");

const router = express.Router();

async function loadCreator(req, res, creatorId) {
  const creator = await prisma.creatorAccount.findFirst({ where: { id: creatorId, agencyId: req.auth.agencyId, deletedAt: null } });
  if (!creator) {
    res.status(404).json({ ok: false, code: "CREATOR_NOT_FOUND", error: "Creator not found" });
    return null;
  }
  return creator;
}

function countItems(payload) {
  const items = Array.isArray(payload?.items) ? payload.items : Array.isArray(payload?.media) ? payload.media : [];
  const itemsCount = items.length;
  const sortedCount = items.filter((item) => item?.sorted === true || item?.status === "sorted").length;
  return { itemsCount, sortedCount, unsortedCount: Math.max(0, itemsCount - sortedCount) };
}

router.get("/unsorted/:creatorId", async (req, res) => {
  try {
    const creator = await loadCreator(req, res, req.params.creatorId); if (!creator) return;
    const snapshot = await prisma.vaultUnsortedSnapshot.findUnique({ where: { agencyId_creatorId: { agencyId: req.auth.agencyId, creatorId: creator.id } } });
    return res.json({ ok: true, snapshot });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "VAULT_UNSORTED_GET_FAILED", error: err?.message || "Failed" });
  }
});

router.put("/unsorted/:creatorId", async (req, res) => {
  try {
    const creator = await loadCreator(req, res, req.params.creatorId); if (!creator) return;
    const payload = req.body?.payload && typeof req.body.payload === "object" ? req.body.payload : req.body || {};
    const counts = countItems(payload);
    const snapshot = await prisma.vaultUnsortedSnapshot.upsert({
      where: { agencyId_creatorId: { agencyId: req.auth.agencyId, creatorId: creator.id } },
      create: { agencyId: req.auth.agencyId, creatorId: creator.id, payload, ...counts, updatedByUserId: req.auth.userId, capturedAt: new Date() },
      update: { payload, ...counts, updatedByUserId: req.auth.userId, capturedAt: new Date() },
    });
    return res.json({ ok: true, snapshot });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "VAULT_UNSORTED_PUT_FAILED", error: err?.message || "Failed" });
  }
});

router.post("/unsorted/:creatorId/items/:mediaId/mark-sorted", async (req, res) => {
  try {
    const creator = await loadCreator(req, res, req.params.creatorId); if (!creator) return;
    const snapshot = await prisma.vaultUnsortedSnapshot.findUnique({ where: { agencyId_creatorId: { agencyId: req.auth.agencyId, creatorId: creator.id } } });
    if (!snapshot) return res.status(404).json({ ok: false, code: "VAULT_UNSORTED_NOT_FOUND", error: "Unsorted snapshot not found" });

    const payload = snapshot.payload && typeof snapshot.payload === "object" ? snapshot.payload : {};
    const mediaId = String(req.params.mediaId || "");
    const items = Array.isArray(payload.items) ? payload.items : Array.isArray(payload.media) ? payload.media : [];
    for (const item of items) {
      if (String(item?.id || item?.mediaId || "") === mediaId) {
        item.sorted = true;
        item.status = "sorted";
        item.sortedAt = new Date().toISOString();
        item.sortedByUserId = req.auth.userId;
      }
    }
    if (Array.isArray(payload.items)) payload.items = items;
    else payload.media = items;
    const counts = countItems(payload);
    const updated = await prisma.vaultUnsortedSnapshot.update({ where: { id: snapshot.id }, data: { payload, ...counts, updatedByUserId: req.auth.userId } });
    return res.json({ ok: true, snapshot: updated });
  } catch (err) {
    return res.status(500).json({ ok: false, code: "VAULT_UNSORTED_MARK_SORTED_FAILED", error: err?.message || "Failed" });
  }
});

module.exports = router;
