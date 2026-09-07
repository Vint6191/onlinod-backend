"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { listCustomReadyDeliveries, getCustomReadyDelivery, preflightCustomManualSend, preflightProgrammaticCustomMedia } = require("./custom-content-delivery-service");
const { vaultSettlementFingerprint } = require("./custom-content-pipeline-authority-service");


function receipt(folderId, profileRevision, mediaIds, at = new Date("2026-08-22T08:00:00.000Z")) {
  return {
    vaultSettlementFolderId: folderId,
    vaultSettlementProfileRevision: profileRevision,
    vaultSettlementMediaFingerprint: vaultSettlementFingerprint({ folderId, profileRevision, mediaIds }),
    vaultSettlementConfirmedAt: at,
    vaultSettlementConfirmedByDeviceId: "device-1",
  };
}

function fixture() {
  const readyAt = new Date("2026-08-22T08:00:00.000Z");
  const creator = { id: "creator-1", displayName: "Model One", username: "modelone", avatarUrl: null, customsVaultFolderId: "folder-77" };
  const order = {
    id: "custom-1", creatorId: "creator-1", dialogId: "777", scenario: "Custom scenario", internalNote: null,
    type: "CONTENT", contentKind: "VIDEO", status: "PENDING", deliveredAt: new Date("2026-08-20T01:00:00.000Z"), fanDeliveredAt: null,
    deliverySentMediaIds: [], deliveryMessageIds: [], deliveryOfferedCents: 0,
    priceCents: 6000, paidAmountCents: 4000, createdAt: new Date("2026-08-20T00:00:00.000Z"), creator,
  };
  const row = {
    id: "sub-1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: "custom-1",
    telegramMessageIds: [101, 102], ofMediaIds: ["9001", "9002"], reviewStatus: "APPROVED", reviewedAt: readyAt,
    pipelineDisposition: "ACTIVE", executionVaultFolderId: "folder-77", executionRelayRecipient: "relay_model", executionProfileRevision: 1, executionPinnedAt: readyAt,
    ...receipt("folder-77", 1, ["9001", "9002"], readyAt),
    receivedAt: new Date("2026-08-21T00:00:00.000Z"), creator, customOrder: order,
  };
  const assets = ["9001", "9002"].map((mediaId) => ({
    creatorId: "creator-1", mediaId, source: "CUSTOM", customOrderId: "custom-1", customSubmissionId: "sub-1", customFullPriceCents: 6000,
    mediaType: "video", thumbUrl: `https://cdn/${mediaId}.jpg`, previewUrl: `https://cdn/${mediaId}.preview`, fullUrl: `https://cdn/${mediaId}.mp4`, folderIds: ["folder-77"], catalogActive: true, sortingStatus: "SORTED",
  }));
  const rows = [row];
  const db = {
    customContentSubmission: {
      findMany: async ({ where, take = 999999, cursor = null, skip = 0, orderBy = [] }) => {
        let found = rows.filter((item) => {
          if (where?.reviewStatus && item.reviewStatus !== where.reviewStatus) return false;
          if (where?.pipelineDisposition && String(item.pipelineDisposition || "ACTIVE") !== String(where.pipelineDisposition)) return false;
          if (where?.creatorId?.in && !where.creatorId.in.includes(item.creatorId)) return false;
          if (where?.creatorId && typeof where.creatorId === "string" && item.creatorId !== where.creatorId) return false;
          if (where?.ofMediaIds?.hasSome && !where.ofMediaIds.hasSome.some((id) => item.ofMediaIds.includes(String(id)))) return false;
          return true;
        });
        const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
        found.sort((a,b) => { for (const spec of specs) { const [key,dir]=Object.entries(spec||{})[0]||[]; if(!key) continue; const av=a[key],bv=b[key]; const cmp=(av instanceof Date || bv instanceof Date) ? new Date(av||0)-new Date(bv||0) : String(av??"").localeCompare(String(bv??"")); if(cmp) return dir === "desc" ? -cmp : cmp; } return 0; });
        if (cursor?.id) { const index=found.findIndex((item)=>item.id===cursor.id); if(index>=0) found=found.slice(index+Math.max(1,skip)); } else if(skip) found=found.slice(skip);
        return found.slice(0,take);
      },
      findFirst: async ({ where }) => rows.find((item) => item.customOrderId === where.customOrderId && item.reviewStatus === where.reviewStatus && (!where.creatorId?.in || where.creatorId.in.includes(item.creatorId))) || null,
    },
    creatorMediaAsset: {
      findMany: async ({ where }) => assets.filter((asset) => {
        if (where?.agencyId && where.agencyId !== "agency-1") return false;
        if (where?.creatorId && where.creatorId !== asset.creatorId) return false;
        if (where?.source && where.source !== asset.source) return false;
        if (where?.mediaId?.in && !where.mediaId.in.includes(asset.mediaId)) return false;
        return !where?.OR || where.OR.some((group) => group.creatorId === asset.creatorId && group.mediaId.in.includes(asset.mediaId));
      }),
    },
  };
  db.creatorAccount = {
    findFirst: async ({ where }) => where.id === "creator-1" && where.agencyId === "agency-1" ? creator : null,
    findMany: async ({ where }) => (where.id?.in || []).filter((id) => id === "creator-1").map((id) => ({ id })),
  };
  const member = { id: "chatter-1", agencyId: "agency-1", roleKey: "chatter", role: "OPERATOR", assignedCreators: "all", permissions: { "chats.reply": true } };
  return { db, member, row, order, assets, rows };
}

test("approved finalized content becomes a compact READY_TO_DELIVER read model with due price", async () => {
  const { db, member } = fixture();
  const result = await listCustomReadyDeliveries({ agencyId: "agency-1", member, db });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  const item = result.items[0];
  assert.equal(item.customOrderId, "custom-1");
  assert.equal(item.remainingAmountCents, 2000);
  assert.equal(item.deliveryPriceCents, 2000);
  assert.equal(item.freeDelivery, false);
  assert.equal(item.readyAt, "2026-08-22T08:00:00.000Z");
  assert.equal(item.vaultFolderId, "folder-77");
  assert.deepEqual(item.media.map((media) => media.mediaId), ["9001", "9002"]);
});

test("Telegram task deliveredAt does not suppress READY; partial fan delivery returns only remaining media and residual ask", async () => {
  const { db, member, order } = fixture();
  order.deliverySentMediaIds = ["9001"];
  order.deliveryMessageIds = ["msg-1"];
  order.deliveryOfferedCents = 1500;
  const result = await getCustomReadyDelivery({ agencyId: "agency-1", member, customOrderId: "custom-1", db });
  assert.equal(result.item.deliveryPriceCents, 500);
  assert.equal(result.item.mediaCount, 1);
  assert.equal(result.item.approvedMediaCount, 2);
  assert.equal(result.item.deliveredMediaCount, 1);
  assert.deepEqual(result.item.deliveredMediaIds, ["9001"]);
  assert.deepEqual(result.item.media.map((media) => media.mediaId), ["9002"]);
});

test("fully paid approved custom is prepared as FREE without storing another payment state", async () => {
  const { db, member, order } = fixture();
  order.paidAmountCents = 6000;
  const result = await getCustomReadyDelivery({ agencyId: "agency-1", member, customOrderId: "custom-1", db });
  assert.equal(result.item.deliveryPriceCents, 0);
  assert.equal(result.item.freeDelivery, true);
  assert.equal(result.item.paymentStatus, "PAID_IN_FULL");
});

test("approved legacy content without a pinned execution profile is not READY until move-only recovery settles its historical destination", async () => {
  const { db, member, row } = fixture();
  row.executionPinnedAt = null;
  row.executionVaultFolderId = null;
  const result = await listCustomReadyDeliveries({ agencyId: "agency-1", member, db });
  assert.deepEqual(result.items, []);
  await assert.rejects(
    () => getCustomReadyDelivery({ agencyId: "agency-1", member, customOrderId: "custom-1", db }),
    (error) => error?.code === "CUSTOM_DELIVERY_NOT_READY",
  );
});

test("delivery queue fails closed for partial Content Library finalization or delivered order", async () => {
  const { db, member, assets, order } = fixture();
  assets.pop();
  let result = await listCustomReadyDeliveries({ agencyId: "agency-1", member, db });
  assert.equal(result.items.length, 0);
  assets.push({ creatorId: "creator-1", mediaId: "9002", source: "CUSTOM", customOrderId: "custom-1", customSubmissionId: "sub-1", customFullPriceCents: 6000, mediaType: "video", thumbUrl: null, previewUrl: null, fullUrl: null, folderIds: [], catalogActive: true, sortingStatus: "UNSORTED" });
  order.fanDeliveredAt = new Date();
  result = await listCustomReadyDeliveries({ agencyId: "agency-1", member, db });
  assert.equal(result.items.length, 0);
});

test("ready delivery requires chats.reply and creator scope", async () => {
  const { db, member } = fixture();
  await assert.rejects(
    () => listCustomReadyDeliveries({ agencyId: "agency-1", member: { ...member, permissions: { "chats.reply": false } }, db }),
    (error) => error.code === "CUSTOM_DELIVERY_FORBIDDEN",
  );
  const scoped = { ...member, assignedCreators: ["creator-other"] };
  db.creatorAccount = { findMany: async () => [{ id: "creator-other" }] };
  const result = await listCustomReadyDeliveries({ agencyId: "agency-1", member: scoped, db });
  assert.equal(result.items.length, 0);
});

test("ready queue pushes delivered/history filtering into Prisma instead of bounded post-filter scans", async () => {
  let capturedWhere = null;
  const db = {
    customContentSubmission: { findMany: async ({ where }) => { capturedWhere = where; return []; } },
    creatorMediaAsset: { findMany: async () => [] },
  };
  db.creatorAccount = {
    findFirst: async ({ where }) => where.id === "creator-1" && where.agencyId === "agency-1" ? creator : null,
    findMany: async ({ where }) => (where.id?.in || []).filter((id) => id === "creator-1").map((id) => ({ id })),
  };
  const member = { id: "chatter-1", agencyId: "agency-1", roleKey: "chatter", role: "OPERATOR", assignedCreators: "all", permissions: { "chats.reply": true } };
  const result = await listCustomReadyDeliveries({ agencyId: "agency-1", member, db });
  assert.equal(result.items.length, 0);
  assert.deepEqual(capturedWhere.customOrder, { is: { type: "CONTENT", status: "PENDING", fanDeliveredAt: null } });
  assert.deepEqual(capturedWhere.reviewedAt, { not: null });
});

test("ready queue reaches an eligible delivery after more than 2000 poisoned APPROVED rows", async () => {
  const { db, member, row, order, assets, rows } = fixture();
  const base = new Date("2026-03-01T00:00:00.000Z").getTime();
  rows.splice(0, rows.length); assets.splice(0, assets.length);
  for (let i = 0; i < 2000; i += 1) {
    const poisonedOrder = { ...order, id: `poison-ready-order-${i}`, dialogId: String(20000 + i) };
    rows.push({ ...row, id: `poison-ready-${String(i).padStart(4, "0")}`, customOrderId: poisonedOrder.id, customOrder: poisonedOrder, telegramMessageIds: [i + 1], ofMediaIds: [`6${20000 + i}`], executionPinnedAt: null, executionVaultFolderId: null, reviewedAt: new Date(base + i) });
  }
  const liveOrder = { ...order, id: "reachable-ready-order", dialogId: "88888" };
  rows.push({ ...row, id: "reachable-ready", customOrderId: liveOrder.id, customOrder: liveOrder, telegramMessageIds: [888888], ofMediaIds: ["888888"], executionPinnedAt: new Date(base + 3000), executionVaultFolderId: "folder-77", ...receipt("folder-77", 1, ["888888"], new Date(base + 3000)), reviewedAt: new Date(base + 3000) });
  assets.push({ creatorId: "creator-1", mediaId: "888888", source: "CUSTOM", customOrderId: "reachable-ready-order", customSubmissionId: "reachable-ready", customFullPriceCents: 6000, mediaType: "video", thumbUrl: null, previewUrl: null, fullUrl: null, folderIds: ["folder-77"], catalogActive: true, sortingStatus: "SORTED" });
  const result = await listCustomReadyDeliveries({ agencyId: "agency-1", member, db, limit: 1 });
  assert.deepEqual(result.items.map((item) => item.submissionId), ["reachable-ready"]);
});

test("READY fails closed when a current-receipt CUSTOM asset loses the pinned folder projection", async () => {
  const { db, member, assets } = fixture();
  assets[0].folderIds = [];
  assets[0].sortingStatus = "UNSORTED";
  const result = await listCustomReadyDeliveries({ agencyId: "agency-1", member, db });
  assert.deepEqual(result.items, []);
  await assert.rejects(
    () => getCustomReadyDelivery({ agencyId: "agency-1", member, customOrderId: "custom-1", db }),
    (error) => error?.code === "CUSTOM_DELIVERY_NOT_READY",
  );
});

test("V20.9 delivery readiness requires assets from the exact approved submission version", async () => {
  const { db, member, assets } = fixture();
  assets[0].customSubmissionId = "sub-old-rejected";
  const result = await listCustomReadyDeliveries({ agencyId: "agency-1", member, db });
  assert.deepEqual(result.items, [], "rejected/older version assets must never satisfy a newer approved submission");
});


test("manual-send preflight allows generic media but exact-preflights any CUSTOM media", async () => {
  const { db, member, assets } = fixture();
  let result = await preflightCustomManualSend({ agencyId: "agency-1", member, creatorId: "creator-1", dialogId: "777", mediaIds: ["general-1"], db });
  assert.deepEqual(result, { ok: true, matched: false, allow: true, code: null });

  result = await preflightCustomManualSend({ agencyId: "agency-1", member, creatorId: "creator-1", dialogId: "777", mediaIds: ["9001", "9002"], db });
  assert.equal(result.matched, true);
  assert.equal(result.allow, true);
  assert.equal(result.item.customOrderId, "custom-1");
  assert.deepEqual(result.attemptedCustomMediaIds, ["9001", "9002"]);

  assets[0].customSubmissionId = "stale-submission";
  result = await preflightCustomManualSend({ agencyId: "agency-1", member, creatorId: "creator-1", dialogId: "777", mediaIds: ["9001"], db });
  assert.equal(result.allow, false);
  assert.equal(result.code, "CUSTOM_DELIVERY_NOT_READY");
});

test("manual-send preflight fails closed for mixed CUSTOM/general media and terminal/not-ready Customs", async () => {
  const { db, member, order } = fixture();
  let result = await preflightCustomManualSend({ agencyId: "agency-1", member, creatorId: "creator-1", dialogId: "777", mediaIds: ["9001", "general-1"], db });
  assert.equal(result.allow, false);
  assert.equal(result.code, "CUSTOM_DELIVERY_MIXED_MEDIA");

  order.status = "CANCELLED";
  // The fixture's findFirst is intentionally simple, so make current READY fail through fanDeliveredAt.
  order.fanDeliveredAt = new Date();
  result = await preflightCustomManualSend({ agencyId: "agency-1", member, creatorId: "creator-1", dialogId: "777", mediaIds: ["9001"], db });
  assert.equal(result.allow, false);
  assert.equal(result.code, "CUSTOM_DELIVERY_NOT_READY");
});


test("manual-send preflight keeps proven submission media CUSTOM even when CreatorMediaAsset projection is missing", async () => {
  const { db, member, assets } = fixture();
  assets.splice(0, assets.length);
  const result = await preflightCustomManualSend({ agencyId: "agency-1", member, creatorId: "creator-1", dialogId: "777", mediaIds: ["9001"], db });
  assert.equal(result.matched, true);
  assert.equal(result.allow, false);
  assert.equal(result.code, "CUSTOM_DELIVERY_NOT_READY");
});


test("manual-send preflight rejects an explicit media contract overflow instead of silently truncating correctness", async () => {
  const { db, member } = fixture();
  const tooMany = Array.from({ length: 201 }, (_, index) => String(100000 + index));
  await assert.rejects(
    () => preflightCustomManualSend({ agencyId: "agency-1", member, creatorId: "creator-1", dialogId: "777", mediaIds: tooMany, db }),
    (error) => error?.code === "CUSTOM_DELIVERY_MEDIA_LIMIT" && error?.status === 413,
  );
});


test("programmatic media preflight blocks any CUSTOM provenance but allows generic media", async () => {
  const { db, member } = fixture();
  let result = await preflightProgrammaticCustomMedia({ agencyId: "agency-1", member, creatorId: "creator-1", mediaIds: ["general-1"], db });
  assert.deepEqual(result, { ok: true, matched: false, allow: true, code: null, customMediaIds: [] });

  result = await preflightProgrammaticCustomMedia({ agencyId: "agency-1", member, creatorId: "creator-1", mediaIds: ["9001"], db });
  assert.equal(result.matched, true);
  assert.equal(result.allow, false);
  assert.equal(result.code, "CUSTOM_MEDIA_PROGRAMMATIC_FORBIDDEN");
  assert.deepEqual(result.customMediaIds, ["9001"]);
});

test("programmatic media preflight keeps submission-proven CUSTOM media blocked when typed asset projection is missing", async () => {
  const { db, member, assets } = fixture();
  assets.splice(0, assets.length);
  const result = await preflightProgrammaticCustomMedia({ agencyId: "agency-1", member, creatorId: "creator-1", mediaIds: ["9001"], db });
  assert.equal(result.matched, true);
  assert.equal(result.allow, false);
  assert.equal(result.code, "CUSTOM_MEDIA_PROGRAMMATIC_FORBIDDEN");
  assert.deepEqual(result.customMediaIds, ["9001"]);
});
