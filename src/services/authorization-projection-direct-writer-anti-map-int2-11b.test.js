"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const srcRoot = path.resolve(__dirname, "..");

function productionJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...productionJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js") && !entry.name.endsWith(".test.js")) out.push(full);
  }
  return out;
}

function filesMatching(regex) {
  const matches = [];
  for (const file of productionJsFiles(srcRoot)) {
    const source = fs.readFileSync(file, "utf8");
    if (regex.test(source)) matches.push(path.relative(srcRoot, file).replaceAll(path.sep, "/"));
  }
  return matches.sort();
}

const read = (rel) => fs.readFileSync(path.join(srcRoot, rel), "utf8");

test("INT2.11B anti-map: DeviceCreatorBinding direct writers are explicit and closed", () => {
  assert.deepEqual(
    filesMatching(/deviceCreatorBinding\.(?:upsert|update|updateMany|create|delete|deleteMany)\s*\(/),
    ["routes/devices.js", "services/creator-lifecycle-authority-service.js"],
  );
});

test("INT2.11B anti-map: TeamObservationState has one canonical production writer", () => {
  assert.deepEqual(
    filesMatching(/teamObservationState\.(?:upsert|update|updateMany|create|delete|deleteMany)\s*\(/),
    ["services/team-observation-service.js"],
  );
});

test("INT2.11B anti-map: accessEpoch increment writers remain the classified authority/admin set", () => {
  assert.deepEqual(
    filesMatching(/accessEpoch\s*:\s*\{\s*increment\s*:\s*1\s*\}/),
    [
      "services/access-epoch-service.js",
      "services/creator-access-scope-authority-service.js",
      "services/team-administration-service.js",
      "services/team-ownership-transfer-service.js",
    ],
  );
});

test("INT2.11B anti-map: direct realtimeReady consumers stay limited to the two fenced ingest routes", () => {
  assert.deepEqual(filesMatching(/realtimeReady\s*:\s*true/), ["routes/automation-control.js", "routes/stats.js"]);
});

test("INT2.11B cleanup: stats has no dead fail-open analytics reporter helper", () => {
  const source = read("routes/stats.js");
  assert.doesNotMatch(source, /requireFreshAnalyticsReporter/);
  assert.doesNotMatch(source, /Number\.isInteger\(Number\(member\?\.accessEpoch\)\)/);
});


test("INT2.11C anti-map: creator-wide realtime watermark readers stay explicit and classified", () => {
  assert.deepEqual(
    filesMatching(/teamObservationState\.(?:findUnique|findFirst|findMany)\s*\(/),
    ["routes/devices.js", "services/dialog-history-batch-service.js", "services/team-observation-service.js"],
  );
  assert.deepEqual(
    filesMatching(/lastRealtimeEventAt/),
    ["routes/devices.js", "services/dialog-history-batch-service.js", "services/team-observation-service.js"],
  );
});

test("INT2.11C anti-map: authorization/capability projections have no hidden raw-SQL writers", () => {
  // Match SQL write statements within each source file. Proximity across
  // concatenated modules (or a SELECT next to unrelated SQL) is not a writer.
  for (const file of productionJsFiles(srcRoot)) {
    const source = fs.readFileSync(file, 'utf8');
    if (['notification-consequence-service.js', 'notification-fact-receipt-service.js'].includes(path.basename(file))) {
      assert.match(source, /runRootCommit[\s\S]*lockAgencyLifecycleBarrier[\s\S]*lockDomainWorkClaimForCommit/);
      const sql = source.match(/UPDATE "TeamObservationState"([\s\S]*?)`/)?.[1];
      assert(sql); assert.match(sql, /SET "lastScanSummary"=/);
      assert.match(sql, /WHERE "agencyId"=\$1 AND "creatorId"=\$2 AND "lastScanSummary"->>'jobId'=\$3/);
      assert.doesNotMatch(sql, /SET[\s\S]*(?:lastRealtimeEventAt|lastFullScanAt|realtimeReady)\s*=/);
      continue;
    }
    assert.doesNotMatch(source, /(?:UPDATE\s+|INSERT\s+INTO\s+|DELETE\s+FROM\s+)["`']?(?:TeamObservationState|DeviceCreatorBinding)\b/i, path.relative(srcRoot, file));
  }
});
