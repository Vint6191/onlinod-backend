"use strict";

const crypto = require("node:crypto");
const { z } = require("zod");

function adminError(code, message, status = 409, details = undefined) {
  return Object.assign(new Error(message), { code, status, ...(details ? { details } : {}) });
}

const commandIdSchema = z.string().uuid();
const revisionSchema = z.number().int().min(0).max(2147483647);
const reasonSchema = z.string().trim().min(1).max(500);
const centsSchema = z.number().int().min(0).max(1000000);
const pricingSchema = z.object({
  expectedRevision: revisionSchema,
  reason: reasonSchema,
  tier: z.enum(["STARTER", "GROWTH", "PRO", "ELITE", "CUSTOM"]).optional(),
  tierMode: z.enum(["MANUAL", "AUTO"]).optional(),
  corePriceCents: centsSchema.optional(),
  aiChatterEnabled: z.boolean().optional(),
  aiChatterPriceCents: centsSchema.optional(),
  outreachEnabled: z.boolean().optional(),
  outreachPriceCents: centsSchema.optional(),
  billingExcluded: z.boolean().optional(),
  notes: z.string().max(3000).nullable().optional(),
}).strict().refine(value => Object.keys(value).some(key => !["expectedRevision", "reason"].includes(key)), "No pricing changes supplied");

const billingPolicySchema = z.object({
  expectedRevision: revisionSchema, reason: reasonSchema,
  plan: z.string().trim().min(1).max(80).optional(),
  billingMode: z.enum(["MANUAL", "STRIPE", "CRYPTO", "FREE_INTERNAL"]).optional(),
  billingPeriod: z.enum(["MONTHLY", "THREE_MONTHS", "SIX_MONTHS"]).optional(),
  corePricePerCreatorCents: centsSchema.optional(),
  trialEndsAt: z.string().datetime().nullable().optional(),
}).strict().refine(value => Object.keys(value).some(key => !["expectedRevision", "reason"].includes(key)), "No policy changes supplied");
const billingHoldSchema = z.object({ expectedRevision: revisionSchema, reason: reasonSchema, enabled: z.boolean() }).strict();
const entitlementSchema = z.object({
  expectedRevision: revisionSchema, reason: reasonSchema,
  tier: z.enum(["STARTER", "GROWTH", "PRO", "ELITE", "CUSTOM"]).optional(),
  coreValidUntil: z.string().datetime().nullable().optional(),
  aiChatterValidUntil: z.string().datetime().nullable().optional(),
  outreachValidUntil: z.string().datetime().nullable().optional(),
}).strict().refine(value => ["coreValidUntil", "aiChatterValidUntil", "outreachValidUntil"].some(key => value[key] !== undefined), "Choose an access component to grant or revoke")
  .refine(value => value.tier === undefined || value.coreValidUntil !== undefined, "Changing access tier requires an explicit core grant/revoke");

const bulkPricingSchema = z.object({
  reason: reasonSchema,
  tier: z.enum(["STARTER", "GROWTH", "PRO", "ELITE", "CUSTOM"]),
  corePriceCents: centsSchema.optional(),
  includeExcluded: z.boolean().default(false),
  items: z.array(z.object({ creatorId: z.string().trim().min(1).max(180), expectedRevision: revisionSchema }).strict()).min(1).max(100),
  resumesCommandId: commandIdSchema.optional(),
}).strict().refine(value => new Set(value.items.map(item => item.creatorId)).size === value.items.length, "Duplicate creator selection")
  .refine(value => value.tier !== "CUSTOM" || value.corePriceCents !== undefined, "CUSTOM requires an explicit core price");

const deliveryArchiveSchema = z.object({
  agencyId: z.string().trim().min(1).max(180), reason: reasonSchema,
  olderThan: z.string().datetime(),
  items: z.array(z.object({ id: z.string().trim().min(1).max(180), expectedUpdatedAt: z.string().datetime() }).strict()).min(1).max(100),
}).strict().refine(value => new Set(value.items.map(item => item.id)).size === value.items.length, "Duplicate delivery selection");

const contentLifecycleSchema = z.object({
  agencyId: z.string().trim().min(1).max(180), creatorId: z.string().trim().min(1).max(180),
  action: z.enum(["trash","restore","permanent"]), expectedUpdatedAt: z.string().datetime(), reason: reasonSchema,
}).strict();

const ACTIONS = Object.freeze({
  "data.content.lifecycle": { roles: ["SUPER_ADMIN"], schema: contentLifecycleSchema },
  "data.delivery.archive": { roles: ["SUPER_ADMIN"], schema: deliveryArchiveSchema },
  "billing.pricing.bulk.cancel": { roles: ["SUPER_ADMIN", "SUPPORT"], parentIdentity: true, schema: z.object({ targetCommandId: commandIdSchema, reason: reasonSchema }).strict() },
  "billing.pricing.bulk": { resumeIdentity: true, roles: ["SUPER_ADMIN", "SUPPORT"], schema: bulkPricingSchema },
  "billing.policy.set": { roles: ["SUPER_ADMIN", "SUPPORT"], schema: billingPolicySchema },
  "billing.hold.set": { roles: ["SUPER_ADMIN"], schema: billingHoldSchema },
  "billing.entitlement.set": { roles: ["SUPER_ADMIN", "SUPPORT"], schema: entitlementSchema },
  "billing.pricing.set": { roles: ["SUPER_ADMIN", "SUPPORT"], schema: pricingSchema },
  "admin.identity.create": { roles: ["SUPER_ADMIN"], roster: true },
  "admin.identity.patch": { roles: ["SUPER_ADMIN"], roster: true },
  "admin.identity.reset-password": { roles: ["SUPER_ADMIN"], roster: true },
});

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function intentHash({ action, targetId, payload }) {
  return crypto.createHash("sha256").update(canonicalJson({ version: 1, action, targetId, payload })).digest("hex");
}

function passwordFingerprint(password) {
  const key = process.env.JWT_SECRET || (process.env.NODE_ENV !== "production" ? "onlinod-local-admin-command-tests" : null);
  if (!key) throw adminError("ADMIN_COMMAND_SECRET_UNAVAILABLE", "JWT_SECRET is required", 503);
  return crypto.createHmac("sha256", key).update("admin-credential-intent-v1\0").update(String(password)).digest("hex");
}

function commandRequest(req) {
  const raw = req.get?.("Idempotency-Key") || req.headers?.["idempotency-key"];
  if (!raw) throw adminError("ADMIN_COMMAND_ID_REQUIRED", "A stable Idempotency-Key is required", 428);
  const parsed = commandIdSchema.safeParse(raw);
  if (!parsed.success) throw adminError("ADMIN_COMMAND_ID_INVALID", "Idempotency-Key must be a UUID", 400);
  return {
    commandId: parsed.data,
    actor: { adminId: req.admin?.id, sessionId: req.adminSession?.id, accessEpoch: req.adminSession?.issuedAccessEpoch },
  };
}

function publicAdmin(row) {
  return { id: row.id, email: row.email, name: row.name, role: row.role, active: row.active, accessEpoch: row.accessEpoch, lastLoginAt: row.lastLoginAt || null, createdAt: row.createdAt };
}

module.exports = { contentLifecycleSchema, deliveryArchiveSchema, bulkPricingSchema, billingPolicySchema, billingHoldSchema, entitlementSchema, ACTIONS, adminError, canonicalJson, commandIdSchema, revisionSchema, reasonSchema, pricingSchema, intentHash, passwordFingerprint, commandRequest, publicAdmin };
