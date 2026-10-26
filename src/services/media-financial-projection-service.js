"use strict";

// Media observations remain additive. Only the existing canonical finance owner
// can replace their monetary interpretation; this is a rebuildable projection.
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { hashCanonicalJson } = require("./realtime-receipt-hash");
const { runRootCommit } = require("./db-commit-kernel");
const { lockDbAdvisoryXact } = require("./db-transaction-service");
const work = require("./domain-work-authority-service");
const { lockCreatorFacts } = require("./creator-fact-write-authority");
const { lockAgencyLifecycleBarrier } = require("./agency-lifecycle-barrier-service");
const { pauseDeletedAgencyProjection } = require("./analytics-projection-lifecycle-service");
const WORK_CLASS = "MEDIA_FINANCIAL_PROJECTION", ADOPTION_KEY = "media_financial_adoption_v1", PAGE = 500;
const COUNTS = ["sentCount", "soldCount", "notOpenedCount", "freeCount", "revenueCents", "revenueUnknownCount"];
const paid = new Set(["", "done", "completed", "complete", "success", "paid"]);
const refunded = new Set(["undo", "refunded", "refund", "chargeback", "reversed", "reversal"]);
const fail = code => Object.assign(new Error(code), { code });
const own = result => { if (!result || result.lost) throw fail("MEDIA_FINANCIAL_CLAIM_LOST"); return result; };
const sourceKey = (creatorId, dialogId) => `local-snapshot:${crypto.createHash("sha256").update(`${creatorId}\u0000${dialogId}`).digest("hex")}`;
const key = row => JSON.stringify([row.sourceKey, row.messageId || row.sourceMessageId]);
const money = value => value !== null && value !== undefined && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null;
const counts = value => ({ ...Object.fromEntries(COUNTS.map(field => [field, Number(value?.[field] || 0)])), uniqueBuyers: Number(value?.uniqueBuyers || 0), lastSoldAt: value?.lastSoldAt || null });
async function lock(db, agencyId, creatorId) { await lockDbAdvisoryXact({ db, key: `media_library_usage:${agencyId}:${creatorId}` }); }
async function requestProjection(db, scope) {
  return work.publishDomainWork({ db, ...scope, workClass: WORK_CLASS, objectType: "CreatorAccount", objectId: scope.creatorId, partitionKey: scope.creatorId });
}

async function verifiedLegacyRows(db, creatorId, rows) {
  const ids = [...new Set(rows.map(row => row.externalTransactionId).filter(Boolean))];
  const entries = ids.length ? await db.$queryRawUnsafe(`SELECT e."transactionId",e."netCents",e.status,e.category FROM "CreatorEarningsLedgerProof" p
    JOIN "CreatorEarningsGenerationEntry" e ON e.generation=p."activeGeneration"
    WHERE p."creatorId"=$1 AND e."transactionId"=ANY($2::text[])
    UNION ALL SELECT e."transactionId",e."netCents",e.status,e.category FROM "CreatorEarningsLedgerEntry" e
    WHERE e."creatorId"=$1 AND e."transactionId"=ANY($2::text[])
      AND NOT EXISTS(SELECT 1 FROM "CreatorEarningsLedgerProof" p WHERE p."creatorId"=$1 AND p."activeGeneration" IS NOT NULL)`, creatorId, ids) : [];
  const byId = new Map(entries.map(row => [row.transactionId, row]));
  const categories = { MESSAGE: "messages", POST: "posts", STREAM: "streams", OTHER: "other" };
  return rows.map(row => {
    if (!row.externalTransactionId) return { ...row, netCents: null };
    const entry = byId.get(row.externalTransactionId);
    // One provider identity can move from Sale to Tip or another category.
    // Its money cannot revive the retired message association during adoption.
    if (String(row.transactionStatus || "").trim().toLowerCase() === "superseded"
      || (entry && entry.category !== categories[row.saleType])) {
      return { ...row, netCents: null, transactionStatus: "superseded" };
    }
    return { ...row, netCents: entry ? money(entry.netCents) : null, transactionStatus: entry?.status || "unverified" };
  });
}

async function publishCanonicalMediaSales({ db, agencyId, creatorId, rows, adoption = false }) {
  if (!rows.length) return [];
  if (rows.length > 2000) throw fail("MEDIA_FINANCIAL_PAGE_CAPACITY");
  await lock(db, agencyId, creatorId);
  if (adoption) rows = await verifiedLegacyRows(db, creatorId, rows);
  const old = await db.$queryRawUnsafe('SELECT * FROM "CreatorMediaSaleLink" WHERE "creatorId"=$1 AND "agencyId"=$2 AND "saleId"=ANY($3::text[])', creatorId, agencyId, rows.map(row => row.id));
  const previous = new Map(old.map(row => [row.saleId, row])), affected = new Map(), writes = [];
  for (const row of rows) {
    const dialogId = row.fanOnlyFansUserIdAtEvent || row.fan?.onlyFansUserId || null;
    const exact = Boolean(dialogId && row.messageId && row.saleType === "MESSAGE");
    const status = String(row.transactionStatus || "").trim().toLowerCase();
    const proofActive = exact && (paid.has(status) || refunded.has(status) || (status === "unverified" && Boolean(row.externalNotificationId)));
    const value = { saleId: row.id, agencyId, creatorId, sourceKey: exact ? sourceKey(creatorId, dialogId) : null,
      dialogId: exact ? dialogId : null, messageId: exact ? row.messageId : null,
      netCents: exact && row.currency === "USD" ? refunded.has(status) ? 0 : paid.has(status) ? money(row.netCents) : null : null,
      proofActive, purchasedAt: exact ? new Date(row.purchasedAt).toISOString() : null,
      operationId: row.externalTransactionId || row.externalNotificationId || row.id };
    value.version = hashCanonicalJson(value);
    const before = previous.get(row.id);
    if (before?.version === value.version) continue;
    if (before?.sourceKey && before.messageId) affected.set(key(before), before);
    if (value.sourceKey) affected.set(key(value), value);
    writes.push(value);
  }
  if (!writes.length) return [];
  await db.$executeRawUnsafe(`INSERT INTO "CreatorMediaSaleLink"("saleId","agencyId","creatorId","sourceKey","dialogId","messageId","netCents","proofActive","purchasedAt","operationId",version)
    SELECT x."saleId",$1,$2,x."sourceKey",x."dialogId",x."messageId",x."netCents",x."proofActive",x."purchasedAt",x."operationId",x.version
    FROM jsonb_to_recordset($3::jsonb) x("saleId" text,"sourceKey" text,"dialogId" text,"messageId" text,"netCents" int,"proofActive" boolean,"purchasedAt" timestamp,"operationId" text,version text)
    ON CONFLICT("saleId") DO UPDATE SET "sourceKey"=EXCLUDED."sourceKey","dialogId"=EXCLUDED."dialogId","messageId"=EXCLUDED."messageId",
      "netCents"=EXCLUDED."netCents","proofActive"=EXCLUDED."proofActive","purchasedAt"=EXCLUDED."purchasedAt","operationId"=EXCLUDED."operationId",version=EXCLUDED.version,"updatedAt"=clock_timestamp()`, agencyId, creatorId, JSON.stringify(writes));
  return publishMessageStates({ db,agencyId,creatorId,affected });
}

async function publishMessageStates({ db,agencyId,creatorId,affected }) {
  const changes = [], stateWrites = [];
  // Each canonical batch is bounded. This grouped read touches only the exact
  // affected messages through CreatorMediaSaleLink_message_idx.
  const summaries = affected.size ? await db.$queryRawUnsafe(`SELECT a."sourceKey",a."messageId",a."dialogId",
      count(l."saleId") FILTER(WHERE l."proofActive")::int AS proofs,
      CASE WHEN count(l."saleId") FILTER(WHERE l."proofActive" AND l."netCents" IS NULL)>0 THEN NULL
        ELSE sum(l."netCents") FILTER(WHERE l."proofActive") END AS net,
      max(l."purchasedAt") FILTER(WHERE l."proofActive") AS "purchasedAt",
      min(l."operationId") FILTER(WHERE l."proofActive") AS "operationId"
    FROM jsonb_to_recordset($3::jsonb) a("sourceKey" text,"messageId" text,"dialogId" text)
    LEFT JOIN "CreatorMediaSaleLink" l ON l."agencyId"=$1 AND l."creatorId"=$2 AND l."sourceKey"=a."sourceKey" AND l."messageId"=a."messageId"
    GROUP BY a."sourceKey",a."messageId",a."dialogId"`, agencyId, creatorId, JSON.stringify([...affected.values()])) : [];
  for (const row of summaries) {
    const payload = { dialogId: row.dialogId, messageId: row.messageId, opened: row.proofs > 0,
      ...(row.proofs > 0 ? { purchasedAt: new Date(row.purchasedAt).toISOString(), operationId: row.operationId } : {}) };
    const version = hashCanonicalJson({ ...payload, net: row.net == null ? null : String(row.net) });
    stateWrites.push({ sourceKey: row.sourceKey, messageId: row.messageId, dialogId: row.dialogId,
      netCents: row.net == null ? null : String(row.net), proofActive: row.proofs > 0, purchasedAt: row.purchasedAt,
      operationId: row.operationId, version });
    changes.push({ entityType: "MESSAGE_PURCHASE", entityId: `${row.dialogId}:${row.messageId}`,
      sourceIdentity: `canonical-message:${row.dialogId}:${row.messageId}`, sourceVersion: version,
      tombstone: row.proofs === 0, payload: row.proofs ? payload : { dialogId: row.dialogId, messageId: row.messageId, reason: "CANONICAL_ASSOCIATION_WITHDRAWN" } });
  }
  if (stateWrites.length) await db.$executeRawUnsafe(`INSERT INTO "CreatorMediaMessageFinancialState"("agencyId","creatorId","sourceKey","messageId","dialogId","netCents","proofActive","purchasedAt","operationId",version)
    SELECT $1,$2,x."sourceKey",x."messageId",x."dialogId",x."netCents",x."proofActive",x."purchasedAt",x."operationId",x.version
    FROM jsonb_to_recordset($3::jsonb) x("sourceKey" text,"messageId" text,"dialogId" text,"netCents" bigint,"proofActive" boolean,"purchasedAt" timestamp,"operationId" text,version text)
    ON CONFLICT("creatorId","sourceKey","messageId") DO UPDATE SET "netCents"=EXCLUDED."netCents","proofActive"=EXCLUDED."proofActive",
      "purchasedAt"=EXCLUDED."purchasedAt","operationId"=EXCLUDED."operationId",version=EXCLUDED.version,dirty=TRUE,cursor='',"updatedAt"=clock_timestamp()
    WHERE "CreatorMediaMessageFinancialState".version<>EXCLUDED.version`, agencyId,creatorId,JSON.stringify(stateWrites));
  if (summaries.length) await requestProjection(db, { agencyId, creatorId });
  return changes;
}

function effectiveFact(observed, state, allocation) {
  const result = { ...observed, revenueCents: 0, revenueUnknownCount: 0 };
  if (state?.proofActive) {
    result.soldCount = 1; result.freeCount = 0; result.notOpenedCount = 0; result.uniqueBuyers = 1;
    result.lastSoldAt = state.purchasedAt ? new Date(state.purchasedAt).toISOString() : observed.lastSoldAt;
  } else if (state && observed.purchaseEvidence !== "PROVIDER") {
    // A withdrawn server association cannot be resurrected by an old PC's
    // snapshot that carries no independent provider proof.
    result.soldCount = 0; result.uniqueBuyers = 0; result.lastSoldAt = null;
    result.notOpenedCount = result.freeCount ? 0 : 1;
  }
  if (!result.soldCount) return result;
  const net = state?.proofActive ? money(state.netCents) : null;
  const count = observed.allocationCount || allocation?.count, index = observed.allocationIndex ?? allocation?.index;
  if (net === 0) return result;
  if (net == null || !Number.isSafeInteger(count) || count < 1 || !Number.isSafeInteger(index) || index < 0 || index >= count) {
    result.revenueUnknownCount = 1; return result;
  }
  result.revenueCents = Math.floor(net / count) + (index < net % count ? 1 : 0);
  return result;
}

async function statesForFacts(db, { agencyId, creatorId }, facts) {
  const keys = [...new Map(facts.map(row => [key(row), { sourceKey: row.sourceKey, messageId: row.sourceMessageId || row.messageId }])).values()];
  if (!keys.length) return new Map();
  const rows = await db.$queryRawUnsafe(`SELECT s.* FROM "CreatorMediaMessageFinancialState" s
    JOIN jsonb_to_recordset($3::jsonb) x("sourceKey" text,"messageId" text) ON s."sourceKey"=x."sourceKey" AND s."messageId"=x."messageId"
    WHERE s."agencyId"=$1 AND s."creatorId"=$2`, agencyId, creatorId, JSON.stringify(keys));
  return new Map(rows.map(row => [key(row), row]));
}

async function applyContributionDeltas(db, scope, rows) {
  if (!rows.length) return;
  const deltas = new Map();
  for (const row of rows) {
    const previous = counts(row.before), next = counts(row.after), delta = deltas.get(row.mediaId) || { mediaId: row.mediaId, ...counts(null) };
    for (const field of [...COUNTS, "uniqueBuyers"]) delta[field] += next[field] - previous[field];
    deltas.set(row.mediaId, delta);
  }
  await db.$executeRawUnsafe(`UPDATE "CreatorMediaAsset" a SET
    ${[...COUNTS, "uniqueBuyers"].map(field => `"${field}"=a."${field}"+d."${field}"`).join(",")},
    "averagePriceCents"=CASE WHEN a."soldCount"+d."soldCount">0 THEN ROUND((a."revenueCents"+d."revenueCents")::numeric/(a."soldCount"+d."soldCount"))::int ELSE 0 END,
    "lastSoldAt"=(SELECT c."lastSoldAt" FROM "CreatorMediaUsageContribution" c WHERE c."creatorId"=a."creatorId" AND c."mediaId"=a."mediaId" AND c."lastSoldAt" IS NOT NULL ORDER BY c."lastSoldAt" DESC LIMIT 1),
    "usageUpdatedAt"=clock_timestamp(),"updatedAt"=clock_timestamp()
    FROM jsonb_to_recordset($3::jsonb) d("mediaId" text,${[...COUNTS, "uniqueBuyers"].map(field => `"${field}" int`).join(",")})
    WHERE a."agencyId"=$1 AND a."creatorId"=$2 AND a."mediaId"=d."mediaId"`, scope.agencyId, scope.creatorId, JSON.stringify([...deltas.values()]));
}

async function projectFactPage(db, scope, facts, suppliedStates = null) {
  if (!facts.length) return 0;
  const states = suppliedStates || await statesForFacts(db, scope, facts), changed = [], byContribution = new Map();
  // Old171 did not record attachment count/ordinal. A partial historical page
  // cannot prove the allocation denominator. Refund0 and linkage withdrawal
  // apply now; positive NET remains explicitly unknown until current exact
  // message evidence supplies its complete attachment ordinals.
  for (const row of facts) {
    const observed = row.observedPayload || row.payload, payload = effectiveFact(observed, states.get(key(row)));
    if (row.observedPayload && hashCanonicalJson(row.payload) === hashCanonicalJson(payload)) continue;
    changed.push({ ...row, observed, payload });
    const k = JSON.stringify([row.sourceKey, row.mediaId]);
    const delta = byContribution.get(k) || { sourceKey: row.sourceKey, mediaId: row.mediaId, ...counts(null) };
    for (const field of COUNTS) delta[field] += Number(payload[field] || 0) - Number(row.payload?.[field] || 0);
    byContribution.set(k, delta);
  }
  if (!changed.length) return 0;
  await db.$executeRawUnsafe(`UPDATE "CreatorMediaUsageFact" f SET payload=x.payload,"observedPayload"=x.observed,purchased=(x.payload->>'soldCount')::int=1,"updatedAt"=clock_timestamp()
    FROM jsonb_to_recordset($3::jsonb) x(id text,payload jsonb,observed jsonb) WHERE f."agencyId"=$1 AND f."creatorId"=$2 AND f.id=x.id`, scope.agencyId, scope.creatorId, JSON.stringify(changed));
  const contributions = await db.$queryRawUnsafe(`SELECT c.*, (SELECT f.payload->>'lastSoldAt' FROM "CreatorMediaUsageFact" f
      WHERE f."creatorId"=c."creatorId" AND f."sourceKey"=c."sourceKey" AND f."mediaId"=c."mediaId" AND f.purchased
      ORDER BY (f.payload->>'lastSoldAt') DESC LIMIT 1) AS "factLastSoldAt" FROM "CreatorMediaUsageContribution" c
    JOIN jsonb_to_recordset($3::jsonb) x("sourceKey" text,"mediaId" text) ON c."sourceKey"=x."sourceKey" AND c."mediaId"=x."mediaId"
    WHERE c."agencyId"=$1 AND c."creatorId"=$2`, scope.agencyId, scope.creatorId, JSON.stringify([...byContribution.values()]));
  const updates = [];
  for (const row of contributions) {
    const delta = byContribution.get(JSON.stringify([row.sourceKey, row.mediaId])), baseline = counts(row.factBaseline || row);
    for (const field of COUNTS) baseline[field] += delta[field];
    if (COUNTS.some(field => !Number.isSafeInteger(baseline[field]) || baseline[field] < 0)) throw fail("MEDIA_FINANCIAL_BASELINE_INVALID");
    baseline.uniqueBuyers = baseline.soldCount > 0 ? 1 : 0;
    baseline.lastSoldAt = row.factLastSoldAt || null;
    const held = row.factBaseline?.legacyPending === true;
    const after = held ? { ...counts(row), revenueUnknownCount: Math.max(1, row.revenueUnknownCount) } : baseline;
    updates.push({ id: row.id, mediaId: row.mediaId, before: row, after, baseline: { ...baseline, legacyPending: held } });
  }
  if (updates.length) await db.$executeRawUnsafe(`UPDATE "CreatorMediaUsageContribution" c SET
    ${COUNTS.map(field => `"${field}"=(x.after->>'${field}')::int`).join(",")},"uniqueBuyers"=(x.after->>'uniqueBuyers')::int,
    "lastSoldAt"=(x.after->>'lastSoldAt')::timestamp,"factBaseline"=x.baseline,"updatedAt"=clock_timestamp()
    FROM jsonb_to_recordset($3::jsonb) x(id text,after jsonb,baseline jsonb)
    WHERE c.id=x.id AND c."agencyId"=$1 AND c."creatorId"=$2`, scope.agencyId,scope.creatorId,JSON.stringify(updates));
  await applyContributionDeltas(db, scope, updates);
  return changed.length;
}

async function enumerateAdoption({ db }) {
  return runRootCommit(db, async ({ tx }) => {
    const [state] = await tx.$queryRawUnsafe('SELECT * FROM "MaintenanceLaneState" WHERE key=$1 FOR UPDATE SKIP LOCKED', ADOPTION_KEY);
    if (!state || state.completedAt) return { selected: 0, completed: true };
    const cursor = state.cursor;
    if (typeof cursor?.upperId !== "string") throw fail("MEDIA_ADOPTION_CURSOR_INVALID");
    const rows = await tx.creatorAccount.findMany({ where: { id: { gt: cursor.afterId || "", lte: cursor.upperId }, deletedAt: null }, select: { id: true, agencyId: true }, orderBy: { id: "asc" }, take: 5 });
    for (const row of rows) {
      await lockAgencyLifecycleBarrier({ db: tx, agencyId: row.agencyId });
      await tx.$executeRawUnsafe(`INSERT INTO "CreatorMediaFinancialAdoptionState"("creatorId","agencyId","upperSaleId")
        VALUES($1,$2,COALESCE((SELECT id FROM "CreatorSale" WHERE "creatorId"=$1 ORDER BY id DESC LIMIT 1),'')) ON CONFLICT("creatorId") DO NOTHING`, row.id, row.agencyId);
      await requestProjection(tx, { agencyId: row.agencyId, creatorId: row.id });
    }
    const completed = rows.length < 5 || rows.at(-1)?.id === cursor.upperId;
    await tx.maintenanceLaneState.update({ where: { key: ADOPTION_KEY }, data: { cursor: { ...cursor, afterId: rows.at(-1)?.id || cursor.afterId }, completedAt: completed ? new Date() : null } });
    return { selected: rows.length, completed };
  });
}

async function processPage({ db, item, ownerToken }) {
  if (item.workClass !== WORK_CLASS || item.objectId !== item.creatorId) throw fail("MEDIA_FINANCIAL_SCOPE_INVALID");
  return runRootCommit(db, async ({ tx }) => {
    const lifecycle = await lockAgencyLifecycleBarrier({ db: tx, agencyId: item.agencyId });
    // Producers acquire fact -> media -> Work. Keep that order for adoption
    // and never invert it while another publisher waits for this claim.
    await lockCreatorFacts(tx, item.agencyId, item.creatorId);
    await lock(tx, item.agencyId, item.creatorId);
    own(await work.lockDomainWorkClaimForCommit({ db: tx, item, ownerToken }));
    if (await pauseDeletedAgencyProjection({ db: tx, lifecycle, item, ownerToken })) return { processed: 0 };
    const scope = { agencyId: item.agencyId, creatorId: item.creatorId };
    const creator = await tx.creatorAccount.findFirst({ where: { id: item.creatorId, agencyId: item.agencyId, deletedAt: null }, select: { id: true } });
    if (!creator) { own(await work.ackDomainWorkClaim({ db: tx, item, ownerToken, terminalCause: "CREATOR_RETIRED" })); return { processed: 0, completed: true }; }
    const [adopt] = await tx.$queryRawUnsafe('SELECT * FROM "CreatorMediaFinancialAdoptionState" WHERE "creatorId"=$1 AND "completedAt" IS NULL', item.creatorId);
    let processed = 0;
    if (adopt?.phase === "SALES") {
      const rows = await tx.creatorSale.findMany({ where: { agencyId: item.agencyId, creatorId: item.creatorId, id: { gt: adopt.saleCursor, lte: adopt.upperSaleId } }, include: { fan: { select: { onlyFansUserId: true } } }, orderBy: { id: "asc" }, take: 100 });
      const changes = await publishCanonicalMediaSales({ db: tx, ...scope, rows, adoption: true });
      if (changes.length) await require("./creator-entity-change-service").publishEntityChanges({ db: tx, ...scope, changes });
      await tx.$executeRawUnsafe('UPDATE "CreatorMediaFinancialAdoptionState" SET "saleCursor"=$2,phase=$3 WHERE "creatorId"=$1', item.creatorId, rows.at(-1)?.id || adopt.saleCursor, rows.length < 100 ? "REVERSE" : "SALES");
      processed = rows.length;
    } else if (adopt?.phase === "REVERSE") {
      //171 retained old exact positive bindings after a sale moved. Adopt the
      //saved entity rows by their old CreatorSale identity, in bounded keysets.
      const rows = await tx.$queryRawUnsafe(`SELECT "entityId","sourceIdentity",payload FROM "CreatorEntityCurrent"
        WHERE "agencyId"=$1 AND "creatorId"=$2 AND "entityType"='MESSAGE_PURCHASE' AND "entityId">$3
        ORDER BY "entityId" LIMIT $4`,item.agencyId,item.creatorId,adopt.factMessage,PAGE);
      const ids = rows.filter(row=>row.sourceIdentity.startsWith('CreatorSale:')).map(row=>row.sourceIdentity.slice(12));
      const links = ids.length ? await tx.$queryRawUnsafe('SELECT * FROM "CreatorMediaSaleLink" WHERE "creatorId"=$1 AND "saleId"=ANY($2::text[])',item.creatorId,ids) : [];
      const byId = new Map(links.map(row=>[row.saleId,row])), affected = new Map();
      for (const row of rows) {
        const link = byId.get(row.sourceIdentity.slice(12));
        if (!row.sourceIdentity.startsWith('CreatorSale:') || !row.payload?.dialogId || !row.payload?.messageId) continue;
        const old = { sourceKey: sourceKey(item.creatorId,row.payload.dialogId), messageId: row.payload.messageId, dialogId: row.payload.dialogId };
        if (!link || link.sourceKey!==old.sourceKey || link.messageId!==old.messageId || !link.proofActive) affected.set(key(old),old);
      }
      if (affected.size) {
        const changes = await publishMessageStates({db:tx,...scope,affected});
        await require('./creator-entity-change-service').publishEntityChanges({db:tx,...scope,changes});
      }
      const done = rows.length < PAGE;
      await tx.$executeRawUnsafe('UPDATE "CreatorMediaFinancialAdoptionState" SET "factMessage"=$2,phase=$3 WHERE "creatorId"=$1', item.creatorId, done?'':rows.at(-1).entityId,done?'FACTS':'REVERSE');
      processed=rows.length;
    } else if (adopt?.phase === "FACTS") {
      const rows = await tx.$queryRawUnsafe(`SELECT * FROM "CreatorMediaUsageFact" WHERE "agencyId"=$1 AND "creatorId"=$2
        AND ("sourceKey","sourceMessageId","mediaId")>($3,$4,$5) ORDER BY "sourceKey","sourceMessageId","mediaId" LIMIT $6`, item.agencyId, item.creatorId, adopt.factSource, adopt.factMessage, adopt.factMedia, PAGE);
      processed = await projectFactPage(tx, scope, rows);
      const last = rows.at(-1);
      await tx.$executeRawUnsafe(`UPDATE "CreatorMediaFinancialAdoptionState" SET "factSource"=$2,"factMessage"=$3,"factMedia"=$4,
        phase=$5,"completedAt"=CASE WHEN $5='COMPLETE' THEN clock_timestamp() ELSE NULL END WHERE "creatorId"=$1`, item.creatorId, last?.sourceKey || adopt.factSource, last?.sourceMessageId || adopt.factMessage, last?.mediaId || adopt.factMedia, rows.length < PAGE ? "COMPLETE" : "FACTS");
    } else {
      const [state] = await tx.$queryRawUnsafe('SELECT * FROM "CreatorMediaMessageFinancialState" WHERE "creatorId"=$1 AND dirty ORDER BY "sourceKey","messageId" LIMIT 1', item.creatorId);
      if (state) {
        const rows = await tx.$queryRawUnsafe(`SELECT * FROM "CreatorMediaUsageFact" WHERE "agencyId"=$1 AND "creatorId"=$2 AND "sourceKey"=$3 AND "sourceMessageId"=$4 AND "mediaId">$5 ORDER BY "mediaId" LIMIT $6`, item.agencyId, item.creatorId, state.sourceKey, state.messageId, state.cursor, PAGE);
        processed = await projectFactPage(tx, scope, rows, new Map([[key(state), state]]));
        await tx.$executeRawUnsafe('UPDATE "CreatorMediaMessageFinancialState" SET cursor=$4,dirty=$5 WHERE "creatorId"=$1 AND "sourceKey"=$2 AND "messageId"=$3', item.creatorId, state.sourceKey, state.messageId, rows.at(-1)?.mediaId || state.cursor, rows.length === PAGE);
      }
    }
    const [pending] = await tx.$queryRawUnsafe(`SELECT EXISTS(SELECT 1 FROM "CreatorMediaMessageFinancialState" WHERE "creatorId"=$1 AND dirty)
      OR EXISTS(SELECT 1 FROM "CreatorMediaFinancialAdoptionState" WHERE "creatorId"=$1 AND "completedAt" IS NULL) AS pending`, item.creatorId);
    if (processed || !pending.pending) await require("./media-entity-change-service").publishMediaResult({ db: tx, ...scope, kind: "FINANCIAL_PROJECTED",
      state: { workId: item.id, requestedRevision: String(item.requestedRevision), cursor: adopt?.saleCursor || adopt?.factMedia || "", completed: !pending.pending } });
    if (pending.pending) own(await work.yieldDomainWorkClaim({ db: tx, item, ownerToken }));
    else own(await work.ackDomainWorkClaim({ db: tx, item, ownerToken }));
    return { processed, completed: !pending.pending };
  }, { profile: "JOB_CHUNK", timeout: 15000, authority: { kind: WORK_CLASS, agencyId: item.agencyId, creatorId: item.creatorId } });
}

async function financialProjectionState(db, creatorId) {
  const [row] = await db.$queryRawUnsafe(`SELECT
    EXISTS(SELECT 1 FROM "CreatorMediaMessageFinancialState" WHERE "creatorId"=$1 AND dirty) AS pending,
    NOT (EXISTS(SELECT 1 FROM "CreatorMediaFinancialAdoptionState" WHERE "creatorId"=$1 AND "completedAt" IS NULL)
    OR EXISTS(SELECT 1 FROM "CreatorMediaUsageSourceState" WHERE "creatorId"=$1 AND "factProtocol"=0)
    OR EXISTS(SELECT 1 FROM "MaintenanceLaneState" m WHERE m.key=$2 AND m."completedAt" IS NULL
      AND $1<=m.cursor->>'upperId' AND NOT EXISTS(SELECT 1 FROM "CreatorMediaFinancialAdoptionState" WHERE "creatorId"=$1))
    ) AS available`, creatorId, ADOPTION_KEY);
  const available = row?.available === true;
  return { available, ready: available && row?.pending === false, pending: row?.pending === true };
}
async function financialProjectionReady(db, creatorId) {
  return (await financialProjectionState(db, creatorId)).ready;
}

async function runSweep({ db = require("../prisma"), limit = 4, maxRuntimeMs = 4000 } = {}) {
  const started = performance.now(), report = { ok: true, enumeration: await enumerateAdoption({ db }), processed: 0, completed: 0, failed: 0 };
  for (let i = 0; i < Math.min(8, Math.max(1, limit)) && (i === 0 || performance.now() - started < maxRuntimeMs); i++) {
    const claim = await work.claimDomainWorkBatch({ db, workClass: WORK_CLASS, limit: 1, perAgencyQuantum: 1, perPartitionQuantum: 1, leaseMs: 120000 });
    if (claim.skipped && !["creator_lifecycle_contended", "none_due"].includes(claim.reason)) { report.ok = false; report.reason = claim.reason; break; }
    const item = claim.items?.[0]; if (!item) break;
    try { const result = await processPage({ db, item, ownerToken: claim.ownerToken }); report.processed += result.processed; if (result.completed) report.completed++; }
    catch (error) { await work.failDomainWorkClaim({ db, item, ownerToken: claim.ownerToken, error }); report.ok = false; report.failed++; report.reason = error.code || error.message; }
  }
  return report;
}

module.exports = { WORK_CLASS, ADOPTION_KEY, PAGE, COUNTS, sourceKey, lock, counts, verifiedLegacyRows, publishCanonicalMediaSales,
  effectiveFact, statesForFacts, publishMessageStates, financialProjectionState, financialProjectionReady, applyContributionDeltas, projectFactPage, enumerateAdoption, processPage, runSweep };
