"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.join(__dirname, "dialog-intelligence.js"), "utf8");

test("pause owns stranded IDLE plus frozen PLANNED dialog-history backlog", () => {
  assert.match(source, /status:\s*\{\s*in:\s*\["IDLE",\s*"PLANNED",\s*"QUEUED",\s*"RUNNING"\]\s*\}/);
  assert.match(source, /historyControl:[\s\S]*state:\s*clean\(state/);
  assert.match(source, /data:\s*\{\s*status:\s*"PAUSED",\s*activeJobId:\s*null/);
});

test("resume restores standalone paused history rows to PLANNED", () => {
  assert.match(source, /const standaloneHistory = await tx\.dialogScanState\.updateMany/);
  assert.match(source, /status:\s*"PAUSED"[\s\S]*activeRunId:\s*null[\s\S]*status:\s*"PLANNED"/);
  assert.match(source, /resumedStates:\s*standaloneHistory\.count/);
});
