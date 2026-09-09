"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  HISTORICAL_ATTRIBUTION_TARGET_INVALID,
  resolveHistoricalAttributionTarget,
} = require("./historical-attribution-target-authority-service");

function dbWith(rows) {
  return {
    agencyMember: {
      async findFirst({ where }) {
        const row = rows.find((item) => item.id === where.id && item.agencyId === where.agencyId && item.deletedAt == null) || null;
        return row ? { id: row.id, userId: row.userId, deactivatedAt: row.deactivatedAt || null } : null;
      },
    },
  };
}

const rows = [
  { id: "active", agencyId: "agency-1", userId: "user-active", deletedAt: null, deactivatedAt: null },
  { id: "deactivated", agencyId: "agency-1", userId: "user-deactivated", deletedAt: null, deactivatedAt: new Date("2026-09-01T00:00:00.000Z") },
  { id: "removed", agencyId: "agency-1", userId: "user-removed", deletedAt: new Date("2026-09-02T00:00:00.000Z"), deactivatedAt: null },
  { id: "other-agency", agencyId: "agency-2", userId: "user-other", deletedAt: null, deactivatedAt: null },
];

test("HistoricalAttributionTargetAuthority accepts an active non-removed member", async () => {
  const result = await resolveHistoricalAttributionTarget({ tx: dbWith(rows), agencyId: "agency-1", targetMemberId: "active" });
  assert.equal(result.ok, true);
  assert.equal(result.status, "active");
  assert.equal(result.member.userId, "user-active");
});

test("HistoricalAttributionTargetAuthority accepts a deactivated non-removed member for historical adjudication", async () => {
  const result = await resolveHistoricalAttributionTarget({ tx: dbWith(rows), agencyId: "agency-1", targetMemberId: "deactivated" });
  assert.equal(result.ok, true);
  assert.equal(result.status, "deactivated");
  assert.equal(result.member.userId, "user-deactivated");
});

test("HistoricalAttributionTargetAuthority rejects removed and cross-agency targets identically", async () => {
  for (const targetMemberId of ["removed", "other-agency", "missing"]) {
    const result = await resolveHistoricalAttributionTarget({ tx: dbWith(rows), agencyId: "agency-1", targetMemberId });
    assert.equal(result.ok, false);
    assert.equal(result.code, HISTORICAL_ATTRIBUTION_TARGET_INVALID);
    assert.equal(result.member, null);
  }
});
