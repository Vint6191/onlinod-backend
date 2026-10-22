"use strict";

// Priority governs a short ready interval; it cannot keep an older due job
// behind an endless supply of new profile batches. nextRunAt is durable and
// advances on a cooperative yield, so fairness survives worker/restart changes.
const MAX_PRIORITY_WAIT_MS = 60_000;
async function selectClaimCandidate({ db, where, now }) {
  const aged = await db.jobInstance.findFirst({
    where: { AND: [where, { nextRunAt: { lte: new Date(+now - MAX_PRIORITY_WAIT_MS) } }] },
    orderBy: [{ nextRunAt: "asc" }, { priority: "desc" }, { id: "asc" }],
  });
  if (aged) return aged;
  return db.jobInstance.findFirst({ where,
    orderBy: [{ priority: "desc" }, { nextRunAt: "asc" }, { id: "asc" }],
  });
}

module.exports = { selectClaimCandidate, MAX_PRIORITY_WAIT_MS };
