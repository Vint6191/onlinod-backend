"use strict";

// Existing scheduler/pacing unit fixtures model a live trial explicitly. Real
// billing eligibility and SQL joins are exercised by the disposable DB proof.
function installTrialBillingRows(db, { clock = null, billing = {} } = {}) {
  const query = db.$queryRawUnsafe?.bind(db);
  db.$queryRawUnsafe = async (sql, ...args) => {
    if (sql.includes('/* phase4_action_fairness */')) {
      const [agencyId, ids, types, now, paid] = args;
      const rows = await db.automationDelivery.findMany({ where: { agencyId, creatorId: { in: ids }, originKind: "AUTOMATION", actionType: { in: types }, status: { in: ["QUEUED", "RETRY_SCHEDULED", "RECONCILE_REQUIRED"] }, notBefore: { lte: now } } });
      const recovery = r => r.status === "RECONCILE_REQUIRED" || r.failureCategory === "OUTCOME_UNKNOWN_RECONCILE" || r.result?.outcomeState === "RECONCILE_REQUIRED";
      const seen = new Set();
      return rows.filter(r => (paid.includes(r.creatorId) && r.attempts < r.maxAttempts) || recovery(r))
        .sort((a,b) => Number(recovery(b))-Number(recovery(a)) || b.priority-a.priority || a.notBefore-b.notBefore || a.createdAt-b.createdAt || a.id.localeCompare(b.id))
        .filter(r => !seen.has(r.creatorId) && seen.add(r.creatorId)).slice(0,100);
    }
    if (sql.includes('c."id" AS "creatorId"') && sql.includes('"billingSupportHold"')) {
      const time = clock ? clock() : query ? (await query('SELECT clock_timestamp() AS "authorityNow"'))?.[0]?.authorityNow : new Date();
      const now = time || new Date();
      return (args[1] || []).map(creatorId => ({ creatorId, authorityNow: now, billingMode: "MANUAL",
        billingSupportHold: false, deletedAt: null, trialEndsAt: new Date(now.getTime() + 86400000), coreValidUntil: null, ...billing }));
    }
    if (/FROM "Agency" WHERE "id"\s*=\s*\$1/.test(sql)) return [{ id: args[0], deletedAt: null, status: "ACTIVE" }];
    if (!query && sql.includes('FROM "AgencyMember"')) return [await db.agencyMember.findFirst({ where: { id: args[0], userId: args[1], agencyId: args[2] } })].filter(Boolean);
    if (query) return query(sql, ...args);
    if (sql.includes("clock_timestamp")) return [{ authorityNow: new Date() }];
    throw new Error(`Unimplemented fixture query: ${sql}`);
  };
}
module.exports = { installTrialBillingRows };
