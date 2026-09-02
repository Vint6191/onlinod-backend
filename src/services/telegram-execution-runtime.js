"use strict";

const crypto = require("node:crypto");
const { allowedCreatorScope, requireCreatorAccess } = require("../middleware/automation-permissions");
const { resolveTelegramAccountId } = require("./custom-order-reminders");
const { assertExecutionAccessFence } = require("./execution-access-fence-service");

const RUNTIME_LEASE_MS = 90 * 1000;
const MAX_RUNTIME_CLAIMS = 100;

function fail(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function clean(value, max = 180) { const text = String(value == null ? "" : value).trim(); return text ? text.slice(0, max) : ""; }

async function eligibleTelegramExecutionAccounts({ agencyId, member, db }) {
  const scope = await allowedCreatorScope({ agencyId, member, db });
  const creators = await db.creatorAccount.findMany({
    where: {
      agencyId,
      deletedAt: null,
      ...(scope.broad ? {} : { id: { in: scope.creatorIds.length ? scope.creatorIds : ["__none__"] } }),
      telegramContact: { not: null },
    },
    select: { id: true, telegramAccountId: true },
    take: 10000,
  });
  if (!creators.length) return [];
  const accounts = await db.agencyTelegramMtprotoAccount.findMany({ where: { agencyId }, select: { id: true }, orderBy: { id: "asc" }, take: 100 });
  if (!accounts.length) return [];
  const existing = new Set(accounts.map((row) => String(row.id)));
  const singleAccountId = accounts.length === 1 ? String(accounts[0].id) : null;
  const byAccount = new Map();
  for (const creator of creators) {
    const assigned = clean(creator.telegramAccountId);
    const accountId = assigned && existing.has(assigned) ? assigned : (!assigned && singleAccountId ? singleAccountId : null);
    if (!accountId || byAccount.has(accountId)) continue;
    byAccount.set(accountId, { accountId, anchorCreatorId: String(creator.id) });
  }
  return [...byAccount.values()];
}

async function assertTelegramMessagingAccess({ agencyId, member, accountId, creatorId, db }) {
  const normalizedAccountId = clean(accountId);
  const normalizedCreatorId = clean(creatorId);
  if (!normalizedAccountId || !normalizedCreatorId) throw fail("TELEGRAM_EXECUTION_SCOPE_REQUIRED", "Telegram account and creator are required");
  const creator = await requireCreatorAccess({ agencyId, member, creatorId: normalizedCreatorId, db });
  const fullCreator = await db.creatorAccount.findFirst({
    where: { id: creator.id, agencyId, deletedAt: null },
    select: { id: true, telegramContact: true, telegramAccountId: true },
  });
  if (!fullCreator || !clean(fullCreator.telegramContact, 160)) throw fail("TELEGRAM_EXECUTION_CREATOR_CONTACT_REQUIRED", "This creator has no Telegram contact", 409);
  const resolvedAccountId = await resolveTelegramAccountId({ agencyId, creator: fullCreator, db });
  if (!resolvedAccountId || String(resolvedAccountId) !== normalizedAccountId) {
    throw fail("TELEGRAM_EXECUTION_ACCOUNT_FORBIDDEN", "This Telegram account is not assigned to this creator", 403);
  }
  return { creator: fullCreator, accountId: normalizedAccountId };
}

async function claimTelegramExecutionRuntimes({ agencyId, member, deviceId, accountId = null, limit = MAX_RUNTIME_CLAIMS, now = new Date(), db }) {
  const normalizedDeviceId = clean(deviceId, 180);
  if (!normalizedDeviceId) throw fail("TELEGRAM_EXECUTION_DEVICE_REQUIRED", "deviceId is required");
  const actor = { userId: clean(member?.userId, 180), memberId: clean(member?.id, 180), accessEpoch: Number(member?.accessEpoch) };
  if (!actor.userId || !actor.memberId || !Number.isInteger(actor.accessEpoch)) throw fail("TELEGRAM_EXECUTION_ACCESS_FENCE_REQUIRED", "Current member access fence is required", 409);
  const eligible = await eligibleTelegramExecutionAccounts({ agencyId, member, db });
  const requestedAccountId = clean(accountId, 180);
  const candidates = requestedAccountId
    ? eligible.filter((candidate) => candidate.accountId === requestedAccountId)
    : eligible;
  if (requestedAccountId && candidates.length === 0) {
    throw fail("TELEGRAM_EXECUTION_ACCOUNT_FORBIDDEN", "This member has no creator access through this Telegram account", 403);
  }
  const take = Math.max(1, Math.min(MAX_RUNTIME_CLAIMS, Math.floor(Number(limit) || MAX_RUNTIME_CLAIMS)));
  const leases = [];
  for (const candidate of candidates.slice(0, take * 3)) {
    if (leases.length >= take) break;
    const account = await db.agencyTelegramMtprotoAccount.findFirst({
      where: { id: candidate.accountId, agencyId },
      select: { id: true, runtimeClaimedByDeviceId: true, runtimeClaimToken: true, runtimeClaimUntil: true, runtimeLeaseUserId: true, runtimeLeaseMemberId: true, runtimeLeaseAccessEpoch: true, runtimeLeaseCreatorId: true },
    });
    if (!account) continue;
    await assertExecutionAccessFence({ db, agencyId, creatorId: candidate.anchorCreatorId, ...actor, lock: true });
    const existingOwned = String(account.runtimeClaimedByDeviceId || "") === normalizedDeviceId
      && String(account.runtimeLeaseUserId || "") === actor.userId
      && String(account.runtimeLeaseMemberId || "") === actor.memberId
      && Number(account.runtimeLeaseAccessEpoch) === actor.accessEpoch
      && String(account.runtimeLeaseCreatorId || "") === String(candidate.anchorCreatorId)
      && String(account.runtimeClaimToken || "")
      && account.runtimeClaimUntil
      && new Date(account.runtimeClaimUntil).getTime() > now.getTime();
    const claimToken = existingOwned ? String(account.runtimeClaimToken) : crypto.randomUUID();
    const claimUntil = new Date(now.getTime() + RUNTIME_LEASE_MS);
    const changed = await db.agencyTelegramMtprotoAccount.updateMany({
      where: {
        id: account.id,
        agencyId,
        OR: [
          { runtimeClaimUntil: null },
          { runtimeClaimUntil: { lt: now } },
          { runtimeClaimedByDeviceId: normalizedDeviceId },
        ],
      },
      data: {
        runtimeClaimedByDeviceId: normalizedDeviceId,
        runtimeClaimToken: claimToken,
        runtimeClaimUntil: claimUntil,
        runtimeLeaseUserId: actor.userId,
        runtimeLeaseMemberId: actor.memberId,
        runtimeLeaseAccessEpoch: actor.accessEpoch,
        runtimeLeaseCreatorId: candidate.anchorCreatorId,
      },
    });
    if (Number(changed?.count || 0) !== 1) continue;
    leases.push({ accountId: account.id, anchorCreatorId: candidate.anchorCreatorId, claimToken, claimUntil: claimUntil.toISOString() });
  }
  return { ok: true, leases, serverNow: now.toISOString(), leaseMs: RUNTIME_LEASE_MS };
}

async function assertTelegramRuntimeLease({ agencyId, member, accountId, deviceId, claimToken, now = new Date(), db }) {
  const normalizedAccountId = clean(accountId);
  const normalizedDeviceId = clean(deviceId);
  const normalizedToken = clean(claimToken, 180);
  if (!normalizedAccountId || !normalizedDeviceId || !normalizedToken) throw fail("TELEGRAM_EXECUTION_LEASE_REQUIRED", "Telegram runtime lease is required", 409);
  const eligible = await eligibleTelegramExecutionAccounts({ agencyId, member, db });
  const anchor = eligible.find((row) => row.accountId === normalizedAccountId);
  if (!anchor) throw fail("TELEGRAM_EXECUTION_ACCOUNT_FORBIDDEN", "This member has no creator access through this Telegram account", 403);
  const account = await db.agencyTelegramMtprotoAccount.findFirst({
    where: { id: normalizedAccountId, agencyId },
    select: { id: true, runtimeClaimedByDeviceId: true, runtimeClaimToken: true, runtimeClaimUntil: true, runtimeLeaseUserId: true, runtimeLeaseMemberId: true, runtimeLeaseAccessEpoch: true, runtimeLeaseCreatorId: true },
  });
  const valid = account
    && String(account.runtimeClaimedByDeviceId || "") === normalizedDeviceId
    && String(account.runtimeClaimToken || "") === normalizedToken
    && String(account.runtimeLeaseUserId || "") === String(member?.userId || "")
    && String(account.runtimeLeaseMemberId || "") === String(member?.id || "")
    && Number(account.runtimeLeaseAccessEpoch) === Number(member?.accessEpoch)
    && String(account.runtimeLeaseCreatorId || "") === String(anchor.anchorCreatorId)
    && account.runtimeClaimUntil
    && new Date(account.runtimeClaimUntil).getTime() > now.getTime();
  if (!valid) throw fail("TELEGRAM_EXECUTION_LEASE_INVALID", "Telegram runtime lease is no longer valid", 409);
  await assertExecutionAccessFence({
    db,
    agencyId,
    creatorId: anchor.anchorCreatorId,
    userId: member?.userId,
    memberId: member?.id,
    accessEpoch: member?.accessEpoch,
    lock: true,
  });
  return { account, anchorCreatorId: anchor.anchorCreatorId };
}

async function releaseTelegramExecutionRuntime({ agencyId, member, accountId, deviceId, claimToken, now = new Date(), db }) {
  const normalizedAccountId = clean(accountId);
  const normalizedDeviceId = clean(deviceId);
  const normalizedToken = clean(claimToken, 180);
  await assertTelegramRuntimeLease({ agencyId, member, accountId: normalizedAccountId, deviceId: normalizedDeviceId, claimToken: normalizedToken, now, db });
  const changed = await db.agencyTelegramMtprotoAccount.updateMany({
    where: { id: normalizedAccountId, agencyId, runtimeClaimedByDeviceId: normalizedDeviceId, runtimeClaimToken: normalizedToken },
    data: {
      runtimeClaimedByDeviceId: null,
      runtimeClaimToken: null,
      runtimeClaimUntil: null,
      runtimeLeaseUserId: null,
      runtimeLeaseMemberId: null,
      runtimeLeaseAccessEpoch: null,
      runtimeLeaseCreatorId: null,
    },
  });
  return { ok: true, released: Number(changed?.count || 0) === 1 };
}

module.exports = {
  RUNTIME_LEASE_MS,
  eligibleTelegramExecutionAccounts,
  assertTelegramMessagingAccess,
  claimTelegramExecutionRuntimes,
  assertTelegramRuntimeLease,
  releaseTelegramExecutionRuntime,
};
