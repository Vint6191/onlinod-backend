"use strict";
const assert = require("node:assert/strict"), crypto = require("node:crypto"), path = require("node:path");
const root = path.resolve(__dirname, "../.."), { createScaleSqlRuntime } = require("../test-support/scale-sql-runtime.cjs");
const { scope } = require("./analytics-traffic/fixture.cjs"), { runRootCommit, currentCommitContext } = require(root + "/src/services/db-commit-kernel");
const { hashCanonicalJson } = require(root + "/src/services/realtime-receipt-hash");
const pass = label => console.log("PASS", label), capturedAt = "2026-10-21T10:00:00.000Z";
const fact = (messageId, mediaId, sold = false) => ({ messageId, mediaId, sentCount: 1, soldCount: Number(sold),
  notOpenedCount: Number(!sold), freeCount: 0, revenueCents: sold ? 500 : 0, uniqueBuyers: Number(sold), lastSoldAt: sold ? capturedAt : null });
function source(sourceKey, revision, facts, { complete = true, pageNumber = 1, previousHash = null, done = true, totalFacts = facts.length } = {}) {
  return { protocolVersion: 2, sourceKey, sourceRevision: revision, capturedAt,
    coverage: { version: 1, complete, localRevision: revision, messageCount: 10000, oldestMessageAt: capturedAt, newestMessageAt: capturedAt }, facts,
    factPage: { runId: crypto.createHash("sha256").update(JSON.stringify([sourceKey, revision])).digest("hex"),
      pageNumber, previousHash, pageHash: hashCanonicalJson(facts), done, ...(done ? { totalFacts } : {}) } };
}
(async () => {
  const f = await createScaleSqlRuntime();
  try {
    const { db } = f, s = await scope(db), own = { agencyId: s.agencyId, creatorId: s.creatorId };
    require.cache[require.resolve(root + "/src/prisma")] = { exports: db };
    const media = require(root + "/src/services/media-library-service"), feed = require(root + "/src/services/creator-entity-change-service");
    const commit = fn => runRootCommit(db, ({ tx }) => fn(tx));
    const submit = (sources, extra = {}) => media.replaceUsageSources({ ...own, db, sources, ...extra });
    const asset = mediaId => db.creatorMediaAsset.findUnique({ where: { creatorId_mediaId: { creatorId: s.creatorId, mediaId } } });
    const changes = () => commit(tx => feed.readEntityChanges({ db: tx, ...own }));
    await assert.rejects(() => submit([{ sourceKey: "legacy", sourceRevision: capturedAt, items: [] }]), { code: "MEDIA_USAGE_FACT_PROTOCOL_REQUIRED" });
    const initial = source("dialog", "first-complete", [fact("001", "m1"), fact("002", "m2")]);
    await submit([initial]);
    assert.equal((await asset("m1")).sentCount, 1); assert.equal((await asset("m2")).sentCount, 1);
    assert.equal((await asset("m1")).catalogActive, false);
    const beforeReplay = (await changes()).headRevision;
    assert.equal((await submit([initial])).staleSources, 1); assert.equal((await changes()).headRevision, beforeReplay);
    await submit([source("dialog", "newer-partial", [fact("001", "m1", true)], { complete: false })]);
    assert.equal((await asset("m2")).sentCount, 1); assert.equal((await asset("m1")).soldCount, 1);
    const purchasedHead = (await changes()).headRevision;
    await submit([source("dialog", "2099-stale-full", [fact("001", "m1"), fact("002", "m2")])]);
    assert.equal((await asset("m1")).soldCount, 1); assert.equal((await asset("m1")).revenueCents, 500);
    assert.equal((await changes()).headRevision, purchasedHead);
    await submit([source("dialog", "older-clock-new-fact", [fact("003", "m1", true)], { complete: false })]);
    assert.equal((await asset("m1")).sentCount, 2); assert.equal((await asset("m1")).soldCount, 2);
    assert.equal((await asset("m1")).uniqueBuyers, 1); assert.equal((await asset("m1")).revenueCents, 1000);
    pass("partial newer PC retains missing facts; stale full PC cannot undo purchase; exact per-fact delta avoids max-count approximation");

    const beforeConflict = (await changes()).headRevision;
    const conflict = source("dialog", "conflict", [{ ...fact("001", "m1", true), revenueCents: 700 }, fact("004", "m3")]);
    await assert.rejects(() => submit([conflict]), { code: "MEDIA_USAGE_FACT_CONFLICT" });
    assert.equal(await asset("m3"), null); assert.equal((await changes()).headRevision, beforeConflict);
    await assert.rejects(() => commit(async tx => {
      await media.replaceUsageSources({ ...own, db: tx, sources: [source("dialog", "rollback", [fact("005", "m4")])] });
      throw Error("OWNER_ROLLBACK");
    }), /OWNER_ROLLBACK/);
    assert.equal(await asset("m4"), null); assert.equal((await changes()).headRevision, beforeConflict);
    pass("conflicting accounting evidence and owner failure roll back fact, aggregate, receipt and reverse publication together");

    const legacy = await db.creatorMediaAsset.create({ data: { ...own, mediaId: "legacy-media", sentCount: 2, soldCount: 1, revenueCents: 500 } });
    await db.creatorMediaUsageSourceState.create({ data: { ...own, sourceKey: "legacy-dialog", sourceRevision: capturedAt } });
    await db.creatorMediaUsageContribution.create({ data: { ...own, assetId: legacy.id, mediaId: legacy.mediaId, sourceKey: "legacy-dialog", sourceRevision: capturedAt, sentCount: 2, soldCount: 1, revenueCents: 500 } });
    const first = source("legacy-dialog", "full-import", [fact("001", "legacy-media", true)], { done: false });
    const firstResult = await submit([first]);
    assert.deepEqual(firstResult.awaitingCompleteSources, ["legacy-dialog"]);
    assert.deepEqual((await submit([first])).awaitingCompleteSources, ["legacy-dialog"]);
    assert.equal((await asset("legacy-media")).sentCount, 2);
    const gap = source("legacy-dialog", "full-import", [fact("002", "legacy-media")], { pageNumber: 3, previousHash: first.factPage.pageHash, totalFacts: 2 });
    await assert.rejects(() => submit([gap]), { code: "MEDIA_USAGE_FACT_PAGE_GAP" });
    const final = source("legacy-dialog", "full-import", [fact("002", "legacy-media")], { pageNumber: 2, previousHash: first.factPage.pageHash, totalFacts: 2 });
    await assert.rejects(() => submit([{ ...final, factPage: { ...final.factPage, totalFacts: 3 } }]), { code: "MEDIA_USAGE_FACT_RUN_CONFLICT" });
    await submit([final]);
    assert.equal((await asset("legacy-media")).sentCount, 2); assert.equal((await asset("legacy-media")).soldCount, 1);
    assert.equal((await db.creatorMediaUsageSourceState.findUnique({ where: { creatorId_sourceKey: { creatorId: s.creatorId, sourceKey: "legacy-dialog" } } })).factProtocol, 2);
    assert.equal((await submit([first])).staleSources, 1);
    await submit([source("legacy-dialog", "late-partial", [fact("002", "legacy-media", true)], { complete: false })]);
    assert.equal((await asset("legacy-media")).soldCount, 2); assert.equal((await asset("legacy-media")).sentCount, 2);
    pass("legacy baseline stays visible until complete hash/count/keyset manifest; atomic cutover and later partial purchase preserve exact counts");

    const protectedAsset = await db.creatorMediaAsset.create({ data: { ...own, mediaId: "legacy-purchased", sentCount: 1, soldCount: 1, revenueCents: 500 } });
    await db.creatorMediaUsageSourceState.create({ data: { ...own, sourceKey: "legacy-positive", sourceRevision: capturedAt } });
    await db.creatorMediaUsageContribution.create({ data: { ...own, assetId: protectedAsset.id, mediaId: protectedAsset.mediaId,
      sourceKey: "legacy-positive", sourceRevision: capturedAt, sentCount: 1, soldCount: 1, revenueCents: 500 } });
    const staleInitialFull = source("legacy-positive", "stale-first-full", [fact("001", "legacy-purchased"), fact("002", "legacy-fresh-media", true)]);
    const held = await submit([staleInitialFull]);
    assert.equal(held.awaitingCompleteReasons["legacy-positive"], "LEGACY_EVIDENCE_UNEXPLAINED");
    assert.equal((await submit([staleInitialFull])).awaitingCompleteReasons["legacy-positive"], "LEGACY_EVIDENCE_UNEXPLAINED");
    assert.equal((await asset("legacy-purchased")).soldCount, 1); assert.equal((await asset("legacy-purchased")).notOpenedCount, 0);
    assert.equal((await asset("legacy-purchased")).revenueCents, 500); assert.equal((await asset("legacy-fresh-media")).soldCount, 1);
    const acceptedPositive = await submit([source("legacy-positive", "other-pc-full-positive", [fact("001", "legacy-purchased", true), fact("002", "legacy-fresh-media", true)])]);
    assert.deepEqual(acceptedPositive.awaitingCompleteSources, []);
    assert.equal((await db.creatorMediaUsageSourceState.findUnique({ where: { creatorId_sourceKey: { creatorId: s.creatorId, sourceKey: "legacy-positive" } } })).factProtocol, 2);
    assert.equal((await asset("legacy-purchased")).soldCount, 1); assert.equal((await asset("legacy-purchased")).sentCount, 1);
    pass("stale initial full import cannot erase legacy purchase evidence; new media progress and another PC's exact positive facts allow cutover");

    // The old clock could reject these facts. A known run receipt expires safely:
    // producer restarts its traversal, and stable identities prevent duplication.
    const page1 = source("paged", "revision", [fact("010", "m-page")], { done: false, complete: false });
    await submit([page1]);
    const state = await db.creatorMediaUsageSourceState.findUnique({ where: { creatorId_sourceKey: { creatorId: s.creatorId, sourceKey: "paged" } } });
    await db.creatorMediaUsageSourceState.update({ where: { id: state.id }, data: { coverage: { ...state.coverage, runs: [] } } });
    const page2 = source("paged", "revision", [], { pageNumber: 2, previousHash: page1.factPage.pageHash, totalFacts: 1, complete: false });
    await assert.rejects(() => submit([page2]), { code: "MEDIA_USAGE_FACT_RUN_RESTART_REQUIRED" });
    await submit([page1, page2]); assert.equal((await asset("m-page")).sentCount, 1);
    pass("bounded receipt loss requests safe page-one restart; empty final page and replay preserve one fact");

    // More media than the old aggregate payload limit remain valid advancing
    // history. Only each page is bounded, never the total v2 source.
    const manyFacts = Array.from({ length: 2001 }, (_, i) => fact(String(i).padStart(5, "0"), `large-${i}`));
    const largeFirst = source("large-v2", "large-run", manyFacts.slice(0, 2000), { done: false, complete: false });
    await submit([largeFirst]);
    await submit([source("large-v2", "large-run", manyFacts.slice(2000), { pageNumber: 2, previousHash: largeFirst.factPage.pageHash, totalFacts: 2001, complete: false })]);
    assert.equal(await db.creatorMediaUsageContribution.count({ where: { creatorId: s.creatorId, sourceKey: "large-v2" } }), 2001);
    const priorAsset = await db.creatorMediaAsset.create({ data: { ...own, mediaId: "large-legacy-old", sentCount: 1 } });
    await db.creatorMediaUsageSourceState.create({ data: { ...own, sourceKey: "large-legacy", sourceRevision: capturedAt } });
    await db.creatorMediaUsageContribution.create({ data: { ...own, assetId: priorAsset.id, mediaId: priorAsset.mediaId, sourceKey: "large-legacy", sourceRevision: capturedAt, sentCount: 1 } });
    const importFacts = [fact("00000", "large-legacy-old"), ...Array.from({ length: 2001 }, (_, i) => fact(String(i + 1).padStart(5, "0"), `legacy-new-${i}`))];
    const importFirst = source("large-legacy", "full-large", importFacts.slice(0, 2000), { done: false });
    await submit([importFirst]);
    assert.equal((await asset("large-legacy-old")).sentCount, 1); assert.equal((await asset("legacy-new-0")).sentCount, 1);
    const plan = await commit(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL enable_seqscan = off");
      return tx.$queryRawUnsafe(`EXPLAIN (FORMAT JSON) SELECT * FROM "CreatorMediaUsageContribution"
        WHERE "agencyId"=$1 AND "creatorId"=$2 AND "sourceKey"=$3
          AND ("factBaseline" IS NULL OR "factBaseline"->>'legacyPending'='true') LIMIT 2001`, s.agencyId, s.creatorId, "large-legacy");
    });
    assert(JSON.stringify(plan).includes("CreatorMediaUsageContribution_legacy_pending_idx"));
    await submit([source("large-legacy", "full-large", importFacts.slice(2000), { pageNumber: 2, previousHash: importFirst.factPage.pageHash, totalFacts: 2002 })]);
    assert.equal((await asset("large-legacy-old")).sentCount, 1); assert.equal((await asset("legacy-new-2000")).sentCount, 1);
    assert.equal(await db.creatorMediaUsageContribution.count({ where: { creatorId: s.creatorId, sourceKey: "large-legacy" } }), 2002);
    pass("v2 histories above 2000 media keep advancing; legacy new media project immediately and indexed bounded old baseline switches atomically");

    let guarded = 0;
    await assert.rejects(() => submit([source("auth-first", "r", [fact("1", "m-auth")]), source("auth-second", "r", [fact("2", "m-auth")])], {
      commitGuard: async tx => { assert.equal(currentCommitContext().tx, tx); if (++guarded === 2) throw Object.assign(Error("revoked"), { code: "ACCESS_REVOKED" }); },
    }), { code: "ACCESS_REVOKED" });
    assert.equal((await asset("m-auth")).sentCount, 1);
    assert.equal(await db.creatorMediaUsageFact.count({ where: { creatorId: s.creatorId, sourceKey: "auth-second" } }), 0);
    pass("each bounded source transaction rechecks authorization before facts; prior valid commit survives later revocation");

    const beforeMetadata = (await changes()).headRevision;
    await media.upsertMediaMetadata({ ...own, db, mediaId: "m1", input: { mediaType: "photo", description: "private", manualTags: [], visibleBodyParts: [], accessType: "paid", minPrice: 0, idealPrice: 0 } });
    const metadataFeed = await changes(); assert.notEqual(metadataFeed.headRevision, beforeMetadata);
    const metadata = metadataFeed.changes.find(row => row.entityId === "asset:m1");
    assert.equal(metadata.payload.mediaId, "m1"); assert(!JSON.stringify(metadata).includes("private"));
    const vault = require(root + "/src/services/vault-unsorted-service"), job = { id: "media-proof-vault", ...own, params: { mode: "full" } };
    const chunk = { kind: "vault_unsorted_media_page", continuation: { mode: "full", messagesFolderId: "messages", pages: 0, scanned: 0 },
      items: [{ mediaId: "vault-new", status: "UNSORTED", folderIds: [] }], hasMore: false, nextOffset: 1 };
    await commit(tx => vault.applyVaultUnsortedChunk({ db: tx, job, chunkResult: chunk }));
    assert.equal(await asset("vault-new"), null); assert.equal((await changes()).headRevision, metadataFeed.headRevision);
    await assert.rejects(() => commit(async tx => {
      await vault.applyVaultUnsortedCompletion({ db: tx, job, result: { mode: "full", pages: 1, scanned: 1, expectedMediaCount: 1 } });
      throw Error("VAULT_ROLLBACK");
    }), /VAULT_ROLLBACK/);
    assert.equal(await asset("vault-new"), null); assert.equal((await changes()).headRevision, metadataFeed.headRevision);
    await commit(tx => vault.applyVaultUnsortedCompletion({ db: tx, job, result: { mode: "full", pages: 1, scanned: 1, expectedMediaCount: 1 } }));
    assert.equal((await asset("vault-new")).catalogActive, true);
    const vaultHead = (await changes()).headRevision;
    await commit(tx => vault.applyVaultUnsortedChunk({ db: tx, job: { ...job, id: "media-incremental", params: { mode: "incremental" } },
      chunkResult: { ...chunk, continuation: { ...chunk.continuation, mode: "incremental" }, items: [{ mediaId: "vault-incremental", status: "UNSORTED", folderIds: [] }] } }));
    assert.equal((await asset("vault-incremental")).catalogActive, true); assert.notEqual((await changes()).headRevision, vaultHead);
    pass("metadata invalidations omit private content; Vault staging is silent, publication and incremental facts atomically signal the reverse feed");
    const factQueries = f.queries?.filter(row => /CreatorMediaUsageFact/.test(row.query) && /^SELECT/.test(row.query.trim())) || [];
    assert(!factQueries.some(row => /SUM\(/i.test(row.query)));
    console.log("MEDIA USAGE FACTS PROOF PASSED");
  } finally { await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
