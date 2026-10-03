"use strict";
const { readWithAnalyticsViewer } = require("./analytics-viewer-read-service");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { CAMPAIGN_COVERAGE_SELECT, evaluateCampaignCollectionState } = require("./campaign-freshness-service");
const DAY = 86400000, UNKNOWN = "unattributed_paid_subscriptions";
const fault = (code, status = 400) => Object.assign(new Error(code), { code, status });
const day = at => at.toISOString().slice(0, 10);
const num = v => { const n = Number(v || 0); if (!Number.isSafeInteger(n)) throw fault("TRAFFIC_METRIC_INTEGER_OVERFLOW", 500); return n; };
const seed = () => ({ valueSnapshotMembers: 0, valuePendingMembers: 0, valuePayingFans: 0,
  fanValueCents: 0, valueMessagesCents: 0, valueTipsCents: 0, valueSubscribesCents: 0, valuePostsCents: 0, valueStreamsCents: 0 });
function rangeWindow(key = "all", now = new Date()) {
  key = String(key || "all").toLowerCase();
  if (key === "all") return { key, startAt: null, endAt: null, calendar: "UTC" };
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let start, end = new Date(today.getTime() + DAY);
  if (key === "24h") start = today;
  else if (["7d", "30d", "90d", "180d", "365d"].includes(key)) start = new Date(end.getTime() - Number(key.slice(0, -1)) * DAY);
  else if (key === "ytd") start = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
  else if (key === "prev_year") { start = new Date(Date.UTC(today.getUTCFullYear() - 1, 0, 1)); end = new Date(Date.UTC(today.getUTCFullYear(), 0, 1)); }
  else throw fault("TRAFFIC_RANGE_INVALID");
  return { key, startAt: start.toISOString(), endAt: end.toISOString(), calendar: "UTC" };
}
function page(input) {
  const take = Number(input.limit ?? 100), offset = Number(input.offset ?? 0);
  if (!Number.isInteger(take) || take < 1 || take > 500 || !Number.isInteger(offset) || offset < 0 || offset > 10000) throw fault("TRAFFIC_PAGINATION_INVALID");
  const after = String(input.after || "");
  if (after.length > 220 || (after && offset)) throw fault("TRAFFIC_CURSOR_INVALID");
  return { take, offset, after };
}
function metricNumbers(metrics) { return Object.fromEntries(Object.entries(metrics || {}).map(([key, value]) => [key, num(value)])); }
async function lifetime(db, scope, kind, ids) {
  if (!ids.length) return new Map();
  const rows = await db.trafficMetric.findMany({ where: { agencyId: scope.agencyId, creatorId: scope.id, kind, objectId: { in: ids }, period: "*" } });
  return new Map(rows.map(r => [r.objectId, metricNumbers(r.metrics)]));
}
async function revenue(db, scope, kind, ids, range) {
  if (!ids.length) return new Map();
  if (range.key === "all") return lifetime(db, scope, kind, ids);
  const rows = await db.$queryRawUnsafe(`SELECT "objectId",COALESCE(SUM(("metrics"->>'revenueCents')::numeric),0)::text AS revenue,
    COALESCE(SUM(("metrics"->>'paidSubscriptions')::numeric),0)::text AS count FROM "TrafficMetric"
    WHERE "agencyId"=$1 AND "creatorId"=$2 AND "kind"=$3 AND "objectId"=ANY($4::text[])
      AND "period">=$5 AND "period"<$6 GROUP BY "objectId"`, scope.agencyId, scope.id, kind, ids, range.startAt.slice(0, 10), range.endAt.slice(0, 10));
  return new Map(rows.map(r => [r.objectId, { revenueCents: num(r.revenue), paidSubscriptions: num(r.count) }]));
}
async function freshness(db, creator, now) {
  const state = await db.trafficProjectionBackfill.findUnique({ where: { creatorId: creator.id } });
  const pending = await db.domainWorkItem.findFirst({ where: { agencyId: creator.agencyId, creatorId: creator.id,
    workClass: { in: ["TRAFFIC_FACT", "TRAFFIC_FAN", "TRAFFIC_BACKFILL"] }, isOutstanding: true }, select: { id: true, state: true, lastError: true } });
  const coverage = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: creator.id }, select: {
    ...CAMPAIGN_COVERAGE_SELECT, membershipCoverageCompletedAt: true,
  } });
  return { providerCoverage: coverage, ready: Boolean(state?.completedAt) && !pending, rebuilding: !state?.completedAt,
    providerFreshness: evaluateCampaignCollectionState(coverage, now),
    pending: Boolean(pending), failure: pending?.state === "RECONCILE_REQUIRED" ? pending.lastError : null,
    providerAuthority: "CAMPAIGNS", valueAuthority: "FAN_DATA_CURRENT", projectionVersion: 3 };
}
async function readSnapshot(db, input, reader) {
  return readWithAnalyticsViewer({ ...input, db, permission: "traffic.view" }, async ({ db: tx, creator }) => {
    const now = await dbAuthorityNow({ db: tx });
    const result = await reader(tx, creator, rangeWindow(input.rangeKey, now));
    return { ok: true, contractVersion: 2, creatorId: creator.id, asOf: now.toISOString(), ...result,
      projection: await freshness(tx, creator, now) };
  });
}
function rowFor(source, value = {}, rev = {}) {
  const cost = num(source.costCents), money = num(rev.revenueCents);
  return { ...source, bucket: "tracked_source", sourceLabel: source.sourceType === "of_campaign" ? "OF campaign / trial" : source.sourceType,
    claimers: num(value.sourceMembers), ...seed(), ...value, paidSubscriptions: num(rev.paidSubscriptions), revenueCents: money,
    roiPercent: cost ? (money - cost) / cost * 100 : null,
    valueRoiPercent: cost ? (num(value.fanValueCents) - cost) / cost * 100 : null };
}

async function getTrafficOverview(input) {
  const { take, offset, after } = page(input);
  return readSnapshot(input.db, input, async (db, creator, range) => {
    const sources = await db.trafficSource.findMany({ where: { agencyId: creator.agencyId, creatorId: creator.id, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: "asc" }, take: take + 1, skip: offset });
    const visible = sources.slice(0, take), ids = ["", ...visible.map(s => s.id)];
    const values = await lifetime(db, creator, "source", ids), receipts = await revenue(db, creator, "source", ids, range);
    const total = (await lifetime(db, creator, "total", [""])).get("") || {}, totalRevenue = (await revenue(db, creator, "total", [""], range)).get("") || {};
    const typeRows = await db.trafficMetric.findMany({ where: { agencyId: creator.agencyId, creatorId: creator.id, kind: "type", period: "*" }, orderBy: { objectId: "asc" }, take: 65 });
    const types = typeRows.slice(0, 64), typeRevenue = await revenue(db, creator, "type", types.map(r => r.objectId), range);
    const unknown = receipts.get("") || {};
    const rows = visible.map(s => rowFor(s, values.get(s.id), receipts.get(s.id)));
    const unknownSource = { id: UNKNOWN, sourceType: "paid_unknown", externalId: "unattributed", name: "Paid subscriptions · unknown source", costCents: 0, isUnattributed: true };
    const unattributed = rowFor(unknownSource, {}, unknown);
    if (!after && !offset && num(unknown.paidSubscriptions)) rows.unshift(unattributed);
    const lastTrafficJob = await db.jobInstance.findFirst({ where: { agencyId: creator.agencyId, creatorId: creator.id, jobKey: "fetch_campaigns" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, status: true, attempts: true, createdAt: true, completedAt: true, lastError: true, progress: true } });
    return { range, totals: { ...seed(), ...total, subscriptionRevenueCents: num(totalRevenue.revenueCents),
      paidSubscriptions: num(totalRevenue.paidSubscriptions), sources: num(total.sources), sourceMembers: num(total.sourceMembers),
      unattributedRevenueCents: num(unknown.revenueCents), unattributedPaidSubscriptions: num(unknown.paidSubscriptions),
      trackedRevenueCents: num(totalRevenue.revenueCents) - num(unknown.revenueCents),
      trackedPaidSubscriptions: num(totalRevenue.paidSubscriptions) - num(unknown.paidSubscriptions) },
    sources: rows, unattributed, buckets: types.map(r => ({ key: r.objectId, label: r.objectId, ...metricNumbers(r.metrics), claimers: num(r.metrics.sourceMembers),
      revenueCents: num(typeRevenue.get(r.objectId)?.revenueCents), paidSubscriptions: num(typeRevenue.get(r.objectId)?.paidSubscriptions) })),
    bucketsTruncated: typeRows.length > 64, lastTrafficJob,
    pagination: { limit: take, offset, hasMore: sources.length > take, nextCursor: sources.length > take ? visible.at(-1).id : null, total: num(total.sources) } };
  });
}

async function getTrafficSourceMembers(input) {
  const { take, offset, after } = page(input), unknown = input.sourceId === UNKNOWN;
  return readSnapshot(input.db, input, async (db, creator, range) => {
    const source = unknown ? { id: UNKNOWN, sourceType: "paid_unknown", name: "Paid subscriptions · unknown source" }
      : await db.trafficSource.findFirst({ where: { id: input.sourceId, agencyId: creator.agencyId, creatorId: creator.id } });
    if (!source) throw fault("TRAFFIC_SOURCE_NOT_FOUND", 404);
    const key = unknown ? "" : source.id;
    const rows = unknown
      ? (await db.trafficMetric.findMany({ where: { agencyId: creator.agencyId, creatorId: creator.id, kind: "receiptFan:", period: "*", ...(after ? { objectId: { gt: after } } : {}) }, orderBy: { objectId: "asc" }, take: take + 1, skip: offset })).map(r => ({ fanId: r.objectId }))
      : await db.$queryRawUnsafe(`SELECT * FROM "TrafficSourceMember" WHERE "agencyId"=$1 AND "creatorId"=$2 AND "sourceId"=$3 AND "fanId">$4
        ${input.onlyPaying === true ? 'AND ("projectionMetrics"->>\'valuePayingFans\')=\'1\'' : ""} ORDER BY "fanId" LIMIT $5 OFFSET $6`, creator.agencyId, creator.id, key, after, take + 1, offset);
    const visible = rows.slice(0, take), fanIds = visible.map(r => r.fanId);
    const fans = await db.creatorFan.findMany({ where: { agencyId: creator.agencyId, creatorId: creator.id, onlyFansUserId: { in: fanIds } },
      select: { id: true, onlyFansUserId: true, username: true, displayName: true, avatarUrl: true } });
    const identities = new Map(fans.map(f => [f.onlyFansUserId, f]));
    const vals = await db.creatorFanValueCurrent.findMany({ where: { agencyId: creator.agencyId, creatorId: creator.id, fanRecordId: { in: fans.map(f => f.id) } } });
    const valueMap = new Map(vals.map(v => [v.fanRecordId, v]));
    const paid = await revenue(db, creator, "receiptFan:" + key, fanIds, range);
    const value = (await lifetime(db, creator, "source", [key])).get(key) || {};
    const members = visible.map(row => {
      const fan = identities.get(row.fanId), val = valueMap.get(fan?.id), available = val?.availability === "AVAILABLE";
      const username = fan?.username || row.metadata?.fanUsername || null, name = fan?.displayName || row.metadata?.fanName || null;
      return { fanId: row.fanId, fanUsername: username, fanName: name, avatarUrl: fan?.avatarUrl || row.metadata?.fanAvatar || null,
        displayName: username ? `@${username}` : name || row.fanId, valueAvailability: val?.availability || "NOT_FETCHED",
        totalSummCents: available ? num(val.platformReportedTotalSpendCents) : null,
        messagesSummCents: available ? num(val.messagesSpentCents) : null, tipsSummCents: available ? num(val.tipsSpentCents) : null,
        subscribesSummCents: available ? num(val.subscriptionsSpentCents) : null, postsSummCents: available ? num(val.postsSpentCents) : null,
        streamsSummCents: available ? num(val.streamsSpentCents) : null, fetchedAt: val?.valueObservedAt || null,
        lastValueFetchedAt: val?.valueObservedAt || null, pendingValue: !available || num(row.projectionMetrics?.valuePendingMembers) > 0,
        firstSeenAt: row.firstSeenAt || null, lastSeenAt: row.lastSeenAt || null, claimedAt: row.claimedAt || null, convertedAt: row.convertedAt || null,
        ledgerSubscriptions: num(paid.get(row.fanId)?.paidSubscriptions), ledgerRevenueCents: num(paid.get(row.fanId)?.revenueCents) };
    });
    return { source, range, totals: { members: num(unknown ? value.paidFans : value.sourceMembers), fetched: num(value.valueSnapshotMembers), pending: num(value.valuePendingMembers),
      buyers: num(unknown ? value.paidFans : value.valuePayingFans), fanValueCents: num(value.fanValueCents), messagesSummCents: num(value.valueMessagesCents),
      tipsSummCents: num(value.valueTipsCents), subscribesSummCents: num(value.valueSubscribesCents), postsSummCents: num(value.valuePostsCents), streamsSummCents: num(value.valueStreamsCents) },
    members, pagination: { limit: take, offset, returned: members.length, hasMore: rows.length > take, nextCursor: rows.length > take ? visible.at(-1).fanId : null } };
  });
}

module.exports = { getTrafficOverview, getTrafficSourceMembers, rangeWindow };
