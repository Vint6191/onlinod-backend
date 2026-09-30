"use strict";
const { z } = require("zod");
const { digest } = require("./team-command-contract");
const id = z.string().trim().min(1).max(180);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const proxyType = z.enum(["HTTP", "HTTPS", "SOCKS4", "SOCKS4A", "SOCKS5"]);
const opaque = z
  .object({
    encryptionMode: z.literal("CLIENT_E2E_V1"),
    keyVersion: z.number().int().positive(),
    algorithm: z.literal("aes-256-gcm-client-e2e-v1"),
    ciphertext: z.string().min(1).max(1_000_000),
    iv: z.string().min(1).max(4096),
    tag: z.string().min(1).max(4096),
  })
  .strict();
const credentials = z
  .object({
    mode: z.enum(["KEEP", "REPLACE", "CLEAR"]),
    opaqueCredentials: opaque.optional(),
    usernameHint: z.string().max(512).nullable().optional(),
  })
  .strict()
  .superRefine((v, c) => {
    if ((v.mode === "REPLACE") !== Boolean(v.opaqueCredentials))
      c.addIssue({ code: z.ZodIssueCode.custom, message: "Only REPLACE requires encrypted credentials" });
  });
const proxy = {
  label: z.string().trim().min(1).max(120),
  type: proxyType,
  host: z.string().trim().min(1).max(512),
  port: z.number().int().min(1).max(65535),
  enabled: z.boolean().optional(),
};
const creator = z
  .object({
    displayName: z.string().trim().min(1).max(120),
    username: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-zA-Z0-9._-]+$/),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();
const avatar = z.object({expectedRevision:z.number().int().min(0), mimeType:z.enum(["image/jpeg","image/png","image/webp"]).nullable(), dataBase64:z.string().max(4*1024*1024).nullable()}).strict().refine(p=>(p.dataBase64===null)===(p.mimeType===null));
const payloads = {
  ...require("./human-control-command-contract").payloads,
  "account.avatar": avatar,
  "creator.avatar": avatar,
  "account.profile": z
    .object({ name: z.string().trim().min(1).max(80), expectedName: z.string().max(80).nullable() })
    .strict(),
  "workspace.update": z
    .object({
      expectedRevision: revision,
      name: z.string().trim().min(1).max(120).optional(),
      timezone: z.string().max(100).optional(),
      timeFormat: z.enum(["12h", "24h"]).optional(),
      dateFormat: z.enum(["DD.MM.YYYY", "MM.DD.YYYY", "YYYY-MM-DD"]).optional(),
      vaultUploadRecipient: z.string().max(100).optional(),
    })
    .strict(),
  "billing.preferences": z
    .object({ expectedRevision: revision, aiChatterEnabled: z.boolean(), outreachEnabled: z.boolean() })
    .strict(),
  "billing.start": z
    .object({
      expectedRevision: revision,
      testMode: z.boolean(),
      expectedActive: z.boolean(),
      expectedChargeCents: z.number().int().min(0).max(10_000_000),
    })
    .strict(),
  "billing.cancelRenewal": z.object({ expectedRevision: revision }).strict(),
  "creator.beginConnection": z
    .object({
      deviceId: id,
      expectedGeneration: z.number().int().min(0),
      expectedState: z.enum(["ENROLLMENT_REQUIRED", "CONNECTING", "CONNECTED", "RECONNECT_REQUIRED", "RECONNECTING"]),
    })
    .strict(),
  "creator.telegramContact": z
    .object({
      telegramContact: z
        .string()
        .trim()
        .max(160)
        .regex(/^[^\r\n\t]*$/)
        .nullable()
        .transform((v) => v || null),
      telegramAccountId: id.nullable(),
      expectedContact: z.string().max(160).nullable(),
      expectedAccountId: id.nullable(),
    })
    .strict(),
  "creator.create": creator,
  "creator.update": creator
    .partial()
    .extend({ expectedUpdatedAt: z.string().datetime({ offset: true }) })
    .strict(),
  "network.create": z
    .object({
      ...proxy,
      deviceId: id,
      expectedNetworkVersion: z.number().int().min(0),
      opaqueCredentials: opaque.optional(),
      usernameHint: z.string().max(512).nullable().optional(),
    })
    .strict(),
  "network.update": z
    .object(proxy)
    .partial()
    .extend({ deviceId: id, expectedVersion: z.number().int().positive(), credentials: credentials.optional() })
    .strict(),
  "network.delete": z.object({ expectedVersion: z.number().int().positive() }).strict(),
  "network.assign": z
    .object({
      expectedVersion: z.number().int().min(0),
      mode: z.enum(["DIRECT", "PROXY"]),
      proxyEndpointId: id.nullable().optional(),
    })
    .strict(),
};
const ACTIONS = Object.keys(payloads);
const envelope = z
  .object({
    commandId: z
      .string()
      .uuid()
      .transform((v) => v.toLowerCase()),
    action: z.enum(ACTIONS),
    targetId: z.string().trim().max(180),
    payload: z.record(z.unknown()),
  })
  .strict();
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
function parseManagementCommand(input, { cancel = false } = {}) {
  const c = envelope.parse(input);
  if (Buffer.byteLength(JSON.stringify(c.payload)) > (c.action.endsWith(".avatar") ? 4300 * 1024 : 1400 * 1024))
    throw fail("MANAGEMENT_COMMAND_TOO_LARGE", "Command exceeds payload limit", 413);
  // Fingerprint the exact persisted intent, not a normalized subset. Cancellation
  // must also tombstone invalid business payloads without changing their identity.
  const fingerprint = digest([1, c.action, c.targetId, c.payload]);
  if (!cancel) {
    if ((["account.profile", "account.avatar", "workspace.update", "creator.create"].includes(c.action) || (c.action === "operation.control" && c.payload.family === "dialog_module") || (c.action === "automation.control" && c.payload.scope === "workspace")) ? c.targetId !== "" : !c.targetId)
      throw fail("MANAGEMENT_COMMAND_TARGET_INVALID", "Invalid command target", 400);
    return { ...c, payload: payloads[c.action].parse(c.payload), fingerprint };
  }
  return { ...c, fingerprint };
}
module.exports = { ACTIONS, parseManagementCommand, fail };
