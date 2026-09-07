"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const prismaModule = require.resolve("../prisma");
require.cache[prismaModule] = { id: prismaModule, filename: prismaModule, loaded: true, exports: {} };
delete require.cache[require.resolve("./vault-unsorted-service")];
delete require.cache[require.resolve("./vault-never-used-service")];
delete require.cache[require.resolve("./vault-directory-service")];

const {
  cleanMediaIds,
  getVaultDirectoryIntelligence,
  checkProtectedVaultMedia,
} = require("./vault-directory-service");

function date(value = "2026-07-16T12:00:00.000Z") { return new Date(value); }

function matchesWhere(row, where = {}) {
  if (where.catalogActive !== undefined && row.catalogActive !== where.catalogActive) return false;
  if (where.mediaId?.in && !where.mediaId.in.includes(row.mediaId)) return false;
  if (where.sentCount?.gt !== undefined && row.sentCount <= where.sentCount.gt) return false;
  if (where.soldCount?.gt !== undefined && row.soldCount <= where.soldCount.gt) return false;
  return true;
}

function fakeDb() {
  const catalog = [
    {
      id: "c1", mediaId: "m1", mediaType: "video", catalogActive: true,
      sortingStatus: "SORTED", sentCount: 3, soldCount: 2, notOpenedCount: 1,
      freeCount: 0, revenueCents: 5000, averagePriceCents: 2500,
      uniqueBuyers: 2, lastSoldAt: date(), thumbUrl: "https://cdn/x.jpg",
      previewUrl: "https://cdn/x-preview.jpg", fullUrl: "https://cdn/x-full.jpg",
      updatedAt: date(), usageUpdatedAt: date(), lastSeenAt: date(),
    },
    {
      id: "c3", mediaId: "m3", mediaType: "photo", catalogActive: true,
      sortingStatus: "UNSORTED", sentCount: 0, soldCount: 0, notOpenedCount: 0,
      freeCount: 0, revenueCents: 0, averagePriceCents: 0, uniqueBuyers: 0,
      lastSoldAt: null, thumbUrl: null, previewUrl: null, fullUrl: null,
      updatedAt: date(), usageUpdatedAt: date(), lastSeenAt: date(),
    },
  ];
  return {
    creatorAccount: { async findFirst() { return { id: "creator-1" }; } },
    creatorMediaAsset: {
      async count({ where }) { return catalog.filter((row) => matchesWhere(row, where)).length; },
      async aggregate({ where }) {
        const rows = catalog.filter((row) => matchesWhere(row, where));
        return {
          _sum: {
            soldCount: rows.reduce((sum, row) => sum + row.soldCount, 0),
            revenueCents: rows.reduce((sum, row) => sum + row.revenueCents, 0),
          },
          _max: { lastSoldAt: rows.map((row) => row.lastSoldAt).filter(Boolean).sort().at(-1) || null },
        };
      },
      async findMany(args) {
        return catalog.filter((row) => matchesWhere(row, args.where)).slice(0, args.take || catalog.length);
      },
      async findFirst({ where }) {
        return catalog.filter((row) => matchesWhere(row, where))[0] || null;
      },
    },
    vaultUnsortedSnapshot: {
      async findUnique() {
        return {
          id: "messages", creatorId: "creator-1", itemsCount: catalog.length,
          unsortedCount: 1, sortedCount: 1, capturedAt: date(), updatedAt: date(),
          payload: {
            schema: 3, kind: "vault_unsorted_snapshot", messagesFolderId: "messages",
            lastFullScanAt: date().toISOString(), lastIncrementalScanAt: null,
            scan: { status: "COMPLETED", mode: "full", jobId: "messages-job", pages: 4, scanned: 120, knownStreak: 0, startedAt: date().toISOString(), completedAt: date().toISOString(), lastError: null },
          },
        };
      },
    },
    dialogScanState: {
      async findMany() { return [{ initialScanComplete: true, status: "COMPLETED", pagesProcessed: 3, messagesProcessed: 90, lastError: null, lastFullScanAt: date(), lastIncrementalScanAt: null, updatedAt: date() }]; },
    },
    dialogScanRun: {
      async findMany() { return [{ id: "discovery-run", jobId: "discovery-job", status: "COMPLETED", pagesProcessed: 1, purchaseSignals: 1, completedAt: date(), updatedAt: date() }]; },
      async findFirst() { return { updatedAt: date(), completedAt: date(), lastError: null }; },
    },
    jobInstance: {
      async findMany(args) {
        if (args.where?.id?.in) return [{ id: "discovery-job", params: { childMode: "initial" } }];
        return [];
      },
      async findFirst() { return null; },
    },
  };
}

test("cleanMediaIds deduplicates and bounds input", () => {
  assert.deepEqual(cleanMediaIds(["m1", "m1", "", "m2"], 2), ["m1", "m2"]);
});

test("Media Library membership is protection while usage stays independently aggregated", async () => {
  const result = await getVaultDirectoryIntelligence({
    agencyId: "agency-1", creatorId: "creator-1", mediaIds: ["m1", "m2", "m3"], db: fakeDb(),
  });
  const byId = new Map(result.analytics.map((item) => [item.mediaId, item]));
  assert.equal(result.pipeline.authoritative, true);
  assert.equal(byId.get("m1").usageState, "USED");
  assert.equal(byId.get("m1").inMessagesCatalog, true);
  assert.equal(byId.get("m3").usageState, "NEVER_USED");
  assert.equal(byId.get("m3").inMessagesCatalog, true);
  assert.equal(byId.get("m2").usageState, "NOT_APPLICABLE");
  assert.equal(result.summary.protectedMediaCount, 2);
});

test("catalog media stays pending until initial Messages and dialog scans are authoritative", async () => {
  const result = await getVaultDirectoryIntelligence({
    agencyId: "agency-1", creatorId: "creator-1", mediaIds: ["m3"], includePipeline: false, db: fakeDb(),
  });
  assert.equal(result.pipeline, null);
  assert.equal(result.analytics[0].usageState, "PENDING");
  assert.equal(result.analytics[0].neverUsed, false);
});

test("protection check returns every requested active Media Library id", async () => {
  const result = await checkProtectedVaultMedia({
    agencyId: "agency-1", creatorId: "creator-1", mediaIds: ["m1", "m2", "m3"], db: fakeDb(),
  });
  assert.deepEqual(result.protectedMediaIds, ["m1", "m3"]);
});


test("manual Vault mutations protect live CUSTOM pipeline media before the remote destructive write", async () => {
  const assets = [
    { mediaId: "m-pinned", source: "CUSTOM", customSubmissionId: "sub-pinned" },
    { mediaId: "m-other", source: "CUSTOM", customSubmissionId: "sub-other" },
    { mediaId: "m-unpinned", source: "CUSTOM", customSubmissionId: "sub-unpinned" },
    { mediaId: "m-terminal", source: "CUSTOM", customSubmissionId: "sub-terminal" },
  ];
  const live = [
    { id: "sub-pinned", executionVaultFolderId: "vault-a" },
    { id: "sub-other", executionVaultFolderId: "vault-b" },
    { id: "sub-unpinned", executionVaultFolderId: null },
  ];
  const db = {
    creatorAccount: { async findFirst() { return { id: "creator-1" }; } },
    creatorMediaAsset: {
      async findMany({ where }) {
        return assets.filter((row) => !where.mediaId?.in || where.mediaId.in.includes(row.mediaId));
      },
    },
    customContentSubmission: {
      async findMany({ where }) {
        return live.filter((row) => !where.id?.in || where.id.in.includes(row.id));
      },
    },
  };

  const hide = await checkProtectedVaultMedia({
    agencyId: "agency-1", creatorId: "creator-1", mediaIds: assets.map((row) => row.mediaId), operation: "hide_media", db,
  });
  assert.deepEqual(new Set(hide.protectedMediaIds), new Set(["m-pinned", "m-other", "m-unpinned"]));
  assert.ok(!hide.protectedMediaIds.includes("m-terminal"), "terminal Custom history must not block ordinary manual Vault cleanup forever");

  const removePinned = await checkProtectedVaultMedia({
    agencyId: "agency-1", creatorId: "creator-1", mediaIds: assets.map((row) => row.mediaId), operation: "remove_from_list", folderId: "vault-a", db,
  });
  assert.deepEqual(new Set(removePinned.protectedMediaIds), new Set(["m-pinned", "m-unpinned"]));
  assert.ok(!removePinned.protectedMediaIds.includes("m-other"), "removing a live Custom from an unrelated extra folder stays allowed");
});

test("Vault destructive protection starts at canonical submission.ofMediaIds before CUSTOM asset materialization", async () => {
  const db = {
    creatorAccount: { async findFirst() { return { id: "creator-1" }; } },
    creatorMediaAsset: { async findMany() { return []; } },
    customContentSubmission: {
      async findMany({ where }) {
        if (where?.ofMediaIds?.hasSome) {
          return [{ id: "sub-canonical", executionVaultFolderId: "vault-a", ofMediaIds: ["m-canonical"] }]
            .filter((row) => row.ofMediaIds.some((id) => where.ofMediaIds.hasSome.includes(id)));
        }
        return [];
      },
    },
  };

  const hide = await checkProtectedVaultMedia({
    agencyId: "agency-1", creatorId: "creator-1", mediaIds: ["m-canonical"], operation: "hide_media", db,
  });
  assert.deepEqual(hide.protectedMediaIds, ["m-canonical"], "confirmed pipeline media is protected before CreatorMediaAsset exists");

  const removePinned = await checkProtectedVaultMedia({
    agencyId: "agency-1", creatorId: "creator-1", mediaIds: ["m-canonical"], operation: "remove_from_list", folderId: "vault-a", db,
  });
  assert.deepEqual(removePinned.protectedMediaIds, ["m-canonical"], "canonical media cannot be removed from its pinned execution folder");

  const removeOther = await checkProtectedVaultMedia({
    agencyId: "agency-1", creatorId: "creator-1", mediaIds: ["m-canonical"], operation: "remove_from_list", folderId: "vault-b", db,
  });
  assert.deepEqual(removeOther.protectedMediaIds, [], "canonical media may still be removed from unrelated extra folders");
});

test("canonical Vault protection has no correctness LIMIT when one media id is referenced by multiple live submissions", async () => {
  const submissions = [
    { id: "sub-a", executionVaultFolderId: "vault-a", ofMediaIds: ["m-shared"] },
    { id: "sub-b", executionVaultFolderId: "vault-b", ofMediaIds: ["m-shared"] },
  ];
  const db = {
    creatorAccount: { async findFirst() { return { id: "creator-1" }; } },
    creatorMediaAsset: { async findMany() { return []; } },
    customContentSubmission: {
      async findMany(args) {
        let rows = submissions.filter((row) => row.ofMediaIds.some((id) => args.where?.ofMediaIds?.hasSome?.includes(id)));
        if (Number.isFinite(args.take)) rows = rows.slice(0, args.take);
        return rows;
      },
    },
  };

  const result = await checkProtectedVaultMedia({
    agencyId: "agency-1", creatorId: "creator-1", mediaIds: ["m-shared"], operation: "remove_from_list", folderId: "vault-b", db,
  });
  assert.deepEqual(result.protectedMediaIds, ["m-shared"], "all live canonical ownership rows must participate before destructive write authority is decided");
});

test("Vault destructive protection starts at durable CUSTOM_RELAY_SEND proof before media-commit projects ofMediaIds", async () => {
  const liveSubmission = {
    id: "sub-proof-window",
    executionVaultFolderId: "vault-a",
    ofMediaIds: [],
    telegramMessageIds: [701],
    telegramSourceAccountId: "tg-1",
    telegramSourceUserId: "987654321012345678",
  };
  const proof = {
    id: "relay-proof-window",
    idempotencyKey: "custom-relay:sub-proof-window:0",
    actionType: "CUSTOM_RELAY_SEND",
    status: "COMPLETED",
    payload: {
      submissionId: "sub-proof-window",
      expectedIndex: 0,
      telegramSourceAccountId: "tg-1",
      telegramSourceUserId: "987654321012345678",
      telegramMessageId: "701",
    },
    result: { programmaticWriteKind: "CUSTOM_RELAY_SEND", mediaId: "990701" },
  };
  const db = {
    creatorAccount: { async findFirst() { return { id: "creator-1" }; } },
    creatorMediaAsset: { async findMany() { return []; } },
    automationDelivery: {
      async findMany({ where }) {
        const requested = new Set((where.OR || []).map((entry) => String(entry?.result?.equals || "")));
        return requested.has(String(proof.result.mediaId)) ? [proof] : [];
      },
    },
    customContentSubmission: {
      async findMany({ where }) {
        if (where?.ofMediaIds?.hasSome) return [];
        if (where?.id?.in?.includes(liveSubmission.id)) return [liveSubmission];
        return [];
      },
    },
  };

  const hide = await checkProtectedVaultMedia({
    agencyId: "agency-1", creatorId: "creator-1", mediaIds: ["990701"], operation: "hide_media", db,
  });
  assert.deepEqual(hide.protectedMediaIds, ["990701"], "relay-confirmed media is protected in the proof→media-commit crash window");

  const removePinned = await checkProtectedVaultMedia({
    agencyId: "agency-1", creatorId: "creator-1", mediaIds: ["990701"], operation: "remove_from_list", folderId: "vault-a", db,
  });
  assert.deepEqual(removePinned.protectedMediaIds, ["990701"], "relay-confirmed media cannot leave its pinned execution folder before media-commit");
});

test("Vault relay-proof protection rejects unbound or terminal historical proof", async () => {
  const proof = {
    id: "relay-proof-bad",
    idempotencyKey: "custom-relay:sub-proof-bad:0",
    actionType: "CUSTOM_RELAY_SEND",
    status: "COMPLETED",
    payload: {
      submissionId: "sub-proof-bad",
      expectedIndex: 0,
      telegramSourceAccountId: "tg-1",
      telegramSourceUserId: "987654321012345678",
      telegramMessageId: "999", // does not match canonical source message 701
    },
    result: { programmaticWriteKind: "CUSTOM_RELAY_SEND", mediaId: "990702" },
  };
  const db = {
    creatorAccount: { async findFirst() { return { id: "creator-1" }; } },
    creatorMediaAsset: { async findMany() { return []; } },
    automationDelivery: { async findMany() { return [proof]; } },
    customContentSubmission: {
      async findMany({ where }) {
        if (where?.ofMediaIds?.hasSome) return [];
        if (where?.id?.in) {
          return [{
            id: "sub-proof-bad", executionVaultFolderId: "vault-a", ofMediaIds: [],
            telegramMessageIds: [701], telegramSourceAccountId: "tg-1", telegramSourceUserId: "987654321012345678",
          }];
        }
        return [];
      },
    },
  };
  const badBinding = await checkProtectedVaultMedia({
    agencyId: "agency-1", creatorId: "creator-1", mediaIds: ["990702"], operation: "hide_media", db,
  });
  assert.deepEqual(badBinding.protectedMediaIds, [], "a result mediaId without exact source/idempotency binding is not ownership proof");

  db.customContentSubmission.findMany = async ({ where }) => {
    if (where?.ofMediaIds?.hasSome) return [];
    return []; // terminal/archived submission is excluded by the live-pipeline query
  };
  const terminal = await checkProtectedVaultMedia({
    agencyId: "agency-1", creatorId: "creator-1", mediaIds: ["990702"], operation: "hide_media", db,
  });
  assert.deepEqual(terminal.protectedMediaIds, [], "terminal historical relay proof must not block Vault cleanup forever");
});
