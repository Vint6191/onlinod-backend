"use strict";

const prisma = require("../prisma");
const { readCreatorLedgerOverview } = require("./creator-analytics-ledger-service");

const DAY_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_RETENTION_DAYS = 30;
const OVERVIEW_RANGES = new Set(["7d", "30d", "90d", "180d", "365d"]);

function object(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
function text(value, max = 500) {
  if (value === null || value === undefined) return null;
  const out = String(value).trim();
  return out ? out.slice(0, max) : null;
}
function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}
function int(value) {
  return Math.max(0, Math.floor(number(value)));
}
function cents(value) {
  return Math.round(number(value));
}
function iso(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
function statusClass(status) {
  const value = String(status || "").toUpperCase();
  if (value === "CLAIMED") return "RUNNING";
  if (value === "SCHEDULED") return "QUEUED";
  if (value === "DONE") return "COMPLETE";
  return value || "IDLE";
}

const JOB_LABELS = Object.freeze({
  catchup_notifications_scan: "Activity history",
  financial_transactions_scan: "Financial history",
  fetch_campaigns: "Campaigns",
  fetch_earnings: "Earnings snapshot",
  subscriber_directory_scan: "Subscribers directory",
  dialog_intelligence_scan: "Dialog history",
  vault_unsorted_scan: "Media catalog",
  traffic_sources_scan: "Traffic sources",
  likes_content_discovery: "Content discovery",
  sfs_target_discovery: "SFS discovery",
  sfs_target_scan: "SFS scan",
});

function jobLabel(jobKey, params = {}) {
  const base = JOB_LABELS[jobKey] || String(jobKey || "Background task").replaceAll("_", " ");
  const syncKind = text(params.analyticsSyncKind, 40);
  const mode = text(params.financialMode || params.campaignMode || params.notificationMode, 40);
  if (syncKind === "initial") return `Initial sync · ${base}`;
  if (syncKind === "catchup" || mode === "catchup") return `Catch-up · ${base}`;
  return base;
}

function progressSnapshot(progress) {
  const row = object(progress);
  let percent = Number(row.percent);
  if (!Number.isFinite(percent)) {
    const current = Number(row.current ?? row.processed ?? row.completed ?? row.fetched ?? row.pages);
    const total = Number(row.total ?? row.requested ?? row.discovered ?? row.totalPages);
    if (Number.isFinite(current) && Number.isFinite(total) && total > 0) percent = current / total * 100;
  }
  if (!Number.isFinite(percent)) percent = 0;
  percent = Math.max(0, Math.min(100, Math.round(percent * 10) / 10));
  const message = text(row.message || row.phase || row.stage || row.waitReason, 500);
  const current = Number(row.current ?? row.processed ?? row.completed ?? row.fetched ?? row.pages);
  const total = Number(row.total ?? row.requested ?? row.discovered ?? row.totalPages);
  return {
    percent,
    message,
    current: Number.isFinite(current) && current >= 0 ? Math.floor(current) : null,
    total: Number.isFinite(total) && total >= 0 ? Math.floor(total) : null,
  };
}

async function readCreatorCurrentTask({ db = prisma, creatorId }) {
  const claimed = await db.jobInstance.findFirst({
    where: { creatorId, status: "CLAIMED" },
    orderBy: [{ lastProgressAt: "desc" }, { priority: "desc" }, { claimedAt: "desc" }],
  });
  const job = claimed || await db.jobInstance.findFirst({
    where: { creatorId, status: { in: ["PAUSED", "SCHEDULED"] } },
    orderBy: [{ priority: "desc" }, { nextRunAt: "asc" }, { createdAt: "asc" }],
  });
  if (!job) return { active: false, status: "IDLE", label: "Background runtime ready", progress: { percent: 100, message: null, current: null, total: null } };
  const params = object(job.params);
  const progress = progressSnapshot(job.progress);
  return {
    active: job.status === "CLAIMED" || job.status === "PAUSED",
    id: job.id,
    jobKey: job.jobKey,
    status: statusClass(job.status),
    rawStatus: job.status,
    label: jobLabel(job.jobKey, params),
    mode: text(params.analyticsSyncKind || params.financialMode || params.campaignMode || params.notificationMode, 80),
    stage: text(params.analyticsSyncStage, 80),
    progress,
    startedAt: iso(job.startedAt || job.claimedAt),
    lastProgressAt: iso(job.lastProgressAt),
    scheduledAt: iso(job.scheduledAt),
    nextRunAt: iso(job.nextRunAt),
    error: text(job.lastError, 2000),
  };
}

async function readCreatorTaskActivityDays({ db = prisma, creatorId, now = new Date() }) {
  const cutoff = new Date(now.getTime() - ACTIVITY_RETENTION_DAYS * DAY_MS);
  if (typeof db?.$queryRawUnsafe === "function") {
    try {
      const rows = await db.$queryRawUnsafe(`
        SELECT to_char(("updatedAt" AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS day
        FROM "CreatorTaskActivity"
        WHERE "creatorId" = $1 AND "updatedAt" >= $2
        GROUP BY 1
        ORDER BY 1 DESC
        LIMIT 30
      `, creatorId, cutoff);
      return (rows || []).map((row) => text(row.day, 10)).filter(Boolean);
    } catch {
      // Rolling deploy fallback below.
    }
  }
  let rows = [];
  try {
    rows = db?.creatorTaskActivity?.findMany
      ? await db.creatorTaskActivity.findMany({
          where: { creatorId, updatedAt: { gte: cutoff } },
          orderBy: [{ updatedAt: "desc" }],
          take: 5000,
          select: { updatedAt: true },
        })
      : [];
  } catch {
    rows = db?.jobInstance?.findMany
      ? await db.jobInstance.findMany({
          where: { creatorId, updatedAt: { gte: cutoff } },
          orderBy: [{ updatedAt: "desc" }],
          take: 5000,
          select: { updatedAt: true },
        })
      : [];
  }
  return [...new Set(rows.map((row) => iso(row.updatedAt)?.slice(0, 10)).filter(Boolean))].slice(0, 30);
}

async function readCreatorTaskActivity({ db = prisma, creatorId, now = new Date(), day = null, limit = 240 }) {
  const cutoff = new Date(now.getTime() - ACTIVITY_RETENTION_DAYS * DAY_MS);
  const take = Math.max(1, Math.min(5000, Number(limit) || 240));
  const where = { creatorId, updatedAt: { gte: cutoff } };
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(String(day))) {
    const start = new Date(`${day}T00:00:00.000Z`);
    const end = new Date(start.getTime() + DAY_MS);
    where.updatedAt = { gte: start, lt: end };
  }
  let rows = [];
  try {
    rows = await db.creatorTaskActivity.findMany({ where, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take });
  } catch (error) {
    // During a rolling deploy the app can briefly run before the new table is
    // migrated. Keep the Overview readable by deriving the same 30-day window
    // from JobInstance until migration finishes.
    if (!db?.jobInstance?.findMany) throw error;
    const jobs = await db.jobInstance.findMany({
      where: {
        creatorId,
        updatedAt: where.updatedAt,
        OR: [
          { status: { in: ["CLAIMED", "PAUSED", "DONE", "FAILED", "CANCELLED"] } },
          { status: "SCHEDULED", OR: [{ startedAt: { not: null } }, { claimedAt: { not: null } }] },
        ],
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take,
    });
    rows = jobs.map((job) => ({
      id: `job:${job.id}`,
      jobId: job.id,
      jobKey: job.jobKey,
      mode: text(object(job.params).analyticsSyncKind || object(job.params).financialMode || object(job.params).campaignMode || object(job.params).notificationMode, 80),
      stage: text(object(job.params).analyticsSyncStage, 80),
      status: job.status,
      detail: text(object(job.progress).message, 500),
      lastError: text(job.lastError, 2000),
      startedAt: job.startedAt || job.claimedAt,
      completedAt: job.completedAt,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    }));
  }
  return rows.map((row) => {
    const params = { analyticsSyncKind: row.mode, analyticsSyncStage: row.stage };
    const at = row.completedAt || row.updatedAt || row.startedAt || row.createdAt;
    return {
      id: row.id,
      jobId: row.jobId,
      jobKey: row.jobKey,
      label: jobLabel(row.jobKey, params),
      status: statusClass(row.status),
      rawStatus: row.status,
      mode: row.mode || null,
      stage: row.stage || null,
      detail: text(row.detail, 500),
      error: text(row.lastError, 2000),
      startedAt: iso(row.startedAt),
      completedAt: iso(row.completedAt),
      at: iso(at),
      day: iso(at)?.slice(0, 10) || null,
      durationMs: row.startedAt && row.completedAt
        ? Math.max(0, new Date(row.completedAt).getTime() - new Date(row.startedAt).getTime())
        : null,
    };
  });
}

function subscriptionSummary(groups) {
  const out = { newSubscribers: 0, paidStarts: 0, freeStarts: 0, unknownStarts: 0, renewals: 0, expired: 0, autoRenewDisabled: 0, refunded: 0 };
  for (const row of groups || []) {
    const type = String(row.eventType || "").toUpperCase();
    const count = int(row?._count?._all);
    if (type.startsWith("SUBSCRIBED_")) out.newSubscribers += count;
    if (type === "SUBSCRIBED_PAID") out.paidStarts += count;
    if (type === "SUBSCRIBED_FREE") out.freeStarts += count;
    if (type === "SUBSCRIBED_UNKNOWN") out.unknownStarts += count;
    if (type === "RENEWED") out.renewals += count;
    if (type === "EXPIRED") out.expired += count;
    if (type === "AUTO_RENEW_DISABLED") out.autoRenewDisabled += count;
    if (type === "REFUNDED") out.refunded += count;
  }
  return out;
}

function normalizeTransactionType(type) {
  const value = String(type || "other").trim().toLowerCase();
  if (value === "message" || value === "chat_message" || value === "chat_messages") return "messages";
  if (value === "tip" || value === "tips") return "tips";
  if (value.startsWith("subscription")) return "subscriptions";
  if (value === "post") return "posts";
  if (value === "stream" || value === "streams") return "streams";
  return "other";
}

function financeSummary(groups) {
  const types = new Map();
  let grossCents = 0;
  let netCents = 0;
  let transactions = 0;
  let refundGrossCents = 0;
  let refundNetCents = 0;
  let refundTransactions = 0;
  let payoutPendingNetCents = 0;
  let payoutPendingTransactions = 0;
  for (const row of groups || []) {
    const status = String(row.transactionStatus || "").trim().toLowerCase();
    const count = int(row?._count?._all);
    const gross = cents(row?._sum?.amountCents);
    const net = cents(row?._sum?.netCents);
    const key = normalizeTransactionType(row.transactionType);
    if (status === "undo") {
      refundGrossCents += gross;
      refundNetCents += net;
      refundTransactions += count;
      continue;
    }
    if (!types.has(key)) types.set(key, { key, grossCents: 0, netCents: 0, transactions: 0 });
    const bucket = types.get(key);
    grossCents += gross;
    netCents += net;
    transactions += count;
    bucket.grossCents += gross;
    bucket.netCents += net;
    bucket.transactions += count;
    if (status === "loading") {
      payoutPendingNetCents += net;
      payoutPendingTransactions += count;
    }
  }
  return {
    grossCents,
    netCents,
    transactions,
    refundGrossCents,
    refundNetCents,
    refundTransactions,
    payoutPendingNetCents,
    payoutPendingTransactions,
    types: [...types.values()].sort((a, b) => b.netCents - a.netCents || b.transactions - a.transactions),
  };
}

async function readCampaignPayingFanCount({ db, creatorId, start, end, fallback }) {
  if (typeof db?.$queryRawUnsafe !== "function") return fallback;
  const rows = await db.$queryRawUnsafe(`
    WITH attributed AS (
      SELECT event."fanId", membership."campaignId"
      FROM "CreatorFinancialTransaction" event
      JOIN LATERAL (
        SELECT link."campaignId"
        FROM "CreatorCampaignFan" link
        WHERE link."creatorId" = $1
          AND link."fanId" = event."fanId"
          AND link."attributedAt" IS NOT NULL
          AND link."attributedAt" <= event."occurredAt"
        ORDER BY link."attributedAt" DESC, link."id" DESC
        LIMIT 1
      ) membership ON TRUE
      WHERE event."creatorId" = $1
        AND event."fanId" IS NOT NULL
        AND event."occurredAt" >= $2::timestamptz
        AND event."occurredAt" <= $3::timestamptz
        AND LOWER(COALESCE(event."transactionStatus", '')) <> 'undo'
    )
    SELECT COUNT(DISTINCT "fanId")::bigint AS count FROM attributed
  `, creatorId, start, end);
  return int(rows?.[0]?.count ?? fallback);
}


async function readCampaignCurrentValues({ db, creatorId }) {
  if (typeof db?.$queryRawUnsafe !== "function") {
    return { byCampaign: new Map(), summary: { ofValueKnownFans: 0, ofValuePayingFans: 0, ofValueNetCents: 0, ofValueFetchedAt: null } };
  }
  const [rows, summaryRows] = await Promise.all([
    db.$queryRawUnsafe(`
      SELECT
        membership."campaignId",
        COUNT(value."id")::bigint AS "ofValueKnownFans",
        COUNT(*) FILTER (WHERE value."totalNetCents" > 0)::bigint AS "ofValuePayingFans",
        COALESCE(SUM(value."totalNetCents"), 0)::bigint AS "ofValueNetCents",
        MAX(value."fetchedAt") AS "ofValueFetchedAt"
      FROM "CreatorCampaignFan" membership
      LEFT JOIN "CreatorFanValueCurrent" value
        ON value."creatorId" = membership."creatorId" AND value."fanId" = membership."fanId"
      WHERE membership."creatorId" = $1
      GROUP BY membership."campaignId"
    `, creatorId),
    db.$queryRawUnsafe(`
      SELECT
        COUNT(value."id")::bigint AS "ofValueKnownFans",
        COUNT(*) FILTER (WHERE value."totalNetCents" > 0)::bigint AS "ofValuePayingFans",
        COALESCE(SUM(value."totalNetCents"), 0)::bigint AS "ofValueNetCents",
        MAX(value."fetchedAt") AS "ofValueFetchedAt"
      FROM "CreatorFanValueCurrent" value
      WHERE value."creatorId" = $1
        AND EXISTS (
          SELECT 1 FROM "CreatorCampaignFan" membership
          WHERE membership."creatorId" = $1 AND membership."fanId" = value."fanId"
        )
    `, creatorId),
  ]);
  return {
    byCampaign: new Map((rows || []).map((row) => [String(row.campaignId), {
      ofValueKnownFans: int(row.ofValueKnownFans),
      ofValuePayingFans: int(row.ofValuePayingFans),
      ofValueNetCents: cents(row.ofValueNetCents),
      ofValueFetchedAt: iso(row.ofValueFetchedAt),
    }])),
    summary: {
      ofValueKnownFans: int(summaryRows?.[0]?.ofValueKnownFans),
      ofValuePayingFans: int(summaryRows?.[0]?.ofValuePayingFans),
      ofValueNetCents: cents(summaryRows?.[0]?.ofValueNetCents),
      ofValueFetchedAt: iso(summaryRows?.[0]?.ofValueFetchedAt),
    },
  };
}

async function readCreatorOverview({ db = prisma, creatorId, rangeKey = "30d", now = new Date() }) {
  const range = OVERVIEW_RANGES.has(String(rangeKey)) ? String(rangeKey) : "30d";
  const ledger = await readCreatorLedgerOverview({ db, creatorId, rangeKey: range, now });
  const start = new Date(ledger.range.startAt);
  const end = new Date(ledger.range.endAt);
  const eventBetween = { gte: start, lte: end };

  const [creator, financialGroups, campaignFanGroups, campaignCurrent] = await Promise.all([
    db.creatorAccount.findUnique({ where: { id: creatorId }, select: { id: true, createdAt: true, updatedAt: true } }),
    db.creatorFinancialTransaction.groupBy({
      by: ["transactionType", "transactionStatus"],
      where: { creatorId, occurredAt: eventBetween },
      _count: { _all: true },
      _sum: { amountCents: true, netCents: true },
    }),
    db.creatorCampaignFan.groupBy({
      by: ["campaignId"],
      where: { creatorId, attributedAt: eventBetween },
      _count: { _all: true },
    }),
    readCampaignCurrentValues({ db, creatorId }),
  ]);

  const joinedByCampaign = new Map(campaignFanGroups.map((row) => [String(row.campaignId), int(row?._count?._all)]));
  const currentByCampaign = campaignCurrent.byCampaign;
  const campaigns = (ledger.campaigns || []).map((row) => {
    const current = currentByCampaign.get(String(row.id)) || {};
    return ({
    id: row.id,
    externalCampaignId: row.externalCampaignId,
    name: row.name,
    isActive: row.isActive === true,
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
    fansCount: int(row.fansCount),
    newFans: joinedByCampaign.get(String(row.id)) || 0,
    payingFans: int(row.payingFans),
    netCents: cents(row.netCents),
    grossCents: cents(row.grossCents),
    transactions: int(row.transactionsCount),
    messageNetCents: cents(row.salesRevenueCents),
    tipsNetCents: cents(row.tipsRevenueCents),
    subscriptionsNetCents: cents(row.subscriptionRevenueCents),
    unknownAttributionFans: int(row.unknownAttributionFans),
    ofValueKnownFans: int(current.ofValueKnownFans),
    ofValuePayingFans: int(current.ofValuePayingFans),
    ofValueNetCents: cents(current.ofValueNetCents),
    ofValueFetchedAt: iso(current.ofValueFetchedAt),
  });
  }).sort((a, b) => b.ofValueNetCents - a.ofValueNetCents || b.netCents - a.netCents || b.newFans - a.newFans || a.name.localeCompare(b.name));
  const campaignFallbackPayers = campaigns.reduce((sum, row) => sum + row.payingFans, 0);
  const payingFans = await readCampaignPayingFanCount({ db, creatorId, start, end, fallback: campaignFallbackPayers });

  const notificationBaselineAtRaw = ledger.notificationSync?.fullBackfillVerifiedAt || ledger.notificationSync?.fullBackfillCompletedAt || null;
  const notificationBaselineAt = notificationBaselineAtRaw ? new Date(notificationBaselineAtRaw) : null;
  const notificationBaselineComplete = Boolean(notificationBaselineAt);
  const oldestNotificationAt = ledger.notificationSync?.oldestOccurredAt ? new Date(ledger.notificationSync.oldestOccurredAt) : null;
  const oneYearStart = new Date(now.getTime() - 365 * DAY_MS);
  const accumulatedFromInitialHalfYear = notificationBaselineAt && notificationBaselineAt.getTime() <= now.getTime() - 185 * DAY_MS;
  const explicitOneYearSpan = oldestNotificationAt && oldestNotificationAt <= oneYearStart;
  const oneYearAvailable = Boolean(notificationBaselineComplete && (accumulatedFromInitialHalfYear || explicitOneYearSpan));

  const activity = subscriptionSummary(ledger.subscriptions);
  activity.likes = int(ledger.totals.likesCount);
  activity.comments = int(ledger.totals.commentsCount);

  const finance = financeSummary(financialGroups);
  const campaignTotals = {
    activeCampaigns: campaigns.filter((row) => row.isActive).length,
    campaigns: campaigns.length,
    fans: campaigns.reduce((sum, row) => sum + row.fansCount, 0),
    newFans: campaigns.reduce((sum, row) => sum + row.newFans, 0),
    payingFans,
    netCents: campaigns.reduce((sum, row) => sum + row.netCents, 0),
    grossCents: campaigns.reduce((sum, row) => sum + row.grossCents, 0),
    transactions: campaigns.reduce((sum, row) => sum + row.transactions, 0),
    unknownAttributionFans: campaigns.reduce((sum, row) => sum + row.unknownAttributionFans, 0),
    ofValueKnownFans: int(campaignCurrent.summary.ofValueKnownFans),
    ofValuePayingFans: int(campaignCurrent.summary.ofValuePayingFans),
    ofValueNetCents: cents(campaignCurrent.summary.ofValueNetCents),
    ofValueFetchedAt: iso(campaignCurrent.summary.ofValueFetchedAt),
  };

  return {
    ok: true,
    creatorId,
    range: ledger.range,
    ranges: [
      { key: "7d", label: "7D", enabled: true },
      { key: "30d", label: "30D", enabled: true },
      { key: "90d", label: "3M", enabled: true },
      { key: "180d", label: "6M", enabled: true },
      { key: "365d", label: "1Y", enabled: oneYearAvailable, reason: oneYearAvailable ? null : "Available after ONLINOD has accumulated a full year of activity coverage" },
    ],
    coverage: {
      notificationVerified: notificationBaselineComplete,
      earningsVerified: ledger.verification.officialEarnings,
      messagesVerified: ledger.verification.officialMessages,
      activityFromAt: iso(ledger.availability?.activityFromAt),
      activityToAt: iso(ledger.availability?.activityToAt),
      oneYearAvailable,
      creatorStoredSinceAt: iso(creator?.createdAt),
    },
    activity,
    finance,
    messagesServer: {
      incoming: int(ledger.totals.incomingMessages),
      outgoing: int(ledger.totals.outgoingMessages),
      dailyUniqueDialogsSum: int(ledger.totals.uniqueDialogs),
      days: int(ledger.totals.dialogDays),
    },
    campaigns: { totals: campaignTotals, rows: campaigns },
    daily: {
      metrics: (ledger.daily?.metrics || []).map((row) => ({
        date: row.date,
        likes: int(row.likes),
        comments: int(row.comments),
        newSubscribers: int(row.newSubscribers),
        renewals: int(row.renewals),
        incomingMessages: int(row.incomingMessages),
        outgoingMessages: int(row.outgoingMessages),
      })),
      earnings: (ledger.daily?.earnings || []).map((row) => ({ date: row.date, totalCents: cents(row.totalCents) })),
    },
  };
}

module.exports = {
  ACTIVITY_RETENTION_DAYS,
  readCreatorOverview,
  readCreatorCurrentTask,
  readCreatorTaskActivity,
  readCreatorTaskActivityDays,
  progressSnapshot,
  jobLabel,
};
