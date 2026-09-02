const express = require("express");
const { z } = require("zod");
const prisma = require("../prisma");
const { authRequired, requireAuthDevice } = require("../middleware/auth");
const { allowedCreatorScope } = require("../middleware/automation-permissions");
const { updateObservationFromHeartbeat, recordRealtimeObservationPing, realtimeFrameSampleAt } = require("../services/team-observation-service");
const {
  OFFLINE_DIALOG_RECOVERY_GAP_MS,
  hasLongOfflineGap,
  hasRealtimeCoverageClockSkew,
  scheduleOfflineDialogRecovery,
  shouldPreserveRealtimeCoverage,
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
    accessEpoch: z.number().int().min(0).optional().nullable(),
    sessionReadReady: z.boolean().optional().default(false),
    sessionWriteReady: z.boolean().optional().default(false),
    pageLocalReady: z.boolean().optional().default(false),
    browserMaterialized: z.boolean().optional().default(false),
    browserPresentable: z.boolean().optional().default(false),
    sessionProofEpoch: z.number().int().min(0).optional().nullable(),
    canonicalRevision: z.number().int().min(0).optional().nullable(),
    networkRevision: z.number().int().min(0).optional().nullable(),
    runtimeReady: z.boolean().optional().default(false),
    wsConnected: z.boolean().optional().default(false),
    realtimeHealthy: z.boolean().optional().default(false),
    lastWsFrameAt: z.string().datetime().optional().nullable(),
    lastRuntimeEventAt: z.string().datetime().optional().nullable(),
    backgroundMode: z.boolean().optional().default(false),
  }).passthrough()).optional().default([]),
});


async function syncDeviceCreatorBindings({ agencyId, deviceId, accounts, allowedCreatorIds = null, now = new Date() }) {
  const list = Array.isArray(accounts) ? accounts : [];
  let accepted = 0;
  let rejected = 0;
  const seenCreatorIds = [];
  const recoveryCandidates = new Map();
  const resolvedAccounts = [];

  for (const account of list) {
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
      where: { agencyId, deletedAt: null, status: "READY", OR: or },
      select: { id: true },
    });

    if (!creator || (allowedCreatorIds && !allowedCreatorIds.has(creator.id))) {
      rejected += 1;
      continue;
    }

    const sessionReadReady = account?.sessionReadReady === true;
    const sessionWriteReady = sessionReadReady && account?.sessionWriteReady === true;
    const realtimeReady = account?.realtimeHealthy === true;
    const pageLocalReady = account?.pageLocalReady === true;
    const browserMaterialized = account?.browserMaterialized === true;
    const browserPresentable = browserMaterialized && account?.browserPresentable === true;
    const accessEpoch = Number.isInteger(Number(account?.accessEpoch)) ? Number(account.accessEpoch) : null;
    const sessionProofEpoch = Number.isInteger(Number(account?.sessionProofEpoch)) ? Number(account.sessionProofEpoch) : null;
    const canonicalRevision = Number.isInteger(Number(account?.canonicalRevision)) ? Number(account.canonicalRevision) : null;
    const networkRevision = Number.isInteger(Number(account?.networkRevision)) ? Number(account.networkRevision) : null;

    // DeviceCreatorBinding is device presence plus capability telemetry. It is
    // never creator-access authority; allowedCreatorIds was resolved from the
    // current AgencyMember before this function was called. Realtime coverage
    // is still based only on the durable inbound-frame observation timestamp,
    // observation timestamp, and only when a healthy listener comes back.
    const realtimeFrameAt = account?.realtimeHealthy === true
      ? realtimeFrameSampleAt(account, now)
      : null;
    if (realtimeFrameAt) {
      const observation = await prisma.teamObservationState.findUnique({
        where: { agencyId_creatorId: { agencyId, creatorId: creator.id } },
        select: { lastRealtimeEventAt: true },
      }).catch(() => null);
      const lastCoveredAt = observation?.lastRealtimeEventAt || null;
      if (!lastCoveredAt
        || hasLongOfflineGap(lastCoveredAt, now, OFFLINE_DIALOG_RECOVERY_GAP_MS)
        || hasRealtimeCoverageClockSkew(lastCoveredAt, now)) {
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
        accessEpoch,
        sessionReadReady,
        sessionWriteReady,
        realtimeReady,
        pageLocalReady,
        browserMaterialized,
        browserPresentable,
        sessionProofEpoch,
        canonicalRevision,
        networkRevision,
        lastCapabilityAt: now,
        lastSeenAt: now,
      },
      update: {
        status: "ACTIVE",
        remoteId,
        username,
        accessEpoch,
        sessionReadReady,
        sessionWriteReady,
        realtimeReady,
        pageLocalReady,
        browserMaterialized,
        browserPresentable,
        sessionProofEpoch,
        canonicalRevision,
        networkRevision,
        lastCapabilityAt: now,
        lastSeenAt: now,
      },
    });

    seenCreatorIds.push(creator.id);
    resolvedAccounts.push({
      creatorId: creator.id,
      account: {
        ...account,
        creatorId: creator.id,
        backendCreatorId: creator.id,
        sessionReadReady,
        sessionWriteReady,
        realtimeHealthy: Boolean(realtimeFrameAt),
        pageLocalReady,
        browserMaterialized,
        browserPresentable,
        lastWsFrameAt: realtimeFrameAt?.toISOString() || null,
      },
    });
    accepted += 1;
  }

  // Mark bindings not seen in this heartbeat as stale instead of deleting.
  await prisma.deviceCreatorBinding.updateMany({
    where: {
      agencyId,
      deviceId,
      ...(seenCreatorIds.length ? { creatorId: { notIn: seenCreatorIds } } : {}),
    },
    data: {
      status: "STALE",
      sessionReadReady: false,
      sessionWriteReady: false,
      realtimeReady: false,
      pageLocalReady: false,
      browserMaterialized: false,
      browserPresentable: false,
    },
  });

  return {
    accepted,
    rejected,
    visibleCreatorIds: seenCreatorIds,
    recoveryCandidates: [...recoveryCandidates.values()],
    resolvedAccounts,
  };
}

router.post("/heartbeat", async (req, res) => {
  try {
    const input = heartbeatSchema.parse(req.body || {});
    const boundDeviceId = requireAuthDevice(req, input.deviceId, {
      requiredCode: "DEVICE_BOUND_TOKEN_REQUIRED",
      mismatchCode: "DEVICE_IDENTITY_MISMATCH",
    });
    const agencyId = input.agencyId || input.activeAgencyId || req.auth.agencyId;

    let heartbeatMembership = req.auth.membership;
    if (agencyId !== req.auth.agencyId) {
      heartbeatMembership = await prisma.agencyMember.findFirst({
        where: { userId: req.auth.userId, agencyId, deletedAt: null, deactivatedAt: null, agency: { deletedAt: null } },
      });

      if (!heartbeatMembership) {
        return res.status(403).json({ ok: false, code: "DEVICE_AGENCY_FORBIDDEN", error: "User has no access to this agency" });
      }
    }

    const creatorScope = await allowedCreatorScope({ agencyId, member: heartbeatMembership });
    const allowedCreatorIds = creatorScope.broad ? null : new Set(creatorScope.creatorIds);

    const device = await prisma.workerDevice.upsert({
      where: { id: boundDeviceId },
      create: {
        id: boundDeviceId,
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
      deviceId: boundDeviceId,
      accounts: input.accounts,
      allowedCreatorIds,
      now: heartbeatAt,
    });

    const dialogRecovery = [];
    const recoveryDecisions = new Map();
    for (const candidate of bindings.recoveryCandidates || []) {
      let result;
      try {
        result = await scheduleOfflineDialogRecovery({
          agencyId,
          creatorId: candidate.creatorId,
          lastCoveredAt: candidate.lastCoveredAt,
          now: heartbeatAt,
        });
      } catch (error) {
        console.warn("[devices/heartbeat] offline dialog recovery scheduling failed:", {
          creatorId: candidate.creatorId,
          error: error?.message || String(error),
        });
        result = {
          ok: false,
          created: false,
          creatorId: candidate.creatorId,
          reason: "recovery_schedule_failed",
          error: error?.message || String(error),
        };
      }
      recoveryDecisions.set(candidate.creatorId, result);
      dialogRecovery.push(result);
    }

    const realtimeBindings = (bindings.resolvedAccounts || [])
      .filter((entry) => entry?.account?.realtimeHealthy === true
        && Boolean(realtimeFrameSampleAt(entry.account, heartbeatAt)));
    const realtimeAccounts = realtimeBindings.map((entry) => entry.account);
    let observation = null;
    try {
      // Notification catch-up and dialog recovery use the same truthful
      // realtime coverage set. A merely loaded/authenticated tab no longer
      // masks a dead WebSocket.
      observation = await updateObservationFromHeartbeat({
        agencyId,
        deviceId: boundDeviceId,
        accounts: realtimeAccounts,
      });
      const realtimePings = [];
      for (const entry of realtimeBindings) {
        const decision = recoveryDecisions.get(entry.creatorId) || null;
        realtimePings.push(await recordRealtimeObservationPing({
          agencyId,
          deviceId: boundDeviceId,
          account: entry.account,
          now: heartbeatAt,
          // lastRealtimeEventAt means contiguous, reconciled coverage. A live
          // WS can be healthy again while an older offline hole is paused,
          // cancelled, running or waiting to be scheduled. Preserve the old
          // boundary until that hole is actually settled.
          advanceRealtimeCoverage: !shouldPreserveRealtimeCoverage(decision),
        }));
      }
      observation.realtimeHealthy = realtimePings.filter((item) => item?.ok).length;
      observation.realtimeCoverageAdvanced = realtimePings.filter((item) => item?.coverageAdvanced).length;
      observation.realtimeCoverageFenced = realtimePings.filter((item) => item?.ok && !item?.coverageAdvanced).length;
    } catch (err) {
      console.warn("[devices/heartbeat] observation update failed:", err?.message || err);
      observation = { ok: false, code: "OBSERVATION_UPDATE_FAILED" };
    }

    const commands = await prisma.deviceCommand.findMany({
      where: {
        deviceId: boundDeviceId,
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

    // Revision correctness is state-based. DeviceCommand remains only a wakeup
    // hint: every successful heartbeat returns the current canonical session
    // manifest for creators that this authenticated membership may access. No
    // encrypted payload, cookie value, IV/tag or credential hash is exposed.
    const requestedCreatorIds = Array.from(new Set((input.accounts || [])
      .flatMap((account) => [account?.creatorId, account?.accountId])
      .map((value) => String(value || "").trim())
      .filter(Boolean)))
      .slice(0, 10000);
    const scopedCreatorIds = allowedCreatorIds
      ? requestedCreatorIds.filter((id) => allowedCreatorIds.has(id))
      : requestedCreatorIds;
    const manifestRows = scopedCreatorIds.length ? await prisma.creatorAccount.findMany({
      where: {
        agencyId,
        deletedAt: null,
        id: { in: scopedCreatorIds },
      },
      select: {
        id: true,
        remoteId: true,
        sessionState: {
          select: {
            status: true,
            revision: true,
            payloadVersion: true,
            platformUserId: true,
            capturedByDeviceId: true,
            updatedAt: true,
          },
        },
        networkProfile: {
          select: {
            mode: true,
            proxyEndpointId: true,
            version: true,
            updatedAt: true,
          },
        },
      },
      take: 10000,
    }) : [];
    const creatorSessions = manifestRows.map((creator) => ({
      creatorId: creator.id,
      revision: creator.sessionState?.revision || 0,
      status: creator.sessionState?.status || "MISSING",
      payloadVersion: creator.sessionState?.payloadVersion || null,
      platformUserId: creator.sessionState?.platformUserId || creator.remoteId || null,
      capturedByDeviceId: creator.sessionState?.capturedByDeviceId || null,
      updatedAt: creator.sessionState?.updatedAt || null,
    }));
    const creatorNetworks = manifestRows.map((creator) => ({
      creatorId: creator.id,
      mode: creator.networkProfile?.mode || "DIRECT",
      version: creator.networkProfile?.version || 0,
      proxyEndpointId: creator.networkProfile?.proxyEndpointId || null,
      updatedAt: creator.networkProfile?.updatedAt || null,
    }));

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
      creatorSessions,
      creatorNetworks,
      commands,
      observation,
      permissionsVersion: Date.now(),
    });
  } catch (err) {
    if (err?.issues) {
      return res.status(400).json({ ok: false, code: "VALIDATION_ERROR", error: err.issues[0]?.message || "Validation error", issues: err.issues });
    }
    if (err?.status) {
      return res.status(Number(err.status) || 403).json({ ok: false, code: err.code || "DEVICE_HEARTBEAT_FORBIDDEN", error: err.message || "Device heartbeat forbidden" });
    }

    console.error("[devices/heartbeat] failed:", err);
    return res.status(500).json({ ok: false, code: "DEVICE_HEARTBEAT_FAILED", error: "Device heartbeat failed" });
  }
});

// Legacy endpoint intentionally cannot mutate realtime coverage. Older builds
// used it as a blind keepalive and could erase a creator-wide offline gap even
// while dialog recovery was paused or fenced. Current desktop builds report
// truthful WS health only through /heartbeat.
router.post("/realtime-ping", (_req, res) => res.status(410).json({
  ok: false,
  code: "REALTIME_PING_DEPRECATED",
  error: "Use device heartbeat with truthful realtime health",
}));

router.post("/commands/:id/ack", async (req, res) => {
  try {
    const command = await prisma.deviceCommand.findUnique({ where: { id: req.params.id } });
    if (!command) return res.status(404).json({ ok: false, code: "COMMAND_NOT_FOUND", error: "Command not found" });

    requireAuthDevice(req, command.deviceId, {
      requiredCode: "DEVICE_BOUND_TOKEN_REQUIRED",
      mismatchCode: "DEVICE_IDENTITY_MISMATCH",
    });

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

router.get("/mine", (_req, res) => res.status(410).json({
  ok: false,
  code: "DEVICE_INVENTORY_GONE",
  error: "Agency-wide customer device inventory is retired; use signed device heartbeat/runtime surfaces",
}));

module.exports = router;
