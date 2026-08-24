const express = require("express");

const prisma = require("../prisma");
const { authRequired, requireAuthDevice } = require("../middleware/auth");
const { requireCreatorAccess } = require("../middleware/automation-permissions");
const { decryptSnapshot } = require("../services/snapshot-crypto");
const { audit } = require("../services/audit-service");
const { assertLegacyAccessSnapshotReadable, cryptoShredLegacyAccessSnapshotById } = require("../services/legacy-access-snapshot-policy");

const router = express.Router();

router.use(authRequired);

router.get("/creators/:creatorId/access-snapshots", async (req, res) => {
  try {
    const creator = await requireCreatorAccess({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      creatorId: req.params.creatorId,
      db: prisma,
    });

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
        payloadRetiredAt: true,
        createdAt: true,
        deviceId: true,
      },
      take: 10000});

    return res.json({ ok: true, snapshots });
  } catch (err) {
    if (Number(err?.status || 0) >= 500) console.error("[access-snapshots/list] failed:", err);
    return res.status(Number(err?.status) || 500).json({ ok: false, code: err?.code || "SNAPSHOTS_LIST_FAILED", error: err?.message || "Failed to list snapshots" });
  }
});

router.get("/access-snapshots/:id/payload", async (req, res) => {
  try {
    const snapshot = await prisma.accessSnapshot.findFirst({
      where: {
        id: req.params.id,
        agencyId: req.auth.agencyId,
      },
      select: { id: true, creatorId: true },
    });

    if (!snapshot) {
      return res.status(404).json({ ok: false, code: "SNAPSHOT_NOT_FOUND", error: "Snapshot not found" });
    }

    await requireCreatorAccess({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      creatorId: snapshot.creatorId,
      db: prisma,
    });
    requireAuthDevice(req, req.auth.deviceId, {
      requiredCode: "ACCESS_SNAPSHOT_DEVICE_BOUND_TOKEN_REQUIRED",
      mismatchCode: "ACCESS_SNAPSHOT_AUTH_DEVICE_MISMATCH",
    });
    await assertLegacyAccessSnapshotReadable({ db: prisma, agencyId: req.auth.agencyId });

    // Authorization may involve DB work and can race revocation/enforcement.
    // Never decrypt the object fetched before those gates: re-read the secret
    // state afterwards so a snapshot retired during authorization cannot leak
    // through a stale in-memory ciphertext copy.
    const currentSnapshot = await prisma.accessSnapshot.findFirst({
      where: { id: snapshot.id, agencyId: req.auth.agencyId },
    });
    if (!currentSnapshot) {
      return res.status(404).json({ ok: false, code: "SNAPSHOT_NOT_FOUND", error: "Snapshot not found" });
    }

    if (currentSnapshot.payloadRetiredAt || !currentSnapshot.encryptedPayload || !currentSnapshot.iv || !currentSnapshot.tag) {
      return res.status(410).json({ ok: false, code: "SNAPSHOT_SECRET_RETIRED", error: "Snapshot secret material has been permanently retired" });
    }

    if (!currentSnapshot.active || currentSnapshot.revokedAt) {
      return res.status(409).json({ ok: false, code: "SNAPSHOT_REVOKED", error: "Snapshot is not active" });
    }

    const payload = decryptSnapshot(currentSnapshot);

    await audit({
      agencyId: req.auth.agencyId,
      actorUserId: req.auth.userId,
      action: "access_snapshot.payload_read",
      targetType: "access_snapshot",
      targetId: currentSnapshot.id,
      metadata: {
        creatorId: currentSnapshot.creatorId,
        deviceId: currentSnapshot.deviceId,
      },
    });

    return res.json({
      ok: true,
      snapshot: {
        id: currentSnapshot.id,
        creatorId: currentSnapshot.creatorId,
        createdAt: currentSnapshot.createdAt,
        active: currentSnapshot.active,
      },
      payload,
    });
  } catch (err) {
    if (Number(err?.status || 0) >= 500) console.error("[access-snapshots/payload] failed:", err);
    return res.status(Number(err?.status) || 500).json({ ok: false, code: err?.code || "SNAPSHOT_DECRYPT_FAILED", error: err?.message || "Failed to decrypt snapshot" });
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

    await requireCreatorAccess({
      agencyId: req.auth.agencyId,
      member: req.auth.membership || req.member,
      creatorId: snapshot.creatorId,
      db: prisma,
    });
    requireAuthDevice(req, req.auth.deviceId, {
      requiredCode: "ACCESS_SNAPSHOT_DEVICE_BOUND_TOKEN_REQUIRED",
      mismatchCode: "ACCESS_SNAPSHOT_AUTH_DEVICE_MISMATCH",
    });

    const retiredAt = new Date();
    const updated = await prisma.$transaction(async (tx) => {
      await cryptoShredLegacyAccessSnapshotById({
        db: tx,
        agencyId: req.auth.agencyId,
        snapshotId: snapshot.id,
        retiredAt,
      });
      return tx.accessSnapshot.findFirst({
        where: { id: snapshot.id, agencyId: req.auth.agencyId },
        select: {
          id: true,
          active: true,
          revokedAt: true,
          payloadRetiredAt: true,
          creatorId: true,
          createdAt: true,
        },
      });
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
    if (Number(err?.status || 0) >= 500) console.error("[access-snapshots/revoke] failed:", err);
    return res.status(Number(err?.status) || 500).json({ ok: false, code: err?.code || "SNAPSHOT_REVOKE_FAILED", error: err?.message || "Failed to revoke snapshot" });
  }
});

module.exports = router;
