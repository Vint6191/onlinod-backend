"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const OWNERS = new Set([path.resolve(__dirname, "job-planning-repository.js")]);

function productionJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) out.push(full);
  }
  return out;
}

test("all new JobInstance creation/upsert authority is owned by JobPlanningRepository", () => {
  const offenders = [];
  for (const file of productionJsFiles(ROOT)) {
    if (OWNERS.has(file)) continue;
    const source = fs.readFileSync(file, "utf8");
    if (/jobInstance\s*\.\s*(?:create|createMany|upsert)\s*\(/.test(source)) {
      offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test("scheduler and domain planners use the planning repository instead of hand-rolled reset semantics", () => {
  const files = [
    "services/job-scheduler.js",
    "services/likes-service.js",
    "services/sfs-service.js",
    "services/subscriber-directory-service.js",
    "services/traffic-service.js",
    "services/vault-unsorted-service.js",
    "services/dialog-intelligence-service.js",
    "routes/dialog-intelligence.js",
    "services/notification-scan-control-service.js",
    "services/campaign-scan-control-service.js",
    "services/financial-transaction-scan-control-service.js",
  ];
  for (const rel of files) {
    const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
    assert.match(source, /job-planning-repository/, rel);
  }
});

test("only execution/recovery authorities may directly return JobInstance to SCHEDULED", () => {
  const allowed = new Set([
    "services/job-lease-service.js",
    "services/dialog-intelligence-service.js",
  ]);
  const offenders = [];
  for (const file of productionJsFiles(ROOT)) {
    const rel = path.relative(ROOT, file).replaceAll(path.sep, "/");
    if (rel === "services/job-planning-repository.js" || allowed.has(rel)) continue;
    const source = fs.readFileSync(file, "utf8");
    if (/jobInstance\s*\.\s*(?:update|updateMany)\s*\([\s\S]{0,500}?status\s*:\s*["']SCHEDULED["']/.test(source)) {
      offenders.push(rel);
    }
  }
  assert.deepEqual(offenders, []);
});
