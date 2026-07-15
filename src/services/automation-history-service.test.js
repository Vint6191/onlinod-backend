"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyAutomationDelivery, groupDeliveriesForArchive } = require("./automation-history-service");

test("semantic counters classify automation actions", () => {
  assert.equal(classifyAutomationDelivery({ status: "COMPLETED", actionType: "SEND_MESSAGE", result: { replied: true } }).sent, 1);
  assert.equal(classifyAutomationDelivery({ status: "COMPLETED", actionType: "SEND_MESSAGE", result: { replied: true } }).replied, 1);
  assert.equal(classifyAutomationDelivery({ status: "COMPLETED", actionType: "FOLLOW_BACK" }).followed, 1);
  assert.equal(classifyAutomationDelivery({ status: "COMPLETED", actionType: "SFS_UNFOLLOW_TARGET" }).unfollowed, 1);
  assert.equal(classifyAutomationDelivery({ status: "FAILED", actionType: "LIKE_POST" }).failed, 1);
});

test("archive groups are separated by creator module action and month", () => {
  const rows = [
    { agencyId: "a", creatorId: "c", moduleKey: "likes", actionType: "LIKE_POST", status: "COMPLETED", finishedAt: new Date("2026-01-02T00:00:00Z") },
    { agencyId: "a", creatorId: "c", moduleKey: "likes", actionType: "LIKE_POST", status: "FAILED", finishedAt: new Date("2026-01-03T00:00:00Z") },
    { agencyId: "a", creatorId: "c", moduleKey: "likes", actionType: "LIKE_POST", status: "COMPLETED", finishedAt: new Date("2026-02-03T00:00:00Z") },
  ];
  const groups = groupDeliveriesForArchive(rows);
  assert.equal(groups.length, 2);
  assert.equal(groups[0].total, 2);
  assert.equal(groups[0].completed, 1);
  assert.equal(groups[0].failed, 1);
});
