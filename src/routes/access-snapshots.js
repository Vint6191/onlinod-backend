const express = require("express");

const prisma = require("../prisma");
const { authRequired } = require("../middleware/auth");
const { decryptSnapshot } = require("../services/snapshot-crypto");
const { audit } = require("../services/audit-service");

const router = express.Router();

router.use(authRequired);

router.get("/creators/:creatorId/access-snapshots", async (req, res) => {
  try {
    const creator = await prisma.creatorAccount.findFirst({
      where: {
        id: req.params.creatorId,
        agencyId: req.auth.agencyId,
      },
    });

    if (!creator) {
      return res.status(404).json({ ok: false, code: "CREATOR_NOT_FOUND", error: "Creator not found" });
    }

    const snapshots = await prisma.accessSnapshot.findMany({
      where: {
        creatorId: creator.id,
        agencyId: req.auth.agencyId,
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        type: true,
        payloadVersion: true,
        algorithm: true,
        userAgentHash: true,
        remoteId: true,
        username: true,
        active: true,
        expiresAt: true,
        revokedAt: true,
        createdAt: true,
        deviceId: true,
      },
    });

    return res.json({ ok: true, snapshots });
  } catch (err) {
    console.error("[access-snapshots/list] failed:", err);
    return res.status(500).json({
      ok: false,
      code: "SNAPSHOTS_LIST_FAILED",
      error: "Failed to list snapshots",
    });
  }
});

router.get("/access-snapshots/:id/payload", async (req, res) => {
  try {
    const snapshot = await prisma.accessSnapshot.findFirst({
      where: {
        id: req.params.id,
        agencyId: req.auth.agencyId,
      },
    });

    if (!snapshot) {
      return res.status(404).json({ ok: false, code: "SNAPSHOT_NOT_FOUND", error: "Snapshot not found" });
    }

    if (!snapshot.active || snapshot.revokedAt) {
      return res.status(409).json({ ok: false, code: "SNAPSHOT_REVOKED", error: "Snapshot is not active" });
    }

    const payload = decryptSnapshot(snapshot);

    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: "access_snapshot.payload_read",
      targetType: "access_snapshot",
      targetId: snapshot.id,
      metadata: {
        creatorId: snapshot.creatorId,
        deviceId: snapshot.deviceId,
      },
    });

    return res.json({
      ok: true,
      snapshot: {
        id: snapshot.id,
        creatorId: snapshot.creatorId,
        createdAt: snapshot.createdAt,
        active: snapshot.active,
      },
      payload,
    });
  } catch (err) {
    console.error("[access-snapshots/payload] failed:", err);
    return res.status(500).json({
      ok: false,
      code: "SNAPSHOT_DECRYPT_FAILED",
      error: err?.message || "Failed to decrypt snapshot",
    });
  }
});

router.post("/access-snapshots/:id/revoke", async (req, res) => {
  try {
    const snapshot = await prisma.accessSnapshot.findFirst({
      where: {
        id: req.params.id,
        agencyId: req.auth.agencyId,
      },
    });

    if (!snapshot) {
      return res.status(404).json({ ok: false, code: "SNAPSHOT_NOT_FOUND", error: "Snapshot not found" });
    }

    const updated = await prisma.accessSnapshot.update({
      where: { id: snapshot.id },
      data: {
        active: false,
        revokedAt: snapshot.revokedAt || new Date(),
      },
      select: {
        id: true,
        active: true,
        revokedAt: true,
        creatorId: true,
        createdAt: true,
      },
    });

    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: "access_snapshot.revoke",
      targetType: "access_snapshot",
      targetId: snapshot.id,
      metadata: {
        creatorId: snapshot.creatorId,
      },
    });

    return res.json({ ok: true, snapshot: updated });
  } catch (err) {
    console.error("[access-snapshots/revoke] failed:", err);
    return res.status(500).json({
      ok: false,
      code: "SNAPSHOT_REVOKE_FAILED",
      error: "Failed to revoke snapshot",
    });
  }
});

module.exports = router;
