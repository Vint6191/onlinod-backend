"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const enabled = process.env.ONLINOD_POSTGRES_INTEGRATION === "1";

test("published earnings keep the database UTC observation time across server timezones", { skip: !enabled }, async () => {
  const db = require("../prisma");
  const { runRootCommit } = require("./db-commit-kernel");
  const generation = require("./earnings-generation-service");
  const { readPublishedEarningsDays } = require("./published-earnings-read-repository");
  const { FINANCIAL_PROOF_POLICY_VERSION } = require("./earnings-coverage-service");
  const { assertTeamControlPlaneWriteAdmission, authorizeCreatorAccountWrite } = require("./database-write-contract-service");
  const originalTimezone = process.env.TZ;
  const rollback = new Error("PUBLISHED_EARNINGS_TIMEZONE_FIXTURE_ROLLBACK");
  try {
    await assert.rejects(() => runRootCommit(db, async ({ tx }) => {
      const id = "earnings-time210-" + randomUUID();
      const agencyId = id + "-agency", creatorId = id + "-creator";
      const now = new Date(Math.floor(Date.now() / 1000) * 1000), observedAt = new Date(now);
      const day = new Date(now.toISOString().slice(0, 10));
      await assertTeamControlPlaneWriteAdmission(tx);
      await authorizeCreatorAccountWrite(tx);
      await tx.agency.create({ data: { id: agencyId, name: "Earnings timezone fixture" } });
      await tx.creatorAccount.create({ data: { id: creatorId, agencyId, displayName: "Earnings timezone", remoteId: id, status: "READY" } });
      await generation.lock(tx, creatorId);
      await tx.creatorEarningsGeneration.create({ data: { id, agencyId, creatorId, runId: id, state: "ACTIVE", phase: "READY", mode: "SNAPSHOT",
        fromAt: day, throughAt: observedAt, snapshotAt: observedAt, fullScan: true, publishedAt: observedAt, proofPolicyVersion: FINANCIAL_PROOF_POLICY_VERSION } });
      await generation.upsert(tx, id, [{ transactionId: "tip", occurredAt: observedAt, category: "tips", netCents: 800,
        grossCents: 1000, status: "done", observedAt }]);
      await tx.creatorEarningsLedgerProof.create({ data: { agencyId, creatorId, generation: id, activeGeneration: id,
        fromAt: day, throughAt: observedAt, confirmedThroughAt: observedAt, proofPolicyVersion: FINANCIAL_PROOF_POLICY_VERSION } });
      for (const timezone of ["UTC", "Europe/Kyiv", "America/Los_Angeles"]) {
        process.env.TZ = timezone;
        const rows = await readPublishedEarningsDays({ db: tx, creatorId, from: day, to: day, now });
        assert.equal(rows.length, 1);
        assert.equal(rows[0].daily.totalCents, 800);
        assert.equal(rows[0].coverage.liveFresh, true);
        assert.equal(rows[0].daily.collectedAt.toISOString(), observedAt.toISOString(), timezone);
        assert.equal(rows[0].coverage.lastVerifiedAt.toISOString(), observedAt.toISOString(), timezone);
      }
      throw rollback;
    }), error => error === rollback);
  } finally {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
    await db.$disconnect();
  }
});
