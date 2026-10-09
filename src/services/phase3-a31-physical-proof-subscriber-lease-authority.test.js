"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const source = (relative) => fs.readFileSync(path.join(ROOT, relative), "utf8");

test("A31 Subscriber durable mutation lock order fences repair/publication before any maintenance mutation", () => {
  const subscriber = source("src/services/subscriber-directory-service.js");
  const maintenance = source("src/services/subscriber-directory-maintenance-service.js");
  const signals = source("src/services/subscriber-directory-maintenance-signal-service.js");
  const start = subscriber.indexOf("async function publicationTransaction");
  const end = subscriber.indexOf("async function projectHiddenOnlineChunk", start);
  const body = subscriber.slice(start, end);
  const agency = body.indexOf("lockAutomationWriteCommitFence");
  const creator = body.indexOf("lockSubscriberPublicationCreator");
  const signal = body.indexOf("lockSubscriberMaintenanceClaimRow");
  assert.ok(start >= 0 && agency > 0 && creator > agency && signal > creator,
    "canonical lock order must be automation agency -> subscriber creator -> maintenance signal row");
  assert.match(subscriber, /repairSubscriberDirectoryStateGeneration[\s\S]*maintenanceSignal/);
  assert.match(subscriber, /advanceSubscriberPublication[\s\S]*maintenanceSignal/);
  assert.doesNotMatch(maintenance, /withSubscriberMaintenanceClaimFence/,
    "maintenance worker must not lock the signal row before creator publication authority");
  assert.match(signals, /"claimUntil" > clock_timestamp\(\)[\s\S]*FOR UPDATE/);
});

test("A31 recovered automation planning remains durable debt and Bumps cannot escape the fenced transaction", () => {
  const subscriber = source("src/services/subscriber-directory-service.js");
  const bumps = source("src/services/bump-service.js");
  assert.match(subscriber, /subscriberDerivedPlanningConverged/);
  assert.match(subscriber, /reason: "planning_failed", durableRetryRequired: true/);
  assert.match(subscriber, /fencedMaintenance[\s\S]*scheduleFanRefresh: fencedRefreshScheduler/);
  assert.match(bumps, /scheduleFanRefresh = \(args\) => scheduleFanDataPointRefresh\(\{ \.\.\.args, db \}\)/);
  assert.match(bumps, /planBumps\([\s\S]*scheduleFanRefresh/);
  assert.match(subscriber, /DERIVED_AUTOMATION_PLANNING_FAILED/);
  assert.match(subscriber, /publicationJobReconciledAt:\s*null/);
});

test("A31 generation repair and completion work are bounded instead of O(all history) / 100000 phase loops", () => {
  const subscriber = source("src/services/subscriber-directory-service.js");
  const migration = source("prisma/migrations/20261009000000_current_baseline/migration.sql");
  const finalPg = source("src/services/phase3-analytics-final-authority-cutover.integration.test.js");
  const repairStart = subscriber.indexOf("async function repairSubscriberDirectoryStateGeneration");
  const repairEnd = subscriber.indexOf("async function findSubscriberPublicationDebtForCreator", repairStart);
  const repair = subscriber.slice(repairStart, repairEnd);
  assert.doesNotMatch(repair, /SELECT\s+MAX\s*\(/i);
  assert.match(repair, /ORDER BY r\."publicationGeneration" DESC, r\."id" DESC[\s\S]*LIMIT 1/);
  assert.match(migration, /SubscriberScanRun_creator_published_generation_idx/);
  assert.match(subscriber, /maxSteps = 8/);
  assert.match(subscriber, /Math\.min\(32/);
  assert.doesNotMatch(subscriber, /100000/);
  assert.match(finalPg, /generationRepairMs/);
  assert.match(finalPg, /SubscriberScanRun_creator_published_generation_idx/);
  assert.match(finalPg, /expired real Subscriber recovery cannot mutate generation, run, projections, or jobs/);
});



test("A31 maintenance failures/poison debt are visible and recoverable without Render shell", () => {
  const subscriberMaintenance = source("src/services/subscriber-directory-maintenance-service.js");
  const campaign = source("src/services/campaign-fan-refresh-queue-service.js");
  const scheduler = source("src/services/job-scheduler.js");
  const admin = source("src/routes/admin.js");
  assert.match(subscriberMaintenance, /poisonedSignals/);
  assert.match(subscriberMaintenance, /poisonedSample/);
  assert.match(subscriberMaintenance, /ok: totals\.errors === 0 && poisonedSignals === 0/);
  assert.match(campaign, /ok: totals\.errors === 0/);
  assert.match(scheduler, /Phase2 maintenance degraded/);
  assert.match(scheduler, /result\[name\] = laneResult/);
  assert.match(scheduler, /laneResult\?\.ok === false\) result\.ok = false/);
  assert.match(admin, /maintenance\/subscriber-signals/);
  assert.match(admin, /maintenance\/subscriber-signals\/:id\/requeue/);
  assert.match(admin, /ensureSuperAdmin/);
  assert.match(admin, /operationHandler\("maintenance\.subscriber\.requeue"\)/);
  const command=source("src/services/admin-operational-command-service.js");
  assert.match(command, /executeAdminCommand/);
  assert.match(command, /maintenance\.subscriber\.requeue/);
});








