"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
function source(rel) { return fs.readFileSync(path.join(root, rel), "utf8"); }

test("INT5.5D-2 SFS and Subscriber jobs opt into the same server-wide causal read lease", () => {
  const jobs = source("src/services/job-lease-service.js");
  const sfs = source("src/services/sfs-service.js");
  const subscriber = source("src/services/subscriber-directory-service.js");

  assert.match(jobs, /sfs_target_discovery:\s*Object\.freeze\(\["sfs_target_discovery"\]\)/);
  assert.match(jobs, /subscriber_directory_scan:\s*Object\.freeze\(\["subscriber_directory_page"\]\)/);
  assert.match(jobs, /FAN_OBSERVATION_READ_LEASE_JOB_KEYS = new Set\(Object\.keys\(FAN_OBSERVATION_READ_PURPOSE_BY_JOB_KEY\)\)/);
  assert.match(jobs, /FAN_OBSERVATION_READ_LEASE_JOB_KEYS\.has\(String\(candidate\.jobKey \|\| ""\)\)[\s\S]*observationReadLeaseVersion: 1/,
    "first claim after cutover must upgrade old scheduled SFS/Subscriber jobs too");
  assert.match(sfs, /observationTokenVersion: 1, observationReadLeaseVersion: 1/);
  assert.match(subscriber, /observationTokenVersion: 1,[\s\S]*observationReadLeaseVersion: 1/);
});

test("INT5.5D-2 lease purpose map remains exact and rejects cross-purpose substitution", () => {
  const jobs = source("src/services/job-lease-service.js");
  assert.match(jobs, /const allowed = FAN_OBSERVATION_READ_PURPOSE_BY_JOB_KEY\[String\(job\?\.jobKey \|\| ""\)\] \|\| null/);
  assert.match(jobs, /!Array\.isArray\(allowed\)[\s\S]*!allowed\.includes\(requested\)/);
  assert.match(jobs, /FAN_OBSERVATION_READ_LEASE_PURPOSE_FORBIDDEN/);
});
