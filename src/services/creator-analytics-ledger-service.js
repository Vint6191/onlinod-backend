"use strict";

const crypto = require("node:crypto");
const prisma = require("../prisma");
const { parseStrictIsoDateTime } = require("./strict-date-time");

const RANGE_DAYS = Object.freeze({ "24h": 1, "7d": 7, "30d": 30, "90d": 90, "180d": 180, "365d": 365 });
const CAMPAIGN_COLLECTOR_VERSION = "campaigns-v4";
const CAMPAIGN_SCHEMA_VERSION = 3;
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
const EARNINGS_RANGE_KEYS = new Set(["24h", "7d", "30d", "90d", "180d", "365d", "ytd", "prev_year", "all"]);
function rangeBounds(rangeKey, now = new Date()) {
  const end = new Date(now);
  const key = String(rangeKey || "30d").toLowerCase();
  let start;
  if (key === "24h") {
    start = utcDay(end);
  } else if (RANGE_DAYS[key]) {
    start = utcDay(end);
    start.setUTCDate(start.getUTCDate() - (RANGE_DAYS[key] - 1));
  } else if (key === "ytd") {
    start = new Date(Date.UTC(end.getUTCFullYear(), 0, 1));
  } else if (key === "prev_year") {
    start = new Date(Date.UTC(end.getUTCFullYear() - 1, 0, 1));
    end.setTime(Date.UTC(end.getUTCFullYear(), 0, 1) - 1);
  } else {
    start = new Date(Date.UTC(2016, 0, 1));
  }
  return { key, start, end, dayStart: utcDay(start), dayEnd: utcDay(end) };
}
function earningsJobBounds(job, observedAt) {
  const key = String(job?.params?.rangeKey || "7d").trim().toLowerCase();
  if (!EARNINGS_RANGE_KEYS.has(key)) throw new Error("Earnings job rangeKey is invalid");
  return rangeBounds(key, observedAt);
}
function requireJob(job) {
  if (!job?.id || !job?.creatorId || !job?.agencyId) {
    throw new Error("Analytics job is missing id/creator/agency scope");
  }
}
function checksum(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
  return tx.analyticsIngestBatch.update({
    where: { id: batchId },
    data: {
      status,
      receivedRows: counts.received || 0,
      insertedRows: counts.inserted || 0,
      updatedRows: counts.updated || 0,
      unchangedRows: counts.unchanged || 0,
      rejectedRows: counts.rejected || 0,
      completedAt: new Date(),
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

async function latestCampaignGeneration(tx, creatorId) {
  if (typeof tx?.analyticsIngestBatch?.findFirst !== "function") return null;
  const batch = await tx.analyticsIngestBatch.findFirst({
    where: { creatorId, dataType: "CAMPAIGNS" },
    orderBy: [{ rangeFrom: "desc" }, { createdAt: "desc" }],
    select: { rangeFrom: true },
  });
  const value = batch?.rangeFrom;
  const date = value instanceof Date ? value : value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
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
  const requestedRange = earningsJobBounds(job, observedAt);
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
  const rangeFrom = rows[0]?.date || observedAt;
  const rangeTo = rows.length ? utcDayEnd(rows.at(-1).date) : observedAt;
  return inTransaction(db, async (tx) => {
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
    const currentDay = utcDay(observedAt);
    for (const row of rows) {
      const where = { creatorId_date_sourceTimezone: { creatorId: job.creatorId, date: row.date, sourceTimezone: row.sourceTimezone } };
      const existing = await tx.creatorEarningsDaily.findUnique({ where, select: { id: true, collectedAt: true } });
      const existingCollectedAt = existing?.collectedAt instanceof Date
        ? existing.collectedAt
        : existing?.collectedAt ? new Date(existing.collectedAt) : null;
      if (existingCollectedAt && Number.isFinite(existingCollectedAt.getTime()) && existingCollectedAt > observedAt) {
        unchanged += 1;
        continue;
      }
      const data = {
        agencyId: job.agencyId,
        creatorId: job.creatorId,
        ...row,
        sourceScanRunId: scanRunId,
        collectedAt: observedAt,
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
        coveredToAt: isCurrentDay ? observedAt : utcDayEnd(row.date),
        errorCode: isCurrentDay ? "EARNINGS_DAY_IN_PROGRESS" : "EARNINGS_SCAN_PENDING",
        verifiedAt: observedAt,
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
  const requestedRange = earningsJobBounds(job, observedAt);
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
    const complete =
      payload.chartComplete === true &&
      payload.dailyComplete === true &&
      scannerRejected === 0 &&
      allCommitted &&
      pageBatches.length === expectedDailyBatches &&
      expectedDailyCount === requestedDayCount &&
      acceptedRows === expectedDailyCount &&
      persistedDailyCount === expectedDailyCount;
    const desiredStatus = complete ? "COMMITTED" : "PARTIAL";
    if (!replay || batch.status !== desiredStatus) {
      await finishBatch(
        tx,
        batch.id,
        { received: expectedDailyCount + scannerRejected, unchanged: expectedDailyCount, rejected: scannerRejected },
        desiredStatus,
        complete ? null : "EARNINGS_SCAN_PROOF_INCOMPLETE",
        complete ? null : proofMessage(proof),
      );
    }
    if (complete && pageBatches.length) {
      await tx.analyticsCoverage.updateMany({
        where: {
          creatorId: job.creatorId,
          dataType: "EARNINGS",
          ingestBatchId: { in: pageBatches.map((row) => row.id) },
          coverageDate: { lt: utcDay(observedAt) },
          status: "PARTIAL",
          lastErrorCode: "EARNINGS_SCAN_PENDING",
        },
        data: {
          status: "COMPLETE",
          lastVerifiedAt: observedAt,
          lastErrorCode: null,
          lastErrorMessage: null,
          retryAfterAt: null,
        },
      });
    }
    return { batchId: batch.id, complete, replay, proof };
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
  const user = object(row.user || row.fan || row.subscriber || row);
  const onlyFansUserId = text(user.id ?? user.userId ?? row.userId ?? row.fanId, 180);
  if (!onlyFansUserId) return null;
  const attributedAtRaw = row.attributedAt ?? row.createdAt ?? row.created_at ?? row.claimedAt;
  const attributedAt = attributedAtRaw == null ? null : strictDate(attributedAtRaw);
  if (attributedAtRaw != null && !attributedAt) return null;
  return {
    onlyFansUserId,
    username: text(user.username, 200),
    displayName: text(user.name ?? user.displayName, 500),
    externalClaimerId: text(row.id ?? row.claimerId, 220),
    attributedAt,
  };
}

async function ingestCampaignChunk({ db = prisma, job, deviceId, chunk }) {
  requireJob(job);
  const payload = object(chunk);
  const kind = text(payload.kind, 80);
  if (!["campaigns_page", "campaign_claimers_page"].includes(kind)) throw new Error("Unsupported campaign chunk kind");
  const batchKey = text(payload.batchKey, 500);
  const scanRunId = text(payload.scanRunId, 120);
  const scanStartedAt = strictDate(payload.scanStartedAt);
  const observedAt = strictDate(payload.observedAt);
  if (
    !batchKey || !scanRunId || !scanStartedAt || !observedAt || scanStartedAt > observedAt ||
    payload.schemaVersion !== CAMPAIGN_SCHEMA_VERSION || payload.collectorVersion !== CAMPAIGN_COLLECTOR_VERSION
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
    await acquireAnalyticsLock(tx, "creator-campaigns", job.creatorId);
    const { batch, replay } = await beginBatch(tx, {
      job,
      deviceId,
      idempotencyKey,
      dataType: "CAMPAIGNS",
      rangeFrom: scanStartedAt,
      rangeTo: observedAt,
      collectorVersion: payload.collectorVersion,
      schemaVersion: payload.schemaVersion,
      payload,
    });
    if (replay && ["COMMITTED", "PARTIAL"].includes(batch.status)) {
      return { replay: true, batchId: batch.id, status: batch.status };
    }

    const received = rawRows.length + scannerRejected;
    const latestGeneration = await latestCampaignGeneration(tx, job.creatorId);
    if (latestGeneration && latestGeneration > scanStartedAt) {
      await finishBatch(tx, batch.id, { received, unchanged: received }, "COMMITTED");
      return { replay: false, batchId: batch.id, inserted: 0, updated: 0, unchanged: received, rejected: 0, superseded: true };
    }

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
        const existing = await tx.creatorCampaign.findUnique({ where, select: { id: true, sourceScanStartedAt: true } });
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
          collectedAt: observedAt,
          sourceDeviceId: deviceId || null,
          sourceJobId: job.id,
        };
        await tx.creatorCampaign.upsert({
          where,
          create: {
            agencyId: job.agencyId,
            creatorId: job.creatorId,
            ...campaign,
            sourceScanRunId: scanRunId,
            sourceScanStartedAt: scanStartedAt,
            collectedAt: observedAt,
            sourceDeviceId: deviceId || null,
            sourceJobId: job.id,
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
      return { replay: false, batchId: batch.id, inserted, updated, unchanged, rejected, superseded: false };
    }

    const saved = await tx.creatorCampaign.findUnique({
      where: { creatorId_externalCampaignId: { creatorId: job.creatorId, externalCampaignId } },
      select: { id: true },
    });
    if (!saved) throw new Error("Campaign claimer page references an unknown campaign");
    const uniqueClaimers = new Map();
    let backendRejected = 0;
    for (const rawClaimer of rawRows) {
      const claimer = normalizeClaimer(rawClaimer);
      if (!claimer) {
        rejected += 1;
        backendRejected += 1;
        continue;
      }
      uniqueClaimers.set(claimer.onlyFansUserId, claimer);
    }
    const duplicateClaimers = rawRows.length - backendRejected - uniqueClaimers.size;
    unchanged += duplicateClaimers;

    for (const claimer of uniqueClaimers.values()) {
      const seenAt = claimer.attributedAt || observedAt;
      const fanWhere = { creatorId_onlyFansUserId: { creatorId: job.creatorId, onlyFansUserId: claimer.onlyFansUserId } };
      const existingFan = await tx.creatorFan.findUnique({ where: fanWhere, select: { id: true, lastSeenAt: true } });
      let fan;
      if (existingFan) {
        const previousLastSeenAt = existingFan.lastSeenAt instanceof Date ? existingFan.lastSeenAt : new Date(existingFan.lastSeenAt);
        fan = await tx.creatorFan.update({
          where: fanWhere,
          data: {
            ...(claimer.username ? { username: claimer.username } : {}),
            ...(claimer.displayName ? { displayName: claimer.displayName } : {}),
            ...(Number.isFinite(previousLastSeenAt.getTime()) && previousLastSeenAt > seenAt ? {} : { lastSeenAt: seenAt }),
          },
        });
      } else {
        fan = await tx.creatorFan.create({
          data: {
            agencyId: job.agencyId,
            creatorId: job.creatorId,
            onlyFansUserId: claimer.onlyFansUserId,
            username: claimer.username,
            displayName: claimer.displayName,
            firstSeenAt: seenAt,
            lastSeenAt: seenAt,
          },
        });
      }

      const where = { campaignId_fanId: { campaignId: saved.id, fanId: fan.id } };
      const existing = await tx.creatorCampaignFan.findUnique({
        where,
        select: { id: true, sourceScanStartedAt: true, externalClaimerId: true, attributedAt: true },
      });
      if (isNewerGeneration(existing, scanStartedAt)) {
        unchanged += 1;
        continue;
      }
      const existingAttributedAt = existing?.attributedAt ? strictDate(existing.attributedAt) : null;
      const attributedAt = existingAttributedAt && claimer.attributedAt
        ? new Date(Math.min(existingAttributedAt.getTime(), claimer.attributedAt.getTime()))
        : existingAttributedAt || claimer.attributedAt || null;
      await tx.creatorCampaignFan.upsert({
        where,
        create: {
          agencyId: job.agencyId,
          creatorId: job.creatorId,
          campaignId: saved.id,
          fanId: fan.id,
          externalClaimerId: claimer.externalClaimerId,
          attributedAt: claimer.attributedAt,
          sourceScanRunId: scanRunId,
          sourceScanStartedAt: scanStartedAt,
          collectedAt: observedAt,
          sourceDeviceId: deviceId || null,
          sourceJobId: job.id,
        },
        update: {
          externalClaimerId: claimer.externalClaimerId || existing?.externalClaimerId || null,
          attributedAt,
          sourceScanRunId: scanRunId,
          sourceScanStartedAt: scanStartedAt,
          collectedAt: observedAt,
          sourceDeviceId: deviceId || null,
          sourceJobId: job.id,
        },
      });
      if (existing) updated += 1;
      else inserted += 1;
    }

    // Campaign attribution is historical. A later OF response may be partial,
    // delayed or temporarily omit a claimer; never erase a previously observed
    // campaign -> fan fact from a scanner page. New scans only add or refresh
    // evidence. CreatorCampaign.isActive is reconciled separately after a fully
    // proven campaign-list scan.
    const campaignComplete = payload.campaignComplete === true && rejected === 0;
    await finishBatch(
      tx,
      batch.id,
      { received, inserted, updated, unchanged, rejected },
      rejected ? "PARTIAL" : "COMMITTED",
      rejected ? "CAMPAIGN_CLAIMER_PAGE_REJECTED_ROWS" : null,
    );
    return { replay: false, batchId: batch.id, inserted, updated, unchanged, rejected, campaignComplete, superseded: false };
  });
}

async function completeCampaignScan({ db = prisma, job, deviceId, result }) {
  requireJob(job);
  const payload = object(result);
  const scanRunId = text(payload.scanRunId, 120);
  const scanStartedAt = strictDate(payload.scanStartedAt);
  const observedAt = strictDate(payload.observedAt);
  if (
    payload.schemaVersion !== CAMPAIGN_SCHEMA_VERSION || payload.collectorVersion !== CAMPAIGN_COLLECTOR_VERSION ||
    !scanRunId || !scanStartedAt || !observedAt || scanStartedAt > observedAt
  ) {
    throw new Error("Invalid campaign completion contract");
  }
  const expectedCampaignBatches = integer(payload.campaignBatchCount, 50);
  const expectedClaimerBatches = integer(payload.claimerBatchCount, 1_000_000);
  const expectedCampaignCount = integer(payload.campaignCount, 2_000);
  if (expectedCampaignBatches === null || expectedClaimerBatches === null || expectedCampaignCount === null) {
    throw new Error("Campaign completion counters are invalid");
  }
  const key = `campaigns:${job.id}:run:${scanRunId}:completion:v4`;
  if (key.length > 240) throw new Error("Campaign completion idempotency key exceeds 240 characters");
  return inTransaction(db, async (tx) => {
    await acquireAnalyticsLock(tx, "creator-campaigns", job.creatorId);
    const { batch, replay } = await beginBatch(tx, {
      job,
      deviceId,
      idempotencyKey: key,
      dataType: "CAMPAIGNS",
      rangeFrom: scanStartedAt,
      rangeTo: observedAt,
      collectorVersion: payload.collectorVersion,
      schemaVersion: payload.schemaVersion,
      payload,
    });

    const latestGeneration = await latestCampaignGeneration(tx, job.creatorId);
    if (latestGeneration && latestGeneration > scanStartedAt) {
      if (!replay || batch.status !== "COMMITTED") {
        await finishBatch(tx, batch.id, { received: expectedCampaignCount, unchanged: expectedCampaignCount }, "COMMITTED");
      }
      return { batchId: batch.id, complete: true, replay, superseded: true, proof: { newerGeneration: latestGeneration.toISOString() } };
    }

    const batchPrefix = `campaigns:${job.id}:run:${scanRunId}:`;
    const pageBatches = await tx.analyticsIngestBatch.findMany({
      where: {
        sourceJobId: job.id,
        dataType: "CAMPAIGNS",
        idempotencyKey: { startsWith: batchPrefix },
        NOT: { id: batch.id },
      },
      select: { idempotencyKey: true, status: true, rejectedRows: true },
    });
    const campaignBatches = pageBatches.filter((item) => item.idempotencyKey.includes(":campaigns:"));
    const claimerBatches = pageBatches.filter((item) => item.idempotencyKey.includes(":claimers:"));
    const allCommitted = pageBatches.every((item) => item.status === "COMMITTED" && item.rejectedRows === 0);
    const observedCampaignCount = await tx.creatorCampaign.count({
      where: { creatorId: job.creatorId, sourceScanRunId: scanRunId, sourceScanStartedAt: scanStartedAt },
    });
    const proof = {
      expectedCampaignBatches,
      observedCampaignBatches: campaignBatches.length,
      expectedClaimerBatches,
      observedClaimerBatches: claimerBatches.length,
      expectedCampaignCount,
      observedCampaignCount,
      allCommitted,
    };
    const complete =
      payload.campaignPagesComplete === true &&
      payload.claimersComplete === true &&
      payload.truncated !== true &&
      allCommitted &&
      campaignBatches.length === expectedCampaignBatches &&
      claimerBatches.length === expectedClaimerBatches &&
      observedCampaignCount === expectedCampaignCount;
    const desiredBatchStatus = complete ? "COMMITTED" : "PARTIAL";
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
    if (complete) {
      await tx.creatorCampaign.updateMany({
        where: {
          creatorId: job.creatorId,
          OR: [{ sourceScanStartedAt: null }, { sourceScanStartedAt: { lt: scanStartedAt } }],
        },
        data: { isActive: false },
      });
    }
    await setCoverage(tx, {
      job,
      batchId: batch.id,
      dataType: "CAMPAIGNS",
      date: observedAt,
      status: complete ? "COMPLETE" : "PARTIAL",
      coveredFromAt: scanStartedAt,
      coveredToAt: observedAt,
      errorCode: complete ? null : "CAMPAIGN_SCAN_PROOF_INCOMPLETE",
      errorMessage: complete ? null : proofMessage(proof),
      verifiedAt: observedAt,
    });
    return { batchId: batch.id, complete, replay, superseded: false, proof };
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
  if (knownDialogs === null || incompleteDialogs === null || incompleteDialogs > knownDialogs) throw new Error("Messages daily local coverage counters are invalid");
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
  const payload = { rows: rawRows, syncId: cleanSyncId, observedAt: observed.toISOString(), localCoverage: { complete: localCoverageComplete, knownDialogs, incompleteDialogs } };
  const idempotencyKey = `messages-daily:${creatorId}:${cleanSyncId}`;
  return inTransaction(db, async (tx) => {
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
    const status = rejected === 0 ? "COMMITTED" : "PARTIAL";
    await finishBatch(tx, batch.id, { received: rawRows.length, inserted, updated, unchanged, rejected }, status, rejected ? "MESSAGES_DAILY_REJECTED_ROWS" : null);
    return { received: rawRows.length, accepted: normalized.length, rejected, inserted, updated, unchanged, replay: false, localCoverageComplete, knownDialogs, incompleteDialogs };
  });
}

async function readCampaignRevenue({ db, creatorId, start, end }) {
  if (typeof db.$queryRaw !== "function") return new Map();
  const rows = await db.$queryRaw`
    WITH financial_events AS (
      SELECT "fanId", "amountCents", "purchasedAt" AS occurred_at, 'sale'::text AS kind
      FROM "CreatorSale"
      WHERE "creatorId" = ${creatorId} AND "fanId" IS NOT NULL AND "purchasedAt" BETWEEN ${start} AND ${end}
      UNION ALL
      SELECT "fanId", "amountCents", "tippedAt" AS occurred_at, 'tip'::text AS kind
      FROM "CreatorTip"
      WHERE "creatorId" = ${creatorId} AND "fanId" IS NOT NULL AND "tippedAt" BETWEEN ${start} AND ${end}
      UNION ALL
      SELECT "fanId", "observedPriceCents" AS "amountCents", "occurredAt" AS occurred_at, 'subscription'::text AS kind
      FROM "CreatorSubscriptionEvent"
      WHERE "creatorId" = ${creatorId}
        AND "fanId" IS NOT NULL
        AND "observedPriceCents" IS NOT NULL
        AND "eventType" IN ('SUBSCRIBED_PAID', 'RENEWED', 'RESUBSCRIBED')
        AND "occurredAt" BETWEEN ${start} AND ${end}
    ), attributed AS (
      SELECT event.*, membership."campaignId"
      FROM financial_events AS event
      JOIN LATERAL (
        SELECT link."campaignId"
        FROM "CreatorCampaignFan" AS link
        WHERE link."creatorId" = ${creatorId}
          AND link."fanId" = event."fanId"
          AND link."attributedAt" IS NOT NULL
          AND link."attributedAt" <= event.occurred_at
        ORDER BY link."attributedAt" DESC, link."id" DESC
        LIMIT 1
      ) AS membership ON TRUE
    )
    SELECT
      "campaignId",
      COALESCE(SUM("amountCents"), 0)::bigint AS "totalRevenueCents",
      COALESCE(SUM("amountCents") FILTER (WHERE kind = 'sale'), 0)::bigint AS "salesRevenueCents",
      COALESCE(SUM("amountCents") FILTER (WHERE kind = 'tip'), 0)::bigint AS "tipsRevenueCents",
      COALESCE(SUM("amountCents") FILTER (WHERE kind = 'subscription'), 0)::bigint AS "subscriptionRevenueCents",
      COUNT(*)::bigint AS "transactionsCount"
    FROM attributed
    GROUP BY "campaignId"
  `;
  return new Map(rows.map((row) => [String(row.campaignId), {
    totalRevenueCents: Number(row.totalRevenueCents || 0),
    salesRevenueCents: Number(row.salesRevenueCents || 0),
    tipsRevenueCents: Number(row.tipsRevenueCents || 0),
    subscriptionRevenueCents: Number(row.subscriptionRevenueCents || 0),
    transactionsCount: Number(row.transactionsCount || 0),
  }]));
}

async function readCreatorCoverage({ db = prisma, creatorId, rangeKey, limit = 120, offset = 0, now = new Date() }) {
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

async function readCreatorLedgerOverview({ db = prisma, creatorId, rangeKey, now = new Date() }) {
  const range = rangeBounds(rangeKey, now);
  const eventBetween = { gte: range.start, lte: range.end };
  const dayBetween = { gte: range.dayStart, lte: range.dayEnd };
  const currentDay = utcDay(now);
  const currentDayInRange = currentDay >= range.dayStart && currentDay <= range.dayEnd;
  const [earnings, messages, likes, comments, likesCount, commentsCount, sales, tips, subscriptions, campaigns, coveragePage, completeEarningsDays, inProgressEarningsDays, completeMessageDays, inProgressMessageDays, campaignRevenue, unknownCampaignAttribution, notificationSync] = await Promise.all([
    db.creatorEarningsDaily.findMany({ where: { creatorId, date: dayBetween }, orderBy: { date: "asc" } }),
    db.creatorMessagesDaily.findMany({ where: { creatorId, date: dayBetween }, orderBy: { date: "asc" } }),
    db.creatorPostLike.groupBy({ by: ["onlyFansPostId"], where: { creatorId, likedAt: eventBetween }, _count: { _all: true }, orderBy: { _count: { onlyFansPostId: "desc" } }, take: 50 }),
    db.creatorPostComment.groupBy({ by: ["onlyFansPostId"], where: { creatorId, commentedAt: eventBetween }, _count: { _all: true }, orderBy: { _count: { onlyFansPostId: "desc" } }, take: 50 }),
    db.creatorPostLike.count({ where: { creatorId, likedAt: eventBetween } }),
    db.creatorPostComment.count({ where: { creatorId, commentedAt: eventBetween } }),
    db.creatorSale.aggregate({ where: { creatorId, purchasedAt: eventBetween }, _sum: { amountCents: true }, _count: { _all: true } }),
    db.creatorTip.aggregate({ where: { creatorId, tippedAt: eventBetween }, _sum: { amountCents: true }, _count: { _all: true } }),
    db.creatorSubscriptionEvent.groupBy({ by: ["eventType"], where: { creatorId, occurredAt: eventBetween }, _count: { _all: true }, _sum: { observedPriceCents: true } }),
    db.creatorCampaign.findMany({ where: { creatorId }, include: { _count: { select: { fans: true } } }, orderBy: [{ isActive: "desc" }, { collectedAt: "desc" }], take: 2000 }),
    readCreatorCoverage({ db, creatorId, rangeKey, limit: 120, offset: 0, now }),
    db.analyticsCoverage.count({ where: { creatorId, dataType: "EARNINGS", sourceTimezone: "UTC", status: "COMPLETE", coverageDate: dayBetween } }),
    currentDayInRange ? db.analyticsCoverage.count({ where: { creatorId, dataType: "EARNINGS", sourceTimezone: "UTC", status: "PARTIAL", coverageDate: currentDay, lastErrorCode: "EARNINGS_DAY_IN_PROGRESS" } }) : Promise.resolve(0),
    db.analyticsCoverage.count({ where: { creatorId, dataType: "MESSAGES_DAILY", sourceTimezone: "UTC", status: "COMPLETE", coverageDate: dayBetween } }),
    currentDayInRange ? db.analyticsCoverage.count({ where: { creatorId, dataType: "MESSAGES_DAILY", sourceTimezone: "UTC", status: "PARTIAL", coverageDate: currentDay, lastErrorCode: "MESSAGES_DAY_IN_PROGRESS" } }) : Promise.resolve(0),
    readCampaignRevenue({ db, creatorId, start: range.start, end: range.end }),
    db.creatorCampaignFan.groupBy({ by: ["campaignId"], where: { creatorId, attributedAt: null }, _count: { _all: true } }),
    db.creatorNotificationSyncState?.findUnique
      ? db.creatorNotificationSyncState.findUnique({ where: { creatorId } })
      : Promise.resolve(null),
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
  const verifiedEarningsDays = completeEarningsDays + inProgressEarningsDays;
  const verifiedMessageDays = completeMessageDays + inProgressMessageDays;
  const officialEarnings = earnings.length === expectedEarningsDays && verifiedEarningsDays === expectedEarningsDays;
  const officialMessages = messages.length === expectedEarningsDays && verifiedMessageDays === expectedEarningsDays;
  return {
    ok: true,
    creatorId,
    range: { key: range.key, startAt: range.start.toISOString(), endAt: range.end.toISOString() },
    verification: {
      officialEarnings,
      officialMessages,
      notificationFacts: Boolean(notificationSync?.fullBackfillVerifiedAt),
      earningsDays: verifiedEarningsDays,
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
      lastCatchupCompletedAt: notificationSync.lastCatchupCompletedAt,
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
      likesCount,
      commentsCount,
    },
    daily: {
      earnings: earnings.map((row) => ({ ...row, date: row.date.toISOString().slice(0, 10) })),
      messages: messages.map((row) => ({ ...row, date: row.date.toISOString().slice(0, 10) })),
    },
    engagement: { likes, comments },
    subscriptions,
    campaigns: campaignRows,
    coverage: coveragePage.rows,
    coveragePagination: coveragePage.pagination,
  };
}

async function readCampaignFans({ db = prisma, creatorId, campaignId, limit = 50, offset = 0 }) {
  const take = Math.max(1, Math.min(100, Number(limit) || 50));
  const skip = Math.max(0, Math.min(1_000_000, Number(offset) || 0));
  const campaign = await db.creatorCampaign.findFirst({
    where: { id: campaignId, creatorId },
    select: { id: true, externalCampaignId: true, name: true, isActive: true },
  });
  if (!campaign) return null;
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
        },
      },
    },
    orderBy: [{ attributedAt: "desc" }, { collectedAt: "desc" }, { id: "desc" }],
    skip,
    take: take + 1,
  });
  const hasMore = rows.length > take;
  return {
    campaign,
    fans: rows.slice(0, take).map((row) => ({
      id: row.id,
      externalClaimerId: row.externalClaimerId,
      attributedAt: row.attributedAt,
      collectedAt: row.collectedAt,
      fan: row.fan,
    })),
    pagination: { limit: take, offset: skip, returned: Math.min(rows.length, take), hasMore },
  };
}

module.exports = {
  ingestEarningsChunk,
  completeEarningsScan,
  ingestCampaignChunk,
  completeCampaignScan,
  upsertMessagesDaily,
  readCreatorLedgerOverview,
  readCreatorCoverage,
  readCampaignFans,
  normalizeEarningsRow,
  normalizeCampaign,
  normalizeMessageDay,
  rangeBounds,
  EARNINGS_COLLECTOR_VERSION,
  EARNINGS_SCHEMA_VERSION,
  CAMPAIGN_COLLECTOR_VERSION,
  CAMPAIGN_SCHEMA_VERSION,
};
