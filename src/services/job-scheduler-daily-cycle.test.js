"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function cacheModule(path, exports) {
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

const prismaPath = require.resolve("../prisma");
const retentionPath = require.resolve("./retention-service");
const subscriberPath = require.resolve("./subscriber-directory-service");
const followBackPath = require.resolve("./follow-back-service");
const bumpPath = require.resolve("./bump-service");
const likesPath = require.resolve("./likes-service");
const followAutomationPath = require.resolve("./follow-automation-service");
const sfsPath = require.resolve("./sfs-service");
const dailyPath = require.resolve("./vault-intelligence-daily-service");
const domainWorkPath = require.resolve("./domain-work-authority-service");
const schedulerPath = require.resolve("./job-scheduler");

let dailyCalls = 0;
cacheModule(prismaPath, {
  creatorAccount: {
    async findFirst() {
      return { id: "creator-1", agencyId: "agency-1", remoteId: "of-1", username: "creator", displayName: "Creator" };
    },
  },
  jobInstance: {
    async findFirst() {
      throw new Error("unrelated earnings scheduler failure");
    },
  },
});
cacheModule(domainWorkPath, {
  WORK_CLASS: { CREATOR_RECURRING_PLANNING: "CREATOR_RECURRING_PLANNING" },
  async claimDomainWorkBatch() {
    return { ownerToken: "owner-1", authorityNow: new Date(), items: [{ id: "work-1", agencyId: "agency-1", creatorId: "creator-1", objectId: "creator-1" }] };
  },
  async heartbeatDomainWorkClaim() { return { renewed: true, authorityNow: new Date() }; },
  async ackDomainWorkClaim() { return { acknowledged: true }; },
  async failDomainWorkClaim() { return { failed: true }; },
  async yieldDomainWorkClaim() { return { yielded: true }; },
});
cacheModule(retentionPath, {
  async runRetentionSweep() { return { totalDeleted: 0 }; },
  async getRetentionSettings() { return { settings: { retentionSweepWindowHours: 24 } }; },
});
cacheModule(subscriberPath, { async ensureSubscriberScanDue() { return { created: false }; } });
cacheModule(followBackPath, { async ensureAutomaticFollowBack() { return { created: false, reason: "disabled" }; } });
cacheModule(bumpPath, { async ensureAutomaticBumps() { return { created: false, reason: "disabled" }; } });
cacheModule(likesPath, { async ensureAutomaticLikes() { return { created: false, reason: "disabled" }; } });
cacheModule(followAutomationPath, { async ensureAutomaticFollowAutomation() { return { created: false, reason: "disabled" }; } });
cacheModule(sfsPath, { async ensureAutomaticSfs() { return { reason: "disabled" }; } });
cacheModule(dailyPath, {
  async ensureDailyVaultIntelligenceCycle(input) {
    dailyCalls += 1;
    assert.equal(input.creatorId, "creator-1");
    return { ok: true, created: 1 };
  },
});
delete require.cache[schedulerPath];
const { runRecurringSweep } = require("./job-scheduler");

test("daily Vault Intelligence remains independent from unrelated recurring job failures", async () => {
  const result = await runRecurringSweep();
  assert.equal(dailyCalls, 1);
  assert.equal(result.dailyCyclesStarted, 1);
  assert.equal(result.creatorsScanned, 1);
});
