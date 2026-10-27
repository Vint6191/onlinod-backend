"use strict";
const c = require("./common");
const { getDatabases, ready } = require("./databases");
const { DialogRepository } = require("./dialog-repository");
const { DialogReadModels, emptyCrmStats } = require("./dialog-read-models");
const { DialogChanges } = require("./dialog-changes");
const { CrmRepository } = require("./crm-repository");
const { CrmAnalysisService } = require("./crm-analysis-service");
const { HistoryRelay } = require("./history-relay");
const { readFanCurrent } = require("../fan-data-authority-service");
const { readCapacity, assertCapacity } = require("./capacity");
let singleton;
const READS = new Set([
  "getIdentity",
  "getState",
  "getStatus",
  "hasDialog",
  "getMessages",
  "inspectScanFrontier",
  "findExistingMessageIds",
  "listResumableStates",
  "count",
  "listLocalMessageCounts",
  "getThreadRow",
  "buildCrmStats",
  "emptyCrmStats",
  "getPanelSnapshot",
  "getAnalysisAutomationState",
  "readRevision",
  "readPage",
  "listProfiles",
  "get",
  "beginInput",
  "work",
  "progress",
  "status",
  "listDue",
  "readCheckpoints",
  "due",
  "assertMediaUsageRevision",
  "listDirtyRuntimeMessageCountRows",
  "listMediaUsageRows",
  "listMediaUsageDialogIds",
  "listMediaUsageFactPage",
  "listDialogMediaFacts",
  "listVaultSalesRows",
  "getDailyMessageMetricsRows",
  "listUserMessageMetadataFirstSeenSince",
  "listTeamPendingBootstrapDialogs",
]);
class ConversationRuntime {
  constructor(db, core) {
    this.db = db;
    this.core = core;
    this.dialogs = new DialogRepository(db.dialogs);
    this.models = new DialogReadModels(this.dialogs);
    this.crm = new CrmRepository(db.crm, this.dialogs, {
      read: (ctx, onlyFansUserIds) => readFanCurrent(core, { agencyId: ctx.agencyId, creatorId: ctx.creatorId, onlyFansUserIds }),
      revision: async ctx => (await c.one(core,
        'SELECT "lastRevision" FROM "CreatorEntityChangeHead" WHERE "agencyId"=$1 AND "creatorId"=$2',
        ctx.agencyId, ctx.creatorId))?.lastRevision || 0n,
    });
    this.crm.models = this.models;
    this.relay = new HistoryRelay(this.dialogs, this.crm);
    this.analysis = new CrmAnalysisService(this.crm, this.dialogs, this.relay);
    this.changes = new DialogChanges(this.dialogs, core);
    this.health = new Map();
    this.capacities = new Map();
    this.capacityReads = new Map();
    this.pumpBusy = false;
  }
  async check(domain) {
    const now = Date.now();
    if (now - (this.health.get(domain) || 0) < 30000) return;
    await ready(this.db[domain], domain);
    this.health.set(domain, now);
  }
  async capacity(domain) {
    const max = Number(process.env.CONVERSATION_BRANCH_MAX_BYTES || 850000000);
    c.check(Number.isSafeInteger(max) && max > 0, "CONVERSATION_CAPACITY_CONFIG_INVALID", 503);
    const previous = this.capacities.get(domain);
    if (previous && previous.maxBytes === max && Date.now() - previous.at < 10000) return assertCapacity(previous);
    // All databases in this branch share disk. This is a physical size guard,
    // distinct from the per-model accounted quota. Other Neon branches/projects
    // must be budgeted by the operator; PostgreSQL cannot see them here.
    let pending = this.capacityReads.get(domain);
    if (!pending) {
      pending = readCapacity(this.db[domain], domain, max).then(snapshot => {
        this.capacities.set(domain, snapshot); return snapshot;
      });
      this.capacityReads.set(domain, pending);
      void pending.finally(() => { if (this.capacityReads.get(domain) === pending) this.capacityReads.delete(domain); }).catch(() => undefined);
    }
    return assertCapacity(await pending);
  }
  async financial(ctx, fanId) {
    if (ctx.canViewMoney !== true) return { available: false, source: "financial-ledger", reason: "FORBIDDEN" };
    const row = await c.one(
      this.core,
      `SELECT s.stage,s.snapshot,b."netCents",b.payments,p.generation,p."activeGeneration",p."creatorId",p."throughAt",
      EXISTS(SELECT 1 FROM "FanLtvChange" x WHERE x."creatorId"=s."creatorId") dirty,
      EXISTS(SELECT 1 FROM "FanLtvReceipt" x WHERE x."creatorId"=s."creatorId" AND x."nextDueAt"<=now()) due
      FROM "FanLtvState" s LEFT JOIN "FanLtvBalance" b ON b."creatorId"=s."creatorId" AND b."rangeKey"='all' AND b."fanId"=$3
      LEFT JOIN "CreatorEarningsLedgerProof" p ON p."creatorId"=s."creatorId" AND p."agencyId"=s."agencyId"
      WHERE s."agencyId"=$1 AND s."creatorId"=$2`,
      ctx.agencyId,
      ctx.creatorId,
      fanId
    );
    const available = Boolean(
      row &&
        row.stage === "LIVE" &&
        !row.dirty &&
        !row.due &&
        row.snapshot?.proofGeneration === row.generation &&
        row.snapshot?.sourceKey === require("../fan-ltv-projection-service").sourceKey(row) &&
        row.throughAt &&
        row.snapshot?.throughAt === c.iso(row.throughAt)
    );
    return {
      available,
      source: "financial-ledger",
      netCents: available ? Number(row.netCents || 0) : null,
      payments: available ? Number(row.payments || 0) : null,
      historyComplete:
        available && row.snapshot?.historyComplete === true && row.snapshot?.ranges?.all?.attributionComplete === true,
      asOf: row?.snapshot?.asOf || null,
      reason: available ? null : "PROJECTION_UPDATING",
    };
  }
  async automationState(ctx, input) {
    const [state, count, profile] = await Promise.all([
      this.dialogs.getState(ctx, input),
      this.dialogs.count(ctx, input),
      this.crm.getProfile(ctx, input.dialogId),
    ]);
    return {
      creatorId: ctx.creatorId,
      dialogId: input.dialogId,
      fullScanDone: false,
      collectionComplete: state.collectionComplete === true,
      scanHasMore: state.scanHasMore,
      messagesCount: count.messages,
      newestMessageId: state.newestMessageId || "",
      analysisStatus: profile.analysisStatus,
      analysisUpdatedAt: profile.analysisUpdatedAt,
      requestedAt: null,
      attempts: 0,
      nextRetryAt: null,
      reason: "",
      analyzedMessageId: "",
      analyzedMessagesCount: 0,
    };
  }
  async canonicalIdentity(ctx, input) {
    const current = (
      await readFanCurrent(this.core, {
        agencyId: ctx.agencyId,
        creatorId: ctx.creatorId,
        onlyFansUserIds: [input.dialogId],
      })
    )[0];
    if (!current) return { changed: false, receiptId: `fan-missing:${input.dialogId}` };
    const id = current.platformIdentity;
    return c.transaction(this.db.crm, async (tx) => {
      await this.crm.scope(ctx, tx);
      await c.one(tx, "SELECT scope_id FROM crm_scope WHERE scope_id=$1 FOR UPDATE", ctx.scopeId);
      const before = await this.crm.ensure(ctx, input.dialogId, tx);
      const patch = {
        platformUsername: id.username || "",
        platformDisplayName: id.platformDisplayName || "",
        platformIdentityRevision: JSON.stringify(id.fieldAuthority),
      };
      const changed = Object.keys(patch).some((k) => before.profile[k] !== patch[k]);
      if (changed) {
        await c.exec(
          tx,
          "UPDATE crm_profile SET profile=profile || $3::jsonb,revision=revision+1,updated_at=now() WHERE scope_id=$1 AND fan_id=$2",
          ctx.scopeId,
          input.dialogId,
          JSON.stringify(patch)
        );
        await this.crm.touch(ctx, input.dialogId, tx, "identity.canonical", Object.keys(patch));
      }
      return { changed, receiptId: c.hash([ctx.scopeId, input.dialogId, patch]) };
    });
  }
  async call(ctx, target, method, args, command) {
    c.check(Array.isArray(args) && args.length <= 6, "CONVERSATION_ARGUMENTS_INVALID", 400);
    const a = args[0] || {};
    if (target === "scope" && method === "getIdentity") return { platformCreatorId: ctx.platformCreatorId };
    const domain = ["crmProfiles", "campaignProfiles", "persona", "analysis"].includes(target) ? "crm" : "dialogs";
    await this.check(domain);
    if (
      [
        "commitScanPage",
        "upsertMessages",
        "apply",
        "updateProfile",
        "save",
        "request",
        "claim",
        "beginReplies",
        "ensureAutomatic",
        "checkpoint",
      ].includes(method)
    )
      await this.capacity(domain);
    if (target === "messages") {
      if (
        [
          "getIdentity",
          "getState",
          "getStatus",
          "getMessages",
          "inspectScanFrontier",
          "findExistingMessageIds",
          "listResumableStates",
        ].includes(method)
      )
        return this.dialogs[method](ctx, a);
      if (method === "hasDialog") return (await this.dialogs.count(ctx, a)).messages > 0;
      if (method === "markState") return this.dialogs.markState(ctx, a);
      if (method === "commitScanPage") {
        const { dialogId, messages, statePatch, frontier, targeted } = a;
        if (targeted)
          c.check(
            messages?.length === 1 && !frontier && Object.keys(statePatch || {}).length === 0,
            "TARGETED_MESSAGE_INVALID",
            400
          );
        return this.dialogs.commitScanPage(
          ctx,
          { dialogId, messages, statePatch, frontier, targeted: targeted === true },
          command
        );
      }
      if (method === "upsertMessages") {
        c.check(
          Array.isArray(a) && a.length > 0 && a.every((m) => m.dialogId === a[0].dialogId),
          "DIALOG_BATCH_SCOPE_INVALID",
          400
        );
        return (
          await this.dialogs.commitScanPage(ctx, { dialogId: a[0].dialogId, messages: a, statePatch: {} }, command)
        ).summary;
      }
      if (method === "ensureDialogThread")
        return c.transaction(this.db.dialogs, async (tx) => {
          await this.dialogs.scope(ctx, tx);
          await this.dialogs.thread(ctx, a.dialogId, tx);
        });
      if (
        ["listDialogMediaFacts", "listUserMessageMetadataFirstSeenSince", "listTeamPendingBootstrapDialogs"].includes(
          method
        )
      )
        return this.models[method](ctx, a);
      if (method === "clear") throw c.fail("SERVER_ARCHIVE_CLEAR_REQUIRES_EXPLICIT_ADMIN_RESET", 409);
      if (method === "listAllMessagesForAnalysis") throw c.fail("HISTORY_PAGINATION_REQUIRED", 400);
      if (method === "observeProviderPurchase")
        return (await this.changes.purchase(ctx, { ...a, kind: "provider" }, command)).changed;
    }
    if (target === "stats") {
      if (method === "emptyCrmStats") return emptyCrmStats();
      if (["count", "listLocalMessageCounts"].includes(method)) return this.dialogs[method](ctx, a);
      if (method === "getThreadRow") return this.models.getThreadRow(ctx, a);
      if (method === "buildCrmStats") return this.models.buildCrmStats(ctx, { dialogId: args[1] });
      if (["refreshAllDialogThreads", "refreshDialogThread"].includes(method)) return; // Aggregates commit with each page.
    }
    if (
      target === "readModels" &&
      [
        "listDirtyRuntimeMessageCountRows",
        "assertMediaUsageRevision",
        "listMediaUsageRows",
        "listMediaUsageDialogIds",
        "listMediaUsageFactPage",
        "listVaultSalesRows",
        "getDailyMessageMetricsRows",
      ].includes(method)
    )
      return this.models[method](ctx, a);
    if (target === "history") {
      if (method === "beginInput") return this.dialogs.beginInput(ctx, a);
      if (method === "readPage") return this.dialogs.readPage(ctx, a, args[2]);
    }
    if (target === "changes") {
      if (method === "apply") return this.changes.apply(ctx, a, command);
      if (["due", "reserve", "complete"].includes(method)) return this.changes[method](ctx, a);
      if (["defer", "stop", "wait"].includes(method)) return this.changes.settle(ctx, a, method);
    }
    if (target === "crmProfiles") {
      if (method === "updateFanIdentity") return this.crm.updateFanIdentity(ctx, a);
      if (method === "applyCanonicalFanIdentity") return this.canonicalIdentity(ctx, a);
      if (method === "getAnalysisAutomationState") return this.automationState(ctx, a);
      if (method === "getPanelSnapshot" || method === "updateProfile") {
        const panel =
          method === "updateProfile"
            ? await this.crm.updateProfile(ctx, a, command)
            : await this.crm.getPanelSnapshot(ctx, a);
        try {
          panel.financial = await this.financial(ctx, a.dialogId);
        } catch {
          panel.financial = { available: false, source: "financial-ledger", reason: "FINANCIAL_UNAVAILABLE" };
        }
        return panel;
      }
      // Unleased AI/profile/automation writes are deliberately not a public port.
    }
    if (target === "campaignProfiles") {
      if (method === "readRevision") return this.crm.readRevision(ctx);
      if (method === "readPage") return this.crm.readPage(ctx, a);
      if (method === "listProfiles") {
        const page = await this.crm.readPage(ctx, a);
        c.check(!page.nextDialogId, "CAMPAIGN_PAGINATION_REQUIRED");
        return page.rows;
      }
    }
    if (target === "persona") {
      if (method === "get") return this.crm.personaGet(ctx);
      if (method === "save") return this.crm.personaSave(ctx, a, command);
    }
    if (target === "analysis") {
      if (method === "beginReplies") return this.analysis.beginReplies(ctx, a, command);
      if (method === "cancel") return this.analysis.defer(ctx, a, 0, args[2], args[3], true);
      if (
        [
          "completeReplies",
          "collect",
          "ensureAutomatic",
          "recoverProviderFailure",
          "discover",
          "waitForScan",
          "work",
          "progress",
          "bindContext",
          "saveReduction",
          "saveFinal",
          "request",
          "claim",
          "renew",
          "readNextPage",
          "checkpoint",
          "readCheckpoints",
          "complete",
          "defer",
          "status",
          "listDue",
        ].includes(method)
      )
        return this.analysis[method](ctx, a, ...args.slice(2));
    }
    throw c.fail("CONVERSATION_METHOD_NOT_AVAILABLE", 400);
  }
  async pump() {
    if (this.pumpBusy) return;
    this.pumpBusy = true;
    try {
      await this.check("dialogs");
      await this.check("crm");
      const token = c.randomUUID();
      const scopes = await c.transaction(this.db.dialogs, async (tx) => {
        const due = await c.rows(
          tx,
          "SELECT scope_id,agency_id,platform_creator_id FROM dialog_archive_scope WHERE relay_pending AND relay_next_at<=now() AND (relay_lease_until IS NULL OR relay_lease_until<=now()) ORDER BY relay_next_at,scope_id LIMIT 8 FOR UPDATE SKIP LOCKED"
        );
        if (due.length)
          await c.exec(
            tx,
            "UPDATE dialog_archive_scope SET relay_token=$2,relay_lease_until=now()+interval '30 seconds',relay_next_at=now()+interval '30 seconds' WHERE scope_id=ANY($1::text[])",
            due.map((s) => s.scope_id),
            token
          );
        return due;
      });
      let firstError;
      for (const s of scopes) {
        const ctx = {
          scopeId: s.scope_id,
          agencyId: s.agency_id,
          platformCreatorId: s.platform_creator_id,
          actorId: "history-relay",
        };
        try {
          await this.relay.scope(ctx, 32);
          await this.dialogs.prune(ctx);
        } catch (error) {
          firstError ||= error;
        }
        try {
          await c.transaction(this.db.dialogs, async (tx) => {
            const owner = await c.one(
              tx,
              "SELECT relay_token FROM dialog_archive_scope WHERE scope_id=$1 FOR UPDATE",
              s.scope_id
            );
            if (owner.relay_token !== token) return;
            const pending = await c.one(
              tx,
              "SELECT 1 FROM dialog_archive_outbox WHERE scope_id=$1 AND revision>acknowledged_revision LIMIT 1",
              s.scope_id
            );
            await c.exec(
              tx,
              "UPDATE dialog_archive_scope SET relay_pending=$2,relay_lease_until=NULL,relay_next_at=now()+interval '5 seconds' WHERE scope_id=$1",
              s.scope_id,
              Boolean(pending)
            );
          });
        } catch (error) {
          firstError ||= error;
        }
      }
      await c.exec(
        this.db.crm,
        "DELETE FROM crm_command_receipt WHERE (scope_id,command_id) IN (SELECT scope_id,command_id FROM crm_command_receipt WHERE expires_at<now() ORDER BY expires_at LIMIT 128)"
      );
      await c.exec(
        this.db.crm,
        "DELETE FROM crm_audit WHERE id IN (SELECT id FROM crm_audit WHERE created_at<now()-interval '90 days' ORDER BY created_at LIMIT 128)"
      );
      await c.exec(
        this.db.crm,
        "DELETE FROM crm_reply_run WHERE token IN (SELECT token FROM crm_reply_run WHERE expires_at<now() ORDER BY expires_at LIMIT 64)"
      );

      if (firstError) throw firstError;
    } finally {
      this.pumpBusy = false;
    }
  }
}
function runtime() {
  if (!singleton) singleton = new ConversationRuntime(getDatabases(), require("../../prisma"));
  return singleton;
}
module.exports = { ConversationRuntime, runtime, READS };
