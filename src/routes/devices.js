const express = require("express");
const { z } = require("zod");
const prisma = require("../prisma");
const { authRequired } = require("../middleware/auth");

const router = express.Router();
router.use(authRequired);

const heartbeatSchema = z.object({
  deviceId: z.string().min(3).max(160),
  deviceName: z.string().max(160).optional().nullable(),
  platform: z.string().max(80).optional().nullable(),
  appVersion: z.string().max(80).optional().nullable(),
  activeAgencyId: z.string().optional().nullable(),
});

router.post("/heartbeat", async (req, res) => {
  try {
    const input = heartbeatSchema.parse(req.body || {});
    const agencyId = input.activeAgencyId || req.auth.agencyId;

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
      forceLogout,
      revokedCreatorIds: Array.from(new Set(revokedCreatorIds)),
      revokedPartitions: Array.from(new Set(revokedPartitions)),
      commands,
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

module.exports = router;
