"use strict";

const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { runRootCommit } = require("./db-commit-kernel");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");
const { acquireCampaignTransactionLock } = require("./campaign-transaction-lock-service");
const { lockDbAdvisoryXact } = require("./db-transaction-service");
const { collectionCommand, COLLECTOR_TYPES } = require("./analytics-collector-control-service");
const { stampObservationStart, observationStartForJob } = require("./analytics-observation-time");
const directoryCounts = require("./campaign-directory-count-authority");
const { publishDomainWork, claimDomainWorkBatch, lockDomainWorkClaimForCommit,
  ackDomainWorkClaim, yieldDomainWorkClaim, failDomainWorkClaim } = require("./domain-work-authority-service");

const KEYS = new Set(["fetch_earnings", "fetch_campaigns", "financial_transactions_scan"]);
const PAGE = 200;
const MAX_ATTEMPTS = 8;
const MAX_JOB_ATTEMPTS = 5;
function fault(code, status = 409) { return Object.assign(new Error(code), { code, status }); }
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().filter(k => value[k] !== undefined)
    .map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}
function payloadHash(value) { return crypto.createHash("sha256").update(canonical(value || {})).digest("hex"); }
function tokenHash(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex"); }
function isAnalyticsPublicationJob(job) { return KEYS.has(job?.jobKey); }
function response(row) {
  if (row.response) return { ...row.response, publicationId: row.id, accepted: true };
  return { accepted: true, publicationId: row.id, publicationPending: true,
    job: { id: row.jobId, status: "PUBLISHING" }, sideEffect: { type: "analytics_publication", pending: true } };
}
function assertReplay(row, input) {
  if (row.userId !== input.userId || row.deviceId !== input.deviceId
      || row.leaseRevision !== input.leaseRevision || row.leaseTokenHash !== tokenHash(input.leaseToken)) {
    throw fault("ANALYTICS_PUBLICATION_IDENTITY_MISMATCH");
  }
  if (row.payloadHash !== payloadHash(input.result)) throw fault("ANALYTICS_PUBLICATION_PAYLOAD_CONFLICT");
  return response(row);
}

// Called only inside the existing locked lease commit. This is the linearization
// point: after acceptance the server owns publication of already accepted facts.
async function acceptAnalyticsPublication({ db, job, userId, deviceId, leaseToken, leaseRevision, result, now }) {
  if (!isAnalyticsPublicationJob(job)) throw fault("ANALYTICS_PUBLICATION_JOB_INVALID");
  const existing = await db.analyticsPublication.findUnique({ where: { jobId_leaseRevision: { jobId: job.id, leaseRevision } } });
  if (existing) return assertReplay(existing, { userId, deviceId, leaseToken, leaseRevision, result });
  const payload = result || {};
  if (job.jobKey === "financial_transactions_scan") {
    const authority = require("./financial-receipt-authority");
    await authority.enter(db);
    if (authority.enabled(job) && (await authority.completionProof(db, job)).row?.cursor.phase !== "done") throw fault("FINANCIAL_TRAVERSAL_NOT_FINISHED");
  }
  if (job.jobKey === "fetch_campaigns") {
    require("./campaign-traversal-authority-service").assertCompletion(job, payload);
    await require("./campaign-causal-activation-service").enterCampaignBoundedExecution({ db });
  }
  if (Buffer.byteLength(canonical(payload), "utf8") > 128 * 1024) throw fault("ANALYTICS_COMPLETION_TOO_LARGE", 400);
  if (job.jobKey === "fetch_earnings") earningsInput(job, payload);
  else if (job.jobKey === "fetch_campaigns") require("./creator-analytics-ledger-service").validateCampaignCompletion(job, payload);
  else require("./financial-transactions-service").validateFinancialCompletion(job, payload);
  const inputClock = await db.analyticsPublicationInputClock.findUnique({ where: { jobId: job.id } });
  const stage = job.jobKey === "fetch_earnings" ? "EARNINGS_BATCHES"
    : job.jobKey === "fetch_campaigns" ? "CAMPAIGN_DIRECTORY" : "FINANCIAL_ROWS";
  const row = await db.analyticsPublication.create({ data: {
    id: `${job.id}:${leaseRevision}`, jobId: job.id, agencyId: job.agencyId, creatorId: job.creatorId, userId, deviceId,
    leaseRevision, leaseTokenHash: tokenHash(leaseToken), payloadHash: payloadHash(payload),
    payload, stage, state: "PENDING", cursor: {}, proof: {}, availableAt: now,
    inputRevision: inputClock?.revision || 0n,
  } });
  const changed = await db.jobInstance.updateMany({ where: {
    id: job.id, status: "CLAIMED", claimedByDeviceId: deviceId, leaseRevision,
    leaseTokenHash: tokenHash(leaseToken), leaseUntil: { gt: now },
  }, data: { status: "PUBLISHING", leaseUntil: null, leaseTokenHash: null,
    continuation: null, lastProgressAt: now, lastError: null,
    progress: { percent: 99, message: "Publishing verified analytics" }, result: payload } });
  if (changed.count !== 1) throw fault("JOB_LEASE_STALE");
  await db.fanObservationReadLease.deleteMany({ where: { jobId: job.id, deviceId, leaseRevision } });
  await publishDomainWork({ db, agencyId: job.agencyId, creatorId: job.creatorId,
    workClass: "ANALYTICS_PUBLICATION", objectType: "ANALYTICS_PUBLICATION", objectId: row.id, partitionKey: job.creatorId });
  return response(row);
}

async function lockDomain(db, job) {
  if (job.jobKey === "fetch_campaigns") {
    await acquireCampaignTransactionLock(db, job.creatorId);
    return require("./campaign-causal-activation-service").enterCampaignBoundedExecution({ db });
  }
  if (job.jobKey === "financial_transactions_scan") {
    await require("./financial-receipt-authority").enter(db);
    return lockDbAdvisoryXact({ db, key: `analytics-collector:financial:${job.creatorId}` });
  }
  // Same lock identity used by earnings page ingestion.
  const value = BigInt.asIntN(64, BigInt("0x" + crypto.createHash("sha256").update(`creator-earnings:${job.creatorId}`).digest("hex").slice(0, 16)));
  await db.$executeRawUnsafe("SELECT pg_advisory_xact_lock($1::bigint)", value.toString());
}

async function currentGeneration(db, job) {
  if (job.jobKey === "fetch_earnings") return true;
  const type = job.jobKey === "fetch_campaigns" ? COLLECTOR_TYPES.CAMPAIGNS : COLLECTOR_TYPES.FINANCIAL;
  const command = collectionCommand(job, type);
  const state = await (type === COLLECTOR_TYPES.CAMPAIGNS ? db.creatorCampaignCollectionState : db.creatorFinancialCollectionState)
    .findUnique({ where: { creatorId: job.creatorId } });
  return !state?.activeGeneration || state.activeGeneration === command.generation;
}

async function save(db, row, data, now) {
  return db.analyticsPublication.update({ where: { id: row.id }, data: {
    ...data, availableAt: new Date(now.getTime() + 25), attempts: 0, lastError: null,
  } });
}
function afterId(cursor) { return cursor?.id ? { id: { gt: cursor.id } } : {}; }
function sumSafe(a, b) {
  const value = a + b;
  if (!Number.isSafeInteger(value)) throw fault("ANALYTICS_PUBLICATION_AMOUNT_OVERFLOW");
  return value;
}
function nextCursor(rows) { return rows.length ? { id: rows[rows.length - 1].id } : {}; }
function earningsInput(job, payload) {
  return require("./creator-analytics-ledger-service").validateEarningsCompletion(job, payload);
}

async function earningsUnit(db, job, row, now) {
  const input = earningsInput(job, row.payload);
  const dailyWhere = { creatorId: job.creatorId, sourceJobId: job.id,
    sourceScanRunId: input.scanRunId, sourceTimezone: "UTC",
    date: { gte: input.startDate, lte: input.endDate } };
  const batchWhere = { sourceJobId: job.id, dataType: "EARNINGS",
    idempotencyKey: { startsWith: `earnings:${job.id}:run:${input.scanRunId}:daily:` } };
  const proof = { batches: 0, acceptedRows: 0, rejectedRows: 0, rejectedBatches: 0, persistedDailyCount: 0, ...row.proof };
  if (row.stage === "EARNINGS_BATCHES") {
    const rows = await db.analyticsIngestBatch.findMany({ where: { ...batchWhere, ...afterId(row.cursor) },
      orderBy: { id: "asc" }, take: PAGE, select: { id: true, receivedRows: true, rejectedRows: true, status: true } });
    for (const item of rows) {
      proof.batches++; proof.acceptedRows += item.receivedRows - item.rejectedRows;
      proof.rejectedRows += item.rejectedRows;
      if (item.status !== "COMMITTED" || item.rejectedRows !== 0) proof.rejectedBatches++;
    }
    return save(db, row, { proof, cursor: rows.length === PAGE ? nextCursor(rows) : {},
      stage: rows.length === PAGE ? row.stage : "EARNINGS_DAYS" }, now);
  }
  if (row.stage === "EARNINGS_DAYS") {
    const rows = await db.creatorEarningsDaily.findMany({ where: { ...dailyWhere, ...afterId(row.cursor) },
      orderBy: { id: "asc" }, take: PAGE, select: { id: true } });
    proof.persistedDailyCount += rows.length;
    return save(db, row, { proof, cursor: rows.length === PAGE ? nextCursor(rows) : {},
      stage: rows.length === PAGE ? row.stage : "EARNINGS_PREPARE" }, now);
  }
  if (row.stage === "EARNINGS_PREPARE") {
    const prepared = await require("./creator-analytics-ledger-service").completeEarningsScan({
      db, job, deviceId: row.deviceId, result: row.payload, publication: { ...proof, prepareOnly: true },
    });
    return save(db, row, { proof: { ...proof, scanProofId: prepared.scanProofId, complete: prepared.complete },
      stage: "EARNINGS_LINK_DAYS", cursor: {} }, now);
  }
  if (row.stage === "EARNINGS_LINK_DAYS") {
    const rows = await db.creatorEarningsDaily.findMany({ where: { ...dailyWhere, ...afterId(row.cursor) },
      orderBy: { id: "asc" }, take: PAGE, select: { id: true } });
    if (rows.length) await db.creatorEarningsDaily.updateMany({
      where: { ...dailyWhere, id: { in: rows.map(x => x.id) } }, data: { scanProofId: proof.scanProofId },
    });
    return save(db, row, { cursor: rows.length === PAGE ? nextCursor(rows) : {},
      stage: rows.length === PAGE ? row.stage : "EARNINGS_LINK_COVERAGE" }, now);
  }
  if (row.stage === "EARNINGS_LINK_COVERAGE") {
    const where = { creatorId: job.creatorId, dataType: "EARNINGS", sourceTimezone: "UTC",
      coverageDate: { gte: input.startDate, lte: input.endDate }, ingestBatch: { is: batchWhere } };
    const rows = await db.analyticsCoverage.findMany({ where: { ...where, ...afterId(row.cursor) },
      orderBy: { id: "asc" }, take: PAGE, select: { id: true } });
    if (rows.length) {
      const ids = rows.map(x => x.id);
      await db.analyticsCoverage.updateMany({ where: { ...where, id: { in: ids } }, data: { scanProofId: proof.scanProofId } });
      if (proof.complete) await db.analyticsCoverage.updateMany({ where: { ...where, id: { in: ids },
        coverageDate: { gte: input.startDate, lte: input.endDate, lt: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) },
        status: "PARTIAL", lastErrorCode: "EARNINGS_SCAN_PENDING" }, data: {
        status: "COMPLETE", lastVerifiedAt: observationStartForJob(job), lastErrorCode: null, lastErrorMessage: null, retryAfterAt: null,
      } });
    }
    return save(db, row, { cursor: rows.length === PAGE ? nextCursor(rows) : {}, stage: rows.length === PAGE ? row.stage : "FINALIZE" }, now);
  }
  throw fault("ANALYTICS_PUBLICATION_STAGE_INVALID");
}

async function campaignUnit(db, job, row, now) {
  const command = collectionCommand(job, COLLECTOR_TYPES.CAMPAIGNS);
  if (String(row.payload.scanRunId || "") !== command.generation) throw fault("CAMPAIGN_PUBLICATION_RUN_MISMATCH");
  const params = job.params || {};
  const reuse = Number(params.campaignDirectoryReuseVersion || 0) >= 1 && params.campaignDirectoryReuseGeneration;
  const generation = reuse ? params.campaignDirectoryReuseGeneration : command.generation;
  const requestedAt = reuse ? new Date(params.campaignDirectoryReuseRequestedAt) : command.requestedAt;
  const proof = { observedCampaignCount: 0, ...row.proof };
  if (row.stage === "CAMPAIGN_DIRECTORY") {
    const state = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: job.creatorId } });
    const sealed = directoryCounts.sealedDirectoryCount(state, { generation, requestedAt });
    if (sealed !== null) {
      return save(db, row, { proof: { observedCampaignCount: sealed,
        directoryCountRevision: String(state.campaignDirectoryCountRevision) }, cursor: {}, stage: "CAMPAIGN_PREPARE" }, now);
    }
    const rows = await db.creatorCampaign.findMany({ where: { creatorId: job.creatorId, sourceScanRunId: generation,
      sourceScanStartedAt: requestedAt, ...afterId(row.cursor) }, orderBy: { id: "asc" }, take: PAGE, select: { id: true } });
    proof.observedCampaignCount += rows.length;
    return save(db, row, { proof, cursor: rows.length === PAGE ? nextCursor(rows) : {},
      stage: rows.length === PAGE ? row.stage : "CAMPAIGN_PREPARE" }, now);
  }
  if (row.stage === "CAMPAIGN_PREPARE") {
    const result = await require("./creator-analytics-ledger-service").completeCampaignScan({
      db, job, deviceId: row.deviceId, result: row.payload, publication: { ...proof, prepareOnly: true },
    });
    return save(db, row, { proof: { ...proof, membershipComplete: result.providerTraversalComplete === true },
      stage: result.providerTraversalComplete === true && !reuse ? "CAMPAIGN_RETIRE_ABSENT" : "FINALIZE", cursor: {} }, now);
  }
  if (row.stage === "CAMPAIGN_RETIRE_ABSENT") {
    const where = { creatorId: job.creatorId, isActive: true,
      OR: [{ sourceScanStartedAt: null }, { sourceScanStartedAt: { lt: command.requestedAt } }] };
    const rows = await db.creatorCampaign.findMany({ where: { ...where, ...afterId(row.cursor) },
      orderBy: { id: "asc" }, take: PAGE, select: { id: true } });
    if (rows.length) await db.creatorCampaign.updateMany({ where: { ...where, id: { in: rows.map(x => x.id) } }, data: { isActive: false } });
    return save(db, row, { cursor: rows.length === PAGE ? nextCursor(rows) : {}, stage: rows.length === PAGE ? row.stage : "FINALIZE" }, now);
  }
  throw fault("ANALYTICS_PUBLICATION_STAGE_INVALID");
}

async function financialUnit(db, job, row, now) {
  const command = collectionCommand(job, COLLECTOR_TYPES.FINANCIAL);
  if (String(row.payload.scanRunId || "") !== command.generation) throw fault("FINANCIAL_PUBLICATION_RUN_MISMATCH");
  // Page commits already maintain distinct transaction totals and chart proof
  // in the immutable run scope. Publication never enumerates mutable sourceJobId.
  const proof = await require("./financial-receipt-authority").completionProof(db, job);
  return save(db, row, { proof: { receiptRunId: proof.row?.id || null, complete: proof.complete }, cursor: {}, stage: "FINALIZE" }, now);
}

function repairParams(job, now) {
  const previous = job.params || {};
  if (job.jobKey === "fetch_earnings") {
    const old = new Date(previous.authorityRequestedAt || previous.requestedAt);
    const next = new Date(Math.max(now.getTime(), old.getTime() + 1));
    return stampObservationStart({ ...previous, requestedAt: now.toISOString(), authorityRequestedAt: next.toISOString(), scanGeneration: crypto.randomUUID() }, now);
  }
  const control = require("./analytics-collector-control-service");
  const type = job.jobKey === "fetch_campaigns" ? COLLECTOR_TYPES.CAMPAIGNS : COLLECTOR_TYPES.FINANCIAL;
  const command = collectionCommand(job, type);
  const params = { ...previous, ...control.buildCollectionCommand({ collectorType: type,
    collectionMode: command.mode, reason: previous.collectionReason || "PUBLICATION_REPAIR", now }) };
  // A new provider traversal must not reuse the rejected generation's frozen
  // directory/frontier proof or idempotency keys.
  for (const key of Object.keys(params)) if (/^campaignDirectoryReuse/.test(key)) delete params[key];
  return control.stampCollectionAuthorityParams(params, now, command.requestedAt);
}
async function settle(db, job, row, sideEffect, now, { forceTerminal = false } = {}) {
  const complete = sideEffect?.ok === true;
  const protocolSuperseded = !complete && ((job.jobKey === "fetch_campaigns" && sideEffect?.completion?.protocolCurrent === false)
    || (job.jobKey === "financial_transactions_scan" && sideEffect?.protocolCurrent === false));
  const attempts = Number(job.attempts || 0) + (!complete && !protocolSuperseded ? 1 : 0);
  const terminal = forceTerminal || (!protocolSuperseded && attempts >= MAX_JOB_ATTEMPTS);
  const retryAt = complete || terminal ? null : new Date(now.getTime() + (protocolSuperseded ? 1000 : 60000 * 2 ** Math.max(0, attempts - 1)));
  const status = complete ? "DONE" : terminal ? "FAILED" : "SCHEDULED";
  const result = { job: { id: job.id, status, ...(retryAt ? { retryAt: retryAt.toISOString() } : {}) }, sideEffect,
    accepted: true, publicationPending: false, ...(protocolSuperseded ? { protocolSuperseded: true } : {}) };
  // End the immutable execution receipt first. Only then may this job identity
  // be scheduled with a fresh scan generation; both changes commit together.
  await db.analyticsPublication.update({ where: { id: row.id }, data: {
    state: complete ? "COMMITTED" : "REJECTED", stage: "TERMINAL", response: result,
    completedAt: now, lastError: complete ? null : String(sideEffect?.error || `${job.jobKey}_partial`),
  } });
  if (!complete && !protocolSuperseded) await require("./job-result-service").recordJobFailure({ db, job,
    error: protocolSuperseded ? `${job.jobKey}_protocol_superseded` : `${job.jobKey}_partial`, terminal, retryAfterAt: retryAt });
  const updated = await db.jobInstance.update({ where: { id: job.id }, data: {
    status, completedAt: retryAt ? null : now, attempts, leaseUntil: null, leaseTokenHash: null, continuation: null,
    claimedAt: null, claimedByDeviceId: null, workId: null,
    ...(retryAt ? { nextRunAt: retryAt, params: repairParams(job, now) } : {}),
    lastProgressAt: now, result: { ...row.payload, completionSideEffect: sideEffect },
    progress: { percent: complete ? 100 : retryAt ? 0 : 99, message: complete ? "completed" : retryAt ? "scheduled for analytics repair" : "analytics publication failed" },
    lastError: complete ? null : protocolSuperseded ? `${job.jobKey}_protocol_superseded` : String(sideEffect?.error || `${job.jobKey}_partial`),
  } });
  if (job.jobKey === "financial_transactions_scan") await require("./financial-receipt-retention-service").publish({ db, job, now });
  if (retryAt) require("./job-planning-repository").publishPlannedJobAvailable(updated);
  return result;
}

async function runAnalyticsPublicationUnit({ db, publicationId, claim = null }) {
  const candidate = await db.analyticsPublication.findUnique({ where: { id: publicationId } });
  const jobId = candidate?.jobId;
  if (!candidate || candidate.state !== "PENDING") return candidate ? response(candidate) : { skipped: true };
  return runRootCommit(db, async ({ tx }) => {
    const perform = async () => {
    const lifecycle = await lockAgencyLifecycleBarrier({ db: tx, agencyId: candidate.agencyId });
    const creators = await tx.$queryRawUnsafe('SELECT "id" FROM "CreatorAccount" WHERE "id"=$1 AND "agencyId"=$2 AND "deletedAt" IS NULL FOR SHARE', candidate.creatorId, candidate.agencyId);
    const jobs = await tx.$queryRawUnsafe('SELECT * FROM "JobInstance" WHERE "id"=$1 FOR UPDATE SKIP LOCKED', jobId);
    if (!jobs.length) return { skipped: true, reason: "job_locked_or_removed" };
    const job = jobs[0];
    await tx.$queryRawUnsafe('SELECT "id" FROM "AnalyticsPublication" WHERE "id"=$1 FOR UPDATE', publicationId);
    const row = await tx.analyticsPublication.findUnique({ where: { id: publicationId } });
    if (!row || row.state !== "PENDING") return row ? response(row) : { skipped: true };
    const now = await dbAuthorityNow({ db: tx });
    if (claim) {
      const owned = await lockDomainWorkClaimForCommit({ db: tx, item: claim.item, ownerToken: claim.ownerToken });
      if (!owned.current) throw fault("ANALYTICS_PUBLICATION_CLAIM_LOST");
    }
    if (row.availableAt > now) return { skipped: true, reason: "not_due", nextRunAt: row.availableAt };
    if (!lifecycle.row || lifecycle.row.deletedAt || !creators.length || job.status !== "PUBLISHING") {
      const result = { accepted: true, publicationPending: false, job: { id: job.id, status: job.status === "PUBLISHING" ? "CANCELLED" : job.status }, cancelled: true };
      await tx.analyticsPublication.update({ where: { id: publicationId }, data: { state: "CANCELLED", response: result, completedAt: now } });
      if (job.status === "PUBLISHING") await tx.jobInstance.update({ where: { id: job.id }, data: { status: "CANCELLED", completedAt: now, lastError: "PUBLICATION_SCOPE_RETIRED" } });
      return result;
    }
    await lockDomain(tx, job);
    if (!await currentGeneration(tx, job)) return settle(tx, job, row, { ok: true, superseded: true, type: "analytics_publication" }, now);
    if (job.jobKey === "fetch_earnings") {
      const clock = await tx.analyticsPublicationInputClock.findUnique({ where: { jobId } });
      const revision = clock?.revision || 0n;
      if (revision !== row.inputRevision) {
        await save(tx, row, { inputRevision: revision, stage: "EARNINGS_BATCHES", cursor: {}, proof: {} }, now);
        return { publicationPending: true, inputChanged: true, job: { id: job.id, status: "PUBLISHING" } };
      }
    }
    if (row.stage === "FINALIZE") {
      const sideEffect = await require("./job-result-service").applyJobResult({ db: tx, job,
        deviceId: row.deviceId, userId: row.userId, result: row.payload, publication: row.proof });
      return settle(tx, job, row, sideEffect, now);
    }
    if (job.jobKey === "fetch_earnings") await earningsUnit(tx, job, row, now);
    else if (job.jobKey === "fetch_campaigns") await campaignUnit(tx, job, row, now);
    else await financialUnit(tx, job, row, now);
    return { publicationPending: true, job: { id: job.id, status: "PUBLISHING" }, stage: row.stage };
    };
    const result = await perform();
    if (claim && !(await lockDomainWorkClaimForCommit({ db: tx, item: claim.item, ownerToken: claim.ownerToken })).current) {
      throw fault("ANALYTICS_PUBLICATION_CLAIM_LOST");
    }
    return result;
  }, { profile: "JOB_CHUNK", authority: { kind: "ANALYTICS_PUBLICATION", agencyId: candidate.agencyId, creatorId: candidate.creatorId } });
}

async function runAnalyticsPublicationSweep({ db, limit = 8, maxRuntimeMs = 5000, maxUnitsPerClaim = 8 } = {}) {
  const started = performance.now();
  const budget = Math.max(1, Math.min(5000, Number(maxRuntimeMs) || 5000));
  const quantum = Math.max(1, Math.min(8, Math.floor(Number(maxUnitsPerClaim) || 8)));
  const batch = await claimDomainWorkBatch({ db, workClass: "ANALYTICS_PUBLICATION",
    limit: Math.max(1, Math.min(16, limit)), perAgencyQuantum: 2, perPartitionQuantum: 1 });
  const results = [];
  for (const item of batch.items || []) {
    const publicationId = item.objectId;
    const candidate = await db.analyticsPublication.findUnique({ where: { id: publicationId } });
    const jobId = candidate?.jobId;
    try {
      if (!candidate) { await ackDomainWorkClaim({ db, item, ownerToken: batch.ownerToken }); continue; }
      let current = candidate, result = { publicationPending: true, job: { id: jobId, status: "PUBLISHING" } }, units = 0;
      // A maintenance lane gets a turn only once per catalog rotation. Advance
      // a bounded quantum while we own this claim, instead of waiting another
      // full rotation between tiny publication stages. Every unit still has its
      // own transaction, input revision check and before/after ownership fence.
      while (current?.state === "PENDING" && units < quantum && performance.now() - started < budget) {
        // The database decides whether work is due. Do not compare its clock
        // with the application clock; only pace continuation between units.
        if (units) {
          if (performance.now() - started + 25 >= budget) break;
          await new Promise(resolve => setTimeout(resolve, 25));
        }
        result = await runAnalyticsPublicationUnit({ db, publicationId, claim: { item, ownerToken: batch.ownerToken } });
        units++;
        current = await db.analyticsPublication.findUnique({ where: { id: publicationId } });
        if (result.skipped) break;
      }
      results.push({ ...result, units });
      if (!current || current.state !== "PENDING") await ackDomainWorkClaim({ db, item, ownerToken: batch.ownerToken });
      else await yieldDomainWorkClaim({ db, item, ownerToken: batch.ownerToken, availableAt: current.availableAt,
        progressCursor: { stage: current.stage, cursor: current.cursor, inputRevision: String(current.inputRevision), updatedAt: current.updatedAt.toISOString() } });
      // The ordinary durable analytics planner advances the initial pipeline;
      // completion must not become a failure if an optional eager wake fails.
    } catch (error) {
      if (error?.code === "ANALYTICS_PUBLICATION_CLAIM_LOST") { results.push({ jobId, lost: true }); continue; }
      results.push({ jobId, error: String(error?.code || error?.message || error) });
      await runRootCommit(db, async ({ tx }) => {
        const lifecycle = await lockAgencyLifecycleBarrier({ db: tx, agencyId: candidate.agencyId });
        const creators = await tx.$queryRawUnsafe('SELECT "id" FROM "CreatorAccount" WHERE "id"=$1 AND "agencyId"=$2 AND "deletedAt" IS NULL FOR SHARE', candidate.creatorId, candidate.agencyId);
        if (!lifecycle.row || lifecycle.row.deletedAt || !creators.length) return;
        const jobs = await tx.$queryRawUnsafe('SELECT * FROM "JobInstance" WHERE "id"=$1 FOR UPDATE', jobId);
        await tx.$queryRawUnsafe('SELECT "id" FROM "AnalyticsPublication" WHERE "id"=$1 FOR UPDATE', publicationId);
        const row = await tx.analyticsPublication.findUnique({ where: { id: publicationId } });
        if (!row || row.state !== "PENDING" || jobs[0]?.status !== "PUBLISHING") return;
        if (!(await lockDomainWorkClaimForCommit({ db: tx, item, ownerToken: batch.ownerToken })).current) return;
        await lockDomain(tx, jobs[0]);
        const attempt = row.attempts + 1, at = await dbAuthorityNow({ db: tx });
        const message = String(error?.code || error?.message || error).slice(0, 2000);
        if (attempt >= MAX_ATTEMPTS || require("./domain-work-failure-policy").domainWorkFailureOutcome({ error, consecutiveFailures: attempt }).state === "RECONCILE_REQUIRED") {
          await settle(tx, jobs[0], row, { ok: false, type: "analytics_publication", error: message }, at, { forceTerminal: true });
        } else await tx.analyticsPublication.update({ where: { id: publicationId }, data: {
          attempts: attempt, lastError: message, availableAt: new Date(at.getTime() + Math.min(300000, 1000 * 2 ** attempt)),
        } });
      }, { profile: "JOB_CHUNK", authority: { kind: "ANALYTICS_PUBLICATION_FAILURE" } });
      const failed = await db.analyticsPublication.findUnique({ where: { id: publicationId } });
      if (!failed || failed.state !== "PENDING") await ackDomainWorkClaim({ db, item, ownerToken: batch.ownerToken });
      else await failDomainWorkClaim({ db, item, ownerToken: batch.ownerToken, error });
    }
  }
  return { ok: results.every(x => !x.error), processed: results.length, results };
}

module.exports = { PAGE, isAnalyticsPublicationJob, payloadHash, assertReplay, response,
  acceptAnalyticsPublication, runAnalyticsPublicationUnit, runAnalyticsPublicationSweep };
