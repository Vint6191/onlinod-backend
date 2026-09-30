"use strict";
const { permissions } = require("./human-control-command-contract");
const { setAutomationControl, getAutomationControlSnapshot } = require("./automation-control-service");
const { lockAutomationWriteCommitFence } = require("./automation-write-commit-fence-service");
const media = require("./media-library-service");
const tips = require("./team-tip-ledger-service"),
  ppv = require("./team-ppv-ledger-service");
const templates = require("./automation-server-service");
const custom = require("./custom-orders-service");
const destination = require("./custom-vault-destination-service");
const { agencyRemovalPhrase } = require("./creator-agency-removal");
const {
  retireCreatorWithinTransaction,
  publishCreatorRetirementControlEvents,
} = require("./creator-lifecycle-authority-service");
const { lockTeamControlPlaneTopology } = require("./team-control-plane-authority-service");
const { assertTeamControlPlaneWriteAdmission } = require("./phase2-release-compatibility-authority-service");
const { deferCommitHint } = require("./db-commit-kernel");
const { dbAuthorityNow } = require("./db-time-authority-service");
const has = (c) => Object.hasOwn(permissions, c.action);
const fail = (code, message, status = 409) => Object.assign(new Error(message), { code, status });
const iso = (v) => (v ? new Date(v).toISOString() : null);
const controlKey = (c) =>
  c.payload.scope === "workspace"
    ? "workspace"
    : c.payload.scope === "creator"
      ? `creator:${c.targetId}`
      : `creator:${c.targetId}:module:${c.payload.moduleKey}`;
function permission(c) {
  return c.action === "claims.tip"
    ? c.payload.action === "claim"
      ? "money.claim"
      : c.payload.action === "release"
        ? "money.release_own_claim"
        : "money.override_attribution"
    : permissions[c.action];
}
async function targets(tx, agencyId, c) {
  if (!c.action.startsWith("claims.")) return c.targetId ? [c.targetId] : [];
  const row =
    c.action === "claims.tip"
      ? await tx.teamTipLedger.findFirst({ where: { agencyId, eventHash: c.targetId }, select: { creatorId: true } })
      : await tx.teamPpvResolveJob.findFirst({ where: { agencyId, id: c.targetId }, select: { creatorId: true } });
  return row?.creatorId ? [row.creatorId] : [];
}
async function admission(tx, c) {
  if (c.action === "creator.retire") await assertTeamControlPlaneWriteAdmission(tx);
}
async function lockPrefix(tx, agencyId, c) {
  if (c.action === "operation.control" && c.payload.family === "dialog_module")
    await require("./db-transaction-service").lockDbAdvisoryXact({ db: tx, key: `dialog-module:${agencyId}` });
  if (
    c.action.startsWith("automation.") ||
    (c.action === "operation.control" &&
      (c.payload.family.startsWith("automation_") || ["hidden", "subscriber"].includes(c.payload.family)))
  )
    await lockAutomationWriteCommitFence({ db: tx, agencyId, creatorId: c.targetId || null });
  if (c.action === "creator.retire") await lockTeamControlPlaneTopology({ tx, agencyId, agencyAlreadyLocked: true });
}
async function apply(tx, agencyId, userId, member, c, context, deviceId) {
  const p = c.payload;
  let value;
  if (c.action === "operation.control")
    return require("./operational-command-service").apply(tx, agencyId, c.targetId, userId, member, p);
  if (c.action.startsWith("claims.")) {
    const isTip = c.action === "claims.tip";
    const row = isTip
      ? await tx.teamTipLedger.findFirst({ where: { agencyId, eventHash: c.targetId } })
      : await tx.teamPpvResolveJob.findFirst({ where: { agencyId, id: c.targetId } });
    if (!row || iso(row.updatedAt) !== p.expectedUpdatedAt)
      throw fail("CLAIM_VERSION_CONFLICT", "Attribution evidence changed; reload before deciding");
    value = isTip
      ? await tips.applyTipOverride({
          agencyId,
          byUserId: userId,
          byMemberId: member.id,
          actorMember: member,
          eventHash: c.targetId,
          action: p.action,
          targetMemberId: p.targetMemberId,
          reason: p.reason,
          db: tx,
        })
      : await ppv.resolvePpvConflict({
          agencyId,
          jobId: c.targetId,
          actorMemberId: member.id,
          actorMember: member,
          memberId: p.memberId,
          action: p.action,
          reason: p.reason,
          deviceId,
          db: tx,
        });
    if (value.code || (isTip && value.ok !== true))
      throw fail(value.code || "CLAIM_FAILED", value.error || "Attribution could not be confirmed", 409);
    return { humanReference: isTip ? { id: row.id } : { outcome: { ok: true, ...value } } };
  }
  if (c.action === "automation.control") {
    await lockAutomationWriteCommitFence({ db: tx, agencyId, creatorId: p.scope === "workspace" ? null : c.targetId });
    if ((p.scope === "workspace") !== !c.targetId || (p.scope === "module" && !p.moduleKey))
      throw fail("CONTROL_TARGET_INVALID", "Invalid control target", 400);
    const row = await tx.automationControlState.findUnique({
      where: { agencyId_scopeKey: { agencyId, scopeKey: controlKey(c) } },
    });
    if (iso(row?.updatedAt) !== p.expectedUpdatedAt)
      throw fail("CONTROL_VERSION_CONFLICT", "Automation settings changed; reload before editing");
    value = await setAutomationControl({
      agencyId,
      userId,
      creatorId: c.targetId || null,
      ...p,
      db: tx,
      _commitFenceHeld: true,
    });
    return { ...value, humanReference: { changedDeliveries: value.changedDeliveries, changedJobs: value.changedJobs } };
  }
  if (c.action === "automation.template") {
    const type = p.kind === "bump" ? "bump_online" : "sfs_comment";
    const row = p.templateId
      ? await tx.automationTask.findFirst({
          where: { agencyId, creatorId: c.targetId, type, OR: [{ id: p.templateId }, { clientId: p.templateId }] },
        })
      : null;
    if (
      p.expectedTaskId
        ? !row || row.id !== p.expectedTaskId || iso(row.updatedAt) !== p.expectedUpdatedAt
        : Boolean(row) || p.expectedUpdatedAt !== null || p.operation !== "save"
    )
      throw fail("AUTOMATION_TEMPLATE_VERSION_CONFLICT", "Template changed; reload before editing");
    const templateId = p.templateId || `bump_${c.commandId}`;
    if (p.operation === "save") {
      const raw = {
        ...p.input,
        id: templateId,
        clientId: row?.clientId || templateId,
        creatorId: c.targetId,
        accountId: c.targetId,
      };
      if (p.kind === "sfs" && !String(raw.commentText || raw.messageText || raw.text || "").trim())
        throw fail("SFS_COMMENT_TEXT_REQUIRED", "Comment text is required", 400);
      const input = (p.kind === "bump" ? templates.normalizeBumpToTask : templates.normalizeSfsCommentToTask)(
        raw,
        c.targetId
      );
      await templates.assertReusableBumpMediaAllowed({
        agencyId,
        creatorId: c.targetId,
        media: input.config?.media,
        db: tx,
      });
      value = await templates.upsertTask({ agencyId, userId, input, expectedCreatorId: c.targetId, db: tx });
    } else {
      if (p.operation === "restore")
        await templates.assertReusableBumpMediaAllowed({
          agencyId,
          creatorId: c.targetId,
          media: row.config?.media || row.config?.mediaFiles,
          db: tx,
        });
      value = await (p.operation === "restore" ? templates.restoreTask : templates.trashTask)({
        agencyId,
        userId,
        taskId: row.id,
        creatorId: c.targetId,
        permanent: p.operation === "delete",
        db: tx,
      });
    }
    return { humanReference: { taskId: value.item?.id || row?.id, deleted: p.operation === "delete" } };
  }
  if (c.action === "traffic.cost") {
    const changed = await tx.trafficSource.updateMany({
      where: { id: p.sourceId, agencyId, creatorId: c.targetId, costRevision: p.expectedRevision },
      data: { costCents: p.costCents, currency: p.currency, costRevision: { increment: 1 } },
    });
    if (changed.count !== 1) throw fail("TRAFFIC_COST_VERSION_CONFLICT", "Traffic cost changed; reload before editing");
    return { humanReference: {} };
  }
  if (c.action === "media.metadata") {
    const row = await tx.creatorMediaAsset.findUnique({
      where: { creatorId_mediaId: { creatorId: c.targetId, mediaId: p.mediaId } },
    });
    if (
      p.expectedAssetId
        ? row?.id !== p.expectedAssetId || iso(row.metadataUpdatedAt || row.updatedAt) !== p.expectedUpdatedAt
        : Boolean(row?.metadataUpdatedAt)
    )
      throw fail("MEDIA_METADATA_VERSION_CONFLICT", "Media metadata changed; reload before editing");
    value = await media.upsertMediaMetadata({
      agencyId,
      creatorId: c.targetId,
      mediaId: p.mediaId,
      input: p.metadata,
      userId,
      db: tx,
    });
    return { ...value, humanReference: {} };
  }
  if (c.action === "media.folder" || c.action === "media.delete") {
    value = await (c.action === "media.folder" ? media.mutateFolderMembership : media.deleteMediaAssets)({
      agencyId,
      creatorId: c.targetId,
      ...p,
      db: tx,
    });
    return { ...value, humanReference: { outcome: value } };
  }
  if (c.action === "custom.update") {
    const row = await tx.customOrder.findFirst({ where: { id: p.orderId, agencyId, creatorId: c.targetId } });
    if (!row || iso(row.updatedAt) !== p.expectedUpdatedAt)
      throw fail("CUSTOM_ORDER_VERSION_CONFLICT", "Custom order changed; reload before editing");
    const now = await dbAuthorityNow({ db: tx });
    value = await custom.updateCustomOrder({
      agencyId,
      member,
      orderId: p.orderId,
      input: { ...p.patch, creatorId: c.targetId },
      now,
      db: tx,
    });
    return { ...value, humanReference: { readAt: now.toISOString() } };
  }
  if (c.action === "custom.destination") {
    value = await destination.setCustomVaultDestination({
      agencyId,
      member,
      creatorId: c.targetId,
      folderId: p.folderId,
      expectedFolderId: p.expectedFolderId,
      expectedRevision: p.expectedRevision,
      db: tx,
    });
    return { ...value, humanReference: {} };
  }
  if (c.action === "creator.retire") {
    const row = await tx.creatorAccount.findFirst({ where: { id: c.targetId, agencyId, deletedAt: null } });
    if (!row || agencyRemovalPhrase(row) !== p.phrase)
      throw fail("CREATOR_DELETE_PHRASE_REQUIRED", "Agency removal phrase does not match", 400);
    const result = await retireCreatorWithinTransaction({
      tx,
      agencyId,
      creatorId: c.targetId,
      actorUserId: userId,
      mode: "SOFT",
      retiredAt: await dbAuthorityNow({ db: tx }),
      sourceRequestId: `creator-retirement:${c.commandId}`,
      revokeReason: "CREATOR_REMOVED_FROM_AGENCY",
      managementActorMember: member,
      managementPermissionKey: "creators.manage",
      agencyAlreadyLocked: true,
      expectedUpdatedAt: p.expectedUpdatedAt,
    });
    deferCommitHint(context, `retirement:${c.targetId}`, () =>
      publishCreatorRetirementControlEvents({
        agencyId,
        creatorId: c.targetId,
        reason: "CREATOR_REMOVED_FROM_AGENCY",
        memberEpochs: result.memberEpochs,
        sourceDeviceId: deviceId,
      })
    );
    const outcome = {
      ok: true,
      creatorId: c.targetId,
      historyPreserved: true,
      alreadyRemoved: result.alreadyRetired === true,
    };
    for (const key of [
      "removedFromMemberAssignments",
      "removedFromInvitationAssignments",
      "revokedCanonicalSessionCount",
      "retiredCanonicalSessionSecretCount",
      "revokedCreatorKeyWrapCount",
      "retiredDedicatedProxyCount",
    ])
      outcome[key] = Number(result[key] || 0);
    return { humanReference: { outcome } };
  }
  throw fail("HUMAN_COMMAND_UNKNOWN", "Unsupported control action", 400);
}
async function current(tx, agencyId, member, c, ref) {
  if (c.action === "operation.control") {
    await require("./operational-command-service").authorizeExtra(tx, member, c.payload);
    return ref.humanReference.outcome;
  }
  const p = c.payload;
  if (c.action === "claims.ppv") return ref.humanReference.outcome;
  if (c.action === "claims.tip") {
    const row = await tx.teamTipLedger.findFirst({ where: { id: ref.humanReference.id, agencyId } });
    if (!row) return null;
    const [attribution] = await tips.enrichTipRows([row], agencyId, tx);
    return { ok: true, attribution };
  }

  if (["media.folder", "media.delete", "creator.retire"].includes(c.action)) return ref.humanReference.outcome;
  if (c.action === "automation.template") {
    if (ref.humanReference.deleted)
      return { ok: true, accountId: c.targetId, creatorId: c.targetId, deleted: true, item: null };
    const row = await tx.automationTask.findFirst({
      where: { agencyId, creatorId: c.targetId, id: ref.humanReference.taskId },
    });
    return row
      ? {
          ok: true,
          accountId: c.targetId,
          creatorId: c.targetId,
          item: (p.kind === "bump" ? templates.taskToBump : templates.taskToSfsComment)(row),
          task: row,
        }
      : null;
  }
  if (c.action === "traffic.cost") {
    const source = await tx.trafficSource.findFirst({ where: { id: p.sourceId, agencyId, creatorId: c.targetId } });
    return source
      ? {
          ok: true,
          source,
          recompute: { ok: true, skipped: true, reason: "LEGACY_AGGREGATE_RETIRED", days: 0, recomputedDays: 0 },
        }
      : null;
  }
  if (c.action === "automation.control") {
    const control = await tx.automationControlState.findUnique({
      where: { agencyId_scopeKey: { agencyId, scopeKey: controlKey(c) } },
    });
    return control
      ? {
          ok: true,
          control,
          ...ref.humanReference,
          snapshot: c.targetId ? await getAutomationControlSnapshot({ agencyId, creatorId: c.targetId, db: tx }) : null,
        }
      : null;
  }
  if (c.action === "media.metadata") {
    const row = await tx.creatorMediaAsset.findUnique({
      where: { creatorId_mediaId: { creatorId: c.targetId, mediaId: p.mediaId } },
    });
    return row ? { ok: true, creatorId: c.targetId, item: media.assetToMetadata(row) } : null;
  }
  if (c.action === "custom.update")
    return custom.getCustomOrder({
      agencyId,
      member,
      orderId: p.orderId,
      now: new Date(ref.humanReference.readAt),
      db: tx,
    });
  if (c.action === "custom.destination")
    return destination.getCustomVaultDestination({ agencyId, member, creatorId: c.targetId, db: tx });
  return null;
}
module.exports = { has, permissions, permission, targets, admission, lockPrefix, apply, current };
