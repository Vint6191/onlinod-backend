const express = require("express");
const crypto = require("node:crypto");
const { z } = require("zod");

const prisma = require("../prisma");
const { authRequired } = require("../middleware/auth");
const { encryptSnapshot, hashUserAgent } = require("../services/snapshot-crypto");

const router = express.Router();

// DEV-ONLY in-memory migration sessions.
// Purpose: authenticated web starts migration, Electron completes it by token.
// No raw cookies are pasted into browser/clipboard.
const devMigrationSessions = new Map();

function createDevMigrationToken({ agencyId, userId }) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + 10 * 60 * 1000;

  devMigrationSessions.set(token, {
    agencyId,
    userId,
    expiresAt,
    createdAt: Date.now(),
    status: "PENDING",
    result: null,
    error: null,
    completedAt: null,
  });

  return { token, expiresAt };
}

function getDevMigrationSession(token) {
  const clean = String(token || "").trim();
  if (!clean) return null;

  const session = devMigrationSessions.get(clean);
  if (!session) return null;

  if (session.expiresAt < Date.now()) {
    session.status = session.status === "COMPLETED" ? session.status : "EXPIRED";
    session.error = session.error || "Migration token expired";
    return session;
  }

  return session;
}

function consumeDevMigrationToken(token) {
  const session = getDevMigrationSession(token);
  if (!session) return null;

  if (session.status === "EXPIRED" || session.status === "COMPLETED") {
    return null;
  }

  session.status = "RUNNING";
  session.startedAt = Date.now();
  return session;
}

function finishDevMigrationToken(token, result) {
  const session = devMigrationSessions.get(String(token || "").trim());
  if (!session) return;

  session.status = result?.ok ? "COMPLETED" : "FAILED";
  session.result = result || null;
  session.error = result?.ok ? null : result?.error || "Migration failed";
  session.completedAt = Date.now();
}

function failDevMigrationToken(token, err) {
  const session = devMigrationSessions.get(String(token || "").trim());
  if (!session) return;

  session.status = "FAILED";
  session.error = String(err?.message || err || "Migration failed");
  session.result = {
    ok: false,
    error: session.error,
  };
  session.completedAt = Date.now();
}

async function importCreatorsIntoAgency({ agencyId, userId, creators, includeSnapshots = true }) {
  const results = [];

  for (const raw of creators) {
    const item = normalizeCreator(raw);

    const result = await prisma.$transaction(async (tx) => {
      const existing = await findExistingCreator({
        agencyId,
        remoteId: item.remoteId,
        username: item.username,
        partition: item.partition,
      });

      if (existing) {
        const updated = await tx.creatorAccount.update({
          where: { id: existing.id },
          data: {
            displayName: item.displayName || existing.displayName,
            username: item.username || existing.username,
            remoteId: item.remoteId || existing.remoteId,
            avatarUrl: item.avatarUrl || existing.avatarUrl,
            partition: item.partition || existing.partition,
            status: item.status || existing.status,
},
        });

        const snapshotRecord =
          includeSnapshots && item.snapshot
            ? await saveImportedSnapshot({
                tx,
                agencyId,
                userId,
                creator: updated,
                snapshot: item.snapshot,
              })
            : null;

        return {
          action: "updated",
          creator: updated,
          snapshotId: snapshotRecord?.id || null,
          snapshotImported: !!snapshotRecord,
          matchedBy:
            item.remoteId && existing.remoteId === item.remoteId
              ? "remoteId"
              : item.username && existing.username?.toLowerCase() === item.username.toLowerCase()
              ? "username"
              : "partition",
          localId: item.localId,
        };
      }

      const created = await tx.creatorAccount.create({
        data: {
          agencyId,
          displayName: item.displayName,
          username: item.username,
          remoteId: item.remoteId,
          avatarUrl: item.avatarUrl,
          partition: item.partition,
          status: item.status,
},
      });

      const snapshotRecord =
        includeSnapshots && item.snapshot
          ? await saveImportedSnapshot({
              tx,
              agencyId,
              userId,
              creator: created,
              snapshot: item.snapshot,
            })
          : null;

      return {
        action: "created",
        creator: created,
        snapshotId: snapshotRecord?.id || null,
        snapshotImported: !!snapshotRecord,
        matchedBy: null,
        localId: item.localId,
      };
    });

    results.push(result);
  }

  return {
    ok: true,
    imported: results.length,
    created: results.filter((x) => x.action === "created").length,
    updated: results.filter((x) => x.action === "updated").length,
    snapshotsImported: results.filter((x) => x.snapshotImported).length,
    results,
  };
}


const cookieSchema = z.object({
  name: z.string(),
  value: z.string(),
  domain: z.string().optional().nullable(),
  path: z.string().optional().nullable(),
  secure: z.boolean().optional().nullable(),
  httpOnly: z.boolean().optional().nullable(),
  sameSite: z.any().optional().nullable(),
  session: z.boolean().optional().nullable(),
  expirationDate: z.number().optional().nullable(),
});

const snapshotSchema = z.object({
  snapshotId: z.string().optional().nullable(),
  type: z.string().optional().nullable(),
  accountId: z.string().optional().nullable(),
  createdAt: z.union([z.string(), z.number()]).optional().nullable(),
  remoteId: z.union([z.string(), z.number()]).optional().nullable(),
  username: z.string().optional().nullable(),
  displayName: z.string().optional().nullable(),
  userAgent: z.string().optional().nullable(),
  cookies: z.array(cookieSchema).optional().default([]),
  storage: z.any().optional().nullable(),
});

const importedCreatorSchema = z.object({
  id: z.string().max(180).optional().nullable(),
  name: z.string().max(160).optional().nullable(),
  displayName: z.string().max(160).optional().nullable(),
  username: z.string().max(160).optional().nullable(),
  remoteId: z.union([z.string(), z.number()]).optional().nullable(),
  avatar: z.string().max(2000).optional().nullable(),
  avatarUrl: z.string().max(2000).optional().nullable(),
  header: z.string().max(2000).optional().nullable(),
  partition: z.string().max(260).optional().nullable(),
  status: z.string().max(80).optional().nullable(),
  chatMessagesCount: z.union([z.string(), z.number()]).optional().nullable(),
  subscribersCount: z.union([z.string(), z.number()]).optional().nullable(),
  createdAt: z.union([z.string(), z.number()]).optional().nullable(),
  updatedAt: z.union([z.string(), z.number()]).optional().nullable(),

  // DEV MIGRATION ONLY:
  // Exported by Electron from current local partitions.
  // Backend will encrypt and store as AccessSnapshot.
  snapshot: snapshotSchema.optional().nullable(),
});

const importSchema = z.object({
  creators: z.array(importedCreatorSchema).min(1).max(200),
  includeSnapshots: z.boolean().optional().default(false),
});

function toNullableString(value) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function toNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function normalizeStatus(value, hasSnapshot = false) {
  const raw = String(value || "").trim().toLowerCase();

  if (raw === "ready" || raw === "creator" || raw === "connected") return "READY";
  if (raw === "not_creator" || raw === "not creator") return "NOT_CREATOR";
  if (raw === "auth_failed" || raw === "auth failed") return "AUTH_FAILED";
  if (raw === "disabled") return "DISABLED";

  return hasSnapshot ? "READY" : "DRAFT";
}

function normalizeCreator(input) {
  const snapshot = input.snapshot || null;
  const remoteId =
    toNullableString(input.remoteId) ||
    toNullableString(snapshot?.remoteId);

  const username =
    (toNullableString(input.username) ||
      toNullableString(snapshot?.username) ||
      null)?.replace(/^@+/, "") || null;

  const displayName =
    toNullableString(input.displayName) ||
    toNullableString(input.name) ||
    toNullableString(snapshot?.displayName) ||
    username ||
    remoteId ||
    "Creator";

  const hasSnapshotCookies =
    Array.isArray(snapshot?.cookies) &&
    snapshot.cookies.length > 0;

  return {
    localId: toNullableString(input.id),
    remoteId,
    username,
    displayName,
    avatarUrl: toNullableString(input.avatarUrl) || toNullableString(input.avatar),
    headerUrl: toNullableString(input.header),
    partition: toNullableString(input.partition),
    status: normalizeStatus(input.status, hasSnapshotCookies),
    // Metrics are intentionally not written into CreatorAccount here.
    // Current Prisma schema stores identity/access on CreatorAccount;
    // runtime metrics can be stored separately later.
    unreadCount: toNumber(input.chatMessagesCount),
    subscribersCount: toNumber(input.subscribersCount),
    snapshot,
    hasSnapshotCookies,
  };
}

async function findExistingCreator({ agencyId, remoteId, username, partition }) {
  if (remoteId) {
    const byRemoteId = await prisma.creatorAccount.findFirst({
      where: { agencyId, remoteId },
    });
    if (byRemoteId) return byRemoteId;
  }

  if (username) {
    const byUsername = await prisma.creatorAccount.findFirst({
      where: {
        agencyId,
        username: {
          equals: username,
          mode: "insensitive",
        },
      },
    });
    if (byUsername) return byUsername;
  }

  if (partition) {
    const byPartition = await prisma.creatorAccount.findFirst({
      where: { agencyId, partition },
    });
    if (byPartition) return byPartition;
  }

  return null;
}

function sanitizeSnapshotForEncryption({ snapshot, creator, agencyId }) {
  const cookies = Array.isArray(snapshot?.cookies) ? snapshot.cookies : [];

  return {
    type: "of_access",
    migratedFrom: "electron_local_dev_import",
    localSnapshotId: snapshot?.snapshotId || null,
    localAccountId: snapshot?.accountId || null,
    agencyId,
    creatorId: creator.id,
    remoteId: snapshot?.remoteId || creator.remoteId || null,
    username: snapshot?.username || creator.username || null,
    displayName: snapshot?.displayName || creator.displayName || null,
    userAgent: snapshot?.userAgent || null,
    cookies,
    storage: snapshot?.storage || null,
    capturedAt: new Date().toISOString(),
    localCreatedAt: snapshot?.createdAt || null,
  };
}

async function saveImportedSnapshot({ tx, agencyId, userId, creator, snapshot }) {
  const cookies = Array.isArray(snapshot?.cookies) ? snapshot.cookies : [];
  if (!cookies.length) return null;

  const payload = sanitizeSnapshotForEncryption({
    snapshot,
    creator,
    agencyId,
  });

  const encrypted = encryptSnapshot(payload);

  await tx.accessSnapshot.updateMany({
    where: {
      agencyId,
      creatorId: creator.id,
      active: true,
    },
    data: {
      active: false,
      revokedAt: new Date(),
    },
  });

  return tx.accessSnapshot.create({
    data: {
      agencyId,
      creatorId: creator.id,
      createdByUserId: userId,
      deviceId: "dev-local-migration",
      encryptedPayload: encrypted.encryptedPayload,
      iv: encrypted.iv,
      tag: encrypted.tag,
      algorithm: encrypted.algorithm,
      payloadVersion: encrypted.payloadVersion,
      userAgentHash: hashUserAgent(snapshot.userAgent),
      remoteId: snapshot.remoteId || creator.remoteId || null,
      username: snapshot.username || creator.username || null,
      active: true,
    },
  });
}

router.post("/import-local", authRequired, async (req, res) => {
  try {
    const input = importSchema.parse(req.body);
    const result = await importCreatorsIntoAgency({
      agencyId: req.auth.agencyId,
      userId: req.auth.userId,
      creators: input.creators,
      includeSnapshots: input.includeSnapshots !== false,
    });

    return res.json(result);
  } catch (err) {
    try {
      failDevMigrationToken(req.body?.token, err);
    } catch (_) {}

    if (err?.issues) {
      return res.status(400).json({
        ok: false,
        code: "VALIDATION_ERROR",
        error: err.issues?.[0]?.message || "Validation error",
        issues: err.issues,
      });
    }

    console.error("[creators/import-local] failed:", err);

    return res.status(500).json({
      ok: false,
      code: "CREATOR_IMPORT_FAILED",
      error: err?.message || "Failed to import local creators",
    });
  }
});

router.post("/import-local/start-auto", authRequired, async (req, res) => {
  try {
    const { token, expiresAt } = createDevMigrationToken({
      agencyId: req.auth.agencyId,
      userId: req.auth.userId,
    });

    return res.json({
      ok: true,
      token,
      expiresAt,
      migrateUrl: `onlinod://migrate-local?token=${encodeURIComponent(token)}`,
    });
  } catch (err) {
    console.error("[creators/import-local/start-auto] failed:", err);
    return res.status(500).json({
      ok: false,
      code: "MIGRATION_START_FAILED",
      error: err?.message || "Failed to start local migration",
    });
  }
});


router.get("/import-local/status-auto", authRequired, async (req, res) => {
  try {
    const token = String(req.query?.token || "").trim();
    const session = getDevMigrationSession(token);

    if (!session) {
      return res.status(404).json({
        ok: false,
        code: "MIGRATION_SESSION_NOT_FOUND",
        error: "Migration session not found",
      });
    }

    if (session.agencyId !== req.auth.agencyId || session.userId !== req.auth.userId) {
      return res.status(403).json({
        ok: false,
        code: "FORBIDDEN",
        error: "Migration session belongs to another user/workspace",
      });
    }

    return res.json({
      ok: true,
      status: session.status,
      expiresAt: session.expiresAt,
      createdAt: session.createdAt,
      startedAt: session.startedAt || null,
      completedAt: session.completedAt || null,
      result: session.result || null,
      error: session.error || null,
    });
  } catch (err) {
    console.error("[creators/import-local/status-auto] failed:", err);
    return res.status(500).json({
      ok: false,
      code: "MIGRATION_STATUS_FAILED",
      error: err?.message || "Failed to read migration status",
    });
  }
});

router.post("/import-local/complete-auto", async (req, res) => {
  try {
    const token = String(req.body?.token || "").trim();
    const session = consumeDevMigrationToken(token);

    if (!session) {
      return res.status(401).json({
        ok: false,
        code: "MIGRATION_TOKEN_INVALID",
        error: "Invalid or expired migration token",
      });
    }

    const input = importSchema.parse({
      creators: req.body?.creators || [],
      includeSnapshots: req.body?.includeSnapshots !== false,
    });

    const result = await importCreatorsIntoAgency({
      agencyId: session.agencyId,
      userId: session.userId,
      creators: input.creators,
      includeSnapshots: input.includeSnapshots !== false,
    });

    const response = {
      ...result,
      mode: "auto_dev_migration",
    };

    finishDevMigrationToken(token, response);

    return res.json(response);
  } catch (err) {
    if (err?.issues) {
      return res.status(400).json({
        ok: false,
        code: "VALIDATION_ERROR",
        error: err.issues?.[0]?.message || "Validation error",
        issues: err.issues,
      });
    }

    console.error("[creators/import-local/complete-auto] failed:", err);

    return res.status(500).json({
      ok: false,
      code: "MIGRATION_COMPLETE_FAILED",
      error: err?.message || "Failed to complete local migration",
    });
  }
});

module.exports = router;
