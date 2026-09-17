"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

test("INT5.5D-4 every explicit job owner transition releases its creator observation read lease atomically", () => {
  const root = path.resolve(__dirname, "../..");
  const source = fs.readFileSync(path.join(root, "src/services/job-lease-service.js"), "utf8");
  const failStart = source.indexOf("async function failJob");
  const releaseStart = source.indexOf("async function releaseJob", failStart);
  const failBody = source.slice(failStart, releaseStart);
  const releaseBody = source.slice(releaseStart, source.indexOf("module.exports", releaseStart));

  assert.match(failBody, /jobInstance\.updateMany[\s\S]*fanObservationReadLease\?\.deleteMany[\s\S]*jobId: job\.id[\s\S]*deviceId[\s\S]*leaseRevision/);
  assert.match(releaseBody, /jobInstance\.updateMany[\s\S]*fanObservationReadLease\?\.deleteMany[\s\S]*jobId: job\.id[\s\S]*deviceId[\s\S]*leaseRevision/);
});

test("INT5.5D-4 administrative action owner transitions release the old delivery revision read lease", () => {
  const root = path.resolve(__dirname, "../..");
  const source = fs.readFileSync(path.join(root, "src/services/automation-action-delivery-service.js"), "utf8");
  const cancelBody = source.slice(source.indexOf("async function cancelActionDelivery"), source.indexOf("async function releaseClaimByAdmin"));
  const releaseBody = source.slice(source.indexOf("async function releaseClaimByAdmin"), source.indexOf("async function retrySafeFailures"));

  assert.match(cancelBody, /automationDelivery\.updateMany[\s\S]*fanObservationReadLease\?\.deleteMany[\s\S]*deliveryId: delivery\.id[\s\S]*leaseRevision: delivery\.leaseRevision/);
  assert.match(releaseBody, /automationDelivery\.updateMany[\s\S]*fanObservationReadLease\?\.deleteMany[\s\S]*deliveryId: delivery\.id[\s\S]*leaseRevision: delivery\.leaseRevision/);
});


test("INT5.5D-4 worker action fail/release transitions cannot strand the creator read lease", () => {
  const root = path.resolve(__dirname, "../..");
  const source = fs.readFileSync(path.join(root, "src/services/automation-action-delivery-service.js"), "utf8");
  const failBody = source.slice(source.indexOf("async function failActionDelivery"), source.indexOf("async function releaseActionDelivery"));
  const releaseBody = source.slice(source.indexOf("async function releaseActionDelivery"), source.indexOf("async function listActionDeliveries"));

  assert.match(failBody, /automationDelivery\.updateMany[\s\S]*fanObservationReadLease\?\.deleteMany[\s\S]*deliveryId: delivery\.id[\s\S]*deviceId: input\.deviceId[\s\S]*leaseRevision: input\.leaseRevision/);
  assert.match(releaseBody, /automationDelivery\.updateMany[\s\S]*fanObservationReadLease\?\.deleteMany[\s\S]*deliveryId: delivery\.id[\s\S]*deviceId: input\.deviceId[\s\S]*leaseRevision: input\.leaseRevision/);
});

test("INT5.5D-4 direct control/candidate bypasses also release creator read authority with revision fences", () => {
  const root = path.resolve(__dirname, "../..");
  const control = fs.readFileSync(path.join(root, "src/services/automation-control-service.js"), "utf8");
  const lifecycle = fs.readFileSync(path.join(root, "src/services/creator-lifecycle-authority-service.js"), "utf8");
  const followBack = fs.readFileSync(path.join(root, "src/services/follow-back-service.js"), "utf8");
  const sfs = fs.readFileSync(path.join(root, "src/services/sfs-service.js"), "utf8");

  assert.match(control, /cancelAutomationJobsForControl[\s\S]*jobInstance\.updateMany[\s\S]*fanObservationReadLease\?\.deleteMany[\s\S]*jobId: job\.id[\s\S]*leaseRevision: job\.leaseRevision/);
  assert.match(control, /pauseDeliveriesForControl[\s\S]*automationDelivery\.updateMany[\s\S]*leaseRevision: row\.leaseRevision[\s\S]*fanObservationReadLease\?\.deleteMany[\s\S]*deliveryId: row\.id[\s\S]*leaseRevision: row\.leaseRevision/);
  assert.match(lifecycle, /jobInstance\.updateMany[\s\S]*fanObservationReadLease\?\.deleteMany[\s\S]*creatorId: creator/);
  assert.match(followBack, /automationDelivery\.findMany[\s\S]*select: \{ id: true, leaseRevision: true \}[\s\S]*id: row\.id, leaseRevision: row\.leaseRevision[\s\S]*fanObservationReadLease\?\.deleteMany[\s\S]*deliveryId: row\.id[\s\S]*leaseRevision: row\.leaseRevision/);
  assert.match(sfs, /automationDelivery\.findMany[\s\S]*select: \{ id: true, leaseRevision: true \}[\s\S]*id: row\.id, leaseRevision: row\.leaseRevision[\s\S]*fanObservationReadLease\?\.deleteMany[\s\S]*deliveryId: row\.id[\s\S]*leaseRevision: row\.leaseRevision/);
});
