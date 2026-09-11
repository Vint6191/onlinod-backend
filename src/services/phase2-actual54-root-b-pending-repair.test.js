"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const prismaPath = require.resolve("../prisma");
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };
const { applyTeamPendingProjection } = require("./team-pending-projection-service");

function d(value) { return new Date(value); }

function makeProductionLikeDb() {
  const state = {
    id: "pending-1", agencyId: "agency-1", creatorId: "creator-1", dialogId: "fan-1", fanId: "fan-1",
    status: "PENDING", projectionRevision: 4n, projectionState: "FULL",
    firstIncomingAt: d("2026-09-10T10:00:00Z"), lastIncomingAt: d("2026-09-10T10:05:00Z"), incomingCount: 4,
    lastAppliedEventAt: d("2026-09-10T10:05:00Z"), lastAppliedEventId: "event-z",
  };
  let rawPage = 0;
  let projected = 0;
  const pageRows = [
    { id: "event-a", messageId: "m-a", localId: "l-a", fanId: "fan-1", ts: d("2026-09-10T10:00:00Z") },
    { id: "event-b", messageId: "m-b", localId: "l-b", fanId: "fan-1", ts: d("2026-09-10T10:01:00Z") },
  ];
  const db = {
    async $executeRawUnsafe() { return 1; },
    async $queryRawUnsafe(sql) {
      assert.match(String(sql), /ORDER BY e\."ts" ASC,e\."id" ASC\s+LIMIT \$8/);
      rawPage += 1;
      return rawPage === 1 ? pageRows : [];
    },
    teamSentMessageLedger: { async findFirst() { return null; } },
    teamActivityEvent: {
      async findFirst({ where }) { return where?.eventKind === "DIALOG_SEEN" ? null : null; },
      async update({ data }) { projected += 1; return { id: "event-0", ...data }; },
      async findMany() { throw new Error("unbounded findMany must not be used by production late repair"); },
    },
    teamPendingDialogState: {
      async findUnique() { return state; },
      async update({ data }) { Object.assign(state, data); return state; },
      async upsert({ create, update }) { Object.assign(state, Object.keys(state).length ? update : create); return state; },
    },
  };
  return { db, state, get rawPage() { return rawPage; }, get projected() { return projected; } };
}

const late = {
  id: "event-0", agencyId: "agency-1", creatorId: "creator-1", dialogId: "fan-1", fanId: "fan-1",
  eventKind: "FAN_MESSAGE_RECEIVED", messageId: "m-0", localId: "l-0", ts: d("2026-09-10T09:59:00Z"),
};

test("F54-04 inline production late event defers without scanning history or falsely marking projected", async () => {
  const fx = makeProductionLikeDb();
  const result = await applyTeamPendingProjection(late, fx.db);
  assert.equal(result.complete, false);
  assert.equal(result.deferred, true);
  assert.equal(fx.rawPage, 0, "inline current mutation must not launch a historical scan");
  assert.equal(fx.projected, 0, "deferred event must remain unprojected for durable DWI repair");
});

test("F54-04 worker repair is bounded and restartable through an explicit cursor", async () => {
  const fx = makeProductionLikeDb();
  const first = await applyTeamPendingProjection(late, fx.db, { executeRepair: true, repairLimit: 2 });
  assert.equal(first.complete, false);
  assert.equal(first.repairPending, true);
  assert.equal(first.progress.incomingCount, 2);
  assert.equal(first.progress.cursorId, "event-b");
  assert.equal(fx.rawPage, 1);
  assert.equal(fx.projected, 0);

  const second = await applyTeamPendingProjection(late, fx.db, { executeRepair: true, repairLimit: 2, repairProgress: first.progress });
  assert.equal(second.complete, true);
  assert.equal(second.status, "PENDING");
  assert.equal(fx.rawPage, 2);
  assert.equal(fx.state.incomingCount, 2);
  assert.equal(fx.projected, 1, "source event is marked only after the bounded repair converges");
});

test("F54-04 migration supplies physical order and duplicate-identity indexes for bounded repair", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "migrations", "20260911013000_phase2_actual54_root_b_closure", "migration.sql"), "utf8");
  assert.match(migration, /TeamSentMessageLedger_dialog_canonical_order_idx/);
  assert.match(migration, /TeamActivityEvent_pending_repair_identity_idx/);
  assert.match(migration, /TeamSentMessageLedger_dialog_reply_order_idx/);
  assert.match(migration, /COALESCE\(NULLIF\("messageId",''\),NULLIF\("localId",''\),"id"\)/);
  assert.match(migration, /WHERE "eventKind"='FAN_MESSAGE_RECEIVED'/);
});

test("F54-04 scheduler persists pending repair progress on DomainWork yield", () => {
  const scheduler = fs.readFileSync(path.join(__dirname, "job-scheduler.js"), "utf8");
  const authority = fs.readFileSync(path.join(__dirname, "team-dialog-projection-authority-service.js"), "utf8");
  assert.match(scheduler, /progressCursor:\s*item\?\.progressCursor/);
  assert.match(scheduler, /progressCursor:\s*result\?\.nextProgressCursor/);
  assert.match(authority, /pendingRepair:\s*\{\s*eventId:/);
  assert.match(authority, /repairProgress/);
});

test("F54-04 resumed pending repair does not replay sibling response projection on every page", () => {
  const authority = fs.readFileSync(path.join(__dirname, "team-dialog-projection-authority-service.js"), "utf8");
  assert.match(authority, /if \(!repairEventId\) await applyTeamResponseProjection\(row, db\)/);
});
