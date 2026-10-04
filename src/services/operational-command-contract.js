"use strict";
const { z } = require("zod");
const id = z.string().trim().min(1).max(180),
  text = z.string().max(120),
  ids = z.array(id).max(500);
const schemas = {
  traffic_refresh: {
    refresh: z.object({
      force: z.boolean().optional(),
      accountHints: z
        .object({
          accountId: id.nullable().optional(),
          localAccountId: id.nullable().optional(),
          accountManifestId: id.nullable().optional(),
          creatorRemoteId: id.nullable().optional(),
          remoteId: id.nullable().optional(),
          creatorUsername: text.nullable().optional(),
          username: text.nullable().optional(),
          creatorDisplayName: text.nullable().optional(),
        })
        .strict()
        .optional(),
    }),
  },
  dialog_single: {
    start: z.object({
      dialogId: id,
      fanId: id.nullable().optional(),
      mode: z.enum(["initial", "full", "incremental", "targeted", "reconcile"]).optional(),
      targetMessageId: id.nullable().optional(),
      cursor: z.string().max(240).nullable().optional(),
      source: text.optional(),
      generation: z.number().int().min(0).optional(),
      pageLimit: z.number().int().min(1).max(100).optional(),
      overlapPages: z.number().int().min(0).max(10).optional(),
      maxPages: z.number().int().min(1).max(10000).optional(),
      priority: z.number().int().min(0).max(200).optional(),
      knownMessageThreshold: z.number().int().min(1).max(100).optional(),
    }),
    cancel: z.object({ dialogId: id, reason: z.string().max(500).optional() }),
  },
  dialog_module: { configure: z.object({ enabled: z.boolean(), settings: z.record(z.unknown()).optional() }) },
  notification: { start: z.object({ forceFull: z.boolean().optional() }), stop: z.object({}) },
  financial: { start: z.object({}), stop: z.object({}) },
  campaign: { start: z.object({ intent: z.enum(["source", "repair"]).optional() }), stop: z.object({}) },
  vault: {
    start: z.object({
      mode: z.enum(["incremental", "full"]).optional(),
      source: text.optional(),
      priority: z.number().int().min(0).max(200).optional(),
    }),
    pause: z.object({}),
    resume: z.object({}),
    cancel: z.object({}),
  },
  dialog: {
    start: z.object({
      mode: z.enum(["initial", "incremental", "full"]).optional(),
      source: text.optional(),
      pageLimit: z.number().int().min(1).max(100).optional(),
      overlapPages: z.number().int().min(0).max(10).optional(),
      maxPages: z.number().int().min(1).max(10000).optional(),
      priority: z.number().int().min(0).max(200).optional(),
    }),
    pause: z.object({ reason: z.string().max(500).optional() }),
    resume: z.object({}),
    cancel: z.object({ reason: z.string().max(500).optional() }),
  },
  subscriber: {
    start: z.object({
      force: z.boolean().optional(),
      manual: z.boolean().optional(),
      mode: z.literal("full").optional(),
      sourceType: z.string().max(40).optional(),
      pageLimit: z.number().int().min(20).max(100).optional(),
      scanEveryDays: z.number().int().min(1).max(30).optional(),
    }),
  },
  hidden: { status: z.object({ fanId: id, status: z.enum(["active", "ignored", "blocked"]) }) },
  automation_candidate: {
    action: z.object({
      module: z.enum(["follow_back", "follow", "likes", "sfs"]),
      candidateId: id,
      action: z.enum(["ignore", "block", "restore", "follow", "refollow", "like", "run", "retry"]),
    }),
  },
  automation_delivery: {
    retry: z.object({ deliveryId: id }),
    cancel: z.object({ deliveryId: id, reason: z.string().max(500).optional() }),
    release: z.object({ deliveryId: id }),
    retry_safe: z.object({ moduleKey: text.nullable().optional(), limit: z.number().int().min(1).max(100).optional() }),
  },
  automation_plan: {
    follow_back: z.object({ fanId: id.optional(), source: text.optional() }),
    follow: z.object({ fanId: id.optional(), source: text.optional() }),
    bumps: z.object({
      source: z
        .enum(["online", "hidden_online", "paid_subscriber", "free_subscriber", "subscription_event", "manual"])
        .optional(),
      fanIds: ids.optional(),
      limit: z.number().int().min(1).max(500).optional(),
      manual: z.boolean().optional(),
    }),
    bumps_auto: z.object({}),
    bump_replies: z.object({ limit: z.number().int().min(1).max(500).optional() }),
    likes: z.object({ candidateIds: ids.optional(), source: text.optional() }),
    likes_discover: z.object({
      fanIds: ids.optional(),
      force: z.boolean().optional(),
      maxFans: z.number().int().min(1).max(500).optional(),
      source: text.optional(),
    }),
    sfs: z.object({
      candidateId: id.optional(),
      limit: z.number().int().min(1).max(100).optional(),
      source: text.optional(),
    }),
    sfs_discover: z.object({ force: z.boolean().optional(), source: text.optional() }),
  },
  analytics_refresh: {
    refresh: z.object({ rangeKey: z.enum(["today", "yesterday", "7d", "14d", "30d", "90d", "all"]) }),
  },
};
const operation = z
  .object({
    family: z.enum(Object.keys(schemas)),
    operation: z.string().max(40),
    input: z.record(z.unknown()),
    expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict()
  .superRefine((p, ctx) => {
    const schema = schemas[p.family]?.[p.operation];
    if (!schema) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Unsupported operation" });
      return;
    }
    const result = schema.strict().safeParse(p.input);
    if (!result.success) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid operation input" });
    if (p.family === "automation_candidate") {
      const allowed = {
        follow_back: ["ignore", "block", "restore", "follow", "retry"],
        follow: ["ignore", "block", "restore", "refollow", "retry"],
        likes: ["ignore", "block", "restore", "like", "retry"],
        sfs: ["ignore", "block", "restore", "run", "retry"],
      };
      if (!allowed[p.input.module]?.includes(p.input.action))
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid candidate action" });
    }
  });
function permissions(p) {
  if (p.family === "dialog_module") return ["workspace.manage_settings"];
  if (["financial", "campaign"].includes(p.family)) return ["creator_analytics.refresh", "money.view_earnings"];
  if (["notification", "analytics_refresh"].includes(p.family)) return ["creator_analytics.refresh"];
  if (p.family === "traffic_refresh") return ["traffic.view", "traffic.refresh"];
  if (["vault", "dialog", "dialog_single"].includes(p.family)) return ["content.manage_vault"];
  return ["automation.manage"];
}
module.exports = { operation, permissions, schemas };
