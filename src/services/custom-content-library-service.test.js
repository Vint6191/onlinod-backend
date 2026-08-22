"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  finalizeCustomContentSubmissionLibrary,
  syncFinalizedSubmissionAssignment,
} = require("./custom-content-library-service");

const member = { id: "member-1", userId: "user-1", roleKey: "chatter", role: "OPERATOR", assignedCreators: ["creator-1"] };
function clone(value) { return value == null ? value : structuredClone(value); }

function fakeDb({ submission = {}, assets = [], order = {}, folderId = "vault-customs" } = {}) {
  const submissionRow = {
    id: "submission-1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "custom-1",
    telegramMessageIds: [101, 102], ofMediaIds: ["9001", "9002"], comment: null,
    receivedAt: new Date("2026-08-21T10:00:00.000Z"), createdAt: new Date("2026-08-21T10:00:00.000Z"), updatedAt: new Date("2026-08-21T10:00:00.000Z"),
    ...clone(submission),
  };
  const orderRow = { id: "custom-1", agencyId: "agency-1", creatorId: "creator-1", type: "CONTENT", scenario: "Red lingerie video, two angles", priceCents: 6000, ...clone(order) };
  const mediaAssets = assets.map(clone);
  const audits = [];
  return {
    _submission: submissionRow,
    _assets: mediaAssets,
    _audits: audits,
    creatorAccount: {
      async findFirst({ where }) {
        if (where.id !== "creator-1" || where.agencyId !== "agency-1") return null;
        return { id: "creator-1", agencyId: "agency-1", displayName: "Model", username: "model", status: "READY", customsVaultFolderId: folderId };
      },
    },
    customContentSubmission: {
      async findFirst({ where }) { return where.id === submissionRow.id && where.agencyId === submissionRow.agencyId ? clone(submissionRow) : null; },
    },
    customOrder: {
      async findFirst({ where }) {
        if (!submissionRow.customOrderId) return null;
        return where.id === orderRow.id && where.agencyId === orderRow.agencyId && where.creatorId === orderRow.creatorId ? clone(orderRow) : null;
      },
    },
    creatorMediaAsset: {
      async findMany({ where, take = 100 }) {
        return mediaAssets.filter((asset) => {
          if (asset.agencyId !== where.agencyId || asset.creatorId !== where.creatorId) return false;
          if (where.mediaId?.in && !where.mediaId.in.includes(asset.mediaId)) return false;
          if (where.source !== undefined && asset.source !== where.source) return false;
          return true;
        }).slice(0, take).map(clone);
      },
      async createMany({ data, skipDuplicates }) {
        let count = 0;
        for (const item of data) {
          if (skipDuplicates && mediaAssets.some((asset) => asset.creatorId === item.creatorId && asset.mediaId === item.mediaId)) continue;
          mediaAssets.push({
            mediaType: "unknown", durationSec: 0, thumbUrl: null, previewUrl: null, fullUrl: null,
            manualTags: [], visibleBodyParts: [], minPriceCents: 0, metadataUpdatedAt: null,
            createdAt: new Date(), updatedAt: new Date(),
            ...clone(item),
          });
          count += 1;
        }
        return { count };
      },
      async update({ where, data }) {
        const asset = mediaAssets.find((row) => row.id === where.id);
        if (!asset) throw new Error("asset not found");
        Object.assign(asset, clone(data), { updatedAt: new Date("2026-08-21T13:00:00.000Z") });
        return clone(asset);
      },
    },
    auditLog: { async create({ data }) { audits.push(clone(data)); return { id: `audit-${audits.length}`, ...clone(data) }; } },
  };
}

test("V20.4 uses typed CreatorMediaAsset columns for Customs provenance, not metadata JSON", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const block = schema.match(/model CreatorMediaAsset \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(block, /source\s+CreatorMediaAssetSource\s+@default\(GENERAL\)/);
  assert.match(block, /customOrderId\s+String\?/);
  assert.match(block, /customSubmissionId\s+String\?/);
  assert.match(block, /customFullPriceCents\s+Int\?/);
  assert.match(schema, /enum CreatorMediaAssetSource \{\s*GENERAL\s*CUSTOM\s*\}/);
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260821131500_custom_content_library_columns/migration.sql"), "utf8");
  assert.match(migration, /ADD COLUMN "source" "CreatorMediaAssetSource" NOT NULL DEFAULT 'GENERAL'/);
  assert.match(migration, /ADD COLUMN "customOrderId" TEXT/);
  assert.match(migration, /ADD COLUMN "customFullPriceCents" INTEGER/);
  assert.doesNotMatch(migration, /metadata/i, "Customs provenance must not be packed into JSON metadata");
});

test("finalize materializes every settled OF media id in Content Library with full custom price", async () => {
  const db = fakeDb();
  const result = await finalizeCustomContentSubmissionLibrary({ agencyId: "agency-1", member, submissionId: "submission-1", db, now: new Date("2026-08-21T12:00:00.000Z") });
  assert.equal(result.ok, true);
  assert.equal(result.customOrderId, "custom-1");
  assert.equal(result.fullContentPriceCents, 6000);
  assert.equal(db._assets.length, 2);
  for (const asset of db._assets) {
    assert.equal(asset.source, "CUSTOM");
    assert.equal(asset.customOrderId, "custom-1");
    assert.equal(asset.customSubmissionId, "submission-1");
    assert.equal(asset.customFullPriceCents, 6000);
    assert.equal(asset.catalogActive, true);
    assert.equal(asset.sortingStatus, "SORTED");
    assert.deepEqual(asset.folderIds, ["vault-customs"]);
    assert.equal(asset.description, "Red lingerie video, two angles");
    assert.equal(asset.idealPriceCents, 6000, "Content Library selling price starts from the FULL custom total, never remaining due");
    assert.equal(asset.accessType, "paid");
  }
  assert.equal(db._audits.filter((row) => row.action === "custom_content_submission.content_library_finalize").length, 1);

  const retry = await finalizeCustomContentSubmissionLibrary({ agencyId: "agency-1", member, submissionId: "submission-1", db, now: new Date("2026-08-21T12:01:00.000Z") });
  assert.equal(retry.idempotent, true);
  assert.equal(db._audits.filter((row) => row.action === "custom_content_submission.content_library_finalize").length, 1, "exact finalize retry must not create audit noise");
});

test("automatic Customs finalize never overwrites human Media Library description or pricing", async () => {
  const db = fakeDb({ assets: [{
    id: "asset-1", agencyId: "agency-1", creatorId: "creator-1", mediaId: "9001", source: "GENERAL", customOrderId: null, customFullPriceCents: null,
    catalogActive: true, sortingStatus: "UNSORTED", folderIds: [], description: "Manager edited description", idealPriceCents: 3500, accessType: "paid",
    metadataUpdatedAt: new Date("2026-08-21T11:00:00.000Z"), firstSeenAt: new Date(), lastSeenAt: new Date(),
  }] });
  await finalizeCustomContentSubmissionLibrary({ agencyId: "agency-1", member, submissionId: "submission-1", db });
  const asset = db._assets.find((row) => row.mediaId === "9001");
  assert.equal(asset.source, "CUSTOM");
  assert.equal(asset.customOrderId, "custom-1");
  assert.equal(asset.customSubmissionId, "submission-1");
  assert.equal(asset.customFullPriceCents, 6000);
  assert.equal(asset.description, "Manager edited description");
  assert.equal(asset.idealPriceCents, 3500);
  assert.deepEqual(asset.folderIds, ["vault-customs"]);
});

test("an unassigned settled submission is still durable CUSTOM library content and later assignment fills typed provenance", async () => {
  const db = fakeDb({ submission: { customOrderId: null } });
  await finalizeCustomContentSubmissionLibrary({ agencyId: "agency-1", member, submissionId: "submission-1", db });
  for (const asset of db._assets) {
    assert.equal(asset.source, "CUSTOM");
    assert.equal(asset.customOrderId, null);
    assert.equal(asset.customSubmissionId, "submission-1");
    assert.equal(asset.customFullPriceCents, null);
    assert.equal(asset.idealPriceCents, 0);
  }

  db._submission.customOrderId = "custom-1";
  const synced = await syncFinalizedSubmissionAssignment({ agencyId: "agency-1", member, submissionId: "submission-1", db });
  assert.equal(synced.synced, true);
  for (const asset of db._assets) {
    assert.equal(asset.customOrderId, "custom-1");
    assert.equal(asset.customSubmissionId, "submission-1");
    assert.equal(asset.customFullPriceCents, 6000);
    assert.equal(asset.idealPriceCents, 6000);
    assert.equal(asset.description, "Red lingerie video, two angles");
  }
});

test("Content Library finalize refuses incomplete OF upload state", async () => {
  const db = fakeDb({ submission: { ofMediaIds: ["9001"] } });
  await assert.rejects(
    () => finalizeCustomContentSubmissionLibrary({ agencyId: "agency-1", member, submissionId: "submission-1", db }),
    (error) => error?.code === "CUSTOM_SUBMISSION_NOT_READY_FOR_LIBRARY" && error?.status === 409,
  );
  assert.equal(db._assets.length, 0);
});

test("V20.5 finalize seeds existing Content Library preview columns from fresh OF commit without JSON or extra tables", async () => {
  const db = fakeDb();
  await finalizeCustomContentSubmissionLibrary({
    agencyId: "agency-1",
    member,
    submissionId: "submission-1",
    db,
    mediaHints: [
      { mediaId: "9001", mediaType: "video", thumbUrl: "https://cdn.test/9001-thumb.jpg", previewUrl: "https://cdn.test/9001-preview.jpg", fullUrl: "https://cdn.test/9001.mp4" },
      { mediaId: "9002", mediaType: "photo", thumbUrl: "https://cdn.test/9002-thumb.jpg", previewUrl: "https://cdn.test/9002-preview.jpg", fullUrl: "https://cdn.test/9002.jpg" },
      { mediaId: "not-in-submission", mediaType: "video", fullUrl: "https://cdn.test/evil.mp4" },
    ],
  });
  const first = db._assets.find((row) => row.mediaId === "9001");
  const second = db._assets.find((row) => row.mediaId === "9002");
  assert.equal(first.mediaType, "video");
  assert.equal(first.thumbUrl, "https://cdn.test/9001-thumb.jpg");
  assert.equal(first.previewUrl, "https://cdn.test/9001-preview.jpg");
  assert.equal(first.fullUrl, "https://cdn.test/9001.mp4");
  assert.equal(second.mediaType, "photo");
  assert.equal(second.fullUrl, "https://cdn.test/9002.jpg");
  assert.equal(db._assets.some((row) => row.mediaId === "not-in-submission"), false);

  // A later retry must not overwrite richer/fresher URLs already written by the normal Media Library scanner.
  first.thumbUrl = "https://cdn.test/scanner-fresh-thumb.jpg";
  await finalizeCustomContentSubmissionLibrary({
    agencyId: "agency-1",
    member,
    submissionId: "submission-1",
    db,
    mediaHints: [{ mediaId: "9001", mediaType: "video", thumbUrl: "https://cdn.test/stale-upload-thumb.jpg" }],
  });
  assert.equal(first.thumbUrl, "https://cdn.test/scanner-fresh-thumb.jpg");
});


test("V20.9 Content Library stores exact submission provenance in a typed FK", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const block = schema.match(/model CreatorMediaAsset \{([\s\S]*?)\n\}/)?.[1] || "";
  assert.match(block, /customSubmissionId\s+String\?/);
  assert.match(block, /customSubmission\s+CustomContentSubmission\?/);
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260822123500_custom_content_submission_asset_provenance/migration.sql"), "utf8");
  assert.match(migration, /ADD COLUMN "customSubmissionId" TEXT/);
  assert.match(migration, /"mediaId" = ANY\(submission\."ofMediaIds"\)/);
  assert.match(migration, /ON DELETE SET NULL ON UPDATE CASCADE/);
});
