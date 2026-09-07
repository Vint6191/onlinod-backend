"use strict";

const { audit } = require("./audit-service");
const { requireCreatorAccess } = require("../middleware/automation-permissions");
const { canUsePermission } = require("./team-access-control");
const { lockCustomExecutionDefaults } = require("./custom-content-pipeline-authority-service");

const MAX_FOLDER_ID = 180;

function fail(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function creatorId(value) { const text = String(value == null ? "" : value).trim(); if (!text) throw fail("CUSTOM_VAULT_CREATOR_REQUIRED", "creatorId is required"); if (text.length > 180) throw fail("CUSTOM_VAULT_CREATOR_INVALID", "creatorId is too long"); return text; }
function folderId(value) {
  if (value === null || value === undefined || value === "") return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > MAX_FOLDER_ID) throw fail("CUSTOM_VAULT_FOLDER_ID_INVALID", `folderId is too long (max ${MAX_FOLDER_ID} characters)`);
  const lower = text.toLowerCase();
  if (lower === "all" || lower === "unsorted") throw fail("CUSTOM_VAULT_FOLDER_ID_INVALID", "A custom Vault folder is required");
  return text;
}
function serialize(row) {
  const value = row?.customsVaultFolderId == null ? null : String(row.customsVaultFolderId).trim() || null;
  return { ok: true, creatorId: String(row?.id || ""), folderId: value, configured: Boolean(value) };
}

async function getCustomVaultDestination({ agencyId, member, creatorId: rawCreatorId, db = null } = {}) {
  const client = db || require("../prisma");
  const cid = creatorId(rawCreatorId);
  await requireCreatorAccess({ agencyId, member, creatorId: cid, db: client });
  const row = await client.creatorAccount.findFirst({ where: { id: cid, agencyId, deletedAt: null }, select: { id: true, customsVaultFolderId: true } });
  if (!row) throw fail("CUSTOM_VAULT_CREATOR_NOT_FOUND", "Creator not found", 404);
  return serialize(row);
}

async function setCustomVaultDestination({ agencyId, member, creatorId: rawCreatorId, folderId: rawFolderId, db = null } = {}) {
  const client = db || require("../prisma");
  const cid = creatorId(rawCreatorId);
  const nextFolderId = folderId(rawFolderId);
  await requireCreatorAccess({ agencyId, member, creatorId: cid, db: client });
  if (!(await canUsePermission({ member, key: "content.manage_vault", db: client }))) {
    throw fail("CUSTOM_VAULT_DESTINATION_FORBIDDEN", "Vault management permission is required", 403);
  }

  const apply = async (tx) => {
    // Lock-order invariant: mutate the Creator row first, then join the execution-default
    // advisory fence before COMMIT. First-profile pinning may already hold a Submission
    // row when it waits on this fence; taking advisory -> Creator here would permit
    // Submission -> advisory -> Creator -> Submission deadlocks with cancellation.
    //
    // Linearization is still exact: while this transaction waits for the advisory lock
    // its Creator update is uncommitted/invisible. A pin that owns the advisory lock can
    // only observe the old committed default and commits first; otherwise this setter
    // acquires the fence and commits before the pin, which then observes the new default.
    const current = await tx.creatorAccount.findFirst({ where: { id: cid, agencyId, deletedAt: null }, select: { id: true, customsVaultFolderId: true, updatedAt: true } });
    if (!current) throw fail("CUSTOM_VAULT_CREATOR_NOT_FOUND", "Creator not found", 404);
    const previousFolderId = current.customsVaultFolderId == null ? null : String(current.customsVaultFolderId).trim() || null;
    if (previousFolderId === nextFolderId) {
      return { previousFolderId, creator: { id: cid, customsVaultFolderId: nextFolderId } };
    }
    const changed = await tx.creatorAccount.updateMany({ where: { id: cid, agencyId, deletedAt: null, updatedAt: current.updatedAt }, data: { customsVaultFolderId: nextFolderId } });
    if (Number(changed?.count || 0) !== 1) throw fail("CUSTOM_VAULT_DESTINATION_CONFLICT", "Creator Vault destination changed concurrently; reload and retry", 409);
    await lockCustomExecutionDefaults({ db: tx, agencyId });
    return { previousFolderId, creator: { id: cid, customsVaultFolderId: nextFolderId } };
  };

  const outcome = typeof client.$transaction === "function"
    ? await client.$transaction(apply, { timeout: 35_000 })
    : await apply(client);
  await audit({
    agencyId,
    actorUserId: member?.userId || null,
    action: "custom_order.vault_destination_update",
    entityType: "creator_account",
    entityId: cid,
    metadata: { previousFolderId: outcome.previousFolderId, folderId: nextFolderId },
  }).catch(() => undefined);
  return serialize(outcome.creator);
}

module.exports = { getCustomVaultDestination, setCustomVaultDestination };
