"use strict";
const { parseManagementCommand, fail } = require("./management-command-contract");
const { digest } = require("./team-command-contract");
const { runRootCommit, deferCommitHint } = require("./db-commit-kernel");
const { lockDbAdvisoryXact } = require("./db-transaction-service");
const { assertManagementCommitAuthority, lockAgencyLifecycle } = require("./management-commit-authority-service");
const { createCreatorDraft, beginCreatorConnection } = require("./creator-enrollment-authority-service");
const { updateCreatorMetadata } = require("./creator-metadata-service");
const {
  lockEligibleAccountUser,
  updateAccountProfile,
  getWorkspaceSettings,
  updateWorkspaceSettings,
} = require("./settings-service");
const { publicUser } = require("./auth-service");
const { audit } = require("./audit-service");
const network = require("./creator-network-profile-service");
const billingControl = require("./billing-control-command-service");
const { lockAgencyBillingMutation } = require("./billing-entitlement-service");
const { updateCreatorTelegramContact } = require("./creator-telegram-contact-authority-service");
const { publishDesktopControlEvent } = require("./desktop-control-events");

const stable = (value) => JSON.parse(JSON.stringify(value));
const boundedResult = (value) => value !== null && Buffer.byteLength(JSON.stringify(value)) <= 256 * 1024;
async function creatorScope(tx, agencyId, c, ref) {
  const ids = new Set(ref?.creatorIds || []);
  if (
    [
      "creator.update",
      "creator.beginConnection",
      "creator.telegramContact",
      "network.create",
      "network.assign",
    ].includes(c.action) ||
    c.action.startsWith("billing.")
  )
    ids.add(c.targetId);
  if (["network.update", "network.delete"].includes(c.action)) {
    const proxy = await tx.agencyProxyEndpoint.findFirst({ where: { agencyId, id: c.targetId } });
    if (proxy?.ownerCreatorId) ids.add(proxy.ownerCreatorId);
    const assigned = await tx.creatorNetworkProfile.findFirst({
      where: { agencyId, proxyEndpointId: c.targetId, mode: "PROXY" },
      select: { creatorId: true },
    });
    if (assigned) ids.add(assigned.creatorId);
  }
  return [...ids].sort();
}
async function currentResult(tx, agencyId, userId, member, c, ref) {
  if (c.action.startsWith("billing.")) return billingControl.currentBillingControl(tx, agencyId, c, ref);
  if (c.action === "account.profile") {
    const row = await tx.user.findUnique({ where: { id: userId } });
    return row ? { ok: true, user: publicUser(row) } : null;
  }
  if (c.action === "workspace.update")
    return { ok: true, ...(await getWorkspaceSettings({ db: tx, agencyId, member })) };
  if (c.action.startsWith("creator.")) {
    const creator = await tx.creatorAccount.findFirst({ where: { id: ref.creatorId, agencyId, deletedAt: null } });
    return creator
      ? {
          ok: true,
          creator,
          ...(c.action === "creator.beginConnection"
            ? {
                mode: ref.connectionMode,
                connectionGeneration: ref.connectionGeneration,
                unchanged: ref.unchanged,
              }
            : {}),
        }
      : null;
  }
  if (c.action === "network.delete") return ref.deletion;
  if (c.action === "network.assign")
    return {
      ok: true,
      profile: await network.getCreatorNetworkManifest({ db: tx, agencyId, creatorId: c.targetId }),
      unchanged: ref.unchanged,
    };
  const proxy = await tx.agencyProxyEndpoint.findFirst({ where: { agencyId, id: ref.proxyId } });
  if (!proxy) return null;
  return {
    ok: true,
    proxy: network.proxyPublic(proxy),
    ...(c.action === "network.create"
      ? { profile: await network.getCreatorNetworkManifest({ db: tx, agencyId, creatorId: c.targetId }) }
      : { unchanged: ref.unchanged, runtimeChanged: ref.runtimeChanged }),
  };
}
async function apply(tx, agencyId, userId, member, deviceId, c) {
  const p = c.payload;
  if (c.action.startsWith("billing.")) return billingControl.applyBillingControl(tx, agencyId, userId, member, c);
  if (c.action === "creator.beginConnection")
    return {
      ok: true,
      ...(await beginCreatorConnection({
        db: tx,
        agencyId,
        creatorId: c.targetId,
        userId,
        actorMember: member,
        ...p,
      })),
    };
  if (c.action === "creator.telegramContact")
    return {
      ok: true,
      creator: await updateCreatorTelegramContact({
        db: tx,
        agencyId,
        creatorId: c.targetId,
        actorUserId: userId,
        actorMember: member,
        ...p,
      }),
    };
  if (c.action === "account.profile")
    return { ok: true, user: await updateAccountProfile({ db: tx, agencyId, userId, ...p }) };
  if (c.action === "workspace.update")
    return {
      ok: true,
      ...(await updateWorkspaceSettings({
        db: tx,
        agencyId,
        actorUserId: userId,
        member,
        patch: p,
        expectedRevision: p.expectedRevision,
      })),
    };
  if (c.action === "creator.create") return { ok: true, creator: await createCreatorDraft({ db: tx, agencyId, ...p }) };
  if (c.action === "creator.update")
    return {
      ok: true,
      creator: await updateCreatorMetadata({ db: tx, agencyId, actorMember: member, creatorId: c.targetId, input: p }),
    };
  const common = { db: tx, agencyId, actorUserId: userId, actorMember: member, deviceId };
  if (c.action === "network.create")
    return {
      ok: true,
      ...(await network.createProxyForCreator({
        ...common,
        creatorId: c.targetId,
        expectedNetworkVersion: p.expectedNetworkVersion,
        input: p,
      })),
    };
  if (c.action === "network.update")
    return {
      ok: true,
      ...(await network.updateProxyEndpoint({
        ...common,
        proxyId: c.targetId,
        expectedVersion: p.expectedVersion,
        patch: p,
      })),
    };
  if (c.action === "network.delete")
    return {
      ok: true,
      ...(await network.deleteProxyEndpoint({ ...common, proxyId: c.targetId, expectedVersion: p.expectedVersion })),
    };
  return { ok: true, ...(await network.setCreatorNetworkProfile({ ...common, creatorId: c.targetId, ...p })) };
}
async function executeManagementCommand({ db, agencyId, userId, actorMember, deviceId = null, input, cancel = false }) {
  if (!agencyId || !userId || actorMember?.userId !== userId || !actorMember?.id)
    throw fail("MANAGEMENT_COMMAND_ACTOR_REQUIRED", "Current membership is required", 403);
  const c = parseManagementCommand(input, { cancel });
  if (
    !cancel &&
    ["network.create", "network.update", "creator.beginConnection"].includes(c.action) &&
    (!deviceId || deviceId !== c.payload.deviceId)
  )
    throw fail(
      c.action === "creator.beginConnection"
        ? "CREATOR_CONNECTION_AUTH_DEVICE_MISMATCH"
        : "NETWORK_AUTH_DEVICE_MISMATCH",
      "Command belongs to another device",
      403
    );
  const id = "management_v1_" + digest([agencyId, userId, c.commandId]);
  return runRootCommit(
    db,
    async (context) => {
      const tx = context.tx;
      await lockAgencyLifecycle({ tx, agencyId });
      // Billing owns Agency FOR UPDATE before creator/member/business rows.
      if (!cancel && c.action.startsWith("billing.")) await lockAgencyBillingMutation(tx, agencyId);
      await lockDbAdvisoryXact({ db: tx, key: id });
      const [prior] = await tx.$queryRawUnsafe('SELECT * FROM "ManagementCommandReceipt" WHERE "id"=$1', id);
      if (prior && prior.fingerprint !== c.fingerprint)
        throw fail("MANAGEMENT_COMMAND_CONFLICT", "Command ID belongs to a different intent");
      const creatorIds = cancel ? [] : await creatorScope(tx, agencyId, c, prior?.reference);
      // Match account setters' User-lock order, including across agencies. No User
      // FOR SHARE -> advisory-lock inversion when the existing setter joins.
      if (!cancel && c.action === "account.profile") await lockEligibleAccountUser(tx, userId);
      if (!cancel && c.action === "workspace.update")
        await lockDbAdvisoryXact({ db: tx, key: `workspace-settings:${agencyId}` });
      // Writers that later UPDATE CreatorAccount must not first take FOR SHARE
      // and then deadlock while upgrading alongside another command.
      if (!cancel && ["creator.update", "creator.beginConnection", "creator.telegramContact"].includes(c.action))
        await tx.$queryRawUnsafe(
          'SELECT "id" FROM "CreatorAccount" WHERE "id"=$1 AND "agencyId"=$2 AND "deletedAt" IS NULL FOR UPDATE',
          c.targetId,
          agencyId
        );
      const authority = await assertManagementCommitAuthority({
        tx,
        agencyId,
        actorMember,
        agencyAlreadyLocked: true,
        creatorIds,
        permissionKey:
          cancel || c.action === "account.profile" || c.action.startsWith("billing.")
            ? null
            : c.action === "workspace.update"
              ? "workspace.manage_settings"
              : "creators.manage",
        requireBroadCreatorScope: !cancel && c.action === "creator.create",
      });
      if (!cancel && c.action.startsWith("billing.")) billingControl.assertBillingOwner(authority.member);
      const store = async (status, reference) => {
        const encoded = JSON.stringify(reference);
        if (Buffer.byteLength(encoded) > 8192)
          throw fail("MANAGEMENT_COMMAND_RECEIPT_LIMIT", "Receipt exceeds limit", 500);
        await tx.$executeRawUnsafe(
          'INSERT INTO "ManagementCommandReceipt" ("id","agencyId","userId","action","targetId","fingerprint","status","reference") VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',
          id,
          agencyId,
          userId,
          c.action,
          c.targetId,
          c.fingerprint,
          status,
          encoded
        );
      };
      if (cancel) {
        if (!prior) await store("ABANDONED", {});
        return {
          ok: true,
          commandId: c.commandId,
          alreadyCommitted: prior?.status === "COMMITTED",
          abandoned: !prior || prior.status === "ABANDONED",
        };
      }
      if (prior?.status === "ABANDONED") throw fail("MANAGEMENT_COMMAND_ABANDONED", "This command was cancelled");
      if (prior) {
        const current = await currentResult(tx, agencyId, userId, authority.member, c, prior.reference);
        const available = boundedResult(current) && digest(stable(current)) === prior.reference.resultDigest;
        return {
          ok: true,
          commandId: c.commandId,
          action: c.action,
          replayed: true,
          resultUnavailable: !available,
          result: available ? stable(current) : null,
        };
      }
      const value = await apply(tx, agencyId, userId, authority.member, deviceId, c);
      // No snapshots of notes, names or ciphertext in the receipt. These belong to
      // their canonical rows. Recovery compares a digest under fresh authority.
      const reference = {
        creatorIds,
        ...(value.billingReference ? { billingReference: value.billingReference } : {}),
        ...(c.action === "creator.beginConnection"
          ? { connectionMode: value.mode, connectionGeneration: value.connectionGeneration }
          : {}),
        ...(value.creator
          ? { creatorId: value.creator.id, creatorIds: [...new Set([...creatorIds, value.creator.id])] }
          : {}),
        ...(value.proxy ? { proxyId: value.proxy.id } : {}),
        ...(value.unchanged !== undefined ? { unchanged: value.unchanged } : {}),
        ...(value.runtimeChanged !== undefined ? { runtimeChanged: value.runtimeChanged } : {}),
        ...(c.action === "network.delete"
          ? { deletion: { ok: true, deleted: value.deleted, alreadyDeleted: value.alreadyDeleted } }
          : {}),
      };
      // Use the same public projection at commit and replay; domain helper-only
      // actor fields never become a response or change the digest.
      const projection = await currentResult(tx, agencyId, userId, authority.member, c, reference);
      if (!boundedResult(projection))
        throw fail("MANAGEMENT_COMMAND_RESULT_LIMIT", "Canonical result exceeds the response limit", 413);
      const result = stable(projection);
      await audit({
        required: true,
        db: tx,
        agencyId,
        actorUserId: userId,
        action: "management_command.committed",
        targetType: c.action,
        targetId: value.creator?.id || value.proxy?.id || c.targetId || agencyId,
        metadata: { commandId: c.commandId },
      });
      await store("COMMITTED", { ...reference, resultDigest: digest(result) });
      if (c.action.startsWith("network.")) {
        for (const creatorId of creatorIds) {
          const profile = await tx.creatorNetworkProfile.findUnique({
            where: { agencyId_creatorId: { agencyId, creatorId } },
          });
          if (profile)
            deferCommitHint(context, `network:${creatorId}`, () =>
              publishDesktopControlEvent({
                type: "NETWORK_REVISION_CHANGED",
                agencyId,
                creatorId,
                networkVersion: profile.version,
                sourceDeviceId: deviceId,
              })
            );
        }
      }
      return { ok: true, commandId: c.commandId, action: c.action, replayed: false, resultUnavailable: false, result };
    },
    { profile: "SECRET_WRITE", authority: { kind: "MANAGEMENT_COMMAND", agencyId, userId }, maxAttempts: 1 }
  );
}
module.exports = { executeManagementCommand };
