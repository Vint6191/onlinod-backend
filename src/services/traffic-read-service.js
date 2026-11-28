"use strict";
const { readCampaignRefreshDebt } = require("./campaign-refresh-debt-service");
const { readWithAnalyticsViewer } = require("./analytics-viewer-read-service");
const { valueFieldState } = require("./fan-value-field-authority");
const { dbAuthorityNow } = require("./db-time-authority-service");
const { CAMPAIGN_COVERAGE_SELECT, evaluateCampaignCollectionState, coverageDto } = require("./campaign-freshness-service");
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
async function unsupportedRevenueIds(db, scope, kind, ids, range) {
  const params = [scope.agencyId, scope.id, ids];
  let object = "''::text", join = "", scopeClause = "";
  if (kind === "source") object = `COALESCE(r."sourceId",'')`;
  else if (kind === "type") { object = `s."sourceType"`; join = `JOIN "TrafficSource" s ON s.id=r."sourceId" AND s."creatorId"=r."creatorId" AND s."agencyId"=r."agencyId"`; }
  else if (kind.startsWith("receiptFan:")) {
    object = `r."fanId"`; params.push(kind.slice("receiptFan:".length));
    scopeClause = `AND COALESCE(r."sourceId",'')=$${params.length}`;
  }
  let window = "";
  if (range.key !== "all") {
    params.push(new Date(range.startAt), new Date(range.endAt));
    window = `AND r."occurredAt">=$${params.length - 1} AND r."occurredAt"<$${params.length}`;
  }
  const rows = await db.$queryRawUnsafe(`/* traffic-unsupported-subscription-currency */
    SELECT DISTINCT ${object} AS "objectId" FROM "CreatorSubscriptionLedger" r ${join}
    WHERE r."agencyId"=$1 AND r."creatorId"=$2 AND r.currency IS DISTINCT FROM 'USD'
      AND ${object}=ANY($3::text[]) ${scopeClause} ${window}`, ...params);
  return new Set(rows.map(row => row.objectId));
}
async function revenue(db, scope, kind, ids, range) {
  if (!ids.length) return new Map();
  let values;
  if (range.key === "all") values = await lifetime(db, scope, kind, ids);
  else {
    const rows = await db.$queryRawUnsafe(`SELECT "objectId",COALESCE(SUM(("metrics"->>'revenueCents')::numeric),0)::text AS revenue,
      COALESCE(SUM(("metrics"->>'paidSubscriptions')::numeric),0)::text AS count FROM "TrafficMetric"
      WHERE "agencyId"=$1 AND "creatorId"=$2 AND "kind"=$3 AND "objectId"=ANY($4::text[])
        AND "period">=$5 AND "period"<$6 GROUP BY "objectId"`, scope.agencyId, scope.id, kind, ids, range.startAt.slice(0, 10), range.endAt.slice(0, 10));
    values = new Map(rows.map(r => [r.objectId, { revenueCents: num(r.revenue), paidSubscriptions: num(r.count) }]));
  }
  const unsupported = await unsupportedRevenueIds(db, scope, kind, ids, range);
  for (const id of unsupported) values.set(id, { ...values.get(id), revenueCents: null, revenueUnavailableReason: "UNSUPPORTED_CURRENCY" });
  return values;
}
async function costCurrencies(db, scope, types) {
  // Unsupported historical costs are evidence of an unavailable USD total,
  // including a lone foreign source. No currency grouping or FX is exposed.
  const [total, groups] = await Promise.all([
    db.$queryRawUnsafe(`/* traffic-cost-currencies:total */ SELECT EXISTS(
      SELECT 1 FROM "TrafficSource" WHERE "agencyId"=$1 AND "creatorId"=$2 AND currency IS DISTINCT FROM 'USD'
    ) AS unsupported`, scope.agencyId, scope.id),
    types.length ? db.$queryRawUnsafe(`/* traffic-cost-currencies:types */
      SELECT kinds.kind,EXISTS(SELECT 1 FROM "TrafficSource" WHERE "agencyId"=$1 AND "creatorId"=$2
        AND "sourceType"=kinds.kind AND currency IS DISTINCT FROM 'USD') AS unsupported
      FROM unnest($3::text[]) AS kinds(kind)`, scope.agencyId, scope.id, types) : [],
  ]);
  return { total: total[0], types: new Map(groups.map(row => [row.kind, row])) };
}
function costDto(metrics, currencies) {
  const costUnavailableReason = currencies?.unsupported === true ? "UNSUPPORTED_CURRENCY" : null;
  return { costCents: costUnavailableReason ? null : num(metrics?.costCents),
    costCurrency: costUnavailableReason ? null : "USD", costUnavailableReason };
}
function revenueAmount(value) { return value?.revenueCents === null ? null : num(value?.revenueCents); }

async function freshness(db, creator, now) {
  const state = await db.trafficProjectionBackfill.findUnique({ where: { creatorId: creator.id } });
  const pending = await db.domainWorkItem.findFirst({ where: { agencyId: creator.agencyId, creatorId: creator.id,
    workClass: { in: ["TRAFFIC_FACT", "TRAFFIC_FAN", "TRAFFIC_BACKFILL"] }, isOutstanding: true }, select: { id: true, state: true, lastError: true } });
  const coverage = await db.creatorCampaignCollectionState.findUnique({ where: { creatorId: creator.id }, select: {
    ...CAMPAIGN_COVERAGE_SELECT, membershipCoverageCompletedAt: true,
  } });
  return { providerCoverage: coverage ? coverageDto(coverage) : null,
    available: Boolean(state?.completedAt), ready: Boolean(state?.completedAt) && !pending, rebuilding: !state?.completedAt,
    updatedAt: state?.updatedAt?.toISOString() || null,
    providerFreshness: evaluateCampaignCollectionState(coverage, now, await readCampaignRefreshDebt({ db, creatorId: creator.id })),
    pending: Boolean(pending), failure: pending?.state === "RECONCILE_REQUIRED" ? pending.lastError : null,
    providerAuthority: "CAMPAIGNS", valueAuthority: "FAN_DATA_CURRENT", projectionVersion: 3 };
}
async function readSnapshot(db, input, reader) {
  return readWithAnalyticsViewer({ ...input, db, permission: "traffic.view" }, async ({ db: tx, creator }) => {
    const now = await dbAuthorityNow({ db: tx });
    const result = await reader(tx, creator, rangeWindow(input.rangeKey, now), now);
    return { ok: true, contractVersion: 2, creatorId: creator.id, asOf: now.toISOString(), ...result,
      projection: await freshness(tx, creator, now) };
  });
}
function rowFor(source, value = {}, rev = {}) {
  const supported = source.currency === "USD", cost = supported ? num(source.costCents) : null, money = revenueAmount(rev);
  const costUnavailableReason = supported ? null : "UNSUPPORTED_CURRENCY";
  const roiUnavailableReason = costUnavailableReason || rev.revenueUnavailableReason || (cost <= 0 ? "NO_COST" : null);
  const comparableCost = roiUnavailableReason === null;
  return { ...source, currency: supported ? "USD" : null, costCents: cost, costUnavailableReason,
    bucket: "tracked_source", sourceLabel: source.sourceType === "of_campaign" ? "OF campaign / trial" : source.sourceType,
    claimers: num(value.sourceMembers), ...seed(), ...value, paidSubscriptions: num(rev.paidSubscriptions), revenueCents: money,
    revenueUnavailableReason: rev.revenueUnavailableReason || null, costCurrency: supported ? "USD" : null, roiUnavailableReason,
    roiPercent: comparableCost ? (money - cost) / cost * 100 : null,
    valueRoiPercent: supported && cost > 0 ? (num(value.fanValueCents) - cost) / cost * 100 : null };
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
    const types = typeRows.slice(0, 64);
    const [typeRevenue, currencies] = await Promise.all([
      revenue(db, creator, "type", types.map(r => r.objectId), range), costCurrencies(db, creator, types.map(r => r.objectId)),
    ]);
    const unknown = receipts.get("") || {};
    const rows = visible.map(s => rowFor(s, values.get(s.id), receipts.get(s.id)));
    const unknownSource = { id: UNKNOWN, sourceType: "paid_unknown", externalId: "unattributed", name: "Paid subscriptions · unknown source", costCents: 0, currency: "USD", isUnattributed: true };
    const unattributed = rowFor(unknownSource, {}, unknown);
    if (!after && !offset && num(unknown.paidSubscriptions)) rows.unshift(unattributed);
    const lastTrafficJob = await db.jobInstance.findFirst({ where: { agencyId: creator.agencyId, creatorId: creator.id, jobKey: "fetch_campaigns" },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, status: true, attempts: true, createdAt: true, completedAt: true, lastError: true, progress: true } });
    return { range, totals: { ...seed(), ...total, ...costDto(total, currencies.total), subscriptionRevenueCents: revenueAmount(totalRevenue),
      revenueUnavailableReason: totalRevenue.revenueUnavailableReason || null,
      paidSubscriptions: num(totalRevenue.paidSubscriptions), sources: num(total.sources), sourceMembers: num(total.sourceMembers),
      unattributedRevenueCents: revenueAmount(unknown), unattributedPaidSubscriptions: num(unknown.paidSubscriptions),
      trackedRevenueCents: revenueAmount(totalRevenue) === null || revenueAmount(unknown) === null ? null : revenueAmount(totalRevenue) - revenueAmount(unknown),
      trackedPaidSubscriptions: num(totalRevenue.paidSubscriptions) - num(unknown.paidSubscriptions) },
    sources: rows, unattributed, buckets: types.map(r => ({ key: r.objectId, label: r.objectId, ...metricNumbers(r.metrics), ...costDto(r.metrics, currencies.types.get(r.objectId)), claimers: num(r.metrics.sourceMembers),
      revenueCents: revenueAmount(typeRevenue.get(r.objectId)), revenueUnavailableReason: typeRevenue.get(r.objectId)?.revenueUnavailableReason || null, paidSubscriptions: num(typeRevenue.get(r.objectId)?.paidSubscriptions) })),
    bucketsTruncated: typeRows.length > 64, lastTrafficJob,
    pagination: { limit: take, offset, hasMore: sources.length > take, nextCursor: sources.length > take ? visible.at(-1).id : null, total: num(total.sources) } };
  });
}

async function getTrafficSourceMembers(input) {
  const { take, offset, after } = page(input), unknown = input.sourceId === UNKNOWN;
  return readSnapshot(input.db, input, async (db, creator, range, now) => {
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
      const fan = identities.get(row.fanId), val = valueMap.get(fan?.id), fieldState = valueFieldState(val, now), available = fieldState.known;
      const money = field => fieldState.fields[field].known && val?.[field] != null ? num(val[field]) : null;
      const username = fan?.username || row.metadata?.fanUsername || null, name = fan?.displayName || row.metadata?.fanName || null;
      return { fanId: row.fanId, fanUsername: username, fanName: name, avatarUrl: fan?.avatarUrl || row.metadata?.fanAvatar || null,
        displayName: username ? `@${username}` : name || row.fanId, valueAvailability: val?.availability || "NOT_FETCHED",
        totalSummCents: available ? money("platformReportedTotalSpendCents") : null,
        valueKnown: available, valueFresh: fieldState.available,
        messagesSummCents: money("messagesSpentCents"), tipsSummCents: money("tipsSpentCents"),
        subscribesSummCents: money("subscriptionsSpentCents"), postsSummCents: money("postsSpentCents"),
        streamsSummCents: money("streamsSpentCents"), fetchedAt: fieldState.fields.platformReportedTotalSpendCents.observedAt,
        fieldAuthority: fieldState.authority, fieldFreshness: fieldState.fields,
        lastValueFetchedAt: fieldState.fields.platformReportedTotalSpendCents.observedAt, pendingValue: !available || num(row.projectionMetrics?.valuePendingMembers) > 0,
        firstSeenAt: row.firstSeenAt || null, lastSeenAt: row.lastSeenAt || null, claimedAt: row.claimedAt || null, convertedAt: row.convertedAt || null,
        ledgerSubscriptions: num(paid.get(row.fanId)?.paidSubscriptions), ledgerRevenueCents: revenueAmount(paid.get(row.fanId)), revenueUnavailableReason: paid.get(row.fanId)?.revenueUnavailableReason || null };
    });
    const componentTotals = Object.fromEntries([['messages','Messages'],['tips','Tips'],['subscribes','Subscribes'],['posts','Posts'],['streams','Streams']].flatMap(([name,metric]) => {
      const known = num(value[`value${metric}Cents`]);
      const members = num(value.sourceMembers);
      const proved = members === 0 || (num(value.valueComponentsMembers) === members && num(value[`value${metric}UnknownMembers`]) === 0);
      return [[`${name}SummCents`,proved ? known : null],[`known${metric}SummCents`,known],[`${name}UnknownMembers`,num(value[`value${metric}UnknownMembers`])]];
    }));
    return { source: unknown ? source : { ...source, currency: source.currency === "USD" ? "USD" : null,
      costCents: source.currency === "USD" ? num(source.costCents) : null, costUnavailableReason: source.currency === "USD" ? null : "UNSUPPORTED_CURRENCY" }, range, totals: { members: num(unknown ? value.paidFans : value.sourceMembers), fetched: num(value.valueSnapshotMembers), pending: num(value.valuePendingMembers),
      buyers: num(unknown ? value.paidFans : value.valuePayingFans), fanValueCents: num(value.fanValueCents), ...componentTotals },
    members, pagination: { limit: take, offset, returned: members.length, hasMore: rows.length > take, nextCursor: rows.length > take ? visible.at(-1).fanId : null } };
  });
}

module.exports = { getTrafficOverview, getTrafficSourceMembers, rangeWindow };
