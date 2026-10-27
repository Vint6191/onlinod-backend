"use strict";

const { DOMAIN_WORK_GENERATION } = require("./domain-work-authority-service");

// These lanes consume the durable read/planning/publication queues. A successful
// empty claim does not prove that their outstanding quarantined work recovered.
const LANE_CLASSES = Object.freeze({
  fanLtvProjection: ["FAN_LTV_PROJECTION"],
  creatorRecurringPlanning: ["CREATOR_RECURRING_PLANNING"],
  analyticsPublication: ["ANALYTICS_PUBLICATION"],
  analyticsFactPublication: ["ANALYTICS_FACT_PUBLICATION", "ANALYTICS_FACT_ADOPTION"],
});

async function withBlockedWorkHealth({ db, lane, result } = {}) {
  const classes = LANE_CLASSES[lane];
  if (!classes || typeof db?.$queryRawUnsafe !== "function") return result;
  // One index probe per fixed class; neither a tenant scan nor a history count.
  const rows = await db.$queryRawUnsafe(`
    SELECT c.name AS "workClass", blocked.id
    FROM unnest($1::text[]) c(name)
    CROSS JOIN LATERAL (
      SELECT w.id FROM "DomainWorkItem" w
      WHERE w."workClass"=c.name AND w."activeGeneration"=$2
        AND w."isOutstanding" AND w.state='RECONCILE_REQUIRED'
      ORDER BY w.id LIMIT 1
    ) blocked`, classes, DOMAIN_WORK_GENERATION);
  if (!rows.length) return result;
  return {
    ...result,
    ok: false,
    reason: result?.ok === false && result.reason ? result.reason : "DOMAIN_WORK_RECONCILE_REQUIRED",
    // Expose only the fixed class names, not tenant IDs or database error text.
    blockedWorkClasses: classes.filter(name => rows.some(row => row.workClass === name)),
  };
}

module.exports = { withBlockedWorkHealth };
