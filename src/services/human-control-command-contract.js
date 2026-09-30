"use strict";
const { z } = require("zod");
const id = z.string().trim().min(1).max(240),
  stamp = z.string().datetime({ offset: true });
const metadata = z
  .object({
    mediaType: z.enum(["photo", "video", "audio", "gif", "unknown"]),
    durationSec: z.number().int().min(0).max(86400).nullable().optional(),
    description: z.string().max(12000),
    manualTags: z.array(z.string().max(80)).max(100),
    visibleBodyParts: z.array(z.string().max(80)).max(100),
    accessType: z.enum(["free", "paid"]),
    minPrice: z.number().min(0).max(20_000_000),
    idealPrice: z.number().min(0).max(20_000_000),
    storylineName: z.string().max(200).nullable().optional(),
    storylineOrder: z.number().int().min(-100000).max(100000).nullable().optional(),
    storylineRole: z.enum(["main", "additional"]).nullable().optional(),
  })
  .strict();
const orderPatch = z
  .object({
    scenario: z.string().max(12000).optional(),
    internalNote: z.string().max(4000).nullable().optional(),
    type: z.enum(["CONTENT", "CALL", "PHYSICAL"]).optional(),
    contentKind: z.enum(["PHOTO", "VIDEO", "BOTH"]).optional(),
    dueAt: stamp.nullable().optional(),
    scheduledAt: stamp.nullable().optional(),
    durationMinutes: z.number().int().min(1).max(1440).nullable().optional(),
    physicalStatus: z.enum(["WAITING", "READY", "SHIPPED", "COMPLETED"]).optional(),
    acceptedAt: stamp.nullable().optional(),
    cancelReason: z.string().max(1000).nullable().optional(),
    mediaIds: z.array(id).max(200).optional(),
    price: z.number().min(0).max(21474836.47).optional(),
    paidAmount: z.number().min(0).max(21474836.47).optional(),
    reminderConfig: z.record(z.unknown()).nullable().optional(),
    status: z.enum(["PENDING", "COMPLETED", "MISSED", "CANCELLED"]).optional(),
  })
  .strict();
const payloads = {
  "operation.control": require("./operational-command-contract").operation,
  "claims.tip": z
    .object({
      expectedUpdatedAt: stamp,
      action: z.enum(["claim", "release", "manager_override"]),
      targetMemberId: id.nullable(),
      reason: z.string().max(500).nullable(),
    })
    .strict(),
  "claims.ppv": z
    .object({
      expectedUpdatedAt: stamp,
      action: z.enum(["assign", "unresolved", "creator_revenue", "reject", "reopen"]),
      memberId: id.nullable(),
      reason: z.string().max(1000).nullable(),
    })
    .strict(),
  "automation.template": z
    .object({
      kind: z.enum(["bump", "sfs"]),
      operation: z.enum(["save", "trash", "restore", "delete"]),
      templateId: z.string().max(120),
      expectedTaskId: id.nullable(),
      expectedUpdatedAt: stamp.nullable(),
      input: z.record(z.unknown()).optional(),
    })
    .strict(),
  "automation.control": z
    .object({
      scope: z.enum(["workspace", "creator", "module"]),
      moduleKey: z.enum(["follow_back", "bumps", "likes", "follow", "sfs"]).nullable().optional(),
      expectedUpdatedAt: stamp.nullable(),
      enabled: z.boolean().optional(),
      settings: z.record(z.unknown()).optional(),
    })
    .strict(),
  "traffic.cost": z
    .object({
      sourceId: id,
      expectedRevision: z.number().int().min(0),
      costCents: z.number().int().min(0).max(2147483647),
      currency: z.string().regex(/^[A-Z]{3}$/),
    })
    .strict(),
  "media.metadata": z
    .object({ mediaId: id, expectedAssetId: id.nullable(), expectedUpdatedAt: stamp.nullable(), metadata })
    .strict(),
  "media.folder": z
    .object({ mediaIds: z.array(id).min(1).max(5000), folderId: id, action: z.enum(["add", "remove"]) })
    .strict(),
  "media.delete": z.object({ mediaIds: z.array(id).min(1).max(5000) }).strict(),
  "custom.update": z.object({ orderId: id, expectedUpdatedAt: stamp, patch: orderPatch }).strict(),
  "custom.destination": z
    .object({ folderId: id.nullable(), expectedFolderId: id.nullable(), expectedRevision: z.number().int().min(0) })
    .strict(),
  "creator.retire": z
    .object({
      expectedUpdatedAt: stamp,
      phrase: z.string().max(240),
      acknowledgeAgencyRemoval: z.literal(true),
      acknowledgeSessionRevocation: z.literal(true),
    })
    .strict(),
};
const permissions = {
  "operation.control": null,
  "claims.tip": null,
  "claims.ppv": "money.resolve_attribution",
  "automation.template": "automation.manage",
  "automation.control": "automation.manage",
  "traffic.cost": "traffic.manage_costs",
  "media.metadata": "content.manage_vault",
  "media.folder": "content.manage_vault",
  "media.delete": "content.manage_vault",
  "custom.update": null,
  "custom.destination": "content.manage_vault",
  "creator.retire": "creators.manage",
};
module.exports = { payloads, permissions };
