"use strict";

const crypto = require("node:crypto");
const { hashCanonicalJson } = require("./realtime-receipt-hash");
const { publishMediaResult } = require("./media-entity-change-service");
const MAX_FACTS = 2000, MAX_LEGACY_MEDIA = 2000, MAX_RUNS = 8;
const COUNTS = ["sentCount", "soldCount", "notOpenedCount", "freeCount", "revenueCents"];

function fail(code, sourceKey, reason, status = 409) {
  throw Object.assign(new Error(code), { code, sourceKey, reason, status });
}
function text(value, max) { return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value; }
function timestamp(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null; }
function key(fact) { return JSON.stringify([fact.messageId, fact.mediaId]); }
function compareKey(a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0; }
function zero() { return { sentCount: 0, soldCount: 0, notOpenedCount: 0, freeCount: 0, revenueCents: 0, uniqueBuyers: 0, lastSoldAt: null }; }
function counters(row) {
  return { ...Object.fromEntries(COUNTS.map(field => [field, Number(row?.[field] || 0)])),
    uniqueBuyers: Number(row?.uniqueBuyers || 0), lastSoldAt: row?.lastSoldAt ? new Date(row.lastSoldAt).toISOString() : null };
}

// sourceRevision is an opaque producer revision, never a cross-device clock.
// Every accepted contribution is attached to immutable message/media identity.
function normalizeUsageFactSource(input) {
  const sourceKey = input?.sourceKey;
  if (input?.protocolVersion !== 2) fail("MEDIA_USAGE_FACT_PROTOCOL_REQUIRED", sourceKey, "aggregate snapshots cannot prove complete or newer facts");
  if (!text(sourceKey, 240) || !text(input.sourceRevision, 100) || !timestamp(input.capturedAt)) fail("MEDIA_USAGE_FACT_INVALID", sourceKey, "source identity");
  const coverage = input.coverage, page = input.factPage;
  if (!coverage || coverage.version !== 1 || typeof coverage.complete !== "boolean" || !text(coverage.localRevision, 200)
    || !Number.isSafeInteger(coverage.messageCount) || coverage.messageCount < 0
    || !(coverage.oldestMessageAt === null || timestamp(coverage.oldestMessageAt))
    || !(coverage.newestMessageAt === null || timestamp(coverage.newestMessageAt))
    || (coverage.messageCount === 0 && (coverage.oldestMessageAt !== null || coverage.newestMessageAt !== null))
    || (coverage.messageCount > 0 && (!coverage.oldestMessageAt || !coverage.newestMessageAt || Date.parse(coverage.oldestMessageAt) > Date.parse(coverage.newestMessageAt)))) {
    fail("MEDIA_USAGE_FACT_INVALID", sourceKey, "coverage");
  }
  if (!Array.isArray(input.facts) || input.facts.length > MAX_FACTS || Buffer.byteLength(JSON.stringify(input)) > 4 * 1024 * 1024) {
    fail("MEDIA_LIBRARY_USAGE_SOURCE_TOO_LARGE", sourceKey, "bounded fact page required", 413);
  }
  const runId = crypto.createHash("sha256").update(JSON.stringify([sourceKey, coverage.localRevision])).digest("hex");
  if (!page || page.runId !== runId || !Number.isSafeInteger(page.pageNumber) || page.pageNumber < 1
    || typeof page.done !== "boolean" || !/^[a-f0-9]{64}$/.test(page.pageHash || "")
    || !(page.previousHash === null || /^[a-f0-9]{64}$/.test(page.previousHash || ""))
    || page.pageHash !== hashCanonicalJson(input.facts)
    || (page.done && (!Number.isSafeInteger(page.totalFacts) || page.totalFacts < 0))
    || (!page.done && (page.totalFacts !== undefined || input.facts.length === 0))) {
    fail("MEDIA_USAGE_FACT_INVALID", sourceKey, "page manifest");
  }
  let prior = null;
  const facts = input.facts.map(fact => {
    if (!fact || !text(fact.messageId, 240) || !text(fact.mediaId, 240) || fact.sentCount !== 1
      || ![0, 1].includes(fact.soldCount) || ![0, 1].includes(fact.notOpenedCount) || ![0, 1].includes(fact.freeCount)
      || fact.soldCount + fact.notOpenedCount + fact.freeCount !== 1
      || !Number.isSafeInteger(fact.revenueCents) || fact.revenueCents < 0 || fact.revenueCents > 2_000_000_000
      || fact.uniqueBuyers !== fact.soldCount || (!fact.soldCount && fact.revenueCents !== 0)
      || (fact.soldCount ? !timestamp(fact.lastSoldAt) : fact.lastSoldAt !== null)) fail("MEDIA_USAGE_FACT_INVALID", sourceKey, "fact contribution");
    const next = [fact.messageId, fact.mediaId];
    if (prior && compareKey(prior, next) >= 0) fail("MEDIA_USAGE_FACT_INVALID", sourceKey, "fact keyset order");
    prior = next;
    return { messageId: fact.messageId, mediaId: fact.mediaId, ...counters(fact) };
  });
  return { protocolVersion: 2, sourceKey, sourceRevision: input.sourceRevision, capturedAt: new Date(input.capturedAt),
    coverage: { version: 1, complete: coverage.complete, localRevision: coverage.localRevision, messageCount: coverage.messageCount,
      oldestMessageAt: coverage.oldestMessageAt && timestamp(coverage.oldestMessageAt), newestMessageAt: coverage.newestMessageAt && timestamp(coverage.newestMessageAt) },
    facts, factPage: { ...page } };
}

function advanceRun(state, source) {
  const { factPage: page, coverage, sourceKey } = source, now = Date.now();
  const runs = (state?.coverage?.version === 2 && Array.isArray(state.coverage.runs) ? state.coverage.runs : [])
    .filter(run => Number(run.expiresAt) > now).slice(-MAX_RUNS);
  const prior = runs.find(run => run.runId === page.runId);
  const coverageHash = hashCanonicalJson(coverage);
  if (prior) {
    if (prior.coverageHash !== coverageHash || prior.sourceRevision !== source.sourceRevision || prior.capturedAt !== source.capturedAt.toISOString()) {
      fail("MEDIA_USAGE_FACT_RUN_CONFLICT", sourceKey, "run content changed");
    }
    if (page.pageNumber <= prior.pageNumber) {
      if (page.pageNumber === prior.pageNumber && hashCanonicalJson(page) !== prior.manifestHash) fail("MEDIA_USAGE_FACT_RUN_CONFLICT", sourceKey, "page content changed");
      return { duplicate: true };
    }
    if (prior.done || page.pageNumber !== prior.pageNumber + 1 || page.previousHash !== prior.pageHash) fail("MEDIA_USAGE_FACT_PAGE_GAP", sourceKey, "page hash chain");
  } else if (page.pageNumber !== 1 || page.previousHash !== null) fail("MEDIA_USAGE_FACT_RUN_RESTART_REQUIRED", sourceKey, "bounded run receipt expired; restart from page one");
  if (prior?.lastKey && source.facts.length && compareKey(prior.lastKey, [source.facts[0].messageId, source.facts[0].mediaId]) >= 0) {
    fail("MEDIA_USAGE_FACT_RUN_CONFLICT", sourceKey, "page keyset overlaps");
  }
  const receivedFacts = (prior?.receivedFacts || 0) + source.facts.length;
  let previousMessage = prior?.lastKey?.[0], receivedMessages = prior?.receivedMessages || 0;
  for (const fact of source.facts) if (fact.messageId !== previousMessage) { receivedMessages += 1; previousMessage = fact.messageId; }
  if (receivedMessages > coverage.messageCount) fail("MEDIA_USAGE_FACT_RUN_CONFLICT", sourceKey, "facts exceed message coverage");
  if (page.done && page.totalFacts !== receivedFacts) fail("MEDIA_USAGE_FACT_RUN_CONFLICT", sourceKey, "manifest fact count");
  const last = source.facts.at(-1);
  const receipt = { runId: page.runId, pageNumber: page.pageNumber, pageHash: page.pageHash, manifestHash: hashCanonicalJson(page), receivedFacts, receivedMessages,
    lastKey: last ? [last.messageId, last.mediaId] : prior?.lastKey || null, done: page.done,
    coverageHash, sourceRevision: source.sourceRevision, capturedAt: source.capturedAt.toISOString(), expiresAt: now + 86_400_000 };
  // Independent PCs can make progress. Eviction only makes an old producer
  // restart its bounded traversal; stable facts make that replay idempotent.
  return { duplicate: false, coverage: { version: 2, fullCoverage: state?.coverage?.fullCoverage || null,
    runs: [...runs.filter(run => run.runId !== page.runId), receipt].slice(-MAX_RUNS) } };
}

async function mergeUsageFactSourceTx(tx, { agencyId, creatorId, source, recomputeUsage }) {
  const scope = { agencyId, creatorId, sourceKey: source.sourceKey };
  const state = await tx.creatorMediaUsageSourceState.findUnique({ where: { creatorId_sourceKey: { creatorId, sourceKey: source.sourceKey } } });
  const run = advanceRun(state, source);
  if (run.duplicate) return { accepted: false, stale: true, acceptedItems: 0, missingMediaIds: [], awaitingCompleteSource: state?.factProtocol === 0,
    awaitingCompleteReason: state?.coverage?.awaitingCompleteReason || "COMPLETE_MANIFEST_REQUIRED" };
  // A source absent from the old atomic state+aggregate writer has no legacy
  // aggregate to replace. The v2 hot path never counts/scans its source history.
  const legacy = state?.factProtocol === 0;
  let activate = legacy && source.coverage.complete && source.factPage.done;
  let legacyRows = [];
  const mediaIds = [...new Set(source.facts.map(fact => fact.mediaId))];
  const contributions = mediaIds.length ? await tx.creatorMediaUsageContribution.findMany({ where: { ...scope, mediaId: { in: mediaIds } }, take: MAX_FACTS }) : [];
  const contributionById = new Map(contributions.map(row => [row.mediaId, row]));
  if (activate) {
    // Only original legacy rows need an atomic switch. The former aggregate API
    // admitted at most 2000 distinct media; new fact media project immediately
    // and never enlarge this set. A partial index serves this bounded lookup.
    const pending = await tx.$queryRawUnsafe(`SELECT * FROM "CreatorMediaUsageContribution"
      WHERE "agencyId"=$1 AND "creatorId"=$2 AND "sourceKey"=$3
        AND ("factBaseline" IS NULL OR "factBaseline"->>'legacyPending'='true') LIMIT $4`,
    agencyId, creatorId, source.sourceKey, MAX_LEGACY_MEDIA + 1);
    if (pending.length > MAX_LEGACY_MEDIA) fail("MEDIA_USAGE_LEGACY_BASELINE_INVALID", source.sourceKey, "legacy aggregate exceeds the former writer bound");
    for (const row of pending) contributionById.set(row.mediaId, row);
    legacyRows = pending;
  }
  const existing = source.facts.length ? await tx.$queryRawUnsafe(`
    SELECT f."sourceMessageId", f."mediaId", f.payload, f.purchased FROM "CreatorMediaUsageFact" f
    JOIN jsonb_to_recordset($4::jsonb) AS page("messageId" text, "mediaId" text)
      ON f."sourceMessageId"=page."messageId" AND f."mediaId"=page."mediaId"
    WHERE f."agencyId"=$1 AND f."creatorId"=$2 AND f."sourceKey"=$3`, agencyId, creatorId, source.sourceKey, JSON.stringify(source.facts)) : [];
  const previous = new Map(existing.map(row => [key({ messageId: row.sourceMessageId, mediaId: row.mediaId }), row]));
  const changed = [], baselines = new Map(), pendingLegacy = new Set();
  for (const fact of source.facts) {
    const old = previous.get(key(fact));
    if (old && (hashCanonicalJson(old.payload) === hashCanonicalJson(fact) || (old.purchased && !fact.soldCount))) continue;
    if (old && (old.purchased || !fact.soldCount)) fail("MEDIA_USAGE_FACT_CONFLICT", source.sourceKey, `accounting evidence changed for ${fact.messageId}:${fact.mediaId}`);
    const row = contributionById.get(fact.mediaId);
    if (legacy && row && (!row.factBaseline || row.factBaseline.legacyPending === true)) pendingLegacy.add(fact.mediaId);
    const baseline = baselines.get(fact.mediaId) || counters(row?.factBaseline || (!legacy ? row : null) || zero());
    for (const field of COUNTS) {
      baseline[field] += fact[field] - Number(old?.payload?.[field] || 0);
      if (!Number.isSafeInteger(baseline[field]) || baseline[field] < 0 || baseline[field] > 2_000_000_000) fail("MEDIA_USAGE_FACT_CONFLICT", source.sourceKey, "aggregate overflow or missing baseline");
    }
    baseline.uniqueBuyers = baseline.soldCount > 0 ? 1 : 0;
    if (fact.lastSoldAt && (!baseline.lastSoldAt || fact.lastSoldAt > baseline.lastSoldAt)) baseline.lastSoldAt = fact.lastSoldAt;
    baselines.set(fact.mediaId, baseline); changed.push(fact);
  }
  const active = mediaIds.length ? await tx.creatorMediaAsset.findMany({ where: { agencyId, creatorId, catalogActive: true, mediaId: { in: mediaIds } }, select: { mediaId: true }, take: mediaIds.length }) : [];
  const activeIds = new Set(active.map(row => row.mediaId));
  if (changed.length) {
    await tx.$executeRawUnsafe(`INSERT INTO "CreatorMediaUsageFact"
      (id,"agencyId","creatorId","sourceKey","sourceMessageId","mediaId",payload,purchased,"sourceRevision","lastSeenRunId","createdAt","updatedAt")
      SELECT page.id,$1,$2,$3,page."messageId",page."mediaId",page.payload,page.purchased,$5,$6,clock_timestamp(),clock_timestamp()
      FROM jsonb_to_recordset($4::jsonb) AS page(id text,"messageId" text,"mediaId" text,payload jsonb,purchased boolean)
      ON CONFLICT ("creatorId","sourceKey","sourceMessageId","mediaId") DO UPDATE SET payload=EXCLUDED.payload,purchased=EXCLUDED.purchased,
        "sourceRevision"=EXCLUDED."sourceRevision","lastSeenRunId"=EXCLUDED."lastSeenRunId","updatedAt"=EXCLUDED."updatedAt"`,
    agencyId, creatorId, source.sourceKey, JSON.stringify(changed.map(fact => ({ id: crypto.randomUUID(), messageId: fact.messageId, mediaId: fact.mediaId, payload: fact, purchased: Boolean(fact.soldCount) }))), source.sourceRevision, source.factPage.runId);
  }
  if (activate) for (const row of legacyRows) {
    pendingLegacy.add(row.mediaId);
    if (!baselines.has(row.mediaId)) baselines.set(row.mediaId, counters(row.factBaseline || zero()));
  }
  // A full traversal on a stale PC does not explain old positive purchase
  // evidence whose message identities were never stored by the aggregate API.
  // Keep that exact old projection until facts account for it. This is a
  // conservative migration hold, never a max(old,new) accounting projection.
  const unexplainedLegacy = activate && legacyRows.some(row => ["sentCount", "soldCount", "revenueCents"]
    .some(field => baselines.get(row.mediaId)[field] < Number(row[field] || 0)));
  if (unexplainedLegacy) activate = false;
  const affected = [...baselines.keys()];
  if (affected.length) {
    await tx.creatorMediaAsset.createMany({ data: affected.map(mediaId => ({ id: crypto.randomUUID(), agencyId, creatorId, mediaId,
      catalogActive: false, sortingStatus: "UNSORTED", firstSeenAt: source.capturedAt, lastSeenAt: source.capturedAt })), skipDuplicates: true });
    const assets = await tx.creatorMediaAsset.findMany({ where: { agencyId, creatorId, mediaId: { in: affected } }, select: { id: true, mediaId: true }, take: affected.length });
    const assetIds = new Map(assets.map(row => [row.mediaId, row.id]));
    const rows = affected.map(mediaId => ({ id: crypto.randomUUID(), mediaId, assetId: assetIds.get(mediaId),
      factBaseline: { ...baselines.get(mediaId), legacyPending: !activate && pendingLegacy.has(mediaId) },
      ...(!activate && pendingLegacy.has(mediaId) ? counters(contributionById.get(mediaId)) : baselines.get(mediaId)) }));
    await tx.$executeRawUnsafe(`INSERT INTO "CreatorMediaUsageContribution"
      (id,"agencyId","creatorId","sourceKey","sourceRevision","assetId","mediaId","factBaseline","sentCount","soldCount","notOpenedCount","freeCount","revenueCents","uniqueBuyers","lastSoldAt","capturedAt","createdAt","updatedAt")
      SELECT p.id,$1,$2,$3,$5,p."assetId",p."mediaId",p."factBaseline",p."sentCount",p."soldCount",p."notOpenedCount",p."freeCount",p."revenueCents",p."uniqueBuyers",p."lastSoldAt",$6,clock_timestamp(),clock_timestamp()
      FROM jsonb_to_recordset($4::jsonb) AS p(id text,"assetId" text,"mediaId" text,"factBaseline" jsonb,"sentCount" int,"soldCount" int,"notOpenedCount" int,"freeCount" int,"revenueCents" int,"uniqueBuyers" int,"lastSoldAt" timestamptz)
      ON CONFLICT ("creatorId","sourceKey","mediaId") DO UPDATE SET "assetId"=EXCLUDED."assetId","sourceRevision"=EXCLUDED."sourceRevision",
        "factBaseline"=EXCLUDED."factBaseline","sentCount"=EXCLUDED."sentCount","soldCount"=EXCLUDED."soldCount","notOpenedCount"=EXCLUDED."notOpenedCount",
        "freeCount"=EXCLUDED."freeCount","revenueCents"=EXCLUDED."revenueCents","uniqueBuyers"=EXCLUDED."uniqueBuyers","lastSoldAt"=EXCLUDED."lastSoldAt",
        "capturedAt"=GREATEST("CreatorMediaUsageContribution"."capturedAt",EXCLUDED."capturedAt"),"updatedAt"=EXCLUDED."updatedAt"`,
    agencyId, creatorId, source.sourceKey, JSON.stringify(rows), source.sourceRevision, source.capturedAt);
  }
  if (source.coverage.complete && source.factPage.done) run.coverage.fullCoverage = source.coverage;
  run.coverage.awaitingCompleteReason = legacy && !activate
    ? (unexplainedLegacy || state?.coverage?.awaitingCompleteReason === "LEGACY_EVIDENCE_UNEXPLAINED" ? "LEGACY_EVIDENCE_UNEXPLAINED" : "COMPLETE_MANIFEST_REQUIRED") : null;
  await tx.creatorMediaUsageSourceState.upsert({ where: { creatorId_sourceKey: { creatorId, sourceKey: source.sourceKey } },
    create: { ...scope, sourceRevision: source.sourceRevision, capturedAt: source.capturedAt, coverage: run.coverage, factProtocol: legacy && !activate ? 0 : 2 },
    update: { sourceRevision: source.sourceRevision, capturedAt: new Date(Math.max(source.capturedAt.getTime(), new Date(state?.capturedAt || 0).getTime())), coverage: run.coverage, factProtocol: legacy && !activate ? 0 : 2 } });
  const projected = affected.filter(mediaId => activate || !pendingLegacy.has(mediaId));
  if (projected.length) {
    await recomputeUsage(tx, agencyId, creatorId, projected);
    await publishMediaResult({ db: tx, agencyId, creatorId, kind: "USAGE_FACTS", entityId: `usage:${source.sourceKey}`,
      state: { runId: source.factPage.runId, pageHash: source.factPage.pageHash, baseline: [...baselines] } });
  }
  return { accepted: true, stale: false, acceptedItems: changed.length, missingMediaIds: mediaIds.filter(id => !activeIds.has(id)),
    awaitingCompleteSource: legacy && !activate, awaitingCompleteReason: run.coverage.awaitingCompleteReason };
}

module.exports = { normalizeUsageFactSource, mergeUsageFactSourceTx };
