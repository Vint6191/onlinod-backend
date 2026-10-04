"use strict";

const { performance } = require("node:perf_hooks");
const work = require("./domain-work-authority-service");
const { runRootCommit } = require("./db-commit-kernel");
const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");
const { pauseDeletedAgencyProjection } = require("./analytics-projection-lifecycle-service");

const WORK_CLASS = "ANALYTICS_FACT_PUBLICATION";
const ADOPTION_CLASS = "ANALYTICS_FACT_ADOPTION";
const ADOPTION_KEY = "analytics_publication_adoption_v1";
const PAGE = 100;
const TABLES = ["CreatorSale", "CreatorTip", "CreatorSubscriptionEvent", "CreatorPaidSubscription",
  "CreatorPostLike", "CreatorPostComment", "CreatorFinancialTransaction", "CreatorMessagesDaily"];
const MODELS = TABLES.map(value => value[0].toLowerCase() + value.slice(1));
function fault(code) { return Object.assign(new Error(code), { code }); }
function owned(result) { if (!result || result.lost) throw fault("ANALYTICS_FACT_CLAIM_LOST"); return result; }
function number(value) {
  const parsed = Number(value || 0);
  if (!Number.isSafeInteger(parsed)) throw fault("ANALYTICS_FACT_AMOUNT_OVERFLOW");
  return parsed;
}
function add(values, key, amount) {
  const next = number(values[key]) + number(amount);
  if (!Number.isSafeInteger(next)) throw fault("ANALYTICS_FACT_AMOUNT_OVERFLOW");
  if (next) values[key] = next; else delete values[key];
}
function financialType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (["message", "chat_message", "chat_messages"].includes(type)) return "message";
  if (["tip", "tips"].includes(type)) return "tip";
  if (type.startsWith("subscription")) return "subscription";
  if (type === "post") return "post";
  if (["stream", "streams"].includes(type)) return "stream";
  return "other";
}

// Fixed-size dimension vocabulary; unknown provider types cannot grow a day
// JSON object with arbitrarily many keys. Monetary sums retain their sign.
function contribution(kind, row) {
  if (!row || (kind === "CreatorMessagesDaily" && row.sourceTimezone !== "UTC")) return null;
  const time = row.purchasedAt || row.tippedAt || row.occurredAt || row.paidAt || row.likedAt || row.commentedAt || row.date;
  const utc = typeof time === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?$/.test(time) ? time + "Z" : time;
  const date = new Date(utc);
  if (!Number.isFinite(+date)) throw fault("ANALYTICS_FACT_DATE_INVALID");
  const values = {}, members = [];
  const set = (key, value = 1) => add(values, key, value);
  if (kind === "CreatorSale") {
    set("salesCount"); set("salesCents", row.amountCents); set("totalObservedRevenueCents", row.amountCents);
    if (row.saleType === "MESSAGE") set("messageSales");
    if (row.saleType === "POST") set("postSales");
    if (row.fanId) members.push(["uniqueBuyers", row.fanId]);
  } else if (kind === "CreatorTip") {
    set("tipsCount"); set("tipsCents", row.amountCents); set("totalObservedRevenueCents", row.amountCents);
  } else if (kind === "CreatorPaidSubscription") {
    set("paidSubscriptions"); set("paidSubscriptionsCents", row.amountCents); set("totalObservedRevenueCents", row.amountCents);
  } else if (kind === "CreatorPostLike" || kind === "CreatorPostComment") {
    const like = kind === "CreatorPostLike";
    set(like ? "likes" : "comments");
    if (row.fanId) members.push([like ? "uniqueLikingFans" : "uniqueCommentingFans", row.fanId]);
  } else if (kind === "CreatorSubscriptionEvent") {
    const type = String(row.eventType);
    const types = ["SUBSCRIBED_FREE", "SUBSCRIBED_PAID", "SUBSCRIBED_UNKNOWN", "RENEWED", "RESUBSCRIBED", "EXPIRED", "AUTO_RENEW_DISABLED", "AUTO_RENEW_ENABLED", "REFUNDED"];
    if (!types.includes(type)) throw fault("ANALYTICS_SUBSCRIPTION_TYPE_INVALID");
    set(`subscription:${type}:count`); set(`subscription:${type}:amount`, row.observedPriceCents);
    if (type.startsWith("SUBSCRIBED_")) set("newSubscribers");
    if (type === "RENEWED") set("renewals");
    if (type === "EXPIRED") set("expiredSubscribers");
    if (type === "AUTO_RENEW_DISABLED") set("autoRenewDisabled");
  } else if (kind === "CreatorFinancialTransaction") {
    const status = ["undo", "loading"].includes(String(row.transactionStatus).trim().toLowerCase()) ? String(row.transactionStatus).trim().toLowerCase() : "settled";
    const prefix = `financial:${financialType(row.transactionType)}:${status}:`;
    set(prefix + "count"); set(prefix + "amount", row.amountCents); set(prefix + "net", row.netCents);
  } else if (kind === "CreatorMessagesDaily") {
    for (const key of ["incomingMessages", "outgoingMessages", "uniqueDialogs"]) set(key, row[key]);
  } else throw fault("ANALYTICS_FACT_KIND_INVALID");
  return { day: date.toISOString().slice(0, 10), values, members };
}

function deltas(rows) {
  const days = new Map(), members = new Map();
  for (const row of rows) for (const [value, sign] of [[row.publishedValue, -1], [row.currentValue, 1]]) {
    const part = contribution(row.kind, value);
    if (!part) continue;
    const day = days.get(part.day) || {};
    for (const [key, amount] of Object.entries(part.values)) add(day, key, sign * amount);
    days.set(part.day, day);
    for (const [metric, memberId] of part.members) {
      const key = JSON.stringify([part.day, metric, memberId]);
      const current = members.get(key) || { day: part.day, metric, memberId, refs: 0 };
      current.refs += sign; members.set(key, current);
    }
  }
  return { days, members: [...members.values()].filter(row => row.refs) };
}

async function applyDeltas(db, item, rows) {
  const delta = deltas(rows);
  await db.$executeRawUnsafe("SELECT set_config('onlinod.analytics_publication_writer','1',true)");
  // One valid DomainWork owner per creator, with claim fence checked in this
  // transaction. Member reference counts make distinct-fan corrections exact.
  const members = delta.members.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const previousMembers = members.length ? await db.$queryRawUnsafe(`SELECT m.* FROM "CreatorAnalyticsDayMember" m
    JOIN jsonb_to_recordset($2::jsonb) r(day date,metric text,"memberId" text)
      ON m.date=r.day AND m.metric=r.metric AND m."memberId"=r."memberId" WHERE m."creatorId"=$1`, item.creatorId, JSON.stringify(members)) : [];
  const key = row => JSON.stringify([row.day || row.date.toISOString().slice(0, 10), row.metric, row.memberId]);
  const priorMembers = new Map(previousMembers.map(row => [key(row), row.refs]));
  const writes = members.map(member => {
    const previous = priorMembers.get(key(member)) || 0, refs = number(previous) + member.refs;
    if (refs < 0 || refs > 2147483647) throw fault("ANALYTICS_MEMBER_COUNT_INVALID");
    if (!previous || !refs) add(delta.days.get(member.day), member.metric, refs ? 1 : -1);
    return { ...member, refs };
  });
  if (writes.length) {
    await db.$executeRawUnsafe(`DELETE FROM "CreatorAnalyticsDayMember" m USING jsonb_to_recordset($2::jsonb) r(day date,metric text,"memberId" text,refs int)
      WHERE m."creatorId"=$1 AND m.date=r.day AND m.metric=r.metric AND m."memberId"=r."memberId" AND r.refs=0`, item.creatorId, JSON.stringify(writes));
    await db.$executeRawUnsafe(`INSERT INTO "CreatorAnalyticsDayMember"("agencyId","creatorId",date,metric,"memberId",refs)
      SELECT $1,$2,r.day,r.metric,r."memberId",r.refs FROM jsonb_to_recordset($3::jsonb) r(day date,metric text,"memberId" text,refs int) WHERE r.refs>0
      ON CONFLICT("creatorId",date,metric,"memberId") DO UPDATE SET refs=EXCLUDED.refs`, item.agencyId, item.creatorId, JSON.stringify(writes));
  }
  const dates = [...delta.days.keys()].sort();
  const previous = dates.length ? await db.creatorAnalyticsDay.findMany({ where: { creatorId: item.creatorId, agencyId: item.agencyId, date: { in: dates.map(day => new Date(day)) } } }) : [];
  const byDay = new Map(previous.map(row => [row.date.toISOString().slice(0, 10), row.values]));
  const updates = dates.map(day => {
    const values = { ...(byDay.get(day) || {}) };
    for (const [key, amount] of Object.entries(delta.days.get(day))) add(values, key, amount);
    return { date: day, values };
  });
  if (updates.length) await db.$executeRawUnsafe(`INSERT INTO "CreatorAnalyticsDay"("agencyId","creatorId","date","values","updatedAt")
    SELECT $1,$2,r.date,r.values,clock_timestamp() FROM jsonb_to_recordset($3::jsonb) r(date date,values jsonb)
    ON CONFLICT("creatorId","date") DO UPDATE SET "values"=EXCLUDED."values","updatedAt"=EXCLUDED."updatedAt"`, item.agencyId, item.creatorId, JSON.stringify(updates));
  if (rows.length) await db.$executeRawUnsafe(`UPDATE "CreatorAnalyticsFactPublication" f SET "publishedValue"=f."currentValue","dirty"=FALSE
    FROM jsonb_to_recordset($3::jsonb) r(kind text,"factId" text)
    WHERE f."agencyId"=$1 AND f."creatorId"=$2 AND f.kind=r.kind AND f."factId"=r."factId"`,
    item.agencyId, item.creatorId, JSON.stringify(rows.map(({ kind, factId }) => ({ kind, factId }))));
  // Once a deletion is published, no source row remains for adoption to race.
  // Remove only this locked page's settled tombstones, never scan old history.
  if (rows.length) await db.$executeRawUnsafe(`DELETE FROM "CreatorAnalyticsFactPublication" f
    USING jsonb_to_recordset($3::jsonb) r(kind text,"factId" text)
    WHERE f."agencyId"=$1 AND f."creatorId"=$2 AND f.kind=r.kind AND f."factId"=r."factId"
      AND f."currentValue" IS NULL AND f."publishedValue" IS NULL AND NOT f.dirty`,
    item.agencyId, item.creatorId, JSON.stringify(rows.map(({ kind, factId }) => ({ kind, factId }))));
  return updates.length;
}

async function processPage({ db, item, ownerToken }) {
  if (item.workClass !== WORK_CLASS || item.objectId !== item.creatorId) throw fault("ANALYTICS_FACT_SCOPE_INVALID");
  return runRootCommit(db, async ({ tx }) => {
    const lifecycle = await lockAgencyLifecycleBarrier({ db: tx, agencyId: item.agencyId });
    owned(await work.lockDomainWorkClaimForCommit({ db: tx, item, ownerToken }));
    if (await pauseDeletedAgencyProjection({ db: tx, lifecycle, item, ownerToken })) return { waiting: true, processed: 0 };
    const creator = await tx.creatorAccount.findFirst({ where: { id: item.creatorId, agencyId: item.agencyId, deletedAt: null }, select: { id: true } });
    if (!lifecycle.row || !creator) {
      owned(await work.ackDomainWorkClaim({ db: tx, item, ownerToken, terminalCause: "CREATOR_RETIRED" }));
      return { completed: true, processed: 0 };
    }
    // Fence work before admitting the page, then NEVER wait for a fact row.
    // A multi-row producer can already hold Work from its first row while
    // attempting a later row. Locking rows and then waiting for Work would
    // create a cycle. SKIP LOCKED makes this inverse admission order safe:
    // blocked producers publish/reopen Work after this commit, so no wake is lost.
    const rows = await tx.$queryRawUnsafe(`SELECT * FROM "CreatorAnalyticsFactPublication"
      WHERE "agencyId"=$1 AND "creatorId"=$2 AND dirty ORDER BY kind,"factId" LIMIT $3 FOR UPDATE SKIP LOCKED`, item.agencyId, item.creatorId, PAGE);
    const days = await applyDeltas(tx, item, rows);
    const pending = await tx.creatorAnalyticsFactPublication.findFirst({ where: { creatorId: item.creatorId, dirty: true }, select: { factId: true } });
    if (pending) owned(await work.yieldDomainWorkClaim({ db: tx, item, ownerToken }));
    else owned(await work.ackDomainWorkClaim({ db: tx, item, ownerToken }));
    return { processed: rows.length, days, completed: !pending, yielded: Boolean(pending) };
  }, { profile: "JOB_CHUNK", authority: { kind: WORK_CLASS, agencyId: item.agencyId, creatorId: item.creatorId } });
}

async function enumerateAdoption({ db }) {
  return runRootCommit(db, async ({ tx }) => {
    const [state] = await tx.$queryRawUnsafe('SELECT * FROM "MaintenanceLaneState" WHERE key=$1 FOR UPDATE SKIP LOCKED', ADOPTION_KEY);
    if (!state || state.completedAt) return { selected: 0, complete: Boolean(state?.completedAt) };
    if (state.generation !== ADOPTION_KEY || state.activeGeneration !== ADOPTION_KEY) throw fault("ANALYTICS_ADOPTION_GENERATION_INVALID");
    const cursor = state.cursor;
    if (!cursor || typeof cursor.upperId !== "string") throw fault("ANALYTICS_ADOPTION_CURSOR_INVALID");
    const rows = await tx.creatorAccount.findMany({ where: { id: { gt: cursor.afterId || "", lte: cursor.upperId } }, orderBy: { id: "asc" }, take: 10, select: { id: true, agencyId: true, deletedAt: true } });
    for (const row of [...rows].sort((a, b) => a.agencyId.localeCompare(b.agencyId) || a.id.localeCompare(b.id))) {
      await lockAgencyLifecycleBarrier({ db: tx, agencyId: row.agencyId });
      const identity = { agencyId: row.agencyId, creatorId: row.id, workClass: ADOPTION_CLASS, objectType: "CreatorAccount", objectId: row.id, partitionKey: row.id };
      if (!await tx.domainWorkItem.findUnique({ where: { id: work.workId(identity) }, select: { id: true } })) await work.publishDomainWork({ db: tx, ...identity });
    }
    const complete = rows.length < 10 || rows.at(-1)?.id === cursor.upperId;
    await tx.maintenanceLaneState.update({ where: { key: ADOPTION_KEY }, data: { cursor: { ...cursor, afterId: rows.at(-1)?.id || cursor.afterId }, completedAt: complete ? new Date() : null, lastOutcome: complete ? "ENUMERATED" : "ENUMERATING" } });
    return { selected: rows.length, complete };
  }, { profile: "JOB_CHUNK", authority: { kind: ADOPTION_CLASS } });
}

async function processAdoption({ db, item, ownerToken }) {
  if (item.workClass !== ADOPTION_CLASS || item.objectId !== item.creatorId) throw fault("ANALYTICS_ADOPTION_SCOPE_INVALID");
  return runRootCommit(db, async ({ tx }) => {
    const lifecycle = await lockAgencyLifecycleBarrier({ db: tx, agencyId: item.agencyId });
    const activeCreator = await tx.creatorAccount.findFirst({ where: { id: item.creatorId, agencyId: item.agencyId, deletedAt: null }, select: { id: true } });
    if (!lifecycle.row || lifecycle.row.deletedAt || !activeCreator) {
      owned(await work.lockDomainWorkClaimForCommit({ db: tx, item, ownerToken }));
      if (await pauseDeletedAgencyProjection({ db: tx, lifecycle, item, ownerToken })) return { waiting: true, processed: 0 };
      owned(await work.ackDomainWorkClaim({ db: tx, item, ownerToken, terminalCause: "CREATOR_RETIRED" }));
      return { completed: true, processed: 0 };
    }
    const cursor = item.progressCursor || {}, table = cursor.table || 0;
    if (!Number.isInteger(table) || table < 0 || table >= TABLES.length) throw fault("ANALYTICS_ADOPTION_CURSOR_INVALID");
    // Lock source before staging, as live writers do. Adoption never overwrites
    // a newer staged value; historical and live publications cannot double-add.
    const rows = await tx.$queryRawUnsafe(`SELECT * FROM "${TABLES[table]}" WHERE "agencyId"=$1 AND "creatorId"=$2 AND id>$3
      ORDER BY id LIMIT $4 FOR SHARE`, item.agencyId, item.creatorId, cursor.afterId || "", PAGE);
    if (rows.length) await tx.$executeRawUnsafe('SELECT "analytics_stage_fact_v1"($1,value,FALSE,TRUE) FROM jsonb_array_elements($2::jsonb)', TABLES[table], JSON.stringify(rows));
    const claim = owned(await work.lockDomainWorkClaimForCommit({ db: tx, item, ownerToken }));
    if (await pauseDeletedAgencyProjection({ db: tx, lifecycle, item, ownerToken })) return { waiting: true, processed: 0 };
    const creator = await tx.creatorAccount.findFirst({ where: { id: item.creatorId, agencyId: item.agencyId, deletedAt: null }, select: { id: true } });
    if (!lifecycle.row || !creator) {
      owned(await work.ackDomainWorkClaim({ db: tx, item, ownerToken, terminalCause: "CREATOR_RETIRED" }));
      return { completed: true, processed: 0 };
    }
    if (claim.newerRevision) throw fault("ANALYTICS_ADOPTION_REPUBLISHED");
    const next = rows.length === PAGE ? { table, afterId: rows.at(-1).id } : { table: table + 1, afterId: "" };
    if (next.table < TABLES.length) {
      owned(await work.yieldDomainWorkClaim({ db: tx, item, ownerToken, progressCursor: next }));
      return { yielded: true, processed: rows.length };
    }
    await tx.creatorAnalyticsPublicationState.upsert({ where: { creatorId: item.creatorId }, create: { agencyId: item.agencyId, creatorId: item.creatorId, initialized: true }, update: { initialized: true, updatedAt: new Date() } });
    owned(await work.ackDomainWorkClaim({ db: tx, item, ownerToken }));
    return { completed: true, processed: rows.length };
  }, { profile: "JOB_CHUNK", authority: { kind: ADOPTION_CLASS, agencyId: item.agencyId, creatorId: item.creatorId } });
}

async function runSweep({ db = require("../prisma"), limit = 8, maxRuntimeMs = 5000 } = {}) {
  const started = performance.now();
  const report = { ok: true, enumeration: await enumerateAdoption({ db }), processed: 0, failed: 0, completed: 0 };
  for (let i = 0; i < Math.min(16, limit) && performance.now() - started < maxRuntimeMs; i++) {
    const workClass = i % 2 ? ADOPTION_CLASS : WORK_CLASS;
    const claim = await work.claimDomainWorkBatch({ db, workClass, limit: 1, perAgencyQuantum: 1, perPartitionQuantum: 1, leaseMs: 120000 });
    const item = claim.items?.[0]; if (!item) continue;
    try {
      const result = await (workClass === ADOPTION_CLASS ? processAdoption : processPage)({ db, item, ownerToken: claim.ownerToken });
      report.processed += result.processed; if (result.completed) report.completed++;
    } catch (error) {
      await work.failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error }); report.failed++; report.ok = false;
    }
  }
  return report;
}

async function readPublishedDays({ db, creatorId, from, to }) {
  const [row] = await db.$queryRawUnsafe(`SELECT COALESCE(s.initialized,FALSE) AS initialized,
    EXISTS(SELECT 1 FROM "CreatorAnalyticsFactPublication" f WHERE f."creatorId"=c.id AND f.dirty LIMIT 1) AS pending,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('date',d.date,'values',d.values,'updatedAt',d."updatedAt") ORDER BY d.date)
      FROM "CreatorAnalyticsDay" d WHERE d."creatorId"=c.id AND d.date>=$2::date AND d.date<=$3::date),'[]') AS days
    FROM "CreatorAccount" c LEFT JOIN "CreatorAnalyticsPublicationState" s ON s."creatorId"=c.id WHERE c.id=$1`, creatorId, from, to);
  if (!row) throw fault("ANALYTICS_CREATOR_MISSING");
  const totals = {}, days = row.days || [];
  for (const day of days) for (const [key, amount] of Object.entries(day.values)) add(totals, key, amount);
  const subscriptions = [], financialGroups = [];
  for (const key of Object.keys(totals)) {
    const parts = key.split(":");
    if (parts[0] === "subscription" && parts[2] === "count") subscriptions.push({ eventType: parts[1], _count: { _all: totals[key] }, _sum: { observedPriceCents: totals[`subscription:${parts[1]}:amount`] || 0 } });
    if (parts[0] === "financial" && parts[3] === "count") financialGroups.push({ transactionType: parts[1], transactionStatus: parts[2], _count: { _all: totals[key] }, _sum: { amountCents: totals[`financial:${parts[1]}:${parts[2]}:amount`] || 0, netCents: totals[`financial:${parts[1]}:${parts[2]}:net`] || 0 } });
  }
  return { ready: row.initialized && !row.pending, state: !row.initialized ? "REBUILDING" : row.pending ? "UPDATING" : "READY",
    days: days.map(row => ({ date: new Date(row.date), ...row.values })), totals, subscriptions, financialGroups };
}

module.exports = { WORK_CLASS, ADOPTION_CLASS, ADOPTION_KEY, TABLES, MODELS, PAGE, contribution, deltas,
  applyDeltas, processPage, enumerateAdoption, processAdoption, runSweep, readPublishedDays };
