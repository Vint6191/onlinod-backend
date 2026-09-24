"use strict";

// Existing scheduler/pacing unit fixtures model a live trial explicitly. Real
// billing eligibility and SQL joins are exercised by the disposable DB proof.
function installTrialBillingRows(db) {
  const query = db.$queryRawUnsafe?.bind(db);
  db.$queryRawUnsafe = async (sql, ...args) => {
    if (sql.includes('c."id" AS "creatorId"') && sql.includes('"billingSupportHold"')) {
      const time = query ? (await query('SELECT clock_timestamp() AS "authorityNow"'))?.[0]?.authorityNow : new Date();
      const now = time || new Date();
      return (args[1] || []).map(creatorId => ({ creatorId, authorityNow: now, billingMode: "MANUAL",
        billingSupportHold: false, deletedAt: null, trialEndsAt: new Date(now.getTime() + 86400000), coreValidUntil: null }));
    }
    if (query) return query(sql, ...args);
    if (sql.includes("clock_timestamp")) return [{ authorityNow: new Date() }];
    throw new Error(`Unimplemented fixture query: ${sql}`);
  };
}
module.exports = { installTrialBillingRows };
