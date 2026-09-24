"use strict";

// Adds the new persistent traversal contract to older billing unit fixtures.
// This is not a substitute for PostgreSQL transaction/lease proofs.
function attachReconciliationFixture(db, now, onPage = () => {}) {
  const state = { id: "billing_aggregate_v1", lastAgencyId: null, ownerToken: null, leaseUntil: null, cycle: 0, failureCount: 0 };
  db.$queryRawUnsafe = async sql => sql.includes("clock_timestamp") ? [{ authorityNow: now }] : [{ id: state.id }];
  db.agency.findMany = async args => {
    onPage(args);
    const agency = await db.agency.findUnique({ where: { id: "agency-1" } });
    return agency && (!args.where.id || agency.id > args.where.id.gt) ? [{ id: agency.id }] : [];
  };
  const apply = data => {
    for (const [key, value] of Object.entries(data)) state[key] = value && typeof value === "object" && "increment" in value ? Number(state[key] || 0) + value.increment : value;
    return structuredClone(state);
  };
  db.billingReconciliationCursor = {
    findUnique: async () => structuredClone(state),
    update: async ({ data }) => apply(data),
    updateMany: async ({ where, data }) => {
      if (where.ownerToken !== state.ownerToken) return { count: 0 };
      apply(data); return { count: 1 };
    },
  };
  return state;
}

module.exports = { attachReconciliationFixture };
