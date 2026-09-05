"use strict";

const crypto = require("node:crypto");
const { allowedCreatorScope, requireCreatorAccess } = require("../middleware/automation-permissions");
const { resolveTelegramAccountId } = require("./custom-order-reminders");
const { assertExecutionAccessFence } = require("./execution-access-fence-service");
const { activeLifecycleWhere } = require("./telegram-account-reference-authority-service");
const { scanAllById, findPendingTaskAnchors, scanIncompleteTelegramSources, scanActiveFollowupIntents, fetchAccountRowsByIds } = require("./telegram-exact-authority-scan-service");

const RUNTIME_LEASE_MS = 90 * 1000;
const MAX_RUNTIME_CLAIMS = 100;

function fail(code, message, status = 400) { return Object.assign(new Error(message), { code, status }); }
function clean(value, max = 180) { const text = String(value == null ? "" : value).trim(); return text ? text.slice(0, max) : ""; }

async function eligibleTelegramExecutionAccounts({ agencyId, member, db, includeRetiring = false }) {
  const scope = await allowedCreatorScope({ agencyId, member, db });
  const creators = [];
  await scanAllById({
    delegate: db.creatorAccount,
    where: {
      agencyId,
      deletedAt: null,
      ...(scope.broad ? {} : { id: { in: scope.creatorIds.length ? scope.creatorIds : ["__none__"] } }),
      telegramContact: { not: null },
    },
    select: { id: true, telegramAccountId: true },
    onPage: async (rows) => { creators.push(...rows); return false; },
  });
  if (!creators.length) return [];

  const creatorIds = creators.map((row) => String(row.id));
  const rawCandidates = new Map();
  const mergeRawCandidate = ({ accountId, anchorCreatorId, messagingEligible = false, inboundEligible = false }) => {
    const normalizedAccountId = clean(accountId);
    const normalizedCreatorId = clean(anchorCreatorId);
    if (!normalizedAccountId || !normalizedCreatorId) return;
    const current = rawCandidates.get(normalizedAccountId);
    if (current) {
      current.messagingEligible = current.messagingEligible === true || messagingEligible === true;
      current.inboundEligible = current.inboundEligible === true || inboundEligible === true;
      return;
    }
    rawCandidates.set(normalizedAccountId, {
      accountId: normalizedAccountId,
      anchorCreatorId: normalizedCreatorId,
      messagingEligible: messagingEligible === true,
      inboundEligible: inboundEligible === true,
    });
  };

  const explicitAssignedIds = Array.from(new Set(creators.map((row) => clean(row.telegramAccountId)).filter(Boolean)));
  const explicitRows = await fetchAccountRowsByIds({ agencyId, accountIds: explicitAssignedIds, db });
  const explicitActive = new Set(explicitRows
    .filter((row) => String(row?.lifecycleState || "ACTIVE").toUpperCase() === "ACTIVE")
    .map((row) => String(row.id)));

  const autoCreators = creators.filter((row) => !clean(row.telegramAccountId));
  let autoAccountId = null;
  if (autoCreators.length && db.agencyTelegramMtprotoAccount?.findMany) {
    const activeRows = await db.agencyTelegramMtprotoAccount.findMany({
      where: { agencyId, ...activeLifecycleWhere() },
      select: { id: true, lifecycleState: true },
      orderBy: { id: "asc" },
      take: 2,
    });
    if ((activeRows || []).length === 1) autoAccountId = String(activeRows[0].id);
  }

  for (const creator of creators) {
    const assigned = clean(creator.telegramAccountId);
    const accountId = assigned ? (explicitActive.has(assigned) ? assigned : null) : autoAccountId;
    if (!accountId) continue;
    mergeRawCandidate({ accountId, anchorCreatorId: String(creator.id), messagingEligible: true, inboundEligible: true });
  }

  // Historical Telegram source work is exact: cursor to exhaustion, never first-N sampling.
  await scanIncompleteTelegramSources({
    agencyId,
    creatorIds,
    db,
    onRow: async (row) => {
      mergeRawCandidate({ accountId: row.telegramSourceAccountId, anchorCreatorId: String(row.creatorId), messagingEligible: false, inboundEligible: false });
      return false;
    },
  });

  // Follow-up execution only needs current unresolved states. Drain them to exhaustion rather
  // than letting old row count determine whether a required pinned account is discovered.
  await scanActiveFollowupIntents({
    agencyId,
    creatorIds,
    db,
    onRow: async (row) => {
      mergeRawCandidate({ accountId: row.accountId, anchorCreatorId: String(row.creatorId), messagingEligible: false, inboundEligible: false });
      return false;
    },
  });

  // Pending TASK thread discovery starts from CURRENT PENDING orders. Historical terminal TASK
  // volume therefore cannot hide the one active thread that still needs inbound capability.
  const pendingTaskAnchors = await findPendingTaskAnchors({ agencyId, creatorIds, db });
  for (const row of pendingTaskAnchors) {
    mergeRawCandidate({ accountId: row.accountId, anchorCreatorId: String(row.creatorId), messagingEligible: false, inboundEligible: true });
  }

  if (!rawCandidates.size) return [];
  const accountRows = await fetchAccountRowsByIds({ agencyId, accountIds: [...rawCandidates.keys()], db });
  const allowed = new Set(accountRows.filter((row) => {
    const state = String(row?.lifecycleState || "ACTIVE").toUpperCase();
    return includeRetiring ? state === "ACTIVE" || state === "RETIRING" : state === "ACTIVE";
  }).map((row) => String(row.id)));

  return [...rawCandidates.values()].filter((candidate) => allowed.has(candidate.accountId));
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
  const lifecycle = await db.agencyTelegramMtprotoAccount.findFirst({ where: { id: normalizedAccountId, agencyId }, select: { id: true, lifecycleState: true } });
  if (!lifecycle || String(lifecycle.lifecycleState || "ACTIVE") !== "ACTIVE") {
    throw fail("TELEGRAM_EXECUTION_ACCOUNT_RETIRING", "This Telegram account is retiring and cannot accept new messaging work", 409);
  }
  return { creator: fullCreator, accountId: normalizedAccountId };
}

async function claimTelegramExecutionRuntimes({ agencyId, member, deviceId, accountId = null, limit = MAX_RUNTIME_CLAIMS, now = new Date(), db }) {
  const normalizedDeviceId = clean(deviceId, 180);
  if (!normalizedDeviceId) throw fail("TELEGRAM_EXECUTION_DEVICE_REQUIRED", "deviceId is required");
  const actor = { userId: clean(member?.userId, 180), memberId: clean(member?.id, 180), accessEpoch: Number(member?.accessEpoch) };
  if (!actor.userId || !actor.memberId || !Number.isInteger(actor.accessEpoch)) throw fail("TELEGRAM_EXECUTION_ACCESS_FENCE_REQUIRED", "Current member access fence is required", 409);

  // New work only considers ACTIVE accounts. RETIRING accounts are reintroduced below only when
  // this exact signed Desktop already owns their runtime identity; that path exists solely so a
  // crash/restart can finish the durable inbound-outbox drain. It is never a new retirement claim.
  const activeEligible = await eligibleTelegramExecutionAccounts({ agencyId, member, db });
  const candidateById = new Map(activeEligible.map((candidate) => [candidate.accountId, { ...candidate, retiring: false, drainOnly: false }]));
  if (db.agencyTelegramMtprotoAccount?.findMany) {
    // A local SQLite observation can outlive every server-visible reason that originally made an
    // ACTIVE account eligible (for example the creator was reassigned immediately after the helper
    // persisted a provider message). The backend cannot inspect that local durability. Preserve one
    // narrow recovery capability for the exact signed owner of an undrained generation so it can
    // replay already-durable observations and certify drained=true. This is never generic messaging
    // or new inbound intake and it never transfers to another Desktop.
    const undrainedOwned = await db.agencyTelegramMtprotoAccount.findMany({
      where: {
        agencyId,
        lifecycleState: "ACTIVE",
        runtimeClaimedByDeviceId: normalizedDeviceId,
        runtimeLeaseUserId: actor.userId,
        runtimeLeaseMemberId: actor.memberId,
        runtimeLeaseAccessEpoch: actor.accessEpoch,
      },
      select: { id: true, runtimeLeaseCreatorId: true, runtimeClaimGeneration: true, runtimeDrainedGeneration: true, runtimeClaimInboundEligible: true },
      take: MAX_RUNTIME_CLAIMS,
    });
    for (const row of undrainedOwned || []) {
      const claimGeneration = Math.max(0, Number(row.runtimeClaimGeneration) || 0);
      const drainedGeneration = Math.max(0, Number(row.runtimeDrainedGeneration) || 0);
      if (claimGeneration <= drainedGeneration || row.runtimeClaimInboundEligible !== true) continue;
      const anchorCreatorId = clean(row.runtimeLeaseCreatorId, 180);
      if (!anchorCreatorId) continue;
      try {
        await assertExecutionAccessFence({ db, agencyId, creatorId: anchorCreatorId, ...actor, lock: true });
      } catch (_) {
        continue;
      }
      const existing = candidateById.get(String(row.id));
      if (existing) {
        existing.durableReplayEligible = true;
        continue;
      }
      candidateById.set(String(row.id), {
        accountId: String(row.id), anchorCreatorId, messagingEligible: false, inboundEligible: false,
        durableReplayEligible: true, drainOnly: true, retiring: false,
      });
    }

    const retiringOwned = await db.agencyTelegramMtprotoAccount.findMany({
      where: {
        agencyId,
        lifecycleState: "RETIRING",
        runtimeClaimedByDeviceId: normalizedDeviceId,
        runtimeLeaseUserId: actor.userId,
        runtimeLeaseMemberId: actor.memberId,
        runtimeLeaseAccessEpoch: actor.accessEpoch,
      },
      select: { id: true, runtimeLeaseCreatorId: true },
      take: MAX_RUNTIME_CLAIMS,
    });
    for (const row of retiringOwned || []) {
      const anchorCreatorId = clean(row.runtimeLeaseCreatorId, 180);
      if (!anchorCreatorId || candidateById.has(String(row.id))) continue;
      try {
        await assertExecutionAccessFence({ db, agencyId, creatorId: anchorCreatorId, ...actor, lock: true });
      } catch (_) {
        continue;
      }
      candidateById.set(String(row.id), { accountId: String(row.id), anchorCreatorId, messagingEligible: false, inboundEligible: false, durableReplayEligible: true, drainOnly: true, retiring: true });
    }
  }

  const requestedAccountId = clean(accountId, 180);
  const allCandidates = [...candidateById.values()].sort((left, right) =>
    Number(right.retiring === true || right.drainOnly === true) - Number(left.retiring === true || left.drainOnly === true),
  );
  const candidates = requestedAccountId ? allCandidates.filter((candidate) => candidate.accountId === requestedAccountId) : allCandidates;
  if (requestedAccountId && candidates.length === 0) {
    throw fail("TELEGRAM_EXECUTION_ACCOUNT_FORBIDDEN", "This member has no creator access through this Telegram account", 403);
  }
  const take = Math.max(1, Math.min(MAX_RUNTIME_CLAIMS, Math.floor(Number(limit) || MAX_RUNTIME_CLAIMS)));
  const leases = [];
  for (const candidate of candidates.slice(0, take * 3)) {
    if (leases.length >= take) break;
    const account = await db.agencyTelegramMtprotoAccount.findFirst({
      where: { id: candidate.accountId, agencyId },
      select: { id: true, lifecycleState: true, retirementRequestedAt: true, runtimeClaimedByDeviceId: true, runtimeClaimToken: true, runtimeClaimUntil: true, runtimeLeaseUserId: true, runtimeLeaseMemberId: true, runtimeLeaseAccessEpoch: true, runtimeLeaseCreatorId: true, runtimeClaimGeneration: true, runtimeDrainedGeneration: true, runtimeClaimInboundEligible: true },
    });
    if (!account) continue;
    const lifecycleState = String(account.lifecycleState || "ACTIVE").toUpperCase();
    if (lifecycleState !== "ACTIVE" && lifecycleState !== "RETIRING") continue;
    await assertExecutionAccessFence({ db, agencyId, creatorId: candidate.anchorCreatorId, ...actor, lock: true });
    const ownedIdentity = String(account.runtimeClaimedByDeviceId || "") === normalizedDeviceId
      && String(account.runtimeLeaseUserId || "") === actor.userId
      && String(account.runtimeLeaseMemberId || "") === actor.memberId
      && Number(account.runtimeLeaseAccessEpoch) === actor.accessEpoch
      && String(account.runtimeLeaseCreatorId || "") === String(candidate.anchorCreatorId)
      && String(account.runtimeClaimToken || "");
    const claimGeneration = Math.max(0, Number(account.runtimeClaimGeneration) || 0);
    const drainedGeneration = Math.max(0, Number(account.runtimeDrainedGeneration) || 0);
    const generationInboundEligible = account.runtimeClaimInboundEligible === true;
    const priorUndrained = claimGeneration > drainedGeneration;
    const existingOwned = Boolean(ownedIdentity && account.runtimeClaimUntil && new Date(account.runtimeClaimUntil).getTime() > now.getTime());
    const resumeUndrainedOwner = Boolean(ownedIdentity && priorUndrained);
    // A crashed/released runtime may own durable SQLite observations that the backend cannot see.
    // Never transfer that generation to a different Desktop merely because its TTL expired.
    if (priorUndrained && !ownedIdentity) continue;
    if (lifecycleState === "RETIRING" && !ownedIdentity) continue;
    const claimToken = existingOwned || resumeUndrainedOwner || lifecycleState === "RETIRING" ? String(account.runtimeClaimToken) : crypto.randomUUID();
    if (!claimToken) continue;
    const nextGeneration = existingOwned || resumeUndrainedOwner || lifecycleState === "RETIRING" ? claimGeneration : claimGeneration + 1;
    const claimUntil = new Date(now.getTime() + RUNTIME_LEASE_MS);
    const where = lifecycleState === "RETIRING"
      ? {
          id: account.id, agencyId, lifecycleState: "RETIRING",
          runtimeClaimedByDeviceId: normalizedDeviceId,
          runtimeClaimToken: String(account.runtimeClaimToken),
          runtimeLeaseUserId: actor.userId,
          runtimeLeaseMemberId: actor.memberId,
          runtimeLeaseAccessEpoch: actor.accessEpoch,
          runtimeLeaseCreatorId: candidate.anchorCreatorId,
          runtimeClaimGeneration: claimGeneration,
          runtimeDrainedGeneration: drainedGeneration,
        }
      : resumeUndrainedOwner
        ? {
            id: account.id, agencyId,
            runtimeClaimedByDeviceId: normalizedDeviceId,
            runtimeClaimToken: String(account.runtimeClaimToken),
            runtimeLeaseUserId: actor.userId,
            runtimeLeaseMemberId: actor.memberId,
            runtimeLeaseAccessEpoch: actor.accessEpoch,
            runtimeLeaseCreatorId: candidate.anchorCreatorId,
            runtimeClaimGeneration: claimGeneration,
            runtimeDrainedGeneration: drainedGeneration,
          }
        : {
            id: account.id, agencyId,
            runtimeClaimGeneration: claimGeneration,
            runtimeDrainedGeneration: drainedGeneration,
            OR: [
              { runtimeClaimUntil: null },
              { runtimeClaimUntil: { lt: now } },
              { runtimeClaimedByDeviceId: normalizedDeviceId },
            ],
          };
    const changed = await db.agencyTelegramMtprotoAccount.updateMany({
      where,
      data: {
        runtimeClaimedByDeviceId: normalizedDeviceId,
        runtimeClaimToken: claimToken,
        runtimeClaimUntil: claimUntil,
        runtimeLeaseUserId: actor.userId,
        runtimeLeaseMemberId: actor.memberId,
        runtimeLeaseAccessEpoch: actor.accessEpoch,
        runtimeLeaseCreatorId: candidate.anchorCreatorId,
        runtimeClaimGeneration: nextGeneration,
        runtimeClaimInboundEligible: nextGeneration === claimGeneration
          ? (generationInboundEligible || (lifecycleState === "ACTIVE" && candidate.inboundEligible === true))
          : (lifecycleState === "ACTIVE" && candidate.inboundEligible === true),
      },
    });
    if (Number(changed?.count || 0) !== 1) continue;
    leases.push({
      accountId: account.id,
      anchorCreatorId: candidate.anchorCreatorId,
      messagingEligible: lifecycleState === "ACTIVE" && candidate.messagingEligible === true,
      inboundEligible: lifecycleState === "ACTIVE" && candidate.inboundEligible === true,
      durableReplayEligible: candidate.durableReplayEligible === true || (resumeUndrainedOwner && generationInboundEligible) || (lifecycleState === "RETIRING" && generationInboundEligible),
      drainOnly: candidate.drainOnly === true || lifecycleState === "RETIRING",
      retiring: lifecycleState === "RETIRING",
      claimToken,
      claimUntil: claimUntil.toISOString(),
    });
  }
  return { ok: true, leases, serverNow: now.toISOString(), leaseMs: RUNTIME_LEASE_MS };
}

async function assertTelegramRuntimeLease({ agencyId, member, accountId, deviceId, claimToken, now = new Date(), db }) {
  const normalizedAccountId = clean(accountId);
  const normalizedDeviceId = clean(deviceId);
  const normalizedToken = clean(claimToken, 180);
  if (!normalizedAccountId || !normalizedDeviceId || !normalizedToken) throw fail("TELEGRAM_EXECUTION_LEASE_REQUIRED", "Telegram runtime lease is required", 409);
  const account = await db.agencyTelegramMtprotoAccount.findFirst({
    where: { id: normalizedAccountId, agencyId },
    select: { id: true, lifecycleState: true, runtimeClaimedByDeviceId: true, runtimeClaimToken: true, runtimeClaimUntil: true, runtimeLeaseUserId: true, runtimeLeaseMemberId: true, runtimeLeaseAccessEpoch: true, runtimeLeaseCreatorId: true, runtimeClaimGeneration: true, runtimeDrainedGeneration: true, runtimeClaimInboundEligible: true },
  });
  if (!account) throw fail("TELEGRAM_EXECUTION_ACCOUNT_FORBIDDEN", "This Telegram account is not available", 403);
  const eligible = await eligibleTelegramExecutionAccounts({ agencyId, member, db, includeRetiring: true });
  let anchor = eligible.find((row) => row.accountId === normalizedAccountId) || null;
  const lifecycleState = String(account.lifecycleState || "ACTIVE").toUpperCase();
  // Retirement drain may outlive the account's mutable creator assignment. In that case the
  // signed runtime identity itself is the temporary drain anchor; it cannot grant new work and
  // is still checked against current member/creator access below.
  const signedOwner = String(account.runtimeClaimedByDeviceId || "") === normalizedDeviceId
    && String(account.runtimeClaimToken || "") === normalizedToken
    && String(account.runtimeLeaseUserId || "") === String(member?.userId || "")
    && String(account.runtimeLeaseMemberId || "") === String(member?.id || "")
    && Number(account.runtimeLeaseAccessEpoch) === Number(member?.accessEpoch)
    && clean(account.runtimeLeaseCreatorId, 180);
  const claimGeneration = Math.max(0, Number(account.runtimeClaimGeneration) || 0);
  const drainedGeneration = Math.max(0, Number(account.runtimeDrainedGeneration) || 0);
  const undrainedSignedOwner = Boolean(signedOwner && claimGeneration > drainedGeneration && account.runtimeClaimInboundEligible === true);
  if (!anchor && (lifecycleState === "RETIRING" || lifecycleState === "ACTIVE") && undrainedSignedOwner) {
    anchor = {
      accountId: normalizedAccountId, anchorCreatorId: String(account.runtimeLeaseCreatorId),
      messagingEligible: false, inboundEligible: false, durableReplayEligible: true, drainOnly: true,
    };
  }
  if (!anchor) throw fail("TELEGRAM_EXECUTION_ACCOUNT_FORBIDDEN", "This member has no creator access through this Telegram account", 403);
  const valid = String(account.runtimeClaimedByDeviceId || "") === normalizedDeviceId
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
  return {
    account,
    anchorCreatorId: anchor.anchorCreatorId,
    messagingEligible: lifecycleState === "ACTIVE" && anchor.messagingEligible === true,
    inboundEligible: lifecycleState === "ACTIVE" && anchor.inboundEligible === true,
    durableReplayEligible: anchor.durableReplayEligible === true || undrainedSignedOwner,
    drainOnly: anchor.drainOnly === true || lifecycleState === "RETIRING",
    retiring: lifecycleState === "RETIRING",
  };
}

async function assertTelegramInboundRuntimeLease(args) {
  const runtime = await assertTelegramRuntimeLease(args);
  if (!runtime.inboundEligible && !runtime.durableReplayEligible) {
    throw fail("TELEGRAM_INBOUND_ACCOUNT_FORBIDDEN", "This Telegram runtime cannot accept or durably replay inbound provider observations", 403);
  }
  return runtime;
}

async function releaseTelegramExecutionRuntime({ agencyId, member, accountId, deviceId, claimToken, drained = false, now = new Date(), db }) {
  const normalizedAccountId = clean(accountId);
  const normalizedDeviceId = clean(deviceId);
  const normalizedToken = clean(claimToken, 180);
  const runtime = await assertTelegramRuntimeLease({ agencyId, member, accountId: normalizedAccountId, deviceId: normalizedDeviceId, claimToken: normalizedToken, now, db });
  const lifecycle = await db.agencyTelegramMtprotoAccount.findFirst({
    where: { id: normalizedAccountId, agencyId },
    select: { id: true, lifecycleState: true },
  });
  const retiring = String(lifecycle?.lifecycleState || "ACTIVE").toUpperCase() === "RETIRING";
  const generation = Math.max(0, Number(runtime.account?.runtimeClaimGeneration) || 0);
  const drainedRelease = drained === true;
  const changed = await db.agencyTelegramMtprotoAccount.updateMany({
    where: { id: normalizedAccountId, agencyId, runtimeClaimedByDeviceId: normalizedDeviceId, runtimeClaimToken: normalizedToken, runtimeClaimGeneration: generation },
    data: drainedRelease
      ? {
          runtimeClaimedByDeviceId: null,
          runtimeClaimToken: null,
          runtimeClaimUntil: null,
          runtimeLeaseUserId: null,
          runtimeLeaseMemberId: null,
          runtimeLeaseAccessEpoch: null,
          runtimeLeaseCreatorId: null,
          runtimeDrainedGeneration: generation,
          ...(retiring ? { retirementDrainCompletedAt: now } : {}),
        }
      : {
          // Ordinary shutdown/scope release is NOT a durable outbox proof. Keep the signed
          // owner identity and generation so only this Desktop can resume an undrained lease.
          runtimeClaimUntil: null,
        },
  });
  return { ok: true, released: Number(changed?.count || 0) === 1, retirementDrained: retiring && drainedRelease, drained: drainedRelease, anchorCreatorId: runtime.anchorCreatorId };
}

module.exports = {
  RUNTIME_LEASE_MS,
  eligibleTelegramExecutionAccounts,
  assertTelegramMessagingAccess,
  claimTelegramExecutionRuntimes,
  assertTelegramRuntimeLease,
  assertTelegramInboundRuntimeLease,
  releaseTelegramExecutionRuntime,
};
