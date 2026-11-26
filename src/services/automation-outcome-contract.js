"use strict";

// User control governs new work. An unresolved external effect is a separate
// obligation and must stay claimable even while the originating module is off.
const UNKNOWN = "OUTCOME_UNKNOWN_RECONCILE";
function deliveryRequiresReconciliation(delivery) {
  return delivery?.status === "RECONCILE_REQUIRED"
    || delivery?.failureCategory === UNKNOWN
    || String(delivery?.result?.outcomeState || "").toUpperCase() === "RECONCILE_REQUIRED";
}
function unresolvedDeliveryWhere() {
  return { OR: [
    { status: "RECONCILE_REQUIRED" },
    { failureCategory: UNKNOWN },
    { result: { path: ["outcomeState"], equals: "RECONCILE_REQUIRED" } },
  ] };
}
function deliveryOutcomeSnapshotWhere(delivery) {
  // Match the observed outcome atomically. NOT over nullable JSON paths has
  // SQL three-valued semantics and would also exclude healthy missing markers.
  return { failureCategory: delivery.failureCategory ?? null,
    result: { equals: delivery.result ?? require("@prisma/client").Prisma.JsonNull } };
}

module.exports = { deliveryRequiresReconciliation, unresolvedDeliveryWhere, deliveryOutcomeSnapshotWhere };
