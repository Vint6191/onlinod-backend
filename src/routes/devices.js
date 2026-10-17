const express = require("express");
const { z } = require("zod");
const prisma = require("../prisma");
const { authRequired, requireAuthDevice } = require("../middleware/auth");
const { allowedCreatorScope } = require("../middleware/automation-permissions");
const { dbAuthorityNow } = require("../services/db-time-authority-service");
const { assertCurrentAuthorizationSession } = require("../services/authorization-session-authority-service");
const { withHeartbeatMemberGeneration } = require("../services/device-heartbeat-generation-service");
const { realtimeFrameSampleAt } = require("../services/team-observation-service");


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
  }).passthrough()).max(10000).optional().default([]),
});


const syncDeviceCreatorBindings = require("../services/device-heartbeat-batch-service").syncBindings;

router.post("/heartbeat", async (req, res) => {
  try {
    const input = heartbeatSchema.parse(req.body || {});
    const boundDeviceId = requireAuthDevice(req, input.deviceId, {
      requiredCode: "DEVICE_BOUND_TOKEN_REQUIRED",
      mismatchCode: "DEVICE_IDENTITY_MISMATCH",
    });
    const agencyId = input.agencyId || input.activeAgencyId || req.auth.agencyId;

    const heartbeatAt = await dbAuthorityNow({ db: prisma, fallbackNow: new Date() });

    // Device liveness and creator capability remain different facts, but a move
    // of the device row into another agency is itself agency-scoped state. Commit
    // the device row and revision-sensitive creator capability under the same
    // current-membership generation lock. Stale reported account accessEpoch can
    // still record liveness while all creator capabilities remain false; an
    // inactive/revoked target membership cannot mutate device.agencyId at all.
    const capabilityCommit = await withHeartbeatMemberGeneration({
      agencyId,
      userId: req.auth.userId,
      memberId: agencyId === req.auth.agencyId ? (req.auth.membership?.id || null) : null,
      work: async ({ tx, member, accessEpoch }) => {
        const device = await tx.workerDevice.upsert({
          where: { id: boundDeviceId },
          create: {
            id: boundDeviceId,
            agencyId,
            userId: req.auth.userId,
            deviceName: input.deviceName || null,
            platform: input.platform || null,
            appVersion: input.appVersion || null,
            lastSeenAt: heartbeatAt,
          },
          update: {
            agencyId,
            userId: req.auth.userId,
            deviceName: input.deviceName || undefined,
            platform: input.platform || undefined,
            appVersion: input.appVersion || undefined,
            lastSeenAt: heartbeatAt,
          },
        });
        const creatorScope = await allowedCreatorScope({ agencyId, member, db: tx });
        const allowedCreatorIds = creatorScope.broad ? null : new Set(creatorScope.creatorIds);
        const bindings = await syncDeviceCreatorBindings({
          agencyId,
          deviceId: boundDeviceId,
          accounts: input.accounts,
          allowedCreatorIds,
          currentAccessEpoch: accessEpoch,
          now: heartbeatAt,
          db: tx,
        });
        return { device, bindings, accessEpoch };
      },
    });

    const device = capabilityCommit.device;
    const bindings = capabilityCommit.bindings;
    const currentAccessEpoch = capabilityCommit.accessEpoch;

    const recoveryCreators = new Set((bindings.recoveryCandidates || []).map(x => x.creatorId));
    const dialogRecovery = bindings.recoveryCandidates?.length
      ? [{ ok: true, reason: "recovery_check_queued", creators: bindings.recoveryCandidates.length }] : [];

    const realtimeBindings = (bindings.resolvedAccounts || [])
      .filter((entry) => entry?.account?.realtimeHealthy === true
        && Boolean(realtimeFrameSampleAt(entry.account, heartbeatAt)));
    let observation = null;
    try {
      observation = await withHeartbeatMemberGeneration({
        agencyId,
        userId: req.auth.userId,
        memberId: agencyId === req.auth.agencyId ? (req.auth.membership?.id || null) : null,
        expectedAccessEpoch: currentAccessEpoch,
        work: async ({ tx, member, accessEpoch }) => {
          // Recheck membership before recording coverage and durable recovery
          // requests. A revoked capability must not publish a fresh watermark.
          await require('../services/creator-live-sync-service').recordCaptureSamples({
            db:tx,agencyId,deviceId:boundDeviceId,memberId:member.id,accessEpoch,bindings:realtimeBindings,now:heartbeatAt,
          });
          await require('../services/dialog-recovery-queue-service').enqueue({
            db:tx,agencyId,candidates:bindings.recoveryCandidates || [],bindings:realtimeBindings,now:heartbeatAt,
          });
          return require('../services/device-heartbeat-batch-service').recordTeamObservations({
            db:tx,agencyId,bindings:realtimeBindings,now:heartbeatAt,
            preserve:creatorId=>recoveryCreators.has(creatorId),
          });
        },
      });
    } catch (err) {
      if (err?.code === "DEVICE_HEARTBEAT_ACCESS_EPOCH_STALE") {
        observation = { ok: false, code: "OBSERVATION_ACCESS_EPOCH_STALE" };
      } else {
        console.warn("[devices/heartbeat] observation update failed:", err?.message || err);
        observation = { ok: false, code: "OBSERVATION_UPDATE_FAILED" };
      }
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
    const manifestRows = await withHeartbeatMemberGeneration({
      agencyId,
      userId: req.auth.userId,
      memberId: agencyId === req.auth.agencyId ? (req.auth.membership?.id || null) : null,
      work: async ({ tx, member }) => {
        const manifestScope = await allowedCreatorScope({ agencyId, member, db: tx });
        const manifestAllowedCreatorIds = manifestScope.broad ? null : new Set(manifestScope.creatorIds);
        const scopedCreatorIds = manifestAllowedCreatorIds
          ? requestedCreatorIds.filter((id) => manifestAllowedCreatorIds.has(id))
          : requestedCreatorIds;
        return scopedCreatorIds.length ? tx.creatorAccount.findMany({
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
      },
    });
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

    const commands = await prisma.deviceCommand.findMany({
      where: {
        deviceId: boundDeviceId,
        agencyId,
        deliveredAt: null,
      },
      orderBy: { createdAt: "asc" },
      take: 50,
    });

    await assertCurrentAuthorizationSession({ db: prisma, ...req.auth });

    if (commands.length) {
      await prisma.deviceCommand.updateMany({
        where: { id: { in: commands.map((item) => item.id) } },
        data: { deliveredAt: new Date() },
      });
    }

    // Revocation is durable RefreshSession state, checked above. A queued device
    // hint can outlive the login it revoked (including while Desktop is offline).
    // Consume it, but never turn it into authority over a newer successful login.
    const forceLogout = false;
    const currentCommands = commands.filter((item) => item.command !== "FORCE_LOGOUT");
    const revokedCreatorIds = [];
    const revokedPartitions = [];

    for (const command of currentCommands) {
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
      creatorSessions,
      creatorNetworks,
      commands: currentCommands,
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
