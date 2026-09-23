"use strict";

// Caller holds its creator/consumer planning transaction lock; cursor and plans
// commit together. Each callback must use an indexed, tenant-scoped keyset.
async function readFanConsumerPage({ db, agencyId, creatorId, runId, consumerKey, limit = 100, findPage, keyOf = (row) => row.id, stableAcrossPublications = false }) {
  const take = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const cursor = await db.fanConsumerCursor.findUnique({ where: { creatorId_consumerKey: { creatorId, consumerKey } } });
  if (cursor && cursor.agencyId !== agencyId) throw new Error("FAN_CONSUMER_CURSOR_TENANT_MISMATCH");
  // Stable fan/content identities survive publication replacement. Resetting
  // such a key on every new run can starve the tail of a large live cohort.
  const afterKey = cursor && (stableAcrossPublications || cursor.runId === runId) ? cursor.afterKey : null;
  let rows = await findPage({ afterKey, take: take + 1 });
  if (!rows.length && afterKey) rows = await findPage({ afterKey: null, take: take + 1 });
  const page = rows.slice(0, take);
  const data = { runId, afterKey: rows.length > take ? String(keyOf(page[page.length - 1])) : null };
  await db.fanConsumerCursor.upsert({ where: { creatorId_consumerKey: { creatorId, consumerKey } },
    create: { agencyId, creatorId, consumerKey, ...data }, update: data });
  return page;
}

// Scan history supplies cohort membership/dialog identity only. Current fan
// eligibility is resolved by FanDataAuthority after this bounded enumeration.
async function readSubscriberConsumerPage({ db, agencyId, creatorId, runId, consumerKey, fanIds = [], limit = 100 }) {
  const take = Math.max(1, Math.min(500, Math.floor(Number(limit) || 100)));
  const ids = [...new Set(fanIds.map(String).filter(Boolean))].slice(0, 500);
  const findPage = ({ afterKey, take: pageSize }) => db.subscriberScanItem.findMany({
    where: { agencyId, creatorId, runId, ...(ids.length ? { fanId: { in: ids } } : afterKey ? { fanId: { gt: afterKey } } : {}) },
    orderBy: { fanId: "asc" }, take: pageSize,
    select: { id: true, fanId: true, dialogId: true, runId: true, observedAt: true },
  });
  if (ids.length) return findPage({ afterKey: null, take });
  // Existing unique (runId, fanId) index is the bounded seek authority.
  return readFanConsumerPage({ db, agencyId, creatorId, runId, consumerKey, limit: take, findPage,
    keyOf: (row) => row.fanId, stableAcrossPublications: true });
}

module.exports = { readFanConsumerPage, readSubscriberConsumerPage };
