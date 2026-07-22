"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "jobs.js"), "utf8");

test("jobs claim route validates and forwards the discovery-only capability", () => {
  assert.match(source, /dialogDiscoveryOnly:\s*z\.boolean\(\)\.optional\(\)/);
  assert.match(source, /dialogDiscoveryOnly:\s*input\.dialogDiscoveryOnly\s*===\s*true/);
});
