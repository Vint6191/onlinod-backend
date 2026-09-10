"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const prismaPath = require.resolve("../prisma");
const retentionPath = require.resolve("./retention-service");
delete require.cache[retentionPath];
delete require.cache[prismaPath];
require.cache[prismaPath] = { id: prismaPath, filename: prismaPath, loaded: true, exports: {} };
const { compactTeamProjectionAuthorityForAgency } = require(retentionPath);

function fixture({ pageFull = false } = {}) {
  const calls = { deletedResponse: [], deletedDialog: [], deletedCoverage: [], coverageUpdate: null, retainedUpdate: null };
  const limitRows = pageFull ? Array.from({ length: 2 }, (_, i) => ({ id: `r${i + 1}` })) : [{ id: "r1" }];
  const db = {
    async $transaction(work) { return work(db); },
    phase2WorkCoverage: {
      async findUnique() { return { active: true, enumerationState: "COMPLETE", completedAt: new Date("2026-09-01T00:00:00Z") }; },
      async updateMany({ where, data }) { calls.retainedUpdate = { where, data }; return { count: 1 }; },
    },
    teamResponseCase: {
      async findMany({ where, take }) {
        assert.equal(where.agencyId, "agency-1");
        assert.equal(where.projectionState, "FULL", "INCOMPLETE_HISTORY must not be retention-eligible");
        assert.equal(take, 2);
        return limitRows;
      },
      async deleteMany({ where }) { calls.deletedResponse.push(...where.id.in); return { count: where.id.in.length }; },
    },
    teamDialogSession: {
      async findMany({ where, take }) { assert.equal(where.agencyId, "agency-1"); assert.equal(take, 2); return pageFull ? [{ id: "d1" }, { id: "d2" }] : [{ id: "d1" }]; },
      async deleteMany({ where }) { calls.deletedDialog.push(...where.id.in); return { count: where.id.in.length }; },
    },
    teamCoverageSession: {
      async findMany({ where, take }) { assert.equal(where.agencyId, "agency-1"); assert.deepEqual(where.endedAt.not, null); assert.equal(take, 2); return pageFull ? [{ id: "c1" }, { id: "c2" }] : [{ id: "c1" }]; },
      async deleteMany({ where }) { calls.deletedCoverage.push(...where.id.in); return { count: where.id.in.length }; },
    },
    teamProjectionCoverage: {
      async findUnique() { return { agencyId: "agency-1", responseCoverageFrom: new Date("2025-01-01T00:00:00Z"), dialogCoverageFrom: new Date("2025-01-01T00:00:00Z") }; },
      async update({ data }) { calls.coverageUpdate = data; return { agencyId: "agency-1", ...data }; },
    },
  };
  return { db, calls };
}

test("A45 final bounded projection compaction advances retained watermark atomically only after short pages", async () => {
  const { db, calls } = fixture({ pageFull: false });
  const cutoff = new Date("2025-09-09T00:00:00Z");
  const result = await compactTeamProjectionAuthorityForAgency({ db, agencyId: "agency-1", cutoff, batchSize: 2 });

  assert.equal(result.deleted, 3);
  assert.equal(result.hasMore, false);
  assert.equal(result.watermarkAdvanced, true);
  assert.deepEqual(calls.deletedResponse, ["r1"]);
  assert.deepEqual(calls.deletedDialog, ["d1"]);
  assert.deepEqual(calls.deletedCoverage, ["c1"]);
  assert.equal(calls.coverageUpdate.responseCoverageFrom.toISOString(), cutoff.toISOString());
  assert.equal(calls.coverageUpdate.dialogCoverageFrom.toISOString(), cutoff.toISOString());
  assert.equal(calls.coverageUpdate.source, "phase2_retention_vector_v3");
  assert.equal(calls.retainedUpdate.data.retainedFrom.toISOString(), cutoff.toISOString());
});

test("A45 full projection page yields without advancing coverage boundary", async () => {
  const { db, calls } = fixture({ pageFull: true });
  const cutoff = new Date("2025-09-09T00:00:00Z");
  const result = await compactTeamProjectionAuthorityForAgency({ db, agencyId: "agency-1", cutoff, batchSize: 2 });

  assert.equal(result.deleted, 6);
  assert.equal(result.hasMore, true);
  assert.equal(result.watermarkAdvanced, false);
  assert.equal(calls.coverageUpdate, null);
  assert.equal(calls.retainedUpdate, null);
});

test("projection compaction is fail-closed while bounded response repair coverage is incomplete", async () => {
  const { db, calls } = fixture({ pageFull: false });
  db.phase2WorkCoverage.findUnique = async () => ({ active: false, enumerationState: "RUNNING", completedAt: null });
  const result = await compactTeamProjectionAuthorityForAgency({ db, agencyId: "agency-1", cutoff: new Date("2025-09-09T00:00:00Z"), batchSize: 2 });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "response_repair_coverage_incomplete");
  assert.equal(calls.deletedResponse.length, 0);
  assert.equal(calls.coverageUpdate, null);
});
