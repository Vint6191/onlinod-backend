"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const migration = read("prisma/migrations/20260912003000_phase2_actual56_operational_pending_authority/migration.sql");
const pending = read("src/services/team-pending-read-service.js");
const analytics = read("src/services/team-analytics-service.js");

test("C3/C4 one DB OperationalPendingOwner authority owns current eligibility", () => {
  assert.match(migration, /CREATE OR REPLACE VIEW "TeamOperationalPendingCurrent"/);
  assert.match(migration, /JOIN "CreatorAccount" c[\s\S]*c\."deletedAt" IS NULL/);
  assert.match(migration, /LEFT JOIN "AgencyMember" m[\s\S]*m\."deletedAt" IS NULL[\s\S]*m\."deactivatedAt" IS NULL/);
  assert.match(migration, /LEFT JOIN "User" u[\s\S]*u\."disabledAt" IS NULL/);
  assert.match(migration, /"phase2_scope_allows_creator"\(m\."assignedCreators",p\."creatorId"\)/);
  assert.match(migration, /AS "operationalOwnerMemberId"/);
});

test("C3 member/unassigned list filtering occurs before LIMIT in SQL", () => {
  const block = pending.slice(pending.indexOf("async function loadOperationalPendingRows"), pending.indexOf("async function summarizeOperationalPending"));
  assert.match(block, /"ownerMemberId"=\$4/);
  assert.match(block, /"operationalOwnerMemberId"=\$4/);
  assert.match(block, /"operationalOwnerMemberId" IS NULL/);
  assert.ok(block.indexOf('"ownerMemberId"=$4') < block.indexOf('"operationalOwnerMemberId"=$4'));
  assert.ok(block.indexOf('"operationalOwnerMemberId"=$4') < block.indexOf('LIMIT $6'));
  assert.doesNotMatch(pending, /candidateLimit = .*requestedLimit \* 4/);
});

test("C3 member summary exposes the raw-owner predicate needed by the owner-first base index", () => {
  const block = pending.slice(pending.indexOf("async function summarizeOperationalPending"), pending.indexOf("async function memberNamesForRows"));
  assert.match(block, /"ownerMemberId"=\$4/);
  assert.match(block, /"operationalOwnerMemberId"=\$4/);
  assert.ok(block.indexOf('"ownerMemberId"=$4') < block.indexOf('"operationalOwnerMemberId"=$4'));
});

test("C3 degraded summary is UNKNOWN and never resurrects historical ownerMemberId", () => {
  assert.match(pending, /unknownOperationalPendingSummary/);
  assert.match(pending, /availability: "UNKNOWN"/);
  const summary = pending.slice(pending.indexOf("async function summarizeOperationalPending"), pending.indexOf("async function memberNamesForRows"));
  assert.match(summary, /TeamOperationalPendingCurrent/);
  assert.match(summary, /catch \(error\)[\s\S]*unknownOperationalPendingSummary/);
  assert.doesNotMatch(summary, /catch[\s\S]*return summarizePendingRows\(fallbackRows/);
});

test("C4 Team Analytics scale and compatibility paths consume operational owner authority", () => {
  const summary = analytics.slice(analytics.indexOf("async function loadPendingSummarySql"), analytics.indexOf("function floorUtcDay"));
  assert.match(summary, /FROM "TeamOperationalPendingCurrent" p/);
  assert.match(summary, /p\."operationalOwnerMemberId" AS "memberId"/);
  assert.match(summary, /GROUPING SETS \(\(p\."operationalOwnerMemberId"\), \(\)\)/);
  const compat = analytics.slice(analytics.indexOf("async function loadProjectedPendingStates"), analytics.indexOf("function supportsTeamScaleReadAuthority"));
  assert.match(compat, /TeamOperationalPendingCurrent/);
  assert.match(compat, /operationalOwnerMapForRows/);
  assert.match(compat, /ownerMemberId: row\.operationalOwnerMemberId \|\| null/);
});


test("C3/C4 compatibility analytics cannot broaden beyond current pending generation or retired Creator", () => {
  assert.match(pending, /CURRENT_PENDING_PROJECTION_STATES = Object\.freeze\(\["FULL", "INCOMPLETE_HISTORY"\]\)/);
  assert.match(pending, /function currentPendingProjectionWhere\(\)[\s\S]*derivationVersion: CURRENT_PENDING_DERIVATION_VERSION[\s\S]*projectionState: \{ in: \[\.\.\.CURRENT_PENDING_PROJECTION_STATES\] \}/);
  const compat = analytics.slice(analytics.indexOf("async function loadProjectedPendingStates"), analytics.indexOf("function supportsTeamScaleReadAuthority"));
  assert.match(compat, /o\."derivationVersion"=\$2/);
  assert.match(compat, /o\."projectionState"=ANY\(\$3::text\[\]\)/);
  assert.match(compat, /CURRENT_PENDING_DERIVATION_VERSION, CURRENT_PENDING_PROJECTION_STATES, creatorIds/);
  assert.match(compat, /\.\.\.currentPendingProjectionWhere\(\)/);
  assert.match(compat, /creator: \{ is: \{ deletedAt: null \} \}/);
});

test("C3/C4 every production OperationalPendingCurrent read is generation-bounded", () => {
  const consumers = [pending, analytics];
  let reads = 0;
  for (const source of consumers) {
    const regex = /FROM\s+"TeamOperationalPendingCurrent"\s+[op]/g;
    let match;
    while ((match = regex.exec(source)) !== null) {
      reads += 1;
      const window = source.slice(match.index, match.index + 1400);
      assert.match(window, /"derivationVersion"[^\n]*team_pending_v2|"derivationVersion"[^\n]*\$2|generationSql/,
        "current operational pending read must fence the current derivation generation");
      assert.match(window, /"projectionState"|generationSql/,
        "current operational pending read must fence accepted projection states");
    }
  }
  assert.equal(reads, 4, "unexpected new OperationalPendingCurrent consumer requires C3/C4 audit");
});

test("C4 current Team Analytics cannot fail-open to historical pending ownership", () => {
  assert.match(analytics, /const currentDialogGeneration = true;/);
  assert.match(analytics, /loadPendingSummarySql\(\{ agencyId, allowedCreatorIds, authorityNow, currentGenerationOnly: currentDialogGeneration \}\)/);
  const projected = analytics.slice(analytics.indexOf("async function loadProjectedPendingStates"), analytics.indexOf("function supportsTeamScaleReadAuthority"));
  assert.match(projected, /catch \(_\) \{[\s\S]*return \{ available: false, rows: \[\] \};[\s\S]*\}/);
  const applyStart = analytics.indexOf("const hasProjectedPending = pendingProjection?.available === true");
  const apply = analytics.slice(applyStart, applyStart + 5000);
  assert.match(apply, /if \(hasProjectedPending\)[\s\S]*metricFor\(pending\.ownerMemberId\)/);
  assert.match(apply, /else if \(hasProjectedResponses\)[\s\S]*unansweredIncomingCount = null/);
});
