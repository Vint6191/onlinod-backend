const express = require("express");
const { z } = require("zod");
const prisma = require("../prisma");
const { authRequired } = require("../middleware/auth");
const { updateObservationFromHeartbeat, recordRealtimeObservationPing } = require("../services/team-observation-service");
const {
  OFFLINE_DIALOG_RECOVERY_GAP_MS,
  hasLongOfflineGap,
  scheduleOfflineDialogRecovery,
} = require("../services/dialog-offline-recovery-service");

const router = express.Router();
router.use(authRequired);

const heartbeatSchema = z.object({
  deviceId: z.string().min(3).max(160),
  deviceName: z.string().max(160).optional().nullable(),
  platform: z.string().max(80).optional().nullable(),
  appVersion: z.string().max(80).optional().nullable(),
  agencyId: z.string().optional().nullable(),
  activeAgencyId: z.string().optional().nullable(),
  accounts: z.array(z.object({
    accountId: z.string().optional().nullable(),
    creatorId: z.string().optional().nullable(),
    remoteId: z.union([z.string(), z.number()]).optional().nullable(),
    username: z.string().optional().nullable(),
    displayName: z.string().optional().nullable(),
    status: z.string().optional().nullable(),
    runtimeReady: z.boolean().optional().default(false),
    wsConnected: z.boolean().optional().default(false),
    realtimeHealthy: z.boolean().optional().default(false),
    lastWsFrameAt: z.string().datetime().optional().nullable(),
    lastRuntimeEventAt: z.string().datetime().optional().nullable(),
    backgroundMode: z.boolean().optional().default(false),
  }).passthrough()).optional().default([]),
});


async function syncDeviceCreatorBindings({ agencyId, deviceId, accounts, now = new Date() }) {
  const list = Array.isArray(accounts) ? accounts : [];
  let accepted = 0;
  let rejected = 0;
  const seenCreatorIds = [];
  const recoveryCandidates = new Map();

  for (const account of list) {
    const status = String(account?.status || "").toUpperCase();
    if (status && status !== "READY") {
      rejected += 1;
      continue;
    }

    const remoteId = account?.remoteId === undefined || account?.remoteId === null ? null : String(account.remoteId);
    const username = account?.username ? String(account.username).replace(/^@/, "") : null;
    const candidateIds = [account?.creatorId, account?.backendCreatorId, account?.accountId]
      .map((value) => String(value || "").trim())
      .filter(Boolean);

    const or = [];
    if (candidateIds.length) or.push({ id: { in: candidateIds } });
    if (remoteId) or.push({ remoteId });
    if (username) or.push({ username });

    if (!or.length) {
      rejected += 1;
      continue;
    }

    const creator = await prisma.creatorAccount.findFirst({
      where: { agencyId, deletedAt: null, OR: or },
      select: { id: true },
    });

    if (!creator) {
      rejected += 1;
      continue;
    }

    // DeviceCreatorBinding.lastSeenAt means the Chromium/API execution context
    // can claim work. It is not proof that WebSocket observation was healthy.
    // Dialog recovery is therefore based only on the durable realtime
    // observation timestamp, and only when a healthy listener comes back.
    if (account?.realtimeHealthy === true) {
      const observation = await prisma.teamObservationState.findUnique({
        where: { agencyId_creatorId: { agencyId, creatorId: creator.id } },
        select: { lastRealtimeEventAt: true },
      }).catch(() => null);
      const lastCoveredAt = observation?.lastRealtimeEventAt || null;
      if (hasLongOfflineGap(lastCoveredAt, now, OFFLINE_DIALOG_RECOVERY_GAP_MS)) {
        recoveryCandidates.set(creator.id, { creatorId: creator.id, lastCoveredAt });
      }
    }

    await prisma.deviceCreatorBinding.upsert({
      where: { deviceId_creatorId: { deviceId, creatorId: creator.id } },
      create: {
        deviceId,
        creatorId: creator.id,
        agencyId,
        status: "ACTIVE",
        remoteId,
        username,
        lastSeenAt: now,
      },
      update: {
        status: "ACTIVE",
        remoteId,
        username,
        lastSeenAt: now,
      },
    });

    seenCreatorIds.push(creator.id);
    accepted += 1;
  }

  // Mark bindings not seen in this heartbeat as stale instead of deleting.
  await prisma.deviceCreatorBinding.updateMany({
    where: {
      agencyId,
      deviceId,
      ...(seenCreatorIds.length ? { creatorId: { notIn: seenCreatorIds } } : {}),
    },
    data: { status: "STALE" },
  });

  return {
    accepted,
    rejected,
    visibleCreatorIds: seenCreatorIds,
    recoveryCandidates: [...recoveryCandidates.values()],
  };
}

router.post("/heartbeat", async (req, res) => {
  try {
    const input = heartbeatSchema.parse(req.body || {});
    const agencyId = input.agencyId || input.activeAgencyId || req.auth.agencyId;

    if (agencyId !== req.auth.agencyId) {
      const member = await prisma.agencyMember.findFirst({
        where: { userId: req.auth.userId, agencyId, agency: { deletedAt: null } },
      });

      if (!member) {
        return res.status(403).json({ ok: false, code: "DEVICE_AGENCY_FORBIDDEN", error: "User has no access to this agency" });
      }
    }

    const device = await prisma.workerDevice.upsert({
      where: { id: input.deviceId },
      create: {
        id: input.deviceId,
        agencyId,
        userId: req.auth.userId,
        deviceName: input.deviceName || null,
        platform: input.platform || null,
        appVersion: input.appVersion || null,
        lastSeenAt: new Date(),
      },
      update: {
        agencyId,
        userId: req.auth.userId,
        deviceName: input.deviceName || undefined,
        platform: input.platform || undefined,
        appVersion: input.appVersion || undefined,
        lastSeenAt: new Date(),
      },
    });

    const heartbeatAt = new Date();
    const bindings = await syncDeviceCreatorBindings({
      agencyId,
      deviceId: input.deviceId,
      accounts: input.accounts,
      now: heartbeatAt,
    });

    const dialogRecovery = [];
    for (const candidate of bindings.recoveryCandidates || []) {
      try {
        dialogRecovery.push(await scheduleOfflineDialogRecovery({
          agencyId,
          creatorId: candidate.creatorId,
          lastCoveredAt: candidate.lastCoveredAt,
          now: heartbeatAt,
        }));
      } catch (error) {
        console.warn("[devices/heartbeat] offline dialog recovery scheduling failed:", {
          creatorId: candidate.creatorId,
          error: error?.message || String(error),
        });
        dialogRecovery.push({
          ok: false,
          created: false,
          creatorId: candidate.creatorId,
          reason: "recovery_schedule_failed",
          error: error?.message || String(error),
        });
      }
    }

    const realtimeAccounts = input.accounts.filter((account) => account?.realtimeHealthy === true);
    let observation = null;
    try {
      // Notification catch-up and dialog recovery use the same truthful
      // realtime coverage set. A merely loaded/authenticated tab no longer
      // masks a dead WebSocket.
      observation = await updateObservationFromHeartbeat({
        agencyId,
        deviceId: input.deviceId,
        accounts: realtimeAccounts,
      });
      const realtimePings = [];
      for (const account of realtimeAccounts) {
        realtimePings.push(await recordRealtimeObservationPing({
          agencyId,
          deviceId: input.deviceId,
          account,
          now: heartbeatAt,
        }));
      }
      observation.realtimeHealthy = realtimePings.filter((item) => item?.ok).length;
    } catch (err) {
      console.warn("[devices/heartbeat] observation update failed:", err?.message || err);
      observation = { ok: false, code: "OBSERVATION_UPDATE_FAILED" };
    }

    const commands = await prisma.deviceCommand.findMany({
      where: {
        deviceId: input.deviceId,
        agencyId,
        deliveredAt: null,
      },
      orderBy: { createdAt: "asc" },
      take: 50,
    });

    if (commands.length) {
      await prisma.deviceCommand.updateMany({
        where: { id: { in: commands.map((item) => item.id) } },
        data: { deliveredAt: new Date() },
      });
    }

    const forceLogout = commands.some((item) => item.command === "FORCE_LOGOUT");
    const revokedCreatorIds = [];
    const revokedPartitions = [];

    for (const command of commands) {
      const payload = command.payload && typeof command.payload === "object" ? command.payload : {};
      if (Array.isArray(payload.creatorIds)) revokedCreatorIds.push(...payload.creatorIds.map(String));
      if (Array.isArray(payload.partitions)) revokedPartitions.push(...payload.partitions.map(String));
    }

    return res.json({
      ok: true,
      device,
      bindings: {
        accepted: bindings.accepted,
        rejected: bindings.rejected,
        visibleCreatorIds: bindings.visibleCreatorIds,
      },
      dialogRecovery,
      forceLogout,
      revokedCreatorIds: Array.from(new Set(revokedCreatorIds)),
      revokedPartitions: Array.from(new Set(revokedPartitions)),
      commands,
      observation,
      permissionsVersion: Date.now(),
    });
  } catch (err) {
    if (err?.issues) {
      return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: err.issues[0]?.message || "Validation error", issues: err.issues });
    }

    console.error("[devices/heartbeat] failed:", err);
    return res.status(500).json({ ok: false, code: "DEVICE_HEARTBEAT_FAILED", error: "Device heartbeat failed" });
  }
});

const realtimePingSchema = z.object({
  deviceId: z.string().min(3).max(160),
  agencyId: z.string().optional().nullable(),
  activeAgencyId: z.string().optional().nullable(),
  accountId: z.string().optional().nullable(),
  creatorId: z.string().optional().nullable(),
  backendCreatorId: z.string().optional().nullable(),
  remoteId: z.union([z.string(), z.number()]).optional().nullable(),
  username: z.string().optional().nullable(),
  displayName: z.string().optional().nullable(),
}).passthrough();

router.post("/realtime-ping", async (req, res) => {
  try {
    const input = realtimePingSchema.parse(req.body || {});
    const agencyId = input.agencyId || input.activeAgencyId || req.auth.agencyId;

    const device = await prisma.workerDevice.findUnique({ where: { id: input.deviceId } });
    if (!device || device.userId !== req.auth.userId || device.agencyId !== agencyId) {
      return res.status(403).json({ ok: false, code: "NOT_YOUR_DEVICE", error: "Invalid device" });
    }

    const result = await recordRealtimeObservationPing({
      agencyId,
      deviceId: input.deviceId,
      account: input,
    });

    return res.json(result);
  } catch (err) {
    if (err?.issues) {
      return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: err.issues[0]?.message || "Validation error", issues: err.issues });
    }
    console.error("[devices/realtime-ping] failed:", err);
    return res.status(500).json({ ok: false, code: "REALTIME_PING_FAILED", error: "Realtime ping failed" });
  }
});

router.post("/commands/:id/ack", async (req, res) => {
  try {
    const command = await prisma.deviceCommand.findUnique({ where: { id: req.params.id } });
    if (!command) return res.status(404).json({ ok: false, code: "COMMAND_NOT_FOUND", error: "Command not found" });

    const device = await prisma.workerDevice.findFirst({
      where: { id: command.deviceId, userId: req.auth.userId },
    });

    if (!device) return res.status(403).json({ ok: false, code: "COMMAND_FORBIDDEN", error: "Command does not belong to this device" });

    const updated = await prisma.deviceCommand.update({
      where: { id: command.id },
      data: {
        ackedAt: new Date(),
        result: req.body?.result || {},
      },
    });

    return res.json({ ok: true, command: updated });
  } catch (err) {
    console.error("[devices/commands/ack] failed:", err);
    return res.status(500).json({ ok: false, code: "COMMAND_ACK_FAILED", error: "Command ack failed" });
  }
});

router.get("/mine", async (req, res) => {
  try {
    const agencyId = String(req.query.agencyId || req.auth.agencyId || "");
    if (!agencyId) return res.status(400).json({ ok: false, code: "NO_AGENCY", error: "Agency is missing" });
    if (agencyId !== req.auth.agencyId) return res.status(403).json({ ok: false, code: "DEVICE_AGENCY_FORBIDDEN", error: "No access to agency" });

    const devices = await prisma.workerDevice.findMany({
      where: { agencyId },
      orderBy: { lastSeenAt: "desc" },
      include: {
        creatorBindings: {
          include: { creator: { select: { id: true, displayName: true, username: true, status: true, avatarUrl: true } } },
          orderBy: { updatedAt: "desc" },
        },
      },
      take: 10000});

    return res.json({ ok: true, devices });
  } catch (err) {
    console.error("[devices/mine] failed:", err);
    return res.status(500).json({ ok: false, code: "DEVICES_MINE_FAILED", error: "Failed to load devices" });
  }
});

module.exports = router;
