"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { parseStrictIsoDateTime } = require("./strict-date-time");
const { rebuildCreatorDailyMetrics, upsertLocalMessageCoverage } = require("./creator-analytics-projection-service");
const { projectFanIdentity, projectFanValue, projectFanObservationBatch } = require("./fan-data-authority-service");
const { displayRangeBounds, scanContractFromJob } = require("./analytics-range-contract");
const {
  collectionCommand, COLLECTOR_TYPES, acceptCampaignGeneration, completeCampaignCollection,
} = require("./analytics-collector-control-service");
const { evaluateCollectionState, evaluateAggregateCollectionState, stateVocabulary } = require("./analytics-state-evaluator");
const {
  earningsFreshnessLimitMs, trustedCollectionTimestamp, CAMPAIGN_FAN_VALUE_FRESHNESS_MS,
  CAMPAIGN_ACTIVE_FRONTIER_FRESHNESS_MS, CAMPAIGN_INACTIVE_FRONTIER_FRESHNESS_MS, CAMPAIGN_DIRECTORY_DISCOVERY_SLA_MS,
} = require("./analytics-freshness-policy");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { consumeFanObservationToken, consumeFanObservationTokensBatch } = require("./fan-observation-token-service");
const { campaignCausalV1State, enterCampaignWriterGeneration } = require("./campaign-causal-activation-service");
const { enqueueUniqueCampaignFanRefreshes, campaignFanValueCoverageFromState } = require("./campaign-fan-refresh-queue-service");

const CAMPAIGN_COLLECTOR_VERSION = "campaigns-v13";
const CAMPAIGN_SERVER_REFRESH_COLLECTOR_VERSIONS = new Set(["campaigns-v9", "campaigns-v10", "campaigns-v11", "campaigns-v12", CAMPAIGN_COLLECTOR_VERSION]);
const CAMPAIGN_COMPAT_COLLECTOR_VERSIONS = new Set(["campaigns-v5", "campaigns-v6", "campaigns-v7", "campaigns-v8", "campaigns-v9", "campaigns-v10", "campaigns-v11", "campaigns-v12", CAMPAIGN_COLLECTOR_VERSION]);
const CAMPAIGN_FRESHNESS_COVERAGE_COLLECTOR_VERSIONS = new Set([CAMPAIGN_COLLECTOR_VERSION]);
const CAMPAIGN_RESUMABLE_COLLECTOR_VERSIONS = new Set(["campaigns-v10", "campaigns-v11", "campaigns-v12", CAMPAIGN_COLLECTOR_VERSION]);
const CAMPAIGN_ORDER_INDEPENDENT_COLLECTOR_VERSIONS = new Set(["campaigns-v12", CAMPAIGN_COLLECTOR_VERSION]);
const CAMPAIGN_SCHEMA_VERSION = 4;
const CAMPAIGN_FRONTIER_SCHEDULING_VERSION = 1;
const CAMPAIGN_DIRECTORY_REUSE_VERSION = 1;
const CAMPAIGN_FRONTIER_BUDGET_DEFAULT = 50;
const CAMPAIGN_FRONTIER_BUDGET_MAX = 200;
const EARNINGS_COLLECTOR_VERSION = "earnings-v4";
const EARNINGS_SCHEMA_VERSION = 4;
const MESSAGES_COLLECTOR_VERSION = "local-dialog-messages-v2";
const MESSAGES_SCHEMA_VERSION = 2;

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function array(value) {
  return Array.isArray(value) ? value : [];
}
function text(value, max = 500) {
  const out = String(value ?? "").trim();
  return out && out.length <= max ? out : null;
}
function integer(value, max = 2_147_483_647) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
}
function cents(value) {
  return integer(value);
}
function safeBigIntCents(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? BigInt(n) : null;
}
function strictDate(value) {
  return parseStrictIsoDateTime(value);
}
function dateOnly(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}
function currency(value) {
  const code = String(value || "USD").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}
function timezone(value) {
  const zone = text(value || "UTC", 100);
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date(0));
    return zone;
  } catch {
    return null;
  }
}
function utcDay(value) {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
function utcDayEnd(value) {
  return new Date(utcDay(value).getTime() + 86_400_000 - 1);
}
function compareDate(a, b) {
  return a.getTime() - b.getTime();
}
function rangeBounds(rangeKey, now = new Date()) {
  const range = displayRangeBounds(rangeKey, now);
  return {
    key: range.rangeKey,
    start: range.startAt,
    end: range.endAt,
    dayStart: range.startDay,
    dayEnd: range.endDay,
  };
}
function earningsJobBounds(job) {
  const contract = scanContractFromJob(job);
  return {
    key: contract.displayRangeKey || null,
    start: contract.scanFrom,
    end: utcDayEnd(contract.scanTo),
    dayStart: contract.scanFrom,
    dayEnd: contract.scanTo,
    contract,
  };
}
function requireJob(job) {
  if (!job?.id || !job?.creatorId || !job?.agencyId) {
    throw new Error("Analytics job is missing id/creator/agency scope");
  }
}
function checksum(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function campaignClaimerFrontierFanIds(value) {
  return [...new Set(array(value).map((item) => text(item, 180)).filter(Boolean))].sort().slice(0, 50);
}
function campaignClaimerFrontierHash(fanIds) {
  return checksum(campaignClaimerFrontierFanIds(fanIds));
}

function sameInstant(left, right) {
  const a = strictDate(left);
  const b = strictDate(right);
  if (!a || !b) return a === null && b === null;
  return a.getTime() === b.getTime();
}

async function readCampaignFrontierFanState(tx, { campaignId, canonicalRunId = null, canonicalStartedAt = null, stagedRunId = null, stagedStartedAt = null }) {
  if (typeof tx.creatorCampaignFrontierFan?.findMany !== "function") {
    throw new Error("CAMPAIGN_FRONTIER_RELATION_UNAVAILABLE");
  }
  const rows = await tx.creatorCampaignFrontierFan.findMany({
    where: { campaignId },
    select: { frontierKind: true, onlyFansUserId: true, sourceScanRunId: true, sourceScanStartedAt: true },
    orderBy: [{ frontierKind: "asc" }, { onlyFansUserId: "asc" }],
    take: 100,
  });
  const canonical = [];
  const staged = [];
  for (const row of rows || []) {
    const fanId = text(row?.onlyFansUserId, 180);
    if (!fanId) continue;
    if (row.frontierKind === "CANONICAL" &&
        String(row.sourceScanRunId || "") === String(canonicalRunId || "") &&
        sameInstant(row.sourceScanStartedAt, canonicalStartedAt)) {
      canonical.push(fanId);
    } else if (row.frontierKind === "STAGED" &&
        String(row.sourceScanRunId || "") === String(stagedRunId || "") &&
        sameInstant(row.sourceScanStartedAt, stagedStartedAt)) {
      staged.push(fanId);
    }
  }
  return {
    canonical: campaignClaimerFrontierFanIds(canonical),
    staged: campaignClaimerFrontierFanIds(staged),
  };
}

async function replaceCampaignFrontierFanState(tx, { job, campaignId, frontierKind, fanIds, scanRunId = null, scanStartedAt = null }) {
  if (typeof tx.creatorCampaignFrontierFan?.deleteMany !== "function" ||
      typeof tx.creatorCampaignFrontierFan?.createMany !== "function") {
    throw new Error("CAMPAIGN_FRONTIER_RELATION_UNAVAILABLE");
  }
  const normalized = campaignClaimerFrontierFanIds(fanIds);
  await tx.creatorCampaignFrontierFan.deleteMany({ where: { campaignId, frontierKind } });
  if (normalized.length) {
    await tx.creatorCampaignFrontierFan.createMany({
      data: normalized.map((onlyFansUserId) => ({
        agencyId: job.agencyId,
        creatorId: job.creatorId,
        campaignId,
        frontierKind,
        onlyFansUserId,
        sourceScanRunId: scanRunId || null,
        sourceScanStartedAt: scanStartedAt || null,
      })),
      skipDuplicates: true,
    });
  }
  return normalized;
}

async function projectCampaignMembershipBatch(tx, {
  job, campaignId, scanRunId, scanStartedAt, serverReceivedAt, deviceId = null, claimers, fanByOnlyFansUserId, canonicalFrontierStartedAt = null,
}) {
  const items = [];
  for (const claimer of claimers) {
    const fan = fanByOnlyFansUserId.get(String(claimer.onlyFansUserId));
    if (!fan?.id) throw new Error("CAMPAIGN_CLAIMER_FAN_PROJECTION_MISSING");
    items.push({
      id: crypto.randomUUID(),
      fanRecordId: String(fan.id),
      externalClaimerId: claimer.externalClaimerId || null,
      claimerUsernameAtEvent: claimer.username || null,
      claimerDisplayNameAtEvent: claimer.displayName || null,
      claimerAvatarUrlAtEvent: claimer.avatarUrl || null,
      attributedAt: claimer.attributedAt ? claimer.attributedAt.toISOString() : null,
    });
  }
  if (!items.length) {
    return { inserted: 0, updated: 0, unchanged: 0, currentRunMembershipProgress: 0, historicalMembershipBoundaryReached: false };
  }
  if (typeof tx?.$queryRawUnsafe !== "function") throw new Error("CAMPAIGN_MEMBERSHIP_BULK_SQL_UNAVAILABLE");

  const rows = await tx.$queryRawUnsafe(
    `
      WITH incoming AS (
        SELECT *
        FROM jsonb_to_recordset($1::jsonb) AS i(
          "id" text,
          "fanRecordId" text,
          "externalClaimerId" text,
          "claimerUsernameAtEvent" text,
          "claimerDisplayNameAtEvent" text,
          "claimerAvatarUrlAtEvent" text,
          "attributedAt" text
        )
      ),
      existing AS MATERIALIZED (
        SELECT
          membership."id",
          membership."fanId" AS "fanRecordId",
          membership."sourceScanRunId",
          membership."sourceScanStartedAt",
          membership."externalClaimerId",
          membership."attributedAt"
        FROM "CreatorCampaignFan" AS membership
        JOIN incoming AS i ON i."fanRecordId" = membership."fanId"
        WHERE membership."campaignId" = $2
        FOR UPDATE
      ),
      annotated AS (
        SELECT
          i.*,
          e."id" AS "existingId",
          e."sourceScanRunId" AS "existingScanRunId",
          e."sourceScanStartedAt" AS "existingScanStartedAt",
          e."externalClaimerId" AS "existingExternalClaimerId",
          e."attributedAt" AS "existingAttributedAt",
          COALESCE(e."sourceScanStartedAt" > $3::timestamptz, false) AS "newerGeneration",
          COALESCE(e."sourceScanRunId" = $4 AND e."sourceScanStartedAt" = $3::timestamptz, false) AS "alreadyObservedInCurrentRun",
          COALESCE($5::timestamptz IS NOT NULL AND e."sourceScanStartedAt" IS NOT NULL AND e."sourceScanStartedAt" <= $5::timestamptz, false) AS "historicalBoundary"
        FROM incoming AS i
        LEFT JOIN existing AS e ON e."fanRecordId" = i."fanRecordId"
      ),
      upserted AS (
        INSERT INTO "CreatorCampaignFan" (
          "id", "agencyId", "creatorId", "campaignId", "fanId",
          "externalClaimerId", "claimerUsernameAtEvent", "claimerDisplayNameAtEvent", "claimerAvatarUrlAtEvent",
          "attributedAt", "sourceScanRunId", "sourceScanStartedAt", "collectedAt",
          "sourceDeviceId", "sourceJobId", "createdAt", "updatedAt"
        )
        SELECT
          a."id", $6, $7, $2, a."fanRecordId",
          a."externalClaimerId", a."claimerUsernameAtEvent", a."claimerDisplayNameAtEvent", a."claimerAvatarUrlAtEvent",
          NULLIF(a."attributedAt", '')::timestamptz, $4, $3::timestamptz, $8::timestamptz,
          $9, $10, $8::timestamptz, $8::timestamptz
        FROM annotated AS a
        WHERE a."newerGeneration" = false
        ON CONFLICT ("campaignId", "fanId") DO UPDATE SET
          "externalClaimerId" = COALESCE(EXCLUDED."externalClaimerId", "CreatorCampaignFan"."externalClaimerId"),
          "claimerUsernameAtEvent" = EXCLUDED."claimerUsernameAtEvent",
          "claimerDisplayNameAtEvent" = EXCLUDED."claimerDisplayNameAtEvent",
          "claimerAvatarUrlAtEvent" = EXCLUDED."claimerAvatarUrlAtEvent",
          "attributedAt" = CASE
            WHEN "CreatorCampaignFan"."attributedAt" IS NULL THEN EXCLUDED."attributedAt"
            WHEN EXCLUDED."attributedAt" IS NULL THEN "CreatorCampaignFan"."attributedAt"
            ELSE LEAST("CreatorCampaignFan"."attributedAt", EXCLUDED."attributedAt")
          END,
          "sourceScanRunId" = EXCLUDED."sourceScanRunId",
          "sourceScanStartedAt" = EXCLUDED."sourceScanStartedAt",
          "collectedAt" = EXCLUDED."collectedAt",
          "sourceDeviceId" = EXCLUDED."sourceDeviceId",
          "sourceJobId" = EXCLUDED."sourceJobId",
          "updatedAt" = EXCLUDED."updatedAt"
        WHERE "CreatorCampaignFan"."sourceScanStartedAt" IS NULL
           OR "CreatorCampaignFan"."sourceScanStartedAt" <= EXCLUDED."sourceScanStartedAt"
        RETURNING "fanId" AS "fanRecordId"
      )
      SELECT
        a."fanRecordId",
        (a."existingId" IS NOT NULL) AS "existed",
        a."newerGeneration",
        a."alreadyObservedInCurrentRun",
        a."historicalBoundary",
        (u."fanRecordId" IS NOT NULL) AS "wrote"
      FROM annotated AS a
      LEFT JOIN upserted AS u ON u."fanRecordId" = a."fanRecordId"
    `,
    JSON.stringify(items),
    String(campaignId),
    scanStartedAt.toISOString(),
    String(scanRunId),
    canonicalFrontierStartedAt ? canonicalFrontierStartedAt.toISOString() : null,
    String(job.agencyId),
    String(job.creatorId),
    serverReceivedAt.toISOString(),
    deviceId ? String(deviceId) : null,
    String(job.id),
  );

  let inserted = 0;
  let updated = 0;
  let unchanged = 0;
  let currentRunMembershipProgress = 0;
  let historicalMembershipBoundaryReached = false;
  for (const row of Array.isArray(rows) ? rows : []) {
    const newerGeneration = row?.newerGeneration === true;
    const existed = row?.existed === true;
    const wrote = row?.wrote === true;
    if (newerGeneration) {
      unchanged += 1;
      continue;
    }
    if (!wrote) throw new Error("CAMPAIGN_MEMBERSHIP_BULK_WRITE_MISSING");
    if (row?.alreadyObservedInCurrentRun !== true) currentRunMembershipProgress += 1;
    if (row?.historicalBoundary === true) historicalMembershipBoundaryReached = true;
    if (existed) updated += 1;
    else inserted += 1;
  }
  if ((Array.isArray(rows) ? rows.length : 0) !== items.length) throw new Error("CAMPAIGN_MEMBERSHIP_BULK_RESULT_INCOMPLETE");
  return { inserted, updated, unchanged, currentRunMembershipProgress, historicalMembershipBoundaryReached };
}

function campaignCompletionProofFromState(state, scanRunId, collectorVersion) {
  const row = object(state);
  const matches =
    text(row.campaignProofScanRunId, 120) === scanRunId &&
    text(row.campaignProofCollectorVersion, 80) === collectorVersion;
  return {
    matches,
    campaignBatches: matches ? integer(row.campaignProofCampaignBatches, 1_000_000) ?? 0 : 0,
    claimerBatches: matches ? integer(row.campaignProofClaimerBatches) ?? 0 : 0,
    rejectedBatches: matches ? integer(row.campaignProofRejectedBatches, 1_000_000) ?? 0 : 0,
    rejectedRows: matches ? integer(row.campaignProofRejectedRows, 100_000_000) ?? 0 : 0,
  };
}

async function recordCampaignCompletionProofBatch(tx, { job, scanRunId, collectorVersion, kind, rejectedRows = 0, state = null }) {
  if (!['campaigns_page', 'campaign_claimers_page'].includes(kind)) return null;
  const previous = campaignCompletionProofFromState(
    state || await tx.creatorCampaignCollectionState.findUnique({ where: { creatorId: job.creatorId } }),
    scanRunId,
    collectorVersion,
  );
  const rejected = integer(rejectedRows, 10_000);
  if (rejected === null) throw new Error('Campaign completion proof rejectedRows is invalid');
  const data = {
    campaignProofScanRunId: scanRunId,
    campaignProofCollectorVersion: collectorVersion,
    campaignProofCampaignBatches: previous.campaignBatches + (kind === 'campaigns_page' ? 1 : 0),
    campaignProofClaimerBatches: previous.claimerBatches + (kind === 'campaign_claimers_page' ? 1 : 0),
    campaignProofRejectedBatches: previous.rejectedBatches + (rejected > 0 ? 1 : 0),
    campaignProofRejectedRows: previous.rejectedRows + rejected,
  };
  return tx.creatorCampaignCollectionState.update({
    where: { creatorId: job.creatorId },
    data,
  });
}
function proofMessage(proof) {
  return Object.entries(proof)
    .map(([key, value]) => `${key}=${value === null || value === undefined ? "null" : String(value)}`)
    .join("; ")
    .slice(0, 2000);
}

async function inTransaction(db, callback) {
  if (typeof db?.$transaction === "function") {
    return db.$transaction(callback, { maxWait: 10_000, timeout: 60_000 });
  }
  return callback(db);
}

async function beginBatch(tx, { job, agencyId, creatorId, deviceId, idempotencyKey, dataType, rangeFrom, rangeTo, sourceTimezone = "UTC", collectorVersion, schemaVersion, payload }) {
  const payloadChecksum = checksum(payload);
  const existing = await tx.analyticsIngestBatch.findUnique({ where: { idempotencyKey } });
  if (existing) {
    if (existing.payloadChecksum !== payloadChecksum) {
      throw new Error(`Analytics idempotency conflict for ${idempotencyKey}`);
    }
    return { batch: existing, replay: true };
  }
  const scopedAgencyId = job?.agencyId || agencyId;
  const scopedCreatorId = job?.creatorId || creatorId;
  if (!scopedAgencyId || !scopedCreatorId) throw new Error("Analytics batch scope is missing");
  const batch = await tx.analyticsIngestBatch.create({
    data: {
      agencyId: scopedAgencyId,
      creatorId: scopedCreatorId,
      sourceDeviceId: deviceId || null,
      sourceJobId: job?.id || null,
      idempotencyKey,
      dataType,
      status: "RECEIVED",
      rangeFrom,
      rangeTo,
      sourceTimezone,
      collectorVersion,
      schemaVersion,
      payloadChecksum,
      receivedRows: 0,
    },
  });
  return { batch, replay: false };
}
async function finishBatch(tx, batchId, counts, status = "COMMITTED", errorCode = null, errorMessage = null) {
  const completedAt = await dbAuthorityNow({ db: tx, fallbackNow: new Date() });
  return tx.analyticsIngestBatch.update({
    where: { id: batchId },
    data: {
      status,
      receivedRows: counts.received || 0,
      insertedRows: counts.inserted || 0,
      updatedRows: counts.updated || 0,
      unchangedRows: counts.unchanged || 0,
      rejectedRows: counts.rejected || 0,
      completedAt,
      lastErrorCode: errorCode,
      lastErrorMessage: errorMessage,
    },
  });
}
async function setCoverage(tx, { agencyId, creatorId, job, batchId, dataType, date, sourceTimezone = "UTC", status, coveredFromAt = null, coveredToAt = null, cursorStart = null, cursorEnd = null, errorCode = null, errorMessage = null, verifiedAt = new Date() }) {
  const scopedAgencyId = job?.agencyId || agencyId;
  const scopedCreatorId = job?.creatorId || creatorId;
  if (!scopedAgencyId || !scopedCreatorId) throw new Error("Coverage scope is missing");
  const coverageDate = utcDay(date);
  const complete = status === "COMPLETE";
  const from = complete && coveredFromAt === null ? coverageDate : coveredFromAt;
  const to = complete && coveredToAt === null ? utcDayEnd(coverageDate) : coveredToAt;
  return tx.analyticsCoverage.upsert({
    where: {
      creatorId_dataType_coverageDate_sourceTimezone: {
        creatorId: scopedCreatorId,
        dataType,
        coverageDate,
        sourceTimezone,
      },
    },
    create: {
      agencyId: scopedAgencyId,
      creatorId: scopedCreatorId,
      ingestBatchId: batchId,
      dataType,
      coverageDate,
      sourceTimezone,
      status,
      coveredFromAt: from,
      coveredToAt: to,
      sourceCursorStart: cursorStart,
      sourceCursorEnd: cursorEnd,
      lastVerifiedAt: verifiedAt,
      lastErrorCode: errorCode,
      lastErrorMessage: errorMessage,
    },
    update: {
      ingestBatchId: batchId,
      status,
      coveredFromAt: from,
      coveredToAt: to,
      sourceCursorStart: cursorStart,
      sourceCursorEnd: cursorEnd,
      lastVerifiedAt: verifiedAt,
      lastErrorCode: errorCode,
      lastErrorMessage: errorMessage,
      retryAfterAt: null,
    },
  });
}

function advisoryLockValue(namespace, scopeId) {
  const hex = crypto.createHash("sha256").update(`${namespace}:${scopeId}`).digest("hex").slice(0, 16);
  return BigInt.asIntN(64, BigInt(`0x${hex}`));
}

async function acquireAnalyticsLock(tx, namespace, scopeId) {
  if (typeof tx?.$executeRawUnsafe !== "function") return;
  const value = advisoryLockValue(namespace, scopeId);
  await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock($1::bigint)", value.toString());
}

function isNewerGeneration(existing, scanStartedAt) {
  const value = existing?.sourceScanStartedAt;
  const date = value instanceof Date ? value : value ? new Date(value) : null;
  return Boolean(date && Number.isFinite(date.getTime()) && date.getTime() > scanStartedAt.getTime());
}

function normalizeEarningsRow(raw) {
  const row = object(raw);
  const date = dateOnly(String(row.date || ""));
  const sourceTimezone = timezone(row.sourceTimezone || "UTC");
  const currencyCode = currency(row.currency);
  const optionalCents = (value) => (value === null || value === undefined ? null : cents(value));
  const values = {
    subscriptionsCents: optionalCents(row.subscriptionsCents),
    messagesCents: optionalCents(row.messagesCents),
    tipsCents: optionalCents(row.tipsCents),
    postsCents: optionalCents(row.postsCents),
    streamsCents: optionalCents(row.streamsCents),
    referralsCents: optionalCents(row.referralsCents),
    totalCents: cents(row.totalCents),
  };
  if (!date || sourceTimezone !== "UTC" || !currencyCode || values.totalCents === null) return null;
  const components = [values.subscriptionsCents, values.messagesCents, values.tipsCents, values.postsCents, values.streamsCents, values.referralsCents];
  if (components.some((value) => value !== null && !Number.isInteger(value))) return null;
  const known = components.filter((value) => value !== null);
  if (known.length === components.length && values.totalCents < known.reduce((sum, value) => sum + value, 0)) return null;
  const sourceUpdatedAt = row.sourceUpdatedAt == null ? null : strictDate(row.sourceUpdatedAt);
  if (row.sourceUpdatedAt != null && !sourceUpdatedAt) return null;
  return { date, sourceTimezone, currency: currencyCode, ...values, sourceUpdatedAt };
}

async function ingestEarningsChunk({ db = prisma, job, deviceId, chunk }) {
  requireJob(job);
  const payload = object(chunk);
  const scanRunId = text(payload.scanRunId, 120);
  const batchKey = text(payload.batchKey, 500);
  if (
    payload.kind !== "earnings_daily_page" ||
    payload.schemaVersion !== EARNINGS_SCHEMA_VERSION ||
    payload.collectorVersion !== EARNINGS_COLLECTOR_VERSION ||
    !scanRunId ||
    !batchKey
  ) {
    throw new Error("Invalid earnings page contract");
  }
  if (!batchKey.startsWith(`run:${scanRunId}:daily:`)) throw new Error("Earnings batch key does not match scan run");
  const idempotencyKey = `earnings:${job.id}:${batchKey}`;
  if (idempotencyKey.length > 240) throw new Error("Earnings idempotency key exceeds 240 characters");
  const observedAt = strictDate(payload.observedAt);
  if (!observedAt) throw new Error("Earnings page observedAt must be an ISO date-time with timezone");
  const requestedRange = earningsJobBounds(job);
  const rawRows = array(payload.rows);
  if (rawRows.length > 50) throw new Error("Earnings page exceeds 50 rows");
  const scannerRejected = integer(payload.scannerRejected, 10_000);
  if (scannerRejected === null) throw new Error("Earnings scannerRejected is invalid");
  const normalizedRows = rawRows.map(normalizeEarningsRow);
  const rejectedRows = normalizedRows.filter((row) => row === null).length;
  const rows = normalizedRows.filter(Boolean).sort((a, b) => compareDate(a.date, b.date));
  const rowKeys = new Set();
  for (const row of rows) {
    if (row.date < requestedRange.dayStart || row.date > requestedRange.dayEnd) {
      throw new Error("Earnings page contains a day outside the job range");
    }
    const key = `${row.date.toISOString().slice(0, 10)}:${row.sourceTimezone}`;
    if (rowKeys.has(key)) throw new Error(`Earnings page contains duplicate row ${key}`);
    rowKeys.add(key);
  }
  const rangeFrom = rows[0]?.date || requestedRange.dayStart;
  const rangeTo = rows.length ? utcDayEnd(rows.at(-1).date) : utcDayEnd(requestedRange.dayEnd);
  return inTransaction(db, async (tx) => {
    const serverReceivedAt = await dbAuthorityNow({ db: tx, fallbackNow: new Date() });
    await acquireAnalyticsLock(tx, "creator-earnings", job.creatorId);
    const { batch, replay } = await beginBatch(tx, {
      job,
      deviceId,
      idempotencyKey,
      dataType: "EARNINGS",
      rangeFrom,
      rangeTo,
      collectorVersion: EARNINGS_COLLECTOR_VERSION,
      schemaVersion: EARNINGS_SCHEMA_VERSION,
      payload,
    });
    if (replay && ["COMMITTED", "PARTIAL"].includes(batch.status)) {
      return { replay: true, batchId: batch.id, status: batch.status };
    }
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    const currentDay = utcDay(serverReceivedAt);
    for (const row of rows) {
      const where = { creatorId_date_sourceTimezone: { creatorId: job.creatorId, date: row.date, sourceTimezone: row.sourceTimezone } };
      const existing = await tx.creatorEarningsDaily.findUnique({
        where,
        select: { id: true, sourceScanRequestedAt: true },
      });
      const existingRequestedAt = existing?.sourceScanRequestedAt instanceof Date
        ? existing.sourceScanRequestedAt
        : existing?.sourceScanRequestedAt ? new Date(existing.sourceScanRequestedAt) : null;
      if (existingRequestedAt && Number.isFinite(existingRequestedAt.getTime()) && existingRequestedAt > requestedRange.contract.requestedAt) {
        unchanged += 1;
        continue;
      }
      const data = {
        agencyId: job.agencyId,
        creatorId: job.creatorId,
        ...row,
        sourceScanRunId: scanRunId,
        sourceScanRequestedAt: requestedRange.contract.requestedAt,
        scanProofId: null,
        collectedAt: serverReceivedAt,
        sourceDeviceId: deviceId || null,
        sourceJobId: job.id,
      };
      await tx.creatorEarningsDaily.upsert({ where, create: data, update: data });
      if (existing) updated += 1;
      else inserted += 1;
      const isCurrentDay = row.date.getTime() === currentDay.getTime();
      await setCoverage(tx, {
        job,
        batchId: batch.id,
        dataType: "EARNINGS",
        date: row.date,
        sourceTimezone: row.sourceTimezone,
        status: "PARTIAL",
        coveredFromAt: row.date,
        coveredToAt: isCurrentDay ? serverReceivedAt : utcDayEnd(row.date),
        errorCode: isCurrentDay ? "EARNINGS_DAY_IN_PROGRESS" : "EARNINGS_SCAN_PENDING",
        verifiedAt: serverReceivedAt,
      });
    }
    const rejected = scannerRejected + rejectedRows;
    await finishBatch(
      tx,
      batch.id,
      { received: rawRows.length + scannerRejected, inserted, updated, unchanged, rejected },
      rejected === 0 ? "COMMITTED" : "PARTIAL",
      rejected === 0 ? null : "EARNINGS_PAGE_REJECTED_ROWS",
    );
    return { replay: false, batchId: batch.id, inserted, updated, unchanged, rejected };
  });
}

async function completeEarningsScan({ db = prisma, job, deviceId, result }) {
  requireJob(job);
  const payload = object(result);
  const scanRunId = text(payload.scanRunId, 120);
  if (
    payload.schemaVersion !== EARNINGS_SCHEMA_VERSION ||
    payload.collectorVersion !== EARNINGS_COLLECTOR_VERSION ||
    !scanRunId
  ) {
    throw new Error("Invalid earnings completion contract");
  }
  const expectedDailyBatches = integer(payload.dailyBatchCount, 10_000);
  const expectedDailyCount = integer(payload.dailyCount, 20_000);
  const scannerRejected = integer(payload.scannerRejected, 10_000);
  if (expectedDailyBatches === null || expectedDailyCount === null || scannerRejected === null) throw new Error("Earnings completion counters are invalid");
  const observedAt = strictDate(payload.observedAt);
  if (!observedAt) throw new Error("Earnings completion observedAt must be an ISO date-time with timezone");
  const requestedRange = earningsJobBounds(job);
  const range = object(payload.range);
  const startDate = dateOnly(String(range.startDate || ""));
  const endDate = dateOnly(String(range.endDate || ""));
  if (!startDate || !endDate || startDate > endDate) throw new Error("Earnings completion range is invalid");
  if (startDate.getTime() !== requestedRange.dayStart.getTime() || endDate.getTime() !== requestedRange.dayEnd.getTime()) {
    throw new Error("Earnings completion range does not match the claimed job");
  }
  const key = `earnings:${job.id}:run:${scanRunId}:completion:v4`;
  if (key.length > 240) throw new Error("Earnings completion idempotency key exceeds 240 characters");
  return inTransaction(db, async (tx) => {
    const serverReceivedAt = await dbAuthorityNow({ db: tx, fallbackNow: new Date() });
    const { batch, replay } = await beginBatch(tx, {
      job,
      deviceId,
      idempotencyKey: key,
      dataType: "EARNINGS",
      rangeFrom: startDate,
      rangeTo: utcDayEnd(endDate),
      collectorVersion: EARNINGS_COLLECTOR_VERSION,
      schemaVersion: EARNINGS_SCHEMA_VERSION,
      payload,
    });
    const prefix = `earnings:${job.id}:run:${scanRunId}:daily:`;
    const pageBatches = await tx.analyticsIngestBatch.findMany({
      where: {
        sourceJobId: job.id,
        dataType: "EARNINGS",
        idempotencyKey: { startsWith: prefix },
      },
      select: { id: true, status: true, receivedRows: true, rejectedRows: true },
    });
    const acceptedRows = pageBatches.reduce((sum, row) => sum + row.receivedRows - row.rejectedRows, 0);
    const allCommitted = pageBatches.every((row) => row.status === "COMMITTED" && row.rejectedRows === 0);
    const persistedDailyCount = await tx.creatorEarningsDaily.count({
      where: { creatorId: job.creatorId, date: { gte: startDate, lte: endDate } },
    });
    const requestedDayCount = Math.floor((requestedRange.dayEnd.getTime() - requestedRange.dayStart.getTime()) / 86_400_000) + 1;
    const proof = {
      expectedDailyBatches,
      observedDailyBatches: pageBatches.length,
      expectedDailyCount,
      requestedDayCount,
      acceptedRows,
      persistedDailyCount,
      allCommitted,
      chartComplete: payload.chartComplete === true,
      dailyComplete: payload.dailyComplete === true,
      scannerRejected,
    };
    const evaluatedComplete =
      payload.chartComplete === true &&
      payload.dailyComplete === true &&
      scannerRejected === 0 &&
      allCommitted &&
      pageBatches.length === expectedDailyBatches &&
      expectedDailyCount === requestedDayCount &&
      acceptedRows === expectedDailyCount &&
      persistedDailyCount === expectedDailyCount;

    // Durable proof is the business/audit authority after operational ingest rows
    // become eligible for compaction. Replaying the exact immutable completion
    // payload after page-batch retention must therefore remain idempotently
    // COMMITTED instead of re-inferring PARTIAL from missing technical history.
    let scanProof = await tx.analyticsScanProof.findUnique({
      where: { creatorId_dataType_scanRunId: { creatorId: job.creatorId, dataType: "EARNINGS", scanRunId } },
    });
    if (scanProof) {
      if (scanProof.payloadChecksum !== batch.payloadChecksum
        || utcDay(scanProof.scanFrom).getTime() !== requestedRange.dayStart.getTime()
        || utcDay(scanProof.scanTo).getTime() !== requestedRange.dayEnd.getTime()) {
        throw new Error("Analytics scan proof idempotency conflict");
      }
    }
    // AnalyticsScanProof outlives every operational AnalyticsIngestBatch row.
    // A late replay may therefore arrive after retention removed both page and
    // completion batches. Matching COMMITTED durable proof remains sufficient
    // business evidence; technical history must never be required to re-prove it.
    const durableCommittedReplay = scanProof?.status === "COMMITTED";
    const complete = evaluatedComplete || durableCommittedReplay;
    const desiredStatus = complete ? "COMMITTED" : "PARTIAL";
    const completionBatch = (!replay || batch.status !== desiredStatus)
      ? await finishBatch(
        tx,
        batch.id,
        { received: expectedDailyCount + scannerRejected, unchanged: expectedDailyCount, rejected: scannerRejected },
        desiredStatus,
        complete ? null : "EARNINGS_SCAN_PROOF_INCOMPLETE",
        complete ? null : proofMessage(proof),
      )
      : batch;

    const proofRejectedRows = pageBatches.reduce((sum, row) => sum + Number(row.rejectedRows || 0), 0) + scannerRejected;
    if (scanProof) {

      // Completion is intentionally replayable. A first attempt may arrive before
      // every asynchronously-reported page has committed and therefore create a
      // PARTIAL receipt. Re-evaluating the same immutable completion payload may
      // later prove the scan complete. Receipt state is monotonic: PARTIAL may be
      // promoted to COMMITTED, but an already-COMMITTED durable proof is never
      // downgraded because operational page history was compacted or a stale retry
      // observed less transient execution evidence.
      if (scanProof.status !== "COMMITTED") {
        scanProof = await tx.analyticsScanProof.update({
          where: { id: scanProof.id },
          data: {
            status: desiredStatus,
            committedAt: complete ? serverReceivedAt : null,
            serverReceivedAt,
            clientObservedAt: observedAt,
            sourceDeviceId: deviceId || scanProof.sourceDeviceId || null,
            sourceJobId: scanProof.sourceJobId || job.id,
            rowCount: acceptedRows,
            rejectedRows: proofRejectedRows,
          },
        });
      }
    } else {
      scanProof = await tx.analyticsScanProof.create({
        data: {
          agencyId: job.agencyId,
          creatorId: job.creatorId,
          dataType: "EARNINGS",
          scanRunId,
          sourceTimezone: requestedRange.contract.sourceTimezone,
          scanFrom: requestedRange.dayStart,
          scanTo: requestedRange.dayEnd,
          requestedAt: requestedRange.contract.requestedAt,
          clientObservedAt: observedAt,
          serverReceivedAt,
          committedAt: complete ? serverReceivedAt : null,
          status: desiredStatus,
          collectorVersion: EARNINGS_COLLECTOR_VERSION,
          schemaVersion: EARNINGS_SCHEMA_VERSION,
          scanGeneration: requestedRange.contract.scanGeneration,
          collectionReason: requestedRange.contract.collectionReason,
          sourceDeviceId: deviceId || null,
          sourceJobId: job.id,
          rowCount: acceptedRows,
          rejectedRows: proofRejectedRows,
          payloadChecksum: completionBatch.payloadChecksum,
        },
      });
    }

    await tx.creatorEarningsDaily.updateMany({
      where: { creatorId: job.creatorId, sourceJobId: job.id, sourceScanRunId: scanRunId },
      data: { scanProofId: scanProof.id, sourceScanRequestedAt: requestedRange.contract.requestedAt },
    });

    if (pageBatches.length) {
      await tx.analyticsCoverage.updateMany({
        where: { creatorId: job.creatorId, dataType: "EARNINGS", ingestBatchId: { in: pageBatches.map((row) => row.id) } },
        data: { scanProofId: scanProof.id },
      });
    }
    if (complete && pageBatches.length) {
      await tx.analyticsCoverage.updateMany({
        where: {
          creatorId: job.creatorId,
          dataType: "EARNINGS",
          ingestBatchId: { in: pageBatches.map((row) => row.id) },
          coverageDate: { lt: utcDay(serverReceivedAt) },
          status: "PARTIAL",
          lastErrorCode: "EARNINGS_SCAN_PENDING",
        },
        data: {
          status: "COMPLETE",
          scanProofId: scanProof.id,
          lastVerifiedAt: serverReceivedAt,
          lastErrorCode: null,
          lastErrorMessage: null,
          retryAfterAt: null,
        },
      });
    }
    return { batchId: batch.id, scanProofId: scanProof.id, complete, replay: replay || durableCommittedReplay, proof };
  });
}

function normalizeCampaign(raw) {
  const row = object(raw);
  const externalCampaignId = text(row.id ?? row.externalCampaignId, 220);
  const name = text(row.name ?? row.title ?? (externalCampaignId ? `Campaign ${externalCampaignId}` : null), 500);
  if (!externalCampaignId || !name) return null;
  const startedAtRaw = row.startedAt ?? row.createdAt ?? row.created_at;
  const endedAtRaw = row.endedAt ?? row.ended_at;
  const startedAt = startedAtRaw == null ? null : strictDate(startedAtRaw);
  const endedAt = endedAtRaw == null ? null : strictDate(endedAtRaw);
  const claimersRaw = row.claimers_count ?? row.claimersCount;
  const clicksRaw = row.clicks_count ?? row.clicksCount;
  const claimersCount = claimersRaw == null ? null : integer(claimersRaw);
  const clicksCount = clicksRaw == null ? null : integer(clicksRaw);
  if (startedAtRaw != null && !startedAt) return null;
  if (endedAtRaw != null && !endedAt) return null;
  if (claimersRaw != null && claimersCount === null) return null;
  if (clicksRaw != null && clicksCount === null) return null;
  if (startedAt && endedAt && endedAt < startedAt) return null;
  return {
    externalCampaignId,
    name,
    campaignType: text(row.type ?? row.campaignType, 80),
    trackingCode: text(row.trackingCode ?? row.code, 220),
    trackingUrl: text(row.trackingUrl ?? row.url, 4000),
    isActive: row.is_active === true || row.isActive === true,
    startedAt,
    endedAt,
    claimersCount,
    clicksCount,
  };
}
function normalizeClaimer(raw) {
  const row = object(raw);
  const nestedUser = object(row.user || row.fan || row.subscriber);
  const hasNestedUser = Object.keys(nestedUser).length > 0;
  const user = hasNestedUser ? nestedUser : row;
  // Desktop's canonical flattened claimer contract is { id: claimerId, userId: fanId }.
  // Never let the attribution row id masquerade as the OnlyFans user id.
  const onlyFansUserId = text(hasNestedUser
    ? (user.id ?? user.userId ?? row.userId ?? row.fanId)
    : (row.userId ?? row.fanId ?? row.id), 180);
  if (!onlyFansUserId) return null;
  const attributedAtRaw = row.attributedAt ?? row.createdAt ?? row.created_at ?? row.claimedAt;
  const attributedAt = attributedAtRaw == null ? null : strictDate(attributedAtRaw);
  if (attributedAtRaw != null && !attributedAt) return null;
  const username = text(user.username, 200);
  const displayName = text(user.name ?? user.displayName, 500);
  const avatarUrl = text(user.avatar ?? user.avatarUrl ?? object(user.avatarThumbs).c144 ?? object(user.avatarThumbs).c50, 1200);
  const embeddedRaw = object(row.embeddedValue);
  let embeddedValue = null;
  if (Object.keys(embeddedRaw).length) {
    try {
      embeddedValue = normalizeCampaignFanValueItem({
        ...embeddedRaw,
        fanOnlyFansUserId: onlyFansUserId,
        available: true,
        username,
        displayName,
        avatarUrl,
      }, embeddedRaw.observedAt);
    } catch {
      return null;
    }
    if (embeddedValue.available !== true) return null;
  }
  return {
    onlyFansUserId,
    username,
    displayName,
    avatarUrl,
    externalClaimerId: text(row.id ?? row.claimerId, 220),
    attributedAt,
    embeddedValue,
  };
}

async function ingestCampaignChunk({ db = prisma, job, deviceId, chunk }) {
  requireJob(job);
  const payload = object(chunk);
  const kind = text(payload.kind, 80);
  if (!["campaigns_page", "campaign_claimers_page"].includes(kind)) throw new Error("Unsupported campaign chunk kind");
  const batchKey = text(payload.batchKey, 500);
  const command = collectionCommand(job, COLLECTOR_TYPES.CAMPAIGNS);
  const scanRunId = text(payload.scanRunId, 120);
  const scanStartedAt = command.requestedAt;
  const processObservedAt = new Date();
  if (
    !batchKey || !scanRunId || scanRunId !== command.generation ||
    payload.schemaVersion !== CAMPAIGN_SCHEMA_VERSION || !CAMPAIGN_COMPAT_COLLECTOR_VERSIONS.has(payload.collectorVersion)
  ) {
    throw new Error("Invalid campaign chunk contract");
  }
  if (!batchKey.startsWith(`run:${scanRunId}:`)) throw new Error("Campaign batch key does not match scan run");
  const idempotencyKey = `campaigns:${job.id}:${batchKey}`;
  if (idempotencyKey.length > 240) throw new Error("Campaign idempotency key exceeds 240 characters");
  const scannerRejected = integer(payload.scannerRejected, 10_000);
  if (scannerRejected === null) throw new Error("Campaign scannerRejected is invalid");
  const rawRows = kind === "campaigns_page" ? array(payload.campaigns) : array(payload.claimers);
  if (rawRows.length > 50) throw new Error(kind === "campaigns_page" ? "Campaign page exceeds 50 rows" : "Campaign claimer page exceeds 50 rows");
  const externalCampaignId = kind === "campaign_claimers_page" ? text(payload.externalCampaignId, 220) : null;
  if (kind === "campaign_claimers_page" && !externalCampaignId) throw new Error("Campaign claimer page is missing externalCampaignId");

  return inTransaction(db, async (tx) => {
    await enterCampaignWriterGeneration({ db: tx });
    await acquireAnalyticsLock(tx, "creator-campaigns", job.creatorId);

    // Current selective Campaign claimer writes are only legal after the server
    // has issued this exact Campaign as a target for this scanRun. Perform this
    // preflight before generation acceptance so a direct/stale claimer write
    // cannot activate or reset collection state and only then be rejected.
    if (kind === "campaign_claimers_page" && command.mode === "catchup" && Number(object(job.params).campaignFrontierSchedulingVersion || 0) >= CAMPAIGN_FRONTIER_SCHEDULING_VERSION) {
      const reuse = campaignDirectoryReuseBinding(job);
      if (reuse) {
        if (typeof tx.creatorCampaignCollectionState?.findUnique !== "function") {
          const error = new Error("Campaign directory reuse authority store is unavailable");
          error.code = "CAMPAIGN_DIRECTORY_REUSE_STORE_UNAVAILABLE";
          throw error;
        }
        const directoryState = await tx.creatorCampaignCollectionState.findUnique({ where: { creatorId: job.creatorId } });
        if (!campaignDirectoryReuseStateMatches(directoryState, reuse, command)) {
          const error = new Error("Campaign directory reuse generation is stale");
          error.code = "CAMPAIGN_DIRECTORY_REUSE_STALE";
          throw error;
        }
      }
      const target = await tx.creatorCampaign.findUnique({
        where: { creatorId_externalCampaignId: { creatorId: job.creatorId, externalCampaignId } },
        select: { claimersTargetRunId: true },
      });
      if (!target) throw new Error("Campaign claimer page references an unknown campaign");
      if (target.claimersTargetRunId !== scanRunId) {
        const error = new Error("Campaign claimer page is outside the server-selected frontier budget");
        error.code = "CAMPAIGN_FRONTIER_NOT_TARGETED";
        throw error;
      }
    }

    const generation = await acceptCampaignGeneration({ db: tx, job, deviceId });
    if (!generation.accepted) return { replay: false, superseded: true, generation: generation.command.generation };
    const serverReceivedAt = await dbAuthorityNow({ db: tx, fallbackNow: processObservedAt });
    const { batch, replay } = await beginBatch(tx, {
      job,
      deviceId,
      idempotencyKey,
      dataType: "CAMPAIGNS",
      rangeFrom: scanStartedAt,
      rangeTo: serverReceivedAt,
      collectorVersion: payload.collectorVersion,
      schemaVersion: payload.schemaVersion,
      payload,
    });
    if (replay && ["COMMITTED", "PARTIAL"].includes(batch.status)) {
      return { replay: true, batchId: batch.id, status: batch.status };
    }

    const received = rawRows.length + scannerRejected;

    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    let rejected = scannerRejected;

    if (kind === "campaigns_page") {
      for (const rawCampaign of rawRows) {
        const campaign = normalizeCampaign(rawCampaign);
        if (!campaign) {
          rejected += 1;
          continue;
        }
        const where = { creatorId_externalCampaignId: { creatorId: job.creatorId, externalCampaignId: campaign.externalCampaignId } };
        const existing = await tx.creatorCampaign.findUnique({
          where,
          select: { id: true, sourceScanStartedAt: true, isActive: true, claimersCount: true, claimerRevision: true },
        });
        if (isNewerGeneration(existing, scanStartedAt)) {
          unchanged += 1;
          continue;
        }
        const common = {
          name: campaign.name,
          isActive: campaign.isActive,
          ...(campaign.campaignType !== null ? { campaignType: campaign.campaignType } : {}),
          ...(campaign.trackingCode !== null ? { trackingCode: campaign.trackingCode } : {}),
          ...(campaign.trackingUrl !== null ? { trackingUrl: campaign.trackingUrl } : {}),
          ...(campaign.startedAt !== null ? { startedAt: campaign.startedAt } : {}),
          ...(campaign.endedAt !== null ? { endedAt: campaign.endedAt } : {}),
          ...(campaign.claimersCount !== null ? { claimersCount: campaign.claimersCount } : {}),
          ...(campaign.clicksCount !== null ? { clicksCount: campaign.clicksCount } : {}),
          sourceScanRunId: scanRunId,
          sourceScanStartedAt: scanStartedAt,
          collectedAt: serverReceivedAt,
          sourceDeviceId: deviceId || null,
          sourceJobId: job.id,
        };
        const frontierSignalChanged = Boolean(existing) && (
          existing.isActive !== campaign.isActive ||
          (campaign.claimersCount !== null && existing.claimersCount !== campaign.claimersCount)
        );
        if (frontierSignalChanged) {
          common.claimerRevision = { increment: 1 };
          common.claimersNextDueAt = serverReceivedAt;
        }
        await tx.creatorCampaign.upsert({
          where,
          create: {
            agencyId: job.agencyId,
            creatorId: job.creatorId,
            ...campaign,
            sourceScanRunId: scanRunId,
            sourceScanStartedAt: scanStartedAt,
            collectedAt: serverReceivedAt,
            sourceDeviceId: deviceId || null,
            sourceJobId: job.id,
            claimerRevision: 1,
            claimerVerifiedRevision: 0,
            claimersNextDueAt: serverReceivedAt,
          },
          update: common,
        });
        if (existing) updated += 1;
        else inserted += 1;
      }
      await finishBatch(
        tx,
        batch.id,
        { received, inserted, updated, unchanged, rejected },
        rejected ? "PARTIAL" : "COMMITTED",
        rejected ? "CAMPAIGN_PAGE_REJECTED_ROWS" : null,
      );
      await recordCampaignCompletionProofBatch(tx, {
        job, scanRunId, collectorVersion: payload.collectorVersion, kind, rejectedRows: rejected, state: generation.state,
      });
      return { replay: false, batchId: batch.id, inserted, updated, unchanged, rejected, superseded: false };
    }

    const saved = await tx.creatorCampaign.findUnique({
      where: { creatorId_externalCampaignId: { creatorId: job.creatorId, externalCampaignId } },
      select: {
        id: true,
        catchupFrontierHash: true,
        catchupFrontierRunId: true,
        catchupFrontierStartedAt: true,
        stagedCatchupFrontierHash: true,
        stagedCatchupFrontierRunId: true,
        stagedCatchupFrontierStartedAt: true,
        isActive: true,
        claimerRevision: true,
        claimerVerifiedRevision: true,
        claimersTargetRunId: true,
      },
    });
    if (!saved) throw new Error("Campaign claimer page references an unknown campaign");
    const frontierSchedulingCurrent = Number(object(job.params).campaignFrontierSchedulingVersion || 0) >= CAMPAIGN_FRONTIER_SCHEDULING_VERSION;
    if (frontierSchedulingCurrent && command.mode === "catchup" && saved.claimersTargetRunId !== scanRunId) {
      const error = new Error("Campaign claimer page is outside the server-selected frontier budget");
      error.code = "CAMPAIGN_FRONTIER_NOT_TARGETED";
      throw error;
    }
    const frontierFanState = await readCampaignFrontierFanState(tx, {
      campaignId: saved.id,
      canonicalRunId: saved.catchupFrontierRunId,
      canonicalStartedAt: saved.catchupFrontierStartedAt,
      stagedRunId: saved.stagedCatchupFrontierRunId,
      stagedStartedAt: saved.stagedCatchupFrontierStartedAt,
    });
    const uniqueClaimers = new Map();
    let backendRejected = 0;
    for (const rawClaimer of rawRows) {
      const claimer = normalizeClaimer(rawClaimer);
      if (!claimer) {
        rejected += 1;
        backendRejected += 1;
        continue;
      }
      const existingClaimer = uniqueClaimers.get(claimer.onlyFansUserId);
      uniqueClaimers.set(claimer.onlyFansUserId, existingClaimer ? {
        ...existingClaimer,
        ...claimer,
        username: claimer.username || existingClaimer.username || null,
        displayName: claimer.displayName || existingClaimer.displayName || null,
        avatarUrl: claimer.avatarUrl || existingClaimer.avatarUrl || null,
        embeddedValue: claimer.embeddedValue || existingClaimer.embeddedValue || null,
      } : claimer);
    }
    const duplicateClaimers = rawRows.length - backendRejected - uniqueClaimers.size;
    unchanged += duplicateClaimers;

    const activation = await campaignCausalV1State({ db: tx, lockForCommit: true });
    const observationTokenRequired = activation.active === true || Number(object(job.params).observationTokenVersion || 0) >= 1;
    let identityObservedAt = serverReceivedAt;
    if (uniqueClaimers.size && observationTokenRequired) {
      const observationToken = text(payload.observationToken, 500);
      if (!observationToken) throw new Error("CAMPAIGN_CLAIMER_OBSERVATION_TOKEN_REQUIRED");
      const consumed = await consumeFanObservationToken({
        db: tx,
        job,
        deviceId,
        leaseRevision: Number(job.leaseRevision),
        token: observationToken,
        purpose: "campaign_claimers_page",
        subjects: [...uniqueClaimers.keys()],
      });
      identityObservedAt = strictDate(consumed.observedAt);
      if (!identityObservedAt) throw new Error("CAMPAIGN_CLAIMER_OBSERVATION_TIME_INVALID");
    }

    const claimerObservations = [...uniqueClaimers.values()].map((claimer) => ({
      onlyFansUserId: claimer.onlyFansUserId,
      identity: {
        username: claimer.username,
        platformDisplayName: claimer.displayName,
        avatarUrl: claimer.avatarUrl,
        observedAt: identityObservedAt,
        activityObservedAt: identityObservedAt,
        source: "CAMPAIGN_CLAIMER",
      },
      ...(claimer.embeddedValue?.available === true ? {
        value: {
          availability: "AVAILABLE",
          totalSpentCents: claimer.embeddedValue.values.totalSpentCents,
          messagesSpentCents: claimer.embeddedValue.values.messagesSpentCents,
          subscriptionsSpentCents: claimer.embeddedValue.values.subscriptionsSpentCents,
          tipsSpentCents: claimer.embeddedValue.values.tipsSpentCents,
          postsSpentCents: claimer.embeddedValue.values.postsSpentCents,
          streamsSpentCents: claimer.embeddedValue.values.streamsSpentCents,
          lastActivityAt: claimer.embeddedValue.lastActivityAt,
          observedAt: identityObservedAt,
          source: "CAMPAIGN_CLAIMER",
        },
      } : {}),
    }));
    if (claimerObservations.length) {
      await projectFanObservationBatch(tx, {
        agencyId: job.agencyId,
        creatorId: job.creatorId,
        sourceDeviceId: deviceId || null,
        sourceJobId: job.id,
        scanRunId,
        items: claimerObservations,
        allowedSources: ["CAMPAIGN_CLAIMER"],
        observedAtPolicy: "TRUSTED_INPUT",
        receivedAt: serverReceivedAt,
      });
    }

    let projectedFans = [];
    const projectedFanIds = [...uniqueClaimers.keys()];
    if (projectedFanIds.length && typeof tx.creatorFan?.findMany === "function") {
      projectedFans = await tx.creatorFan.findMany({
        where: { creatorId: job.creatorId, onlyFansUserId: { in: projectedFanIds } },
        select: { id: true, onlyFansUserId: true, valueCurrent: { select: { valueObservedAt: true } } },
        take: projectedFanIds.length,
      });
    } else if (projectedFanIds.length && typeof tx.creatorFan?.findUnique === "function") {
      projectedFans = (await Promise.all(projectedFanIds.map(async (onlyFansUserId) => {
        const fan = await tx.creatorFan.findUnique({
          where: { creatorId_onlyFansUserId: { creatorId: job.creatorId, onlyFansUserId } },
          select: { id: true, onlyFansUserId: true, valueCurrent: { select: { valueObservedAt: true } } },
        });
        return fan ? { ...fan, onlyFansUserId: fan.onlyFansUserId || onlyFansUserId } : null;
      }))).filter(Boolean);
    }
    const fanByOnlyFansUserId = new Map(projectedFans.map((fan) => [String(fan.onlyFansUserId), fan]));
    // Membership is historical Campaign provenance. Project the complete page
    // with one set-based statement: lock existing membership rows, preserve the
    // oldest attribution time, reject older generations, derive exact historical
    // deep-boundary/no-progress evidence, and upsert all accepted memberships.
    // This replaces the previous N findUnique + N upsert topology.
    const canonicalFrontierStartedAt =
      CAMPAIGN_SERVER_REFRESH_COLLECTOR_VERSIONS.has(payload.collectorVersion) &&
      String(payload.campaignMode || '').toLowerCase() === 'catchup' &&
      Boolean(saved.catchupFrontierHash) &&
      Boolean(saved.catchupFrontierRunId)
        ? strictDate(saved.catchupFrontierStartedAt)
        : null;
    const membershipProjection = await projectCampaignMembershipBatch(tx, {
      job,
      campaignId: saved.id,
      scanRunId,
      scanStartedAt,
      serverReceivedAt,
      deviceId,
      claimers: [...uniqueClaimers.values()],
      fanByOnlyFansUserId,
      canonicalFrontierStartedAt,
    });
    inserted += membershipProjection.inserted;
    updated += membershipProjection.updated;
    unchanged += membershipProjection.unchanged;
    const historicalMembershipBoundaryReached = membershipProjection.historicalMembershipBoundaryReached;
    const currentRunMembershipProgress = membershipProjection.currentRunMembershipProgress;

    let fanRefreshQueue = null;
    if (CAMPAIGN_SERVER_REFRESH_COLLECTOR_VERSIONS.has(payload.collectorVersion)) {
      // Every accepted fan participates in per-run freshness coverage. Embedded
      // subscribedOnData and already-fresh canonical values are terminal
      // ALREADY_FRESH evidence; stale/missing values attach to a cross-run
      // coalesced refresh demand instead of spawning one job per Campaign run.
      const refreshCandidates = [...uniqueClaimers.values()].map((claimer) => ({
        onlyFansUserId: claimer.onlyFansUserId,
        embeddedValueAvailable: claimer.embeddedValue?.available === true,
        valueObservedAt: fanByOnlyFansUserId.get(String(claimer.onlyFansUserId))?.valueCurrent?.valueObservedAt || null,
      }));
      fanRefreshQueue = await enqueueUniqueCampaignFanRefreshes({
        db: tx, job, scanRunId, scanStartedAt, candidates: refreshCandidates, now: serverReceivedAt,
        collectorVersion: payload.collectorVersion,
      });
    }

    const claimerPageNumber = integer(payload.pageNumber);
    const pageFrontierFanIds = campaignClaimerFrontierFanIds([...uniqueClaimers.keys()]);
    const canonicalFrontierFanIds = frontierFanState.canonical;
    const canonicalFrontierSet = new Set(canonicalFrontierFanIds);
    const exactAnchorBoundaryReached =
      canonicalFrontierSet.size > 0 &&
      pageFrontierFanIds.some((fanId) => canonicalFrontierSet.has(fanId));
    // campaigns-v12 is intentionally order-independent. OF does not expose a
    // source-level ordering/cursor contract that proves a historical membership
    // or matching head page is the end of all unseen claimers. Preserve legacy
    // deep-boundary behavior only for already-running pre-v12 collectors; the
    // current collector reaches membership completion only at sourceHasMore=false.
    const orderIndependentTraversal = CAMPAIGN_ORDER_INDEPENDENT_COLLECTOR_VERSIONS.has(payload.collectorVersion);
    const serverDeepBoundaryReached =
      orderIndependentTraversal !== true &&
      CAMPAIGN_SERVER_REFRESH_COLLECTOR_VERSIONS.has(payload.collectorVersion) &&
      String(payload.campaignMode || '').toLowerCase() === 'catchup' &&
      rejected === 0 &&
      (exactAnchorBoundaryReached || historicalMembershipBoundaryReached);
    const serverNoProgressDetected =
      CAMPAIGN_RESUMABLE_COLLECTOR_VERSIONS.has(payload.collectorVersion) &&
      payload.sourceHasMore === true &&
      serverDeepBoundaryReached !== true &&
      currentRunMembershipProgress === 0;
    const knownBoundaryReached = orderIndependentTraversal
      ? false
      : payload.knownBoundaryReached === true || serverDeepBoundaryReached;
    const campaignComplete = orderIndependentTraversal
      ? payload.sourceHasMore !== true && payload.campaignComplete === true && rejected === 0
      : (payload.campaignComplete === true || serverDeepBoundaryReached) && rejected === 0;
    const firstPageFrontierFanIds = claimerPageNumber === 1 && rejected === 0 ? pageFrontierFanIds : null;
    const firstPageFrontierHash = firstPageFrontierFanIds
      ? campaignClaimerFrontierHash(firstPageFrontierFanIds)
      : null;
    const stagedStartedAt = strictDate(saved.stagedCatchupFrontierStartedAt);
    const stagedFrontierMatchesGeneration =
      Boolean(saved.stagedCatchupFrontierHash) &&
      saved.stagedCatchupFrontierRunId === scanRunId &&
      Boolean(stagedStartedAt) &&
      stagedStartedAt.getTime() === scanStartedAt.getTime();
    const stagedFrontierFanIds = stagedFrontierMatchesGeneration
      ? frontierFanState.staged
      : [];
    const frontierToPublish = firstPageFrontierHash || (
      campaignComplete && stagedFrontierMatchesGeneration
        ? text(saved.stagedCatchupFrontierHash, 64)
        : null
    );
    const frontierFanIdsToPublish = firstPageFrontierFanIds || (
      campaignComplete && stagedFrontierMatchesGeneration
        ? stagedFrontierFanIds
        : null
    );

    if (firstPageFrontierHash && !campaignComplete) {
      // Stage the normalized head-page fingerprint, but do not publish it as
      // the canonical catch-up frontier until this Campaign reaches a proven
      // boundary. Exact fan anchors are stored in a typed relation rather than
      // business JSON on CreatorCampaign.
      await replaceCampaignFrontierFanState(tx, {
        job, campaignId: saved.id, frontierKind: "STAGED",
        fanIds: firstPageFrontierFanIds, scanRunId, scanStartedAt,
      });
      await tx.creatorCampaign.update({
        where: { id: saved.id },
        data: {
          stagedCatchupFrontierHash: firstPageFrontierHash,
          stagedCatchupFrontierRunId: scanRunId,
          stagedCatchupFrontierStartedAt: scanStartedAt,
        },
      });
    } else if (campaignComplete && frontierToPublish) {
      // Publish only after the provider boundary is proven in the same scan
      // generation. Canonical typed anchors are replaced atomically with the
      // scalar frontier metadata and staged anchors are cleared in this outer
      // transaction.
      await replaceCampaignFrontierFanState(tx, {
        job, campaignId: saved.id, frontierKind: "CANONICAL",
        fanIds: frontierFanIdsToPublish || [], scanRunId, scanStartedAt,
      });
      await replaceCampaignFrontierFanState(tx, {
        job, campaignId: saved.id, frontierKind: "STAGED",
        fanIds: [], scanRunId: null, scanStartedAt: null,
      });
      await tx.creatorCampaign.update({
        where: { id: saved.id },
        data: {
          catchupFrontierHash: frontierToPublish,
          catchupFrontierRunId: scanRunId,
          catchupFrontierStartedAt: scanStartedAt,
          stagedCatchupFrontierHash: null,
          stagedCatchupFrontierRunId: null,
          stagedCatchupFrontierStartedAt: null,
        },
      });
    }

    if (campaignComplete && frontierSchedulingCurrent) {
      const verificationIntervalMs = saved.isActive === false
        ? CAMPAIGN_INACTIVE_FRONTIER_FRESHNESS_MS
        : CAMPAIGN_ACTIVE_FRONTIER_FRESHNESS_MS;
      const verifiedRevision = Math.max(1, Number(saved.claimerRevision || 1));
      const verified = await tx.creatorCampaign.updateMany({
        where: {
          id: saved.id, creatorId: job.creatorId,
          ...(command.mode === "catchup" ? { claimersTargetRunId: scanRunId } : {}),
        },
        data: {
          claimerVerifiedRevision: verifiedRevision,
          claimersVerifiedAt: serverReceivedAt,
          claimersNextDueAt: new Date(serverReceivedAt.getTime() + verificationIntervalMs),
          claimersLastVerifiedRunId: scanRunId,
          claimersTargetRunId: null,
        },
      });
      if (!verified.count && command.mode === "catchup") {
        const error = new Error("Campaign frontier target changed before verification commit");
        error.code = "CAMPAIGN_FRONTIER_TARGET_STALE";
        throw error;
      }
      if (verified.count && typeof tx.creatorCampaignCollectionState?.findUnique === "function") {
        const frontierState = await tx.creatorCampaignCollectionState.findUnique({ where: { creatorId: job.creatorId } });
        if (frontierState?.campaignFrontierPlanRunId === scanRunId) {
          const completed = Math.min(
            Math.max(0, Number(frontierState.campaignFrontierTargetCount || 0)),
            Math.max(0, Number(frontierState.campaignFrontierCompletedCount || 0)) + 1,
          );
          const target = Math.max(0, Number(frontierState.campaignFrontierTargetCount || 0));
          const deferred = Math.max(0, Number(frontierState.campaignFrontierDeferredCount || 0));
          await tx.creatorCampaignCollectionState.update({
            where: { creatorId: job.creatorId },
            data: {
              campaignFrontierCompletedCount: completed,
              campaignFrontierFreshnessStatus: completed >= target ? (deferred > 0 ? "PARTIAL" : "COMPLETE") : "SCANNING",
              campaignFrontierUpdatedAt: serverReceivedAt,
            },
          });
        }
      }
    }

    // Campaign attribution is historical. A later OF response may be partial,
    // delayed or temporarily omit a claimer; never erase a previously observed
    // campaign -> fan fact from a scanner page. New scans only add or refresh
    // evidence. CreatorCampaign.isActive is reconciled separately after a fully
    // proven campaign-list scan.
    await finishBatch(
      tx,
      batch.id,
      { received, inserted, updated, unchanged, rejected },
      rejected ? "PARTIAL" : "COMMITTED",
      rejected ? "CAMPAIGN_CLAIMER_PAGE_REJECTED_ROWS" : null,
    );
    await recordCampaignCompletionProofBatch(tx, {
      job, scanRunId, collectorVersion: payload.collectorVersion, kind, rejectedRows: rejected, state: generation.state,
    });
    return {
      replay: false, batchId: batch.id, inserted, updated, unchanged, rejected, campaignComplete,
      knownBoundaryReached, serverDeepBoundaryReached, serverNoProgressDetected, externalCampaignId, fanRefreshQueue, superseded: false,
    };
  });
}

function normalizeCampaignFanValueItem(payload, inheritedObservedAt = null) {
  const item = object(payload);
  // Desktop observation time is retained as provenance only. Canonical FanData
  // ordering is server-owned: causal jobs consume the post-read token chronology;
  // pre-cutover legacy jobs retain PostgreSQL receipt time as their rollout fallback.
  const clientObservedAt = strictDate(item.observedAt ?? inheritedObservedAt);
  const onlyFansUserId = text(item.fanOnlyFansUserId, 180);
  if (!clientObservedAt || !onlyFansUserId) throw new Error("Invalid campaign fan value item contract");
  if (item.available !== true) {
    return { available: false, clientObservedAt, onlyFansUserId, reasonCode: text(item.reasonCode, 180) || "FAN_VALUE_UNAVAILABLE" };
  }
  const values = {
    totalSpentCents: safeBigIntCents(item.totalSpentCents ?? item.totalNetCents),
    messagesSpentCents: safeBigIntCents(item.messagesSpentCents ?? item.messagesNetCents),
    subscriptionsSpentCents: safeBigIntCents(item.subscriptionsSpentCents ?? item.subscriptionsNetCents),
    tipsSpentCents: safeBigIntCents(item.tipsSpentCents ?? item.tipsNetCents),
    postsSpentCents: safeBigIntCents(item.postsSpentCents ?? item.postsNetCents),
    streamsSpentCents: safeBigIntCents(item.streamsSpentCents ?? item.streamsNetCents),
  };
  if (values.totalSpentCents === null) throw new Error("Campaign fan value total cents are invalid");
  const lastActivityAt = item.lastActivityAt == null ? null : strictDate(item.lastActivityAt);
  if (item.lastActivityAt != null && !lastActivityAt) throw new Error("Campaign fan value lastActivityAt is invalid");
  return {
    available: true, clientObservedAt, onlyFansUserId, values, lastActivityAt,
    observationToken: text(item.observationToken, 500),
    username: text(item.username, 200),
    displayName: text(item.displayName, 500),
    avatarUrl: text(item.avatarUrl, 1200),
    headerUrl: text(item.headerUrl, 1200),
  };
}

async function assertCampaignFanValueScope(tx, job, scanRunId, onlyFansUserIds) {
  const ids = [...new Set((onlyFansUserIds || []).map((value) => text(value, 180)).filter(Boolean))];
  if (!ids.length) return;
  if (!tx.creatorCampaignFan?.findMany) {
    const error = new Error("Campaign fan value evidence store is unavailable");
    error.code = "CAMPAIGN_FAN_VALUE_SCOPE_STORE_UNAVAILABLE";
    throw error;
  }
  const rows = await tx.creatorCampaignFan.findMany({
    where: {
      creatorId: job.creatorId,
      sourceJobId: job.id,
      sourceScanRunId: scanRunId,
      fan: { onlyFansUserId: { in: ids } },
    },
    select: { fan: { select: { onlyFansUserId: true } } },
    take: ids.length,
  });
  const proven = new Set((rows || []).map((row) => text(row?.fan?.onlyFansUserId, 180)).filter(Boolean));
  const unproven = ids.filter((id) => !proven.has(id));
  if (unproven.length) {
    const error = new Error("Campaign fan value is outside the server-proven claimer scope");
    error.code = "CAMPAIGN_FAN_VALUE_SCOPE_MISMATCH";
    throw error;
  }
}

async function projectCampaignFanValueCurrent({ tx, job, deviceId, scanRunId, item, observedAt }) {
  const authorityObservedAt = strictDate(observedAt);
  if (!authorityObservedAt) throw new Error("Campaign fan value authority time is invalid");
  return projectFanValue(tx, {
    agencyId: job.agencyId,
    creatorId: job.creatorId,
    onlyFansUserId: item.onlyFansUserId,
    totalSpentCents: item.values.totalSpentCents,
    messagesSpentCents: item.values.messagesSpentCents,
    subscriptionsSpentCents: item.values.subscriptionsSpentCents,
    tipsSpentCents: item.values.tipsSpentCents,
    postsSpentCents: item.values.postsSpentCents,
    streamsSpentCents: item.values.streamsSpentCents,
    lastActivityAt: item.lastActivityAt,
    availability: "AVAILABLE",
    observedAt: authorityObservedAt,
    source: "CAMPAIGN_CLAIMER",
    sourceDeviceId: deviceId || null,
    sourceJobId: job.id,
    scanRunId,
  });
}

async function upsertCampaignFanValueTx({ tx, job, deviceId, scanRunId, item, authorityObservedAt }) {
  if (item.available !== true) return { available: false, reasonCode: item.reasonCode };
  const observedAt = strictDate(authorityObservedAt);
  if (!observedAt) throw new Error("Campaign fan value authority time is invalid");
  const fan = await projectFanIdentity(tx, {
    agencyId: job.agencyId,
    creatorId: job.creatorId,
    onlyFansUserId: item.onlyFansUserId,
    username: item.username,
    platformDisplayName: item.displayName,
    avatarUrl: item.avatarUrl,
    headerUrl: item.headerUrl,
    observedAt,
    source: "CAMPAIGN_CLAIMER",
  });
  const projected = await projectCampaignFanValueCurrent({ tx, job, deviceId, scanRunId, item, observedAt });
  return {
    replay: projected.replay,
    available: true,
    fanRecordId: fan.id,
    fetchedAt: projected.record?.valueObservedAt || observedAt,
  };
}

function campaignFanValueObservationTokenRequired(job) {
  return Number(object(job?.params).observationTokenVersion || 0) >= 1;
}

async function campaignFanValueAuthorityObservedAt({ tx, job, deviceId, item, fallbackObservedAt }) {
  if (item.available !== true) return fallbackObservedAt;
  const activation = await campaignCausalV1State({ db: tx, lockForCommit: true });
  if (!activation.active && !campaignFanValueObservationTokenRequired(job)) return fallbackObservedAt;
  if (!item.observationToken) throw new Error("CAMPAIGN_FAN_VALUE_OBSERVATION_TOKEN_REQUIRED");
  const consumed = await consumeFanObservationToken({
    db: tx,
    job,
    deviceId,
    leaseRevision: Number(job.leaseRevision),
    token: item.observationToken,
    purpose: "campaign_fan_values",
    subjects: [item.onlyFansUserId],
  });
  const observedAt = strictDate(consumed.observedAt);
  if (!observedAt) throw new Error("CAMPAIGN_FAN_VALUE_OBSERVATION_TIME_INVALID");
  return observedAt;
}

async function ingestCampaignFanValueChunk({ db = prisma, job, deviceId, chunk }) {
  requireJob(job);
  const payload = object(chunk);
  if (text(payload.kind, 80) !== "campaign_fan_value") throw new Error("Unsupported campaign fan value chunk kind");
  const batchKey = text(payload.batchKey, 500);
  const command = collectionCommand(job, COLLECTOR_TYPES.CAMPAIGNS);
  const scanRunId = text(payload.scanRunId, 120);
  const scanStartedAt = command.requestedAt;
  const processObservedAt = new Date();
  if (
    !batchKey || !scanRunId || scanRunId !== command.generation ||
    payload.schemaVersion !== CAMPAIGN_SCHEMA_VERSION || !CAMPAIGN_COMPAT_COLLECTOR_VERSIONS.has(payload.collectorVersion)
  ) throw new Error("Invalid campaign fan value chunk contract");
  if (!batchKey.startsWith(`run:${scanRunId}:`)) throw new Error("Campaign fan value batch key does not match scan run");
  const item = normalizeCampaignFanValueItem(payload, processObservedAt);
  const idempotencyKey = `campaigns:${job.id}:${batchKey}`;
  if (idempotencyKey.length > 240) throw new Error("Campaign fan value idempotency key exceeds 240 characters");
  return inTransaction(db, async (tx) => {
    await enterCampaignWriterGeneration({ db: tx });
    await acquireAnalyticsLock(tx, "creator-campaigns", job.creatorId);
    const generation = await acceptCampaignGeneration({ db: tx, job, deviceId });
    if (!generation.accepted) return { replay: false, superseded: true, generation: generation.command.generation };
    await assertCampaignFanValueScope(tx, job, scanRunId, [item.onlyFansUserId]);
    const serverReceivedAt = await dbAuthorityNow({ db: tx, fallbackNow: processObservedAt });
    const { batch, replay } = await beginBatch(tx, {
      job,
      deviceId,
      idempotencyKey,
      dataType: "CAMPAIGNS",
      rangeFrom: scanStartedAt,
      rangeTo: serverReceivedAt,
      collectorVersion: payload.collectorVersion,
      schemaVersion: payload.schemaVersion,
      payload,
    });
    if (replay && ["COMMITTED", "PARTIAL"].includes(batch.status)) {
      return { replay: true, batchId: batch.id, status: batch.status };
    }
    const authorityObservedAt = await campaignFanValueAuthorityObservedAt({
      tx, job, deviceId, item, fallbackObservedAt: serverReceivedAt,
    });
    const applied = await upsertCampaignFanValueTx({ tx, job, deviceId, scanRunId, item, authorityObservedAt });
    await finishBatch(tx, batch.id, {
      received: 1,
      inserted: applied.available === true && applied.replay !== true ? 1 : 0,
      unchanged: applied.available !== true || applied.replay === true ? 1 : 0,
    });
    return { ...applied, replay: false, batchId: batch.id, superseded: false };
  });
}

async function ingestCampaignFanValuesBatchChunk({ db = prisma, job, deviceId, chunk }) {
  requireJob(job);
  const payload = object(chunk);
  if (text(payload.kind, 80) !== "campaign_fan_values_batch") throw new Error("Unsupported campaign fan values batch kind");
  const batchKey = text(payload.batchKey, 500);
  const command = collectionCommand(job, COLLECTOR_TYPES.CAMPAIGNS);
  const scanRunId = text(payload.scanRunId, 120);
  const scanStartedAt = command.requestedAt;
  const processObservedAt = new Date();
  const values = array(payload.values);
  if (
    !batchKey || !scanRunId || scanRunId !== command.generation || values.length < 1 || values.length > 20 ||
    payload.schemaVersion !== CAMPAIGN_SCHEMA_VERSION || !CAMPAIGN_COMPAT_COLLECTOR_VERSIONS.has(payload.collectorVersion)
  ) throw new Error("Invalid campaign fan values batch contract");
  if (!batchKey.startsWith(`run:${scanRunId}:`)) throw new Error("Campaign fan values batch key does not match scan run");
  const normalized = values.map((value) => normalizeCampaignFanValueItem(value, processObservedAt));
  const normalizedIds = normalized.map((item) => item.onlyFansUserId);
  if (new Set(normalizedIds).size !== normalizedIds.length) throw new Error("CAMPAIGN_FAN_VALUE_DUPLICATE_FAN");
  const idempotencyKey = `campaigns:${job.id}:${batchKey}`;
  if (idempotencyKey.length > 240) throw new Error("Campaign fan values idempotency key exceeds 240 characters");
  return inTransaction(db, async (tx) => {
    await enterCampaignWriterGeneration({ db: tx });
    await acquireAnalyticsLock(tx, "creator-campaigns", job.creatorId);
    const generation = await acceptCampaignGeneration({ db: tx, job, deviceId });
    if (!generation.accepted) return { replay: false, superseded: true, generation: generation.command.generation, received: values.length, available: 0, unavailable: 0, applied: [] };
    await assertCampaignFanValueScope(tx, job, scanRunId, normalizedIds);
    const serverReceivedAt = await dbAuthorityNow({ db: tx, fallbackNow: processObservedAt });
    const { batch, replay } = await beginBatch(tx, {
      job,
      deviceId,
      idempotencyKey,
      dataType: "CAMPAIGNS",
      rangeFrom: scanStartedAt,
      rangeTo: serverReceivedAt,
      collectorVersion: payload.collectorVersion,
      schemaVersion: payload.schemaVersion,
      payload,
    });
    if (replay && ["COMMITTED", "PARTIAL"].includes(batch.status)) {
      return { replay: true, batchId: batch.id, status: batch.status, received: normalized.length };
    }
    const availableItems = normalized.filter((item) => item.available === true);
    const activation = await campaignCausalV1State({ db: tx, lockForCommit: true });
    const observationTokenRequired = activation.active === true || campaignFanValueObservationTokenRequired(job);
    let authorityTimes = availableItems.map(() => serverReceivedAt);
    if (availableItems.length && observationTokenRequired) {
      for (const item of availableItems) {
        if (!item.observationToken) throw new Error("CAMPAIGN_FAN_VALUE_OBSERVATION_TOKEN_REQUIRED");
      }
      const consumed = await consumeFanObservationTokensBatch({
        db: tx,
        job,
        deviceId,
        leaseRevision: Number(job.leaseRevision),
        requests: availableItems.map((item) => ({
          token: item.observationToken,
          purpose: "campaign_fan_values",
          subjects: [item.onlyFansUserId],
        })),
      });
      authorityTimes = consumed.map((entry) => {
        const observedAt = strictDate(entry?.observedAt);
        if (!observedAt) throw new Error("CAMPAIGN_FAN_VALUE_OBSERVATION_TIME_INVALID");
        return observedAt;
      });
    }

    if (availableItems.length) {
      const observations = availableItems.map((item, index) => {
        const observedAt = authorityTimes[index];
        return {
          onlyFansUserId: item.onlyFansUserId,
          identity: {
            username: item.username,
            platformDisplayName: item.displayName,
            avatarUrl: item.avatarUrl,
            headerUrl: item.headerUrl,
            observedAt,
            source: "CAMPAIGN_CLAIMER",
          },
          value: {
            availability: "AVAILABLE",
            totalSpentCents: item.values.totalSpentCents,
            messagesSpentCents: item.values.messagesSpentCents,
            subscriptionsSpentCents: item.values.subscriptionsSpentCents,
            tipsSpentCents: item.values.tipsSpentCents,
            postsSpentCents: item.values.postsSpentCents,
            streamsSpentCents: item.values.streamsSpentCents,
            lastActivityAt: item.lastActivityAt,
            observedAt,
            source: "CAMPAIGN_CLAIMER",
          },
        };
      });
      await projectFanObservationBatch(tx, {
        agencyId: job.agencyId,
        creatorId: job.creatorId,
        sourceDeviceId: deviceId || null,
        sourceJobId: job.id,
        scanRunId,
        items: observations,
        allowedSources: ["CAMPAIGN_CLAIMER"],
        observedAtPolicy: "TRUSTED_INPUT",
        receivedAt: serverReceivedAt,
      });
    }

    const authorityTimeByFan = new Map(availableItems.map((item, index) => [item.onlyFansUserId, authorityTimes[index]]));
    const applied = normalized.map((item) => item.available === true
      ? { available: true, replay: false, fetchedAt: authorityTimeByFan.get(item.onlyFansUserId) || serverReceivedAt }
      : { available: false, reasonCode: item.reasonCode });
    const available = availableItems.length;
    const unavailable = normalized.length - available;
    await finishBatch(tx, batch.id, {
      received: normalized.length,
      inserted: available,
      unchanged: unavailable,
    });
    return { replay: false, batchId: batch.id, received: normalized.length, available, unavailable, applied, superseded: false };
  });
}


function campaignFrontierBudget(job) {
  const requested = Number(object(job?.params).campaignFrontierBudget);
  if (!Number.isInteger(requested) || requested < 1) return CAMPAIGN_FRONTIER_BUDGET_DEFAULT;
  return Math.min(CAMPAIGN_FRONTIER_BUDGET_MAX, requested);
}

function campaignDirectoryReuseBinding(job) {
  const params = object(job?.params);
  if (Number(params.campaignDirectoryReuseVersion || 0) < CAMPAIGN_DIRECTORY_REUSE_VERSION) return null;
  const generation = text(params.campaignDirectoryReuseGeneration, 120);
  if (!generation) return null;
  const requestedAt = strictDate(params.campaignDirectoryReuseRequestedAt);
  const revision = integer(params.campaignDirectoryReuseRevision, 2_147_483_647);
  const campaignCount = integer(params.campaignDirectoryReuseCampaignCount, 100_000_000);
  if (!requestedAt || revision === null || revision < 1 || campaignCount === null) {
    const error = new Error("Campaign directory reuse binding is invalid");
    error.code = "CAMPAIGN_DIRECTORY_REUSE_INVALID";
    throw error;
  }
  return { generation, requestedAt, revision, campaignCount };
}

function sameTime(left, right) {
  const a = left instanceof Date ? left : left ? new Date(left) : null;
  const b = right instanceof Date ? right : right ? new Date(right) : null;
  return Boolean(a && b && Number.isFinite(a.getTime()) && Number.isFinite(b.getTime()) && a.getTime() === b.getTime());
}

function campaignDirectoryReuseStateMatches(state, reuse, command) {
  return Boolean(
    reuse &&
    command?.mode === "catchup" &&
    state?.campaignDirectoryGeneration === reuse.generation &&
    sameTime(state?.campaignDirectoryRequestedAt, reuse.requestedAt) &&
    Number(state?.campaignDirectoryRevision || 0) === reuse.revision &&
    Number(state?.campaignDirectoryCampaignCount || 0) === reuse.campaignCount &&
    Math.max(0, Number(state?.campaignDirectoryDiscoveryRequestedRevision || 0)) <= Math.max(0, Number(state?.campaignDirectoryDiscoveryCompletedRevision || 0)) &&
    state?.campaignDirectoryVerifiedAt
  );
}

async function campaignDirectoryAuthority(tx, { job, command, scanRunId, durable, now }) {
  const reuse = campaignDirectoryReuseBinding(job);
  const state = await tx.creatorCampaignCollectionState.findUnique({ where: { creatorId: job.creatorId } });
  if (reuse) {
    if (!campaignDirectoryReuseStateMatches(state, reuse, command)) {
      const error = new Error("Campaign directory reuse generation is stale");
      error.code = "CAMPAIGN_DIRECTORY_REUSE_STALE";
      throw error;
    }
    const persistedCount = await tx.creatorCampaign.count({
      where: { creatorId: job.creatorId, sourceScanRunId: reuse.generation, sourceScanStartedAt: reuse.requestedAt },
    });
    if (persistedCount !== reuse.campaignCount) {
      const error = new Error("Campaign directory reuse snapshot no longer matches its durable count");
      error.code = "CAMPAIGN_DIRECTORY_REUSE_COUNT_MISMATCH";
      throw error;
    }
    return { ...reuse, reused: true };
  }

  const expectedBatches = integer(durable?.campaignBatchCount, 1_000_000);
  const proof = campaignCompletionProofFromState(state, scanRunId, CAMPAIGN_COLLECTOR_VERSION);
  if (expectedBatches === null || proof.matches !== true || proof.rejectedBatches !== 0 || proof.rejectedRows !== 0 || proof.campaignBatches !== expectedBatches) {
    const error = new Error("Campaign directory generation is not fully durable");
    error.code = "CAMPAIGN_DIRECTORY_PROOF_INCOMPLETE";
    throw error;
  }
  const campaignCount = await tx.creatorCampaign.count({
    where: { creatorId: job.creatorId, sourceScanRunId: scanRunId, sourceScanStartedAt: command.requestedAt },
  });
  if (state?.campaignDirectoryGeneration === scanRunId && sameTime(state?.campaignDirectoryRequestedAt, command.requestedAt)) {
    if (Number(state?.campaignDirectoryCampaignCount || 0) !== campaignCount || Number(state?.campaignDirectoryRevision || 0) < 1) {
      const error = new Error("Campaign directory durable authority changed inside one generation");
      error.code = "CAMPAIGN_DIRECTORY_AUTHORITY_CONFLICT";
      throw error;
    }
    const requestedDiscoveryRevision = Math.max(0, Number(state?.campaignDirectoryDiscoveryRequestedRevision || 0));
    if (Math.max(0, Number(state?.campaignDirectoryDiscoveryCompletedRevision || 0)) < requestedDiscoveryRevision || !state?.campaignDirectoryDiscoveryDueAt) {
      await tx.creatorCampaignCollectionState.update({
        where: { creatorId: job.creatorId },
        data: {
          campaignDirectoryDiscoveryCompletedRevision: requestedDiscoveryRevision,
          campaignDirectoryDiscoveryDueAt: new Date(now.getTime() + CAMPAIGN_DIRECTORY_DISCOVERY_SLA_MS),
        },
      });
    }
    return { generation: scanRunId, requestedAt: command.requestedAt, revision: Number(state.campaignDirectoryRevision), campaignCount, reused: false };
  }
  const revision = Math.max(0, Number(state?.campaignDirectoryRevision || 0)) + 1;
  const requestedDiscoveryRevision = Math.max(0, Number(state?.campaignDirectoryDiscoveryRequestedRevision || 0));
  const updated = await tx.creatorCampaignCollectionState.update({
    where: { creatorId: job.creatorId },
    data: {
      campaignDirectoryGeneration: scanRunId,
      campaignDirectoryRequestedAt: command.requestedAt,
      campaignDirectoryVerifiedAt: now,
      campaignDirectoryRevision: revision,
      campaignDirectoryCampaignCount: campaignCount,
      campaignDirectoryDiscoveryCompletedRevision: requestedDiscoveryRevision,
      campaignDirectoryDiscoveryDueAt: new Date(now.getTime() + CAMPAIGN_DIRECTORY_DISCOVERY_SLA_MS),
    },
  });
  return { generation: scanRunId, requestedAt: command.requestedAt, revision: Number(updated?.campaignDirectoryRevision || revision), campaignCount, reused: false };
}

async function ensureCampaignFrontierPlan(tx, { job, command, scanRunId, now, directoryAuthority }) {
  // Production Prisma always exposes this delegate after the A8 migration.
  // Tiny pre-A8 unit-test adapters may omit it; keep their legacy all-scan
  // behavior without weakening the production capability-gated authority.
  if (typeof tx.creatorCampaignCollectionState?.findUnique !== "function" || typeof tx.creatorCampaignCollectionState?.update !== "function") {
    return null;
  }
  const current = await tx.creatorCampaignCollectionState.findUnique({ where: { creatorId: job.creatorId } });
  if (current?.campaignFrontierPlanRunId === scanRunId) return current;

  const exactGeneration = {
    creatorId: job.creatorId,
    sourceScanRunId: directoryAuthority.generation,
    sourceScanStartedAt: directoryAuthority.requestedAt,
  };
  const allCount = await tx.creatorCampaign.count({ where: exactGeneration });
  if (allCount !== directoryAuthority.campaignCount) throw new Error("CAMPAIGN_DIRECTORY_AUTHORITY_COUNT_CHANGED");
  const schedulingCurrent = Number(object(job.params).campaignFrontierSchedulingVersion || 0) >= CAMPAIGN_FRONTIER_SCHEDULING_VERSION;
  let dueCount = allCount;
  let targetCount = allCount;
  let targetIds = [];

  if (command.mode === "full" || !schedulingCurrent) {
    // Full/rolling-compat traversal already scans every row. Do not materialize
    // the entire directory merely to attach target markers.
    targetCount = allCount;
  } else {
    // Prisma cannot compare two columns in a portable where-clause. Revision
    // mismatch is therefore selected with the due timestamp authority: every
    // metadata revision bump sets claimersNextDueAt=server DB time atomically.
    const dueWhere = {
      ...exactGeneration,
      OR: [{ claimersNextDueAt: null }, { claimersNextDueAt: { lte: now } }],
    };
    dueCount = await tx.creatorCampaign.count({ where: dueWhere });
    const targets = await tx.creatorCampaign.findMany({
      where: dueWhere,
      orderBy: [{ claimersNextDueAt: "asc" }, { externalCampaignId: "asc" }],
      take: campaignFrontierBudget(job),
      select: { id: true },
    });
    targetIds = targets.map((row) => row.id);
    targetCount = targetIds.length;
  }

  if (targetIds.length) {
    await tx.creatorCampaign.updateMany({
      where: { id: { in: targetIds }, creatorId: job.creatorId },
      data: { claimersTargetRunId: scanRunId },
    });
  }
  const deferred = Math.max(0, dueCount - targetCount);
  const oldestDue = dueCount > 0
    ? await tx.creatorCampaign.findFirst({
      where: {
        ...exactGeneration,
        OR: [{ claimersNextDueAt: null }, { claimersNextDueAt: { lte: now } }],
      },
      orderBy: [{ claimersNextDueAt: "asc" }, { externalCampaignId: "asc" }],
      select: { claimersNextDueAt: true },
    })
    : null;
  const nextDue = await tx.creatorCampaign.findFirst({
    where: exactGeneration,
    orderBy: [{ claimersNextDueAt: "asc" }, { externalCampaignId: "asc" }],
    select: { claimersNextDueAt: true },
  });
  const fanCutoff = new Date(command.requestedAt.getTime() - CAMPAIGN_FAN_VALUE_FRESHNESS_MS);
  return tx.creatorCampaignCollectionState.update({
    where: { creatorId: job.creatorId },
    data: {
      campaignFrontierPlanRunId: scanRunId,
      campaignFrontierFreshnessStatus: targetCount ? "QUEUED" : (deferred > 0 ? "PARTIAL" : "COMPLETE"),
      campaignFrontierDueCount: dueCount,
      campaignFrontierTargetCount: targetCount,
      campaignFrontierCompletedCount: 0,
      campaignFrontierDeferredCount: deferred,
      campaignFrontierOldestDueAt: oldestDue?.claimersNextDueAt || (dueCount > 0 ? command.requestedAt : null),
      campaignFrontierNextDueAt: nextDue?.claimersNextDueAt || null,
      campaignFrontierUpdatedAt: now,
      // A zero-target generation has no Campaign-derived FanData work. Initialize
      // an exact empty run so completion does not invent outstanding refreshes.
      ...(targetCount === 0 ? {
        fanValueCoverageScanRunId: scanRunId,
        fanValueFreshnessCutoffAt: fanCutoff,
        fanValueFreshnessStatus: "COMPLETE",
        fanValueExpected: 0,
        fanValueAlreadyFresh: 0,
        fanValueQueued: 0,
        fanValueSucceeded: 0,
        fanValueUnavailable: 0,
        fanValueFailed: 0,
        fanValueOutstanding: 0,
        fanValueCoverageUpdatedAt: now,
      } : {}),
    },
  });
}

async function loadCampaignDirectorySegment({ db = prisma, job, chunk }) {
  requireJob(job);
  const payload = object(chunk);
  if (text(payload.kind, 80) !== "campaign_directory_segment") throw new Error("Unsupported campaign directory segment request");
  const command = collectionCommand(job, COLLECTOR_TYPES.CAMPAIGNS);
  const scanRunId = text(payload.scanRunId, 120);
  if (
    payload.schemaVersion !== CAMPAIGN_SCHEMA_VERSION ||
    payload.collectorVersion !== CAMPAIGN_COLLECTOR_VERSION ||
    !scanRunId || scanRunId !== command.generation
  ) throw new Error("Invalid campaign directory segment contract");

  const driver = object(job.continuation);
  const durable = driver.driverPhase === "execute" ? object(driver.jobContinuation) : {};
  if (
    durable.collectorVersion !== CAMPAIGN_COLLECTOR_VERSION ||
    durable.scanRunId !== scanRunId ||
    durable.directorySourceExhausted !== true ||
    durable.campaignPagesComplete !== true ||
    durable.truncated === true
  ) throw new Error("Campaign directory segment requested before durable directory completion");

  const requestedCursor = text(payload.cursor, 220) || null;
  const durableCursor = text(durable.segmentCursor, 220) || null;
  const durableRequestCursor = text(durable.segmentRequestCursor, 220) || null;
  const phase = text(durable.phase, 40);
  const freshAdvance = phase === "segment" && requestedCursor === durableCursor;
  const lostResponseReplay = phase === "claimers" && requestedCursor === durableRequestCursor;
  if (!freshAdvance && !lostResponseReplay) throw new Error("Campaign directory segment cursor does not match durable traversal");

  const authorityNow = await dbAuthorityNow({ db, fallbackNow: new Date() });
  let directory = null;
  if (typeof db.creatorCampaignCollectionState?.findUnique === "function" && typeof db.creatorCampaignCollectionState?.update === "function" && typeof db.creatorCampaignCollectionState?.upsert === "function") {
    const reuse = campaignDirectoryReuseBinding(job);
    // A stale backlog job must fail before it can become the active collection
    // generation or reset run-level coverage. Validate the exact directory
    // generation/revision first, then accept the new tranche generation.
    if (reuse) directory = await campaignDirectoryAuthority(db, { job, command, scanRunId, durable, now: authorityNow });
    const generation = await acceptCampaignGeneration({ db, job });
    if (!generation.accepted) throw new Error("Campaign directory segment belongs to a stale collection generation");
    if (!directory) directory = await campaignDirectoryAuthority(db, { job, command, scanRunId, durable, now: authorityNow });
  } else {
    // Tiny legacy unit-test adapters may not model collection state. Production
    // Prisma always takes the authority path above; keep source-only tests from
    // pretending to validate directory-reuse fencing they cannot represent.
    const count = await db.creatorCampaign.count({
      where: { creatorId: job.creatorId, sourceScanRunId: scanRunId, sourceScanStartedAt: command.requestedAt },
    });
    directory = { generation: scanRunId, requestedAt: command.requestedAt, revision: 0, campaignCount: count, reused: false };
  }
  const frontierPlan = await ensureCampaignFrontierPlan(db, { job, command, scanRunId, now: authorityNow, directoryAuthority: directory });

  const where = {
    creatorId: job.creatorId,
    sourceScanRunId: directory.generation,
    sourceScanStartedAt: directory.requestedAt,
    ...(requestedCursor ? { externalCampaignId: { gt: requestedCursor } } : {}),
  };
  const rows = await db.creatorCampaign.findMany({
    where,
    orderBy: { externalCampaignId: "asc" },
    take: 51,
    select: { externalCampaignId: true, claimersTargetRunId: true },
  });
  const page = rows.slice(0, 50);
  const nextCursor = page.length ? text(page[page.length - 1]?.externalCampaignId, 220) : requestedCursor;
  const totalCampaignCount = requestedCursor === null ? directory.campaignCount : null;
  return {
    campaignDirectorySegment: {
      requestCursor: requestedCursor,
      cursor: nextCursor,
      hasMore: rows.length > 50,
      campaigns: page.map((row) => ({
        id: text(row.externalCampaignId, 220),
        scanClaimers: command.mode === "full" || Number(object(job.params).campaignFrontierSchedulingVersion || 0) < CAMPAIGN_FRONTIER_SCHEDULING_VERSION || row.claimersTargetRunId === scanRunId,
      })).filter((row) => Boolean(row.id)),
      frontierPlan: {
        status: text(frontierPlan?.campaignFrontierFreshnessStatus, 40) || "MISSING",
        due: Math.max(0, Number(frontierPlan?.campaignFrontierDueCount || 0)),
        target: Math.max(0, Number(frontierPlan?.campaignFrontierTargetCount || 0)),
        completed: Math.max(0, Number(frontierPlan?.campaignFrontierCompletedCount || 0)),
        deferred: Math.max(0, Number(frontierPlan?.campaignFrontierDeferredCount || 0)),
      },
      ...(totalCampaignCount !== null ? { totalCampaignCount } : {}),
    },
  };
}

async function completeCampaignScan({ db = prisma, job, deviceId, result }) {
  requireJob(job);
  const payload = object(result);
  const command = collectionCommand(job, COLLECTOR_TYPES.CAMPAIGNS);
  const scanRunId = text(payload.scanRunId, 120);
  const scanStartedAt = command.requestedAt;
  const directoryReuse = campaignDirectoryReuseBinding(job);
  const processObservedAt = new Date();
  if (
    payload.schemaVersion !== CAMPAIGN_SCHEMA_VERSION || !CAMPAIGN_COMPAT_COLLECTOR_VERSIONS.has(payload.collectorVersion) ||
    !scanRunId || scanRunId !== command.generation
  ) {
    throw new Error("Invalid campaign completion contract");
  }
  const protocolCurrent = payload.collectorVersion === CAMPAIGN_COLLECTOR_VERSION;
  const expectedCampaignBatches = integer(payload.campaignBatchCount, 1_000_000);
  const expectedClaimerBatches = integer(payload.claimerBatchCount);
  const expectedCampaignCount = integer(payload.campaignCount, 100_000_000);
  if (expectedCampaignBatches === null || expectedClaimerBatches === null || expectedCampaignCount === null) {
    throw new Error("Campaign completion counters are invalid");
  }
  const key = `campaigns:${job.id}:run:${scanRunId}:completion:${payload.collectorVersion}`;
  if (key.length > 240) throw new Error("Campaign completion idempotency key exceeds 240 characters");
  return inTransaction(db, async (tx) => {
    await enterCampaignWriterGeneration({ db: tx });
    await acquireAnalyticsLock(tx, "creator-campaigns", job.creatorId);
    const generation = await acceptCampaignGeneration({ db: tx, job, deviceId });
    if (!generation.accepted) return { complete: true, replay: false, superseded: true, proof: { newerGeneration: generation.state?.activeGeneration || null } };
    const serverReceivedAt = await dbAuthorityNow({ db: tx, fallbackNow: processObservedAt });
    const { batch, replay } = await beginBatch(tx, {
      job,
      deviceId,
      idempotencyKey: key,
      dataType: "CAMPAIGNS",
      rangeFrom: scanStartedAt,
      rangeTo: serverReceivedAt,
      collectorVersion: payload.collectorVersion,
      schemaVersion: payload.schemaVersion,
      payload,
    });

    // Completion proof is incrementally maintained in CreatorCampaignCollectionState
    // when each campaign/claimer page batch becomes terminal. Do not fetch the
    // entire AnalyticsIngestBatch history for a long-running Campaign collection.
    const incrementalProof = campaignCompletionProofFromState(generation.state, scanRunId, payload.collectorVersion);
    const allCommitted = incrementalProof.matches === true && incrementalProof.rejectedBatches === 0;
    let directoryGeneration = scanRunId;
    let directoryRequestedAt = scanStartedAt;
    let directoryReuseValid = false;
    if (directoryReuse) {
      const directoryState = await tx.creatorCampaignCollectionState.findUnique({ where: { creatorId: job.creatorId } });
      directoryReuseValid =
        directoryState?.campaignDirectoryGeneration === directoryReuse.generation &&
        sameTime(directoryState?.campaignDirectoryRequestedAt, directoryReuse.requestedAt) &&
        Number(directoryState?.campaignDirectoryRevision || 0) === directoryReuse.revision &&
        Number(directoryState?.campaignDirectoryCampaignCount || 0) === directoryReuse.campaignCount &&
        Math.max(0, Number(directoryState?.campaignDirectoryDiscoveryRequestedRevision || 0)) <= Math.max(0, Number(directoryState?.campaignDirectoryDiscoveryCompletedRevision || 0));
      directoryGeneration = directoryReuse.generation;
      directoryRequestedAt = directoryReuse.requestedAt;
    }
    const observedCampaignCount = await tx.creatorCampaign.count({
      where: { creatorId: job.creatorId, sourceScanRunId: directoryGeneration, sourceScanStartedAt: directoryRequestedAt },
    });
    const directoryProofComplete = directoryReuse
      ? directoryReuseValid && expectedCampaignBatches === 0 && observedCampaignCount === directoryReuse.campaignCount
      : incrementalProof.campaignBatches === expectedCampaignBatches;
    const membershipComplete =
      protocolCurrent &&
      payload.campaignPagesComplete === true &&
      payload.claimersComplete === true &&
      payload.truncated !== true &&
      allCommitted &&
      directoryProofComplete &&
      incrementalProof.claimerBatches === expectedClaimerBatches &&
      observedCampaignCount === expectedCampaignCount;
    const fanValueCoverage = CAMPAIGN_FRESHNESS_COVERAGE_COLLECTOR_VERSIONS.has(payload.collectorVersion)
      ? campaignFanValueCoverageFromState(generation.state, scanRunId)
      : null;
    // A genuinely empty current Campaign generation has no claimer page that
    // could initialize the delegated freshness ledger. Do not strand an empty
    // creator in PARTIAL forever: membership proof + zero server-observed
    // Campaigns is itself exact proof that expected FanData freshness work is 0.
    const emptyCurrentFreshnessComplete = protocolCurrent && membershipComplete && observedCampaignCount === 0;
    let frontierState = await tx.creatorCampaignCollectionState.findUnique({ where: { creatorId: job.creatorId } });
    const frontierSchedulingCurrent = Number(object(job.params).campaignFrontierSchedulingVersion || 0) >= CAMPAIGN_FRONTIER_SCHEDULING_VERSION;
    let frontierPlanMatches = frontierState?.campaignFrontierPlanRunId === scanRunId;
    if (frontierSchedulingCurrent && frontierPlanMatches) {
      const nextDueRow = await tx.creatorCampaign.findFirst({
        where: { creatorId: job.creatorId, sourceScanRunId: directoryGeneration, sourceScanStartedAt: directoryRequestedAt },
        orderBy: [{ claimersNextDueAt: "asc" }, { externalCampaignId: "asc" }],
        select: { claimersNextDueAt: true },
      });
      frontierState = await tx.creatorCampaignCollectionState.update({
        where: { creatorId: job.creatorId },
        data: {
          campaignFrontierNextDueAt: nextDueRow?.claimersNextDueAt || null,
          ...(Math.max(0, Number(frontierState?.campaignFrontierDeferredCount || 0)) === 0 ? { campaignFrontierOldestDueAt: null } : {}),
          campaignFrontierUpdatedAt: serverReceivedAt,
        },
      });
      frontierPlanMatches = frontierState?.campaignFrontierPlanRunId === scanRunId;
    }
    const frontierTarget = frontierPlanMatches ? Math.max(0, Number(frontierState?.campaignFrontierTargetCount || 0)) : 0;
    const frontierCompleted = frontierPlanMatches ? Math.max(0, Number(frontierState?.campaignFrontierCompletedCount || 0)) : 0;
    const frontierDeferred = frontierPlanMatches ? Math.max(0, Number(frontierState?.campaignFrontierDeferredCount || 0)) : 0;
    const frontierFreshnessComplete = protocolCurrent && (
      frontierSchedulingCurrent !== true || (frontierPlanMatches && frontierCompleted >= frontierTarget && frontierDeferred === 0)
    );
    const fanValuesComplete = fanValueCoverage?.matches
      ? fanValueCoverage.outstanding === 0 && fanValueCoverage.failed === 0
      : emptyCurrentFreshnessComplete
        ? true
        : CAMPAIGN_SERVER_REFRESH_COLLECTOR_VERSIONS.has(payload.collectorVersion)
          ? false
          : payload.fanValuesComplete === true;
    const proof = {
      expectedCampaignBatches,
      observedCampaignBatches: incrementalProof.campaignBatches,
      expectedClaimerBatches,
      observedClaimerBatches: incrementalProof.claimerBatches,
      expectedCampaignCount,
      observedCampaignCount,
      allCommitted,
      rejectedBatches: incrementalProof.rejectedBatches,
      rejectedRows: incrementalProof.rejectedRows,
      proofRunMatches: incrementalProof.matches,
      membershipComplete,
      frontierFreshnessComplete,
      campaignFrontierFreshnessStatus: frontierPlanMatches ? String(frontierState?.campaignFrontierFreshnessStatus || "MISSING") : "MISSING",
      campaignFrontierDue: frontierPlanMatches ? Math.max(0, Number(frontierState?.campaignFrontierDueCount || 0)) : 0,
      campaignFrontierTarget: frontierTarget,
      campaignFrontierCompleted: frontierCompleted,
      campaignFrontierDeferred: frontierDeferred,
      fanValuesComplete,
      fanValueFreshnessStatus: fanValueCoverage?.matches ? fanValueCoverage.status : emptyCurrentFreshnessComplete ? "COMPLETE" : null,
      fanValuesExpected: fanValueCoverage?.expected ?? integer(payload.fanValuesTotal, 100_000_000),
      fanValuesAlreadyFresh: fanValueCoverage?.alreadyFresh ?? 0,
      fanValuesQueued: fanValueCoverage?.queued ?? integer(payload.fanValuesRequested, 100_000_000),
      fanValuesSucceeded: fanValueCoverage?.succeeded ?? integer(payload.fanValuesFetched, 100_000_000),
      fanValuesUnavailable: fanValueCoverage?.unavailable ?? integer(payload.fanValuesUnavailable, 100_000_000),
      fanValuesFailed: fanValueCoverage?.failed ?? 0,
      fanValuesOutstanding: fanValueCoverage?.outstanding ?? 0,
    };
    // Provider traversal and delegated FanData freshness are independent authorities.
    // A Campaign job must not be retried (and re-read OF) merely because the
    // asynchronous FanData refresh queue is still draining. The collection state
    // remains PARTIAL/QUEUED until that queue reconciles, but the provider job has
    // successfully completed once membership traversal is proven.
    const providerTraversalComplete = membershipComplete;
    const currentMembershipComplete = membershipComplete && frontierFreshnessComplete;
    const complete = currentMembershipComplete && fanValuesComplete;
    const desiredBatchStatus = complete ? "COMMITTED" : providerTraversalComplete ? "COMMITTED" : "PARTIAL";
    if (!replay || batch.status !== desiredBatchStatus) {
      await finishBatch(
        tx,
        batch.id,
        { received: expectedCampaignCount, unchanged: expectedCampaignCount },
        desiredBatchStatus,
        complete ? null : "CAMPAIGN_SCAN_PROOF_INCOMPLETE",
        complete ? null : proofMessage(proof),
      );
    }
    if (membershipComplete && !directoryReuse) {
      await tx.creatorCampaign.updateMany({
        where: {
          creatorId: job.creatorId,
          OR: [{ sourceScanStartedAt: null }, { sourceScanStartedAt: { lt: scanStartedAt } }],
        },
        data: { isActive: false },
      });
    }
    const collectionState = await completeCampaignCollection({
      db: tx, job, deviceId, complete, membershipComplete: currentMembershipComplete, scanRunId,
    });
    return { batchId: batch.id, complete, providerTraversalComplete, replay, superseded: false, protocolCurrent, proof, collectionStateId: collectionState?.state?.id || null };
  });
}
function normalizeMessageDay(raw) {
  const row = object(raw);
  const date = dateOnly(String(row.date || ""));
  const sourceTimezone = timezone(row.sourceTimezone || "UTC");
  const incomingMessages = integer(row.incomingMessages);
  const outgoingMessages = integer(row.outgoingMessages);
  const totalMessages = integer(row.totalMessages);
  const uniqueDialogs = integer(row.uniqueDialogs);
  const uniqueIncomingFans = integer(row.uniqueIncomingFans);
  const uniqueOutgoingFans = integer(row.uniqueOutgoingFans);
  if (!date || sourceTimezone !== "UTC" || [incomingMessages, outgoingMessages, totalMessages, uniqueDialogs, uniqueIncomingFans, uniqueOutgoingFans].some((value) => value === null)) return null;
  if (incomingMessages + outgoingMessages !== totalMessages) return null;
  if (uniqueIncomingFans > uniqueDialogs || uniqueOutgoingFans > uniqueDialogs) return null;
  return { date, sourceTimezone, incomingMessages, outgoingMessages, totalMessages, uniqueDialogs, uniqueIncomingFans, uniqueOutgoingFans };
}

async function upsertMessagesDaily({ db = prisma, agencyId, creatorId, rows, syncId, observedAt, sourceDeviceId = null, localCoverage }) {
  const rawRows = array(rows);
  if (rawRows.length > 50) throw new Error("Messages daily payload exceeds 50 rows");
  const cleanSyncId = text(syncId, 180);
  const observed = strictDate(observedAt);
  const coverageInput = object(localCoverage);
  const knownDialogs = integer(coverageInput.knownDialogs, 10_000_000);
  const incompleteDialogs = integer(coverageInput.incompleteDialogs, 10_000_000);
  const localCoverageComplete = coverageInput.complete === true;
  const messagesIndexed = integer(coverageInput.messagesIndexed, 2_147_483_647);
  const oldestMessageAt = coverageInput.oldestMessageAt === null || coverageInput.oldestMessageAt === undefined ? null : strictDate(coverageInput.oldestMessageAt);
  const newestMessageAt = coverageInput.newestMessageAt === null || coverageInput.newestMessageAt === undefined ? null : strictDate(coverageInput.newestMessageAt);
  if (knownDialogs === null || incompleteDialogs === null || incompleteDialogs > knownDialogs || messagesIndexed === null) throw new Error("Messages daily local coverage counters are invalid");
  if ((coverageInput.oldestMessageAt !== null && coverageInput.oldestMessageAt !== undefined && !oldestMessageAt)
    || (coverageInput.newestMessageAt !== null && coverageInput.newestMessageAt !== undefined && !newestMessageAt)
    || (oldestMessageAt && newestMessageAt && oldestMessageAt > newestMessageAt)) {
    throw new Error("Messages daily local coverage timestamps are invalid");
  }
  if (localCoverageComplete !== (knownDialogs > 0 && incompleteDialogs === 0)) throw new Error("Messages daily local coverage proof is inconsistent");
  if (!cleanSyncId) throw new Error("Messages daily syncId is required");
  if (!observed) throw new Error("Messages daily observedAt must be an ISO date-time with timezone");
  const normalizedRows = rawRows.map(normalizeMessageDay);
  const rejected = normalizedRows.filter((row) => row === null).length;
  const normalized = normalizedRows.filter(Boolean).sort((a, b) => compareDate(a.date, b.date));
  const keys = new Set();
  for (const row of normalized) {
    const key = `${row.date.toISOString().slice(0, 10)}:${row.sourceTimezone}`;
    if (keys.has(key)) throw new Error("Messages daily payload contains duplicate days");
    keys.add(key);
    if (row.date > utcDay(observed)) throw new Error("Messages daily payload contains a future day");
  }
  const rangeFrom = normalized[0]?.date || utcDay(observed);
  const rangeTo = normalized.length ? new Date(normalized.at(-1).date.getTime() + 86_400_000 - 1) : observed;
  const payload = {
    rows: rawRows, syncId: cleanSyncId, observedAt: observed.toISOString(),
    localCoverage: {
      complete: localCoverageComplete, knownDialogs, incompleteDialogs, messagesIndexed,
      oldestMessageAt: oldestMessageAt?.toISOString() || null, newestMessageAt: newestMessageAt?.toISOString() || null,
    },
  };
  const idempotencyKey = `messages-daily:${creatorId}:${cleanSyncId}`;
  const result = await inTransaction(db, async (tx) => {
    await acquireAnalyticsLock(tx, "creator-messages-daily", creatorId);
    const { batch, replay } = await beginBatch(tx, {
      agencyId,
      creatorId,
      deviceId: sourceDeviceId,
      idempotencyKey,
      dataType: "MESSAGES_DAILY",
      rangeFrom,
      rangeTo,
      collectorVersion: MESSAGES_COLLECTOR_VERSION,
      schemaVersion: MESSAGES_SCHEMA_VERSION,
      payload,
    });
    if (replay && ["COMMITTED", "PARTIAL"].includes(batch.status)) {
      return {
        received: batch.receivedRows,
        accepted: batch.insertedRows + batch.updatedRows + batch.unchangedRows,
        rejected: batch.rejectedRows,
        inserted: batch.insertedRows,
        updated: batch.updatedRows,
        replay: true,
      };
    }
    let inserted = 0;
    let updated = 0;
    let unchanged = 0;
    const currentDay = utcDay(observed);
    for (const row of normalized) {
      const where = { creatorId_date_sourceTimezone: { creatorId, date: row.date, sourceTimezone: row.sourceTimezone } };
      const existing = await tx.creatorMessagesDaily.findUnique({ where, select: { id: true, collectedAt: true } });
      const existingCoverage = await tx.analyticsCoverage.findUnique({
        where: { creatorId_dataType_coverageDate_sourceTimezone: { creatorId, dataType: "MESSAGES_DAILY", coverageDate: row.date, sourceTimezone: row.sourceTimezone } },
        select: { status: true },
      });
      const isCurrentDay = row.date.getTime() === currentDay.getTime();
      const coverageComplete = localCoverageComplete && !isCurrentDay;
      const existingComplete = existingCoverage?.status === "COMPLETE";
      const existingCollectedAt = existing?.collectedAt instanceof Date
        ? existing.collectedAt
        : existing?.collectedAt ? new Date(existing.collectedAt) : null;
      const incomingIsStronger = coverageComplete && !existingComplete;
      const sameProofQuality = coverageComplete === existingComplete;
      const incomingIsAtLeastAsFresh = !existingCollectedAt || !Number.isFinite(existingCollectedAt.getTime()) || observed >= existingCollectedAt;
      const shouldWrite = !existing || incomingIsStronger || (sameProofQuality && incomingIsAtLeastAsFresh);
      if (!shouldWrite) {
        unchanged += 1;
        continue;
      }
      const data = { agencyId, creatorId, ...row, collectedAt: observed, sourceDeviceId };
      await tx.creatorMessagesDaily.upsert({ where, create: data, update: data });
      if (existing) updated += 1;
      else inserted += 1;
      const errorCode = !localCoverageComplete ? "LOCAL_MESSAGE_HISTORY_INCOMPLETE" : isCurrentDay ? "MESSAGES_DAY_IN_PROGRESS" : null;
      await setCoverage(tx, {
        agencyId,
        creatorId,
        batchId: batch.id,
        dataType: "MESSAGES_DAILY",
        date: row.date,
        sourceTimezone: row.sourceTimezone,
        status: coverageComplete ? "COMPLETE" : "PARTIAL",
        coveredFromAt: coverageComplete ? null : row.date,
        coveredToAt: coverageComplete ? null : (isCurrentDay ? observed : utcDayEnd(row.date)),
        errorCode,
        errorMessage: !localCoverageComplete ? `${incompleteDialogs} of ${knownDialogs} known dialogs are not fully scanned` : null,
        verifiedAt: observed,
      });
    }
    if (sourceDeviceId && tx.creatorLocalMessageCoverage) {
      await upsertLocalMessageCoverage({
        db: tx, agencyId, creatorId, deviceId: sourceDeviceId, complete: localCoverageComplete,
        knownDialogs, incompleteDialogs, oldestMessageAt, newestMessageAt, messagesIndexed, verifiedAt: observed,
      });
    }
    const status = rejected === 0 ? "COMMITTED" : "PARTIAL";
    await finishBatch(tx, batch.id, { received: rawRows.length, inserted, updated, unchanged, rejected }, status, rejected ? "MESSAGES_DAILY_REJECTED_ROWS" : null);
    return { received: rawRows.length, accepted: normalized.length, rejected, inserted, updated, unchanged, replay: false, localCoverageComplete, knownDialogs, incompleteDialogs, messagesIndexed, oldestMessageAt, newestMessageAt };
  });
  // CreatorDailyMetrics is a disposable read cache. Rebuild only after the
  // durable message-day transaction commits, so a cache SQL failure can never
  // roll back primary message aggregates or local coverage metadata.
  if (!result.replay && normalized.length && db.creatorDailyMetrics) {
    try {
      await rebuildCreatorDailyMetrics({
        db, agencyId, creatorId, from: normalized[0].date, to: normalized.at(-1).date, now: observed, includeMessages: true,
      });
    } catch (projectionError) {
      console.warn("[creator-analytics] daily metrics projection failed after messages ingest:", projectionError?.message || projectionError);
    }
  }
  return result;
}

async function readCampaignRevenue({ db, creatorId, start = null, end = null }) {
  const queryRaw = typeof db.$queryRawUnsafe === "function"
    ? db.$queryRawUnsafe.bind(db)
    : typeof db.$queryRaw === "function" ? db.$queryRaw.bind(db) : null;
  if (!queryRaw) return new Map();
  const rows = await queryRaw(`
    WITH attributed AS (
      SELECT
        event."fanId",
        event."amountCents",
        event."netCents",
        event."transactionStatus",
        event."transactionType",
        event."occurredAt" AS occurred_at,
        membership."campaignId"
      FROM "CreatorFinancialTransaction" AS event
      JOIN LATERAL (
        SELECT link."campaignId"
        FROM "CreatorCampaignFan" AS link
        WHERE link."creatorId" = $1
          AND link."fanId" = event."fanId"
          AND link."attributedAt" IS NOT NULL
          AND link."attributedAt" <= event."occurredAt"
        ORDER BY link."attributedAt" DESC, link."id" DESC
        LIMIT 1
      ) AS membership ON TRUE
      WHERE event."creatorId" = $1
        AND event."fanId" IS NOT NULL
        AND ($2::timestamptz IS NULL OR event."occurredAt" >= $2::timestamptz)
        AND ($3::timestamptz IS NULL OR event."occurredAt" <= $3::timestamptz)
    )
    SELECT
      "campaignId",
      COALESCE(SUM("amountCents") FILTER (WHERE LOWER(COALESCE("transactionStatus", '')) <> 'undo'), 0)::bigint AS "grossCents",
      COALESCE(SUM("netCents") FILTER (WHERE LOWER(COALESCE("transactionStatus", '')) <> 'undo'), 0)::bigint AS "netCents",
      COUNT(*) FILTER (WHERE LOWER(COALESCE("transactionStatus", '')) <> 'undo')::bigint AS "transactionsCount",
      COUNT(DISTINCT "fanId") FILTER (WHERE LOWER(COALESCE("transactionStatus", '')) <> 'undo')::bigint AS "payingFans",
      COALESCE(SUM("amountCents") FILTER (WHERE LOWER(COALESCE("transactionStatus", '')) = 'done'), 0)::bigint AS "settledGrossCents",
      COALESCE(SUM("netCents") FILTER (WHERE LOWER(COALESCE("transactionStatus", '')) = 'done'), 0)::bigint AS "settledNetCents",
      COUNT(*) FILTER (WHERE LOWER(COALESCE("transactionStatus", '')) = 'done')::bigint AS "settledTransactionsCount",
      COALESCE(SUM("amountCents") FILTER (WHERE LOWER(COALESCE("transactionStatus", '')) = 'loading'), 0)::bigint AS "pendingGrossCents",
      COALESCE(SUM("netCents") FILTER (WHERE LOWER(COALESCE("transactionStatus", '')) = 'loading'), 0)::bigint AS "pendingNetCents",
      COUNT(*) FILTER (WHERE LOWER(COALESCE("transactionStatus", '')) = 'loading')::bigint AS "pendingTransactionsCount",
      COALESCE(SUM("netCents") FILTER (WHERE "transactionType" IN ('message','post','stream') AND LOWER(COALESCE("transactionStatus", '')) <> 'undo'), 0)::bigint AS "salesRevenueCents",
      COALESCE(SUM("netCents") FILTER (WHERE "transactionType" IN ('tip','tips') AND LOWER(COALESCE("transactionStatus", '')) <> 'undo'), 0)::bigint AS "tipsRevenueCents",
      COALESCE(SUM("netCents") FILTER (WHERE "transactionType" LIKE 'subscription%' AND LOWER(COALESCE("transactionStatus", '')) <> 'undo'), 0)::bigint AS "subscriptionRevenueCents"
    FROM attributed
    GROUP BY "campaignId"
  `, creatorId, start, end);
  return new Map(rows.map((row) => [String(row.campaignId), {
    // Preserve the old overview field name as settled NET revenue: this is the
    // amount the creator actually earned, while gross/pending remain available
    // explicitly for the new campaign scanner.
    totalRevenueCents: Number(row.settledNetCents ?? row.totalRevenueCents ?? 0),
    grossCents: Number(row.grossCents ?? row.totalRevenueCents ?? 0),
    netCents: Number(row.netCents ?? row.totalRevenueCents ?? 0),
    transactionsCount: Number(row.transactionsCount || 0),
    payingFans: Number(row.payingFans || 0),
    settledGrossCents: Number(row.settledGrossCents ?? row.totalRevenueCents ?? 0),
    settledNetCents: Number(row.settledNetCents ?? row.totalRevenueCents ?? 0),
    settledTransactionsCount: Number(row.settledTransactionsCount ?? row.transactionsCount ?? 0),
    pendingGrossCents: Number(row.pendingGrossCents || 0),
    pendingNetCents: Number(row.pendingNetCents || 0),
    pendingTransactionsCount: Number(row.pendingTransactionsCount || 0),
    salesRevenueCents: Number(row.salesRevenueCents || 0),
    tipsRevenueCents: Number(row.tipsRevenueCents || 0),
    subscriptionRevenueCents: Number(row.subscriptionRevenueCents || 0),
  }]));
}

async function readCreatorCoverage({ db = prisma, creatorId, rangeKey, limit = 120, offset = 0, now = new Date(), authorityResolved = false }) {
  if (!authorityResolved) now = await dbAuthorityNow({ db, fallbackNow: now });
  const range = rangeBounds(rangeKey, now);
  const dayBetween = { gte: range.dayStart, lte: range.dayEnd };
  const take = Math.max(1, Math.min(500, Number(limit) || 120));
  const skip = Math.max(0, Math.min(1_000_000, Number(offset) || 0));
  const where = { creatorId, coverageDate: dayBetween };
  const [rows, total] = await Promise.all([
    db.analyticsCoverage.findMany({
      where,
      orderBy: [{ dataType: "asc" }, { coverageDate: "desc" }],
      skip,
      take: take + 1,
    }),
    db.analyticsCoverage.count({ where }),
  ]);
  const hasMore = rows.length > take;
  const page = rows.slice(0, take).map((row) => ({
    ...row,
    coverageDate: row.coverageDate.toISOString().slice(0, 10),
  }));
  return {
    rows: page,
    pagination: { limit: take, offset: skip, returned: page.length, total, hasMore },
  };
}

async function readCreatorLedgerOverview({ db = prisma, creatorId, rangeKey, now = new Date(), includeMessages = true, includeCoveragePage = true, authorityResolved = false }) {
  if (!authorityResolved) now = await dbAuthorityNow({ db, fallbackNow: now });
  const range = rangeBounds(rangeKey, now);
  const eventBetween = { gte: range.start, lte: range.end };
  const dayBetween = { gte: range.dayStart, lte: range.dayEnd };
  const currentDay = utcDay(now);
  const currentDayInRange = currentDay >= range.dayStart && currentDay <= range.dayEnd;
  const [earnings, messages, likes, comments, likesCount, commentsCount, sales, tips, subscriptions, campaigns, coveragePage, earningsCoverageRows, completeMessageDays, inProgressMessageDays, campaignRevenue, unknownCampaignAttribution, notificationSync, dailyMetrics, paidSubscriptions, subscriptionStates, localMessageCoverage] = await Promise.all([
    db.creatorEarningsDaily.findMany({ where: { creatorId, date: dayBetween }, orderBy: { date: "asc" } }),
    includeMessages ? db.creatorMessagesDaily.findMany({ where: { creatorId, date: dayBetween }, orderBy: { date: "asc" } }) : Promise.resolve([]),
    db.creatorPostLike.groupBy({ by: ["onlyFansPostId"], where: { creatorId, likedAt: eventBetween }, _count: { _all: true }, orderBy: { _count: { onlyFansPostId: "desc" } }, take: 50 }),
    db.creatorPostComment.groupBy({ by: ["onlyFansPostId"], where: { creatorId, commentedAt: eventBetween }, _count: { _all: true }, orderBy: { _count: { onlyFansPostId: "desc" } }, take: 50 }),
    db.creatorPostLike.count({ where: { creatorId, likedAt: eventBetween } }),
    db.creatorPostComment.count({ where: { creatorId, commentedAt: eventBetween } }),
    db.creatorSale.aggregate({ where: { creatorId, purchasedAt: eventBetween }, _sum: { amountCents: true }, _count: { _all: true } }),
    db.creatorTip.aggregate({ where: { creatorId, tippedAt: eventBetween }, _sum: { amountCents: true }, _count: { _all: true } }),
    db.creatorSubscriptionEvent.groupBy({ by: ["eventType"], where: { creatorId, occurredAt: eventBetween }, _count: { _all: true }, _sum: { observedPriceCents: true } }),
    db.creatorCampaign.findMany({ where: { creatorId }, include: { _count: { select: { fans: true } } }, orderBy: [{ isActive: "desc" }, { collectedAt: "desc" }], take: 2000 }),
    includeCoveragePage ? readCreatorCoverage({ db, creatorId, rangeKey, limit: 120, offset: 0, now, authorityResolved: true }) : Promise.resolve({ rows: [], pagination: { limit: 0, offset: 0, returned: 0, total: 0, hasMore: false } }),
    db.analyticsCoverage.findMany({
      where: {
        creatorId, dataType: "EARNINGS", sourceTimezone: "UTC",
        coverageDate: dayBetween, status: { in: ["COMPLETE", "PARTIAL"] },
      },
      select: {
        coverageDate: true, status: true, lastVerifiedAt: true, retryAfterAt: true, lastErrorCode: true,
        scanProofId: true, scanProof: { select: { status: true } },
      },
      orderBy: { coverageDate: "asc" },
    }),
    includeMessages ? db.analyticsCoverage.count({ where: { creatorId, dataType: "MESSAGES_DAILY", sourceTimezone: "UTC", status: "COMPLETE", coverageDate: dayBetween } }) : Promise.resolve(0),
    includeMessages && currentDayInRange ? db.analyticsCoverage.count({ where: { creatorId, dataType: "MESSAGES_DAILY", sourceTimezone: "UTC", status: "PARTIAL", coverageDate: currentDay, lastErrorCode: "MESSAGES_DAY_IN_PROGRESS" } }) : Promise.resolve(0),
    readCampaignRevenue({ db, creatorId, start: range.start, end: range.end }),
    db.creatorCampaignFan.groupBy({ by: ["campaignId"], where: { creatorId, attributedAt: null }, _count: { _all: true } }),
    db.creatorNotificationSyncState?.findUnique
      ? db.creatorNotificationSyncState.findUnique({ where: { creatorId } })
      : Promise.resolve(null),
    db.creatorDailyMetrics?.findMany
      ? db.creatorDailyMetrics.findMany({
          where: { creatorId, date: dayBetween, sourceTimezone: "UTC" },
          orderBy: { date: "asc" },
          ...(includeMessages ? {} : { select: { date: true, likes: true, comments: true, newSubscribers: true, renewals: true } }),
        })
      : Promise.resolve([]),
    db.creatorPaidSubscription?.aggregate
      ? db.creatorPaidSubscription.aggregate({ where: { creatorId, paidAt: eventBetween }, _sum: { amountCents: true }, _count: { _all: true } })
      : Promise.resolve({ _sum: { amountCents: 0 }, _count: { _all: 0 } }),
    db.creatorSubscriptionState?.groupBy
      ? db.creatorSubscriptionState.groupBy({ by: ["status"], where: { creatorId }, _count: { _all: true } })
      : Promise.resolve([]),
    includeMessages && db.creatorLocalMessageCoverage?.findMany
      ? db.creatorLocalMessageCoverage.findMany({ where: { creatorId }, orderBy: { lastVerifiedAt: "desc" } })
      : Promise.resolve([]),
  ]);
  const earningsKeys = ["subscriptionsCents", "messagesCents", "tipsCents", "postsCents", "streamsCents", "referralsCents", "totalCents"];
  const earningsAccumulator = earnings.reduce((acc, row) => {
    for (const key of earningsKeys) {
      if (row[key] !== null && row[key] !== undefined) {
        acc.sums[key] += Number(row[key]);
        acc.known[key] += 1;
      }
    }
    return acc;
  }, {
    sums: { subscriptionsCents: 0, messagesCents: 0, tipsCents: 0, postsCents: 0, streamsCents: 0, referralsCents: 0, totalCents: 0 },
    known: { subscriptionsCents: 0, messagesCents: 0, tipsCents: 0, postsCents: 0, streamsCents: 0, referralsCents: 0, totalCents: 0 },
  });
  const earningsTotals = Object.fromEntries(earningsKeys.map((key) => [key, earningsAccumulator.known[key] ? earningsAccumulator.sums[key] : null]));
  const messageTotals = messages.reduce((acc, row) => {
    for (const key of ["incomingMessages", "outgoingMessages", "totalMessages", "uniqueDialogs", "uniqueIncomingFans", "uniqueOutgoingFans"]) acc[key] += row[key];
    return acc;
  }, { incomingMessages: 0, outgoingMessages: 0, totalMessages: 0, uniqueDialogs: 0, uniqueIncomingFans: 0, uniqueOutgoingFans: 0 });
  const unknownAttributionByCampaign = new Map(unknownCampaignAttribution.map((row) => [String(row.campaignId), Number(row._count?._all || 0)]));
  const campaignRows = campaigns.map((row) => {
    const revenue = campaignRevenue.get(row.id) || { totalRevenueCents: 0, salesRevenueCents: 0, tipsRevenueCents: 0, subscriptionRevenueCents: 0, transactionsCount: 0 };
    const unknownAttributionFans = unknownAttributionByCampaign.get(row.id) || 0;
    const { _count, ...plain } = row;
    return { ...plain, fansCount: _count.fans, unknownAttributionFans, revenueVerified: unknownAttributionFans === 0, ...revenue };
  });
  const expectedEarningsDays = Math.floor((range.dayEnd.getTime() - range.dayStart.getTime()) / 86_400_000) + 1;
  let completeEarningsDays = 0;
  let provenEarningsDays = 0;
  let freshEarningsDays = 0;
  let partialEarningsDays = 0;
  let earningsRetryAfterAt = null;
  for (const row of earningsCoverageRows) {
    const day = utcDay(row.coverageDate);
    const isCurrentDay = day.getTime() === currentDay.getTime();
    const state = evaluateCollectionState({
      status: row.status,
      proofStatus: row.scanProof?.status || null,
      lastVerifiedAt: row.lastVerifiedAt || null,
      retryAfterAt: row.retryAfterAt || null,
      now,
      freshnessMs: earningsFreshnessLimitMs(day, now),
      partialUsable: isCurrentDay,
    });
    if (state.complete) completeEarningsDays += 1;
    if (state.partial) partialEarningsDays += 1;
    if (state.usable) provenEarningsDays += 1;
    if (state.fresh) freshEarningsDays += 1;
    if (state.deferred && state.retryAfterAt && (!earningsRetryAfterAt || state.retryAfterAt > earningsRetryAfterAt)) {
      earningsRetryAfterAt = state.retryAfterAt;
    }
  }
  const earningsCollectionState = evaluateAggregateCollectionState({
    expectedUnits: expectedEarningsDays,
    completeUnits: completeEarningsDays,
    provenUsableUnits: provenEarningsDays,
    freshUsableUnits: freshEarningsDays,
    partialUnits: partialEarningsDays,
    retryAfterAt: earningsRetryAfterAt,
    now,
  });
  const verifiedEarningsDays = earningsCollectionState.provenUsableUnits;
  const verifiedMessageDays = completeMessageDays + inProgressMessageDays;
  const officialEarnings = earnings.length === expectedEarningsDays && earningsCollectionState.usable;
  const officialMessages = messages.length === expectedEarningsDays && verifiedMessageDays === expectedEarningsDays;
  return {
    ok: true,
    creatorId,
    range: { key: range.key, startAt: range.start.toISOString(), endAt: range.end.toISOString() },
    verification: {
      officialEarnings,
      officialMessages,
      notificationFacts: Boolean(trustedCollectionTimestamp(notificationSync?.fullBackfillVerifiedAt, now)),
      earningsDays: verifiedEarningsDays,
      earningsComplete: earningsCollectionState.complete,
      earningsProven: earningsCollectionState.proven,
      earningsFresh: earningsCollectionState.fresh,
      earningsStale: earningsCollectionState.stale,
      earningsDue: earningsCollectionState.due,
      earningsDeferred: earningsCollectionState.deferred,
      earningsState: stateVocabulary(earningsCollectionState),
      messageDays: verifiedMessageDays,
    },
    notificationSync: notificationSync ? {
      status: notificationSync.status,
      mode: notificationSync.mode,
      pagesScanned: notificationSync.pagesScanned,
      eventsAccepted: notificationSync.eventsAccepted,
      eventsRejected: notificationSync.eventsRejected,
      ignoredEvents: notificationSync.ignoredEvents,
      fullBackfillCompletedAt: notificationSync.fullBackfillCompletedAt,
      fullBackfillVerifiedAt: notificationSync.fullBackfillVerifiedAt,
      oldestOccurredAt: notificationSync.oldestOccurredAt,
      newestOccurredAt: notificationSync.newestOccurredAt,
      lastCatchupCompletedAt: notificationSync.lastCatchupCompletedAt,
      lastCatchupVerifiedAt: notificationSync.lastCatchupVerifiedAt,
      retryAfterAt: notificationSync.retryAfterAt,
      lastSocketEventAt: notificationSync.lastSocketEventAt,
      lastErrorCode: notificationSync.lastErrorCode,
      lastErrorMessage: notificationSync.lastErrorMessage,
    } : null,
    totals: {
      ...earningsTotals,
      ...messageTotals,
      dialogDays: messageTotals.uniqueDialogs,
      salesCents: sales._sum.amountCents || 0,
      salesCount: sales._count._all,
      tipsLedgerCents: tips._sum.amountCents || 0,
      tipsCount: tips._count._all,
      paidSubscriptionsCents: paidSubscriptions._sum.amountCents || 0,
      paidSubscriptionsCount: paidSubscriptions._count._all,
      likesCount,
      commentsCount,
    },
    daily: {
      earnings: earnings.map((row) => ({ ...row, date: row.date.toISOString().slice(0, 10) })),
      messages: messages.map((row) => ({ ...row, date: row.date.toISOString().slice(0, 10) })),
      metrics: dailyMetrics.map((row) => ({ ...row, date: row.date.toISOString().slice(0, 10) })),
    },
    availability: (() => {
      const activityFrom = notificationSync?.oldestOccurredAt ? new Date(notificationSync.oldestOccurredAt) : null;
      const endCandidates = [
        notificationSync?.fullBackfillVerifiedAt,
        notificationSync?.lastCatchupCompletedAt,
        notificationSync?.lastSocketEventAt,
        notificationSync?.newestOccurredAt,
      ]
        .map((value) => trustedCollectionTimestamp(value, now))
        .filter(Boolean);
      const activityTo = endCandidates.length
        ? new Date(Math.max(...endCandidates.map((value) => value.getTime())))
        : null;
      const validFrom = activityFrom && Number.isFinite(activityFrom.getTime()) ? activityFrom : null;
      const validRange = validFrom && activityTo && activityTo >= validFrom;
      return {
        activityFromAt: validFrom,
        activityToAt: activityTo,
        activityAvailableDays: validRange
          ? Math.floor((activityTo.getTime() - validFrom.getTime()) / 86_400_000) + 1
          : 0,
      };
    })(),
    subscriptionStates,
    localMessageCoverage,
    engagement: { likes, comments },
    subscriptions,
    campaigns: campaignRows,
    coverage: coveragePage.rows,
    coveragePagination: coveragePage.pagination,
  };
}

async function readCampaignFans({ db = prisma, creatorId, campaignId, limit = 50, offset = 0, rangeKey = null, now = new Date(), authorityResolved = false }) {
  if (!authorityResolved) now = await dbAuthorityNow({ db, fallbackNow: now });
  const fanValueFreshnessCutoff = new Date(now.getTime() - CAMPAIGN_FAN_VALUE_FRESHNESS_MS);
  const take = Math.max(1, Math.min(100, Number(limit) || 50));
  const skip = Math.max(0, Math.min(1_000_000, Number(offset) || 0));
  const campaign = await db.creatorCampaign.findFirst({
    where: { id: campaignId, creatorId },
    select: { id: true, externalCampaignId: true, name: true, isActive: true },
  });
  if (!campaign) return null;

  // Read the page through Prisma so fan identity remains strongly typed, then
  // aggregate money only for those fan ids. A payment belongs to the latest
  // campaign attribution that existed before the payment, which prevents one
  // transaction from being counted for multiple campaigns when the same fan
  // later enters another tracking campaign.
  const rows = await db.creatorCampaignFan.findMany({
    where: { creatorId, campaignId: campaign.id },
    include: {
      fan: {
        select: {
          id: true,
          onlyFansUserId: true,
          username: true,
          displayName: true,
          firstSeenAt: true,
          lastSeenAt: true,
          valueCurrent: {
            select: {
              availability: true,
              platformReportedTotalSpendCents: true,
              messagesSpentCents: true,
              subscriptionsSpentCents: true,
              tipsSpentCents: true,
              postsSpentCents: true,
              streamsSpentCents: true,
              lastActivityAt: true,
              valueObservedAt: true,
              source: true,
            },
          },
        },
      },
    },
    orderBy: [{ attributedAt: "desc" }, { collectedAt: "desc" }, { id: "desc" }],
    skip,
    take: take + 1,
  });
  const pageRows = rows.slice(0, take);
  const fanRecordIds = pageRows.map((row) => row.fanRecordId).filter(Boolean);
  const range = rangeKey ? rangeBounds(rangeKey, now) : null;
  let moneyByFan = new Map();
  const queryRaw = typeof db.$queryRawUnsafe === "function"
    ? db.$queryRawUnsafe.bind(db)
    : typeof db.$queryRaw === "function" ? db.$queryRaw.bind(db) : null;
  if (fanRecordIds.length && queryRaw) {
    const moneyRows = await queryRaw(`
      WITH attributed AS (
        SELECT
          event."fanId",
          event."amountCents",
          event."netCents",
          event."transactionStatus",
          membership."campaignId"
        FROM "CreatorFinancialTransaction" AS event
        JOIN LATERAL (
          SELECT link."campaignId"
          FROM "CreatorCampaignFan" AS link
          WHERE link."creatorId" = $1
            AND link."fanId" = event."fanId"
            AND link."attributedAt" IS NOT NULL
            AND link."attributedAt" <= event."occurredAt"
          ORDER BY link."attributedAt" DESC, link."id" DESC
          LIMIT 1
        ) AS membership ON TRUE
        WHERE event."creatorId" = $1
          AND event."fanId" = ANY($3::text[])
          AND ($4::timestamptz IS NULL OR event."occurredAt" >= $4::timestamptz)
          AND ($5::timestamptz IS NULL OR event."occurredAt" <= $5::timestamptz)
      )
      SELECT
        "fanId",
        COALESCE(SUM("amountCents") FILTER (WHERE LOWER(COALESCE("transactionStatus", '')) <> 'undo'), 0)::bigint AS "grossCents",
        COALESCE(SUM("netCents") FILTER (WHERE LOWER(COALESCE("transactionStatus", '')) <> 'undo'), 0)::bigint AS "netCents",
        COUNT(*) FILTER (WHERE LOWER(COALESCE("transactionStatus", '')) <> 'undo')::bigint AS "transactionsCount",
        COALESCE(SUM("amountCents") FILTER (WHERE LOWER(COALESCE("transactionStatus", '')) = 'done'), 0)::bigint AS "settledGrossCents",
        COALESCE(SUM("netCents") FILTER (WHERE LOWER(COALESCE("transactionStatus", '')) = 'done'), 0)::bigint AS "settledNetCents",
        COUNT(*) FILTER (WHERE LOWER(COALESCE("transactionStatus", '')) = 'done')::bigint AS "settledTransactionsCount",
        COALESCE(SUM("amountCents") FILTER (WHERE LOWER(COALESCE("transactionStatus", '')) = 'loading'), 0)::bigint AS "pendingGrossCents",
        COALESCE(SUM("netCents") FILTER (WHERE LOWER(COALESCE("transactionStatus", '')) = 'loading'), 0)::bigint AS "pendingNetCents",
        COUNT(*) FILTER (WHERE LOWER(COALESCE("transactionStatus", '')) = 'loading')::bigint AS "pendingTransactionsCount"
      FROM attributed
      WHERE "campaignId" = $2
      GROUP BY "fanId"
    `, creatorId, campaign.id, fanRecordIds, range?.start || null, range?.end || null);
    moneyByFan = new Map(moneyRows.map((row) => [String(row.fanId), {
      grossCents: Number(row.grossCents || 0),
      netCents: Number(row.netCents || 0),
      transactionsCount: Number(row.transactionsCount || 0),
      settledGrossCents: Number(row.settledGrossCents || 0),
      settledNetCents: Number(row.settledNetCents || 0),
      settledTransactionsCount: Number(row.settledTransactionsCount || 0),
      pendingGrossCents: Number(row.pendingGrossCents || 0),
      pendingNetCents: Number(row.pendingNetCents || 0),
      pendingTransactionsCount: Number(row.pendingTransactionsCount || 0),
    }]));
  }
  const zeroMoney = {
    grossCents: 0, netCents: 0, transactionsCount: 0,
    settledGrossCents: 0, settledNetCents: 0, settledTransactionsCount: 0,
    pendingGrossCents: 0, pendingNetCents: 0, pendingTransactionsCount: 0,
  };
  const hasMore = rows.length > take;
  return {
    campaign,
    range: range ? { key: range.key, startAt: range.start.toISOString(), endAt: range.end.toISOString() } : null,
    fans: pageRows.map((row) => {
      const { valueCurrent, ...fan } = row.fan;
      const valueObservedAt = valueCurrent?.valueObservedAt ? new Date(valueCurrent.valueObservedAt) : null;
      const valueFresh = Boolean(
        valueCurrent && valueObservedAt && Number.isFinite(valueObservedAt.getTime()) &&
        valueObservedAt.getTime() >= fanValueFreshnessCutoff.getTime()
      );
      return {
        id: row.id,
        externalClaimerId: row.externalClaimerId,
        attributedAt: row.attributedAt,
        collectedAt: row.collectedAt,
        fan,
        fanValue: valueFresh ? {
          available: valueCurrent.availability === "AVAILABLE",
          availability: valueCurrent.availability,
          platformReportedTotalSpendCents: valueCurrent.platformReportedTotalSpendCents == null ? null : Number(valueCurrent.platformReportedTotalSpendCents),
          messagesSpentCents: valueCurrent.messagesSpentCents == null ? null : Number(valueCurrent.messagesSpentCents),
          subscriptionsSpentCents: valueCurrent.subscriptionsSpentCents == null ? null : Number(valueCurrent.subscriptionsSpentCents),
          tipsSpentCents: valueCurrent.tipsSpentCents == null ? null : Number(valueCurrent.tipsSpentCents),
          postsSpentCents: valueCurrent.postsSpentCents == null ? null : Number(valueCurrent.postsSpentCents),
          streamsSpentCents: valueCurrent.streamsSpentCents == null ? null : Number(valueCurrent.streamsSpentCents),
          lastActivityAt: valueCurrent.lastActivityAt,
          observedAt: valueCurrent.valueObservedAt,
          source: valueCurrent.source,
        } : null,
        fanValueStaleObservedAt: !valueFresh && valueObservedAt ? valueObservedAt : null,
        fanValueFreshnessCutoffAt: fanValueFreshnessCutoff,
        revenue: moneyByFan.get(String(row.fanRecordId)) || zeroMoney,
      };
    }),
    pagination: { limit: take, offset: skip, returned: pageRows.length, hasMore },
  };
}

async function readCampaignsWithRevenue({ db = prisma, creatorId, limit = 100, offset = 0 }) {
  const take = Math.max(1, Math.min(200, Number(limit) || 100));
  const skip = Math.max(0, Math.min(1_000_000, Number(offset) || 0));
  const authorityNow = await dbAuthorityNow({ db, fallbackNow: new Date() });
  const valueFreshnessCutoff = new Date(authorityNow.getTime() - CAMPAIGN_FAN_VALUE_FRESHNESS_MS);
  const [rows, total, totalFans] = await Promise.all([
    db.creatorCampaign.findMany({
      where: { creatorId },
      include: { _count: { select: { fans: true } } },
      orderBy: [{ isActive: "desc" }, { startedAt: "desc" }, { collectedAt: "desc" }, { id: "desc" }],
      skip,
      take: take + 1,
    }),
    db.creatorCampaign.count({ where: { creatorId } }),
    db.creatorCampaignFan.count({ where: { creatorId } }),
  ]);
  const revenue = await readCampaignRevenue({ db, creatorId, start: null, end: null });
  const currentValueRows = typeof db.$queryRawUnsafe === "function" ? await db.$queryRawUnsafe(`
    SELECT
      membership."campaignId",
      COUNT(value."id")::bigint AS "ofValueKnownFans",
      COUNT(*) FILTER (WHERE value."totalNetCents" > 0)::bigint AS "ofValuePayingFans",
      COALESCE(SUM(value."totalNetCents"), 0)::bigint AS "platformReportedFanSpendCents",
      MAX(value."fetchedAt") AS "ofValueFetchedAt"
    FROM "CreatorCampaignFan" AS membership
    LEFT JOIN "CreatorFanValueCurrent" AS value
      ON value."creatorId" = membership."creatorId" AND value."fanId" = membership."fanId"
     AND value."availability" = 'AVAILABLE'
     AND value."fetchedAt" >= $2::timestamptz
    WHERE membership."creatorId" = $1
    GROUP BY membership."campaignId"
  `, creatorId, valueFreshnessCutoff) : [];
  const currentValueByCampaign = new Map(currentValueRows.map((row) => [String(row.campaignId), {
    ofValueKnownFans: Number(row.ofValueKnownFans || 0),
    ofValuePayingFans: Number(row.ofValuePayingFans || 0),
    platformReportedFanSpendCents: Number(row.platformReportedFanSpendCents || 0),
    ofValueFetchedAt: row.ofValueFetchedAt || null,
  }]));
  const pageRows = rows.slice(0, take).map((row) => {
    const { _count, ...campaign } = row;
    const money = revenue.get(row.id) || {
      totalRevenueCents: 0, grossCents: 0, netCents: 0, transactionsCount: 0, payingFans: 0,
      settledGrossCents: 0, settledNetCents: 0, settledTransactionsCount: 0,
      pendingGrossCents: 0, pendingNetCents: 0, pendingTransactionsCount: 0,
      salesRevenueCents: 0, tipsRevenueCents: 0, subscriptionRevenueCents: 0,
    };
    const currentValue = currentValueByCampaign.get(row.id) || { ofValueKnownFans: 0, ofValuePayingFans: 0, platformReportedFanSpendCents: 0, ofValueFetchedAt: null };
    return { ...campaign, fansCount: Number(_count?.fans || 0), ...money, ...currentValue };
  });
  const revenueSummary = [...revenue.values()].reduce((acc, item) => {
    acc.payingFans += Number(item.payingFans || 0);
    acc.settledNetCents += Number(item.settledNetCents || 0);
    acc.pendingNetCents += Number(item.pendingNetCents || 0);
    acc.transactionsCount += Number(item.transactionsCount || 0);
    return acc;
  }, { payingFans: 0, settledNetCents: 0, pendingNetCents: 0, transactionsCount: 0 });
  const currentValueSummaryRows = typeof db.$queryRawUnsafe === "function" ? await db.$queryRawUnsafe(`
    SELECT
      COUNT(value."id")::bigint AS "ofValueKnownFans",
      COUNT(*) FILTER (WHERE value."totalNetCents" > 0)::bigint AS "ofValuePayingFans",
      COALESCE(SUM(value."totalNetCents"), 0)::bigint AS "platformReportedFanSpendCents",
      MAX(value."fetchedAt") AS "ofValueFetchedAt"
    FROM "CreatorFanValueCurrent" AS value
    WHERE value."creatorId" = $1
      AND value."availability" = 'AVAILABLE'
      AND value."fetchedAt" >= $2::timestamptz
      AND EXISTS (
        SELECT 1 FROM "CreatorCampaignFan" AS membership
        WHERE membership."creatorId" = $1 AND membership."fanId" = value."fanId"
      )
  `, creatorId, valueFreshnessCutoff) : [];
  const currentValueSummary = currentValueSummaryRows[0] || {};
  return {
    campaigns: pageRows,
    summary: {
      campaigns: total,
      fans: totalFans,
      ...revenueSummary,
      ofValueKnownFans: Number(currentValueSummary.ofValueKnownFans || 0),
      ofValuePayingFans: Number(currentValueSummary.ofValuePayingFans || 0),
      platformReportedFanSpendCents: Number(currentValueSummary.platformReportedFanSpendCents || 0),
      ofValueFetchedAt: currentValueSummary.ofValueFetchedAt || null,
      ofValueFreshnessCutoffAt: valueFreshnessCutoff,
    },
    pagination: { limit: take, offset: skip, returned: pageRows.length, total, hasMore: rows.length > take },
  };
}

module.exports = {
  ingestEarningsChunk,
  completeEarningsScan,
  ingestCampaignChunk,
  loadCampaignDirectorySegment,
  ingestCampaignFanValueChunk,
  ingestCampaignFanValuesBatchChunk,
  completeCampaignScan,
  upsertMessagesDaily,
  readCreatorLedgerOverview,
  readCreatorCoverage,
  readCampaignFans,
  readCampaignsWithRevenue,
  normalizeEarningsRow,
  normalizeCampaign,
  normalizeMessageDay,
  rangeBounds,
  EARNINGS_COLLECTOR_VERSION,
  EARNINGS_SCHEMA_VERSION,
  CAMPAIGN_COLLECTOR_VERSION,
  CAMPAIGN_SCHEMA_VERSION,
};
