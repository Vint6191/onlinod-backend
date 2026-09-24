"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { accessFromRow, recoveryWindow, readBillingExecutionAccess } = require("./billing-execution-access-service");
const now = new Date("2026-09-24T00:00:00.000Z");
const row = extra => ({ authorityNow: now, billingMode: "MANUAL", billingSupportHold: false, ...extra });

test("paid and trial deadlines are exclusive, future paid starts cannot authorize a present request", () => {
  assert.equal(accessFromRow(row({ trialEndsAt: now, coreValidUntil: now })).allowed, false);
  assert.equal(accessFromRow(row({ coreValidFrom: new Date(+now + 1), coreValidUntil: new Date(+now + 1000) })).allowed, false);
  assert.equal(accessFromRow(row({ coreValidFrom: now, coreValidUntil: new Date(+now + 1) })).allowed, true);
  assert.equal(accessFromRow(row({ trialEndsAt: new Date(+now + 2000), coreValidUntil: new Date(+now + 1000) })).validUntil.getTime(), +now + 2000);
});
test("malformed clock fails closed and invalid explicit core start cannot inherit a legacy null start", () => {
  assert.throws(() => accessFromRow({ authorityNow: "2026-09-24" }), { code: "BILLING_ACCESS_CLOCK_INVALID" });
  assert.equal(accessFromRow(row({ coreValidFrom: "bad", coreValidUntil: new Date(+now + 1000) })).allowed, false);
  assert.equal(accessFromRow(row({ coreValidFrom: null, coreValidUntil: new Date(+now + 1000) })).allowed, true);
});
test("billing recovery bounds tolerate midnight, exclude current day, long history, invalid dates and another schema", () => {
  const p = { analyticsContractVersion: 1, sourceTimezone: "UTC", scanFrom: "2026-08-25", scanTo: "2026-09-23" };
  assert.equal(recoveryWindow(p, now), true);
  assert.equal(recoveryWindow(p, new Date(+now + 86400000)), true);
  assert.equal(recoveryWindow(p, new Date(+now + 2 * 86400000)), false);
  for (const change of [{ scanTo: "2026-09-24" }, { scanFrom: "2026-08-24" }, { scanFrom: "2026-02-30" }, { scanFrom: "2026-09-23", scanTo: "2026-09-22" }, { sourceTimezone: "Europe/Moscow" }, { analyticsContractVersion: "1" }]) {
    assert.equal(recoveryWindow({ ...p, ...change }, now), false);
  }
});
test("billing reads do not fall back to cached status or wall time when storage is unavailable", async () => {
  const db = { $queryRawUnsafe: async () => { throw new Error("storage unavailable"); } };
  await assert.rejects(readBillingExecutionAccess({ db, agencyId: "a", creatorIds: ["c"] }), /storage unavailable/);
});
