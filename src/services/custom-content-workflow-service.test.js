"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  assignUnassignedCustomContentSubmission,
  listAwaitingCustomRevisions,
  listCustomSubmissionAssignmentCandidates,
  listCustomPipelineResolutionQueue,
  listUnassignedCustomContentSubmissions,
  resolveUnassignedCustomContentSubmission,
  resolveRetiredCreatorPendingCustomOrder,
} = require("./custom-content-workflow-service");
const { vaultSettlementFingerprint } = require("./custom-content-pipeline-authority-service");

const manager = { id: "manager-1", userId: "user-1", agencyId: "agency-1", roleKey: "manager", role: "MANAGER", assignedCreators: "all", permissions: { "team.analytics.view": true, "content.review_customs": true } };
const viewer = { ...manager, id: "viewer-1", permissions: { "team.analytics.view": true, "content.review_customs": false } };
const creator = { id: "creator-1", agencyId: "agency-1", displayName: "Model One", username: "modelone", avatarUrl: null, deletedAt: null };
const now = new Date("2026-08-22T12:00:00.000Z");

function submission(overrides = {}) {
  return {
    id: "sub-unassigned", agencyId: "agency-1", creatorId: "creator-1", customOrderId: null,
    telegramMessageIds: [101, 102], ofMediaIds: ["9001"], comment: "second angle",
    pipelineDisposition: "ACTIVE", reviewStatus: "WAITING_REVIEW", reviewComment: null, reviewedAt: null, reviewedByMemberId: null,
    receivedAt: new Date("2026-08-22T11:00:00.000Z"), createdAt: new Date("2026-08-22T11:00:00.000Z"), updatedAt: new Date("2026-08-22T11:00:00.000Z"),
    creator, reviewedByMember: null,
    ...overrides,
  };
}
function order(id, overrides = {}) {
  return {
    id, agencyId: "agency-1", creatorId: "creator-1", dialogId: id.replace(/\D/g, "") || "777", scenario: `Scenario ${id}`,
    type: "CONTENT", contentKind: "VIDEO", status: "PENDING", fanDeliveredAt: null, contentBoundAt: null,
    priceCents: 6000, paidAmountCents: 2000, dueAt: null, createdAt: new Date("2026-08-22T10:00:00.000Z"), updatedAt: new Date("2026-08-22T10:00:00.000Z"),
    creator,
    ...overrides,
  };
}
function fakeDb({ submissions = [], orders = [], assets = [], writes = [], telegramIntents = [], creatorRecord = creator } = {}) {
  const orderForSubmission = (row) => row.customOrder || orders.find((item) => item.id === row.customOrderId) || null;
  const matchesSubmissionWhere = (row, where = {}) => {
    if (where.agencyId && row.agencyId !== where.agencyId) return false;
    if (where.creatorId && typeof where.creatorId === "string" && row.creatorId !== where.creatorId) return false;
    if (where.creatorId?.in && !where.creatorId.in.includes(row.creatorId)) return false;
    if (Array.isArray(where.OR) && !where.OR.some((entry) => matchesSubmissionWhere(row, entry))) return false;
    if (where.id && typeof where.id === "string" && row.id !== where.id) return false;
    if (where.id?.not && row.id === where.id.not) return false;
    if (where.customOrderId === null && row.customOrderId !== null) return false;
    if (where.customOrderId?.not === null && row.customOrderId === null) return false;
    if (typeof where.customOrderId === "string" && row.customOrderId !== where.customOrderId) return false;
    if (where.customOrderId?.in && !where.customOrderId.in.includes(row.customOrderId)) return false;
    if (where.reviewStatus && row.reviewStatus !== where.reviewStatus) return false;
    if (where.pipelineDisposition && String(row.pipelineDisposition || "ACTIVE") !== String(where.pipelineDisposition)) return false;
    if (where.pipelineBlockedCode?.not === null && row.pipelineBlockedCode == null) return false;
    if (where.receivedAt?.lte && new Date(row.receivedAt) > new Date(where.receivedAt.lte)) return false;
    if (where.customOrder?.is) {
      const related = orderForSubmission(row);
      if (!related) return false;
      for (const [key, value] of Object.entries(where.customOrder.is)) {
        if (value === null ? related[key] !== null : related[key] !== value) return false;
      }
    }
    return true;
  };
  const restoreRows = (rows, snapshots) => {
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const snapshot = snapshots[index];
      for (const key of Object.keys(row)) if (!Object.prototype.hasOwnProperty.call(snapshot, key)) delete row[key];
      Object.assign(row, snapshot);
    }
  };
  const matchesWriteWhere = (row, where = {}) => {
    if (where.agencyId && row.agencyId !== where.agencyId) return false;
    if (where.creatorId && typeof where.creatorId === "string" && row.creatorId !== where.creatorId) return false;
    if (where.creatorId?.in && !where.creatorId.in.includes(row.creatorId)) return false;
    if (typeof where.actionType === "string" && row.actionType !== where.actionType) return false;
    if (where.actionType?.in && !where.actionType.in.includes(row.actionType)) return false;
    if (typeof where.status === "string" && row.status !== where.status) return false;
    if (where.status?.in && !where.status.in.includes(row.status)) return false;
    if (where.failureCode && row.failureCode !== where.failureCode) return false;
    if (Array.isArray(where.OR) && !where.OR.some((branch) => matchesWriteWhere(row, branch))) return false;
    if (typeof where.targetId === "string" && String(row.targetId || "") !== where.targetId) return false;
    if (where.targetId && typeof where.targetId === "object" && where.targetId.startsWith && !String(row.targetId || "").startsWith(String(where.targetId.startsWith))) return false;
    return true;
  };
  const db = {
    agency: {
      findFirst: async ({ where }) => where.id === "agency-1" ? { id: "agency-1", deletedAt: null, status: "ACTIVE" } : null,
      findUnique: async ({ where }) => where.id === "agency-1" ? { id: "agency-1", deletedAt: null, status: "ACTIVE" } : null,
    },
    creatorAccount: {
      findFirst: async ({ where }) => where.id === creatorRecord.id && where.agencyId === creatorRecord.agencyId ? creatorRecord : null,
      findMany: async () => [creatorRecord],
    },
    customContentSubmission: {
      findMany: async ({ where, take = 9999, cursor = null, skip = 0, orderBy = [] }) => {
        let filtered = submissions.filter((row) => matchesSubmissionWhere(row, where));
        // The production queries use cursor continuation over an explicit stable order.
        const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
        filtered.sort((a, b) => {
          for (const spec of specs) {
            const [key, dir] = Object.entries(spec || {})[0] || [];
            if (!key) continue;
            const av = a[key], bv = b[key];
            const cmp = av instanceof Date || bv instanceof Date ? new Date(av || 0) - new Date(bv || 0) : String(av ?? "").localeCompare(String(bv ?? ""));
            if (cmp) return dir === "desc" ? -cmp : cmp;
          }
          return 0;
        });
        if (cursor?.id) { const index = filtered.findIndex((row) => row.id === cursor.id); if (index >= 0) filtered = filtered.slice(index + Math.max(1, skip)); }
        else if (skip) filtered = filtered.slice(skip);
        return filtered.slice(0, take).map((row) => ({ ...row, creator: row.creator || creator, customOrder: row.customOrder || orders.find((o) => o.id === row.customOrderId) || null }));
      },
      findFirst: async ({ where, orderBy = [] }) => {
        let matches = submissions.filter((row) => {
          if (where.id && typeof where.id === "string" && row.id !== where.id) return false;
          if (where.id?.not && row.id === where.id.not) return false;
          if (where.agencyId && row.agencyId !== where.agencyId) return false;
          if (where.customOrderId && row.customOrderId !== where.customOrderId) return false;
          if (where.reviewStatus && row.reviewStatus !== where.reviewStatus) return false;
          return true;
        });
        const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
        matches.sort((a, b) => {
          for (const spec of specs) { const [key, dir] = Object.entries(spec || {})[0] || []; if (!key) continue; const av=a[key], bv=b[key]; const cmp = av instanceof Date || bv instanceof Date ? new Date(av || 0)-new Date(bv || 0) : String(av ?? "").localeCompare(String(bv ?? "")); if (cmp) return dir === "desc" ? -cmp : cmp; } return 0;
        });
        return matches[0] || null;
      },
      count: async ({ where }) => submissions.filter((row) => matchesSubmissionWhere(row, where)).length,
      update: async ({ where, data }) => {
        const row = submissions.find((item) => item.id === where.id);
        if (!row) throw new Error("missing submission");
        Object.assign(row, data, { updatedAt: new Date(now) });
        return row;
      },
      updateMany: async ({ where, data }) => {
        const row = submissions.find((item) => {
          if (where.id && item.id !== where.id) return false;
          if (where.agencyId && item.agencyId !== where.agencyId) return false;
          if (where.reviewStatus && item.reviewStatus !== where.reviewStatus) return false;
          if (Object.prototype.hasOwnProperty.call(where, "customOrderId") && (item.customOrderId || null) !== (where.customOrderId || null)) return false;
          if (where.updatedAt && new Date(item.updatedAt).getTime() !== new Date(where.updatedAt).getTime()) return false;
          return true;
        });
        if (!row) return { count: 0 };
        Object.assign(row, data, { updatedAt: new Date(new Date(row.updatedAt).getTime() + 1) });
        return { count: 1 };
      },
    },
    customOrder: {
      findMany: async ({ where, take = 9999, cursor = null, skip = 0, orderBy = [] }) => {
        let filtered = orders.filter((row) => {
          if (where.agencyId && row.agencyId !== where.agencyId) return false;
          if (where.creatorId && row.creatorId !== where.creatorId) return false;
          if (where.type && row.type !== where.type) return false;
          if (where.status && row.status !== where.status) return false;
          if (where.fanDeliveredAt === null && row.fanDeliveredAt !== null) return false;
          return true;
        });
        const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
        filtered.sort((a, b) => {
          for (const spec of specs) {
            const [key, dir] = Object.entries(spec || {})[0] || [];
            if (!key) continue;
            const av = a[key], bv = b[key];
            const cmp = av instanceof Date || bv instanceof Date ? new Date(av || 0) - new Date(bv || 0) : String(av ?? "").localeCompare(String(bv ?? ""));
            if (cmp) return dir === "desc" ? -cmp : cmp;
          }
          return 0;
        });
        if (cursor?.id) { const index = filtered.findIndex((row) => row.id === cursor.id); if (index >= 0) filtered = filtered.slice(index + Math.max(1, skip)); }
        else if (skip) filtered = filtered.slice(skip);
        return filtered.slice(0, take);
      },
      findFirst: async ({ where }) => orders.find((row) => row.id === where.id && row.agencyId === where.agencyId && (where.creatorId === undefined || row.creatorId === where.creatorId)) || null,
      count: async ({ where }) => orders.filter((row) => {
        if (where.agencyId && row.agencyId !== where.agencyId) return false;
        if (where.creatorId && typeof where.creatorId === "string" && row.creatorId !== where.creatorId) return false;
        if (where.creatorId?.in && !where.creatorId.in.includes(row.creatorId)) return false;
        if (where.type && row.type !== where.type) return false;
        if (where.status && row.status !== where.status) return false;
        if (where.fanDeliveredAt === null && row.fanDeliveredAt !== null) return false;
        return true;
      }).length,
      updateMany: async ({ where, data }) => {
        const row = orders.find((item) => item.id === where.id && item.agencyId === where.agencyId
          && (where.creatorId === undefined || item.creatorId === where.creatorId)
          && (where.type === undefined || item.type === where.type)
          && (where.status === undefined || item.status === where.status)
          && (where.contentBoundAt === undefined || (where.contentBoundAt === null ? item.contentBoundAt == null : item.contentBoundAt === where.contentBoundAt))
          && (where.updatedAt === undefined || new Date(item.updatedAt).getTime() === new Date(where.updatedAt).getTime()));
        if (!row) return { count: 0 };
        Object.assign(row, data, { updatedAt: new Date(new Date(row.updatedAt).getTime() + 1) });
        return { count: 1 };
      },
    },
    creatorMediaAsset: {
      findMany: async ({ where }) => assets.filter((asset) => {
        if (where.agencyId && asset.agencyId !== where.agencyId) return false;
        if (where.source && asset.source !== where.source) return false;
        if (Array.isArray(where.OR) && !where.OR.some((group) => group.creatorId === asset.creatorId && group.mediaId.in.includes(asset.mediaId))) return false;
        return true;
      }),
    },
    automationDelivery: {
      findFirst: async ({ where }) => writes.find((row) => matchesWriteWhere(row, where)) || null,
      updateMany: async ({ where, data }) => {
        let count = 0;
        for (const row of writes) {
          if (where.agencyId && row.agencyId !== where.agencyId) continue;
          if (where.creatorId && row.creatorId !== where.creatorId) continue;
          if (typeof where.actionType === "string" && row.actionType !== where.actionType) continue;
          if (where.actionType?.in && !where.actionType.in.includes(row.actionType)) continue;
          if (where.status?.in && !where.status.in.includes(row.status)) continue;
          if (where.OR && !where.OR.some((entry) => String(row.targetId || "").startsWith(String(entry.targetId?.startsWith || "")))) continue;
          Object.assign(row, data); count += 1;
        }
        return { count };
      },
      findMany: async ({ where, take = 9999, skip = 0, orderBy = [] }) => {
        const filtered = writes.filter((row) => matchesWriteWhere(row, where));
        const specs = Array.isArray(orderBy) ? orderBy : [orderBy];
        filtered.sort((a, b) => {
          for (const spec of specs) {
            const [key, dir] = Object.entries(spec || {})[0] || [];
            if (!key) continue;
            const av = a[key], bv = b[key];
            const cmp = av instanceof Date || bv instanceof Date ? new Date(av || 0) - new Date(bv || 0) : String(av ?? "").localeCompare(String(bv ?? ""));
            if (cmp) return dir === "desc" ? -cmp : cmp;
          }
          return 0;
        });
        return filtered.slice(skip, skip + take).map((row) => ({ ...row, creator: row.creator || creator }));
      },
      count: async ({ where }) => writes.filter((row) => matchesWriteWhere(row, where)).length,
    },

    telegramDeliveryIntent: {
      findMany: async ({ where = {} } = {}) => telegramIntents.filter((row) => {
        if (where.agencyId && row.agencyId !== where.agencyId) return false;
        if (where.creatorId && row.creatorId !== where.creatorId) return false;
        if (where.customOrderId && row.customOrderId !== where.customOrderId) return false;
        if (where.customSubmissionId?.in && !where.customSubmissionId.in.map(String).includes(String(row.customSubmissionId || ""))) return false;
        if (where.kind && typeof where.kind === "string" && row.kind !== where.kind) return false;
        if (where.kind?.in && !where.kind.in.includes(row.kind)) return false;
        if (where.state && typeof where.state === "string" && row.state !== where.state) return false;
        if (where.state?.in && !where.state.in.includes(row.state)) return false;
        return true;
      }),
      updateMany: async ({ where = {}, data = {} }) => {
        let count = 0;
        for (const row of telegramIntents) {
          if (where.agencyId && row.agencyId !== where.agencyId) continue;
          if (where.creatorId && row.creatorId !== where.creatorId) continue;
          if (where.customOrderId && row.customOrderId !== where.customOrderId) continue;
          if (where.state?.in && !where.state.in.includes(row.state)) continue;
          if (where.commitStartedAt === null && row.commitStartedAt != null) continue;
          for (const [key, value] of Object.entries(data)) {
            if (value && typeof value === "object" && Object.prototype.hasOwnProperty.call(value, "increment")) row[key] = Number(row[key] || 0) + Number(value.increment || 0);
            else row[key] = value;
          }
          count += 1;
        }
        return { count };
      },
    },
    auditLog: { create: async () => ({ id: "audit-1" }) },
    async $executeRawUnsafe() { return 1; },
    async $transaction(fn) {
      const submissionSnapshots = submissions.map((row) => structuredClone(row));
      const orderSnapshots = orders.map((row) => structuredClone(row));
      const writeSnapshots = writes.map((row) => structuredClone(row));
      const telegramSnapshots = telegramIntents.map((row) => structuredClone(row));
      try { return await fn(this); }
      catch (error) {
        restoreRows(submissions, submissionSnapshots);
        restoreRows(orders, orderSnapshots);
        restoreRows(writes, writeSnapshots);
        restoreRows(telegramIntents, telegramSnapshots);
        throw error;
      }
    },
  };
  return db;
}

test("unassigned queue stays compact and reports real upload/library progress", async () => {
  const pinnedAt = new Date("2026-08-22T11:30:00.000Z");
  const row = submission({
    executionVaultFolderId: "vault-unassigned", executionProfileRevision: 1, executionPinnedAt: pinnedAt,
    vaultSettlementFolderId: "vault-unassigned", vaultSettlementProfileRevision: 1,
    vaultSettlementMediaFingerprint: vaultSettlementFingerprint({ folderId: "vault-unassigned", profileRevision: 1, mediaIds: ["9001"] }),
    vaultSettlementConfirmedAt: pinnedAt, vaultSettlementConfirmedByDeviceId: "device-1",
  });
  const db = fakeDb({ submissions: [row], assets: [{ agencyId: "agency-1", creatorId: "creator-1", mediaId: "9001", source: "CUSTOM", customOrderId: null, customSubmissionId: "sub-unassigned", customFullPriceCents: null, catalogActive: true, sortingStatus: "SORTED", folderIds: ["vault-unassigned"], mediaType: "video", thumbUrl: "https://cdn/9001.jpg", previewUrl: null, fullUrl: null }] });
  const result = await listUnassignedCustomContentSubmissions({ agencyId: "agency-1", member: manager, db });
  assert.equal(result.count, 1);
  assert.equal(result.canAssign, true);
  assert.equal(result.items[0].telegramMessageCount, 2);
  assert.equal(result.items[0].ofMediaCount, 1);
  assert.equal(result.items[0].uploadComplete, false);
  assert.equal(result.items[0].finalizedMediaCount, 1);
  assert.equal(result.items[0].media[0].mediaId, "9001");
});

test("unassigned progress fails closed when CUSTOM asset loses its pinned folder projection", async () => {
  const pinnedAt = new Date("2026-08-22T11:30:00.000Z");
  const row = submission({
    executionVaultFolderId: "vault-unassigned", executionProfileRevision: 1, executionPinnedAt: pinnedAt,
    vaultSettlementFolderId: "vault-unassigned", vaultSettlementProfileRevision: 1,
    vaultSettlementMediaFingerprint: vaultSettlementFingerprint({ folderId: "vault-unassigned", profileRevision: 1, mediaIds: ["9001"] }),
    vaultSettlementConfirmedAt: pinnedAt, vaultSettlementConfirmedByDeviceId: "device-1",
  });
  const db = fakeDb({ submissions: [row], assets: [{ agencyId: "agency-1", creatorId: "creator-1", mediaId: "9001", source: "CUSTOM", customOrderId: null, customSubmissionId: "sub-unassigned", customFullPriceCents: null, catalogActive: true, sortingStatus: "UNSORTED", folderIds: [], mediaType: "video" }] });
  const result = await listUnassignedCustomContentSubmissions({ agencyId: "agency-1", member: manager, db });
  assert.equal(result.items[0].finalizedMediaCount, 0);
  assert.equal(result.items[0].libraryFinalized, false);
});



test("Pipeline Resolution does not offer ARCHIVE when current-receipt CUSTOM projection lost its pinned folder", async () => {
  const pinnedAt = new Date("2026-08-22T11:30:00.000Z");
  const row = submission({
    id: "sub-drift", telegramMessageIds: [101], ofMediaIds: ["9001"],
    executionVaultFolderId: "vault-pinned", executionProfileRevision: 1, executionPinnedAt: pinnedAt,
    vaultSettlementFolderId: "vault-pinned", vaultSettlementProfileRevision: 1,
    vaultSettlementMediaFingerprint: vaultSettlementFingerprint({ folderId: "vault-pinned", profileRevision: 1, mediaIds: ["9001"] }),
    vaultSettlementConfirmedAt: pinnedAt, vaultSettlementConfirmedByDeviceId: "device-1",
  });
  const db = fakeDb({ submissions: [row], assets: [{ agencyId: "agency-1", creatorId: "creator-1", mediaId: "9001", source: "CUSTOM", customOrderId: null, customSubmissionId: "sub-drift", customFullPriceCents: null, catalogActive: true, sortingStatus: "UNSORTED", folderIds: [] }] });
  const result = await listCustomPipelineResolutionQueue({ agencyId: "agency-1", member: manager, creatorId: "creator-1", db });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].finalizedMediaCount, 0);
  assert.equal(result.items[0].canArchive, false);
});

test("unassigned queue continuation does not silently rewind after the historical 1m offset horizon", async () => {
  const db = fakeDb({ submissions: [submission()] });
  const requestedOffset = 1_000_123;
  const result = await listUnassignedCustomContentSubmissions({ agencyId: "agency-1", member: manager, offset: requestedOffset, db });
  assert.equal(result.offset, requestedOffset);
  assert.equal(result.nextOffset, requestedOffset);
  assert.deepEqual(result.items, []);
});

test("pipeline resolution exposes PENDING CONTENT order blockers even when no submission exists", async () => {
  const pending = order("custom-blocker", { dialogId: "998877", scenario: "Pending custom blocks creator retirement" });
  const db = fakeDb({ submissions: [], orders: [pending] });
  const result = await listCustomPipelineResolutionQueue({ agencyId: "agency-1", member: manager, creatorId: "creator-1", db });
  assert.equal(result.focusedCreatorId, "creator-1");
  assert.equal(result.items.length, 0, "no fake submission should be invented for an order-only blocker");
  assert.equal(result.pendingCustomCount, 1);
  assert.equal(result.pendingCustomsTruncated, false);
  assert.deepEqual(result.pendingCustoms.map((item) => [item.customOrderId, item.creatorId, item.dialogId]), [["custom-blocker", "creator-1", "998877"]]);
});



test("pipeline resolution exposes active CUSTOM_RELAY_SEND blockers even if no current submission/order card can represent them", async () => {
  const writes = [{
    id: "write-1", agencyId: "agency-1", creatorId: "creator-1", actionType: "CUSTOM_RELAY_SEND", targetId: "legacy-sub:0",
    status: "RECONCILE_REQUIRED", claimedByDeviceId: "device-a", claimUntil: new Date("2026-08-22T12:10:00Z"),
    writeCommitAt: new Date("2026-08-22T12:00:00Z"), updatedAt: new Date("2026-08-22T12:01:00Z"),
  }];
  const db = fakeDb({ submissions: [], orders: [], writes });
  const result = await listCustomPipelineResolutionQueue({ agencyId: "agency-1", member: manager, creatorId: "creator-1", db });
  assert.equal(result.pendingCustomCount, 0);
  assert.equal(result.items.length, 0);
  assert.equal(result.activeWriteCount, 1);
  assert.equal(result.activeWrites[0].status, "RECONCILE_REQUIRED");
  assert.equal(result.activeWrites[0].targetId, "legacy-sub:0");
});

test("Pipeline Resolution keeps terminal no-retry Custom manual outcomes visible because they still block the logical delivery phase", async () => {
  const writes = [{
    id: "manual-unresolved-1", agencyId: "agency-1", creatorId: "creator-1", actionType: "CUSTOM_MANUAL_SEND", targetId: "custom-1",
    status: "FAILED", failureCode: "outcome_unresolved_do_not_retry", claimedByDeviceId: null, claimUntil: null,
    writeCommitAt: new Date("2026-09-06T18:00:00Z"), updatedAt: new Date("2026-09-06T18:31:00Z"),
  }];
  const db = fakeDb({ submissions: [], orders: [], writes });
  const result = await listCustomPipelineResolutionQueue({ agencyId: "agency-1", member: manager, creatorId: "creator-1", db });
  assert.equal(result.activeWriteCount, 1);
  assert.equal(result.activeWrites[0].actionType, "CUSTOM_MANUAL_SEND");
  assert.equal(result.activeWrites[0].status, "FAILED");
  assert.equal(result.activeWrites[0].failureCode, "outcome_unresolved_do_not_retry");
});

test("pipeline resolution paginates pending Custom and active-write blocker lanes independently beyond 100", async () => {
  const orders = Array.from({ length: 135 }, (_, index) => order(`custom-page-${String(index).padStart(3, "0")}`, {
    createdAt: new Date(1_700_000_000_000 + index * 1000),
  }));
  const writes = Array.from({ length: 135 }, (_, index) => ({
    id: `write-page-${String(index).padStart(3, "0")}`, agencyId: "agency-1", creatorId: "creator-1", actionType: "CUSTOM_RELAY_SEND",
    targetId: `sub-${index}:0`, status: "RECONCILE_REQUIRED", claimedByDeviceId: "device-a", claimUntil: null, writeCommitAt: null,
    updatedAt: new Date(1_700_100_000_000 + index * 1000),
  }));
  const db = fakeDb({ submissions: [], orders, writes });
  const first = await listCustomPipelineResolutionQueue({ agencyId: "agency-1", member: manager, creatorId: "creator-1", limit: 50, db });
  assert.equal(first.pendingCustoms.length, 50);
  assert.equal(first.pendingCustomCount, 135);
  assert.equal(first.pendingCustomNextOffset, 50);
  assert.equal(first.pendingCustomHasMore, true);
  assert.equal(first.activeWrites.length, 50);
  assert.equal(first.activeWriteCount, 135);
  assert.equal(first.activeWriteNextOffset, 50);
  assert.equal(first.activeWriteHasMore, true);

  const second = await listCustomPipelineResolutionQueue({
    agencyId: "agency-1", member: manager, creatorId: "creator-1", limit: 50,
    pendingCustomOffset: first.pendingCustomNextOffset, activeWriteOffset: first.activeWriteNextOffset, db,
  });
  assert.equal(second.pendingCustoms[0].customOrderId, "custom-page-050");
  assert.equal(second.pendingCustomNextOffset, 100);
  assert.equal(second.pendingCustomHasMore, true);
  assert.equal(second.activeWrites[0].writeId, "write-page-050");
  assert.equal(second.activeWriteNextOffset, 100);
  assert.equal(second.activeWriteHasMore, true);

  const third = await listCustomPipelineResolutionQueue({
    agencyId: "agency-1", member: manager, creatorId: "creator-1", limit: 50,
    pendingCustomOffset: second.pendingCustomNextOffset, activeWriteOffset: second.activeWriteNextOffset, db,
  });
  assert.equal(third.pendingCustoms.length, 35);
  assert.equal(third.pendingCustomHasMore, false);
  assert.equal(third.activeWrites.length, 35);
  assert.equal(third.activeWriteHasMore, false);
});

test("legacy retired creator with confirmed media has an explicit audited ABANDONED escape without inventing Vault settlement", async () => {
  const retiredCreator = { ...creator, deletedAt: new Date("2026-09-05T12:00:00.000Z"), status: "DISABLED" };
  const row = submission({
    id: "legacy-retired-confirmed", creator: retiredCreator, customOrderId: null, pipelineDisposition: "SALVAGE",
    telegramMessageIds: [501], ofMediaIds: ["99501"],
    pipelineBlockedCode: "CUSTOM_SUBMISSION_CREATOR_RETIRED_LEGACY",
    executionVaultFolderId: null, executionPinnedAt: null, vaultSettlementConfirmedAt: null,
  });
  const db = fakeDb({ submissions: [row], creatorRecord: retiredCreator });
  let auditData = null;
  db.auditLog.create = async ({ data }) => { auditData = data; return { id: "audit-retired-abandon", ...data }; };

  const queue = await listCustomPipelineResolutionQueue({ agencyId: "agency-1", member: manager, creatorId: "creator-1", db });
  assert.equal(queue.items[0].creatorRetired, true);
  assert.equal(queue.items[0].canArchive, false, "no false Vault-settlement proof may be invented");
  assert.equal(queue.items[0].canAbandon, true, "retired historical debt must have an explicit terminal resolution path");

  await assert.rejects(
    () => resolveUnassignedCustomContentSubmission({ agencyId: "agency-1", member: manager, submissionId: row.id, disposition: "ABANDONED", reason: "", db }),
    (error) => error?.code === "CUSTOM_SUBMISSION_DISPOSITION_REASON_REQUIRED",
  );
  const resolved = await resolveUnassignedCustomContentSubmission({
    agencyId: "agency-1", member: manager, submissionId: row.id, disposition: "ABANDONED",
    reason: "creator was retired before pipeline cutover; preserve external proof and stop convergence", db,
  });
  assert.equal(resolved.pipelineDisposition, "ABANDONED");
  assert.deepEqual(row.ofMediaIds, ["99501"], "confirmed external media facts remain durable");
  assert.equal(row.vaultSettlementConfirmedAt, null, "terminal resolution must not synthesize Vault settlement");
  assert.equal(auditData.action, "custom_content_submission.pipeline_disposition_resolve");
  assert.equal(auditData.metadata.retiredCreatorResolution, true);
  assert.equal(auditData.metadata.confirmedMediaCount, 1);
});

test("Pipeline Resolution exposes CALL/PHYSICAL pending Customs and audited terminal path for a legacy retired creator", async () => {
  const retiredCreator = { ...creator, deletedAt: new Date("2026-09-05T12:00:00.000Z"), status: "DISABLED" };
  const call = order("legacy-retired-call", { type: "CALL", contentKind: null, creator: retiredCreator, telegramTaskMessageId: null, deliveredAt: null });
  const physical = order("legacy-retired-physical", { type: "PHYSICAL", contentKind: null, creator: retiredCreator, createdAt: new Date("2026-08-22T10:01:00.000Z") });
  const task = { id: "tg-task-legacy", agencyId: "agency-1", creatorId: retiredCreator.id, customOrderId: call.id, accountId: "tg-account", kind: "TASK", state: "CONFIRMED", commitStartedAt: now, remoteMessageId: 7001, remoteSentAt: new Date("2026-08-22T10:05:00.000Z"), confirmedAt: new Date("2026-08-22T10:05:01.000Z"), claimRevision: 2 };
  const reminder = { id: "tg-reminder-precommit", agencyId: "agency-1", creatorId: retiredCreator.id, customOrderId: call.id, accountId: "tg-account", kind: "AUTO_REMINDER", state: "PLANNED", commitStartedAt: null, claimRevision: 1 };
  const db = fakeDb({ orders: [call, physical], telegramIntents: [task, reminder], creatorRecord: retiredCreator });
  let auditData = null;
  db.auditLog.create = async ({ data }) => { auditData = data; return { id: "audit-retired-order", ...data }; };

  const queue = await listCustomPipelineResolutionQueue({ agencyId: "agency-1", member: manager, creatorId: retiredCreator.id, db });
  assert.equal(queue.pendingCustomCount, 2);
  assert.deepEqual(queue.pendingCustoms.map((row) => row.type), ["CALL", "PHYSICAL"]);
  assert.equal(queue.pendingCustoms[0].creatorRetired, true);
  assert.equal(queue.pendingCustoms[0].canResolveLegacyRetired, true);

  const result = await resolveRetiredCreatorPendingCustomOrder({
    agencyId: "agency-1", member: manager, customOrderId: call.id,
    reason: "creator retired before lifecycle authority; terminalize historical call without fabricating provider cancellation", db,
  });
  assert.equal(result.status, "CANCELLED");
  assert.equal(result.telegramCancellationWaived, true);
  assert.equal(call.status, "CANCELLED");
  assert.equal(call.telegramTaskMessageId, 7001, "confirmed provider TASK is projected before waiver");
  assert.ok(call.deliveredAt, "confirmed provider effect time is preserved");
  assert.ok(call.telegramCancellationWaivedAt);
  assert.match(call.telegramCancellationWaiverReason, /creator retired before lifecycle authority/);
  assert.equal(reminder.state, "CANCELLED", "proven-precommit Telegram work is terminalized");
  assert.equal(task.state, "CONFIRMED", "proven provider outcome is immutable");
  assert.equal(auditData.action, "custom_order.legacy_retired_creator_resolve");
  assert.equal(auditData.metadata.telegramCancellationWaived, true);
});

test("legacy retired-order terminalization is forbidden for an active creator and required audit failure rolls back", async () => {
  const activeOrder = order("active-creator-order", { type: "PHYSICAL", contentKind: null });
  const activeDb = fakeDb({ orders: [activeOrder] });
  await assert.rejects(
    () => resolveRetiredCreatorPendingCustomOrder({ agencyId: "agency-1", member: manager, customOrderId: activeOrder.id, reason: "must not bypass normal lifecycle", db: activeDb }),
    (error) => error.code === "CUSTOM_RETIRED_ORDER_CREATOR_ACTIVE",
  );
  assert.equal(activeOrder.status, "PENDING");

  const retiredCreator = { ...creator, deletedAt: new Date("2026-09-05T12:00:00.000Z"), status: "DISABLED" };
  const retiredOrder = order("retired-audit-rollback", { creator: retiredCreator });
  const db = fakeDb({ orders: [retiredOrder], creatorRecord: retiredCreator });
  db.auditLog.create = async () => { throw new Error("required audit unavailable"); };
  await assert.rejects(
    () => resolveRetiredCreatorPendingCustomOrder({ agencyId: "agency-1", member: manager, customOrderId: retiredOrder.id, reason: "explicit historical resolution", db }),
    /required audit unavailable/,
  );
  assert.equal(retiredOrder.status, "PENDING", "business terminalization and required audit commit atomically");
  assert.equal(retiredOrder.telegramCancellationWaivedAt ?? null, null);
});

test("legacy retired-order resolution refuses to guess an unresolved Telegram TASK outcome", async () => {
  const retiredCreator = { ...creator, deletedAt: new Date("2026-09-05T12:00:00.000Z"), status: "DISABLED" };
  const pending = order("retired-task-unknown", { creator: retiredCreator });
  const unknownTask = { id: "tg-task-unknown", agencyId: "agency-1", creatorId: retiredCreator.id, customOrderId: pending.id, accountId: "tg-account", kind: "TASK", state: "RECONCILE_REQUIRED", commitStartedAt: now, claimRevision: 3 };
  const db = fakeDb({ orders: [pending], telegramIntents: [unknownTask], creatorRecord: retiredCreator });
  await assert.rejects(
    () => resolveRetiredCreatorPendingCustomOrder({ agencyId: "agency-1", member: manager, customOrderId: pending.id, reason: "do not guess provider outcome", db }),
    (error) => error.code === "CUSTOM_RETIRED_ORDER_TASK_OUTCOME_UNRESOLVED",
  );
  assert.equal(pending.status, "PENDING");
  assert.equal(unknownTask.state, "RECONCILE_REQUIRED");
  assert.equal(pending.telegramCancellationWaivedAt ?? null, null);
});

test("legacy retired-order resolution refuses to terminalize while CUSTOM_MANUAL_SEND outcome is unresolved", async () => {
  const retiredCreator = { ...creator, deletedAt: new Date("2026-09-05T12:00:00.000Z"), status: "DISABLED" };
  const pending = order("retired-manual-unknown", { creator: retiredCreator });
  const write = {
    id: "manual-unknown", agencyId: "agency-1", creatorId: retiredCreator.id, actionType: "CUSTOM_MANUAL_SEND",
    targetId: pending.id, status: "FAILED", failureCode: "outcome_unresolved_do_not_retry",
    updatedAt: now, createdAt: new Date("2026-08-22T11:59:00.000Z"),
  };
  const db = fakeDb({ orders: [pending], writes: [write], creatorRecord: retiredCreator });
  await assert.rejects(
    () => resolveRetiredCreatorPendingCustomOrder({ agencyId: "agency-1", member: manager, customOrderId: pending.id, reason: "do not guess physical send outcome", db }),
    (error) => error.code === "CUSTOM_RETIRED_ORDER_MANUAL_DELIVERY_OUTCOME_UNRESOLVED",
  );
  assert.equal(pending.status, "PENDING");
  assert.equal(write.status, "FAILED");
});

test("terminal Custom with stale operational blocker is not resurrected into Pipeline Resolution", async () => {
  const completed = order("custom-terminal", { status: "COMPLETED", fanDeliveredAt: new Date("2026-08-22T11:45:00Z") });
  const row = submission({
    id: "terminal-stale-block", customOrderId: completed.id, customOrder: completed,
    pipelineDisposition: "ACTIVE", pipelineBlockedCode: "STALE_EXECUTION_ERROR", pipelineBlockedAt: new Date("2026-08-22T11:40:00Z"),
  });
  const db = fakeDb({ submissions: [row], orders: [completed] });
  const queue = await listCustomPipelineResolutionQueue({ agencyId: "agency-1", member: manager, db });
  assert.equal(queue.count, 0);
  assert.deepEqual(queue.items, []);
});

test("required disposition audit failure rolls back the human terminal mutation", async () => {
  const row = submission({ id: "audit-rollback-source", customOrderId: null, ofMediaIds: [], pipelineDisposition: "ACTIVE" });
  const db = fakeDb({ submissions: [row] });
  db.auditLog.create = async () => { throw new Error("audit unavailable"); };
  await assert.rejects(
    () => resolveUnassignedCustomContentSubmission({
      agencyId: "agency-1", member: manager, submissionId: row.id, disposition: "ABANDONED",
      reason: "explicit operator resolution", db,
    }),
    /audit unavailable/,
  );
  assert.equal(row.pipelineDisposition, "ACTIVE", "required audit and terminal disposition must commit atomically");
  assert.equal(row.pipelineDispositionReason ?? null, null);
});

test("manual assignment candidates are only first submission or explicit revision targets", async () => {
  const row = submission();
  const orders = [order("custom-new", { createdAt: new Date("2026-08-22T11:30:00Z") }), order("custom-revision"), order("custom-active"), order("custom-approved")];
  const submissions = [
    row,
    submission({ id: "rev-1", customOrderId: "custom-revision", telegramMessageIds: [201], reviewStatus: "REVISION_REQUESTED", reviewComment: "Need another angle", reviewedAt: new Date("2026-08-22T11:10:00Z"), receivedAt: new Date("2026-08-22T10:10:00Z") }),
    submission({ id: "active-1", customOrderId: "custom-active", telegramMessageIds: [301], reviewStatus: "WAITING_REVIEW", receivedAt: new Date("2026-08-22T10:20:00Z") }),
    submission({ id: "approved-1", customOrderId: "custom-approved", telegramMessageIds: [401], reviewStatus: "APPROVED", reviewedAt: new Date("2026-08-22T11:20:00Z"), receivedAt: new Date("2026-08-22T10:30:00Z") }),
  ];
  const db = fakeDb({ submissions, orders });
  const result = await listCustomSubmissionAssignmentCandidates({ agencyId: "agency-1", member: manager, submissionId: row.id, db });
  assert.deepEqual(result.items.map((item) => item.customOrderId), ["custom-revision", "custom-new"]);
  assert.equal(result.items[0].awaitingRevision, true);
  assert.equal(result.items[0].nextRevisionNumber, 2);
  assert.equal(result.items[0].lastRevisionComment, "Need another angle");
});


test("Pipeline Resolution continuation does not silently clamp offsets at the historical 100k horizon", async () => {
  const source = fs.readFileSync(path.join(__dirname, "custom-content-workflow-service.js"), "utf8");
  const start = source.indexOf("async function listCustomPipelineResolutionQueue");
  const end = source.indexOf("async function setCustomPipelineResolution", start);
  const block = source.slice(start, end);
  assert.doesNotMatch(block, /Math\.min\(100_000|100000/);
  assert.match(block, /2_147_483_647/);
  assert.match(block, /nextOffset:\s*skip \+ items\.length/);
  assert.match(block, /pendingCustomNextOffset:\s*pendingSkip \+ pendingCustoms\.length/);
  assert.match(block, /activeWriteNextOffset:\s*writeSkip \+ \(activeWrites \|\| \[\]\)\.length/);
});

test("assignment suggestions apply LIMIT only after eligibility and complete revision history", async () => {
  const row = submission({ id: "incoming" });
  const poisonedOrders = [];
  const poisonedSubmissions = [];
  for (let index = 0; index < 130; index += 1) {
    const id = `poison-${String(index).padStart(3, "0")}`;
    poisonedOrders.push(order(id, { createdAt: new Date(1_800_000_000_000 - index * 1000) }));
    poisonedSubmissions.push(submission({ id: `${id}-active`, customOrderId: id, reviewStatus: "WAITING_REVIEW", receivedAt: new Date(1_800_000_000_000 - index * 1000) }));
  }
  const oldValid = order("valid-old", { createdAt: new Date(1_700_000_000_000) });
  const revisionTarget = order("revision-deep", { createdAt: new Date(1_600_000_000_000) });
  const revisionHistory = Array.from({ length: 501 }, (_, index) => submission({
    id: `deep-v${String(index + 1).padStart(3, "0")}`,
    customOrderId: revisionTarget.id,
    reviewStatus: index === 500 ? "REVISION_REQUESTED" : "WAITING_REVIEW",
    reviewComment: index === 500 ? "Need final redo" : null,
    reviewedAt: index === 500 ? new Date(1_600_000_600_000) : null,
    receivedAt: new Date(1_600_000_000_000 + index * 1000),
    createdAt: new Date(1_600_000_000_000 + index * 1000),
  }));
  const db = fakeDb({ submissions: [row, ...poisonedSubmissions, ...revisionHistory], orders: [...poisonedOrders, oldValid, revisionTarget] });
  const result = await listCustomSubmissionAssignmentCandidates({ agencyId: "agency-1", member: manager, submissionId: row.id, limit: 50, db });
  const byId = new Map(result.items.map((item) => [item.customOrderId, item]));
  assert.equal(byId.has(oldValid.id), true, "older eligible target must survive >100 newer poisoned orders");
  assert.equal(byId.has(revisionTarget.id), true, "deep revision target must remain reachable");
  assert.equal(byId.get(revisionTarget.id).submissionCount, 501);
  assert.equal(byId.get(revisionTarget.id).nextRevisionNumber, 502);
  assert.equal(byId.get(revisionTarget.id).lastRevisionComment, "Need final redo");
});

test("review permission gates manual unassigned assignment and safe target is enforced", async () => {
  const row = submission({ telegramMessageIds: [101], ofMediaIds: [] });
  const target = order("custom-new");
  const db = fakeDb({ submissions: [row], orders: [target] });
  await assert.rejects(() => assignUnassignedCustomContentSubmission({ agencyId: "agency-1", member: viewer, submissionId: row.id, customOrderId: target.id, db }), (error) => error.code === "CUSTOM_WORKFLOW_ASSIGN_FORBIDDEN");
  const result = await assignUnassignedCustomContentSubmission({ agencyId: "agency-1", member: manager, submissionId: row.id, customOrderId: target.id, db });
  assert.equal(result.submission.customOrderId, target.id);
});

test("awaiting revision queue only keeps the latest rejected version per custom", async () => {
  const a = order("custom-a");
  const b = order("custom-b");
  const revA = submission({ id: "a-v1", customOrderId: a.id, reviewStatus: "REVISION_REQUESTED", reviewComment: "Redo ending", reviewedAt: new Date("2026-08-22T11:00:00Z"), receivedAt: new Date("2026-08-22T10:00:00Z"), customOrder: a, reviewedByMember: { id: "manager-1", displayName: "Manager", roleKey: "manager" } });
  const revB = submission({ id: "b-v1", customOrderId: b.id, reviewStatus: "REVISION_REQUESTED", reviewComment: "More light", reviewedAt: new Date("2026-08-22T10:30:00Z"), receivedAt: new Date("2026-08-22T09:00:00Z"), customOrder: b, reviewedByMember: { id: "manager-1", displayName: "Manager", roleKey: "manager" } });
  const newB = submission({ id: "b-v2", customOrderId: b.id, reviewStatus: "WAITING_REVIEW", receivedAt: new Date("2026-08-22T11:30:00Z"), customOrder: b });
  const db = fakeDb({ submissions: [revA, revB, newB], orders: [a, b] });
  const result = await listAwaitingCustomRevisions({ agencyId: "agency-1", member: manager, db });
  assert.deepEqual(result.items.map((item) => item.customOrderId), ["custom-a"]);
  assert.equal(result.items[0].revisionNumber, 1);
  assert.equal(result.items[0].nextRevisionNumber, 2);
  assert.equal(result.items[0].revisionComment, "Redo ending");
  assert.equal(result.items[0].revisionDispatch.status, "DISPATCH_REQUIRED");
});

test("awaiting revision queue derives operational dispatch state from the one durable revision intent", async () => {
  const a = order("custom-a");
  const revA = submission({ id: "a-v1", customOrderId: a.id, reviewStatus: "REVISION_REQUESTED", reviewComment: "Redo ending", reviewedAt: new Date("2026-08-22T11:00:00Z"), receivedAt: new Date("2026-08-22T10:00:00Z"), customOrder: a, reviewedByMember: { id: "manager-1", displayName: "Manager", roleKey: "manager" } });
  const telegramIntents = [{
    id: "revision-a-v1", agencyId: "agency-1", creatorId: "creator-1", customOrderId: a.id, customSubmissionId: revA.id, kind: "REVISION_REQUEST",
    state: "COMMITTING", remoteMessageId: null, remoteSentAt: null, createdAt: new Date("2026-08-22T11:00:01Z"),
  }];
  const db = fakeDb({ submissions: [revA], orders: [a], telegramIntents });
  const sending = await listAwaitingCustomRevisions({ agencyId: "agency-1", member: manager, db });
  assert.equal(sending.items[0].revisionDispatch.status, "SENDING");
  telegramIntents[0].state = "RECONCILE_REQUIRED";
  const unknown = await listAwaitingCustomRevisions({ agencyId: "agency-1", member: manager, db });
  assert.equal(unknown.items[0].revisionDispatch.status, "DELIVERY_UNKNOWN");
  telegramIntents[0].state = "CONFIRMED";
  telegramIntents[0].remoteMessageId = 991;
  telegramIntents[0].remoteSentAt = new Date("2026-08-22T11:01:00Z");
  const waiting = await listAwaitingCustomRevisions({ agencyId: "agency-1", member: manager, db });
  assert.equal(waiting.items[0].revisionDispatch.status, "WAITING_MODEL");
  assert.equal(waiting.items[0].revisionDispatch.providerMessageId, "991");
});

test("V20.9 keeps revision workflow derived and adds only exact typed asset→submission provenance", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const submissionBlock = schema.match(/model CustomContentSubmission \{[\s\S]*?\n\}/)?.[0] || "";
  for (const forbidden of ["revisionNumber", "previousRevision", "awaitingRevision", "assignmentStatus", "revisionDispatchedAt"]) assert.doesNotMatch(submissionBlock, new RegExp(forbidden));
  const assetBlock = schema.match(/model CreatorMediaAsset \{[\s\S]*?\n\}/)?.[0] || "";
  assert.match(assetBlock, /customSubmissionId\s+String\?/);
  assert.match(assetBlock, /customSubmission\s+CustomContentSubmission\?/);
  assert.match(assetBlock, /@@index\(\[customSubmissionId\]\)/);
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260822123500_custom_content_submission_asset_provenance/migration.sql"), "utf8");
  assert.match(migration, /ADD COLUMN "customSubmissionId" TEXT/);
  assert.match(migration, /REFERENCES "CustomContentSubmission"\("id"\)/);
  assert.doesNotMatch(migration, /revisionNumber|awaitingRevision|revisionDispatchedAt/);
});

test("awaiting revision queue exposes lossless cursor continuation beyond the first UI page", async () => {
  const submissions = [];
  const orders = [];
  const base = new Date("2026-03-02T00:00:00.000Z").getTime();
  for (let i = 0; i < 120; i += 1) {
    const customOrder = order(`revision-order-${String(i).padStart(3, "0")}`, { dialogId: String(70000 + i) });
    orders.push(customOrder);
    const stamp = new Date(base + i * 1000);
    submissions.push(submission({
      id: `revision-page-${String(i).padStart(3, "0")}`, customOrderId: customOrder.id,
      reviewStatus: "REVISION_REQUESTED", reviewComment: `redo-${i}`, reviewedAt: stamp,
      receivedAt: stamp, createdAt: stamp, customOrder,
      reviewedByMember: { id: "manager-1", displayName: "Manager", roleKey: "manager" },
    }));
  }
  const db = fakeDb({ submissions, orders });
  const first = await listAwaitingCustomRevisions({ agencyId: "agency-1", member: manager, db, limit: 50 });
  assert.equal(first.items.length, 50);
  assert.equal(first.hasMore, true);
  const second = await listAwaitingCustomRevisions({ agencyId: "agency-1", member: manager, db, limit: 50, cursor: first.nextCursor });
  assert.equal(second.items.length, 50);
  assert.equal(second.hasMore, true);
  const third = await listAwaitingCustomRevisions({ agencyId: "agency-1", member: manager, db, limit: 50, cursor: second.nextCursor });
  assert.equal(third.items.length, 20);
  assert.equal(third.hasMore, false);
  assert.equal(third.nextCursor, null);
  const all = [...first.items, ...second.items, ...third.items].map((item) => item.submissionId);
  assert.equal(new Set(all).size, 120);
  assert.equal(all[119], "revision-page-119");
});
