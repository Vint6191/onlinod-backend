"use strict";

// Durable reverse delivery. Domain owners stage their CURRENT canonical result
// in the same commit as their fact; this service does not apply financial rules.
// Revisions are allocated under a creator-head lock held through commit. An
// earlier revision can therefore never become visible after a reader advances.
const { currentCommitContext, prepareCommit, runRootCommit } = require("./db-commit-kernel");
const { hashCanonicalJson } = require("./realtime-receipt-hash");
const { performance } = require("node:perf_hooks");
const TYPES = Object.freeze(["MESSAGE_PURCHASE", "HOME", "CRM", "CAMPAIGN", "FAN", "MEDIA", "TEAM", "AUDIENCE", "TRAFFIC"]);
const MAX_PAGE = 200, MAX_STAGED = 10000, MAX_CONTRIBUTORS = 40000, MAX_PAYLOAD_BYTES = 8192, RETENTION_DAYS = 30;
const stages = new WeakMap();
const fail = (code, status = 409) => Object.assign(new Error(code), { code, status });
const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
function revision(value, fallback = null) {
  if (value == null && fallback !== null) return BigInt(fallback);
  if (!/^(0|[1-9][0-9]{0,18})$/.test(String(value ?? ""))) throw fail("ENTITY_CHANGE_CURSOR_INVALID", 400);
  const result = BigInt(value);
  if (result > 9223372036854775807n) throw fail("ENTITY_CHANGE_CURSOR_INVALID", 400);
  return result;
}
function boundedString(value, max, code = "ENTITY_CHANGE_INVALID") {
  if (typeof value !== "string" || !value || value.length > max || [...value].some(character => character.charCodeAt(0) < 32)) throw fail(code, 400);
  return value;
}
function normalize(change) {
  if (!TYPES.includes(change?.entityType)) throw fail("ENTITY_CHANGE_TYPE_INVALID", 400);
  const row = { entityType: change.entityType, entityId: boundedString(change.entityId, 500),
    sourceIdentity: boundedString(change.sourceIdentity, 500), sourceVersion: boundedString(String(change.sourceVersion ?? ""), 200),
    tombstone: change.tombstone === true, payload: JSON.parse(JSON.stringify(change.payload ?? {})) };
  if (!row.payload || typeof row.payload !== "object" || Array.isArray(row.payload)
      || Buffer.byteLength(JSON.stringify(row.payload)) > MAX_PAYLOAD_BYTES) throw fail("ENTITY_CHANGE_PAYLOAD_INVALID", 400);
  if (row.entityType === "MESSAGE_PURCHASE" && !row.tombstone) {
    const p = row.payload;
    boundedString(p.dialogId, 240); boundedString(p.messageId, 240);
    if (typeof p.opened !== "boolean" || row.entityId !== `${p.dialogId}:${p.messageId}`) throw fail("ENTITY_CHANGE_PURCHASE_INVALID", 400);
    if (p.purchasedAt && !Number.isFinite(+new Date(p.purchasedAt))) throw fail("ENTITY_CHANGE_PURCHASE_INVALID", 400);
    if (Object.keys(p).some(key => !["dialogId", "messageId", "opened", "purchasedAt", "operationId"].includes(key))) throw fail("ENTITY_CHANGE_PURCHASE_INVALID", 400);
  } else if (row.entityType !== "MESSAGE_PURCHASE") {
    // This public feed invalidates server-owned reads. It must not become an
    // alternate permissionless channel for earnings, chat text or fan profiles.
    if (Object.keys(row.payload).some(key => !["dataVersion", "reason", "dialogId", "fanOnlyFansUserId", "campaignId", "mediaId"].includes(key))) throw fail("ENTITY_CHANGE_INVALIDATION_INVALID", 400);
    for (const value of Object.values(row.payload)) if (value !== null && typeof value !== "string") throw fail("ENTITY_CHANGE_INVALIDATION_INVALID", 400);
  }
  return row;
}

function stageChange(owner, row) {
  const key = `${row.entityType}\u0000${row.entityId}`, old = owner.changes.get(key);
  if (row.entityType === "MESSAGE_PURCHASE") {
    // Exact corrections describe one current message state, rather than a set
    // of independent reasons to reread a shared server-owned view.
    if (old?.sourceIdentity === row.sourceIdentity && /^\d+$/.test(old.sourceVersion) && /^\d+$/.test(row.sourceVersion)
        && BigInt(row.sourceVersion) < BigInt(old.sourceVersion)) return;
    if (!old) owner.contributorCount += 1;
    owner.changes.set(key, row);
    return;
  }
  const entry = old || { entityType: row.entityType, entityId: row.entityId, contributors: new Map(), numericVersions: new Map() };
  const contributorKey = `${row.sourceIdentity}\u0000${row.sourceVersion}`;
  const duplicate = entry.contributors.get(contributorKey);
  if (duplicate) {
    if (duplicate.tombstone !== row.tombstone || hashCanonicalJson(duplicate.payload) !== hashCanonicalJson(row.payload)) {
      throw fail("ENTITY_CHANGE_SOURCE_VERSION_CONFLICT");
    }
    return;
  }
  // Ordered versions of a single owner replace its earlier intermediate state.
  // Opaque hashes may describe independent bounded fact subsets, even when the
  // same helper publishes them, so retain every distinct contributor.
  if (/^\d+$/.test(row.sourceVersion)) {
    const numeric = BigInt(row.sourceVersion), previous = entry.numericVersions.get(row.sourceIdentity);
    if (previous && previous.value > numeric) return;
    if (previous) {
      entry.contributors.delete(`${row.sourceIdentity}\u0000${previous.version}`);
      owner.contributorCount -= 1;
    }
    entry.numericVersions.set(row.sourceIdentity, { version: row.sourceVersion, value: numeric });
  }
  entry.contributors.set(contributorKey, row);
  owner.contributorCount += 1;
  owner.changes.set(key, entry);
}

function combineInvalidation(entry) {
  if (!entry.contributors) return entry;
  const contributors = [...entry.contributors.values()].sort((a,b) => compare(a.sourceIdentity,b.sourceIdentity) || compare(a.sourceVersion,b.sourceVersion));
  if (contributors.length === 1) return contributors[0];
  const dataVersion = hashCanonicalJson(contributors.map(row => [row.sourceIdentity, row.sourceVersion, row.tombstone, hashCanonicalJson(row.payload)]));
  const first = contributors[0].payload;
  const payload = { dataVersion, reason: first.reason && contributors.every(row => row.payload.reason === first.reason) ? first.reason : "CANONICAL_ENTITIES_CHANGED" };
  for (const field of ["dialogId", "fanOnlyFansUserId", "campaignId", "mediaId"]) {
    if (first[field] !== undefined && contributors.every(row => row.payload[field] === first[field])) payload[field] = first[field];
  }
  return { entityType: entry.entityType, entityId: entry.entityId,
    sourceIdentity: `entity-contributors:${hashCanonicalJson([entry.entityType,entry.entityId])}`, sourceVersion: dataVersion,
    payload, tombstone: contributors.every(row => row.tombstone) };
}

async function publishEntityChanges({ db, agencyId, creatorId, changes }) {
  const context = currentCommitContext();
  if (!context || context.tx !== db) throw fail("ENTITY_CHANGE_OWNER_TRANSACTION_REQUIRED");
  boundedString(agencyId, 200); boundedString(creatorId, 200);
  if (!Array.isArray(changes) || changes.length > MAX_STAGED) throw fail("ENTITY_CHANGE_CAPACITY", 400);
  if (!changes.length) return { staged: true, count: 0 };
  let stage = stages.get(context);
  if (!stage) { stage = new Map(); stages.set(context, stage); }
  let owner = stage.get(creatorId);
  if (!owner) { owner = { agencyId, creatorId, changes: new Map(), contributorCount: 0 }; stage.set(creatorId, owner); }
  if (owner.agencyId !== agencyId) throw fail("ENTITY_CHANGE_SCOPE_MISMATCH");
  for (const input of changes) {
    stageChange(owner, normalize(input));
  }
  if ([...stage.values()].reduce((count, item) => count + item.changes.size, 0) > MAX_STAGED
      || [...stage.values()].reduce((count, item) => count + item.contributorCount, 0) > MAX_CONTRIBUTORS) throw fail("ENTITY_CHANGE_CAPACITY");
  prepareCommit(context, "zz-creator-entity-changes", async () => {
    for (const item of [...stage.values()].sort((a, b) => compare(a.creatorId,b.creatorId))) await persistCreator(db, item);
    stages.delete(context);
  }, () => { stage.clear(); stages.delete(context); });
  return { staged: true, count: changes.length };
}

function factInvalidations({ rows, model, creatorId, scopedTypes }) {
  const changes = [], byFan = new Map();
  const versions = rows.map(row => {
    const dialogId = row.fanOnlyFansUserIdAtEvent || row.fan?.onlyFansUserId;
    // Transport collection timestamps/devices are not content revisions.
    const canonical = Object.fromEntries(Object.entries(row).filter(([key]) => !["collectedAt", "updatedAt", "sourceDeviceId", "sourceJobId", "sourceUpdatedAt"].includes(key)));
    const dataVersion = hashCanonicalJson(canonical);
    if (dialogId) {
      if (!byFan.has(dialogId)) byFan.set(dialogId, []);
      byFan.get(dialogId).push([row.id, dataVersion]);
    }
    return [row.id, dataVersion];
  });
  const dataVersion = hashCanonicalJson(versions.sort((a,b) => compare(a[0],b[0])));
  for (const entityType of ["HOME", "TEAM", "CAMPAIGN", "AUDIENCE", "TRAFFIC"]) changes.push({
    entityType, entityId: creatorId, sourceIdentity: `${model}:creator`, sourceVersion: dataVersion,
    payload: { dataVersion, reason: "CANONICAL_FACT_CHANGED" },
  });
  for (const [dialogId, parts] of byFan) {
    const fanVersion = hashCanonicalJson(parts.sort((a,b) => compare(a[0],b[0])));
    for (const entityType of scopedTypes) changes.push({ entityType, entityId: dialogId,
      sourceIdentity: `${model}:fan:${dialogId}`, sourceVersion: fanVersion,
      payload: { dataVersion: fanVersion, reason: "CANONICAL_FACT_CHANGED", dialogId, fanOnlyFansUserId: dialogId } });
  }
  return changes;
}
async function canonicalFactRows(db, { agencyId, creatorId, ids, model }) {
  const unique = [...new Set(ids || [])];
  if (unique.length > 2000) throw fail("ENTITY_CHANGE_CAPACITY");
  return unique.length ? db[model].findMany({ where: { agencyId, creatorId, id: { in: unique } },
    include: { fan: { select: { onlyFansUserId: true } } }, take: unique.length }) : [];
}
async function publishCanonicalSales({ db, agencyId, creatorId, saleIds }) {
  const rows = await canonicalFactRows(db, { agencyId, creatorId, ids: saleIds, model: "creatorSale" });
  if (!rows.length) return { staged: true, count: 0 };
  const changes = factInvalidations({ rows, model: "CreatorSale", creatorId, scopedTypes: ["CRM", "MEDIA", "FAN"] });
  for (const row of rows) {
    const dialogId = row.fanOnlyFansUserIdAtEvent || row.fan?.onlyFansUserId;
    const dataVersion = hashCanonicalJson({ id: row.id, dialogId, messageId: row.messageId, saleType: row.saleType, purchasedAt: row.purchasedAt,
      status: row.transactionStatus, amountCents: row.amountCents, netCents: row.netCents, currency: row.currency });
    // Payout rows with no exact message identity are not purchase evidence for
    // a particular local message. A later canonical link enters this same path.
    // Refunds change financial/media reads; they do not prove message closure.
    if (dialogId && row.messageId && row.saleType === "MESSAGE"
        && ["", "done", "completed", "complete", "success", "paid"].includes(String(row.transactionStatus || "").toLowerCase())) {
      changes.push({ entityType: "MESSAGE_PURCHASE", entityId: `${dialogId}:${row.messageId}`,
        sourceIdentity: `CreatorSale:${row.id}`, sourceVersion: dataVersion, payload: { dialogId, messageId: row.messageId, opened: true,
          purchasedAt: new Date(row.purchasedAt).toISOString(), operationId: row.externalTransactionId || row.externalNotificationId || row.id } });
    }
  }
  return publishEntityChanges({ db, agencyId, creatorId, changes });
}
async function publishCanonicalFactInvalidations({ db, agencyId, creatorId, model, ids }) {
  if (!["creatorTip", "creatorSubscriptionEvent", "creatorPostLike", "creatorPostComment"].includes(model)) throw fail("ENTITY_CHANGE_TYPE_INVALID");
  const rows = await canonicalFactRows(db, { agencyId, creatorId, model, ids });
  if (!rows.length) return { staged: true, count: 0 };
  return publishEntityChanges({ db, agencyId, creatorId,
    changes: factInvalidations({ rows, model, creatorId, scopedTypes: ["CRM", "FAN"] }) });
}

async function persistCreator(db, { agencyId, creatorId, changes }) {
  await db.$executeRawUnsafe(`INSERT INTO "CreatorEntityChangeHead"("creatorId","agencyId") VALUES($1,$2)
    ON CONFLICT("creatorId") DO NOTHING`, creatorId, agencyId);
  const [head] = await db.$queryRawUnsafe(`SELECT "lastRevision" FROM "CreatorEntityChangeHead"
    WHERE "creatorId"=$1 AND "agencyId"=$2 FOR UPDATE`, creatorId, agencyId);
  if (!head) throw fail("ENTITY_CHANGE_SCOPE_MISMATCH");
  const inputs = [...changes.values()].map(combineInvalidation).sort((a, b) => compare(a.entityType,b.entityType) || compare(a.entityId,b.entityId));
  const current = await db.$queryRawUnsafe(`SELECT c.* FROM "CreatorEntityCurrent" c
    JOIN jsonb_to_recordset($3::jsonb) x("entityType" text,"entityId" text)
      ON c."entityType"=x."entityType" AND c."entityId"=x."entityId"
    WHERE c."creatorId"=$1 AND c."agencyId"=$2`, creatorId, agencyId, JSON.stringify(inputs));
  const byEntity = new Map(current.map(row => [`${row.entityType}\u0000${row.entityId}`, row]));
  let last = BigInt(head.lastRevision);
  const writes = [];
  for (const row of inputs) {
    const old = byEntity.get(`${row.entityType}\u0000${row.entityId}`);
    if (old && old.tombstone === row.tombstone && hashCanonicalJson(old.payload) === hashCanonicalJson(row.payload)) continue;
    // Numeric owner versions have a true order. Opaque versions are hashes of
    // the current canonical owner result, never a provider event arrival time.
    if (old?.sourceIdentity === row.sourceIdentity) {
      if (old.sourceVersion === row.sourceVersion) throw fail("ENTITY_CHANGE_SOURCE_VERSION_CONFLICT");
      if (/^\d+$/.test(old.sourceVersion) && /^\d+$/.test(row.sourceVersion) && BigInt(row.sourceVersion) < BigInt(old.sourceVersion)) continue;
    }
    last += 1n;
    writes.push({ ...row, revision: last.toString() });
  }
  if (!writes.length) return;
  const json = JSON.stringify(writes);
  await db.$executeRawUnsafe(`INSERT INTO "CreatorEntityChange"("creatorId","agencyId",revision,"entityType","entityId","sourceIdentity","sourceVersion",payload,tombstone,"createdAt")
    SELECT $1,$2,x.revision,x."entityType",x."entityId",x."sourceIdentity",x."sourceVersion",x.payload,x.tombstone,clock_timestamp()
    FROM jsonb_to_recordset($3::jsonb) x(revision bigint,"entityType" text,"entityId" text,"sourceIdentity" text,"sourceVersion" text,payload jsonb,tombstone boolean)
    ORDER BY x.revision`, creatorId, agencyId, json);
  await db.$executeRawUnsafe(`INSERT INTO "CreatorEntityCurrent"("creatorId","agencyId",revision,"entityType","entityId","sourceIdentity","sourceVersion",payload,tombstone)
    SELECT $1,$2,x.revision,x."entityType",x."entityId",x."sourceIdentity",x."sourceVersion",x.payload,x.tombstone
    FROM jsonb_to_recordset($3::jsonb) x(revision bigint,"entityType" text,"entityId" text,"sourceIdentity" text,"sourceVersion" text,payload jsonb,tombstone boolean)
    ON CONFLICT("creatorId","entityType","entityId") DO UPDATE SET revision=EXCLUDED.revision,"sourceIdentity"=EXCLUDED."sourceIdentity",
      "sourceVersion"=EXCLUDED."sourceVersion",payload=EXCLUDED.payload,tombstone=EXCLUDED.tombstone,"updatedAt"=clock_timestamp()`, creatorId, agencyId, json);
  await db.$executeRawUnsafe(`UPDATE "CreatorEntityChangeHead" SET "lastRevision"=$3,"updatedAt"=clock_timestamp(),
      "nextRetentionAt"=COALESCE("nextRetentionAt",clock_timestamp()+interval '30 days')
    WHERE "creatorId"=$1 AND "agencyId"=$2`, creatorId, agencyId, last);
}

const wire = row => ({ revision: String(row.revision), entityType: row.entityType, entityId: row.entityId,
  sourceIdentity: row.sourceIdentity, sourceVersion: row.sourceVersion, payload: row.payload, tombstone: row.tombstone === true });
function pageLimit(value) {
  if (value == null) return MAX_PAGE;
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > MAX_PAGE) throw fail("ENTITY_CHANGE_LIMIT_INVALID", 400);
  return Number(value);
}
async function readHead(db, agencyId, creatorId) {
  const [head] = await db.$queryRawUnsafe(`SELECT "lastRevision","retainedFrom" FROM "CreatorEntityChangeHead" WHERE "creatorId"=$1 AND "agencyId"=$2`, creatorId, agencyId);
  return head ? { lastRevision: BigInt(head.lastRevision), retainedFrom: BigInt(head.retainedFrom) } : { lastRevision: 0n, retainedFrom: 1n };
}
function assertCursor(head, after) {
  if (after < head.retainedFrom - 1n || after > head.lastRevision) throw Object.assign(fail("RECONCILE_REQUIRED"), {
    retainedFrom: head.retainedFrom.toString(), headRevision: head.lastRevision.toString(), protocolVersion: 1 });
}
async function readEntityChanges({ db, agencyId, creatorId, afterRevision = "0", limit }) {
  const after = revision(afterRevision), size = pageLimit(limit), head = await readHead(db, agencyId, creatorId);
  assertCursor(head, after);
  const rows = await db.$queryRawUnsafe(`SELECT revision,"entityType","entityId","sourceIdentity","sourceVersion",payload,tombstone
    FROM "CreatorEntityChange" WHERE "creatorId"=$1 AND "agencyId"=$2 AND revision>$3 AND revision<=$4 ORDER BY revision LIMIT $5`,
  creatorId, agencyId, after, head.lastRevision, size + 1);
  const changes = rows.slice(0, size).map(wire);
  return { protocolVersion: 1, creatorId, changes, nextRevision: changes.at(-1)?.revision || after.toString(),
    headRevision: head.lastRevision.toString(), retainedFrom: head.retainedFrom.toString(), hasMore: rows.length > size };
}
async function readCurrentEntities({ db, agencyId, creatorId, snapshotBarrier, afterType, afterId, limit }) {
  const size = pageLimit(limit), head = await readHead(db, agencyId, creatorId);
  const barrier = revision(snapshotBarrier, head.lastRevision);
  assertCursor(head, barrier);
  if ((afterType == null) !== (afterId == null)) throw fail("ENTITY_CHANGE_SNAPSHOT_CURSOR_INVALID", 400);
  if (afterType != null) { if (!TYPES.includes(afterType)) throw fail("ENTITY_CHANGE_SNAPSHOT_CURSOR_INVALID", 400); boundedString(afterId, 500); }
  const rows = await db.$queryRawUnsafe(`SELECT revision,"entityType","entityId","sourceIdentity","sourceVersion",payload,tombstone
    FROM "CreatorEntityCurrent" WHERE "creatorId"=$1 AND "agencyId"=$2
      AND ($3::text IS NULL OR ("entityType","entityId")>($3::text,$4::text)) ORDER BY "entityType","entityId" LIMIT $5`,
  creatorId, agencyId, afterType ?? null, afterId ?? null, size + 1);
  const entities = rows.slice(0, size).map(wire), last = entities.at(-1);
  return { protocolVersion: 1, creatorId, entities, snapshotBarrier: barrier.toString(), headRevision: head.lastRevision.toString(),
    retainedFrom: head.retainedFrom.toString(), hasMore: rows.length > size,
    nextCursor: last ? { entityType: last.entityType, entityId: last.entityId } : null };
}

// Compact only a contiguous prefix. Current entity snapshots survive retention,
// so an offline device never pins history and can reconcile in bounded pages.
async function retainPage(db, { limit = 500 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw fail("ENTITY_CHANGE_RETENTION_INVALID", 400);
  // Only due heads enter the indexed queue. A creator with a large backlog
  // returns to the end of that queue after every bounded page, and a held head
  // is skipped without hiding other creators behind its oldest history rows.
  const heads = await db.$queryRawUnsafe(`SELECT * FROM "CreatorEntityChangeHead"
    WHERE "nextRetentionAt"<=statement_timestamp() ORDER BY "nextRetentionAt","creatorId"
    LIMIT 1 FOR UPDATE SKIP LOCKED`);
  if (!heads.length) return 0;
  const head = heads[0];
  const candidates = await db.$queryRawUnsafe(`SELECT revision,("createdAt"<clock_timestamp()-($2::int*interval '1 day')) AS expired
    FROM "CreatorEntityChange" WHERE "creatorId"=$1 ORDER BY revision LIMIT $3`, head.creatorId, RETENTION_DAYS, limit);
  const prefix = [];
  for (const row of candidates) { if (!row.expired) break; prefix.push(row.revision); }
  const through = prefix.length ? BigInt(prefix.at(-1)) : BigInt(head.retainedFrom) - 1n;
  if (prefix.length) await db.$executeRawUnsafe(`DELETE FROM "CreatorEntityChange" WHERE "creatorId"=$1 AND revision<=$2`, head.creatorId, through);
  await db.$executeRawUnsafe(`UPDATE "CreatorEntityChangeHead" SET "retainedFrom"=$2,"updatedAt"=clock_timestamp(),
    "nextRetentionAt"=(SELECT GREATEST(clock_timestamp(),c."createdAt"+($3::int*interval '1 day'))
      FROM "CreatorEntityChange" c WHERE c."creatorId"=$1 ORDER BY c.revision LIMIT 1)
    WHERE "creatorId"=$1`, head.creatorId, through + 1n, RETENTION_DAYS);
  return prefix.length;
}
async function runRetentionSweep({ db = require("../prisma"), maxPages = 8, maxRuntimeMs = 4000 } = {}) {
  const report = { ok: true, processed: 0 }, started = performance.now();
  for (let i = 0; i < Math.min(32, Math.max(1, maxPages)); i++) {
    const count = await runRootCommit(db, ({ tx }) => retainPage(tx), { profile: "RETENTION_MUTATION", timeout: 5000, deadlineMs: 7000 });
    report.processed += count;
    if (!count || performance.now() - started >= maxRuntimeMs) break;
  }
  return report;
}

module.exports = { TYPES, MAX_PAGE, publishEntityChanges, publishCanonicalSales, publishCanonicalFactInvalidations, readEntityChanges, readCurrentEntities, retainPage, runRetentionSweep };
