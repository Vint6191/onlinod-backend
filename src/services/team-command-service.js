"use strict";
const crypto = require("node:crypto");
const prisma = require("../prisma");
const team = require("./team-administration-service");
const schedule = require("./team-schedule-service");
const { parseCommand, digest, permissionFor } = require("./team-command-contract");
const { runRootCommit } = require("./db-commit-kernel");
const { lockDbAdvisoryXact } = require("./db-transaction-service");
const { assertManagementCommitAuthority } = require("./management-commit-authority-service");
const { normalizeAssignedCreators, isOwner, resolveEffectivePermissions } = require("./team-access-control");
const { canUseTeamCapability, TEAM_CAPABILITIES } = require("./team-capabilities");
const { withProductBilling } = require("./product-billing-context-service");
function fail(code, message, status = 409) { return Object.assign(new Error(message), { code, status }); }
function invitationToken(agencyId, userId, command) {
  const secret = String(process.env.JWT_SECRET || "");
  if (!secret) throw fail("TEAM_COMMAND_SECRET_UNAVAILABLE", "Invitation recovery is unavailable", 503);
  // A separate cryptographic domain; no bearer token or invitation URL is stored
  // in a receipt, audit, or client journal. JWT key rotation disables recovery
  // of old links, without rotating/reissuing those invitations as a side effect.
  return crypto.createHmac("sha256", secret).update(JSON.stringify([
    "onlinod/team-invitation/v2", agencyId, userId, command.commandId, command.fingerprint,
  ])).digest("base64url");
}
async function observedScope(tx, agencyId, command) {
  const scope = { creatorIds: [], broad: false, ownerTarget: false, roleKeys: [] };
  const addScope = value => {
    const parsed = normalizeAssignedCreators(value);
    scope.broad ||= parsed.mode === "all";
    scope.creatorIds.push(...parsed.creatorIds);
  };
  const p = command.payload;
  if (command.action.startsWith("member.")) {
    const target = await tx.agencyMember.findFirst({ where: { id: command.targetId, agencyId } });
    if (target) { addScope(target.assignedCreators); scope.ownerTarget = isOwner(target); }
    if (p.assignedCreators !== undefined) addScope(p.assignedCreators);
    if (p.roleKey) scope.roleKeys.push(p.roleKey);
  } else if (command.action.startsWith("invitation.")) {
    const target = command.targetId ? await tx.agencyInvitation.findFirst({ where: { id: command.targetId, agencyId } }) : null;
    if (target) { addScope(target.assignedCreators); scope.roleKeys.push(target.roleKey); }
    if (p.assignedCreators !== undefined) addScope(p.assignedCreators);
    if (p.roleKey) scope.roleKeys.push(p.roleKey);
  } else if (command.action.startsWith("shift.")) {
    if (command.targetId) {
      const shift = await tx.teamShift.findFirst({ where: { id: command.targetId, agencyId }, include: { creators: true } });
      scope.creatorIds.push(...(shift?.creators || []).map(row => row.creatorRefId).filter(Boolean));
    }
    scope.creatorIds.push(...(p.creatorIds || []));
  }
  scope.creatorIds = [...new Set(scope.creatorIds)].sort();
  scope.roleKeys = [...new Set(scope.roleKeys)].sort();
  return scope;
}
async function replayAuthority(tx, agencyId, actorMember, command, receipt) {
  const original = receipt.authorizationScope;
  const current = await observedScope(tx, agencyId, command);
  const commit = await assertManagementCommitAuthority({
    tx, agencyId, actorMember, permissionKey: permissionFor(command.action),
    creatorIds: [...new Set([...original.creatorIds, ...current.creatorIds])].sort(),
    requireBroadCreatorScope: original.broad || current.broad,
  });
  if ((original.ownerTarget || current.ownerTarget) && !isOwner(commit.member)) throw fail("OWNER_MANAGEMENT_REQUIRED", "Only OWNER can recover this member command", 403);
  for (const roleKey of new Set([...original.roleKeys, ...current.roleKeys])) {
    await team.assertActorCanAssignRole({ agencyId, actorMember: commit.member, roleKey, db: tx });
  }
  if (receipt.result.role) team.assertRoleConfigurationWithinActor({ actorMember: commit.member,
    actorPermissions: await resolveEffectivePermissions({ member: commit.member, db: tx }), role: receipt.result.role });
  await scheduleVisibility(tx, commit.member, command);
}
async function scheduleVisibility(tx, actorMember, command) {
  if (command.action.startsWith("shift.") && !(await canUseTeamCapability({ member: actorMember, key: TEAM_CAPABILITIES.VIEW_ANALYTICS, prismaClient: tx }))) {
    throw fail("TEAM_ANALYTICS_VIEW_REQUIRED", "team.analytics.view permission is required", 403);
  }
}
async function executeDomain(context, agencyId, userId, actorMember, actorDeviceId, command) {
  const p = command.payload, id = command.targetId;
  const args = { db: context.tx, commitContext: context, agencyId, actorUserId: userId, actorMember,
    actorMemberId: actorMember.id, actorDeviceId, actorProof: command.actorProof };
  switch (command.action) {
    case "member.update": return { ok: true, member: await team.updateMemberSettings({ ...args, memberId: id, patch: p }) };
    case "member.status": return { ok: true, ...await team.setMemberStatus({ ...args, memberId: id, status: p.status }) };
    case "member.remove": return { ok: true, ...await team.removeMember({ ...args, memberId: id }), historicalAttributionPreserved: true };
    case "invitation.create": return { ok: true, ...await team.createInvitation({ ...args, input: p, invitationToken: invitationToken(agencyId, userId, command) }) };
    case "invitation.reissue": return { ok: true, ...await team.reissueInvitation({ ...args, invitationId: id, expiresInDays: p.expiresInDays, invitationToken: invitationToken(agencyId, userId, command) }) };
    case "invitation.revoke": return { ok: true, ...await team.revokeInvitation({ ...args, invitationId: id }) };
    case "role.create": return { ok: true, role: await team.createCustomRole({ ...args, input: p }) };
    case "role.update": return { ok: true, role: await team.updateRoleMetadata({ ...args, roleKey: id, input: p }) };
    case "role.access": return { ok: true, role: await team.setRoleAccess({ ...args, roleKey: id, ...p }) };
    case "role.permission": return { ok: true, role: await team.setRolePermission({ ...args, roleKey: id, ...p }) };
    case "role.reset": return { ok: true, role: await team.resetRole({ ...args, roleKey: id }) };
    case "role.delete": return { ok: true, ...await team.deleteCustomRole({ ...args, roleKey: id }) };
    case "shift.create": return schedule.createTeamShift({ ...args, input: p });
    case "shift.update": return schedule.updateTeamShift({ ...args, shiftId: id, expectedRevision: p.expectedRevision, input: p });
    case "shift.cancel": return schedule.cancelTeamShift({ ...args, shiftId: id, expectedRevision: p.expectedRevision, reason: p.reason });
    default: throw fail("TEAM_COMMAND_ACTION_INVALID", "Unknown Team action", 400);
  }
}
async function exposeResult(tx, agencyId, userId, command, receipt, replayed) {
  const result = { ...receipt.result, commandId: command.commandId, replayed };
  if (command.action === "invitation.create" || command.action === "invitation.reissue") {
    const current = await tx.agencyInvitation.findFirst({ where: { agencyId, id: result.invitation.id } });
    const token = invitationToken(agencyId, userId, command);
    const matches = current?.tokenHash === crypto.createHash("sha256").update(token).digest("hex");
    const now = await require("./db-time-authority-service").dbAuthorityNow({ db: tx });
    const available = Boolean(matches && !current.claimedAt && !current.revokedAt && new Date(current.expiresAt) > now);
    return { ...result, linkAvailable: available, token: available ? token : null,
      url: available ? team.invitationUrl(token) : null,
      ...(available ? {} : { linkUnavailableReason: "Invitation was replaced, claimed, revoked, expired, or its recovery key changed" }) };
  }
  return result;
}
async function saveReceipt(tx, id, agencyId, userId, command, status, result, authorizationScope) {
  // Raw SQL keeps the contract usable with the deployed Prisma client during a
  // rolling upgrade. The schema model mirrors this new, explicitly bounded row.
  const resultJson = JSON.stringify(result), scopeJson = JSON.stringify(authorizationScope);
  if (Buffer.byteLength(resultJson) > 2097152 || Buffer.byteLength(scopeJson) > 2097152) throw fail("TEAM_COMMAND_RESULT_TOO_LARGE", "Team result exceeds the durable receipt limit", 422);
  const inserted = await tx.$queryRawUnsafe(`INSERT INTO "TeamMutationReceipt"
    ("id","agencyId","userId","action","targetId","fingerprint","status","result","authorizationScope")
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) ON CONFLICT ("id") DO NOTHING RETURNING "id"`,
    id, agencyId, userId, command.action, command.targetId, command.fingerprint, status, resultJson, scopeJson);
  // Serializable PostgreSQL normally raises 40001 for this race. Do not allow
  // a snapshot predating the winning receipt to commit a second domain effect.
  if (inserted.length !== 1) throw Object.assign(new Error("Concurrent Team receipt"), { code: "40001" });
}
async function executeTeamCommand({ db = prisma, agencyId, userId, actorDeviceId = null, input, cancel = false }) {
  const command = parseCommand(input);
  if (!agencyId || !userId) throw fail("TEAM_COMMAND_IDENTITY_REQUIRED", "Authenticated agency and user are required", 403);
  const id = "team_v2_" + digest([agencyId, userId, command.commandId]);
  const execute = () => runRootCommit(db, async context => {
    const tx = context.tx;
    // This command-only mutex precedes every domain lock; no other family takes
    // it, so Agency/Role/Creator/User/Member domain ordering remains unchanged.
    await lockDbAdvisoryXact({ db: tx, key: id });
    const [receipt] = await tx.$queryRawUnsafe('SELECT * FROM "TeamMutationReceipt" WHERE "id"=$1', id);
    const actorMember = await tx.agencyMember.findFirst({ where: { agencyId, userId, deletedAt: null, deactivatedAt: null } });
    if (!actorMember) throw fail("NOT_A_MEMBER", "Current agency membership is required", 403);
    if (cancel) {
      await assertManagementCommitAuthority({ tx, agencyId, actorMember });
      if (receipt && receipt.fingerprint !== command.fingerprint) throw fail("TEAM_COMMAND_INTENT_MISMATCH", "Command ID belongs to a different intent");
      if (!receipt) await saveReceipt(tx, id, agencyId, userId, command, "ABANDONED", {}, {});
      return { ok: true, commandId: command.commandId, alreadyCommitted: receipt?.status === "COMMITTED", abandoned: !receipt || receipt.status === "ABANDONED" };
    }
    if (receipt) {
      await assertManagementCommitAuthorityMinimalIfAbandoned(tx, agencyId, actorMember, receipt);
      if (receipt.fingerprint !== command.fingerprint) throw fail("TEAM_COMMAND_INTENT_MISMATCH", "Command ID belongs to a different intent");
      if (receipt.status === "ABANDONED") throw fail("TEAM_COMMAND_ABANDONED", "This command was cancelled; refresh before starting another action");
      await replayAuthority(tx, agencyId, actorMember, command, receipt);
      return exposeResult(tx, agencyId, userId, command, receipt, true);
    }
    await scheduleVisibility(tx, actorMember, command);
    const authorizationScope = await observedScope(tx, agencyId, command);
    const result = await executeDomain(context, agencyId, userId, actorMember, actorDeviceId, command);
    const { token: _token, url: _url, ...persisted } = result;
    const record = { result: JSON.parse(JSON.stringify(persisted)), authorizationScope };
    await saveReceipt(tx, id, agencyId, userId, command, "COMMITTED", persisted, authorizationScope);
    return exposeResult(tx, agencyId, userId, command, record, false);
  }, { profile: "TEAM_MANAGEMENT", authority: { kind: "TEAM_MANAGEMENT", agencyId, userId },
    conflictCode: "TEAM_COMMAND_RETRY", conflictMessage: "Team state changed concurrently; retry this same command" });
  return !cancel && command.action.startsWith("shift.") ? withProductBilling(agencyId, execute) : execute();
}
async function assertManagementCommitAuthorityMinimalIfAbandoned(tx, agencyId, actorMember, receipt) {
  if (receipt.status === "ABANDONED") await assertManagementCommitAuthority({ tx, agencyId, actorMember });
}
module.exports = { executeTeamCommand };
